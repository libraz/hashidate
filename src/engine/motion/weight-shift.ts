import { minJerk } from './timing';

/**
 * The standing weight, settled on one foot and then carried to the other.
 *
 * A dwell of drawn length, then a minimum-jerk transfer to the opposite side,
 * so the weight rests and leaves at zero speed and the rhythm never repeats.
 * Only the dwell varies: the transfer's speed and the ±1 swing match the sine
 * this replaces, which were set by eye. Free-running, on the frame clock.
 */

/** Dwell on one foot, seconds: `DWELL_MIN` plus up to `DWELL_SPAN`. */
export const DWELL_MIN = 1.5;
export const DWELL_SPAN = 4.6;
/** Transfer between feet, seconds; 10→90 % takes 50.7 % of it, centred on the old sine's 3.3 s. */
export const TRANSFER_MIN = 5.8;
export const TRANSFER_SPAN = 1.4;

export class WeightShift {
  /** Where the weight is, -1..1. */
  value = 0;
  from = 0;
  to = 0;
  phase: 'dwell' | 'transfer' = 'dwell';
  timer = 0;
  /** Length of the current phase, seconds; negative until the first dwell is drawn. */
  length = -1;

  step(dt: number, random: () => number): number {
    if (this.length < 0) this.length = DWELL_MIN + random() * DWELL_SPAN;
    this.timer += dt;
    while (this.timer >= this.length) {
      this.timer -= this.length;
      if (this.phase === 'dwell') {
        this.phase = 'transfer';
        this.from = this.value;
        // The first transfer leaves the centre toward +1, as the sine did.
        this.to = this.to > 0 ? -1 : 1;
        this.length = TRANSFER_MIN + random() * TRANSFER_SPAN;
      } else {
        this.phase = 'dwell';
        this.value = this.to;
        this.length = DWELL_MIN + random() * DWELL_SPAN;
      }
    }
    if (this.phase === 'transfer') {
      this.value = this.from + (this.to - this.from) * minJerk(this.timer / this.length);
    }
    return this.value;
  }
}
