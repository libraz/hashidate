import * as THREE from 'three';
import { HAND_CONTACT } from '../anatomy';
import { BODY_ANCHORS, FACE_ANCHORS } from '../profile';
import type { ArmSolution, Rig } from '../rig';
import type {
  ArmSlot,
  FingerName,
  GestureDef,
  GestureGroup,
  GestureVariation,
  PointSpec,
  Pose,
  Profile,
  ReachSpec,
  Side,
  SpineSlot,
  Vec3Tuple,
} from '../types';
import { Gaze } from './gaze';
import { BASE_FINGERS, BASE_PALM, BASE_POSE, GESTURES, POINT_HAND } from './gestures';
import { breathCurve, DEFAULT_VARIATION, saturate, settle, smoothstep } from './idle';
import { type JumpArc, planJump, sampleJump } from './jump';

/**
 * Body layer: base pose, idle life (breathing / sway / head / gaze), and the
 * playback of the gestures defined in `gestures.ts`.
 *
 * Directions are authored in "character space" — x outward from the midline,
 * y up, z forward — and mirrored per side at apply time. Authoring this way
 * means a gesture written once works on either arm and on any rig, because the
 * rig resolves directions rather than local angles.
 */

const ARM_SLOTS: ArmSlot[] = ['shoulder', 'upperArm', 'lowerArm', 'hand'];
const FINGER_NAMES: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];

/** The gesture table, looked up by an id that arrives as a plain string. */
const GESTURE_TABLE: Record<string, GestureDef> = GESTURES;

/**
 * Idle drift grows toward the extremity: a shoulder barely moves, a hand is
 * never still. Applying it uniformly makes the whole arm wobble as one rigid
 * piece, which is worse than not applying it at all.
 */
const DRIFT_WEIGHT: Record<ArmSlot, number> = {
  shoulder: 0.3,
  upperArm: 0.6,
  lowerArm: 1.0,
  hand: 1.5,
};

/**
 * The arms follow their composed target rather than being set to it.
 *
 * The target is not continuous and cannot be made so: switching gestures moves
 * it by a large angle in a single frame, and a gesture starting moves it fast
 * while its envelope rises. Blending between poses does not fix that — it only
 * decides *which* discontinuous target is in force. A first-order follow does,
 * because no step in the target survives it.
 *
 * The cutoff sits above the fastest authored oscillation (`deny` swings at
 * ~1.4 Hz), so gestures keep their snap; only steps are removed. The value is a
 * direct trade: it caps the per-frame change at roughly 1-exp(-k/60) of the
 * distance to target, so 13 puts a worst-case switch near 11°/frame while
 * costing a 1.2 Hz swing about 13% of its amplitude. Fingers follow slightly
 * slower because a hand changing shape reads as one motion.
 */
const ARM_FOLLOW = 13;
const FINGER_FOLLOW = 13;

/**
 * Seconds of lead per radian the arms have to travel.
 *
 * A gesture's authored `lead` is a floor, not the whole answer: how long the
 * arm needs depends on how far it is from where the gesture wants it, and that
 * is not knowable when the gesture is written. Raising a hand from the hip to
 * beside the face is ~100° and takes about half a second; going there from a
 * pose that already has the hand up takes almost none.
 *
 * Moving every distance in the same fixed time is one of the strongest tells
 * that something is machine-driven — people take longer over longer reaches.
 */
const LEAD_PER_RAD = 0.32;

/**
 * One arm as the blend path sees it: authored directions, a solved reach, or a
 * back-solved point. All three are optional per link, and the palm and the
 * twist are stated by some poses and derived for the rest.
 */
interface ResolvedArm {
  shoulder?: THREE.Vector3;
  upperArm?: THREE.Vector3;
  lowerArm?: THREE.Vector3;
  hand?: THREE.Vector3;
  palm?: THREE.Vector3;
  twist?: number;
}

/**
 * The fingertip request as the solver reads it.
 *
 * `PointSpec` states its directions as authored tuples; this carries the shared
 * scratch vectors the per-side mirror was applied into, which is what keeps a
 * solve that runs up to four times a frame from allocating.
 */
interface PointSolveSpec {
  azimuth: number;
  elevation: number;
  extent: number;
  finger: FingerName;
  point: THREE.Vector3 | null;
  palm: THREE.Vector3 | null;
}

/**
 * A fingertip aim as a caller states it: angles in **degrees**, because the
 * control API and `ctl` speak degrees. `point()` converts to the radians the
 * internal `PointSpec` is in.
 */
export interface PointCommand {
  /** Degrees, 0 straight ahead, positive to the character's right. */
  azimuth?: number;
  /** Degrees, 0 at shoulder height, positive up. */
  elevation?: number;
  /** 0..1 of full reach. */
  extent?: number;
  /** Which fingertip the coordinate refers to. */
  finger?: FingerName;
  point?: Vec3Tuple | null;
  palm?: Vec3Tuple | null;
}

/**
 * A gesture in play. Exported because the UI reads the definition's label and
 * the id straight off the live slot.
 */
export interface ActiveGesture {
  def: GestureDef;
  id: string;
  v: GestureVariation;
  time: number;
  released: boolean;
  speed: number;
  /** Seconds of entrance, this playback's own — see `LEAD_PER_RAD`. */
  lead: number;
}

/** The frame's breath and drift terms, shared by every arm slot's compose step. */
interface IdleEnv {
  br: number;
  d: number;
  armDrift: number;
  kArm: number;
}

/** What the director hands the body layer each frame. */
export interface BodyContext {
  headWorldTarget?: THREE.Vector3 | null;
}

const mkDirs = (): Record<ArmSlot, Vec3Tuple> => ({
  shoulder: [0, 0, 0],
  upperArm: [0, 0, 0],
  lowerArm: [0, 0, 0],
  hand: [0, 0, 0],
});

