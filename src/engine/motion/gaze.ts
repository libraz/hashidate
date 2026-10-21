import * as THREE from 'three';
import { REF_DT } from './follow';
import { smoothstep } from './idle';

/**
 * Gaze wander.
 *
 * Self-contained state with one output, so it is its own object: the body layer
 * owns one and reads the three offsets off it.
 */

/** Natural frequency of the head settling after the eyes, rad/s. See `Gaze.update`. */
export const HEAD_OMEGA = 3.4;
const HEAD_ZETA = 0.72;

/**
 * The head spring's poles, in closed form, as `HEAD_OMEGA` and `HEAD_ZETA`
 * played under the explicit step they were tuned with at `REF_DT`: that step's
 * per-frame decay and turn, read back as a continuous decay rate and frequency.
 */
const HEAD_POLES = (() => {
  const h = HEAD_OMEGA * REF_DT;
  const det = 1 - 2 * HEAD_ZETA * h;
  const trace = 2 - h * h - 2 * HEAD_ZETA * h;
  return {
    decay: -Math.log(det) / (2 * REF_DT),
    freq: Math.acos(trace / (2 * Math.sqrt(det))) / REF_DT,
  };
})();

/**
 * One exact step of the head spring: error `y` from the target and velocity
 * `v` advanced by `dt`, into `out`. Stable at any timestep.
 */
function headStep(out: { x: number; v: number }, y: number, v: number, dt: number): void {
  const { decay, freq } = HEAD_POLES;
  const e = Math.exp(-decay * dt);
  const c = Math.cos(freq * dt);
  const sn = Math.sin(freq * dt);
  const b = (v + decay * y) / freq;
  out.x = e * (y * c + b * sn);
  out.v = e * ((freq * b - decay * y) * c - (decay * b + freq * y) * sn);
}

// Below this the head does not commit to a glance at all — small saccades are
// eyes-only, and driving the neck off every one of them makes the body fidget.
const HEAD_DEADZONE = 0.05;

// Share of turn onsets that open with the eyes off the listener (Andrist 2013).
const ONSET_AVERT = 0.731;
// Seconds before a turn ends by which the eyes are back on the listener (Andrist 2013).
export const END_RETURN = 2.41;
// Shortest onset hold worth starting; anything briefer reads as a twitch (estimate).
export const AVERT_MIN = 0.5;
// Onset hold, seconds: N(1.27, 0.51) after Andrist 2013.
export const HOLD_MEAN = 1.27;
const HOLD_SD = 0.51;
// Hold bounds, about mean ±2 SD, to round off the normal's tails.
const HOLD_MIN = 0.5;
const HOLD_MAX = 2.3;
// Cumulative direction split: up 21.3%, down 29.5%, side the rest (Andrist 2013).
const AVERT_UP = 0.213;
const AVERT_DOWN = 0.508;
// Aversion fixations: the edges of the wander's own range, so no new amplitude.
const AVERT_SIDE = 0.21;
const AVERT_VERT = 0.11;

export interface GazeOptions {
  /** Injectable only so a test can step the wander deterministically. */
  random?: () => number;
}

/** Where the current line sits in its run of speech, read once per frame. */
export interface SpeechGaze {
  speaking: boolean;
  /** Seconds of the current line still to play. */
  remaining: number;
  /** The line starts a run rather than continuing one. */
  opens: boolean;
  /** Nothing is queued behind the line, so the run ends with it. */
  closes: boolean;
}

/**
 * Speech-driven state. `hold` covers the aversion and the saccade into it,
 * `return` the saccade back, `settle` a return forced by speech stopping, which
 * the wander may not cut short. `none` is the plain wander.
 */
