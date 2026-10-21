/**
 * The arm chain's bone writes.
 *
 * Aims shoulder, upper arm, forearm and hand parent-first from world-space
 * direction targets, spends the roll that turns a palm over between the
 * humerus and the forearm, and holds the limiter's output to a speed a limb can
 * move at. It reads the rig's shared anatomy and roll tables rather than owning
 * them; a frame's clock and the limiter switch come from the rig through `port`.
 */

import * as THREE from 'three';
import { type ArmAnatomy, rollRoom, rotationTrust } from '../anatomy';
import type { ArmSlot, JointTable, Profile, Side, Vec3Tuple } from '../types';
import { PRONATION_SPLIT } from './arm-configuration';
import { LIMIT_SLEW } from './arm-driver';
import type { ArmTwists } from './arm-twists';
import type { Hands } from './hands';
import { worldDirection } from './point';

const _q = new THREE.Quaternion();
const _local = new THREE.Quaternion();
const _twistQ = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _slewAxis = new THREE.Vector3();
const _slewPerp = new THREE.Vector3();
const _palmCur = new THREE.Vector3();
const _palmWant = new THREE.Vector3();
const _palmAxis = new THREE.Vector3();
const _hingeFront = new THREE.Vector3();
const _hingeFold = new THREE.Vector3();
const _hingeAxis = new THREE.Vector3();
const _fixDir = new THREE.Vector3();
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
 * Below this the elbow is bent far enough that humeral rotation swings the
 * forearm instead of rolling it, and the shoulder has nothing useful to lend.
 *
 * This is the reason you turn a doorknob by supinating rather than by rotating
 * your shoulder: at a right angle the shoulder's rotation has become a sideways
 * sweep of the whole forearm and does not reach the palm at all.
 */
const ROLL_TRANSFER_MIN = 0.25;
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

/** The three the clamp bounds, in the order the slew walks them. */
const LIMITED_SLOTS = ['upperArm', 'lowerArm', 'hand'] as const;

/** What the arm chain needs from the rig that owns it, read at call time. */
interface ArmChainPort {
  dt(): number;
  limitsEnabled(): boolean;
  armContext(side: Side): boolean;
}

export class ArmChain {
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
  private readonly _foreParentQ = new THREE.Quaternion();
  private readonly _foreQ = new THREE.Quaternion();
  private readonly _handParentQ = new THREE.Quaternion();
  private readonly _handQ = new THREE.Quaternion();
  private readonly _aim: Record<ArmSlot, THREE.Vector3> = {
    shoulder: new THREE.Vector3(),
    upperArm: new THREE.Vector3(),
    lowerArm: new THREE.Vector3(),
    hand: new THREE.Vector3(),
  };
  /** Roll the last palm solve asked for. */
  private _roll = 0;

  /** What the roll budget delivered last frame, for its slew. See `aimArm`. */
  private readonly _rollHeld: Record<Side, { fore: number; humeral: number; set: boolean }> = {
    L: { fore: 0, humeral: 0, set: false },
    R: { fore: 0, humeral: 0, set: false },
  };

  // Scratch for the anatomical clamp, which needs all three arm directions at
  // once — the chain walk in `aimArm` only ever holds one.
  private readonly _limited: Record<Side, LimitedDirs>;
  // Where the limiter actually left each link last frame, and whether that is
  // known for this side. See `slew`.
  private readonly _held: Record<Side, LimitedDirs>;
  private readonly _heldLimit: Record<Side, boolean> = { L: false, R: false };
  private readonly _palmWorld: Record<Side, THREE.Vector3> = {
    L: new THREE.Vector3(),
    R: new THREE.Vector3(),
  };

  constructor(
    private readonly p: Profile,
    private readonly joints: JointTable,
    private readonly anat: ArmAnatomy,
    private readonly palmLocal: Hands['palmLocal'],
    private readonly _humeralFront: Partial<Record<Side, THREE.Vector3>>,
    private readonly foreRoll: Record<Side, number>,
    private readonly upperRoll: Record<Side, number>,
    private readonly armTwists: ArmTwists | null,
    private readonly restOf: (bone: THREE.Bone) => THREE.Quaternion,
    private readonly port: ArmChainPort,
  ) {
    const trio = (): LimitedDirs => ({
      upperArm: new THREE.Vector3(),
      lowerArm: new THREE.Vector3(),
      hand: new THREE.Vector3(),
    });
    this._limited = { L: trio(), R: trio() };
    this._held = { L: trio(), R: trio() };
  }

  private get dt(): number {
    return this.port.dt();
  }

  private get limitsEnabled(): boolean {
    return this.port.limitsEnabled();
  }

  private armContext(side: Side): boolean {
    return this.port.armContext(side);
  }

  /** Forget where the limiter left each link, so the next frame is not slewed from a stale pose. */
  releaseSlew(): void {
    this._heldLimit.L = false;
    this._heldLimit.R = false;
  }