const mkVecs = (): Record<ArmSlot, THREE.Vector3> => ({
  shoulder: new THREE.Vector3(),
  upperArm: new THREE.Vector3(),
  lowerArm: new THREE.Vector3(),
  hand: new THREE.Vector3(),
});

const mkState = (): Record<ArmSlot, THREE.Vector3> => ({
  shoulder: BASE_POSE.shoulder.clone(),
  upperArm: BASE_POSE.upperArm.clone(),
  lowerArm: BASE_POSE.lowerArm.clone(),
  hand: BASE_POSE.hand.clone(),
});

/**
 * Copy an authored direction into scratch with the side's mirror applied.
 *
 * A pose may state either form — `PointSpec` allows both — and what the solver
 * is handed is always the scratch vector, because a solve runs up to four times
 * a frame and per-frame allocation shows up as dropped frames.
 */
const mirrorInto = (
  out: THREE.Vector3,
  v: Vec3Tuple | THREE.Vector3,
  mirror: number,
): THREE.Vector3 =>
  Array.isArray(v)
    ? out.set((v[0] ?? 0) * mirror, v[1] ?? 0, v[2] ?? 0)
    : out.set(v.x * mirror, v.y, v.z);

const mkReach = (): ArmSolution => ({
  upperArm: new THREE.Vector3(),
  lowerArm: new THREE.Vector3(),
  hand: new THREE.Vector3(),
  palm: new THREE.Vector3(),
  tip: new THREE.Vector3(),
  twist: 0,
});

/**
 * Fill in the palm direction for a *solved* arm, in place.
 *
 * Aiming a hand fixes where the fingers point and leaves the roll about that
 * axis free, so a pose that states no palm gets whatever the shortest rotation
 * happens to produce — which is nothing anybody chose. For an authored pose
 * that is tolerable: the directions were tuned by eye against exactly that
 * behaviour. For a solved one there is nothing to have tuned.
 *
 * Rolling the palm to face the way the wrist has to bend makes that bend
 * flexion instead of deviation, and a wrist has three times more flexion than
 * deviation. Without it a solved hand reaching upward came out with 61 degrees
 * of radial deviation against a limit of 20.
 */
function derivePalm(out: ArmSolution): void {
  const p = out.palm.copy(out.hand).addScaledVector(out.lowerArm, -out.hand.dot(out.lowerArm));
  // A straight wrist bends in no direction, so nothing is determined. Fall back
  // to the resting palm rather than to noise.
  if (p.lengthSq() < 4e-4) p.copy(BASE_PALM);
  p.normalize();
}

export class Body {
  rig: Rig;
  p: Profile;
  t: number;

  breathPeriod: number;
  breathDepth: number;
  idleAmount: number;
  weightShift: number;
  gazeAmount: number;
  lookAt: number;

  speaking: boolean;
  speechEnergy: number;

  gesture: ActiveGesture | null;
  blend: number;
  prev: ActiveGesture | null;
  prevBlend: number;

  hipsRest: THREE.Vector3;
  hipsUnit: number;

  jumpHeight: number;
  gravity: number;

  saccade: number;
  pointStrain: Record<Side, number>;

  private _breathPhase: number;
  private _wasSpeaking: boolean;

  private _jump: JumpArc | null;
  private _jumpT: number;
  private _rise: number;
  private _load: number;

  private _gaze: Gaze;

  private _armDirs: Record<Side, Record<ArmSlot, Vec3Tuple>>;
  private _armVec: Record<Side, Record<ArmSlot, THREE.Vector3>>;
  private _armState: Record<Side, Record<ArmSlot, THREE.Vector3>>;
  private _fingerSpec: Record<Side, Record<FingerName, number>>;
  private _twist: Record<Side, number>;
  private _reach: { cur: Record<Side, ArmSolution>; prev: Record<Side, ArmSolution> };

  private _point: PointSolveSpec;
  private _pointDir: THREE.Vector3;
  private _pointPalm: THREE.Vector3;
  private _anchor: THREE.Vector3;
  private _pole: THREE.Vector3;

  private _palm: Record<Side, THREE.Vector3>;
  private _palmTarget: THREE.Vector3;
  private _palmOut: Record<Side, Vec3Tuple>;
  private _palmW: Record<Side, number>;

  private _tmp: THREE.Vector3;
  private _headTarget: THREE.Vector3;

