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
import { gestureDef } from './custom';
import { DirFollower, ScalarFollower } from './follow';
import { Gaze } from './gaze';
import { BASE_FINGERS, BASE_PALM, BASE_POSE, GESTURES, pointHand } from './gestures';
import { breathCurve, DEFAULT_VARIATION, saturate, settle } from './idle';
import { CROUCH_T, type HopSpec, type JumpArc, planJump, sampleJump } from './jump';
import { FINGER_ONSET, LINK_ONSET, minJerk, onset, reachEnvelope } from './timing';

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

/**
 * The built-in gesture table.
 *
 * What `play` looks up is `gestureDef`, which is this plus whatever motions the
 * renderer loaded. This name is for the one thing that must stay built-in only:
 * the autopilot's pool. See `pickGesture`.
 */
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
 * decides *which* discontinuous target is in force. A follower does, because no
 * step in the target survives one.
 *
 * The cutoff sits above the fastest authored oscillation (`deny` swings at
 * ~1.4 Hz), so gestures keep their snap; only steps are removed. The value is a
 * direct trade: it caps the per-frame change at roughly 1-exp(-k/60) of the
 * distance to target, so 13 puts a worst-case switch near 11°/frame while
 * costing a 1.2 Hz swing about 13% of its amplitude. Fingers follow slightly
 * slower because a hand changing shape reads as one motion.
 *
 * Quoted in first-order terms, which is how they were measured; `follow.ts`
 * converts. The filter itself is second-order — see there for why.
 */
const ARM_FOLLOW = 13;
const FINGER_FOLLOW = 13;

/**
 * How fast the limb follows while a reach is carrying the wrist through the
 * room.
 *
 * The follower exists to take steps out of a target that jumps. A travelling
 * reach has no steps in it: the target is interpolated from where the wrist
 * already was, on a curve that is smooth in position, velocity and
 * acceleration. So there is nothing left for the filter to do, and what it does
 * instead is bend the path — a lag in *direction* space pulls the hand off the
 * curve it was being sent along, and the arm arrives at each frame's target one
 * pose behind, which is the one thing a travelling reach must not do.
 *
 * Not switched off outright, because the first frame of a travel can still step:
 * the elbow the search picks for the departure point need not be the one the
 * arm was holding. At four times the standing rate that resolves inside three
 * frames and the rest of the path runs where it was aimed.
 */
const TRAVEL_FOLLOW = ARM_FOLLOW * 4;

/**
 * Sides, in the order the arm loop walks them.
 */
const SIDES: readonly Side[] = ['L', 'R'];

/** Lateral sign in the semantic character frame, independent of world yaw. */
const sideMirror = (side: Side): number => (side === 'R' ? 1 : -1);

/** Axial rotation sign; it retains the shipped left/right twist orientation. */
const rotationMirror = (side: Side): number => -sideMirror(side);

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
 * scratch vectors after character-to-world projection, which is what keeps a
 * solve that runs up to four times a frame from allocating.
 */
interface PointSolveSpec {
  azimuth: number;
  elevation: number;
  extent: number;
  finger: FingerName;
  /** World-space scratch vectors handed to Rig.solvePoint. */
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
  dt: number;
}

/**
 * The two halves of a gesture's envelope, kept apart rather than multiplied.
 *
 * `blend` — their product — is what the pose is worth this frame and is all
 * most of the layer needs. A reach that travels through the room needs them
 * separately: the entrance says how far along its path the hand is, and only
 * the exit may take the arm back off the pose. Multiplying first loses which of
 * the two a falling weight came from, and a reach cannot tell a hand that has
 * not set out yet from one that is being let go.
 */
