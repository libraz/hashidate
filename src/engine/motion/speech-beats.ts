import type { ArmSlot, Side } from '../types';
import { minJerk } from './timing';

/**
 * The small lift a speaker's forearm and hand give at the head of a phrase.
 *
 * Triggered once per phrase head, never on the envelope's peaks and never at
 * random, so every renderer of the same turn beats on the same mora. Additive
 * on top of the arm blend, at the weight rest still holds, so a gesture that
 * owns the arm silences it and a one-handed gesture leaves it on the free arm.
 * Stepped on the turn's clock, as gestures and nods are.
 */

/** Seconds from trigger to the top of the lift. */
export const BEAT_RISE = 0.16;
/** Seconds from the top back to rest. */
export const BEAT_FALL = 0.38;
/** Peak lift per arm link, rad; the shoulder stays out of it, which would read as a gesture. */
export const BEAT_LIFT: Readonly<Record<ArmSlot, number>> = {
  shoulder: 0,
  upperArm: 0,
  lowerArm: 0.06,
  hand: 0.09,
};
/** Share per side: the right hand leads, the left echoes it. */
export const BEAT_SIDE: Readonly<Record<Side, number>> = { R: 1, L: 0.55 };

export class SpeechBeats {
  /** The pulse, 0..1. */
  value = 0;
  private _t = Number.POSITIVE_INFINITY;
  private _from = 0;

  /** Start a pulse from wherever the last one is, so a retrigger never jumps. */
  trigger(): void {
    this._from = this.value;
    this._t = 0;
  }

  step(elapsed: number): number {
    this._t += elapsed;
    const t = this._t;
    if (t < BEAT_RISE) this.value = this._from + (1 - this._from) * minJerk(t / BEAT_RISE);
    else if (t < BEAT_RISE + BEAT_FALL) this.value = 1 - minJerk((t - BEAT_RISE) / BEAT_FALL);
    else this.value = 0;
    return this.value;
  }

  /** The lift for one arm link this frame, rad. */
  angle(side: Side, slot: ArmSlot): number {
    return this.value * BEAT_LIFT[slot] * BEAT_SIDE[side];
  }
}
