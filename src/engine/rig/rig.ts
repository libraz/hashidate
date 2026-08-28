import * as THREE from 'three';
import { ArmAnatomy, fingerCurl, HAND_CONTACT, JOINTS, rollRoom } from '../anatomy';
import type {
  ArmSlot,
  EyeSlot,
  FingerName,
  FingerSpec,
  JointReading,
  JointTable,
  PointSpec,
  Profile,
  Side,
  SpineSlot,
  Vec3Tuple,
} from '../types';
import { solveFingerAxes } from './finger-axes';
import type { ArmSolution, ReachLinks } from './reach';
import { poleAngle, solveReach } from './reach';

/**
 * Bone layer.
 *
 * Poses are expressed as *world-space direction targets* for each limb rather
 * than local Euler angles. Rest orientations differ wildly between avatars, so
 * "point the forearm down and slightly forward" ports across rigs while
 * "rotate 72 degrees about local X" does not.
 *
 * Per frame the caller resets to the rest pose, stacks additive offsets for the
 * spine chain, then aims the arm chains parent-first.
 */

const _q = new THREE.Quaternion();
const _local = new THREE.Quaternion();
const _twistQ = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _e = new THREE.Euler();
const _gC = new THREE.Vector3();
const _gS = new THREE.Vector3();
const _gA = new THREE.Vector3();
const _gB = new THREE.Vector3();
const _gX = new THREE.Vector3();
// How far the clavicle may turn to get the arm room. The sternoclavicular joint
// gives roughly ten degrees of depression and twenty of retraction, and a swing
// away from a target in front of the face is a mix of the two.
const GIRDLE_ROM = 0.38;
const _palmCur = new THREE.Vector3();
const _palmWant = new THREE.Vector3();
const _palmAxis = new THREE.Vector3();
const _armS = new THREE.Vector3();
const _fixDir = new THREE.Vector3();
// Stands in for a bone that was never given a rest orientation, which cannot
// happen for a bone the profile resolved. Only ever read.
const _restFallback = new THREE.Quaternion();

/**
 * The palm constraint one aim is solved against: the palm normal in hand-bone
 * space, where it should end up in world space, and how hard to insist.
 */
interface PalmSpec {
  local: THREE.Vector3;
  target: THREE.Vector3;
  weight: number;
}

const _palmSpec: PalmSpec = {
  local: new THREE.Vector3(),
  target: new THREE.Vector3(),
  weight: 1,
};

/**
 * Joint limits are anatomy, and live in `anatomy/`.
 *
 * What used to be here was a cone: each link could deviate from the one above
 * it by so many radians, whatever direction it deviated in. That bounded the
 * damage without needing to know a rotation axis — which is real, axes differ
 * per rig — but it cannot tell flexion from extension, so it permitted 75
 * degrees of radial deviation at a wrist whose actual range is 20, and it had
 * no opinion at all about an elbow bending sideways.
 *
 * The replacement measures the pose against a body frame derived from the rig's
 * own geometry, so it stays skeleton-independent while knowing which way is
 * which. See `anatomy/` for the model and for why it carries two bands rather
 * than one bound.
 */

/**
 * How the roll that turns the palm to face somewhere is split up the arm.
 *
 * Three joints turn a palm over, and only one of them is below the elbow.
 * Rotating the humerus about its own axis carries the whole limb round; the
 * radius crossing the ulna adds pronation; the wrist itself contributes nothing
 * at all — it has no axial degree of freedom, and what a rig puts on the hand
 * bone is pronation rendered in the wrong place, because the skeleton has no
 * twist bone to put it on.
 *
 * Spending them in that order matters, and getting it wrong is what this used to
 * do. Charging the whole roll to forearm and wrist gave a hand reaching for the
 * mouth 150 degrees of pronation against a limit of 80 — nearly twice the range
 * a forearm has, while the shoulder above it sat unrotated with its own range
 * untouched. Skin weighted across a joint twisted that far collapses to zero
 * volume, so it does not merely look wrong: the wrist disappears.
 *
 * The shoulder is asked first, then the forearm, and the wrist takes only the
 * share of the forearm's pronation that has to be rendered above the joint for
 * the twist to reach the hand.
 *
 * PRONATION_SPLIT is a rendering choice, not an anatomical one: both parts are
 * the same rotation, and the measurement reports their sum as pronation. A real
 * forearm twists progressively along its length, so the lower bone taking the
 * larger share is what looks right.
 */
const PRONATION_SPLIT = 0.4; // of the total pronation, the share on the hand

/**
 * Below this the elbow is bent far enough that humeral rotation swings the
 * forearm instead of rolling it, and the shoulder has nothing useful to lend.
 *
 * This is the reason you turn a doorknob by supinating rather than by rotating
 * your shoulder: at a right angle the shoulder's rotation has become a sideways
 * sweep of the whole forearm and does not reach the palm at all.
 */
const ROLL_TRANSFER_MIN = 0.25;

const SPINE_CHAIN: readonly SpineSlot[] = ['hips', 'spine', 'chest', 'neck', 'head'];
const SIDES: readonly Side[] = ['L', 'R'];
const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];

/**
 * Elbow positions tried when solving a fingertip target.
 *
 * The elbow sits somewhere on a circle around the shoulder-to-wrist line, and
 * nothing about the fingertip says where. Sampling the circle and scoring each
 * position is what turns "put the fingertip here" into a pose an arm would
 * actually adopt — it is the whole of the back-solve, and the reason the anatomy
 * model needs a cost rather than a pass/fail limit.
 *
 * 24 samples puts them 15 degrees apart, which is finer than the cost surface
 * varies; the parabolic refinement afterwards costs one more evaluation and
 * removes the residual stepping.
 */
const SWIVEL_SAMPLES = 24;

/** How far the elbow moves toward its answer each frame. See `searchSwivel`. */
const SWIVEL_TRACK = 0.25;

/**
 * How close the elbow has to get before it is simply put there, in radians.
 *
 * Tracking a fraction of the remaining distance each frame approaches the
 * answer and never reaches it, so a pose merely being held keeps creeping for
 * as long as it is held. That did not show while the hysteresis below was in
 * force, because staying put was itself the winning answer and the distance to
 * close was zero; with the elbow predicted from the target instead, the
 * remainder is real and has to be given somewhere to stop.
 *
 * A tenth of a degree. Small enough that closing it in one frame cannot be
 * seen, and it buys the property that matters more: the same target now yields
 * exactly the same elbow, so a pose looks the same however it was arrived at.
 */