  constructor(rig: Rig, profile: Profile) {
    this.rig = rig;
    this.p = profile;
    this.t = 0;

    this.breathPeriod = 4.2;
    this.breathDepth = 1;
    this.idleAmount = 1; // head micro-motion, posture drift, arm drift
    this.weightShift = 1; // slow lateral shift of the standing weight
    this.gazeAmount = 1; // saccades layered on top of camera tracking
    this.lookAt = 1; // 0 = straight ahead, 1 = track the camera

    // Set per frame by the director from the mouth layer.
    this.speaking = false;
    this.speechEnergy = 0;

    // Two gesture slots. The second holds whatever is on its way out, so a
    // switch crossfades instead of cutting.
    this.gesture = null;
    this.blend = 0;
    this.prev = null;
    this.prevBlend = 0;

    const hips = profile.bones.hips;
    this.hipsRest = hips ? hips.position.clone() : new THREE.Vector3();

    /**
     * Local units per metre at the hips.
     *
     * The weight shift below is the one place in the runtime that writes a bone
     * *translation* rather than a rotation, and a translation is in the parent's
     * units. Rotations are radians and are the same number on any rig, which is
     * why nothing else has needed this — and why the omission was invisible.
     *
     * One of these avatars is authored in centimetres under a 0.01 scale at the
     * armature (the same fact `profile/bones.ts` records for the arm lengths),
     * so a figure written as 12 mm landed as 0.12 mm and the hips did not move
     * at all. The other is authored in metres and behaved as written, which is
     * exactly the shape of bug that survives being looked at on one avatar.
     */
    this.hipsUnit = 1;
    if (hips?.parent) {
      profile.root.updateMatrixWorld(true);
      const scale = hips.parent.getWorldScale(new THREE.Vector3()).x;
      if (scale > 1e-6) this.hipsUnit = 1 / scale;
    }

    this._breathPhase = 0;
    this._wasSpeaking = false;

    // --- jump ---------------------------------------------------------------
    // Metres the hips rise at the apex, and the gravity the arc is solved under.
    // Real gravity gives a real arc; lowering it keeps the same height and makes
    // the character hang at the top, which is a look and not an error.
    this.jumpHeight = 0.08;
    this.gravity = 9.81;
    this._jump = null;
    this._jumpT = 0;
    this._rise = 0; // hips above rest this frame, metres
    this._load = 0; // 0..1, how far into the dip the body is

    // Gaze wanders and snaps back rather than staring; `saccade` carries the
    // amplitude on the frame a new fixation starts so the director can blink
    // with it.
    this._gaze = new Gaze();
    this.saccade = 0;

    // Pre-allocated per side and slot. This runs every frame for hours at a
    // time, and steady garbage shows up as dropped frames long before it shows
    // up as memory.
    this._armDirs = { L: mkDirs(), R: mkDirs() };
    this._armVec = { L: mkVecs(), R: mkVecs() }; // composed target for this frame
    this._armState = { L: mkState(), R: mkState() }; // what the arm is actually doing
    this._fingerSpec = { L: { ...BASE_FINGERS }, R: { ...BASE_FINGERS } };
    this._twist = { L: 0, R: 0 };

    // Resolved IK output, one set per gesture slot so an outgoing reach and an
    // incoming one can both be live during a crossfade.
    this._reach = {
      cur: { L: mkReach(), R: mkReach() },
      prev: { L: mkReach(), R: mkReach() },
    };

    // Request object handed to the fingertip solver, reused rather than rebuilt
    // — `resolveArm` runs up to four times a frame.
    this._point = {
      azimuth: 0,
      elevation: 0,
      extent: 0.8,
      finger: 'index',
      point: null,
      palm: null,
    };
    this.pointStrain = { L: 0, R: 0 };
    this._pointDir = new THREE.Vector3();
    this._pointPalm = new THREE.Vector3();
    this._anchor = new THREE.Vector3();
    // Separate from `_anchor`, which is still holding the reach target when the
    // pole is built.
    this._pole = new THREE.Vector3();

    this._palm = { L: BASE_PALM.clone(), R: BASE_PALM.clone() };
    this._palmTarget = new THREE.Vector3();
    this._palmOut = { L: [0, 0, 0], R: [0, 0, 0] };
    this._palmW = { L: 1, R: 1 }; // how strongly the palm target is honoured

    this._tmp = new THREE.Vector3();
    this._headTarget = new THREE.Vector3();
  }

  /**
   * World position of a face anchor, for gestures that touch the face.
   * `side` picks which cheek/ear/temple, so one definition serves both hands.
   */
  private anchorWorld(
    name: string,
    offset: Vec3Tuple | undefined,
    side: Side,
  ): THREE.Vector3 | null {
    const { face, bones } = this.p;
    const head = bones.head;
    if (!(face && head)) return null;
    const a = FACE_ANCHORS[name] ?? FACE_ANCHORS.mouth;
    const o = offset ?? [0, 0, 0];
    const s = side === 'R' ? 1 : -1;
    const v = this._anchor.copy(face.origin);
    v.addScaledVector(face.right, (a[0] + o[0]) * s * face.ipd);
    v.addScaledVector(face.up, (a[1] + o[1]) * face.ipd);
    v.addScaledVector(face.forward, (a[2] + o[2]) * face.ipd);
    head.updateWorldMatrix(true, false);
    return v.applyMatrix4(head.matrixWorld);
  }

  /**
   * World position of a body anchor, for gestures whose hands meet each other.
   *
   * No matrix to apply, unlike the face: `anatomy/arm.ts` already keeps the body
   * frame in world space and refreshes it once a frame, because every joint
   * limit is measured against it. Anchoring to the chest rather than the hips
   * is what makes a held pose survive the character leaning — the hands stay
   * clasped in front of the chest instead of being left behind by it.
   *
   * `side` mirrors the lateral component the same way the face anchors do, so
   * one spec puts both hands symmetrically either side of the midline.
   */
  private bodyAnchorWorld(
    name: string,
    offset: Vec3Tuple | undefined,
    side: Side,
  ): THREE.Vector3 | null {
    const span = this.p.body?.span;
    const anat = this.rig.anat;
    if (!(span && anat?.update())) return null;
    const a = BODY_ANCHORS[name] ?? BODY_ANCHORS.sternum;
    const o = offset ?? [0, 0, 0];
    const s = side === 'R' ? 1 : -1;
    return this._anchor
      .copy(anat.axisO)
      .addScaledVector(anat.right, (a[0] + o[0]) * s * span)
      .addScaledVector(anat.up, (a[1] + o[1]) * span)
      .addScaledVector(anat.fwd, (a[2] + o[2]) * span);
  }

