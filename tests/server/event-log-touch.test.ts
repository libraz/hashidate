import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@/protocol';
import { Hub } from '@/server/hub';
import { EPOCH_MS } from './hub/fixtures';

/** Touch events name no turn, so two renderers or two taps never read as an echo. */

let hub: Hub;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH_MS);
  hub = new Hub(null, null, null, null, null, undefined, () => 0);
});

afterEach(() => {
  vi.useRealTimers();
});

const tap = (count: number): SessionEvent => ({ type: 'touch.tap', part: 'head', count });

describe('touch events in the event log', () => {
  it('keeps two identical taps inside the echo window', () => {
    hub.report({ events: [tap(1)] });
    vi.setSystemTime(EPOCH_MS + 500);
    hub.report({ events: [tap(1)] });
    const touches = hub.snapshot().events.filter((e) => e.type === 'touch.tap');
    expect(touches).toHaveLength(2);
    expect(touches.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('keeps two taps in one report', () => {
    hub.report({ events: [tap(1), tap(2)] });
    expect(hub.snapshot().events.map((e) => e.count)).toEqual([1, 2]);
  });

  it('keeps a hold with its part, side and count', () => {
    hub.report({ events: [{ type: 'touch.hold', part: 'hand', side: 'R', count: 1 }] });
    expect(hub.snapshot().events[0]).toMatchObject({
      type: 'touch.hold',
      part: 'hand',
      side: 'R',
      count: 1,
    });
  });
});