const SWIVEL_SETTLE = 0.002;

/**
 * The prior is not always available: it lands on the reach line, and says
 * nothing there, whenever the hand is roughly where a hanging elbow would be —
 * an arm at rest by the side is exactly that case. The elbow circle is a
 * pinhead there and the choice does not matter, so what is wanted is only that
 * it does not jump about; the continuity weight is enough on its own.
 */
const SWIVEL_INERTIA = 0.05;

/**
 * Where a person's elbow goes for a given hand position, and how hard the
 * search is held to it.
 *
 * The strain search above answers "which elbow is most comfortable", and that
 * is not the question. An arm's posture is very nearly a function of where the
 * hand is — put your hand somewhere twice and the elbow arrives in the same
 * place both times, whatever route it took — and comfort is not what picks it.
 * The two shallow minima most targets have really are close to equally
 * comfortable, so scoring comfort alone leaves the choice underdetermined, and
 * everything that used to sit here — a continuity weight, a hysteresis margin,
 * a preference for staying put — existed to break a tie that comfort was never
 * going to break. Those are memory, and memory is exactly what an arm posture
 * does not have: they are also why a held pose could sit at one elbow and the
 * same pose reached from the other side sit at the other.
 *
 * So the search gets a prior instead: a predicted elbow position, from the hand
 * position alone, added to the cost as a penalty for departing from it. It
 * decides which of the two minima is in play; strain still does the fine work
 * within it, so every number the anatomy model was tuned to still applies.
 *
 * Being a function of the target and nothing else, the prior cannot flip-flop:
 * a target that is being held still predicts the same elbow every frame.
 *
 * The pole is stated in body spans from the shoulder, in the anatomy frame,
 * with the lateral axis pointing away from the midline on either side. It rides
 * three facts:
 *
 *  - the elbow hangs *below* the shoulder, and rises with the hand at roughly
 *    half the hand's own rate — the elevation regression
 *  - it swings outward as the hand rises, and further outward as the hand
 *    crosses toward the midline. Bringing a hand to the far cheek with the
 *    elbow tucked against the ribs is not a pose an arm can hold
 *  - it sits slightly behind the shoulder at rest and comes forward as the hand
 *    reaches forward, but much less far
 *
 * Only a prior, so these are the shape of the answer rather than the answer.
 */
const ELBOW_PRIOR = 2.0;
const ELBOW_POLE_OUT = 0.3;
const ELBOW_POLE_OUT_RISE = 0.34;
const ELBOW_POLE_OUT_CROSS = 0.24;
const ELBOW_POLE_UP = -0.92;
const ELBOW_POLE_UP_RISE = 0.55;
const ELBOW_POLE_FWD = -0.08;
const ELBOW_POLE_FWD_REACH = 0.3;

/** Spine-chain slots plus the eyes, which take the same additive treatment. */
export type OffsetSlot = SpineSlot | EyeSlot;

/** Radians about each axis, accumulated over a frame. */
interface Offset {
  x: number;
  y: number;
  z: number;
}

/**
 * The directions the anatomical clamp bounds.
 *
 * No shoulder: the girdle is posed from the pose's own request, and `girdleRoom`
 * is the only thing that moves it.
 */
type LimitedDirs = Partial<Record<ArmSlot, THREE.Vector3>> & {
  upperArm: THREE.Vector3;
  lowerArm: THREE.Vector3;
  hand: THREE.Vector3;
};

/**
 * A fingertip request as the solver receives it.
 *
 * `PointSpec` states its directions as character-space tuples, which is how a
 * gesture authors them; the motion layer projects them into world-space
 * scratch vectors first, so both forms arrive here in the solver's frame.
 */
export interface PointRequest extends Omit<PointSpec, 'point' | 'palm'> {
  point?: Vec3Tuple | THREE.Vector3 | null;
  palm?: Vec3Tuple | THREE.Vector3 | null;
}

export class Rig {
  readonly p: Profile;
  /** bone -> rest quaternion */
  readonly rest = new Map<THREE.Bone, THREE.Quaternion>();
  /** slot -> additive Euler offset for this frame */
  readonly offset = new Map<OffsetSlot, Offset>();

  /** Curl axis per finger bone, in that bone's own space. */
  readonly fingerAxis: Map<THREE.Bone, THREE.Vector3>;
  /** Palm normal in hand-bone space. */
  readonly palmLocal: Partial<Record<Side, THREE.Vector3>>;
  /** Total pronation, both bones. */
  readonly foreRoll: Record<Side, number> = { L: 0, R: 0 };
  /** Axial twist given to the humerus. */
  readonly upperRoll: Record<Side, number> = { L: 0, R: 0 };

  readonly anat: ArmAnatomy;
  readonly joints: JointTable;

  /**
   * Off switch for the anatomical limiting, so a pose can be compared against
   * what the raw geometry produces. Worth keeping: when a gesture looks
   * wrong, the first question is whether the limiter caused it or revealed
   * it, and that is one toggle rather than an afternoon.
   */
  limitsEnabled = true;

  // Two buffers alternated down an arm chain. `aim` reads the parent's world
  // rotation and writes the child's, so the two cannot be the same object —
  // and allocating a fresh quaternion per bone per frame is the kind of
  // steady garbage that surfaces as a dropped frame hours into a stream.
  private readonly _chainQ = [new THREE.Quaternion(), new THREE.Quaternion()];

  // Arm state below the shoulder, held aside rather than threaded through
  // `_chainQ`. Those two buffers alternate down a chain, which is enough when
  // each link is posed once; the roll budget poses the forearm and hand more
  // than once — a trial twist on the humerus has to be paid for and measured
  // — and by then the alternating buffers have been overwritten.
  private readonly _upperParentQ = new THREE.Quaternion();
  private readonly _upperQ = new THREE.Quaternion();
  private readonly _foreQ = new THREE.Quaternion();
  private readonly _handQ = new THREE.Quaternion();
  private readonly _aim: Record<ArmSlot, THREE.Vector3> = {
    shoulder: new THREE.Vector3(),
    upperArm: new THREE.Vector3(),
    lowerArm: new THREE.Vector3(),
    hand: new THREE.Vector3(),
  };
  /** Roll the last palm solve asked for. */
  private _roll = 0;

  // Scratch for the anatomical clamp, which needs all three arm directions at
  // once — the chain walk in `aimArm` only ever holds one.
  private readonly _limited: Record<Side, LimitedDirs>;
  private readonly _palmWorld: Record<Side, THREE.Vector3> = {
    L: new THREE.Vector3(),
    R: new THREE.Vector3(),
  };