  /**
   * World position of a gesture's elbow pole, offset from the shoulder in body
   * spans and character space, so the two arms mirror.
   *
   * Anchored on the shoulder rather than the chest because that is what makes
   * the numbers say something an author can picture: an elbow hanging beside
   * the ribs is roughly one upper arm below the shoulder whatever the pose is
   * doing, whereas the same place named from the sternum moves as the character
   * leans. See `Rig.poleAngle` for why this is a point and not an angle.
   */
  private poleWorld(pole: Vec3Tuple, side: Side): THREE.Vector3 | null {
    const span = this.p.body?.span;
    const upper = this.p.bones?.[`upperArm.${side}`];
    const anat = this.rig.anat;
    if (!(span && upper && anat?.update())) return null;
    const s = side === 'R' ? 1 : -1;
    upper.updateWorldMatrix(true, false);
    return upper
      .getWorldPosition(this._pole)
      .addScaledVector(anat.right, (pole[0] ?? 0) * s * span)
      .addScaledVector(anat.up, (pole[1] ?? 0) * span)
      .addScaledVector(anat.fwd, (pole[2] ?? 0) * span);
  }

  /**
   * Where a reach wants the wrist, in world space, or null if this rig cannot
   * resolve the frame it is anchored to.
   *
   * Shared with `resolveArm` because the girdle has to know the target before
   * the shoulder is posed, and the shoulder has to be posed before the arm can
   * be solved from it. Nothing here depends on the arm, so the order works out.
   */
  private reachTarget(r: ReachSpec | undefined, side: Side, mirror: number): THREE.Vector3 | null {
    if (!r) return null;
    const target =
      r.space === 'body'
        ? this.bodyAnchorWorld(r.at, r.offset, side)
        : this.p.face && this.p.bones.head
          ? this.anchorWorld(r.at, r.offset, side)
          : null;
    if (!target) return null;
    if (r.hand && r.space !== 'body') {
      const back = (this.p.limb?.[`tip.${side}.middle`] ?? 0) * HAND_CONTACT;
      if (back > 0) {
        target.addScaledVector(
          this._pointDir.set(r.hand[0] * mirror, r.hand[1], r.hand[2]).normalize(),
          -back,
        );
      }
    }
    return target;
  }

  /**
   * The arm spec for one side of a gesture pose: authored directions, the
   * solved result of a `reach`, or the back-solved result of a `point`. All
   * three come back in character space, so the blend path downstream cannot
   * tell them apart — which is what lets a point crossfade with a wave.
   */
  private resolveArm(
    pose: Pose | null,
    side: Side,
    mirror: number,
    slotName: 'cur' | 'prev',
  ): ResolvedArm | null {
    const pt = pose?.point?.[side];
    if (pt) {
      const out = this._reach[slotName][side];
      // Azimuth is a bearing in the body's own frame, where positive is the
      // character's right for both arms. A gesture wants it mirrored — "point
      // outward" should work on either hand — and an external caller naming an
      // absolute direction does not, so the spec says which it meant.
      const spec = this._point;
      spec.azimuth = (pt.azimuth ?? 0) * (pt.mirror === false ? 1 : mirror);
      spec.elevation = pt.elevation ?? 0;
      spec.extent = pt.extent ?? 0.8;
      spec.finger = pt.finger ?? 'index';
      spec.point = pt.point ? mirrorInto(this._pointDir, pt.point, mirror) : null;
      spec.palm = pt.palm ? mirrorInto(this._pointPalm, pt.palm, mirror) : null;
      if (!this.rig.solvePoint(side, spec, out)) return pose?.arms?.[side] ?? null;
      // How hard the resulting pose was on the joints, kept so a caller can
      // tell an aim that was met from one the arm could only approximate.
      // Reaching for something out of range does not fail — the arm goes as far
      // as it can, which is what a person does — so without this the answer to
      // "did it work" is a screenshot.
      this.pointStrain[side] = out.strain ?? 0;
      // Solved in world space; the blend path re-applies the mirror on the way
      // out, and mirror is ±1 so multiplying inverts it.
      out.upperArm.x *= mirror;
      out.lowerArm.x *= mirror;
      out.hand.x *= mirror;
      out.palm.x *= mirror;
      out.twist = pt.twist ?? 0;
      return out;
    }

    const r = pose?.reach?.[side];
    if (!r) return pose?.arms?.[side] ?? null;

    // Either frame can be unavailable on a rig the profile could not fully
    // resolve, and a gesture that cannot be solved falls back to whatever
    // directions it also carries rather than dropping the arm.
    //
    // The anchor is where the *hand* meets the body and the wrist belongs
    // behind it, which `reachTarget` accounts for. Putting the wrist on the
    // anchor is what the first version did, and it buries the whole hand: the
    // anchor sits on the skin, so the palm and fingers continue on into it.
    // Every one of the face-touching gestures came out with the hand inside the
    // head, and no choice of elbow could fix it — sampling the elbow circle for
    // `hairTouch`, the *shallowest* candidate was still 28% inside. The elbow
    // has no authority over where the wrist is.
    const target = this.reachTarget(r, side, mirror);
    if (!target) return pose?.arms?.[side] ?? null;
    const out = this._reach[slotName][side];
    const hint = r.hand
      ? this._pointDir.set(r.hand[0] * mirror, r.hand[1], r.hand[2]).normalize()
      : null;

    // A pole point is the preferred way to state the elbow, and the only one
    // that stays meaningful while the hand is travelling. `elbow` remains for a
    // pose that wants the raw angle, and a pose that states neither falls back
    // to searching the circle for the least strained place to put it.
    const poleW = r.pole ? this.poleWorld(r.pole, side) : null;
    const poleA = poleW ? this.rig.poleAngle(side, target, poleW) : null;
    let solved = false;
    if (poleA !== null) {
      out.poleA = poleA;
      solved = !!this.rig.solveReach(side, target, poleA, out);
    } else if (r.pole && out.poleA !== undefined) {
      // The pole crossed the reach line, where it says nothing about the elbow.
      // Holding the last angle rides through; recomputing from the noise, or
      // dropping to a different rule for a frame, both show as a snap. The slot
      // is reused by successive gestures, so this can be a stale angle on the
      // first frame of a new one — a frame of the wrong elbow, and not a jump.
      solved = !!this.rig.solveReach(side, target, out.poleA, out);
    } else if (r.elbow !== undefined) {
      // Authored in character terms, so the two arms mirror. A rotation about a
      // mirrored axis runs the other way, which `mirror` being ±1 takes care of.
      solved = !!this.rig.solveReach(side, target, r.elbow * mirror, out);
    } else {
      solved = !!this.rig.solveReachNatural(side, target, hint, out);
    }
    if (!solved) return pose?.arms?.[side] ?? null;

    // Back to character space; the blend path re-applies the mirror on the way
    // out, and mirror is ±1 so multiplying inverts it.
    out.upperArm.x *= mirror;
    out.lowerArm.x *= mirror;
    // `hand` and `palm` are authored in character space and left in it; the
    // blend path mirrors both on the way out. Only the solved limb directions
    // above arrive in world space and have to be brought back.
    if (r.hand) out.hand.set(r.hand[0], r.hand[1], r.hand[2]).normalize();
    else out.hand.copy(out.lowerArm);
    if (r.palm) out.palm.set(r.palm[0], r.palm[1], r.palm[2]).normalize();
    else derivePalm(out);
    out.twist = r.twist ?? 0;
    return out;
  }

