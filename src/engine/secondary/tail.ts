import * as THREE from 'three';
import type { AvatarDescriptor, EmotionName, EmotionVector, Profile } from '../types';
import type { Joint, Spring } from './spring';

/**
 * Tail — the appendage nothing else drives.
 *
 * ## Why this is not secondary motion
 *
 * A tail looks like hair: a chain of bones with no animation of its own, and
 * the sway layer already simulates it. But hair gets away with being purely
 * passive because it hangs off a head, and a head looks around, nods, and
 * follows the camera all the time. A tail hangs off the hips, and a standing
 * character's hips are almost still by design — the weight shift in `motion/body.ts`
 * is ±0.03 rad on a twenty-second cycle, which puts the tip of a 0.7 m tail at
 * a few millimetres per second. The simulation is running and correct, and the
 * result is a tail that does not move.
 *
 * That is not a tuning problem. No amount of stiffness or drag makes a chain
 * swing when nothing swings it, and raising the weight shift until the tail
 * moves would mean a character that sways at the hips like it is on a boat. The
 * missing piece is an input, not a parameter.
 *
 * ## What it drives, and how
 *
 * On an animal-eared character the tail is part of the face. It is where the
 * emotion the voice is carrying shows up on the body, and an audience reads it
 * without being told to — a tail that goes still is a character that has gone
 * flat. So it is driven from the same emotion vector the expression layer
 * composes from, and the mapping below is the whole of the performance.
 *
 * The drive is written onto the *rest pose* of the chain's root, not onto the
 * bone (see `Spring#enableDrive`). The base is posed, the simulation still runs
 * underneath it, and the length of the tail arrives late and overshoots — which
 * is the part that makes a wag read as a tail rather than as a rotating stick.
 *
 * ## What is measured and what is stated
 *
 * The axes are measured off the rig. Which way is "up" and which way is "the
 * character's own right" comes from the body frame the profile already builds
 * out of the shoulders and the neck, and which sign of that axis *raises* the
 * tail is settled by testing it against the direction the tail actually hangs.
 * Nothing here names a bone or assumes an export convention, and both avatars
 * resolve to the same answer through different rigs.
 *
 * What the descriptor states is how far — a long tail and a short one want
 * different angles at the base for the same read — and that is avatar data.
 */

const TAU = Math.PI * 2;

/** How one canonical emotion carries in the tail. */
interface Mood {
  rate: number;
  swing: number;
  lift: number;
}

/**
 * How each canonical emotion carries in the tail.
 *
 * Avatar-independent, exactly like the ARKit table in `face/emotions.ts`: these
 * are facts about what the emotions look like, not about either model.
 *
 * `rate` is wags per second, `swing` a fraction of the avatar's stated sweep,
 * and `lift` a signed fraction of its stated raise — positive up, negative
 * tucked. The three are what separate the moods from each other: joy is fast
 * and wide, anger is faster but low and narrow, sadness drops the tail and
 * nearly stops it, and surprise stands it up without sweeping at all.
 *
 * Neutral is not zero. A resting tail still drifts, and the difference between
 * a small slow sweep and no sweep is the difference between a character who is
 * calm and one whose rig has stopped.
 */
const MOOD: Record<EmotionName, Mood> = {
  neutral: { rate: 0.55, swing: 0.3, lift: 0.0 },
  joy: { rate: 2.2, swing: 1.0, lift: 0.55 },
  relaxed: { rate: 0.45, swing: 0.55, lift: 0.1 },
  thinking: { rate: 0.5, swing: 0.35, lift: 0.05 },
  surprise: { rate: 1.5, swing: 0.3, lift: 0.9 },
  anger: { rate: 2.6, swing: 0.6, lift: -0.2 },
  sadness: { rate: 0.25, swing: 0.15, lift: -0.85 },
  shy: { rate: 0.7, swing: 0.2, lift: -0.55 },
};

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _lift = new THREE.Quaternion();

