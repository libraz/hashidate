import { describe, expect, it } from 'vitest';
import { GESTURES } from '@/engine/motion';
import { DT, harness } from './harness';

/**
 * Lids carried by a gesture's own envelope: they close as it arrives and open
 * as it leaves, with nothing to release.
 */

const NOMINAL = { random: () => 0.5 };

function start(id: string) {
  const h = harness(0, NOMINAL);
  h.body.update(DT);
  h.body.play(id, 'R');
  const step = (seconds: number, each?: (lids: number) => void) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      h.rig.reset();
      h.body.update(DT);
      each?.(h.body.lids);
    }
  };
  return { h, step };
}

describe('Body / lids', () => {
  it('is zero with no gesture', () => {
    const h = harness(0, NOMINAL);
    h.body.update(DT);
    expect(h.body.lids).toBe(0);
  });

  it('rises over the entrance, holds, and returns to zero with no release', () => {
    const { h, step } = start('think');
    const lids = GESTURES.think.lids ?? 0;
    expect(lids).toBeGreaterThan(0);
    let peak = 0;
    step(0.1);
    expect(h.body.lids).toBeLessThan(lids * 0.5);
    step(2, (l) => {
      peak = Math.max(peak, l);
    });
    expect(h.body.lids).toBeCloseTo(lids, 2);
    step(10, (l) => {
      peak = Math.max(peak, l);
    });
    expect(peak).toBeLessThanOrEqual(lids + 1e-9);
    expect(h.body.gesture).toBeNull();
    expect(h.body.lids).toBe(0);
  });

  it('hands the lids into the fade when another gesture plays over them', () => {
    const { h, step } = start('think');
    step(2);
    const think = GESTURES.think.lids ?? 0;
    const yawn = GESTURES.yawn.lids ?? 0;
    h.body.play('yawn', 'R');
    let worst = 0;
    step(3, (l) => {
      worst = Math.max(worst, l);
    });
    expect(worst).toBeLessThanOrEqual(Math.max(think, yawn) + 1e-9);
    // Not dropped on the switch frame either.
    const again = start('think');
    again.step(2);
    again.h.body.play('yawn', 'R');
    again.h.rig.reset();
    again.h.body.update(DT);
    expect(again.h.body.lids).toBeGreaterThan(think * 0.8);
  });

  it("holds a sustained gesture's lids until it is stopped, then fades them", () => {
    const { h, step } = start('doze');
    const lids = GESTURES.doze.lids ?? 0;
    step(6);
    expect(h.body.lids).toBeCloseTo(lids, 2);
    step(4);
    expect(h.body.lids).toBeCloseTo(lids, 2);
    h.body.stopGesture();
    step(0.5);
    expect(h.body.lids).toBeLessThan(lids);
    expect(h.body.lids).toBeGreaterThan(0);
    step(5);
    expect(h.body.lids).toBe(0);
  });
});
