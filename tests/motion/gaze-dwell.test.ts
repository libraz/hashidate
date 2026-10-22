import { describe, expect, it } from 'vitest';
import { speechDwell } from '@/engine/motion/gaze';

const N = 10000;

/** Mean of `speechDwell` over the midpoints of an N-cell grid on r in (0, 1). */
function gridMean(back: boolean): number {
  let sum = 0;
  for (let i = 0; i < N; i++) sum += speechDwell(back, (i + 0.5) / N);
  return sum / N;
}

describe('speechDwell', () => {
  it('averages 2.99 s on the camera', () => {
    expect(Math.abs(gridMean(true) - 2.99) / 2.99).toBeLessThan(0.01);
  });

  it('averages 0.924 s away from it', () => {
    expect(Math.abs(gridMean(false) - 0.924) / 0.924).toBeLessThan(0.01);
  });

  it('is finite and clamped at r = 0', () => {
    expect(speechDwell(true, 0)).toBe(0.5);
    expect(speechDwell(false, 0)).toBe(0.25);
  });
});
