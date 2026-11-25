import { describe, expect, it } from 'vitest';
import { HeadBeats } from '@/engine/motion';

const LONG = 0.1;

/** Pitch per frame over two seconds of a plan with a nod in flight and one placed later. */
function run(step: (beats: HeadBeats) => number): number[] {
  const beats = new HeadBeats();
  beats.start([
    { t: 0.4, amp: 0.1 },
    { t: 1.3, amp: 0.08 },
  ]);
  return Array.from({ length: 2 / LONG }, () => step(beats));
}

describe('HeadBeats / elapsed', () => {
  it('runs the line, spacing and nod clocks on elapsed, not dt', () => {
    const real = run((b) => b.update(LONG));
    expect(real.filter((p) => p !== 0).length).toBeGreaterThan(2);
    expect(run((b) => b.update(1 / 60, LONG))).toEqual(real);
  });
});