  // Where each elbow sat last frame, so the fingertip search has somewhere to
  // prefer. Seeded slightly outward, which is where a hanging elbow is.
  private readonly _swivel: Record<Side, number> = { L: 0, R: 0 };

  // Scratch for the elbow prior. Held apart from `_pt`, which is live across
  // the whole of a fingertip solve while the prior is being computed inside it.
  private readonly _priorPole = new THREE.Vector3();
  private readonly _priorDir = new THREE.Vector3();
  private readonly _pt = {
    dir: new THREE.Vector3(),
    tip: new THREE.Vector3(),
    wrist: new THREE.Vector3(),
    finger: new THREE.Vector3(),
    palm: new THREE.Vector3(),
    shoulder: new THREE.Vector3(),
    best: { upperArm: new THREE.Vector3(), lowerArm: new THREE.Vector3() } as ReachLinks,
    cand: { upperArm: new THREE.Vector3(), lowerArm: new THREE.Vector3() } as ReachLinks,
  };

  constructor(profile: Profile) {
    this.p = profile;

    const all = [...Object.values(profile.bones), ...Object.values(profile.fingerBones).flat()];
    for (const b of all) this.rest.set(b, b.quaternion.clone());

    const fingers = solveFingerAxes(profile);
    this.fingerAxis = fingers.axes;
    this.palmLocal = fingers.palmLocal;

    // Anatomy has to be built after the finger axes: it reads the same rest
    // geometry to work out which side of the hand the thumb is on.
    this.anat = new ArmAnatomy(profile);
    this.joints = profile.anatomy ?? JOINTS;

    const trio = (): LimitedDirs => ({
      upperArm: new THREE.Vector3(),
      lowerArm: new THREE.Vector3(),
      hand: new THREE.Vector3(),
    });
    this._limited = { L: trio(), R: trio() };
  }

  /**
   * The rest orientation captured at construction. Every bone that reaches
   * here came out of the profile, so the map always has it.
   */
  private restOf(bone: THREE.Bone): THREE.Quaternion {
    return this.rest.get(bone) ?? _restFallback;
  }

  /** Start a frame: every controlled bone back to its rest orientation. */
  reset(): void {
    for (const [bone, q] of this.rest) bone.quaternion.copy(q);
    this.offset.clear();
  }

  /** Accumulate a small additive rotation on a spine-chain slot (radians). */
  addOffset(slot: OffsetSlot, x: number, y: number, z: number): void {
    const o = this.offset.get(slot) ?? { x: 0, y: 0, z: 0 };
    o.x += x;
    o.y += y;
    o.z += z;
    this.offset.set(slot, o);
  }

  /** Bake accumulated spine offsets into local quaternions. */
  commitSpine(): void {
    for (const slot of SPINE_CHAIN) {
      const bone = this.p.bones[slot];
      const o = this.offset.get(slot);
      if (!(bone && o)) continue;
      _e.set(o.x, o.y, o.z, 'XYZ');
      bone.quaternion.copy(this.restOf(bone)).multiply(_q.setFromEuler(_e));
    }
    for (const side of SIDES) {
      const bone = this.p.bones[`eye.${side}`];
      const o = this.offset.get(`eye.${side}`);
      if (!(bone && o)) continue;
      _e.set(o.x, o.y, o.z, 'XYZ');
      bone.quaternion.copy(this.restOf(bone)).multiply(_q.setFromEuler(_e));
    }
  }

  /**
   * Aim one bone so its child direction points along `targetWorld`.
   * Writes this bone's world rotation into `out` and returns it, so the next
   * bone down can use it as its parent rotation.
   */
  private aim(
    bone: THREE.Bone,
    restDir: THREE.Vector3,
    parentWorldQ: THREE.Quaternion,
    targetWorld: THREE.Vector3,
    twist: number,
    out: THREE.Quaternion,
    palm: PalmSpec | null = null,
  ): THREE.Quaternion {
    const curWorld = _q.copy(parentWorldQ).multiply(this.restOf(bone));
    const curDir = _v.copy(restDir).applyQuaternion(curWorld).normalize();
    out.setFromUnitVectors(curDir, targetWorld).multiply(curWorld);

    // Aiming a bone leaves the roll about its own axis undetermined: pointing
    // the fingers somewhere says nothing about which way the palm faces, and
    // `setFromUnitVectors` picks the shortest rotation, so the roll comes out
    // as a side effect of the rest pose rather than as anything anyone chose.
    // Where a palm target is given, solve the roll that satisfies it.
    this._roll = 0;
    if (palm) {
      const cur = _palmCur.copy(palm.local).applyQuaternion(out);
      const want = _palmWant.copy(palm.target);
      // Both projected onto the plane normal to the aim axis; the signed angle
      // between them in that plane is the roll needed.
      cur.addScaledVector(targetWorld, -cur.dot(targetWorld));
      want.addScaledVector(targetWorld, -want.dot(targetWorld));
      if (cur.lengthSq() > 1e-8 && want.lengthSq() > 1e-8) {
        cur.normalize();
        want.normalize();
        const cos = THREE.MathUtils.clamp(cur.dot(want), -1, 1);
        const sin = _palmAxis.crossVectors(cur, want).dot(targetWorld);
        // Weighted, so a pose that states no palm can give the constraint up
        // instead of inheriting one: at weight 0 this is the plain minimal
        // rotation, which is a fine default for a hand that nobody has an
        // opinion about.
        //
        // Reported, not applied. Which joints pay for the roll is a question
        // about the whole arm — the shoulder above the elbow has more of the
        // range than everything below it — and this method holds one bone.
        this._roll = Math.atan2(sin, cos) * palm.weight;
      }
    }

    _local.copy(parentWorldQ).invert().multiply(out);
    if (twist) {
      _local.multiply(_twistQ.setFromAxisAngle(restDir, twist));
      // Keep `out` consistent with what the bone actually ends up at, in case
      // anything downstream threads from it.
      out.copy(parentWorldQ).multiply(_local);
    }
    bone.quaternion.copy(_local);
    return out;
  }