/** World rotation of a node, with any scale on the hierarchy divided out. */
const worldQuat = (node: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion =>
  out.setFromRotationMatrix(_m.extractRotation(node.matrixWorld));

export class Tail {
  active = false;
  readonly missing: string[] = [];
  /**
   * Operator-facing scale over the authored sweep, for the same reason the
   * sway layer has them: "is this tail doing too much" is judged by watching.
   *
   * Two, not one. The authored angles are the ones a tail hangs at, and
   * watching it next to the rest of the idle says they read as understated on
   * both avatars — a tail is a large, high-contrast shape at the edge of the
   * frame, and it takes more travel than a face does to register at all. The
   * figure is here rather than doubled in the descriptors because the angles
   * there are per-model and this is not: it is the same judgement about both.
   */
  amount = 2;

  t = 0;
  _phase = 0;

  joints: Joint[] = [];
  swingAxis = new THREE.Vector3();
  liftAxis = new THREE.Vector3();
  swingRange = 0;
  liftRange = 0;
  restLift = 0;

  /**
   * @param profile  the avatar profile; the body frame and the chest are read
   *                 from it to measure the axes
   * @param avatar   the avatar descriptor. No `drive.tail` means no tail drive,
   *                 which is the normal state for an avatar without a tail.
   * @param spring   the sway layer, which owns the chain and hands over its root
   */
  constructor(profile: Profile, avatar: AvatarDescriptor, spring: Spring) {
    const spec = avatar.drive?.tail;
    if (!spec) return;

    // Checked before the chain is claimed, so a failure here does not leave the
    // sway layer carrying joints marked as driven by nobody.
    const frame = profile.body;
    const chest = profile.bones.chest ?? profile.bones.spine ?? profile.bones.hips;
    if (!(frame && chest)) {
      this.missing.push('drive:no body frame');
      return;
    }

    const id = spec.group ?? 'tail';
    const joints = spring.enableDrive(id);
    if (!joints) {
      this.missing.push(`drive:${id}`);
      return;
    }

    profile.root.updateMatrixWorld(true);
    worldQuat(chest, _q);
    const up = frame.up.clone().applyQuaternion(_q);
    const right = frame.right.clone().applyQuaternion(_q);
    const forward = frame.forward.clone().applyQuaternion(_q);

    // The drive is applied in the parent's frame, so the axes have to be stated
    // there. The parent is the hips on both of these rigs, but nothing below
    // depends on that — only on it being whatever the chain hangs from.
    const base = joints[0];
    const parentQ = worldQuat(base.parent, new THREE.Quaternion());
    const toParent = parentQ.clone().invert();

    // Which sign of `right` raises the tail rather than tucking it.
    //
    // Rotating about an axis moves the tip along `axis × direction`, so the
    // sign is read straight off that derivative. Scoring it against *up minus
    // forward* rather than against up alone is what keeps the degenerate case
    // honest: a tail hanging straight down has no up-component either way, and
    // for that one the answer that reads as "raised" is the one that swings it
    // backwards. Both avatars here hang back-and-down and agree on the sign
    // through rigs that share no naming.
    const dir = base.restDir(parentQ, new THREE.Vector3());
    _v.crossVectors(right, dir);
    const raises = _v.dot(up) - _v.dot(forward) >= 0 ? 1 : -1;

    this.joints = joints;
    this.swingAxis = up.applyQuaternion(toParent).normalize();
    this.liftAxis = right.multiplyScalar(raises).applyQuaternion(toParent).normalize();

    this.swingRange = spec.swing ?? 0.45;
    this.liftRange = spec.lift ?? 0.3;
    this.restLift = spec.rest ?? 0;
    this.active = true;

    // The sway layer calibrated its colliders against the bind pose, which is
    // the one pose this chain is now guaranteed not to stay in. Hand it the
    // corners of the range so a collider cannot quietly eat half the
    // performance — see `Spring#calibrateDrive`.
    //
    // Sampled at the default amount, not at whatever the panel can reach. The
    // clearance carved out of the author's collider should cover the motion the
    // avatar actually ships with and no more; an operator winding the slider
    // past it gets clamped, which is what an override is supposed to feel like.
    const poses: THREE.Quaternion[] = [];
    for (const s of [-1, 0, 1]) {
      for (const l of [-1, 1]) {
        const q = new THREE.Quaternion().setFromAxisAngle(
          this.swingAxis,
          this.swingRange * s * this.amount,
        );
        const held = Math.max(-1, Math.min(1, this.restLift + l));
        poses.push(
          q.multiply(_lift.setFromAxisAngle(this.liftAxis, this.liftRange * held * this.amount)),
        );
      }
    }
    spring.calibrateDrive(id, poses);
  }

  /**
   * @param emotion  the director's blended emotion vector, already eased — so
   *                 the mood below inherits that easing and nothing here has to
   *                 smooth a switch a second time
   * @param energy   speech envelope, 0 when silent
   */
  update(dt: number, emotion: EmotionVector, energy = 0): void {
    if (!this.active) return;
    this.t += dt;

    // Weighted mean over whatever the vector holds. Normalised by the total so
    // a vector that does not sum to one — which the API permits — changes the
    // mix and not the overall amount.
    let rate = 0;
    let swing = 0;
    let lift = 0;
    let total = 0;
    for (const [name, w] of Object.entries(emotion) as [EmotionName, number][]) {
      const m = MOOD[name];
      if (!(m && w > 0)) continue;
      rate += m.rate * w;
      swing += m.swing * w;
      lift += m.lift * w;
      total += w;
    }
    if (total > 1e-4) {
      rate /= total;
      swing /= total;
      lift /= total;
    } else ({ rate, swing, lift } = MOOD.neutral);

    // Talking lifts the whole performance a little. Small on purpose: a tail
    // that tracks the voice closely reads as lip-sync rather than as mood.
    rate *= 1 + 0.35 * energy;
    swing *= 1 + 0.25 * energy;

    // Phase is accumulated rather than taken from absolute time, so a change of
    // rate eases instead of teleporting the tail to the other side of its arc.
    this._phase = (this._phase + dt * rate * TAU) % TAU;

    // Two incommensurable terms and a slow amplitude wander, for the reason the
    // head micro-motion has them: a single sine at a constant amplitude is read
    // as machine-driven within a few cycles, and a tail is a large, high
    // contrast shape that gives the viewer plenty of chances to notice.
    const wave = 0.85 * Math.sin(this._phase) + 0.15 * Math.sin(this._phase * 0.37 + 1.1);
    const wander = 0.78 + 0.22 * Math.sin(this.t * 0.23 + 0.7);

    // Clamped, not because the table exceeds the range but because the resting
    // bias is descriptor data and a tail driven past its stated raise is a tail
    // driven into the character's back.
    const held = Math.max(-1, Math.min(1, this.restLift + lift));

    const a = this.amount;
    _q.setFromAxisAngle(this.swingAxis, this.swingRange * swing * wave * wander * a);
    _lift.setFromAxisAngle(this.liftAxis, this.liftRange * held * a);
    // Lift first, then sweep: the sweep is about the body's own vertical, so
    // applying it last sweeps the raised tail horizontally instead of rolling
    // the arc over with it.
    _q.multiply(_lift);

    for (const j of this.joints) j.drive.copy(_q);
  }
}
