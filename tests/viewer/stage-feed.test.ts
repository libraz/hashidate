import { describe, expect, it } from 'vitest';
import type { StageFrame } from '@/viewer/scene/runtime';
import {
  FEED_FPS,
  type FeedMessage,
  type FeedPort,
  isFeedMessage,
  pace,
  StageFeed,
  WANT_TTL_MS,
} from '@/viewer/stage-feed';

/**
 * The stage's end of the feed: encode only while a preview is asking, and say
 * so when going away. Encoding itself needs WebCodecs and is not run here.
 */

class Port implements FeedPort {
  sent: FeedMessage[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  postMessage(message: FeedMessage): void {
    this.sent.push(message);
  }
  close(): void {
    this.closed = true;
  }
}

function feed() {
  let clock = 0;
  const listeners = new Set<(frame: StageFrame) => void>();
  const port = new Port();
  const stage = new StageFeed({
    onFrame: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    source: 's',
    port,
    now: () => clock,
  });
  return {
    stage,
    port,
    listeners,
    at: (t: number) => {
      clock = t;
    },
    frame: () => {
      for (const fn of [...listeners]) fn({} as StageFrame);
    },
  };
}

describe('StageFeed', () => {
  it('draws nothing until a preview asks', () => {
    const f = feed();
    expect(f.stage.running).toBe(false);
    expect(f.listeners.size).toBe(0);
    f.port.onmessage?.({ data: { type: 'want', watcher: 'w', key: true } });
    expect(f.stage.running).toBe(true);
    expect(f.listeners.size).toBe(1);
    f.stage.dispose();
  });

  it('stops once nobody has asked for a while', () => {
    const f = feed();
    f.port.onmessage?.({ data: { type: 'want', watcher: 'w', key: false } });
    f.at(WANT_TTL_MS - 1);
    f.frame();
    expect(f.stage.running).toBe(true);
    f.at(WANT_TTL_MS + 1);
    f.frame();
    expect(f.stage.running).toBe(false);
    expect(f.listeners.size).toBe(0);
    f.stage.dispose();
  });

  it('ignores what is not a want', () => {
    const f = feed();
    f.port.onmessage?.({ data: { type: 'end', source: 'x' } });
    f.port.onmessage?.({ data: { type: 'want', watcher: 'w' } });
    expect(f.stage.running).toBe(false);
    f.stage.dispose();
  });

  it('tells the previews it is going away only if it was sending', () => {
    const idle = feed();
    idle.stage.dispose();
    expect(idle.port.sent).toEqual([]);
    expect(idle.port.closed).toBe(true);

    const busy = feed();
    busy.port.onmessage?.({ data: { type: 'want', watcher: 'w', key: true } });
    busy.stage.dispose();
    expect(busy.port.sent).toEqual([{ type: 'end', source: 's' }]);
  });
});

describe('pace', () => {
  // From an empty credit, so the first frame's immediate send is not counted.
  const sent = (hz: number, frames: number): number => {
    let credit = 0;
    let n = 0;
    for (let i = 0; i < frames; i++) {
      const step = pace(credit, 1000 / hz);
      credit = step.credit;
      if (step.due) n++;
    }
    return n;
  };

  it('sends the feed rate from any display rate above it', () => {
    expect(sent(72, 72 * 10)).toBe(FEED_FPS * 10);
    expect(sent(50, 50 * 10)).toBe(FEED_FPS * 10);
    expect(sent(60, 60 * 10)).toBe(FEED_FPS * 10);
  });

  it('sends every frame from a display slower than the feed', () => {
    expect(sent(24, 24 * 10)).toBe(24 * 10);
  });

  it('does not burst after a stall', () => {
    const after = pace(0, 5_000);
    expect(after).toEqual({ due: true, credit: 1 });
    expect(pace(after.credit, 0).due).toBe(true);
    expect(pace(pace(after.credit, 0).credit, 0).due).toBe(false);
  });
});

describe('isFeedMessage', () => {
  it('accepts the three shapes and nothing else', () => {
    expect(isFeedMessage({ type: 'want', watcher: 'w', key: true })).toBe(true);
    expect(isFeedMessage({ type: 'end', source: 's' })).toBe(true);
    expect(
      isFeedMessage({
        type: 'chunk',
        source: 's',
        key: true,
        timestamp: 1,
        data: new ArrayBuffer(1),
      }),
    ).toBe(true);
    expect(
      isFeedMessage({
        type: 'chunk',
        source: 's',
        key: true,
        timestamp: 1,
        data: new ArrayBuffer(1),
        config: { codec: 'vp8', codedWidth: 1, codedHeight: 1 },
      }),
    ).toBe(true);
    expect(isFeedMessage({ type: 'chunk', source: 's', key: true, timestamp: 1, data: 'x' })).toBe(
      false,
    );
    expect(isFeedMessage({ type: 'shot' })).toBe(false);
    expect(isFeedMessage(null)).toBe(false);
  });
});
