import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, Recording } from '@/protocol';
import { Hub, RECORD_FLUSH_SECONDS, RECORD_TAIL_SECONDS } from '@/server/hub';
import type { OpenOptions } from '@/server/recordings';
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
          file: `/takes/${options.name ?? 'take'}.mp4`,
          mime: null,
          since: now(),
          bytes: 0,
          autoStop: options.autoStop,
          width: options.width,
          height: options.height,
          fps: options.fps,
        };
        return live;
      },
      append(session: string, mime: string, chunk: Buffer): boolean {
        if (live === null || live.session !== session) return false;
        live = { ...live, mime, bytes: live.bytes + chunk.byteLength };
        return true;
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
    h.subscribe((message) => seen.push(...message.commands));
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

  it('lets a held queue go on the first chunk, not on the request', () => {
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

    void h.recordChunk(opened.session, 'video/mp4', Buffer.from('one'));
    expect(seen.at(-1)).toEqual({ cmd: 'pause', on: false });
    expect(h.snapshot().paused).toBe(false);
  });

  it('releases the hold once and not again on the second chunk', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const seen = watch(h);
    const opened = h.startRecording({ ...OPEN, release: true });
    if (opened === null) throw new Error('the take did not open');
    await h.recordChunk(opened.session, 'video/mp4', Buffer.from('one'));
    await h.recordChunk(opened.session, 'video/mp4', Buffer.from('two'));
    expect(seen.filter((c) => c.cmd === 'pause')).toHaveLength(1);
  });

  it('leaves the hold alone for a take that was not asked to release it', async () => {
    const h = new Hub(null, null, null, store());
    h.send({ type: 'command', commands: [{ cmd: 'pause', on: true }] });
    const opened = h.startRecording(OPEN);
    if (opened === null) throw new Error('the take did not open');
    await h.recordChunk(opened.session, 'video/mp4', Buffer.from('one'));
    expect(h.snapshot().paused).toBe(true);
  });

  it('drops a chunk for a session that is not the one in flight', async () => {
    const h = new Hub(null, null, null, store());
    h.startRecording(OPEN);
    expect(await h.recordChunk('r-stale', 'video/mp4', Buffer.from('x'))).toBe(false);
  });

  it('closes the file on the chunk the renderer flags as its last', async () => {
    const takes = store();
    const h = new Hub(null, null, null, takes);
    const opened = h.startRecording(OPEN);
    if (opened === null) throw new Error('the take did not open');
    h.stopRecording(opened.session);
    // Still open on the send: the encoder's last second is on its way.
    expect(h.recording).not.toBeNull();
    await h.recordChunk(opened.session, 'video/mp4', Buffer.alloc(0), { final: true });
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
  });

  it('reports the take on the snapshot, because the bytes arrive here', async () => {
    const h = new Hub(null, null, null, store());
    expect(h.snapshot().recording).toBeNull();
    const opened = h.startRecording({ ...OPEN, name: 'opening' });
    if (opened === null) throw new Error('the take did not open');
    await h.recordChunk(opened.session, 'video/mp4', Buffer.alloc(1024));
    expect(h.snapshot().recording).toMatchObject({ bytes: 1024, mime: 'video/mp4' });
  });
});