  /**
   * Swing the shoulder girdle away from a reach, in place, before the arm is
   * solved from it.
   *
   * A hand cannot be brought to the face by the arm alone. The elbow's flexion
   * fixes a nearest reachable point — fold it as far as it goes and the wrist
   * is still a fixed distance from the shoulder — so on a narrow-shouldered,
   * short-necked figure the face can sit inside that radius and no choice of
   * elbow, pole or wrist reaches it. Measured on the validation avatar the
   * shoulder is 0.09 to 0.14 from the face anchors against an arm of 0.33; the
   * same ratio on a person is around a half to two thirds.
   *
   * What a person does about it is drop and draw back the shoulder, and that is
   * what this does: the clavicle turns away from the target until the wrist can
   * sit where the elbow's *comfortable* range wants it, bounded by the girdle's
   * own travel. It buys a couple of centimetres, which is the difference
   * between a forearm folded flat and one that reads as resting.
   *
   * `dir` is the clavicle's aim, rewritten in place — the body layer's own
   * tuple, deliberately, so the shoulder the arm is solved from is the shoulder
   * that gets posed. The current angle is taken from `dir` rather than from
   * where the bone actually points, so the result is a function of the request
   * alone — read back from the posed bone it would measure its own correction,
   * find nothing left to do, and let the shoulder spring back on the next frame.
   */
  girdleRoom(side: Side, targetWorld: THREE.Vector3, dir: Vec3Tuple, weight = 1): void {
    const { bones, limb } = this.p;
    const clav = bones[`shoulder.${side}`];
    const upper = bones[`upperArm.${side}`];
    const La = limb?.[`upper.${side}`];
    const Lf = limb?.[`lower.${side}`];
    if (!(clav && upper && La && Lf) || weight <= 0) return;

    clav.updateWorldMatrix(true, false);
    upper.updateWorldMatrix(true, false);
    const C = clav.getWorldPosition(_gC);
    // Turning the clavicle cannot change this, so the posed bones give the rest
    // length as readily as the rest pose would.
    const r = C.distanceTo(upper.getWorldPosition(_gS));
    if (r < 1e-4) return;

    const a = _gA.set(dir[0], dir[1], dir[2]);
    if (a.lengthSq() < 1e-8) return;
    a.normalize();
    const b = _gB.copy(targetWorld).sub(C);
    const L = b.length();
    if (L < 1e-4) return;
    b.multiplyScalar(1 / L);

    // Where the wrist has to sit for the elbow to stay inside its free range.
    const flexFree = this.joints?.elbow?.dofs?.flexion?.free?.[1] ?? Math.PI;
    const want = Math.sqrt(La * La + Lf * Lf - 2 * La * Lf * Math.cos(Math.PI - flexFree));
    // Law of cosines on the triangle root-shoulder-target: the shoulder sits on
    // a sphere of radius r about the clavicle root, and this is the cosine that
    // puts it `want` from the target.
    const K = (r * r + L * L - want * want) / (2 * r * L);
    const cos0 = THREE.MathUtils.clamp(a.dot(b), -1, 1);
    if (!(K < cos0)) return;

    const need = Math.acos(THREE.MathUtils.clamp(K, -1, 1)) - Math.acos(cos0);
    const turn = Math.min(need, GIRDLE_ROM) * weight;
    if (turn < 1e-4) return;
    // b cross a, not a cross b: rotating about the latter carries the shoulder
    // *toward* the target, which is the wrong way round and reads as a hunch.
    const axis = _gX.crossVectors(b, a);
    if (axis.lengthSq() < 1e-8) return;
    a.applyAxisAngle(axis.normalize(), turn);
    dir[0] = a.x;
    dir[1] = a.y;
    dir[2] = a.z;
  }

  /**
   * Pose the shoulder alone.
   *
   * Split out of `aimArm` because a reach has to be solved from where the upper
   * arm will be, and that is not where it rests: the clavicle carries it a
   * noticeable distance. The caller poses the shoulder, solves, then poses the
   * rest of the chain — `aimArm` re-aims the shoulder to the same direction on
   * its way past, which costs one quaternion and keeps the chain in one place.
   */
  aimShoulder(side: Side, dir: Vec3Tuple | THREE.Vector3 | null): void {
    const { bones, restDir } = this.p;
    const bone = bones[`shoulder.${side}`];
    const chest = bones.chest ?? bones.spine ?? bones.hips;
    if (!(bone && chest && dir)) return;
    this.aim(
      bone,
      restDir[`shoulder.${side}`],
      chest.getWorldQuaternion(this._chainQ[0]),
      _vTarget(dir),
      0,
      this._chainQ[1],
    );
  }

