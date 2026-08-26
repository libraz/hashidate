import { describe, expect, it } from 'vitest';
import { breathCurve, DEFAULT_VARIATION, saturate, settle, smoothstep } from '@/engine/motion/idle';

/** Sample a curve across a closed interval, endpoints included. */
const sweep = (from: number, to: number, steps: number): number[] =>
  Array.from({ length: steps + 1 }, (_, i) => from + ((to - from) * i) / steps);

describe('breathCurve', () => {
  it('starts and ends at rest, and fills the whole channel in between', () => {
    expect(breathCurve(0)).toBe(0);
    expect(breathCurve(1)).toBeCloseTo(0, 12);
    for (const p of sweep(0, 1, 400)) {
      expect(breathCurve(p)).toBeGreaterThanOrEqual(0);
      expect(breathCurve(p)).toBeLessThanOrEqual(1);
    }
  });

  it('reaches exactly 1 at the top of the inhale', () => {
    const samples = sweep(0, 1, 2000);
    const peak = samples.reduce((best, p) => (breathCurve(p) > breathCurve(best) ? p : best), 0);
    expect(breathCurve(peak)).toBeCloseTo(1, 9);
    expect(peak).toBeCloseTo(0.38, 3);
  });

  it('is continuous where the two halves meet', () => {
    // The peak is a join between two different cosines, not one curve, so a
    // mismatched pair would show up as a step at the top of the breath.
    const before = breathCurve(0.38 - 1e-7);
    const after = breathCurve(0.38 + 1e-7);
    expect(Math.abs(after - before)).toBeLessThan(1e-9);
  });

  it('inhales markedly quicker than it exhales', () => {
    // A symmetric sine is the thing this exists to avoid, so the asymmetry is
    // the property: the rise takes well under half the cycle.
    const samples = sweep(0, 1, 2000);
    const peak = samples.reduce((best, p) => (breathCurve(p) > breathCurve(best) ? p : best), 0);
    expect(peak).toBeLessThan(0.5);
    const ratio = peak / (1 - peak);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(0.8);
  });

  it('is not the symmetric sine it would be if the halves matched', () => {
    const symmetric = (p: number) => 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
    const gap = sweep(0, 1, 200).reduce(
      (worst, p) => Math.max(worst, Math.abs(breathCurve(p) - symmetric(p))),
      0,
    );
    expect(gap).toBeGreaterThan(0.1);
  });

  it('rises without pause to the peak and falls without pause after it', () => {
    const up = sweep(0, 0.38, 200);
    for (let i = 1; i < up.length; i++) {
      expect(breathCurve(up[i])).toBeGreaterThan(breathCurve(up[i - 1]));
    }
    const down = sweep(0.38, 1, 200);
    for (let i = 1; i < down.length; i++) {
      expect(breathCurve(down[i])).toBeLessThan(breathCurve(down[i - 1]));
    }
  });

  it('eases into the top and the bottom rather than cornering', () => {
    const slope = (p: number) => (breathCurve(p + 1e-6) - breathCurve(p - 1e-6)) / 2e-6;
    expect(Math.abs(slope(1e-4))).toBeLessThan(0.05);
    expect(Math.abs(slope(1 - 1e-4))).toBeLessThan(0.05);
  });
});