  /**
   * Blend one arm slot's direction for this frame and write it into `_armDirs`.
   *
   * `pDir`/`cDir` are the outgoing and incoming gesture's directions for this
   * slot, either of which may be absent.
   */
  private composeArmDir(
    slot: ArmSlot,
    side: Side,
    mirror: number,
    env: IdleEnv,
    pDir?: THREE.Vector3,
    cDir?: THREE.Vector3,
  ): Vec3Tuple {
    const v = this._armVec[side][slot].copy(BASE_POSE[slot]);
    // Outgoing first, then incoming: the incoming gesture takes over as its
    // blend rises, and the two never both sit at full weight.
    if (pDir) v.lerp(pDir, this.prevBlend).normalize();
    if (cDir) v.lerp(cDir, this.blend).normalize();

    // Breathing and idle drift are added *after* the gesture blend, not before
    // it. Folding them into the base pose means a gesture at full strength
    // lerps them away and the arms go dead mid-motion — a hand held in a pose
    // is still attached to someone who is breathing.
    v.y += (slot === 'shoulder' ? 0.022 : 0.014) * env.d * env.br;

    const ph = side === 'L' ? 0 : 1.9;
    const w = env.armDrift * DRIFT_WEIGHT[slot];
    v.y += w * Math.sin(this.t * 0.27 + ph);
    v.z += w * 0.8 * Math.sin(this.t * 0.19 + ph + 0.6);
    v.x += w * 0.5 * Math.sin(this.t * 0.23 + ph + 1.3);
    v.normalize();

    // Follow the target instead of snapping to it. See ARM_FOLLOW.
    const s = this._armState[side][slot].lerp(v, env.kArm).normalize();
    const out = this._armDirs[side][slot];
    out[0] = s.x * mirror;
    out[1] = s.y;
    out[2] = s.z;
    return out;
  }

  /**
   * Aim a fingertip, and hold it there.
   *
   * Built as a gesture rather than as a separate channel. A pointing arm has to
   * crossfade with a wave, take a lead time proportional to how far it travels,
   * hold until released and give way to the next gesture — all of which the
   * gesture slot already does, and none of which is worth a second
   * implementation that would drift out of step with the first.
   *
   *   side       "L" | "R"
   *   azimuth    degrees, 0 straight ahead, positive to the character's right
   *   elevation  degrees, 0 at shoulder height, positive up
   *   extent     0..1 of full reach
   *   finger     which fingertip the coordinate refers to
   *
   * The angles arrive in degrees because that is what the control API and `ctl`
   * state them in, and are converted here: the `PointSpec` everything below
   * this line reads is radians.
   *
   * The torso helps, as it does in life: past about 40 degrees off the midline
   * an arm alone cannot get there comfortably and the chest turns into it. That
   * is stated here rather than in the solver because it has to reach the spine
   * before the frame's spine offsets are committed, and the arms are solved
   * after that.
   */
  point(side: Side, spec: PointCommand = {}): void {
    const D = Math.PI / 180;
    const az = (spec.azimuth ?? 0) * D;
    const el = (spec.elevation ?? 0) * D;
    const extent = spec.extent ?? 0.8;
    const at: PointSpec = {
      azimuth: az,
      elevation: el,
      extent,
      mirror: false,
      finger: spec.finger ?? 'index',
      point: spec.point ?? null,
      palm: spec.palm ?? null,
    };
    // Scaled by extent: turning the chest toward something the hand is not
    // actually reaching for reads as the whole character swivelling.
    const turn = az * 0.22 * extent;
    const lean = -Math.max(0, el) * 0.1 * extent;
    const def: GestureDef = {
      label: '指し示す',
      group: 'explain',
      lead: 0.3,
      hold: 1.6,
      sustain: true,
      build: () => ({
        point: { [side]: at },
        fingers: { [side]: POINT_HAND },
        spine: {
          chest: [lean * 0.6, turn * 0.6, 0],
          spine: [lean * 0.4, turn * 0.4, 0],
        },
      }),
    };
    this.playDef(def, `point.${side}`);
  }

  play(id: string): void {
    const def = GESTURE_TABLE[id];
    if (!def) return;
    this.playDef(def, id);
  }

