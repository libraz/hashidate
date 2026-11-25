import { describe, expect, it } from 'vitest';
import { fnv1a64, splitmix64, turnRandom } from '@/engine/random';
import { splitmix64 as reference } from '../helpers/director-fixtures';

const take = (draw: () => number, n: number): number[] => Array.from({ length: n }, draw);

describe('engine random', () => {
  it('draws the same sequence as the test splitmix64', () => {
    for (const seed of [0n, 1n, 0x6861_7368_6964_6174n, (1n << 64n) - 1n]) {
      expect(take(splitmix64(seed), 16)).toEqual(take(reference(seed), 16));
    }
  });

  it('hashes with 64-bit FNV-1a over UTF-8', () => {
    expect(fnv1a64('')).toBe(0xcbf2_9ce4_8422_2325n);
    expect(fnv1a64('a')).toBe(0xaf63_dc4c_8601_ec8cn);
    expect(fnv1a64('foobar')).toBe(0x8594_4171_f739_67e8n);
    expect(fnv1a64('é')).not.toBe(fnv1a64('é\u0000'));
  });

  it('seeds a turn stream from the id and the draw site', () => {
    expect(take(turnRandom('q1', 'gesture'), 8)).toEqual(
      take(splitmix64(fnv1a64('q1:gesture')), 8),
    );
    expect(take(turnRandom('q1', 'nod'), 8)).not.toEqual(take(turnRandom('q1', 'gesture'), 8));
    expect(take(turnRandom('q2', 'nod'), 8)).not.toEqual(take(turnRandom('q1', 'nod'), 8));
  });
});
