import { describe, expect, it, vi } from 'vitest';
import { sessionEventSchema } from '@/protocol';
import { reportTouches } from '@/viewer/mascot/report';

describe('touch reports', () => {
  it('pushes a tap as a touch.tap with its part, side and count', () => {
    const pushEvent = vi.fn();
    const report = reportTouches({ pushEvent });

    report({ kind: 'tap', part: 'arm', side: 'L', count: 3 });

    expect(pushEvent.mock.calls).toEqual([
      [{ type: 'touch.tap', part: 'arm', side: 'L', count: 3 }],
    ]);
  });

  it('pushes a hold as a touch.hold, with no side where the part has none', () => {
    const pushEvent = vi.fn();
    const report = reportTouches({ pushEvent });

    report({ kind: 'hold', part: 'head', count: 1 });

    expect(pushEvent.mock.calls).toEqual([[{ type: 'touch.hold', part: 'head', count: 1 }]]);
    expect('side' in pushEvent.mock.calls[0][0]).toBe(false);
  });

  it('sends only what the wire accepts', () => {
    const pushEvent = vi.fn();
    const report = reportTouches({ pushEvent });

    report({ kind: 'tap', part: 'leg', side: 'R', count: 10 });
    report({ kind: 'hold', part: 'torso', count: 1 });

    for (const [event] of pushEvent.mock.calls) {
      expect(sessionEventSchema.strict().parse(event)).toEqual(event);
    }
  });
});
