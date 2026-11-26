import { describe, expect, it } from 'vitest';
import { angleFrom, isScaleFactor, SCALE_BY_LIMITS } from '@/mascot/limits';

describe('a size factor a window may ask for', () => {
  it('takes both ends of the range and what lies between', () => {
    expect(isScaleFactor(SCALE_BY_LIMITS.min)).toBe(true);
    expect(isScaleFactor(SCALE_BY_LIMITS.max)).toBe(true);
    expect(isScaleFactor(0.5)).toBe(true);
    expect(isScaleFactor(2)).toBe(true);
    expect(isScaleFactor(1)).toBe(true);
  });

  it('refuses what is outside, not finite or not a number', () => {
    for (const bad of [
      0,
      -0,
      -1,
      0.4999,
      2.0001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '1',
      null,
      undefined,
      {},
    ]) {
      expect(isScaleFactor(bad), String(bad)).toBe(false);
    }
  });
});

describe('an angle from two numbers', () => {
  it('returns both when both are finite, without normalising them', () => {
    expect(angleFrom(10, -5)).toEqual({ yaw: 10, pitch: -5 });
    expect(angleFrom(270, 90)).toEqual({ yaw: 270, pitch: 90 });
  });

  it('returns null unless both are finite numbers', () => {
    for (const [yaw, pitch] of [
      [Number.NaN, 0],
      [0, Number.NaN],
      [Number.POSITIVE_INFINITY, 0],
      [0, Number.NEGATIVE_INFINITY],
      [undefined, 0],
      [0, undefined],
      ['10', 0],
      [0, null],
    ]) {
      expect(angleFrom(yaw, pitch), `${String(yaw)},${String(pitch)}`).toBeNull();
    }
  });
});
