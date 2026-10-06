import { describe, expect, it } from 'vitest';
import { DT, type Harness, harness } from './harness';

/**
 * A hop asked for while one is in flight.
 *
 * The rise goes straight into the hips with nothing chasing it, so a request
 * that restarted the arc would drop the whole skeleton to rest in one frame.
 */

function hipsY(h: Harness): number {
  const hips = h.profile.bones.hips;
  if (!hips) throw new Error('synthetic rig has no hips');
  return hips.position.y;
}

function run(h: Harness, frames: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    h.rig.reset();
    h.body.update(DT);
    out.push(hipsY(h));
  }
  return out;
}

const maxStep = (xs: number[]): number =>
  Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i])));

describe('hop retrigger', () => {
  it('keeps the hips continuous when a hop is asked for mid-flight', () => {
    const h = harness();
    const rest = run(h, 2).at(-1) ?? 0;
    h.body.hop({ height: 0.08 });
    const before = run(h, 30);
    // Airborne, so a restart would have somewhere to fall from.
    expect((before.at(-1) ?? 0) - rest).toBeGreaterThan(0.02);
    const alone = harness();
    run(alone, 2);
    alone.body.hop({ height: 0.08 });
    const single = maxStep([rest, ...run(alone, 120)]);
    h.body.hop({ height: 0.08 });
    const after = run(h, 180);
    const all = [rest, ...before, ...after];
    // No frame moves the hips further than the hop's own fastest frame does.
    expect(maxStep(all)).toBeLessThanOrEqual(single + 1e-9);
    // The second hop still happens: the hips leave rest again after landing.
    const landed = after.findIndex((y) => Math.abs(y - rest) < 1e-9);
    expect(landed).toBeGreaterThan(0);
    expect(Math.max(...after.slice(landed)) - rest).toBeGreaterThan(0.02);
  });

  it('drops a queued hop when the run is finished early', () => {
    const h = harness();
    run(h, 2);
    h.body.hop({ height: 0.08 });
    run(h, 10);
    h.body.hop({ height: 0.08 });
    h.body.finishHop();
    run(h, 180);
    expect(h.body.jumping).toBe(false);
  });
});
