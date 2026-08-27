/**
 * Blink layer.
 *
 * A self-contained state machine: it knows nothing about the director, the
 * profile or three, and drives itself off a dt and two booleans. Everything it
 * produces is one number — how shut the lids are this frame — which the caller
 * routes to whatever the avatar calls its blink shapes.
 */

/**
 * Blink shape. Closing takes about a third of the blink and opening the rest;
 * a symmetric pulse reads as a flutter rather than as a blink.
 */
export const BLINK_CLOSE = 0.32;
export const blinkCurve = (u: number): number =>
  u < BLINK_CLOSE
    ? Math.sin((u / BLINK_CLOSE) * Math.PI * 0.5)
    : Math.cos(((u - BLINK_CLOSE) / (1 - BLINK_CLOSE)) * Math.PI * 0.5) ** 0.75;

// A blink cannot follow another this soon. Without the floor, a saccade landing
// on the frame after a blink completes fires the next one immediately and the
// eyes flutter.
export const MIN_BLINK_GAP = 0.55;

/** What the caller knows and the blink does not. */
export interface BlinkContext {
  /** Drives the rate: blinks come faster while speaking than while listening. */
  speaking: boolean;
  /**
   * Hold the eyes open. Surprise does this — blinking through it looks wrong —
   * but which emotions count is the director's call, because it owns the
   * emotion vector. It arrives here already decided.
   */
  suppressed: boolean;
}

export interface BlinkOptions {
  /** Injectable only so a test can step the machine deterministically. */
  random?: () => number;
}

export class Blink {
  /** Off holds the lids open and abandons any blink in flight. */
  enabled = true;

  /**
   * How far the lids sit shut regardless of the rhythm, 0..1. Drowsiness.
   *
   * A floor rather than a mode: at 0.4 the eyes are heavy and still blink, at
   * 0.95 they are shut and the blinks underneath make no difference. That is
   * the same continuum a face actually moves along on the way to sleep, and it
   * means the caller does not have to decide which of the two it is asking for.
   *
   * It outranks `suppressed` — that flag is the director noticing surprise, and
   * a caller that has explicitly said the eyes are closing knows better. It does
   * not outrank `enabled`, which is a debug kill switch for the whole layer.
   */
  droop = 0;

  readonly #random: () => number;
  #weight = 0;
  /** Progress through the current blink, -1 = none. */
  #t = -1;
  #dur = 0.13;
  #depth = 1;
  /** Seconds since the last blink finished. */
  #since = 0;
  #next = 2.5;
  #pendingDouble = 0;

  constructor({ random = Math.random }: BlinkOptions = {}) {
    this.#random = random;
  }

  /** Current blink weight, 0..1. */
  get weight(): number {
    return this.#weight;
  }

  /** Whether a blink is in flight. */
  get closing(): boolean {
    return this.#t >= 0;
  }

  /**
   * Ask for a blink now. Dropped, not deferred, if one is already in flight or
   * the minimum gap has not elapsed.
   *
   * Dropping is the right answer for the only caller there is: the director
   * fires this off a large gaze shift, because blinks cluster around saccades in
   * life. A request that arrives too soon has no moment of its own to belong to,
   * and holding it to fire later would put a blink at an instant nothing
   * motivated — which is exactly the mechanical tell the clustering exists to
   * avoid. The next saccade asks again.
   */
  trigger(): void {
    if (this.#t >= 0 || this.#since < MIN_BLINK_GAP) return;
    this.#start();
  }

  /** Advance one frame. Returns the weight, which `weight` also reports. */
  update(dt: number, ctx: BlinkContext): number {
    if (!this.enabled) {
      this.#weight = 0;
      this.#t = -1;
      return this.#weight;
    }

    // Surprise holds the eyes open; blinking through it looks wrong.
    if (ctx.suppressed) {
      this.#weight = this.#floor();
      this.#t = -1;
      return this.#weight;
    }

    if (this.#t < 0) {
      this.#since += dt;
      if (this.#pendingDouble > 0) {
        this.#pendingDouble -= dt;
        if (this.#pendingDouble <= 0) this.#start(0.8, false);
      } else if (this.#since >= this.#next) {
        this.#start();
        // Blink rate rises while speaking and drops while listening. A constant
        // rate averages out to something subtly lifeless no matter what value
        // it is set to.
        this.#next = ctx.speaking ? 2.0 + this.#random() * 3.0 : 2.9 + this.#random() * 4.5;
      }
    }

    if (this.#t < 0) {
      this.#weight = this.#floor();
      return this.#weight;
    }

    this.#t += dt / this.#dur;
    if (this.#t >= 1) {
      this.#t = -1;
      this.#weight = this.#floor();
      this.#since = 0;
      return this.#weight;
    }

    // The blink rides on top of the droop rather than replacing it: a heavy lid
    // that snaps wide open to blink and settles back is the one thing worse
    // than not blinking at all. Taking the larger of the two closes the rest of
    // the way and returns to where it was.
    this.#weight = Math.max(this.#floor(), blinkCurve(this.#t) * this.#depth);
    return this.#weight;
  }

  #floor(): number {
    return Math.min(1, Math.max(0, this.droop));
  }

  /**
   * Begin a blink. Duration and depth vary per blink: one that is always the
   * same length and always closes fully is a tell nearly as strong as no blink
   * at all. Real blinks also arrive in pairs now and then.
   */
  #start(depth = 1, allowDouble = true): void {
    this.#t = 0;
    // 160-260 ms end to end, which puts the closing phase around 50-85 ms and
    // the opening around 110-175 ms. Shorter than this and the lid reads as a
    // flicker rather than as a blink, however correct the curve is.
    this.#dur = 0.16 + this.#random() * 0.1;
    this.#depth = depth * (0.86 + this.#random() * 0.14);
    this.#pendingDouble = allowDouble && this.#random() < 0.12 ? 0.16 + this.#random() * 0.12 : 0;
  }
}
