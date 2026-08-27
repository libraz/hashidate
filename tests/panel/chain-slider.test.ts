import { describe, expect, it } from 'vitest';
import { shouldAdopt } from '@/panel/voice/ChainSlider';

/**
 * When a polled report is allowed to move a control the operator is dragging.
 *
 * The two failures this sits between are both real and both were the reason it
 * exists. Adopt too eagerly and the handle snaps back under the finger every
 * 500 ms, because the report is still echoing the value from two drags ago.
 * Adopt too reluctantly and loading a preset leaves twenty sliders sitting where
 * they were, describing a chain the renderer is no longer running.
 */

describe('shouldAdopt', () => {
  it('follows the report when nothing has been sent', () => {
    expect(shouldAdopt(0.5, null, 0.01)).toBe(true);
  });

  it('ignores the echo of the value it just sent', () => {
    // The common case: the poll catches up to a drag already in progress.
    expect(shouldAdopt(0.7, 0.7, 0.01)).toBe(false);
  });

  it('ignores an echo that lost precision on the round trip', () => {
    // 0.7 through JSON and a 32-bit float in the processor. Compared exactly,
    // every echo would read as a change and drop the drag.
    expect(shouldAdopt(0.699999988079071, 0.7, 0.01)).toBe(false);
    expect(shouldAdopt(1.1799999475479126, 1.18, 0.01)).toBe(false);
  });

  it('adopts a value the renderer changed on its own', () => {
    // A preset was loaded, or another surface moved it. The local override is
    // now describing a chain nothing is running.
    expect(shouldAdopt(0.2, 0.7, 0.01)).toBe(true);
  });

  it('adopts a value the renderer clamped', () => {
    // The panel does not know every processor's range, so a clamp arrives as a
    // report that disagrees — and it has to win, or the slider claims a setting
    // that was refused.
    expect(shouldAdopt(-12, -20, 0.5)).toBe(true);
  });

  it('scales its tolerance with the step, not with the value', () => {
    // A half-semitone step tolerates a hundredth; a hundredth step does not
    // tolerate a half.
    expect(shouldAdopt(3.2, 3.0, 0.5)).toBe(false);
    expect(shouldAdopt(3.2, 3.0, 0.01)).toBe(true);
  });

  it('does not treat every echo as a change when the step is zero', () => {
    expect(shouldAdopt(0.7, 0.7, 0)).toBe(false);
    expect(shouldAdopt(0.8, 0.7, 0)).toBe(true);
  });
});
