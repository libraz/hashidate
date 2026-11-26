import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHOT_INTERVAL, throttleShots } from '@/panel/preview/shot-drag';
import type { Shot } from '@/protocol';

/** The throttle on shots the panel sends while the pointer is dragging. */

const shot = (yaw: number, pitch: number): Required<Shot> => ({
  frame: 'bust',
  yaw,
  pitch,
  zoom: 1,
});

describe('throttleShots', () => {
  afterEach(() => vi.useRealTimers());

  it('sends the first at once, then at most one per interval, always ending on the last', () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const t = throttleShots(
      (s) => sent.push(s.yaw),
      () => Date.now(),
    );
    t.push(shot(1, 0));
    t.push(shot(2, 0));
    t.push(shot(3, 0));
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(SHOT_INTERVAL);
    expect(sent).toEqual([1, 3]);
    vi.advanceTimersByTime(SHOT_INTERVAL * 3);
    expect(sent).toEqual([1, 3]);
  });

  it('sends nothing after cancel', () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const t = throttleShots(
      (s) => sent.push(s.yaw),
      () => Date.now(),
    );
    t.push(shot(1, 0));
    t.push(shot(2, 0));
    t.cancel();
    vi.advanceTimersByTime(SHOT_INTERVAL * 2);
    expect(sent).toEqual([1]);
  });
});
