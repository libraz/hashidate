import { describe, expect, it } from 'vitest';
import { HopRun } from '../../src/engine/motion/hop-run';

const G = 9.81;
const DT = 1 / 60;
const SPEC = { height: 0.08, count: 1, turn: 0 };

/** Steps until the run lands, returning the frame count. */
function drain(run: HopRun, limit = 10_000): number {
  let n = 0;
  while (run.active && n < limit) {
    run.step(DT, G);
    n++;
  }
  return n;
}

describe('HopRun', () => {
  it('runs one hop and leaves rest values once it lands', () => {
    const run = new HopRun();
    run.start(SPEC, G);
    expect(run.active).toBe(true);
    let peak = 0;
    while (run.active) {
      run.step(DT, G);
      peak = Math.max(peak, run.rise);
    }
    expect(peak).toBeGreaterThan(0);
    expect(run.rise).toBe(0);
    expect(run.load).toBe(0);
  });

  it('queues a run asked for mid-flight and starts it at the landing', () => {
    const solo = new HopRun();
    solo.start(SPEC, G);
    const one = drain(solo);

    const run = new HopRun();
    run.start(SPEC, G);
    run.step(DT, G);
    run.start(SPEC, G);
    expect(drain(run)).toBeGreaterThan(one);
  });

  it('drops the queued run when finished', () => {
    const solo = new HopRun();
    solo.start(SPEC, G);
    const one = drain(solo);

    const run = new HopRun();
    run.start(SPEC, G);
    run.start(SPEC, G);
    run.finish();
    expect(drain(run)).toBe(one);
  });

  it('keeps the hops a turning run needs to face front again', () => {
    const half = new HopRun();
    half.start({ height: 0.08, count: 4, turn: Math.PI }, G);
    half.finish();
    const early = drain(half);

    const full = new HopRun();
    full.start({ height: 0.08, count: 4, turn: Math.PI }, G);
    const all = drain(full);
    // Two half-turn hops close a revolution, so finishing in the first hop ends after two of four.
    expect(early).toBeLessThan(all);
  });
});