  /** Forget the previous frame's limiter output and roll budget. */
  releaseContinuity(): void {
    this._heldLimit.L = false;
    this._heldLimit.R = false;
    this._rollHeld.L.fore = 0;
    this._rollHeld.L.humeral = 0;
    this._rollHeld.L.set = false;
    this._rollHeld.R.fore = 0;
    this._rollHeld.R.humeral = 0;
    this._rollHeld.R.set = false;
    this._roll = 0;
  }

  /**
   * World rotation of `bone`'s actual parent, given the world rotation of the
   * chain bone `above` it. On a direct chain that is `aboveWorld` itself; a
   * carrier bone interposed between the two adds its own local rotation, which
   * a chain walked link by link would otherwise silently drop.
   */
  private parentWorld(
    bone: THREE.Bone,
    above: THREE.Object3D,
    aboveWorld: THREE.Quaternion,
    out: THREE.Quaternion,
  ): THREE.Quaternion {
    const parent = bone.parent;
    if (parent === above) return aboveWorld;
    out.identity();
    for (let node = parent; node; node = node.parent) {
      if (node === above) return out.premultiply(aboveWorld);
      out.premultiply(node.quaternion);
    }
    // Not below the chain bone at all: read the parent the scene actually has.
    return parent ? parent.getWorldQuaternion(out) : out.identity();
  }

  /**
   * Aim one bone so its child direction points along `targetWorld`.
   * Writes this bone's world rotation into `out` and returns it, so the next
   * bone down can derive its parent rotation from it. `parentWorldQ` must be
   * the world rotation of `bone.parent` itself — see `parentWorld`.
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
   * Turn an aimed humerus about its own axis until its front faces the way the
   * forearm folds.
   *
   * The shortest-arc aim leaves the humerus at whatever roll the swing from rest
   * gives it, so a rotated arm bent its elbow up to eighty degrees off the bone's
   * own hinge: the crease of the mesh faced one way and the forearm folded
   * another, and pronation was counted from a frame no forearm has. Faded in with
   * the bend, by the trust the measurement gives it, because a straight elbow
   * folds nowhere.
   */
  private hingeUpper(side: Side, upper: THREE.Bone, uD: THREE.Vector3, lD: THREE.Vector3): void {
    const rest = this._humeralFront[side];
    const trust = rotationTrust(Math.acos(THREE.MathUtils.clamp(uD.dot(lD), -1, 1)));
    if (!rest || trust <= 0) return;
    const front = _hingeFront.copy(rest).applyQuaternion(this._upperQ);
    front.addScaledVector(uD, -front.dot(uD));
    const fold = _hingeFold.copy(lD).addScaledVector(uD, -lD.dot(uD));
    if (front.lengthSq() < 1e-8 || fold.lengthSq() < 1e-8) return;
    front.normalize();
    fold.normalize();
    const turn = Math.atan2(_hingeAxis.crossVectors(front, fold).dot(uD), front.dot(fold));
    upper.quaternion.multiply(
      _twistQ.setFromAxisAngle(this.p.restDir[`upperArm.${side}`], turn * trust),
    );
    this._upperQ.copy(this._upperParentQ).multiply(upper.quaternion);
  }

  /** Pose the shoulder alone. See `Rig.aimShoulder`. */
  aimShoulder(side: Side, dir: Vec3Tuple | THREE.Vector3 | null): void {
    const { bones, restDir } = this.p;
    const bone = bones[`shoulder.${side}`];
    // The clavicle's own parent, which a rig may not have put on the chest slot.
    const parent = bone?.parent;
    if (!(bone && parent && dir)) return;
    this.aim(
      bone,
      restDir[`shoulder.${side}`],
      parent.getWorldQuaternion(this._chainQ[0]),
      worldDirection(dir),
      0,
      this._chainQ[1],
    );
  }