  /**
   * Pose one arm. `dirs` holds world-space unit directions keyed by chain slot;
   * omitted slots keep their rest orientation relative to the parent.
   */
  aimArm(
    side: Side,
    dirs: Record<ArmSlot, Vec3Tuple>,
    twist = 0,
    palmTarget: Vec3Tuple | null = null,
    palmWeight = 1,
  ): void {
    const { bones, restDir } = this.p;
    const palmLocal = this.palmLocal[side];
    let palm: PalmSpec | null = null;
    if (palmTarget && palmWeight > 1e-3 && palmLocal) {
      _palmSpec.local = palmLocal;
      _palmSpec.target.set(palmTarget[0], palmTarget[1], palmTarget[2]).normalize();
      _palmSpec.weight = palmWeight;
      palm = _palmSpec;
    }
    const chest = bones.chest ?? bones.spine ?? bones.hips;
    if (!chest) return;

    // Bound the whole arm before any of it is posed, so a limit is never
    // something a pose can argue its way past. Done up front rather than link
    // by link because the anatomical measurement is not local to a joint: how
    // far the shoulder may lift depends on which plane it lifted in, and
    // whether a wrist is bent or deviated depends on which way the palm faces.
    // The chain walk below only ever holds one link at a time.
    const lim = this.limit(side, dirs, palm);

    // The bounded directions, each in its own vector. `_vTarget` hands back one
    // shared scratch, which was enough while the chain was walked a link at a
    // time; the roll budget needs all three at once to know how much of a
    // shoulder rotation would reach the palm.
    const dir = (slot: ArmSlot): THREE.Vector3 | null => {
      const raw = lim?.[slot] ?? dirs[slot];
      if (!raw) return null;
      const into = this._aim[slot];
      return Array.isArray(raw)
        ? into.set(raw[0], raw[1], raw[2]).normalize()
        : into.copy(raw).normalize();
    };
    const sD = dir('shoulder');
    const uD = dir('upperArm');
    const lD = dir('lowerArm');
    const hD = dir('hand');

    const clav = bones[`shoulder.${side}`];
    const upper = bones[`upperArm.${side}`];
    const fore = bones[`lowerArm.${side}`];
    const hand = bones[`hand.${side}`];
    const foreDir = restDir[`lowerArm.${side}`];
    const handDir = restDir[`hand.${side}`];

    // --- down as far as the upper arm ---------------------------------------
    let q = chest.getWorldQuaternion(this._chainQ[0]);
    if (clav) {
      q = sD
        ? this.aim(clav, restDir[`shoulder.${side}`], q, sD, 0, this._chainQ[1])
        : this._chainQ[1].copy(q).multiply(this.restOf(clav));
    }
    this._upperParentQ.copy(q);
    if (upper) {
      if (uD) this.aim(upper, restDir[`upperArm.${side}`], this._upperParentQ, uD, 0, this._upperQ);
      else this._upperQ.copy(q).multiply(this.restOf(upper));
    } else this._upperQ.copy(q);

    /**
     * Pose the forearm and hand from wherever the upper arm now sits, spending
     * `carry` on forearm pronation and `hw` on the hand. Returns the roll the
     * palm still wants, which does not depend on `hw` — it is measured against
     * the untwisted aim — so the same call both prices a trial and pays for it.
     */
    const below = (carry: number, hw: number): number => {
      let p = this._upperQ;
      if (fore) {
        if (lD) this.aim(fore, foreDir, this._upperQ, lD, 0, this._foreQ);
        else this._foreQ.copy(this._upperQ).multiply(this.restOf(fore));
        if (carry) {
          fore.quaternion.multiply(_twistQ.setFromAxisAngle(foreDir, carry));
          this._foreQ.copy(this._upperQ).multiply(fore.quaternion);
        }
        p = this._foreQ;
      }
      if (!hand) return 0;
      if (!hD) {
        hand.quaternion.copy(this.restOf(hand));
        this._handQ.copy(p).multiply(hand.quaternion);
        return 0;
      }
      this.aim(hand, handDir, p, hD, hw, this._handQ, palm);
      return this._roll;
    };

    // --- who pays for the roll ----------------------------------------------
    const pron = this.joints.elbow.dofs.rotation;
    let R = below(0, 0);
    let humeral = 0;

    if (palm && upper && uD && lD && Math.abs(R) > 1e-3) {
      const spare = R - THREE.MathUtils.clamp(R, pron.max[0], pron.max[1]);
      // How much of a humeral rotation arrives at the palm.
      //
      // Twisting a bone and then re-aiming the one below it to the direction it
      // was already pointing passes on the twist scaled by the cosine of the
      // angle between them — all of it in line, none at a right angle, and
      // negated past that. The palm is two joints down, so it happens twice.
      //
      // Both terms are needed. Stopping at the elbow overstates what reaches a
      // bent wrist, and it was the missing wrist term that had the shoulder
      // declining to help on the reaches that needed it most.
      const transfer = uD.dot(lD) * (hD ? lD.dot(hD) : 1);
      if (spare && Math.abs(transfer) > ROLL_TRANSFER_MIN) {
        // Measured, not assumed: the shoulder may already be rotated by where
        // the elbow points, and that spends the same range. A hand with no
        // direction of its own follows the forearm, which is a straight wrist
        // and the same substitution the elbow search makes.
        this.anat.measure(side, uD, lD, hD ?? lD, null);
        const room = rollRoom(this.anat.m.rotation, this.joints.shoulder.dofs.rotation);
        humeral = THREE.MathUtils.clamp(spare / transfer, room[0], room[1]);
      }
    }

    if (humeral && upper) {
      upper.quaternion.multiply(_twistQ.setFromAxisAngle(restDir[`upperArm.${side}`], humeral));
      this._upperQ.copy(this._upperParentQ).multiply(upper.quaternion);
      const after = below(0, 0);
      // The transfer estimate is a cosine, and near the gate it is a rough one.
      // A donation that left the palm further from where it was asked to face is
      // not a donation; undo it rather than ship an arm rotated for nothing.
      if (Math.abs(after) >= Math.abs(R)) {
        upper.quaternion.multiply(_twistQ.setFromAxisAngle(restDir[`upperArm.${side}`], -humeral));
        this._upperQ.copy(this._upperParentQ).multiply(upper.quaternion);
        humeral = 0;
        below(0, 0);
      } else R = after;
    }

    const total = THREE.MathUtils.clamp(R, pron.max[0], pron.max[1]);
    const carry = total * (1 - PRONATION_SPLIT);
    const hw = palm ? total * PRONATION_SPLIT : twist;
    below(carry, hw);

    // Pronation is recorded here rather than measured later: it is a roll about
    // the forearm's own axis, and a roll about an axis leaves no trace in the
    // segment directions the rest of the model reads. Both bones' shares are
    // recorded as one number, because anatomically they are one rotation.
    this.foreRoll[side] = total;
    this.upperRoll[side] = humeral;

    // --- the wrist, against the palm the arm actually reached ---------------
    //
    // The clamp up top could only bound the wrist against the palm the pose
    // asked for. Where the roll budget could not deliver all of it, the palm
    // ends up somewhere else, and the split of the bend into flexion and
    // deviation turns with it. One correction pass: clamping again moves the
    // palm again, and the second-order term is not worth a third aim per arm
    // per frame.
    if (this.limitsEnabled && palm && hD && lD && hand && palmLocal) {
      const got = this._palmWorld[side].copy(palmLocal).applyQuaternion(this._handQ).normalize();
      _fixDir.copy(hD);
      this.anat.clampWrist(side, lD, hD, got);
      // Bounding the wrist can put the hand back into the face the clamp just
      // lifted it off — this runs after `clamp`, so it has the last word on
      // where the hand points, and it knows nothing about the body. Lift it out
      // again. Only the hand turns, about the wrist, so the arm above it stays
      // exactly as posed.
      if (uD) this.anat.clearHand(side, uD, lD, hD);
      if (hD.distanceToSquared(_fixDir) > 1e-8) below(carry, hw);
    }
  }

  /**
   * The palm normal to measure a wrist against, in world space.
   *
   * The palm *target* the pose asked for, or null where it asked for nothing.
   *
   * Null is the meaningful case, not a fallback. The wrist has to be bounded
   * before the arm is aimed, and the roll that decides where the palm ends up
   * is solved during the aim — so the only palm knowable here is the one the
   * pose stated. Where it stated none, the palm is genuinely free, and
   * `anatomy/` scores the wrist accordingly. Substituting last frame's actual
   * palm looks more informed and is worse: it feeds the previous clamp back
   * into the next one.
   */
  private palmWorld(side: Side, palm: PalmSpec | null): THREE.Vector3 | null {
    if (!palm) return null;
    return this._palmWorld[side].copy(palm.target).normalize();
  }

