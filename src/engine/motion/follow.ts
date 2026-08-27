import * as THREE from 'three';

/**
 * Followers: what turns a target that jumps into a value that moves.
 *
 * Every channel in the body layer composes a target from scratch each frame and
 * then chases it, rather than being set to it. That is not a smoothing
 * nicety — the target genuinely is discontinuous, because switching gestures
 * replaces the pose being blended toward in a single frame, and no amount of
 * care in the blend can remove a step from something the blend does not own.
 *
 * The filter is **second-order critically damped**, and the order is the point.
 *
 * The obvious way to chase a target is to move a fixed fraction of the
 * remaining distance each frame. That removes steps, and its velocity is
 * highest on the very first frame and decays from there — a profile that is
 * backwards. A limb that leaves at full speed and creeps into its pose is the
 * shape of a mechanism responding, not of a person moving, and it is also the
 * shape that never quite arrives, so every gesture carries a long tail during
 * which the arm is still visibly settling.
 *
 * Raising the order fixes both. A step in the target still produces a bounded
 * response, but one that starts at zero velocity, rises and falls. Critically
 * damped, so there is no ringing: this is not a spring effect, it is the same
 * job done with the right order of filter.
 */

/**
 * Rate constants are quoted in first-order terms, because that is what they
 * were measured as: a rate of k means a step is 90% closed after ln(10)/k
 * seconds, and the figures the body layer passes were chosen against the
 * oscillation frequencies its gestures are written at.
 *
 * A critically damped second-order filter at the same constant is markedly
 * slower, because its response has to accelerate before it can travel. It
 * reaches 90% at 3.89/w, so w = k * 3.89 / ln(10) keeps the two agreeing on
 * when a movement is over while disagreeing about how it got there — which is
 * the whole of the change.
 */
export const OMEGA_PER_RATE = 3.89 / Math.LN10;

const _axis = new THREE.Vector3();
const _step = new THREE.Vector3();
const _perp = new THREE.Vector3();

/**
 * A unit direction that follows a unit target.
 *
 * The second-order state is an angular velocity — an axis scaled by a rate —
 * which is the only form that stays meaningful on a sphere. Filtering the three
 * components independently and renormalising is the obvious alternative and is
 * wrong in a way that shows: the correction pulls toward the chord rather than
 * along the arc, so a large turn cuts the corner and a limb swinging across the
 * body dips through it.
 */
export class DirFollower {
  readonly dir: THREE.Vector3;
  private readonly _vel = new THREE.Vector3();

  constructor(start: THREE.Vector3) {
    this.dir = start.clone().normalize();
  }

  /** Drop any stored motion. For a channel that has just been re-seeded. */
  reset(to?: THREE.Vector3): void {
    if (to) this.dir.copy(to).normalize();
    this._vel.set(0, 0, 0);
  }

  /** Advance one frame toward `target`. `rate` is as `OMEGA_PER_RATE` states. */
  step(target: THREE.Vector3, dt: number, rate: number): THREE.Vector3 {
    // The rotation vector that would take `dir` onto `target` in one step:
    // the axis of the shortest rotation, scaled by its angle.
    const ax = _axis.crossVectors(this.dir, target);
    const s = ax.length();
    const c = THREE.MathUtils.clamp(this.dir.dot(target), -1, 1);
    if (s > 1e-9) {
      ax.multiplyScalar(Math.atan2(s, c) / s);
    } else if (c < 0) {
      // Exactly opposed. Every axis is a shortest rotation, so any perpendicular
      // will do — and one has to be chosen, because leaving the error at zero
      // parks the direction on the far side of the sphere permanently.
      _perp.set(1, 0, 0);
      if (Math.abs(this.dir.x) > 0.9) _perp.set(0, 1, 0);
      ax.crossVectors(this.dir, _perp).normalize().multiplyScalar(Math.PI);
    } else {
      ax.set(0, 0, 0);
    }

    // Semi-implicit critically damped step. Written in the implicit form so it
    // stays stable at any timestep: an explicit integrator at a rate this high
    // diverges the first time a frame is long, and a frame is long every time
    // the tab comes back from the background.
    const w = rate * OMEGA_PER_RATE;
    const denom = 1 + 2 * w * dt + w * w * dt * dt;
    this._vel.addScaledVector(ax, w * w * dt).divideScalar(denom);

    const speed = this._vel.length();
    if (speed > 1e-9) {
      this.dir.applyAxisAngle(_step.copy(this._vel).divideScalar(speed), speed * dt);
    }
    return this.dir.normalize();
  }
}

/** The same filter on a plain number — finger curl, forearm twist, a weight. */
export class ScalarFollower {
  value: number;
  private _vel = 0;

  constructor(start: number) {
    this.value = start;
  }

  reset(to?: number): void {
    if (to !== undefined) this.value = to;
    this._vel = 0;
  }

  step(target: number, dt: number, rate: number): number {
    const w = rate * OMEGA_PER_RATE;
    const denom = 1 + 2 * w * dt + w * w * dt * dt;
    this._vel = (this._vel + w * w * dt * (target - this.value)) / denom;
    this.value += this._vel * dt;
    return this.value;
  }
}