describe('settle', () => {
  it('is odd, so neither foot is favoured', () => {
    for (const x of sweep(0, 1, 50)) {
      expect(settle(-x)).toBeCloseTo(-settle(x), 15);
    }
    expect(settle(0)).toBe(0);
  });

  it('maps the unit interval onto itself, reaching the ends exactly', () => {
    expect(settle(1)).toBeCloseTo(1, 15);
    expect(settle(-1)).toBeCloseTo(-1, 15);
    for (const x of sweep(-1, 1, 200)) {
      expect(Math.abs(settle(x))).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('is monotone, so weight never reverses within a transfer', () => {
    const xs = sweep(-1, 1, 200);
    for (let i = 1; i < xs.length; i++) {
      expect(settle(xs[i])).toBeGreaterThan(settle(xs[i - 1]));
    }
  });

  it('is far flatter at the extremes than at the crossing', () => {
    // Weight rests on one foot before transferring. The slope at the ends is
    // what "rests" means, and it has to be a small fraction of the slope at
    // the crossing or the pose is still moving when it should be standing.
    const slope = (x: number) => (settle(x + 1e-6) - settle(x - 1e-6)) / 2e-6;
    expect(slope(0)).toBeGreaterThan(2);
    expect(slope(1)).toBeLessThan(0.2);
    expect(slope(1)).toBeLessThan(slope(0) / 10);
  });

  it('holds a sine near its extremes for longer than the sine does', () => {
    // The trapezoid claim, measured: drive both with the same phase and count
    // the fraction of a cycle spent within 10% of full weight.
    const near = (f: (p: number) => number) =>
      sweep(0, 1, 4000).filter((p) => Math.abs(f(p)) > 0.9).length / 4001;
    const raw = (p: number) => Math.sin(2 * Math.PI * p);
    const flattened = (p: number) => settle(Math.sin(2 * Math.PI * p));
    expect(near(flattened)).toBeGreaterThan(near(raw) * 1.5);
  });

  it('never overshoots the sine it flattens', () => {
    for (const x of sweep(0, 1, 100)) {
      expect(settle(x)).toBeGreaterThanOrEqual(x - 1e-12);
    }
  });
});

describe('saturate', () => {
  it('is proportional near the centre, where a clamp would also be', () => {
    expect(saturate(0, 0.3)).toBe(0);
    expect(saturate(0.003, 0.3)).toBeCloseTo(0.003, 6);
    expect(saturate(-0.003, 0.3)).toBeCloseTo(-0.003, 6);
  });

  it('is already compressing at the limit, where a clamp would still be linear', () => {
    // A clamp returns the limit here; this returns tanh(1) of it, so the eye is
    // still moving in the right direction rather than pinned.
    expect(saturate(0.3, 0.3)).toBeCloseTo(0.3 * Math.tanh(1), 12);
    expect(saturate(0.3, 0.3)).toBeLessThan(0.3);
  });

  it('approaches the limit without reaching it', () => {
    // Asymptotic rather than clamped, over the range a gaze channel can ask
    // for. Far past it — beyond about 19 limits — tanh saturates in a double
    // and the distinction stops being representable, which is not a range any
    // eye is driven through.
    const limit = 0.25;
    for (const k of [1, 2, 3, 5, 8, 10]) {
      expect(saturate(k * limit, limit)).toBeLessThan(limit);
      expect(saturate(-k * limit, limit)).toBeGreaterThan(-limit);
    }
    expect(saturate(10 * limit, limit)).toBeGreaterThan(limit * 0.999);
  });

  it('is odd and strictly increasing, so a glance never stalls or reverses', () => {
    const limit = 0.25;
    const xs = sweep(-2, 2, 400);
    for (let i = 1; i < xs.length; i++) {
      expect(saturate(xs[i], limit)).toBeGreaterThan(saturate(xs[i - 1], limit));
    }
    for (const x of xs) expect(saturate(-x, limit)).toBeCloseTo(-saturate(x, limit), 15);
  });

  it('keeps the same shape whatever the limit is', () => {
    for (const limit of [0.05, 0.2, 1, 4]) {
      expect(saturate(limit, limit) / limit).toBeCloseTo(Math.tanh(1), 12);
      expect(Math.abs(saturate(1e3, limit))).toBeLessThanOrEqual(limit);
    }
  });
});

describe('smoothstep', () => {
  it('pins both endpoints and the midpoint', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBe(0.5);
  });

  it('leaves both ends with zero slope, which is what makes it a blend', () => {
    const slope = (x: number) => (smoothstep(x + 1e-6) - smoothstep(x - 1e-6)) / 2e-6;
    expect(Math.abs(slope(0))).toBeLessThan(1e-5);
    expect(Math.abs(slope(1))).toBeLessThan(1e-5);
    expect(slope(0.5)).toBeCloseTo(1.5, 5);
  });

  it('is monotone and symmetric about the midpoint', () => {
    const xs = sweep(0, 1, 200);
    for (let i = 1; i < xs.length; i++) {
      expect(smoothstep(xs[i])).toBeGreaterThan(smoothstep(xs[i - 1]));
    }
    for (const x of xs) expect(smoothstep(1 - x)).toBeCloseTo(1 - smoothstep(x), 12);
  });

  it('lags a linear ramp early and leads it late', () => {
    expect(smoothstep(0.25)).toBeLessThan(0.25);
    expect(smoothstep(0.75)).toBeGreaterThan(0.75);
  });
});

describe('DEFAULT_VARIATION', () => {
  it('stands in for a playing gesture without varying anything', () => {
    expect(DEFAULT_VARIATION.rate).toBe(1);
    expect(DEFAULT_VARIATION.scale).toBe(1);
    expect(Math.abs(DEFAULT_VARIATION.side)).toBe(1);
  });
});
