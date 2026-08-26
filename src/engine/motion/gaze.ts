import * as THREE from 'three';
import { smoothstep } from './idle';

/**
 * Gaze wander.
 *
 * Self-contained state with one output, so it is its own object: the body layer
 * owns one and reads the three offsets off it.
 */

// Below this the head does not commit to a glance at all — small saccades are
// eyes-only, and driving the neck off every one of them makes the body fidget.
const HEAD_DEADZONE = 0.05;

/**
 * Gaze wander. Eyes hold a fixation for a beat, flick to a new one, and come
 * back to the camera about half the time. A gaze locked dead on the lens for
 * minutes is the single most obviously synthetic thing an avatar can do.
 */
export class Gaze {
  /** Eyes: ballistic. Radians, x = yaw, y = pitch. */
  readonly offset = new THREE.Vector2();
  /** Head and neck: settles after the eyes. */
  readonly settled = new THREE.Vector2();
  /** Ocular drift and microsaccades, added to the eyes only. */
  readonly micro = new THREE.Vector2();

  /**
   * Amplitude on the frame a new fixation starts, so the director can blink
   * with it. Zero on every other frame.
   */
  saccade = 0;

  private readonly _vel = new THREE.Vector2(); // spring velocity for `settled`
  private readonly _target = new THREE.Vector2();
  private readonly _from = new THREE.Vector2();
  private _sacT = 1;
  private _sacDur = 0.05;
  private _timer = 1.2;

  update(dt: number, t: number): void {
    this.saccade = 0;
    this._timer -= dt;
    if (this._timer <= 0) {
      const back = Math.random() < 0.45;
      const nx = back ? 0 : (Math.random() - 0.5) * 0.42;
      const ny = back ? 0 : (Math.random() - 0.5) * 0.22;
      const amp = Math.hypot(nx - this.offset.x, ny - this.offset.y);
      this.saccade = amp;
      this._target.set(nx, ny);
      this._from.copy(this.offset);
      this._sacT = 0;
      // Main sequence: a saccade's duration scales with its amplitude. One
      // fixed time constant makes small glances sluggish and large ones snap.
      this._sacDur = 0.026 + amp * 0.24;
      this._timer = 0.9 + Math.random() * 2.8;
    }

    if (this._sacT < 1) {
      this._sacT = Math.min(1, this._sacT + dt / this._sacDur);
      const e = smoothstep(this._sacT);
      this.offset.x = this._from.x + (this._target.x - this._from.x) * e;
      this.offset.y = this._from.y + (this._target.y - this._from.y) * e;
    }

    // Fixation is not stillness. Ocular drift and microsaccades sit far below
    // the threshold of conscious notice, and it is their *absence* that makes a
    // held gaze read as a rendering rather than as a person.
    this.micro.set(
      0.0022 * Math.sin(t * 3.11) + 0.0014 * Math.sin(t * 7.7 + 1.3),
      0.0016 * Math.sin(t * 2.63 + 0.9) + 0.0011 * Math.sin(t * 6.1 + 2.4),
    );

    // The head does not snap with the eyes; it settles after them, as a mass on
    // a neck does. Modelled as a spring left slightly under-damped, because a
    // critically damped head arrives dead and an exponential ease never
    // overshoots at all — and a real head does, slightly, every time.
    const OMEGA = 3.4;
    const ZETA = 0.72;
    const mag = Math.hypot(this.offset.x, this.offset.y);
    const follow = mag > HEAD_DEADZONE ? (mag - HEAD_DEADZONE) / mag : 0;
    const tx = this.offset.x * follow;
    const ty = this.offset.y * follow;
    this._vel.x += (-2 * ZETA * OMEGA * this._vel.x - OMEGA * OMEGA * (this.settled.x - tx)) * dt;
    this._vel.y += (-2 * ZETA * OMEGA * this._vel.y - OMEGA * OMEGA * (this.settled.y - ty)) * dt;
    this.settled.x += this._vel.x * dt;
    this.settled.y += this._vel.y * dt;
  }
}
