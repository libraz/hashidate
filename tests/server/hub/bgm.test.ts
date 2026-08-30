import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamMessage } from '@/protocol';
import { BgmCoordinator } from '@/server/bgm-state';
import { EVENT_LOG_MAX, Hub } from '@/server/hub';
import { bgm, bgmCue, EPOCH_MS } from './fixtures';

/**
 * Inline BGM cues, routed by the server rather than by the renderer.
 */

let _hub: Hub;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH_MS);
  _hub = new Hub();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('inline BGM cues', () => {
  function routed() {
    const coordinator = new BgmCoordinator(() => EPOCH_MS / 1000);
    const next = new Hub(null, null, null, null, null, coordinator);
    const seen: StreamMessage[] = [];
    next.subscribe((message) => seen.push(message));
    return { hub: next, seen };
  }

  it('waits for an audible renderer and leaves muted or unknown cues available', () => {
    const { hub: next, seen } = routed();
    const cue = bgmCue('turn-1:cue:0', 'play', 'song.mp3');

    next.report({ bgm: bgm({ muted: true }), events: [cue] });
    next.report({ events: [cue] });
    expect(next.snapshot().events).toEqual([]);
    expect(seen).toEqual([{ type: 'command', commands: [{ cmd: 'queue', turns: [] }] }]);

    next.report({ bgm: bgm(), events: [cue] });
    expect(next.snapshot().events).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(seen[1].commands[0]).toMatchObject({
      cmd: 'bgm',
      action: 'play',
      track: 'song.mp3',
      revision: 1,
    });
  });

  it('deduplicates a cue across audible renderers and gives late subscribers the command', () => {
    const { hub: next, seen } = routed();
    const cue = bgmCue('turn-1:cue:0', 'play', 'song.mp3');

    next.report({ bgm: bgm(), events: [cue] });
    next.report({ bgm: bgm(), events: [cue] });
    expect(seen).toHaveLength(2);
    expect(next.snapshot().events).toHaveLength(1);
    expect(next.snapshot().bgm).toMatchObject({
      track: 'song.mp3',
      transport: 'playing',
      revision: 1,
    });

    const late: StreamMessage[] = [];
    next.subscribe((message) => late.push(message));
    expect(late[0].commands[0]).toMatchObject({
      cmd: 'bgm',
      track: 'song.mp3',
      revision: 1,
    });
  });

  it('keeps the cue id set bounded and accepts an id again after eviction', () => {
    const { hub: next, seen } = routed();
    const first = bgmCue('first', 'play', 'first.mp3');
    next.report({ bgm: bgm(), events: [first] });
    for (let i = 0; i < EVENT_LOG_MAX; i += 1) {
      next.report({ bgm: bgm(), events: [bgmCue(`cue-${i}`, 'play', `${i}.mp3`)] });
    }

    next.report({ bgm: bgm(), events: [first] });

    expect(seen).toHaveLength(EVENT_LOG_MAX + 3);
    expect(next.snapshot().events).toHaveLength(EVENT_LOG_MAX);
    expect(next.snapshot().events.filter((event) => event.cueId === 'first')).toHaveLength(1);
  });
});

/**
 * Where the server says it is serving from.
 *
 * Read by the native shell, which finds a listener on the control port and has
 * to decide whether it is this checkout's server or another one's. See
 * `serverRootsSchema`.
 */