  /** Start a gesture from a definition object, named or synthesised. */
  playDef(def: GestureDef, id: string): void {
    if (!def) return;
    // Hand the outgoing gesture to the second slot so it fades out while the
    // new one fades in. Dropping it outright leaves the standing blend weight
    // pointing at a completely different pose, and the arms teleport on the
    // switch frame — the most visible artefact this layer had.
    if (this.gesture && this.blend > 0.02) {
      this.prev = this.gesture;
      this.prevBlend = this.blend;
    } else {
      this.prev = null;
      this.prevBlend = 0;
    }
    const v: GestureVariation = {
      // Frequency and amplitude, never phase: `build` is called from t=0 and a
      // phase offset would put every oscillation mid-swing on frame one, which
      // snaps the limb into the gesture instead of easing it in.
      rate: 0.92 + Math.random() * 0.16,
      scale: 0.9 + Math.random() * 0.2,
      side: Math.random() < 0.5 ? -1 : 1,
    };
    this.gesture = {
      def,
      id,
      v,
      time: 0,
      released: false,
      speed: 0.93 + Math.random() * 0.14,
      // Capped: past about a second an entrance stops reading as deliberate and
      // starts reading as slow, however far the arm has to go.
      lead: Math.min(0.95, Math.max(def.lead, this.travel(def, v) * LEAD_PER_RAD)),
    };
    this.blend = 0;
  }

  /** Largest angle any arm has to cover to reach the gesture's opening pose. */
  private travel(def: GestureDef, v: GestureVariation): number {
    const pose = def.build(0, v);
    let worst = 0;
    for (const side of ['L', 'R'] as const) {
      const mirror = side === 'L' ? this.p.sideSign : -this.p.sideSign;
      const arm = this.resolveArm(pose, side, mirror, 'cur');
      if (!arm) continue;
      for (const slot of ARM_SLOTS) {
        const dir = arm[slot];
        if (!dir) continue;
        worst = Math.max(worst, this._armState[side][slot].angleTo(dir));
      }
    }
    return worst;
  }

  /** Release the current gesture, including a sustained pose. */
  stopGesture(): void {
    if (!this.gesture) return;
    this.gesture.released = true;
    const { def, lead } = this.gesture;
    this.gesture.time = Math.max(this.gesture.time, lead + def.hold);
  }

