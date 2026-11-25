import { describe, expect, it } from 'vitest';
import { findSilences } from '@/engine/motion/prosody';

/** An envelope that is silent exactly on the given `[from, to)` spans and loud elsewhere. */
const envelope =
  (silent: Array<[number, number]>) =>
  (s: number): number =>
    silent.some(([a, b]) => s >= a - 1e-9 && s < b - 1e-9) ? 0 : 1;

describe('findSilences', () => {
  it('reports the first silent sample as start and the first sound as end', () => {
    const out = findSilences(envelope([[1, 1.5]]), 3);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBeCloseTo(1, 9);
    expect(out[0].end).toBeCloseTo(1.5, 9);
  });

  it('leaves out a silence at the head of the take', () => {
    expect(findSilences(envelope([[0, 0.5]]), 3)).toEqual([]);
  });

  it('leaves out a silence that runs to the end of the take', () => {
    expect(findSilences(envelope([[2, 3]]), 3)).toEqual([]);
    expect(findSilences(envelope([[2, 9]]), 3)).toEqual([]);
  });

  it('leaves out a silence shorter than an inter-pausal pause', () => {
    expect(findSilences(envelope([[1, 1.15]]), 3)).toEqual([]);
  });

  it('keeps a silence exactly as long as an inter-pausal pause', () => {
    expect(findSilences(envelope([[1, 1.2]]), 3)).toHaveLength(1);
  });

  it('returns several silences in time order', () => {
    const out = findSilences(
      envelope([
        [0.5, 0.8],
        [1.5, 2],
      ]),
      3,
    );
    expect(out.map((o) => o.start)).toEqual([expect.closeTo(0.5, 9), expect.closeTo(1.5, 9)]);
  });
});
