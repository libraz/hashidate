import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FeedDecoder, FeedReceiver, STALE_MS } from '@/panel/preview/feed';
import type { FeedConfig, FeedMessage, FeedPort } from '@/viewer/stage-feed';

/**
 * The preview's end of the stage feed: which source it decodes, from where,
 * and when it gives up and lets the panel draw its own picture.
 */

const CONFIG: FeedConfig = { codec: 'avc1.42001f', codedWidth: 1280, codedHeight: 720 };

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
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
}

class Decoder implements FeedDecoder {
  configured: FeedConfig[] = [];
  decoded: Array<{ key: boolean; timestamp: number }> = [];
  resets = 0;
  backlog = 0;
  configure(config: FeedConfig): void {
    this.configured.push(config);
  }
  decode(chunk: { key: boolean; timestamp: number }): void {
    this.decoded.push({ key: chunk.key, timestamp: chunk.timestamp });
  }
  reset(): void {
    this.resets++;
  }
  close(): void {}
}

const chunk = (source: string, key: boolean, timestamp: number, config?: FeedConfig) => ({
  type: 'chunk' as const,
  source,
  key,
  timestamp,
  data: new ArrayBuffer(4),
  ...(config ? { config } : {}),
});

let clock = 0;
let port: Port;
let decoder: Decoder;
let receiver: FeedReceiver;

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  port = new Port();
  decoder = new Decoder();
  receiver = new FeedReceiver({ watcher: 'w', decoder: () => decoder, port, now: () => clock });
});

afterEach(() => {
  receiver.dispose();
  vi.useRealTimers();
});

describe('FeedReceiver', () => {
  it('asks for a keyframe until it has decoded one', () => {
    expect(port.sent.at(-1)).toEqual({ type: 'want', watcher: 'w', key: true });
    port.deliver(chunk('a', true, 1, CONFIG));
    vi.advanceTimersByTime(1_000);
    expect(port.sent.at(-1)).toEqual({ type: 'want', watcher: 'w', key: false });
  });

  it('drops delta frames until the first keyframe, then decodes from it', () => {
    port.deliver(chunk('a', false, 1));
    expect(decoder.decoded).toEqual([]);
    expect(receiver.live).toBe(false);
    port.deliver(chunk('a', true, 2, CONFIG));
    port.deliver(chunk('a', false, 3));
    expect(decoder.configured).toEqual([CONFIG]);
    expect(decoder.decoded.map((c) => c.timestamp)).toEqual([2, 3]);
    expect(receiver.live).toBe(true);
  });

  it('stays on the source it locked onto while that source keeps sending', () => {
    port.deliver(chunk('a', true, 1, CONFIG));
    clock = 100;
    port.deliver(chunk('b', true, 2, CONFIG));
    expect(decoder.decoded.map((c) => c.timestamp)).toEqual([1]);
  });

  it('goes stale after silence, and then takes another source from its keyframe', () => {
    port.deliver(chunk('a', true, 1, CONFIG));
    clock = STALE_MS;
    expect(receiver.live).toBe(false);
    port.deliver(chunk('b', false, 2));
    port.deliver(chunk('b', true, 3, CONFIG));
    expect(decoder.decoded.map((c) => c.timestamp)).toEqual([1, 3]);
    expect(receiver.live).toBe(true);
  });

  it('falls back at once when its source says it is going away', () => {
    port.deliver(chunk('a', true, 1, CONFIG));
    port.deliver({ type: 'end', source: 'b' });
    expect(receiver.live).toBe(true);
    port.deliver({ type: 'end', source: 'a' });
    expect(receiver.live).toBe(false);
  });

  it('restarts from the next keyframe when the decoder falls behind', () => {
    port.deliver(chunk('a', true, 1, CONFIG));
    decoder.backlog = 4;
    port.deliver(chunk('a', false, 2));
    expect(decoder.resets).toBe(1);
    expect(port.sent.at(-1)).toEqual({ type: 'want', watcher: 'w', key: true });
    decoder.backlog = 0;
    port.deliver(chunk('a', false, 3));
    port.deliver(chunk('a', true, 4, CONFIG));
    expect(decoder.decoded.map((c) => c.timestamp)).toEqual([1, 4]);
  });

  it('ignores anything that is not a feed message', () => {
    port.deliver({ type: 'chunk', source: 'a' });
    port.deliver('noise');
    expect(decoder.decoded).toEqual([]);
  });

  it('stops asking and closes the channel when disposed', () => {
    receiver.dispose();
    const count = port.sent.length;
    vi.advanceTimersByTime(5_000);
    expect(port.sent.length).toBe(count);
    expect(port.closed).toBe(true);
  });
});