  /** Pick a gesture appropriate to what the character is currently doing. */
  pickGesture(groups: GestureGroup[]): string | null {
    const pool = Object.keys(GESTURE_TABLE).filter((id) =>
      groups.includes(GESTURE_TABLE[id].group),
    );
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  /** Start a small hop. The arc it runs is `planJump`'s. */
  jump(height: number = this.jumpHeight): void {
    this._jump = planJump(height, this.gravity);
    this._jumpT = 0;
  }

  /** Whether a hop is in flight. Read by the panel. */
  get jumping(): boolean {
    return this._jump !== null;
  }

  /**
   * Advance the hop, leaving the hips' rise and the body's compression in
   * `_rise` and `_load`. Both are zero on every frame that is not part of one.
   */
  private jumpStep(dt: number): void {
    this._rise = 0;
    this._load = 0;
    const j = this._jump;
    if (!j) return;

    this._jumpT += dt;
    const s = sampleJump(j, this._jumpT);
    if (s.done) {
      this._jump = null;
      return;
    }
    this._rise = s.rise;
    this._load = s.load;
  }

  /** Current gaze offset in radians, x = yaw, y = pitch. */
  get gaze(): THREE.Vector2 {
    return this._gaze.offset;
  }

  /** Breathing phase, 0..1, exposed so the UI can show it. */
  get breath(): number {
    return breathCurve(this._breathPhase);
  }

  /** Advance one gesture slot and return its pose. */
  private advance(slot: ActiveGesture, dt: number): Pose {
    slot.time += dt;
    return slot.def.build(slot.time * slot.speed, slot.v);
  }

  update(dt: number, { headWorldTarget = null }: BodyContext = {}): void {
    this.t += dt;
    const { rig, p } = this;

    // --- gesture envelopes ------------------------------------------------
    let g: Pose | null = null;
    const variation = this.gesture?.v ?? DEFAULT_VARIATION;
    if (this.gesture) {
      const { def, lead } = this.gesture;
      const t = this.gesture.time + dt;
      const out = lead * 1.25;
      // A sustained pose holds at full weight until it is released.
      const held = def.sustain && !this.gesture.released;
      let target: number;
      // Eased in and out. A linear ramp starts and stops with a visible corner,
      // which is exactly the frame the eye picks up as machine-driven.
      if (t < lead) target = smoothstep(t / lead);
      else if (held || t < lead + def.hold) target = 1;
      else target = smoothstep(Math.max(0, 1 - (t - lead - def.hold) / out));
      target *= variation.scale;
      this.blend += (target - this.blend) * (1 - Math.exp(-dt * 14));
      // Built from t=0, not from t-lead. Freezing the pose through the lead and
      // only starting the motion afterwards makes the gesture appear to begin
      // twice: once as the blend rises, again as the motion kicks in.
      g = this.advance(this.gesture, dt);
      if (target === 0 && this.blend < 0.01) {
        this.gesture = null;
        this.blend = 0;
        g = null;
      }
    } else if (this.blend > 0) {
      this.blend *= Math.exp(-dt * 10);
    }

    let gPrev: Pose | null = null;
    if (this.prev) {
      this.prevBlend *= Math.exp(-dt * 6);
      if (this.prevBlend < 0.01) {
        this.prev = null;
        this.prevBlend = 0;
      }
      // The outgoing gesture keeps moving while it fades. Dissolving a frozen
      // pose looks different from a gesture being abandoned partway through,
      // and the second is what actually happened.
      else gPrev = this.advance(this.prev, dt);
    }

    // --- breathing --------------------------------------------------------
    // Runs unconditionally, including through gestures. A character that stops
    // breathing the moment it raises a hand reads as a puppet.
    //
    // Phase is accumulated rather than derived from absolute time, so changing
    // the period mid-stream eases instead of teleporting the chest.
    if (this.speaking && !this._wasSpeaking) this._breathPhase = 0.04; // catch a breath
    this._wasSpeaking = this.speaking;
    // Speech rides the exhale: the cycle stretches and shallows while talking,
    // and the breath before a line is the part people actually notice missing.
    const period =
      this.breathPeriod * (this.speaking ? 1.5 : 1) * (1 + 0.11 * Math.sin(this.t * 0.077 + 1.4));
    this._breathPhase = (this._breathPhase + dt / period) % 1;

    const breath = breathCurve(this._breathPhase);
    const br = (breath - 0.5) * 2; // -1 .. 1
    const d = this.breathDepth * (this.speaking ? 0.7 : 1);

    rig.addOffset('spine', -0.014 * d * br, 0, 0);
    rig.addOffset('chest', -0.03 * d * br, 0, 0);
    rig.addOffset('neck', 0.01 * d * br, 0, 0);

    // --- weight shift -----------------------------------------------------
    // Slow lateral transfer of weight with the spine counter-leaning above it,
    // so the head stays roughly over the same point. Deliberately very slow —
    // a ~20 s cycle — and out of phase with the breath so the two never lock
    // into a visible rhythm. Anything faster reads as fidgeting.
    const shift = settle(Math.sin(this.t * 0.31)) * this.weightShift;
    const shiftSlow = settle(Math.sin(this.t * 0.13 + 1.1)) * this.weightShift;

    rig.addOffset('hips', 0, 0.01 * shiftSlow, -0.03 * shift);
    rig.addOffset('spine', 0, 0.008 * shiftSlow, 0.018 * shift);
    rig.addOffset('chest', 0, 0.01 * shiftSlow, 0.01 * shift);
    rig.addOffset('neck', 0, 0, -0.014 * shift);

    // --- jump -------------------------------------------------------------
    // Written into the same translation the weight shift uses, and folded into
    // the spine so the body reads as loading and extending rather than as being
    // moved by a crane. The fold is small: with no legs in the rig the spine is
    // doing the work of the whole body, and a deep fold looks like a bow.
    this.jumpStep(dt);
    if (this._rise !== 0) {
      const load = this._load;
      const stretch = Math.max(0, this._rise) / Math.max(0.005, this.jumpHeight);
      rig.addOffset('spine', 0.085 * load - 0.045 * stretch, 0, 0);
      rig.addOffset('chest', 0.07 * load - 0.035 * stretch, 0, 0);
      rig.addOffset('neck', 0.03 * load - 0.02 * stretch, 0, 0);
    }

    const hips = p.bones.hips;
    if (hips) {
      const u = this.hipsUnit;
      hips.position.set(
        this.hipsRest.x + 0.012 * shift * u,
        this.hipsRest.y + (0.0035 * d * br + this._rise) * u,
        this.hipsRest.z,
      );
    }

    // --- head micro-motion and posture ------------------------------------
    // Several incommensurable sines so the head never returns to exactly the
    // same attitude; a single sine reads as a mechanical nod. All well under
    // 0.5 rad/s — the faster harmonics that were here read as a twitch rather
    // than as breathing-scale drift.
    const idle = this.idleAmount;
    rig.addOffset(
      'head',
      idle * (0.022 * Math.sin(this.t * 0.29 + 0.4) + 0.007 * Math.sin(this.t * 0.71 + 1.9)),
      idle * (0.036 * Math.sin(this.t * 0.19 + 2.1) + 0.011 * Math.sin(this.t * 0.47)),
      idle * (0.022 * Math.sin(this.t * 0.24 + 0.8) + 0.006 * Math.sin(this.t * 0.61 + 2.7)),
    );
    rig.addOffset('chest', 0, 0.013 * idle * Math.sin(this.t * 0.21 + 0.9), 0);

    // Posture drifts on a scale far longer than breath — a couple of minutes —
    // which is what keeps a long shot from settling into a recognisable loop.
    const posture = Math.sin(this.t * 0.041 + 0.7) * idle;
    rig.addOffset('spine', 0.009 * posture, 0, 0);
    rig.addOffset('chest', 0.006 * posture, 0, 0);
    rig.addOffset('neck', -0.008 * posture, 0, 0);

    // Speech carries head motion of its own. Driven off the mouth's envelope so
    // it lands with the voice rather than running on a timer of its own.
    const talk = this.speechEnergy;
    if (talk > 0.001) {
      rig.addOffset(
        'head',
        -0.024 * talk * Math.sin(this.t * 2.31 + 0.5),
        0.016 * talk * Math.sin(this.t * 1.73),
        0.011 * talk * Math.sin(this.t * 1.29 + 2.0),
      );
      rig.addOffset('chest', -0.008 * talk * Math.sin(this.t * 2.31 + 0.5), 0, 0);
    }

    // Both gesture slots contribute to the spine; the outgoing one is fading.
    if (gPrev?.spine) {
      for (const [slot, o] of Object.entries(gPrev.spine) as Array<[SpineSlot, Vec3Tuple]>) {
        rig.addOffset(slot, o[0] * this.prevBlend, o[1] * this.prevBlend, o[2] * this.prevBlend);
      }
    }
    if (g?.spine) {
      for (const [slot, o] of Object.entries(g.spine) as Array<[SpineSlot, Vec3Tuple]>) {
        rig.addOffset(slot, o[0] * this.blend, o[1] * this.blend, o[2] * this.blend);
      }
    }

    // --- gaze -------------------------------------------------------------
    this._gaze.update(dt, this.t);
    this.saccade = this._gaze.saccade;
    const head = p.bones.head;
    if (headWorldTarget && head) {
      head.updateWorldMatrix(true, false);
      const hp = head.getWorldPosition(this._tmp);
      const dir = this._headTarget.copy(headWorldTarget).sub(hp).normalize();
      // Partial aim only: a full aim would cancel the idle motion above.
      const k = this.lookAt;
      const camYaw = Math.atan2(dir.x, dir.z) * k;
      const camPitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) * k;
      const amt = this.gazeAmount;

      // Eyes ride the raw saccade plus the microsaccade; head and neck ride the
      // settled copy, which lags and slightly overshoots.
      const eyeYaw = camYaw + (this._gaze.offset.x + this._gaze.micro.x) * amt;
      const eyePitch = camPitch + (this._gaze.offset.y + this._gaze.micro.y) * amt;
      const bodyYaw = camYaw + this._gaze.settled.x * amt;
      const bodyPitch = camPitch + this._gaze.settled.y * amt;

      // Every channel is bounded by the profile's limits. Unbounded tracking of
      // an off-axis camera rotates the iris out of the painted sclera and the
      // eyes go blank white; the body just stops following instead.
      const L = p.gaze;
      const C = THREE.MathUtils.clamp;
      rig.addOffset(
        'neck',
        C(-bodyPitch * 0.16, -L.neckPitch, L.neckPitch),
        C(bodyYaw * 0.16, -L.neckYaw, L.neckYaw),
        0,
      );
      rig.addOffset(
        'head',
        C(-bodyPitch * 0.28, -L.headPitch, L.headPitch),
        C(bodyYaw * 0.28, -L.headYaw, L.headYaw),
        0,
      );
      // Eyes lead the head, as they do in life, but over a range small enough
      // that turning to look at something is carried almost entirely by the
      // head. Saturated rather than clamped, per `saturate` above.
      const ey = saturate(eyeYaw * 0.5, L.eyeYaw);
      const ep = saturate(-eyePitch * 0.5, L.eyePitch);
      for (const side of ['L', 'R'] as const) rig.addOffset(`eye.${side}`, ep, ey, 0);
    }

    rig.commitSpine();

    // --- arms -------------------------------------------------------------
    const armDrift = 0.016 * idle;
    const kArm = 1 - Math.exp(-dt * ARM_FOLLOW);
    const kFinger = 1 - Math.exp(-dt * FINGER_FOLLOW);

    const env: IdleEnv = { br, d, armDrift, kArm };

    for (const side of ['L', 'R'] as const) {
      const mirror = side === 'L' ? p.sideSign : -p.sideSign;
      const dirs = this._armDirs[side];

      // The shoulder is posed before the arm is solved, not with it. A reach
      // starts from the upper arm's world position, and posing the shoulder
      // moves that position — by a quarter of an interpupillary distance on
      // this rig. Solving first and posing after leaves every reach short by
      // exactly that, permanently: the shoulder is back at its rest orientation
      // by the time the next frame solves, so there is nothing to converge on.
      // Only authored directions are read here; a reach never states a shoulder.
      this.composeArmDir(
        'shoulder',
        side,
        mirror,
        env,
        gPrev?.arms?.[side]?.shoulder,
        g?.arms?.[side]?.shoulder,
      );

      // Give the girdle its say before the shoulder is posed. Only for a reach,
      // and only where the pose has no shoulder of its own to state — a gesture
      // that says where the shoulder goes means it.
      const gr = g?.reach?.[side];
      if (gr && !g?.arms?.[side]?.shoulder) {
        const gt = this.reachTarget(gr, side, mirror);
        if (gt) rig.girdleRoom(side, gt, dirs.shoulder, this.blend);
      }
      rig.aimShoulder(side, dirs.shoulder);

      const pArm = this.resolveArm(gPrev, side, mirror, 'prev');
      const cArm = this.resolveArm(g, side, mirror, 'cur');
      for (const slot of ARM_SLOTS) {
        if (slot === 'shoulder') continue;
        this.composeArmDir(slot, side, mirror, env, pArm?.[slot], cArm?.[slot]);
      }

      const twistTarget = (pArm?.twist ?? 0) * this.prevBlend + (cArm?.twist ?? 0) * this.blend;
      this._twist[side] += (twistTarget - this._twist[side]) * kArm;

      // Palm direction blends and follows like the limb directions do.
      const pt = this._palmTarget.copy(BASE_PALM);
      if (pArm?.palm) pt.lerp(pArm.palm, this.prevBlend).normalize();
      if (cArm?.palm) pt.lerp(cArm.palm, this.blend).normalize();
      const ps = this._palm[side].lerp(pt, kArm).normalize();
      const po = this._palmOut[side];
      po[0] = ps.x * mirror;
      po[1] = ps.y;
      po[2] = ps.z;

      // BASE_PALM describes an arm hanging at the side, and only that. A pose
      // that raises the hand and states no palm of its own must not be held to
      // it — keeping a lifted hand rolled as though it were still by the hip
      // demands most of a half turn, which is where the wrist collapsed. Such a
      // pose releases the constraint as it blends in and the roll falls back to
      // whatever the aim itself produces.
      let pw = 1;
      if (pArm && !pArm.palm) pw -= this.prevBlend;
      if (cArm && !cArm.palm) pw -= this.blend;
      this._palmW[side] += (Math.max(0, pw) - this._palmW[side]) * kArm;

      rig.aimArm(side, dirs, this._twist[side] * mirror, po, this._palmW[side]);

      const pf = gPrev?.fingers?.[side];
      const cf = g?.fingers?.[side];
      const spec = this._fingerSpec[side];
      for (const f of FINGER_NAMES) {
        let val = BASE_FINGERS[f];
        const pv = pf?.[f];
        const cv = cf?.[f];
        if (pv !== undefined) val += (pv - val) * this.prevBlend;
        if (cv !== undefined) val += (cv - val) * this.blend;
        spec[f] += (val - spec[f]) * kFinger;
      }
      rig.curlHand(side, spec);
    }
  }
}