interface Envelope {
  /** 0 to 1 over the lead, then held. Never falls. */
  entrance: number;
  /** 1 until the gesture is let go, then back to 0. Never rises. */
  exit: number;
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

const mkState = (): Record<ArmSlot, DirFollower> => ({
  shoulder: new DirFollower(BASE_POSE.shoulder),
  upperArm: new DirFollower(BASE_POSE.upperArm),
  lowerArm: new DirFollower(BASE_POSE.lowerArm),
  hand: new DirFollower(BASE_POSE.hand),
});

const mkFingerState = (): Record<FingerName, ScalarFollower> => ({
  thumb: new ScalarFollower(BASE_FINGERS.thumb),
  index: new ScalarFollower(BASE_FINGERS.index),
  middle: new ScalarFollower(BASE_FINGERS.middle),
  ring: new ScalarFollower(BASE_FINGERS.ring),
  little: new ScalarFollower(BASE_FINGERS.little),
});

const mkFingerSpread = (): Record<FingerName, number> => ({
  thumb: 0,
  index: 0,
  middle: 0,
  ring: 0,
  little: 0,
});

const mkFingerSpreadState = (): Record<FingerName, ScalarFollower> => ({
  thumb: new ScalarFollower(0),
  index: new ScalarFollower(0),
  middle: new ScalarFollower(0),
  ring: new ScalarFollower(0),
  little: new ScalarFollower(0),
});

const mkEnv = (): Envelope => ({ entrance: 0, exit: 1 });

const mkArmEnv = (): Record<ArmSlot, Envelope> => ({
  shoulder: mkEnv(),
  upperArm: mkEnv(),
  lowerArm: mkEnv(),
  hand: mkEnv(),
});

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
  private _armWorld: Record<Side, Record<ArmSlot, Vec3Tuple>>;
  private _armVec: Record<Side, Record<ArmSlot, THREE.Vector3>>;
  private _armState: Record<Side, Record<ArmSlot, DirFollower>>;
  private _fingerSpec: Record<Side, Record<FingerName, number>>;
  private _fingerState: Record<Side, Record<FingerName, ScalarFollower>>;
  private _fingerSpreadSpec: Record<Side, Record<FingerName, number>>;
  private _fingerSpreadState: Record<Side, Record<FingerName, ScalarFollower>>;
  private _twist: Record<Side, ScalarFollower>;
  private _reach: { cur: Record<Side, ArmSolution>; prev: Record<Side, ArmSolution> };

  /**
   * The current gesture's envelope, split per arm link by its onset delay, and
   * the plain one everything else reads. Recomputed each frame; held on the
   * instance only so the arm loop and the reach resolver see the same numbers.
   */
  private _env: Envelope;
  private _armEnv: Record<ArmSlot, Envelope>;
  private _fingerEnv: Envelope;

  /**
   * Where each wrist was standing when the current gesture started, and whether
   * that is known for this side.
   *
   * A reach interpolates its target from here, so the hand crosses the room in
   * a straight line instead of along whatever arc four independently blended
   * link directions happen to trace. Captured once at the switch rather than
   * tracked, because the departure point of a movement does not move.
   */
  private _wristFrom: Record<Side, THREE.Vector3>;
  private _wristKnown: Record<Side, boolean>;
  private _travelS: THREE.Vector3;
  private _travelA: THREE.Vector3;
  private _travelB: THREE.Vector3;
  /** Whether the current gesture is carrying this side's hand through the room. */
  private _travelling: Record<Side, boolean>;

  private _point: PointSolveSpec;
  private _pointDir: THREE.Vector3;
  private _pointPalm: THREE.Vector3;
  private _anchor: THREE.Vector3;
  private _pole: THREE.Vector3;

  private _palm: Record<Side, DirFollower>;
  private _palmTarget: THREE.Vector3;
  private _palmOut: Record<Side, Vec3Tuple>;
  private _palmWorldOut: Record<Side, Vec3Tuple>;
  private _palmW: Record<Side, ScalarFollower>;

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
    this._armWorld = { L: mkDirs(), R: mkDirs() };
    this._armVec = { L: mkVecs(), R: mkVecs() }; // composed target for this frame
    this._armState = { L: mkState(), R: mkState() }; // what the arm is actually doing
    this._fingerSpec = { L: { ...BASE_FINGERS }, R: { ...BASE_FINGERS } };
    this._fingerState = {
      L: mkFingerState(),
      R: mkFingerState(),
    };
    this._fingerSpreadSpec = { L: mkFingerSpread(), R: mkFingerSpread() };
    this._fingerSpreadState = { L: mkFingerSpreadState(), R: mkFingerSpreadState() };
    this._twist = { L: new ScalarFollower(0), R: new ScalarFollower(0) };

    this._env = mkEnv();
    this._armEnv = mkArmEnv();
    this._fingerEnv = mkEnv();

    this._wristFrom = { L: new THREE.Vector3(), R: new THREE.Vector3() };
    this._wristKnown = { L: false, R: false };
    this._travelling = { L: false, R: false };
    this._travelS = new THREE.Vector3();
    this._travelA = new THREE.Vector3();
    this._travelB = new THREE.Vector3();

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

