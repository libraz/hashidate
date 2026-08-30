import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, Recording } from '@/protocol';
import {
  Hub,
  RECORD_FLUSH_SECONDS,
  RECORD_ORPHAN_SECONDS,
  RECORD_TAIL_SECONDS,
} from '@/server/hub';
import type { AppendResult, OpenOptions } from '@/server/recordings';
import { EPOCH_MS, state } from './fixtures';

/**
 * The take being written.
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

describe('recording', () => {
  /** A store that remembers what it was asked, and no filesystem behind it. */
  function store({ fail = false }: { fail?: boolean } = {}) {
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
          file: `/takes/${options.name ?? 'take'}.mp4`,
          mime: null,
          since: now(),
          bytes: 0,
          autoStop: options.autoStop,
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
        if (live.error !== null) {
          return Promise.resolve({ status: 'failed', first: false, recording: live });
        }
        if (chunk.byteLength === 0) {
          return Promise.resolve({ status: 'accepted', first: false, recording: live });
        }
        if (fail) {
          live = { ...live, error: 'sink offline' };
          return Promise.resolve({ status: 'failed', first: false, recording: live });
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

  const OPEN = { width: 1920, height: 1080, fps: 30, autoStop: true };
  const now = (): number => Date.now() / 1000;

  /** Every command that reached a renderer, flattened. */
  function watch(h: Hub): Command[] {
    const seen: Command[] = [];
    h.subscribe((message) =>
      seen.push(...message.commands.filter((command) => command.cmd !== 'queue')),
    );
    return seen;
  }

  it('answers null when the server was started without a recordings directory', () => {
    expect(new Hub().startRecording(OPEN)).toBeNull();
  });

  it('tells every renderer to roll, with the frame it opened the file at', () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const seen = watch(h);
    const opened = h.startRecording({ ...OPEN, name: 'opening' });
    expect(opened?.session).toBe('r1');
    expect(seen).toEqual([
      { cmd: 'record', on: true, session: 'r1', width: 1920, height: 1080, fps: 30 },
    ]);
  });

  it('refuses a second take rather than opening one over the first', () => {
    const h = new Hub(null, null, null, store());
    expect(h.startRecording(OPEN)).not.toBeNull();
    expect(h.startRecording(OPEN)).toBeNull();
  });

  it('lets a held queue go on the first chunk, not on the request', async () => {
    // A timer here would be a guess about how long an encoder takes to produce
    // its first second, and a guess that is short by anything at all clips the
    // front of the line the take opens on.
    const takes = store();
    const h = new Hub(null, null, null, takes);
    h.send({ type: 'command', commands: [{ cmd: 'pause', on: true }] });
    const seen = watch(h);
    const opened = h.startRecording({ ...OPEN, release: true });
    if (opened === null) throw new Error('the take did not open');

    expect(h.snapshot().paused).toBe(true);
    // The hold is in the setup this renderer was handed on connect; what must
    // not have gone out yet is the release.
    expect(seen.some((c) => c.cmd === 'pause' && c.on === false)).toBe(false);

    await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.from('one'));
    expect(seen.at(-1)).toEqual({ cmd: 'pause', on: false });
    expect(h.snapshot().paused).toBe(false);
  });

  it('releases the hold once and not again on the second chunk', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const seen = watch(h);
    const opened = h.startRecording({ ...OPEN, release: true });
    if (opened === null) throw new Error('the take did not open');
    await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.from('one'));
    await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.from('two'));
    expect(seen.filter((c) => c.cmd === 'pause')).toHaveLength(1);
  });

  it('releases a hold only after a successful non-empty write', async () => {
    const takes = store({ fail: true });
    const h = new Hub(null, null, null, takes);
    h.send({ type: 'command', commands: [{ cmd: 'pause', on: true }] });
    const seen = watch(h);
    const opened = h.startRecording({ ...OPEN, release: true });
    if (opened === null) throw new Error('the take did not open');

    expect(
      (await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.alloc(0))).status,
    ).toBe('accepted');
    expect(seen.some((command) => command.cmd === 'pause' && command.on === false)).toBe(false);
    expect(
      (await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.from('x'))).status,
    ).toBe('failed');
    expect(seen.some((command) => command.cmd === 'pause' && command.on === false)).toBe(false);
    expect(h.recording).toMatchObject({ bytes: 0, mime: null, error: 'sink offline' });
  });

  it('closes a failed take on its terminal chunk and permits the next take', async () => {
    const takes = store({ fail: true });
    const h = new Hub(null, null, null, takes);
    const opened = h.startRecording(OPEN);
    if (opened === null) throw new Error('the take did not open');

    const failed = await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.from('x'));
    expect(failed.status).toBe('failed');
    expect(failed.recording).toMatchObject({ bytes: 0, error: 'sink offline' });
    expect(h.recording).not.toBeNull();

    const terminal = await h.recordChunk(
      opened.session,
      'renderer-a',
      'video/mp4',
      Buffer.alloc(0),
      { final: true },
    );
    expect(terminal.status).toBe('failed');
    expect(terminal.recording).toMatchObject({ bytes: 0, error: 'sink offline' });
    expect(h.recording).toBeNull();
    expect(h.startRecording(OPEN)).not.toBeNull();
  });

  it('rejects a second renderer without mixing its bytes into the take', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const opened = h.startRecording(OPEN);
    if (opened === null) throw new Error('the take did not open');

    expect(
      (await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.from('one'))).status,
    ).toBe('accepted');
    expect(
      (await h.recordChunk(opened.session, 'renderer-b', 'video/mp4', Buffer.from('two'))).status,
    ).toBe('conflict');
    expect(h.recording?.bytes).toBe(3);
  });

  it('leaves the hold alone for a take that was not asked to release it', async () => {
    const h = new Hub(null, null, null, store());
    h.send({ type: 'command', commands: [{ cmd: 'pause', on: true }] });
    const opened = h.startRecording(OPEN);
    if (opened === null) throw new Error('the take did not open');
    await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.from('one'));
    expect(h.snapshot().paused).toBe(true);
  });

  it('drops a chunk for a session that is not the one in flight', async () => {
    const h = new Hub(null, null, null, store());
    h.startRecording(OPEN);
    expect(
      (await h.recordChunk('r-stale', 'renderer-a', 'video/mp4', Buffer.from('x'))).status,
    ).toBe('stale');
  });

  it('closes the file on the chunk the renderer flags as its last', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const opened = h.startRecording(OPEN);
    if (opened === null) throw new Error('the take did not open');
    h.stopRecording(opened.session);
    // Still open on the send: the encoder's last second is on its way.
    expect(h.recording).not.toBeNull();
    await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.alloc(0), {
      final: true,
    });
    expect(h.recording).toBeNull();
    expect(takes.closed).toHaveLength(1);
  });

  it('closes the file anyway when the last chunk never arrives', async () => {
    // The renderer was closed or reloaded between the stop and the flush. A file
    // left open forever is worse than one missing its final second.
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const opened = h.startRecording(OPEN);
    if (opened === null) throw new Error('the take did not open');
    h.stopRecording(opened.session);
    await vi.advanceTimersByTimeAsync(RECORD_FLUSH_SECONDS * 1000);
    expect(takes.closed).toHaveLength(1);
  });

  it('refuses a stop that names a take which is not the one running', () => {
    const h = new Hub(null, null, null, store());
    h.startRecording(OPEN);
    expect(h.stopRecording('r-stale')).toBeNull();
    expect(h.recording).not.toBeNull();
  });

  it('ends the take a moment after the last line, rather than on the same frame', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const seen = watch(h);
    h.queue.add([{ text: 'あ' }]);
    const opened = h.startRecording(OPEN);
    if (opened === null) throw new Error('the take did not open');

    const [entry] = h.queue.list();
    h.report({ events: [{ type: 'turn.end', turn: entry.id }] });
    expect(seen.some((c) => c.cmd === 'record' && c.on === false)).toBe(false);

    await vi.advanceTimersByTimeAsync(RECORD_TAIL_SECONDS * 1000);
    expect(seen.at(-1)).toEqual({ cmd: 'record', on: false, session: 'r1' });
  });

  it('does not stop an empty take until work has been seen and drained', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const seen = watch(h);
    h.startRecording(OPEN);

    h.report({ state: state({ speaking: false }) });
    await vi.advanceTimersByTimeAsync(RECORD_TAIL_SECONDS * 2_000);
    expect(seen.some((command) => command.cmd === 'record' && command.on === false)).toBe(false);

    const [entry] = h.queue.add([{ text: 'later' }]);
    h.report({ events: [{ type: 'turn.end', turn: entry.id }] });
    await vi.advanceTimersByTimeAsync(RECORD_TAIL_SECONDS * 1_000);
    expect(seen.some((command) => command.cmd === 'record' && command.on === false)).toBe(true);
  });

  it('keeps recording while a line is airing even though pending is empty', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const seen = watch(h);
    const [entry] = h.queue.add([{ text: 'on air' }]);
    h.startRecording(OPEN);
    h.report({ events: [{ type: 'turn.start', turn: entry.id }] });

    await vi.advanceTimersByTimeAsync(RECORD_TAIL_SECONDS * 1_000);
    expect(seen.some((command) => command.cmd === 'record' && command.on === false)).toBe(false);

    h.report({ events: [{ type: 'turn.end', turn: entry.id }] });
    await vi.advanceTimersByTimeAsync(RECORD_TAIL_SECONDS * 1_000);
    expect(seen.some((command) => command.cmd === 'record' && command.on === false)).toBe(true);
  });

  it('observes a queue edit that clears pending work for the tail', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const seen = watch(h);
    h.queue.add([{ text: 'to clear' }]);
    h.startRecording(OPEN);
    h.queue.clear();
    h.publishQueue();

    await vi.advanceTimersByTimeAsync(RECORD_TAIL_SECONDS * 1_000);
    expect(seen.some((command) => command.cmd === 'record' && command.on === false)).toBe(true);
  });

  it('carries on when a line is queued inside the tail', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const seen = watch(h);
    h.queue.add([{ text: 'あ' }]);
    h.startRecording(OPEN);
    const [entry] = h.queue.list();
    h.report({ events: [{ type: 'turn.end', turn: entry.id }] });

    // A comment arrives while the tail is counting down.
    h.queue.add([{ text: 'い' }]);
    h.report({ state: state({ speaking: false }) });
    await vi.advanceTimersByTimeAsync(RECORD_TAIL_SECONDS * 2000);
    expect(seen.some((c) => c.cmd === 'record' && c.on === false)).toBe(false);
  });

  it('leaves a take alone at the end of a script it was not asked to follow', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const seen = watch(h);
    h.queue.add([{ text: 'あ' }]);
    h.startRecording({ ...OPEN, autoStop: false });
    const [entry] = h.queue.list();
    h.report({ events: [{ type: 'turn.end', turn: entry.id }] });
    await vi.advanceTimersByTimeAsync(RECORD_TAIL_SECONDS * 2000);
    expect(seen.some((c) => c.cmd === 'record' && c.on === false)).toBe(false);
  });

  it('does not end a take because a line is still being said', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const seen = watch(h);
    h.queue.add([{ text: 'あ' }]);
    h.startRecording(OPEN);
    const [entry] = h.queue.list();
    h.report({ state: state({ speaking: true }), events: [{ type: 'turn.end', turn: entry.id }] });
    await vi.advanceTimersByTimeAsync(RECORD_TAIL_SECONDS * 1000);
    expect(seen.some((c) => c.cmd === 'record' && c.on === false)).toBe(false);

    h.report({ state: state({ speaking: false }) });
    await vi.advanceTimersByTimeAsync(RECORD_TAIL_SECONDS * 1000);
    expect(seen.some((c) => c.cmd === 'record' && c.on === false)).toBe(true);
  });

  it('reports the take on the snapshot, because the bytes arrive here', async () => {
    const h = new Hub(null, null, null, store());
    expect(h.snapshot().recording).toBeNull();
    const opened = h.startRecording({ ...OPEN, name: 'opening' });
    if (opened === null) throw new Error('the take did not open');
    await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.alloc(1024));
    expect(h.snapshot().recording).toMatchObject({ bytes: 1024, mime: 'video/mp4' });
  });

  it('closes an orphaned owner take, while reconnecting cancels the watchdog', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const detach = h.subscribe(() => {}, 'renderer-a');
    const opened = h.startRecording(OPEN);
    if (opened === null) throw new Error('the take did not open');
    await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.from('x'));
    detach();

    vi.advanceTimersByTime(RECORD_TAIL_SECONDS * 1_000);
    expect(h.recording).not.toBeNull();
    const reconnect = h.subscribe(() => {}, 'renderer-a');
    await vi.advanceTimersByTimeAsync(RECORD_TAIL_SECONDS * 1_000);
    expect(h.recording).not.toBeNull();
    reconnect();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.recording).toBeNull();
  });

  it('arms the orphan watchdog when the owner disconnects before its first chunk', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const detach = h.subscribe(() => {}, 'renderer-a');
    const opened = h.startRecording(OPEN);
    if (opened === null) throw new Error('the take did not open');
    detach();

    // No owner was pinned when detach ran. The first chunk must pin it and
    // notice that no renderer connection remains before returning.
    await h.recordChunk(opened.session, 'renderer-a', 'video/mp4', Buffer.from('x'));
    expect(h.recording).not.toBeNull();

    const reconnect = h.subscribe(() => {}, 'renderer-a');
    await vi.advanceTimersByTimeAsync(RECORD_ORPHAN_SECONDS * 1000);
    expect(h.recording).not.toBeNull();
    reconnect();
    await vi.advanceTimersByTimeAsync(RECORD_ORPHAN_SECONDS * 1000);
    expect(h.recording).toBeNull();
  });
});
