import { describe, expect, it } from 'vitest';
import { Gaze, HEAD_OMEGA } from '@/engine/motion/gaze';

/**
 * The head settling after the eyes, as a function of the display.
 *
 * It was integrated with one explicit step per frame, so the overshoot a
 * viewer saw depended on the monitor: the figures were tuned at 50 Hz, and a
 * 144 Hz panel or a dropped-frame stutter played a different head. Every other
 * follower in the body layer steps in closed form; this one now does too.
 */

/** Hold the eyes off-centre and play the head toward them for `seconds`. */
function settle(dt: number, seconds: number): number[] {
  const gaze = new Gaze({ random: () => 0.5 });
  // Park the wander, so nothing moves the eyes while the head settles.
  (gaze as unknown as { _timer: number })._timer = Number.POSITIVE_INFINITY;
  gaze.offset.set(0.3, -0.12);
  const out: number[] = [];
  const n = Math.round(seconds / dt);
  for (let i = 1; i <= n; i++) {
    gaze.update(dt, i * dt);
    out.push(gaze.settled.x, gaze.settled.y);
  }
  return out;
}

/** The step this replaced, verbatim, for the tuned rate it must still match. */
function explicit(dt: number, seconds: number): number[] {
  const ZETA = 0.72;
  const tx = 0.3 * ((Math.hypot(0.3, 0.12) - 0.05) / Math.hypot(0.3, 0.12));
  let x = 0;
  let v = 0;
  const out: number[] = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    v += (-2 * ZETA * HEAD_OMEGA * v - HEAD_OMEGA * HEAD_OMEGA * (x - tx)) * dt;
    x += v * dt;
    out.push(x);
  }
  return out;
}

describe('head settle', () => {
  it('plays the same head whatever the frame rate', () => {
    const base = settle(1 / 7200, 3);
    for (const hz of [20, 30, 50, 60, 144]) {
      const run = settle(1 / hz, 3);
      const every = 7200 / hz;
      for (let i = 0; i < run.length / 2; i++) {
        const j = Math.round((i + 1) * every) - 1;
        expect(run[2 * i]).toBeCloseTo(base[2 * j], 9);
        expect(run[2 * i + 1]).toBeCloseTo(base[2 * j + 1], 9);
      }
    }
  });

  it('keeps the response it was tuned with at 50 Hz', () => {
    const run = settle(1 / 50, 3);
    const ref = explicit(1 / 50, 3);
    const target = ref.at(-1) ?? 0;
    for (let i = 0; i < ref.length; i++) {
      expect(Math.abs(run[2 * i] - ref[i])).toBeLessThan(Math.abs(target) * 0.02);
    }
  });

  it('still overshoots slightly, as a head does', () => {
    const run = settle(1 / 60, 3);
    const tx = 0.3 * ((Math.hypot(0.3, 0.12) - 0.05) / Math.hypot(0.3, 0.12));
    const xs = run.filter((_, i) => i % 2 === 0);
    const peak = Math.max(...xs);
    expect(peak).toBeGreaterThan(tx * 1.005);
    expect(peak).toBeLessThan(tx * 1.1);
  });
});