  /**
   * Give the anatomy model this arm's origin and segment lengths, so it can
   * place the arm instead of only pointing it. Needed for the torso clearance,
   * which is a question about positions — and about the whole arm, not just the
   * elbow: reaching across the body puts both ends of the arm outside the trunk
   * and the middle of it inside.
   */
  private armContext(side: Side): boolean {
    const upper = this.p.bones[`upperArm.${side}`];
    const La = this.p.limb?.[`upper.${side}`];
    if (!(upper && La)) {
      this.anat.clearArm();
      return false;
    }
    upper.updateWorldMatrix(true, false);
    // The hand's collision proxy runs from the wrist to where the hand *touches*
    // — half its length, the middle of the palm — and stops there.
    //
    // It has to stop there, and the number has to be the same one the motion
    // layer backs the wrist off by. A reach places the palm on its anchor, and
    // the anchor is a point on the skin; test any further down the hand and the
    // samples past the contact point are inside the body *by construction*.
    // Testing 60% against a 50% back-off did exactly that, and left the poses
    // that touch the face reading 24 to 43 percent buried with the arm itself
    // completely clear.
    this.anat.setArm(
      upper.getWorldPosition(_armS),
      La,
      this.p.limb?.[`lower.${side}`] ?? 0,
      (this.p.limb?.[`tip.${side}.middle`] ?? 0) * HAND_CONTACT,
    );
    return true;
  }

  /**
   * Pull one arm's directions inside its anatomical stops.
   *
   * Returns rig-owned vectors rather than editing `dirs` in place: `dirs` is
   * the body layer's smoothed state, and folding a limit back into it would
   * make the limit accumulate — an arm held against a stop would keep being
   * pushed further into it, one frame's clamp at a time.
   */
  private limit(
    side: Side,
    dirs: Record<ArmSlot, Vec3Tuple>,
    palm: PalmSpec | null,
  ): LimitedDirs | null {
    if (!(this.limitsEnabled && this.anat.update())) return null;
    const u = dirs.upperArm;
    const l = dirs.lowerArm;
    const h = dirs.hand;
    if (!(u && l && h)) return null;
    this.armContext(side);
    const out = this._limited[side];
    out.upperArm.copy(_vTarget(u));
    out.lowerArm.copy(_vTarget(l));
    out.hand.copy(_vTarget(h));
    this.anat.clamp(side, out.upperArm, out.lowerArm, out.hand, this.palmWorld(side, palm));
    return out;
  }