  /** Legacy single-chain path. See `Rig.aimArmLegacy`. */
  aimArmLegacy(
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

    // The bounded directions, each in its own vector. `worldDirection` hands back one
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
    // From the chain's real parent, which a rig may not have put on the chest slot.
    const top = (clav ?? upper)?.parent ?? chest;
    let q = top.getWorldQuaternion(this._chainQ[0]);
    if (clav) {
      q = sD
        ? this.aim(clav, restDir[`shoulder.${side}`], q, sD, 0, this._chainQ[1])
        : this._chainQ[1].copy(q).multiply(this.restOf(clav));
    }
    // The chain bone each link hangs from, whose world rotation the walk holds.
    const aboveUpper = clav ?? top;
    const aboveFore = upper ?? aboveUpper;
    const aboveHand = fore ?? aboveFore;
    this._upperParentQ.copy(upper ? this.parentWorld(upper, aboveUpper, q, this._upperParentQ) : q);
    if (upper) {
      if (uD) this.aim(upper, restDir[`upperArm.${side}`], this._upperParentQ, uD, 0, this._upperQ);
      else this._upperQ.copy(q).multiply(this.restOf(upper));
      if (uD && lD) this.hingeUpper(side, upper, uD, lD);
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
        const fp = this.parentWorld(fore, aboveFore, this._upperQ, this._foreParentQ);
        if (lD) this.aim(fore, foreDir, fp, lD, 0, this._foreQ);
        else this._foreQ.copy(fp).multiply(this.restOf(fore));
        if (carry) {
          fore.quaternion.multiply(_twistQ.setFromAxisAngle(foreDir, carry));
          this._foreQ.copy(fp).multiply(fore.quaternion);
        }
        p = this._foreQ;
      }
      if (!hand) return 0;
      const hp = this.parentWorld(hand, aboveHand, p, this._handParentQ);
      if (!hD) {
        hand.quaternion.copy(this.restOf(hand));
        this._handQ.copy(hp).multiply(hand.quaternion);
        return 0;
      }
      this.aim(hand, handDir, hp, hD, hw, this._handQ, palm);
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

    // The axial half of `slew`: neither roll shows in a link direction, so the
    // direction slew cannot see one change. A palm demand passing half a turn
    // changes sign in a frame, and the clamp sent the forearm from one stop to
    // the other; the shoulder's share steps on its gate and its undo. Eased, the
    // arm still ends where the plain answer says, however it was arrived at.
    const held = this._rollHeld[side];
    const rollStep = LIMIT_SLEW * this.dt;
    if (held.set && rollStep > 0) {
      const eased =
        held.humeral + THREE.MathUtils.clamp(humeral - held.humeral, -rollStep, rollStep);
      if (upper && eased !== humeral) {
        upper.quaternion.multiply(
          _twistQ.setFromAxisAngle(restDir[`upperArm.${side}`], eased - humeral),
        );
        this._upperQ.copy(this._upperParentQ).multiply(upper.quaternion);
        humeral = eased;
        R = below(0, 0);
      }
    }

    let total = THREE.MathUtils.clamp(R, pron.max[0], pron.max[1]);
    if (held.set && rollStep > 0)
      total = held.fore + THREE.MathUtils.clamp(total - held.fore, -rollStep, rollStep);
    held.fore = total;
    held.humeral = humeral;
    held.set = true;
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
    this.armTwists?.stage(side);
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
    out.upperArm.copy(worldDirection(u));
    out.lowerArm.copy(worldDirection(l));
    out.hand.copy(worldDirection(h));
    this.anat.clamp(side, out.upperArm, out.lowerArm, out.hand, this.palmWorld(side, palm));
    this.slew(side, out);
    return out;
  }

  /**
   * Hold the limiter's output to a speed a limb can move at.
   *
   * The body layer takes great care that nothing it hands down here steps — the
   * followers in `motion/follow.ts` exist for that and nothing else — and then
   * this layer puts a step back in. A clamp is a projection onto the set of
   * poses a joint allows, that set is not convex, and projection onto a
   * non-convex set is discontinuous by construction: the humeral rotation is
   * bounded to half a circle, so a request that drifts past the far side of it
   * is equally close to both stops and the nearest one changes in a single
   * frame. The forearm then swings a hundred and eighty degrees between two
   * frames. Measured across every ordered switch between two gestures, one in
   * six carried the wrist faster than four metres a second and the worst carried
   * it at twenty-six, against a peak of two or three for the movement itself.
   * Switching the limiter off entirely left five in a thousand over four, which
   * is what said the clamp was the whole of it rather than a part.
   *
   * The elevation ceiling, the elbow and the wrist each have a seam of their own
   * and no one of them accounts for it, so this bounds the result rather than
   * chasing them: whatever the clamp asks for, the arm travels there at a speed
   * a limb has. Below the cap nothing changes at all, which is what makes it
   * safe — see `LIMIT_SLEW`. The cost is that for the tenth of a second after a
   * seam the arm is outside the stop it was being pulled inside, and that is the
   * trade: `measure` reads the posed bones, so the panel shows the excursion
   * honestly rather than reporting the pose the clamp asked for.
   */
  private slew(side: Side, out: LimitedDirs): void {
    const held = this._held[side];
    const step = LIMIT_SLEW * this.dt;
    if (!(this._heldLimit[side] && step > 0)) {
      for (const slot of LIMITED_SLOTS) held[slot].copy(out[slot]);
      this._heldLimit[side] = true;
      return;
    }
    for (const slot of LIMITED_SLOTS) {
      const cur = held[slot];
      const want = out[slot];
      const axis = _slewAxis.crossVectors(cur, want);
      const sin = axis.length();
      const cos = THREE.MathUtils.clamp(cur.dot(want), -1, 1);
      if (Math.atan2(sin, cos) <= step) {
        cur.copy(want);
      } else if (sin > 1e-9) {
        cur.applyAxisAngle(axis.divideScalar(sin), step).normalize();
      } else {
        // Exactly opposed, which is the half-turn this exists for and the one
        // case where the shortest rotation does not name an axis. Any
        // perpendicular is as short as any other and one has to be picked —
        // leaving the axis at zero would park the link on the far side of the
        // sphere and call it arrived, which is the teleport rather than a fix.
        _slewPerp.set(1, 0, 0);
        if (Math.abs(cur.x) > 0.9) _slewPerp.set(0, 1, 0);
        cur.applyAxisAngle(axis.crossVectors(cur, _slewPerp).normalize(), step).normalize();
      }
      out[slot].copy(cur);
    }
  }
}