type Avert = 'none' | 'hold' | 'return' | 'settle';

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
  private readonly _spring = { x: 0, v: 0 };
  private readonly _target = new THREE.Vector2();
  private readonly _from = new THREE.Vector2();
  private _sacT = 1;
  private _sacDur = 0.05;
  private _timer = 1.2;

  private readonly _random: () => number;
  private _speaking = false;
  private _pinned = false;
  private _avert: Avert = 'none';
  private _hold = 0;

  constructor({ random = Math.random }: GazeOptions = {}) {
    this._random = random;
  }

  /**
   * Advance one frame. Without `speech`, or while nothing speech-driven is in
   * flight, this is the plain wander, draw for draw. A run's first line may
   * open with an aversion, and the last `END_RETURN` seconds of a run hold the
   * eyes on the camera.
   */
  update(dt: number, t: number, speech?: SpeechGaze): void {
    this.saccade = 0;
    const speaking = speech?.speaking ?? false;
    const rising = speaking && !this._speaking;
    const falling = !speaking && this._speaking;
    this._speaking = speaking;
    const pinned = !!speech && speaking && speech.closes && speech.remaining < END_RETURN;
    const pinRising = pinned && !this._pinned;
    this._pinned = pinned;

    // Speech stopped mid-aversion: finish the way back before the wander resumes.
    if (falling && (this._avert === 'hold' || this._avert === 'return')) {
      if (this._avert === 'hold') this._saccadeTo(0, 0);
      this._avert = 'settle';
    }

    if (
      speech &&
      rising &&
      speech.opens &&
      speech.remaining >= END_RETURN + AVERT_MIN &&
      this._random() < ONSET_AVERT
    ) {
      const r = this._random();
      let ax = 0;
      let ay = 0;
      if (r < AVERT_UP) ay = AVERT_VERT;
      else if (r < AVERT_DOWN) ay = -AVERT_VERT;
      else ax = this._random() < 0.5 ? -AVERT_SIDE : AVERT_SIDE;
      // Box-Muller, cosine half only; 1 - u keeps the log finite.
      const u1 = 1 - this._random();
      const u2 = this._random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      let hold = THREE.MathUtils.clamp(HOLD_MEAN + HOLD_SD * z, HOLD_MIN, HOLD_MAX);
      if (speech.closes) hold = Math.min(hold, speech.remaining - END_RETURN);
      this._hold = hold;
      this._avert = 'hold';
      this._saccadeTo(ax, ay);
    } else if (this._avert === 'hold') {
      this._hold -= dt;
      if (this._hold <= 0) {
        this._avert = 'return';
        this._saccadeTo(0, 0);
      }
    }

    // The run's close holds the camera; any fixation elsewhere is abandoned.
    if (pinRising && (this._target.x !== 0 || this._target.y !== 0)) {
      this._avert = 'none';
      this._saccadeTo(0, 0);
    }

    if (this._avert !== 'hold' && this._avert !== 'settle') {
      this._timer -= dt;
      if (this._timer <= 0) {
        const back = this._random() < 0.45;
        let nx = back ? 0 : (this._random() - 0.5) * 0.42;
        let ny = back ? 0 : (this._random() - 0.5) * 0.22;
        if (pinned) {
          nx = 0;
          ny = 0;
        }
        this._avert = 'none';
        this._saccadeTo(nx, ny);
        this._timer = 0.9 + this._random() * 2.8;
      }
    }

    if (this._sacT < 1) {
      this._sacT = Math.min(1, this._sacT + dt / this._sacDur);
      const e = smoothstep(this._sacT);
      this.offset.x = this._from.x + (this._target.x - this._from.x) * e;
      this.offset.y = this._from.y + (this._target.y - this._from.y) * e;
    }
    if (this._sacT >= 1 && (this._avert === 'return' || this._avert === 'settle')) {
      this._avert = 'none';
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
    // Stepped in closed form, so the overshoot is the same on every display.
    const mag = Math.hypot(this.offset.x, this.offset.y);
    const follow = mag > HEAD_DEADZONE ? (mag - HEAD_DEADZONE) / mag : 0;
    const tx = this.offset.x * follow;
    const ty = this.offset.y * follow;
    const s = this._spring;
    headStep(s, this.settled.x - tx, this._vel.x, dt);
    this.settled.x = tx + s.x;
    this._vel.x = s.v;
    headStep(s, this.settled.y - ty, this._vel.y, dt);
    this.settled.y = ty + s.x;
    this._vel.y = s.v;
  }

  /** Start a saccade from wherever the eyes are now. */
  private _saccadeTo(nx: number, ny: number): void {
    const amp = Math.hypot(nx - this.offset.x, ny - this.offset.y);
    this.saccade = amp;
    this._target.set(nx, ny);
    this._from.copy(this.offset);
    this._sacT = 0;
    // Main sequence: a saccade's duration scales with its amplitude. One
    // fixed time constant makes small glances sluggish and large ones snap.
    this._sacDur = 0.026 + amp * 0.24;
  }
}
