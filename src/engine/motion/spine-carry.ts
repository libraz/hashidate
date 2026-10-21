import type { Rig } from '../rig';
import type { Pose, SpineOffsets } from '../types';
import { SPINE_SLOTS } from './custom';

/** One gesture on its way out, as far as the spine can tell. */
type SpineFade = { pose: Pose | null; spineWeight: number; spineStart: number };

/**
 * Add `s` at weight `w` into a flat per-slot spine sum, widening `lo`/`hi` to
 * span its authored values. Returns the slots it wrote as a bit mask.
 */
const addSpine = (
  sum: Float64Array,
  lo: Float64Array,
  hi: Float64Array,
  s: SpineOffsets | undefined,
  w: number,
): number => {
  let mask = 0;
  for (let i = 0; s && i < SPINE_SLOTS.length; i++) {
    const o = s[SPINE_SLOTS[i]];
    if (!o) continue;
    for (let j = 0; j < 3; j++) {
      const k = i * 3 + j;
      sum[k] += o[j] * w;
      lo[k] = Math.min(lo[k], o[j]);
      hi[k] = Math.max(hi[k], o[j]);
    }
    mask |= 1 << i;
  }
  return mask;
};

/**
 * The spine composite of the current and outgoing gestures, and the cubic
 * Hermite carry that eases a cut weight rate out after a play or stop.
 * Composes into flat per-slot arrays and writes the result to the rig as offsets.
 */
export class SpineCarry {
  constructor(private readonly rig: Rig) {}

  // A play or stop restarts every spine weight at zero rate. The rate it cut is
  // carried on top of the composite and eased out over the new fade: a cubic
  // Hermite from the displayed residual and its rate, to rest at zero rate.
  private readonly _spineCarryFrom = new Float64Array(SPINE_SLOTS.length * 3);
  private readonly _spineCarryRate = new Float64Array(SPINE_SLOTS.length * 3);
  private _spineCarryTime = 0;
  private _spineCarryDuration = 0;
  /** Set by a release: the carry may slow the way to rest, never reverse or pass it. */
  private _spineCarryRelease = false;
  /** The spine composite, what was displayed, and the current pose's spine, as of the last update. */
  private readonly _spineSum = new Float64Array(SPINE_SLOTS.length * 3);
  /** Per channel, the span of rest and every authored pose on screen; the carry stays inside it. */
  private readonly _spineLo = new Float64Array(SPINE_SLOTS.length * 3);
  private readonly _spineHi = new Float64Array(SPINE_SLOTS.length * 3);
  private readonly _spineShown = new Float64Array(SPINE_SLOTS.length * 3);
  private _curSpine: SpineOffsets | undefined = undefined;

  /** Restart the carry at the last compose's displayed state; see `Body.captureSpineCarry`. */
  capture(
    release: boolean,
    blendRate: number,
    fadeRate: number,
    fading: ReadonlyArray<SpineFade>,
  ): void {
    const T = this._spineCarryDuration;
    const s = T > 0 ? Math.min(1, this._spineCarryTime / T) : 1;
    for (let i = 0; i < SPINE_SLOTS.length; i++) {
      const slot = SPINE_SLOTS[i];
      for (let j = 0; j < 3; j++) {
        const k = i * 3 + j;
        let rate =
          s < 1
            ? (this._spineCarryFrom[k] * 6 * s * (s - 1)) / T +
              this._spineCarryRate[k] * (1 - s) * (1 - 3 * s)
            : 0;
        rate += (this._curSpine?.[slot]?.[j] ?? 0) * blendRate;
        for (const f of fading) rate += (f.pose?.spine?.[slot]?.[j] ?? 0) * f.spineStart * fadeRate;
        const shown = this._spineShown[k];
        if (release && rate * shown >= 0) rate = 0;
        this._spineCarryFrom[k] = shown - this._spineSum[k];
        this._spineCarryRate[k] = rate;
      }
    }
    this._spineCarryTime = 0;
    this._spineCarryRelease = release;
  }

  /** Set how long the carry takes to ease out. */
  retime(seconds: number): void {
    this._spineCarryDuration = seconds;
  }

  /** Compose the spine for this frame and add it to the rig. */
  compose(
    dt: number,
    fading: ReadonlyArray<SpineFade>,
    current: SpineOffsets | undefined,
    blend: number,
  ): void {
    // Every gesture slot contributes to the spine; the outgoing ones are fading.
    const sum = this._spineSum.fill(0);
    const lo = this._spineLo.fill(0);
    const hi = this._spineHi.fill(0);
    let written = 0;
    for (const f of fading) written |= addSpine(sum, lo, hi, f.pose?.spine, f.spineWeight);
    written |= addSpine(sum, lo, hi, current, blend);
    this._curSpine = current;
    this._spineCarryTime += dt;
    const carryT = this._spineCarryDuration;
    const cs = carryT > 0 ? Math.min(1, this._spineCarryTime / carryT) : 1;
    const h00 = (1 + 2 * cs) * (1 - cs) * (1 - cs);
    const h10 = cs * (1 - cs) * (1 - cs) * carryT;
    const shown = this._spineShown;
    for (let i = 0; i < SPINE_SLOTS.length; i++) {
      for (let k = i * 3; k < i * 3 + 3; k++) {
        const c = sum[k];
        if (cs >= 1) {
          shown[k] = c;
          continue;
        }
        const carried = c + this._spineCarryFrom[k] * h00 + this._spineCarryRate[k] * h10;
        let floor = Math.min(lo[k], c);
        let ceil = Math.max(hi[k], c);
        if (this._spineCarryRelease) {
          floor = Math.max(floor, Math.min(0, shown[k], c));
          ceil = Math.min(ceil, Math.max(0, shown[k], c));
        }
        shown[k] = Math.min(Math.max(carried, floor), ceil);
      }
      const x = i * 3;
      if (written & (1 << i) || shown[x] || shown[x + 1] || shown[x + 2])
        this.rig.addOffset(SPINE_SLOTS[i], shown[x], shown[x + 1], shown[x + 2]);
    }
  }
}