  /**
   * Measure one arm as it currently stands, for the panel.
   *
   * Reads the posed bones rather than the requested directions on purpose: what
   * is worth showing is the pose that survived the clamp, not the one that was
   * asked for. Allocates, so it is a readout and not a frame-loop call.
   */
  measure(side: Side): JointReading[] | null {
    const { bones, restDir } = this.p;
    const u = bones[`upperArm.${side}`];
    const l = bones[`lowerArm.${side}`];
    const h = bones[`hand.${side}`];
    if (!(u && l && h && this.anat.update())) return null;
    this.armContext(side);
    const dir = (bone: THREE.Bone, slot: string) =>
      new THREE.Vector3()
        .copy(restDir[slot])
        .applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()))
        .normalize();
    const palmLocal = this.palmLocal[side];
    const palm = palmLocal
      ? new THREE.Vector3()
          .copy(palmLocal)
          .applyQuaternion(h.getWorldQuaternion(new THREE.Quaternion()))
          .normalize()
      : this.anat.up.clone().negate();
    this.anat.measure(
      side,
      dir(u, `upperArm.${side}`),
      dir(l, `lowerArm.${side}`),
      dir(h, `hand.${side}`),
      palm,
      this.foreRoll[side],
      this.upperRoll[side],
    );
    return this.anat.report();
  }

  /**
   * Find where the elbow belongs on its circle, and solve there.
   *
   * Once a wrist position is fixed the elbow can still sit anywhere on a circle
   * around the shoulder-to-wrist line, and geometry has no opinion about where.
   * This is the part that turns a position into a pose: every position on that
   * circle is sampled and scored, and the cheapest wins. The score is the
   * anatomy model's strain, plus a penalty for departing from where a person
   * would have put it — see `ELBOW_PRIOR` for why strain alone cannot decide.
   *
   * `handDir` is the direction the hand will point, needed to score the wrist;
   * pass null and the wrist is left out of the scoring, which is the right
   * thing when the hand's direction is not decided until the elbow is.
   * `palmN` likewise: null means the palm is free to roll.
   *
   * Returns the winning cost, or null if the target cannot be solved at all.
   */
  private searchSwivel(
    side: Side,
    wristTarget: THREE.Vector3,
    handDir: THREE.Vector3 | null,
    palmN: THREE.Vector3 | null,
    out: ReachLinks,
  ): number | null {
    const cand = this._pt.cand;
    this.armContext(side);
    // Computed before the sweep, not inside it: the prior is a function of the
    // target, and the target does not change while the circle is being sampled.
    const prior = this.predictElbowAngle(side, wristTarget);
    const score = (angle: number): number => {
      if (!this.solveReach(side, wristTarget, angle, cand)) return Number.POSITIVE_INFINITY;
      this.anat.measure(side, cand.upperArm, cand.lowerArm, handDir ?? cand.lowerArm, palmN, 0);
      if (prior !== null) {
        // Cosine rather than a squared difference so the penalty wraps with the
        // circle: the angle is periodic, and a difference of just under a turn
        // is a small move and must not be charged as a large one.
        return this.anat.cost() + ELBOW_PRIOR * (1 - Math.cos(angle - prior));
      }
      // Continuity, so a target drifting between two equally comfortable elbow
      // positions does not flip between them.
      const d = angle - this._swivel[side];
      return this.anat.cost() + SWIVEL_INERTIA * (1 - Math.cos(d));
    };

    const step = (Math.PI * 2) / SWIVEL_SAMPLES;
    // Parabolic refinement through a winner and its neighbours. One extra
    // evaluation each side, and it removes the 15-degree stepping that is
    // otherwise visible as the elbow ratcheting when a target sweeps across.
    const refine = (a0: number, c0: number): number => {
      const cl = score(a0 - step);
      const cr = score(a0 + step);
      const denom = cl - 2 * c0 + cr;
      if (Number.isFinite(cl) && Number.isFinite(cr) && Math.abs(denom) > 1e-9) {
        const shift = (0.5 * (cl - cr)) / denom;
        if (Math.abs(shift) < 1) return a0 + shift * step;
      }
      return a0;
    };

    let bestA = this._swivel[side];
    let bestC = Number.POSITIVE_INFINITY;
    for (let i = 0; i < SWIVEL_SAMPLES; i++) {
      const a = -Math.PI + i * step;
      const c = score(a);
      if (c < bestC) {
        bestC = c;
        bestA = a;
      }
    }
    if (!Number.isFinite(bestC)) return null;
    bestA = refine(bestA, bestC);

    const prev = this._swivel[side];

    // Track toward the answer instead of jumping to it.
    //
    // Where the target is close to the shoulder the elbow circle is wide, and
    // the map from swivel angle to shoulder elevation gets steep — on the
    // hand-to-chin poses six degrees of swivel is fifty of elevation. The cost
    // surface there is not smooth enough for the parabolic step to land in the
    // same place twice, so the refinement alternated between two angles a few
    // degrees apart and the arm swung through a wide arc every frame while the
    // pose was merely being held.
    //
    // Damping costs a few frames of lag on a genuine move, which the direction
    // blend was going to smooth anyway.
    //
    // This smooths a value; it does not choose one. What is being tracked toward
    // is a function of the target alone, so the elbow still ends up in the same
    // place whatever route it took there — which is the property the prior
    // exists for, and the reason the stickiness that used to sit here is gone.
    let d = bestA - prev;
    d = Math.atan2(Math.sin(d), Math.cos(d)); // the short way round
    const settled = Math.abs(d) < SWIVEL_SETTLE ? bestA : prev + d * SWIVEL_TRACK;

    if (!this.solveReach(side, wristTarget, settled, out)) return null;
    this._swivel[side] = settled;
    return bestC;
  }

  /**
   * Where the elbow belongs for a wrist at `wristTarget`, as an angle on the
   * elbow circle. Null on a rig whose body frame or arm the profile could not
   * resolve, and where the predicted pole lands on the reach line and therefore
   * says nothing — see `poleAngle`.
   *
   * Predicted as a *point* and converted, rather than as an angle directly. The
   * angle is measured about the shoulder-to-wrist line, and that line swings
   * through most of a right angle between a hand at the hip and a hand at the
   * mouth, so a formula written in angles would be describing a different elbow
   * at every target. A point beside the ribs is the same place whatever the
   * hand is doing, which is the whole reason the gesture table states poles.
   *
   * See `ELBOW_PRIOR` for what the coefficients mean.
   */
  private predictElbowAngle(side: Side, wristTarget: THREE.Vector3): number | null {
    const span = this.p.body?.span;
    const upper = this.p.bones?.[`upperArm.${side}`];
    const anat = this.anat;
    if (!(span && upper && anat.update())) return null;

    upper.updateWorldMatrix(true, false);
    const S = upper.getWorldPosition(this._priorPole);
    const u = this._priorDir.copy(wristTarget).sub(S);
    if (u.lengthSq() < 1e-10) return null;
    u.normalize();

    // The hand's bearing from the shoulder, resolved in the body's own frame so
    // it survives the character leaning or turning. `s` mirrors the lateral
    // axis, so "outward" means away from the midline on either arm and one set
    // of coefficients serves both.
    const s = side === 'R' ? 1 : -1;
    const outward = u.dot(anat.right) * s;
    const up = u.dot(anat.up);
    const fwd = u.dot(anat.fwd);

    const po =
      ELBOW_POLE_OUT +
      ELBOW_POLE_OUT_RISE * Math.max(0, up) +
      ELBOW_POLE_OUT_CROSS * Math.max(0, -outward);
    const pu = ELBOW_POLE_UP + ELBOW_POLE_UP_RISE * up;
    const pf = ELBOW_POLE_FWD + ELBOW_POLE_FWD_REACH * Math.max(0, fwd);

    // `S` is `_priorPole`, which becomes the pole itself from here.
    this._priorPole
      .addScaledVector(anat.right, po * s * span)
      .addScaledVector(anat.up, pu * span)
      .addScaledVector(anat.fwd, pf * span);

    return poleAngle(this.p, anat, side, wristTarget, this._priorPole);
  }

  /**
   * Reach a wrist to a world position, choosing the elbow rather than being
   * told it.
   *
   * The authored alternative is `solveReach` with an explicit angle, and it is
   * the wrong default: the angle is measured from the body's forward direction
   * about a line whose bearing changes with every target, so one constant means
   * a different elbow for every gesture that uses it. Every face-touching pose
   * in the table carried the same -0.3, which put the elbow in front of the
   * chest for a hand going to the crown and folded the arm across the face.
   */
  solveReachNatural(
    side: Side,
    targetWorld: THREE.Vector3,
    handDir: THREE.Vector3 | null,
    out: ArmSolution,
  ): ArmSolution | null {
    return this.searchSwivel(side, targetWorld, handDir, null, out) !== null ? out : null;
  }

  /**
   * Back-solve an arm from a fingertip.
   *
   * The request is angular: a bearing from the shoulder in the body's own
   * frame, plus how far out along it. That is the coordinate a pointing gesture
   * is actually specified in — "up and to the right, most of the way out" — and
   * unlike a world position it survives the character turning, leaning or being
   * a different size.
   *
   *   azimuth    radians, 0 straight ahead, positive toward the character's right
   *   elevation  radians, 0 at shoulder height, positive up
   *   extent     0..1 of the arm's full reach, fingertip included
   *   finger     which fingertip the coordinate refers to
   *   point      optional world direction the finger should point along
   *   palm       optional world direction the palm should face
   *
   * Two things are solved here that a plain reach does not have to. The target
   * is a fingertip and the solver's chain ends at the wrist, so the hand's own
   * length has to be taken out of the target first — a third of a forearm, and
   * ignoring it puts the hand through whatever is being pointed at. And the
   * elbow is not given: it is searched for, against the anatomy model's strain
   * and against where a person would have put it. Without that search a
   * fingertip target has a whole circle of correct answers and no reason to
   * prefer the one an arm would use.
   */
  solvePoint(side: Side, spec: PointRequest, out: ArmSolution): ArmSolution | null {
    const { bones, limb } = this.p;
    const upper = bones[`upperArm.${side}`];
    const La = limb?.[`upper.${side}`];
    const Lf = limb?.[`lower.${side}`];
    if (!(upper && La && Lf && this.anat.update())) return null;

    const s = this._pt;
    const anat = this.anat;
    const finger = spec.finger ?? 'index';
    const Lt = limb[`tip.${side}.${finger}`] ?? limb[`tip.${side}.index`] ?? 0;

    upper.updateWorldMatrix(true, false);
    const S = upper.getWorldPosition(s.shoulder);

    // Bearing, in the body frame. Built rather than projected, so it cannot be
    // degenerate at any azimuth or elevation.
    const az = spec.azimuth ?? 0;
    const el = spec.elevation ?? 0;
    const ce = Math.cos(el);
    s.dir
      .copy(anat.fwd)
      .multiplyScalar(ce * Math.cos(az))
      .addScaledVector(anat.right, ce * Math.sin(az))
      .addScaledVector(anat.up, Math.sin(el))
      .normalize();

    const reach = La + Lf + Lt;
    const extent = THREE.MathUtils.clamp(spec.extent ?? 0.8, 0.1, 1);
    s.tip.copy(S).addScaledVector(s.dir, reach * extent);

    // A finger points along the bearing unless told otherwise. That is what
    // pointing *is* — the line from the shoulder through the fingertip is the
    // line being indicated — and it also keeps the hand from having to bend to
    // an angle the wrist does not have.
    s.finger.copy(spec.point ? _vTarget(spec.point) : s.dir).normalize();
    s.wrist.copy(s.tip).addScaledVector(s.finger, -Lt);

    // Palm. An explicit one constrains the wrist; without one the palm is a
    // free roll about the pointing axis, and it is *derived* from the solve
    // below rather than assumed. Assuming it — "a hand points palm-down" — was
    // the first version, and it charged the wrist for deviation it would never
    // have had to make: a cross-body point came back with 47 degrees of wrist
    // flexion and 11 of deviation, both flagged, when the real answer is that
    // the forearm rolls over and the wrist barely bends.
    const wanted = spec.palm;
    const fixedPalm = !!wanted;
    if (wanted) {
      s.palm.copy(_vTarget(wanted));
      s.palm.addScaledVector(s.finger, -s.palm.dot(s.finger));
      if (s.palm.lengthSq() < 1e-8) s.palm.copy(anat.up).negate();
      s.palm.normalize();
    }

    const bestC = this.searchSwivel(side, s.wrist, s.finger, fixedPalm ? s.palm : null, out);
    if (bestC === null) return null;

    // Derive the palm from the pose that won: point it along the direction the
    // hand had to bend, which makes that bend flexion rather than deviation.
    // The roll needed to get there is pronation, and `aimArm` hands it to the
    // forearm — which is the joint that actually performs it.
    if (!fixedPalm) {
      s.palm.copy(s.finger).addScaledVector(out.lowerArm, -s.finger.dot(out.lowerArm));
      if (s.palm.lengthSq() < 1e-6) {
        // A straight wrist bends in no direction, so nothing is determined and
        // a hand pointing at something rests palm-down.
        s.palm.copy(anat.up).negate();
        s.palm.addScaledVector(s.finger, -s.palm.dot(s.finger));
        if (s.palm.lengthSq() < 1e-8) s.palm.copy(anat.fwd).negate();
      }
      s.palm.normalize();
    }

    out.hand.copy(s.finger);
    out.twist = 0;
    // Copied, never aliased: `_pt` is one scratch object shared by both arms
    // and by both gesture slots, so handing out a reference to it means the
    // next solve silently rewrites an answer the caller is still holding.
    out.palm.copy(s.palm);
    // Where the fingertip actually ended up, so a caller can tell a request
    // that was honoured from one the arm was too short for.
    out.tip.copy(s.tip);
    out.strain = bestC;
    return out;
  }

  /**
   * Solve a two-link reach so the wrist lands on `targetWorld`. See
   * `reach.ts`, which holds the geometry.
   */
  solveReach(
    side: Side,
    targetWorld: THREE.Vector3,
    elbowAngle: number,
    out: ReachLinks,
  ): ReachLinks | null {
    return solveReach(this.p, this.joints, this.anat, side, targetWorld, elbowAngle, out);
  }

  /**
   * Where on the elbow circle a pole *point* puts the elbow, in radians, or
   * null where the pole sits on the reach line and says nothing. See
   * `reach.ts`.
   */
  poleAngle(side: Side, targetWorld: THREE.Vector3, poleWorld: THREE.Vector3): number | null {
    return poleAngle(this.p, this.anat, side, targetWorld, poleWorld);
  }

  /**
   * Curl a finger. 0 = straight, 1 = the joint's natural full flexion.
   *
   * One number per finger is the right control — nobody flexes a single
   * interphalangeal joint on purpose — but the three segments do not share a
   * range, and the taper that used to spread one number across them was
   * guessed. It had the middle joint travelling 102 degrees and the knuckle 89,
   * which is roughly right, and the fingertip 93, which is 20 degrees more than
   * a fingertip has. Each joint now takes its own range from the joint table.
   *
   * Above 1 is the strained band: available, and nothing reaches it by
   * accident. Below 0 is hyperextension, which the knuckles have and the middle
   * joints do not — also from the table, rather than a blanket floor of zero.
   */
  curlFinger(name: FingerName, side: Side, amount: number): void {
    const chain = this.p.fingerBones[`${name}.${side}`];
    if (!chain) return;
    const joints = this.joints[name === 'thumb' ? 'thumb' : 'finger'];
    for (let i = 0; i < chain.length; i++) {
      const bone = chain[i];
      const axis = this.fingerAxis.get(bone);
      if (!axis) continue;
      bone.quaternion
        .copy(this.restOf(bone))
        .multiply(_q.setFromAxisAngle(axis, fingerCurl(joints, i, amount)));
    }
  }

  curlHand(side: Side, spec: FingerSpec): void {
    for (const f of FINGERS) {
      this.curlFinger(f, side, spec[f] ?? 0);
    }
  }
}

const _t = new THREE.Vector3();
/**
 * A world direction from either form a caller holds one in.
 *
 * Hands back one shared scratch vector, so the result is only valid until the
 * next call — anything needing two directions at once has to copy them out.
 */
function _vTarget(a: Vec3Tuple | THREE.Vector3): THREE.Vector3 {
  return Array.isArray(a) ? _t.set(a[0], a[1], a[2]).normalize() : _t.copy(a).normalize();
}
