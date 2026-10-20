import { describe, expect, it } from 'vitest';
import { fill } from '@/ui/Slider';

/**
 * The lit stretch of a fader's track.
 *
 * Anchored at zero for a signed range and at the bottom otherwise, so a fader
 * left on its anchor is the one with no fill.
 */
describe('the fader fill', () => {
  it('runs from the bottom of an unsigned range', () => {
    expect(fill(0, 0, 1)).toEqual({ from: 0, to: 0 });
    expect(fill(0.25, 0, 1)).toEqual({ from: 0, to: 0.25 });
    expect(fill(1, 0, 1)).toEqual({ from: 0, to: 1 });
  });

  it('runs from zero either way in a signed range', () => {
    expect(fill(0, -12, 12)).toEqual({ from: 0.5, to: 0.5 });
    expect(fill(6, -12, 12)).toEqual({ from: 0.5, to: 0.75 });
    expect(fill(-6, -12, 12)).toEqual({ from: 0.25, to: 0.5 });
  });

  it('runs from the bottom of a range that only reaches zero', () => {
    // A threshold in dB: zero is the top, not an anchor in the middle.
    expect(fill(-55, -80, 0)).toEqual({ from: 0, to: 0.3125 });
  });

  it('clamps a value outside the range to its ends', () => {
    expect(fill(2, 0, 1)).toEqual({ from: 0, to: 1 });
    expect(fill(-20, -12, 12)).toEqual({ from: 0, to: 0.5 });
  });

  it('lights nothing on a range with no length', () => {
    expect(fill(1, 1, 1)).toEqual({ from: 0, to: 0 });
  });
});

describe('the fader fill with a declared rest', () => {
  it('runs from the rest either way, and lights nothing on it', () => {
    // A multiplier over 0..2: 1 changes nothing.
    expect(fill(1, 0, 2, 1)).toEqual({ from: 0.5, to: 0.5 });
    expect(fill(1.5, 0, 2, 1)).toEqual({ from: 0.5, to: 0.75 });
    expect(fill(0.5, 0, 2, 1)).toEqual({ from: 0.25, to: 0.5 });
  });

  it('outranks zero inside a signed range', () => {
    expect(fill(1, -1, 3, 1)).toEqual({ from: 0.5, to: 0.5 });
  });
});
