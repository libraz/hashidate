import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Command, RECORD_DEFAULTS, type Recording } from '@/protocol';
import { Hub, RECORD_ORPHAN_SECONDS } from '@/server/hub';
import type { AppendResult, OpenOptions } from '@/server/recordings';

/**
 * A take that no renderer delivers: nobody attached, nobody unmuted, or a
 * renderer whose encoder never started.
 */

const OPEN = {
  width: 1920,
  height: 1080,
  fps: 30,
  autoStop: true,
  lead: 0,
  tail: RECORD_DEFAULTS.tail,
};

/** A store that accepts bytes from `renderer-a` only, with no filesystem behind it. */
function store() {
  let live: Recording | null = null;
  let counter = 0;
  const closed: Recording[] = [];
  return {
    closed,
    get current(): Recording | null {
      return live;
    },
    open(options: OpenOptions): Recording | null {
      if (live !== null) return null;
      counter += 1;
      live = {
        session: `r${counter}`,
        file: '/takes/take.mp4',
        mime: null,
        since: 0,
        bytes: 0,
        autoStop: options.autoStop,
        lead: options.lead,
        tail: options.tail,
        width: options.width,
        height: options.height,
        fps: options.fps,
        error: null,
      };
      return live;
    },
    append(session: string, owner: string, mime: string, chunk: Buffer): Promise<AppendResult> {
      if (live === null || live.session !== session) {
        return Promise.resolve({ status: 'stale', first: false, recording: live });
      }
      if (owner !== 'renderer-a') {
        return Promise.resolve({ status: 'conflict', first: false, recording: live });
      }
      if (chunk.byteLength === 0) {
        return Promise.resolve({ status: 'accepted', first: false, recording: live });
      }
      const first = live.mime === null;
      live = { ...live, mime, bytes: live.bytes + chunk.byteLength };
      return Promise.resolve({ status: 'accepted', first, recording: live });
    },
    close(session?: string): Promise<Recording | null> {
      if (live === null) return Promise.resolve(null);
      if (session !== undefined && session !== live.session) return Promise.resolve(null);
      closed.push(live);
      live = null;
      return Promise.resolve(closed[closed.length - 1]);
    },
  };
}

function watch(h: Hub): Command[] {
  const seen: Command[] = [];
  h.subscribe((message) =>
    seen.push(...message.commands.filter((command) => command.cmd !== 'queue')),
  );
  return seen;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a take nobody delivers', () => {
  it('closes within the orphan bound and lets go of the hold it set', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    h.send({ type: 'command', commands: [{ cmd: 'pause', on: true }] });
    const seen = watch(h);
    const opened = h.startRecording({ ...OPEN, autoStop: false, release: true });
    if (opened === null) throw new Error('the take did not open');

    await vi.advanceTimersByTimeAsync(RECORD_ORPHAN_SECONDS * 1000 - 1);
    expect(h.recording).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    expect(h.recording).toBeNull();
    expect(takes.closed).toHaveLength(1);
    expect(seen).toContainEqual({ cmd: 'record', on: false, session: opened.session });
    expect(seen.at(-1)).toEqual({ cmd: 'pause', on: false });
    expect(h.snapshot().paused).toBe(false);
    expect(h.startRecording(OPEN)).not.toBeNull();
  });

  it('does not let a renderer that gave up close a take another one delivers', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    h.subscribe(() => {}, 'renderer-a');
    const opened = h.startRecording(OPEN);
    if (opened === null) throw new Error('the take did not open');

    // Two renderers that could not start their encoders report before the one
    // that can has produced its first second.
    const empty = Buffer.alloc(0);
    for (const failing of ['renderer-b', 'renderer-c']) {
      const answer = await h.recordChunk(opened.session, failing, 'video/mp4', empty, {
        final: true,
      });
      expect(answer.status).toBe('accepted');
    }
    expect(h.recording).not.toBeNull();

    await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.from('one'));
    await vi.advanceTimersByTimeAsync(RECORD_ORPHAN_SECONDS * 2000);
    expect(h.recording).toMatchObject({ session: opened.session, bytes: 3 });
    expect(takes.closed).toHaveLength(0);
  });
});