    this._palm = { L: new DirFollower(BASE_PALM), R: new DirFollower(BASE_PALM) };
    this._palmTarget = new THREE.Vector3();
    this._palmOut = { L: [0, 0, 0], R: [0, 0, 0] };
    this._palmWorldOut = { L: [0, 0, 0], R: [0, 0, 0] };
    // How strongly the palm target is honoured. A weight on a constraint rather
    // than something with a trajectory, so it is clamped where it is read: a
    // filter with momentum can undershoot past zero, and a negative weight
    // does not mean "less constrained", it means the palm faces backwards.
    this._palmW = { L: new ScalarFollower(1), R: new ScalarFollower(1) };

    this._tmp = new THREE.Vector3();
    this._headTarget = new THREE.Vector3();
  }

  /**
   * The profile's `sideSign` is only a fallback for a rig with no body frame.
   * Once anatomy has resolved, the lateral axis comes from the live chest and
   * therefore follows root yaw and every committed spine offset.
   */
  private legacyMirror(side: Side): number {
    return side === 'L' ? this.p.sideSign : -this.p.sideSign;
  }

  /**
   * Sign for rotations about an arm axis. With a resolved body frame the
   * lateral semantic sign and the axial sign differ; without one, preserve the
   * profile's pre-frame convention exactly.
   */
  private axialMirror(side: Side, frameReady?: boolean): number {
    const ready = frameReady ?? this.rig.anat.update();
    return ready ? rotationMirror(side) : this.legacyMirror(side);
  }

  /**
   * Project a character-space direction into world space without touching the
   * authored tuple. `lateral` is normally the semantic side sign; a value of
   * one is used for an absolute point bearing. The fallback deliberately keeps
   * the old world-X behaviour when no anatomical frame can be resolved.
   */
  private characterToWorld(
    out: THREE.Vector3,
    value: Vec3Tuple | THREE.Vector3,
    side: Side,
    lateral = sideMirror(side),
    frameReady?: boolean,
  ): THREE.Vector3 {
    const x = (Array.isArray(value) ? (value[0] ?? 0) : value.x) * lateral;
    const y = Array.isArray(value) ? (value[1] ?? 0) : value.y;
    const z = Array.isArray(value) ? (value[2] ?? 0) : value.z;
    const ready = frameReady ?? this.rig.anat.update();
    if (ready) {
      const { anat } = this.rig;
      return out
        .copy(anat.right)
        .multiplyScalar(x)
        .addScaledVector(anat.up, y)
        .addScaledVector(anat.fwd, z)
        .normalize();
    }
    return out
      .set((Array.isArray(value) ? (value[0] ?? 0) : value.x) * -this.p.sideSign * lateral, y, z)
      .normalize();
  }

  /**
   * The tuple form of `characterToWorld`, for the world-space contract at the
   * Rig boundary. A separate buffer keeps `_armDirs` and `_palmOut` canonical.
   */
  private characterTupleToWorld(
    out: Vec3Tuple,
    value: Vec3Tuple | THREE.Vector3,
    side: Side,
    lateral = sideMirror(side),
    frameReady?: boolean,
  ): Vec3Tuple {
    const x = (Array.isArray(value) ? (value[0] ?? 0) : value.x) * lateral;
    const y = Array.isArray(value) ? (value[1] ?? 0) : value.y;
    const z = Array.isArray(value) ? (value[2] ?? 0) : value.z;
    const ready = frameReady ?? this.rig.anat.update();
    if (ready) {
      const { anat } = this.rig;
      out[0] = anat.right.x * x + anat.up.x * y + anat.fwd.x * z;
      out[1] = anat.right.y * x + anat.up.y * y + anat.fwd.y * z;
      out[2] = anat.right.z * x + anat.up.z * y + anat.fwd.z * z;
      return out;
    }
    out[0] = (Array.isArray(value) ? (value[0] ?? 0) : value.x) * -this.p.sideSign * lateral;
    out[1] = y;
    out[2] = z;
    return out;
  }

  /**
   * Bring a world-space solver result back into the canonical blend frame.
   * Solvers never write into the follower state directly: this inverse is the
   * one boundary where a world result becomes a character-space direction.
   */
  private worldToCharacter(
    out: THREE.Vector3,
    value: THREE.Vector3,
    side: Side,
    frameReady?: boolean,
  ): THREE.Vector3 {
    const ready = frameReady ?? this.rig.anat.update();
    if (ready) {
      const { anat } = this.rig;
      const x = value.dot(anat.right) * sideMirror(side);
      const y = value.dot(anat.up);
      const z = value.dot(anat.fwd);
      return out.set(x, y, z).normalize();
    }
    return out.set(value.x * this.legacyMirror(side), value.y, value.z).normalize();
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
  private reachTarget(
    r: ReachSpec | undefined,
    side: Side,
    frameReady?: boolean,
  ): THREE.Vector3 | null {
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
          this.characterToWorld(this._pointDir, r.hand, side, sideMirror(side), frameReady),
          -back,
        );
      }
    }
    return target;
  }

  /**
   * Move a reach's target back along the path the wrist is taking to it, to
   * wherever the entrance has got to. In place.
   *
   * Interpolated about the shoulder — the bearing swung and the distance eased
   * — and not along the straight line between the two points.
   *
   * A straight line is what the minimum-jerk result describes, and it is the
   * right path for a reach out into the room. It is the wrong one for a reach
   * that lands on the body. The straight line from a hand at the hip to a hand
   * at the chin passes within a hand's breadth of the shoulder itself, and the
   * two-link solve there is worthless: the elbow circle is enormous, the map
   * from swivel to pose is near-vertical, and the arm has to fold past its own
   * flexion stop to put the wrist on the line at all. Driven along it the wrist
   * dived to within four centimetres of the shoulder with the elbow at 169
   * degrees against a limit of 150, then snapped back out — a worse artefact
   * than the wandering it was meant to fix.
   *
   * Swinging the bearing keeps the wrist on an arc that stays inside the
   * reachable band the whole way, because both of its endpoints are, and it is
   * also what an arm reaching to its own face does: the hand comes round rather
   * than through. The result is still a straight line wherever the two ends sit
   * at a similar distance from the shoulder, which is the case the minimum-jerk
   * model was measured on.
   */
  private travelTarget(target: THREE.Vector3, side: Side, e: number): void {
    const from = this._wristFrom[side];
    const upper = this.p.bones[`upperArm.${side}`];
    if (!upper) {
      target.lerpVectors(from, target, e);
      return;
    }
    upper.updateWorldMatrix(true, false);
    const S = upper.getWorldPosition(this._travelS);
    const a = this._travelA.copy(from).sub(S);
    const b = this._travelB.copy(target).sub(S);
    const ra = a.length();
    const rb = b.length();
    if (ra < 1e-6 || rb < 1e-6) {
      target.lerpVectors(from, target, e);
      return;
    }
    a.divideScalar(ra);
    b.divideScalar(rb);

    const angle = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
    const sin = Math.sin(angle);
    // Nothing to swing through, or the two bearings are opposed and every arc
    // between them is as good as any other. Easing the distance alone is the
    // whole answer in the first case and no worse than a guess in the second.
    if (sin > 1e-6) {
      a.multiplyScalar(Math.sin((1 - e) * angle) / sin).addScaledVector(
        b,
        Math.sin(e * angle) / sin,
      );
      a.normalize();
    }
    target.copy(S).addScaledVector(a, ra + (rb - ra) * e);
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
    timed = false,
    frameReady?: boolean,
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
      // These tuples are authored in the character frame too. An absolute
      // point bearing and its palm keep their lateral sign for either arm;
      // otherwise both mirror because the pose is relative to the hand's side.
      spec.point = pt.point
        ? this.characterToWorld(
            this._pointDir,
            pt.point,
            side,
            pt.mirror === false ? 1 : mirror,
            frameReady,
          )
        : null;
      spec.palm = pt.palm
        ? this.characterToWorld(
            this._pointPalm,
            pt.palm,
            side,
            pt.mirror === false ? 1 : mirror,
            frameReady,
          )
        : null;
      if (!this.rig.solvePoint(side, spec, out)) return pose?.arms?.[side] ?? null;
      // How hard the resulting pose was on the joints, kept so a caller can
      // tell an aim that was met from one the arm could only approximate.
      // Reaching for something out of range does not fail — the arm goes as far
      // as it can, which is what a person does — so without this the answer to
      // "did it work" is a screenshot.
      this.pointStrain[side] = out.strain ?? 0;
      // The solver reports world directions. Keep the follower/blend state in
      // canonical character space until the final Rig call below.
      this.worldToCharacter(out.upperArm, out.upperArm, side, frameReady);
      this.worldToCharacter(out.lowerArm, out.lowerArm, side, frameReady);
      this.worldToCharacter(out.hand, out.hand, side, frameReady);
      this.worldToCharacter(out.palm, out.palm, side, frameReady);
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
    // head, and no choice of elbow could fix it — sampling the whole elbow
    // circle for a hand held beside the temple, the *shallowest* candidate was
    // still 28% inside. The elbow has no authority over where the wrist is.
    const target = this.reachTarget(r, side, frameReady);
    if (!target) return pose?.arms?.[side] ?? null;

    // Carry the wrist through the room rather than through joint space.
    //
    // Solving at the final anchor every frame and blending the four link
    // directions toward the answer is what this did before, and it leaves the
    // hand's path in the room as a by-product: four unit vectors each turning
    // at its own rate trace a path nobody chose, and the hand wanders on its
    // way. People do the opposite — the hand goes where it is going and the
    // joint angles are whatever that requires.
    //
    // So the *target* interpolates and the solver runs on the interpolated
    // point. Departure is where the wrist actually was when the gesture
    // started, so this composes with whatever the arm was doing rather than
    // starting from a rest pose it may be nowhere near.
    //
    // On the entrance only. Coming off a pose the arm blends back the old way,
    // because a retreat has nowhere in particular to be and the release ramp
    // already governs it.
    if (timed && this._wristKnown[side]) {
      const e = this._armEnv.hand.entrance;
      if (e < 1) this.travelTarget(target, side, e);
      this._travelling[side] = true;
    }

    const out = this._reach[slotName][side];
    const hint = r.hand
      ? this.characterToWorld(this._pointDir, r.hand, side, mirror, frameReady)
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
      // mirrored axis runs the other way; this is axial, not the lateral sign
      // used to project point bearings and directions.
      solved = !!this.rig.solveReach(
        side,
        target,
        r.elbow * this.axialMirror(side, frameReady),
        out,
      );
    } else {
      solved = !!this.rig.solveReachNatural(side, target, hint, out);
    }
    if (!solved) return pose?.arms?.[side] ?? null;

    // Back to character space before blending. The solver's world result is
    // never allowed to become the follower's state, so a root turn cannot
    // masquerade as a gesture change.
    this.worldToCharacter(out.upperArm, out.upperArm, side, frameReady);
    this.worldToCharacter(out.lowerArm, out.lowerArm, side, frameReady);
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
   * slot, either of which may be absent. `pw`/`cw` are what each is worth this
   * frame — per slot rather than per gesture, because the links of a limb do
   * not start together.
   */
  private composeArmDir(
    slot: ArmSlot,
    side: Side,
    env: IdleEnv,
    pDir: THREE.Vector3 | undefined,
    cDir: THREE.Vector3 | undefined,
    pw: number,
    cw: number,
    rate = ARM_FOLLOW,
  ): Vec3Tuple {
    const v = this._armVec[side][slot].copy(BASE_POSE[slot]);
    // Outgoing first, then incoming: the incoming gesture takes over as its
    // blend rises, and the two never both sit at full weight.
    if (pDir) v.lerp(pDir, pw).normalize();
    if (cDir) v.lerp(cDir, cw).normalize();

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
    const s = this._armState[side][slot].step(v, env.dt, rate);
    const out = this._armDirs[side][slot];
    // Keep the follower output in character space. It is projected into world
    // space only at the Rig boundary, after the spine has been committed.
    out[0] = s.x;
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
    const finger = spec.finger ?? 'index';
    const at: PointSpec = {
      azimuth: az,
      elevation: el,
      extent,
      mirror: false,
      finger,
      point: spec.point ?? null,
      palm: spec.palm ?? null,
    };
    // Shaped for the finger that was asked for, not for the index. The solver
    // reads the fingertip's position off this curl, so a hand shaped to point
    // with the wrong finger aims one that is folded into the palm — and the
    // whole arm then travels to put that knuckle where the target is. Built
    // once here rather than inside `build`, which runs every frame.
    const hand = pointHand(finger);
    // Scaled by extent: turning the chest toward something the hand is not
    // actually reaching for reads as the whole character swivelling.
    const turn = az * 0.22 * extent;
    const lean = -Math.max(0, el) * 0.1 * extent;
    const def: GestureDef = {
      label: { en: 'Pointing', ja: '指し示す' },
      group: 'explain',
      lead: 0.3,
      hold: 1.6,
      sustain: true,
      build: () => ({
        point: { [side]: at },
        fingers: { [side]: hand },
        spine: {
          chest: [lean * 0.6, turn * 0.6, 0],
          spine: [lean * 0.4, turn * 0.4, 0],
        },
      }),
    };
    this.playDef(def, `point.${side}`);
  }

  play(id: string): void {
    const def = gestureDef(id);
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
    this._env.entrance = 0;
    this._env.exit = 1;
    for (const slot of ARM_SLOTS) {
      this._armEnv[slot].entrance = 0;
      this._armEnv[slot].exit = 1;
    }
    this._fingerEnv.entrance = 0;
    this._fingerEnv.exit = 1;
    this.markDeparture();
  }

  /**
   * Note where both wrists are standing, as the departure point for any reach
   * the gesture about to start carries.
   *
   * Read off the posed bones rather than reconstructed from the blend state:
   * what a movement leaves from is where the hand *is*, including everything
   * the clamp and the secondary layers did to it, and not where the layer
   * believes it asked for it to be.
   */
  private markDeparture(): void {
    for (const side of SIDES) {
      const hand = this.p.bones[`hand.${side}`];
      this._travelling[side] = false;
      if (!hand) {
        this._wristKnown[side] = false;
        continue;
      }
      hand.updateWorldMatrix(true, false);
      hand.getWorldPosition(this._wristFrom[side]);
      this._wristKnown[side] = true;
    }
  }

  /** Largest angle any arm has to cover to reach the gesture's opening pose. */
  private travel(def: GestureDef, v: GestureVariation): number {
    const pose = def.build(0, v);
    let worst = 0;
    for (const side of ['L', 'R'] as const) {
      const mirror = sideMirror(side);
      const arm = this.resolveArm(pose, side, mirror, 'cur');
      if (!arm) continue;
      for (const slot of ARM_SLOTS) {
        const dir = arm[slot];
        if (!dir) continue;
        worst = Math.max(worst, this._armState[side][slot].dir.angleTo(dir));
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

  /**
   * Pick a gesture appropriate to what the character is currently doing.
   *
   * Built-ins only, deliberately. This is the autopilot: nobody asked for the
   * gesture it returns, so it may only draw from the set that was watched on a
   * render. A motion loaded off disk is played when it is named and never by
   * itself — the first time one appears on air should be a decision.
   */
  pickGesture(groups: GestureGroup[]): string | null {
    const pool = Object.keys(GESTURE_TABLE).filter((id) =>
      groups.includes(GESTURE_TABLE[id].group),
    );
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  /**
   * Start a run of hops. The arc it runs is `planJump`'s, and a run of more
   * than one is continuous — see there for why it needs no gap between them.
   */
  hop({ height = this.jumpHeight, count = 1 }: Partial<HopSpec> = {}): void {
    this._jump = planJump(height, this.gravity, count);
    this._jumpT = 0;
  }

  /** Finish the current hop, dropping any later cycles from a run. */
  finishHop(): void {
    const jump = this._jump;
    if (!jump) return;
    const cycle = jump.push + jump.flight + jump.brake;
    const elapsed = Math.max(0, this._jumpT - CROUCH_T);
    const current = Math.min(jump.count, Math.floor(elapsed / cycle) + 1);
    jump.count = current;
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
      // Eased in and out. A linear ramp starts and stops with a visible corner,
      // which is exactly the frame the eye picks up as machine-driven.
      //
      // The two phases are computed apart and multiplied at the end rather than
      // being decided between: only one of them is ever off 1, so the product
      // is the same number the branch used to produce, and a reach can ask
      // which of the two a weight below 1 came from. See `Envelope`.
      const xIn = lead > 0 ? Math.min(1, t / lead) : 1;
      const xOut = held || t < lead + def.hold ? 1 : Math.max(0, 1 - (t - lead - def.hold) / out);
      this._env.entrance = minJerk(xIn);
      this._env.exit = minJerk(xOut);

      // Per link, staggered outward along the limb and allowed to overshoot.
      for (const slot of ARM_SLOTS) {
        const e = this._armEnv[slot];
        e.entrance = reachEnvelope(onset(xIn, LINK_ONSET[slot]));
        e.exit = this._env.exit;
      }
      // No overshoot on a curl: a finger that opens past straight to settle
      // back is a joint bending the wrong way, not a limb carrying momentum.
      this._fingerEnv.entrance = minJerk(onset(xIn, FINGER_ONSET));
      this._fingerEnv.exit = this._env.exit;

      // The envelope *is* the weight, with nothing chasing it. It is already
      // zero-velocity and zero-acceleration at both ends, so a lag on top adds
      // nothing but lateness and an exponential tail that never quite arrives —
      // and that tail was most of what made a finished gesture read as still
      // settling into itself.
      const target = this._env.entrance * this._env.exit * variation.scale;
      this.blend = target;
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
    // Spine offsets change the body frame. Resolve it once here, after commit,
    // so every direction sent to Rig in this frame uses the same live basis.
    const frameReady = rig.anat.update();

    // --- arms -------------------------------------------------------------
    const armDrift = 0.016 * idle;
    const env: IdleEnv = { br, d, armDrift, dt };
    const scale = variation.scale;

    /**
     * What the current gesture is worth for one channel this frame.
     *
     * Per channel rather than one number for the whole gesture, because the
     * links of a limb do not start together — `this.blend` is what the same
     * expression gives for a channel with no onset delay of its own.
     */
    const plain = (e: Envelope): number => e.entrance * e.exit * scale;

    for (const side of SIDES) {
      const mirror = sideMirror(side);
      const dirs = this._armDirs[side];
      const worldDirs = this._armWorld[side];
      // Set by `resolveArm` below, for this frame only: whether the current
      // gesture is carrying this hand through the room rather than posing it.
      this._travelling[side] = false;

      // The shoulder is posed before the arm is solved, not with it. A reach
      // starts from the upper arm's world position, and posing the shoulder
      // moves that position — by a quarter of an interpupillary distance on
      // this rig. Solving first and posing after leaves every reach short by
      // exactly that, permanently: the shoulder is back at its rest orientation
      // by the time the next frame solves, so there is nothing to converge on.
      // Only authored directions are read here; a reach never states a shoulder.
      const es = this._armEnv.shoulder;
      this.composeArmDir(
        'shoulder',
        side,
        env,
        gPrev?.arms?.[side]?.shoulder,
        g?.arms?.[side]?.shoulder,
        this.prevBlend,
        plain(es),
      );

      // Give the girdle its say before the shoulder is posed. Only for a reach,
      // and only where the pose has no shoulder of its own to state — a gesture
      // that says where the shoulder goes means it.
      const gr = g?.reach?.[side];
      if (gr && !g?.arms?.[side]?.shoulder) {
        const gt = this.reachTarget(gr, side, frameReady);
        this.characterTupleToWorld(worldDirs.shoulder, dirs.shoulder, side, mirror, frameReady);
        if (gt) rig.girdleRoom(side, gt, worldDirs.shoulder, this.blend);
      } else {
        this.characterTupleToWorld(worldDirs.shoulder, dirs.shoulder, side, mirror, frameReady);
      }
      rig.aimShoulder(side, worldDirs.shoulder);

      const pArm = this.resolveArm(gPrev, side, mirror, 'prev', false, frameReady);
      const cArm = this.resolveArm(g, side, mirror, 'cur', true, frameReady);

      /**
       * A link is *carried* when a travelling reach is deciding where it goes,
       * and blended when a pose is.
       *
       * Only the two links that decide where the wrist *is*. The hand's own
       * direction is stated by the pose rather than solved from the target, so
       * there is nothing about it the interpolated point has already eased —
       * carrying it would put the wrist at the gesture's angle while the arm is
       * still down by the hip, which is a request no wrist has the range for.
       * It rides the staggered envelope with the palm and the twist instead.
       *
       * A carried link takes the incoming pose at full weight, because the
       * entrance is already in the target: applying it twice would ease the arm
       * toward a point that is itself still easing, and the hand would leave
       * late and creep the last part of the way. Only the exit may take it back
       * off. The amplitude variation goes too — a travel ends on an anchor that
       * is a point on the body, and scaling a contact by 0.92 is a hand that
       * stops short of the cheek it was reaching for. Variation belongs to the
       * oscillations a gesture writes on top, and they still carry it.
       *
       * The outgoing gesture drops out entirely for the same reason: the travel
       * departs from where the wrist actually was, which already includes
       * whatever the outgoing pose was contributing. Crossfading it back in on
       * top would count it twice.
       */
      const travelling = this._travelling[side];

      for (const slot of ARM_SLOTS) {
        if (slot === 'shoulder') continue;
        const carried = travelling && slot !== 'hand';
        this.composeArmDir(
          slot,
          side,
          env,
          pArm?.[slot],
          cArm?.[slot],
          carried ? 0 : this.prevBlend,
          carried ? this._armEnv[slot].exit : plain(this._armEnv[slot]),
          carried ? TRAVEL_FOLLOW : ARM_FOLLOW,
        );
        this.characterTupleToWorld(worldDirs[slot], dirs[slot], side, mirror, frameReady);
      }

      // The wrist's own channels ride the hand link's envelope: a palm roll and
      // a forearm twist are part of the hand arriving, not of the arm setting
      // out, and starting them with the shoulder is what made a hand appear to
      // present itself before it had gone anywhere.
      //
      // Not travel-aware, unlike the limb directions above. A palm and a twist
      // are stated by the pose rather than solved from the target, so there is
      // nothing about them that the interpolated target has already eased —
      // taking them at full weight from the first frame would be a step. They
      // arrive late instead, which is what a wrist does.
      const cw = plain(this._armEnv.hand);
      const twistTarget = (pArm?.twist ?? 0) * this.prevBlend + (cArm?.twist ?? 0) * cw;
      this._twist[side].step(twistTarget, dt, ARM_FOLLOW);

      // Palm direction blends and follows like the limb directions do.
      const pt = this._palmTarget.copy(BASE_PALM);
      if (pArm?.palm) pt.lerp(pArm.palm, this.prevBlend).normalize();
      if (cArm?.palm) pt.lerp(cArm.palm, cw).normalize();
      const ps = this._palm[side].step(pt, dt, ARM_FOLLOW);
      const po = this._palmOut[side];
      // Palm state follows the same canonical frame as the arm directions.
      po[0] = ps.x;
      po[1] = ps.y;
      po[2] = ps.z;
      const palmWorld = this.characterTupleToWorld(
        this._palmWorldOut[side],
        po,
        side,
        mirror,
        frameReady,
      );

      // BASE_PALM describes an arm hanging at the side, and only that. A pose
      // that raises the hand and states no palm of its own must not be held to
      // it — keeping a lifted hand rolled as though it were still by the hip
      // demands most of a half turn, which is where the wrist collapsed. Such a
      // pose releases the constraint as it blends in and the roll falls back to
      // whatever the aim itself produces.
      let hold = 1;
      if (pArm && !pArm.palm) hold -= this.prevBlend;
      if (cArm && !cArm.palm) hold -= cw;
      const palmW = Math.max(0, this._palmW[side].step(Math.max(0, hold), dt, ARM_FOLLOW));

      rig.aimArm(
        side,
        worldDirs,
        this._twist[side].value * this.axialMirror(side, frameReady),
        palmWorld,
        palmW,
      );

      const pf = gPrev?.fingers?.[side];
      const cf = g?.fingers?.[side];
      const pfSpread = gPrev?.fingerSpread?.[side];
      const cfSpread = g?.fingerSpread?.[side];
      const spec = this._fingerSpec[side];
      const spread = this._fingerSpreadSpec[side];
      const fw = plain(this._fingerEnv);
      for (const f of FINGER_NAMES) {
        let val = BASE_FINGERS[f];
        const pv = pf?.[f];
        const cv = cf?.[f];
        if (pv !== undefined) val += (pv - val) * this.prevBlend;
        if (cv !== undefined) val += (cv - val) * fw;
        spec[f] = this._fingerState[side][f].step(val, dt, FINGER_FOLLOW);

        let spreadVal = 0;
        const pvSpread = pfSpread?.[f];
        const cvSpread = cfSpread?.[f];
        if (pvSpread !== undefined) spreadVal += pvSpread * this.prevBlend;
        if (cvSpread !== undefined) spreadVal += (cvSpread - spreadVal) * fw;
        spread[f] = this._fingerSpreadState[side][f].step(spreadVal, dt, FINGER_FOLLOW);
      }
      rig.curlHand(side, spec, spread);
    }
  }
}
