import { describe, expect, it } from 'vitest';
import { smoothstep } from '@/engine/motion/idle';
import { FINGER_ONSET, LINK_ONSET, minJerk, onset, reachEnvelope } from '@/engine/motion/timing';

/**
 * The time course of a deliberate movement.
 *
 * Everything here is a shape, and the shape is the whole content — the reason
 * this layer exists is that two curves with the same endpoints and the same
 * monotonicity can still read as a person and as a machine. So the tests are
 * about derivatives and about where the mass of the movement sits, not about
 * particular values.
 */

const sweep = (from: number, to: number, steps: number): number[] =>
  Array.from({ length: steps + 1 }, (_, i) => from + ((to - from) * i) / steps);

/** Central differences, wide enough to be stable in double precision. */
const d1 = (f: (x: number) => number, x: number, h = 1e-4): number =>
  (f(x + h) - f(x - h)) / (2 * h);
const d2 = (f: (x: number) => number, x: number, h = 1e-3): number =>
  (f(x + h) - 2 * f(x) + f(x - h)) / (h * h);

describe('minJerk', () => {
  it('runs from rest to rest across the unit interval', () => {
    expect(minJerk(0)).toBe(0);
    expect(minJerk(1)).toBe(1);
    expect(minJerk(0.5)).toBeCloseTo(0.5, 12);
  });

  it('clamps rather than extrapolating', () => {
    // Callers hand it a phase that has been offset by an onset delay, which
    // runs below zero by construction. A quintic left to extrapolate there
    // goes to large numbers fast, and the weight it produces is applied to a
    // direction blend that has no reason to survive it.
    expect(minJerk(-3)).toBe(0);
    expect(minJerk(-1e-9)).toBe(0);
    expect(minJerk(2)).toBe(1);
  });

  it('is symmetric about the halfway point', () => {
    for (const x of sweep(0, 1, 200)) {
      expect(minJerk(1 - x)).toBeCloseTo(1 - minJerk(x), 12);
    }
  });

  it('rises without pause', () => {
    const xs = sweep(0, 1, 500);
    for (let i = 1; i < xs.length; i++) {
      expect(minJerk(xs[i])).toBeGreaterThanOrEqual(minJerk(xs[i - 1]));
    }
  });

  it('starts and stops with no velocity and no acceleration', () => {
    // The property that separates it from smoothstep, and the reason for the
    // change: smoothstep also arrives at rest, but its acceleration steps from
    // zero to a finite value at each end. The corner that produces is what the
    // eye reads as machine-driven, whatever the easing does in between.
    // Sampled off the bare polynomial, not off `minJerk`: the clamp makes one
    // side of a central difference at an endpoint flat by construction, which
    // would report a corner that the curve itself does not have.
    const inner = (x: number) => x * x * x * (10 + x * (-15 + 6 * x));
    for (const end of [0, 1]) {
      expect(Math.abs(d1(inner, end, 1e-3))).toBeLessThan(1e-4);
      expect(Math.abs(d2(inner, end, 1e-3))).toBeLessThan(1e-2);
    }
    const step = (x: number) => x * x * (3 - 2 * x);
    expect(Math.abs(d2(step, 0, 1e-3))).toBeGreaterThan(1);
  });

  it('carries more of the movement in the middle than smoothstep does', () => {
    // Sharper peak velocity, flatter tails: the bell that a reach actually has.
    expect(d1(minJerk, 0.5)).toBeGreaterThan(d1(smoothstep, 0.5));
    expect(minJerk(0.15)).toBeLessThan(smoothstep(0.15));
    expect(minJerk(0.85)).toBeGreaterThan(smoothstep(0.85));
  });
});

describe('reachEnvelope', () => {
  it('runs from rest to rest and lands exactly on the pose', () => {
    expect(reachEnvelope(0)).toBe(0);
    expect(reachEnvelope(1)).toBe(1);
    expect(reachEnvelope(-2)).toBe(0);
    expect(reachEnvelope(4)).toBe(1);
  });

  it('goes past the pose once and settles back onto it', () => {
    const xs = sweep(0, 1, 2000);
    const peak = xs.reduce((best, x) => (reachEnvelope(x) > reachEnvelope(best) ? x : best), 0);
    const over = reachEnvelope(peak) - 1;
    expect(over).toBeGreaterThan(0.01);
    // Past roughly an eighth it stops reading as a limb with mass and starts
    // reading as a bounce, which is a cartoon convention and a different thing.
    expect(over).toBeLessThan(0.12);
    // One excursion, not a ring: strictly up to the peak, strictly down after.
    const up = sweep(0, peak, 300);
    for (let i = 1; i < up.length; i++) {
      expect(reachEnvelope(up[i])).toBeGreaterThan(reachEnvelope(up[i - 1]));
    }
    const down = sweep(peak, 1, 300);
    for (let i = 1; i < down.length; i++) {
      expect(reachEnvelope(down[i])).toBeLessThan(reachEnvelope(down[i - 1]));
    }
  });

  it('carries the correction in the last part of the entrance', () => {
    // The primary submovement does the travelling; what is left is a small
    // late adjustment. If the peak sits near the middle it is not a correction,
    // it is a swing.
    const xs = sweep(0, 1, 2000);
    const peak = xs.reduce((best, x) => (reachEnvelope(x) > reachEnvelope(best) ? x : best), 0);
    expect(peak).toBeGreaterThan(0.6);
    expect(peak).toBeLessThan(0.9);
  });

  it('joins its two halves without a seam', () => {
    // Both submovements are minimum-jerk, so the join has matching value,
    // velocity and acceleration. Anything else there puts a corner exactly
    // where the eye is already watching for the arrival.
    const xs = sweep(0.5, 0.95, 900);
    let worst = 0;
    for (let i = 1; i < xs.length; i++) {
      worst = Math.max(worst, Math.abs(d1(reachEnvelope, xs[i]) - d1(reachEnvelope, xs[i - 1])));
    }
    expect(worst).toBeLessThan(0.5);
  });
});

describe('onset', () => {
  it('leaves a link with no delay alone', () => {
    for (const x of sweep(0, 1, 50)) expect(onset(x, 0)).toBe(x);
  });

  it('starts a delayed link at its delay and finishes it with the rest', () => {
    expect(onset(0.2, 0.2)).toBeCloseTo(0, 12);
    expect(onset(1, 0.2)).toBeCloseTo(1, 12);
    // Before it sets out, so the envelope clamps it away.
    expect(onset(0.1, 0.2)).toBeLessThan(0);
  });

  it('makes a delayed link travel faster over its shorter window', () => {
    const slope = (delay: number) =>
      (minJerk(onset(0.6, delay)) - minJerk(onset(0.55, delay))) / 0.05;
    expect(slope(0.2)).toBeGreaterThan(slope(0));
  });
});

describe('onset table', () => {
  it('runs outward along the limb', () => {
    expect(LINK_ONSET.shoulder).toBe(0);
    expect(LINK_ONSET.upperArm).toBeGreaterThan(LINK_ONSET.shoulder);
    expect(LINK_ONSET.lowerArm).toBeGreaterThan(LINK_ONSET.upperArm);
    expect(LINK_ONSET.hand).toBeGreaterThan(LINK_ONSET.lowerArm);
    expect(FINGER_ONSET).toBeGreaterThan(LINK_ONSET.hand);
  });

  it('leaves every link most of the entrance to move in', () => {
    // A delay near 1 is not a stagger, it is a link that does not move until
    // the gesture is over and then snaps.
    for (const delay of [...Object.values(LINK_ONSET), FINGER_ONSET]) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(0.4);
    }
  });
});
