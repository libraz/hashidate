import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, StreamMessage } from '@/protocol';
import { ECHO_SECONDS, Hub, STATE_STALE_SECONDS } from '@/server/hub';
import { EPOCH_MS, event, state } from './fixtures';

/**
 * The pending queue and the history behind it.
 */

let hub: Hub;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH_MS);
  hub = new Hub();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the pending queue', () => {
  it('removes a started line from every pending republish', () => {
    const [running, pending] = hub.queue.add([{ text: 'running' }, { text: 'pending' }]);
    hub.report({ events: [event(running.id, 'turn.start')] });

    const frames: StreamMessage[] = [];
    hub.subscribe((message) => frames.push(message));
    hub.queue.update(pending.id, { text: 'edited' });
    hub.publishQueue();

    const queues = frames.flatMap((frame) =>
      frame.type === 'command' ? frame.commands.filter((command) => command.cmd === 'queue') : [],
    );
    expect(queues).not.toHaveLength(0);
    for (const command of queues) {
      if (command.cmd === 'queue')
        expect(command.turns.map((turn) => turn.id)).not.toContain(running.id);
    }
    expect(hub.queue.airing().map((entry) => entry.id)).toEqual([running.id]);
    expect(hub.queue.list().map((entry) => entry.id)).toEqual([pending.id]);
  });

  it('files an airing line on end and keeps pending lines separate', () => {
    const [running, pending] = hub.queue.add([{ text: 'running' }, { text: 'pending' }]);
    hub.report({ events: [event(running.id, 'turn.start')] });
    hub.report({ events: [event(running.id, 'turn.end')] });

    expect(hub.queue.airing()).toEqual([]);
    expect(hub.queue.list().map((entry) => entry.id)).toEqual([pending.id]);
    expect(hub.queue.history().map((entry) => entry.id)).toEqual([running.id]);
  });

  it('puts the words of the line on air on the snapshot, and takes them off at the end', () => {
    // The panel has an id from `state.turn` and nothing to read: a started line
    // is out of the pending list and does not reach the history until it is
    // over. This is the only place its text exists in between.
    const [running] = hub.queue.add([{ text: '[hello]こんばんは。' }, { text: 'pending' }]);
    hub.report({ events: [event(running.id, 'turn.start')] });

    expect(hub.snapshot().airing).toEqual([expect.objectContaining({ id: running.id })]);
    expect(hub.snapshot().airing?.[0].text).toBe('[hello]こんばんは。');

    hub.report({ events: [event(running.id, 'turn.end')] });
    expect(hub.snapshot().airing).toEqual([]);
  });

  it('hands the queue to a viewer the moment it attaches', () => {
    hub.queue.add([{ text: 'あ' }, { text: 'い' }]);
    const seen: StreamMessage[] = [];
    hub.subscribe((message) => seen.push(message));
    // A reload mid-stream comes back with an empty renderer queue. Re-delivering
    // on connect is what makes the only thing lost the line that was in the air.
    expect(seen).toHaveLength(1);
    expect(seen[0].commands[0]).toMatchObject({ cmd: 'queue' });
  });

  it('replaces a stale local queue with an empty list on reconnect', () => {
    const [running, pending] = hub.queue.add([{ text: 'running' }, { text: 'pending' }]);
    const seen: StreamMessage[] = [];
    const detach = hub.subscribe((message) => seen.push(message));
    expect(seen[0]).toMatchObject({
      type: 'command',
      commands: [{ cmd: 'queue', turns: [{ id: running.id }, { id: pending.id }] }],
    });

    // This renderer is gone before it hears the start and clear. Its local
    // queue still has both rows, so a reconnect must receive the authoritative
    // empty replacement rather than silence.
    detach();
    hub.report({ events: [event(running.id, 'turn.start')] });
    hub.queue.clear();
    hub.publishQueue();

    const reconnect: StreamMessage[] = [];
    hub.subscribe((message) => reconnect.push(message));
    // Held as well, because the line it missed the start of is still on air.
    expect(reconnect).toEqual([
      {
        type: 'command',
        commands: [
          { cmd: 'pause', on: true },
          { cmd: 'queue', turns: [] },
        ],
      },
    ]);
    expect(hub.queue.airing().map((entry) => entry.id)).toEqual([running.id]);
  });

  it('drops an entry when the renderer reports its turn ended', () => {
    const [a, b] = hub.queue.add([{ text: 'あ' }, { text: 'い' }]);
    hub.report({ events: [event(a.id)] });
    // Driven off the event and not off the reported depth: the count says how
    // many are left, not which one left, and the panel is looking at rows.
    expect(hub.queue.list().map((e) => e.id)).toEqual([b.id]);
  });

  it('empties itself when an interrupt or a clear is sent, before any renderer answers', () => {
    for (const cmd of ['interrupt', 'clear'] as const) {
      hub.queue.add([{ text: 'あ' }, { text: 'い' }]);
      hub.send({ type: 'command', commands: [{ cmd }] });
      // Without this a publish in the gap before the renderers answer would
      // hand them back the script the operator had just killed.
      expect(hub.queue.list()).toEqual([]);
    }
  });

  it('empties itself with nothing attached, and a later publish brings nothing back', () => {
    hub.queue.add([{ text: 'あ' }, { text: 'い' }]);
    expect(hub.command([{ cmd: 'clear' }]).fates).toEqual(['retained']);

    const frames: StreamMessage[] = [];
    hub.subscribe((message) => frames.push(message));
    hub.queue.add([{ text: 'う' }]);
    hub.publishQueue();

    const last = frames.at(-1);
    const queue = last?.type === 'command' ? last.commands.at(-1) : undefined;
    expect(queue?.cmd === 'queue' ? queue.turns.map((turn) => turn.text) : null).toEqual(['う']);
  });

  it('acts on nothing when a renderer reports what it dropped', () => {
    const [a, b, c] = hub.queue.add([{ text: 'あ' }, { text: 'い' }, { text: 'う' }]);
    hub.report({ events: [{ type: 'queue.dropped', turns: [a.id, c.id] }] });
    expect(hub.queue.list().map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });

  it('queues a say from the command route, so a later publish carries it', () => {
    const frames: StreamMessage[] = [];
    hub.subscribe((message) => frames.push(message));
    const { ids, fates } = hub.command([{ cmd: 'say', id: 'mine', text: 'direct' }]);
    hub.queue.add([{ text: 'queued' }]);
    hub.publishQueue();

    expect(ids).toEqual(['mine']);
    expect(fates).toEqual(['delivered']);
    const last = frames.at(-1);
    const queue = last?.type === 'command' ? last.commands[0] : undefined;
    expect(queue?.cmd === 'queue' ? queue.turns.map((turn) => turn.id) : null).toEqual([
      'mine',
      expect.any(String),
    ]);
    // The renderer never receives a bare say the server does not also hold.
    expect(frames.flatMap((frame) => frame.commands).some((c) => c.cmd === 'say')).toBe(false);
    hub.report({ events: [event('mine', 'turn.end')] });
    expect(hub.queue.history().map((entry) => entry.id)).toEqual(['mine']);
  });

  it('mints a fresh id for a say whose id already names a turn', () => {
    const { ids: first } = hub.command([{ cmd: 'say', id: 'same', text: 'a' }]);
    const { ids: second } = hub.command([{ cmd: 'say', id: 'same', text: 'b' }]);
    expect(first).toEqual(['same']);
    expect(second[0]).not.toBe('same');
  });

  it('reports the queue even when the state has gone stale', () => {
    hub.subscribe(() => {});
    hub.report({ state: state() });
    hub.queue.add([{ text: 'あ' }]);
    vi.advanceTimersByTime((STATE_STALE_SECONDS + 1) * 1000);
    const snapshot = hub.snapshot();
    // A stale state is a lie about what the avatar is doing; a script is still
    // a script with nothing connected — which is when it is most looked at.
    expect(snapshot.state).toEqual({});
    expect(snapshot.queue).toHaveLength(1);
  });
});

describe('on-air ownership and renderer recovery', () => {
  const start = (id: string, rendererId?: string): void => {
    hub.report({ events: [event(id, 'turn.start')] }, rendererId);
  };

  it('recovers an on-air line before a new renderer receives pending work', () => {
    const [running, pending] = hub.queue.add([{ text: 'running' }, { text: 'pending' }]);
    const detach = hub.subscribe(() => {}, 'renderer-a');
    start(running.id, 'renderer-a');
    detach();

    const seen: StreamMessage[] = [];
    hub.subscribe((message) => seen.push(message), 'renderer-b');

    expect(hub.queue.airing()).toEqual([]);
    expect(hub.queue.list().map((entry) => entry.id)).toEqual([pending.id]);
    expect(hub.queue.history()).toMatchObject([{ id: running.id, interrupted: true }]);
    expect(hub.snapshot().events.at(-1)).toMatchObject({
      type: 'turn.end',
      turn: running.id,
      interrupted: true,
    });
    expect(seen[0]).toEqual({
      type: 'command',
      commands: [{ cmd: 'queue', turns: [{ id: pending.id, text: 'pending' }] }],
    });
  });

  it('keeps the line on air when the same renderer reconnects within grace', () => {
    const [running] = hub.queue.add([{ text: 'running' }]);
    const detach = hub.subscribe(() => {}, 'renderer-a');
    start(running.id, 'renderer-a');
    detach();

    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 - 1);
    const reconnect = hub.subscribe(() => {}, 'renderer-a');
    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 + 1);

    expect(hub.queue.airing().map((entry) => entry.id)).toEqual([running.id]);
    reconnect();
  });

  it('keeps an on-air line while one of two original renderers remains', () => {
    const [running] = hub.queue.add([{ text: 'running' }]);
    const first = hub.subscribe(() => {}, 'renderer-a');
    const second = hub.subscribe(() => {}, 'renderer-b');
    start(running.id, 'renderer-a');
    start(running.id, 'renderer-b');
    first();

    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 + 1);
    expect(hub.queue.airing().map((entry) => entry.id)).toEqual([running.id]);

    second();
    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 + 1);
    expect(hub.queue.airing()).toEqual([]);
  });

  it('learns a slow second owner before the first owner grace expires', () => {
    const [running] = hub.queue.add([{ text: 'running' }]);
    const first = hub.subscribe(() => {}, 'renderer-a');
    const second = hub.subscribe(() => {}, 'renderer-b');
    start(running.id, 'renderer-a');
    first();
    // A new preview must not shorten grace for the still-connected slow owner.
    hub.subscribe(() => {}, 'renderer-c');

    vi.advanceTimersByTime((STATE_STALE_SECONDS * 1000) / 2);
    start(running.id, 'renderer-b');
    vi.advanceTimersByTime((STATE_STALE_SECONDS * 1000) / 2 + 1);

    expect(hub.queue.airing().map((entry) => entry.id)).toEqual([running.id]);
    second();
  });

  it('recovers after the named owners remain absent for grace', () => {
    const [running, pending] = hub.queue.add([{ text: 'running' }, { text: 'pending' }]);
    const detach = hub.subscribe(() => {}, 'renderer-a');
    start(running.id, 'renderer-a');
    detach();

    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000);

    expect(hub.queue.airing()).toEqual([]);
    expect(hub.queue.list().map((entry) => entry.id)).toEqual([pending.id]);
    expect(hub.queue.history()[0]).toMatchObject({ id: running.id, interrupted: true });
  });

  it('does not recover a line whose start was anonymous', () => {
    const [running] = hub.queue.add([{ text: 'running' }]);
    const detach = hub.subscribe(() => {});
    hub.report({ events: [event(running.id, 'turn.start')] });
    detach();

    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 + 1);
    hub.subscribe(() => {}, 'renderer-new');

    expect(hub.queue.airing().map((entry) => entry.id)).toEqual([running.id]);
    expect(hub.queue.history()).toEqual([]);
  });

  it('carries an interrupted flag from a normal turn.end into history', () => {
    const [running] = hub.queue.add([{ text: 'running' }]);
    const detach = hub.subscribe(() => {}, 'renderer-a');
    start(running.id, 'renderer-a');
    hub.report(
      { events: [{ type: 'turn.end', turn: running.id, interrupted: true }] },
      'renderer-a',
    );
    detach();

    expect(hub.queue.history()[0]).toMatchObject({ id: running.id, interrupted: true });
  });

  it('dispose cancels on-air grace timers', () => {
    const [running] = hub.queue.add([{ text: 'running' }]);
    const detach = hub.subscribe(() => {}, 'renderer-a');
    start(running.id, 'renderer-a');
    detach();

    hub.dispose();
    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 + 1);

    expect(hub.queue.airing().map((entry) => entry.id)).toEqual([running.id]);
  });
});

/**
 * The document half of the snapshot: what is on disk, and what is up.
 *
 * The two come from opposite directions and are on the snapshot together because
 * a panel needs both to draw one control — the roster is a directory only this
 * process can see, and the page is a readout only the renderer can give.
 */

describe('the history and rewinding', () => {
  /** Queue one line and report it said, which is the whole round trip. */
  const spoke = (text: string, type: SessionEvent['type'] = 'turn.end'): string => {
    const [entry] = hub.queue.add([{ text }]);
    hub.report({ events: [event(entry.id, type)] });
    return entry.id;
  };

  it('files a finished turn instead of dropping it', () => {
    const id = spoke('a');
    expect(hub.queue.list()).toEqual([]);
    expect(hub.queue.history().map((e) => e.id)).toEqual([id]);
  });

  it('files the line that was cut off, and leaves the pending list to the server', () => {
    const [running] = hub.queue.add([{ text: 'running' }]);
    hub.queue.add([{ text: 'pending' }]);
    hub.report({ events: [event(running.id, 'turn.start')] });
    hub.report({ events: [event(running.id, 'turn.interrupted')] });

    // A renderer's report of a cut files the line, which was said if only
    // partly. What happens to the rest was decided when the interrupt was sent.
    expect(hub.queue.list().map((e) => e.text)).toEqual(['pending']);
    expect(hub.queue.history().map((e) => e.interrupted)).toEqual([true]);
  });

  it('sends the interrupt and the rewound list in one frame', () => {
    const frames: StreamMessage[] = [];
    hub.subscribe((message) => frames.push(message));
    const id = spoke('a');

    hub.rewind(id, 'one', { interrupt: true });

    const last = frames.at(-1);
    const commands = last?.type === 'command' ? last.commands : [];
    // Two frames would let a renderer apply the stop and then lose the
    // connection holding a queue that had just been rewound out from under it.
    expect(commands[0]).toEqual({ cmd: 'interrupt' });
    expect(commands[1]).toMatchObject({ cmd: 'queue' });
  });

  it('publishes the list without an interrupt when the line may finish', () => {
    const frames: StreamMessage[] = [];
    hub.subscribe((message) => frames.push(message));
    const id = spoke('a');

    hub.rewind(id, 'one', { interrupt: false });

    const last = frames.at(-1);
    const commands = last?.type === 'command' ? last.commands : [];
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ cmd: 'queue' });
  });

  /**
   * Every renderer answers one cut, and the real `Session.interrupt` answers
   * with both a `turn.interrupted` and a `queue.dropped` naming every line it
   * held. Spaced past `ECHO_SECONDS`, so this is not the echo filter at work.
   */
  it('keeps the rewound line and every pending line through the cut three renderers answer', () => {
    const said = spoke('a');
    const running = hub.queue.add([{ text: 'on air' }])[0].id;
    hub.report({ events: [event(running, 'turn.start')] });
    const [pending] = hub.queue.add([{ text: 'pending' }]);

    hub.rewind(said, 'one', { interrupt: true });
    for (let i = 0; i < 3; i += 1) {
      hub.report({
        events: [
          event(running, 'turn.interrupted'),
          { type: 'queue.dropped', turns: [pending.id] },
        ],
      });
      vi.advanceTimersByTime(ECHO_SECONDS * 1000 + 200);
    }

    expect(hub.queue.list().map((e) => e.text)).toEqual(['a', 'pending']);
    expect(hub.queue.list()[1].id).toBe(pending.id);
    expect(hub.queue.history().map((e) => e.text)).toEqual(['a', 'on air']);
  });

  it('puts the cut line back after the lines a from-rewind brings back', () => {
    const first = spoke('a');
    spoke('b');
    const running = hub.queue.add([{ text: 'on air' }])[0].id;
    hub.report({ events: [event(running, 'turn.start')] });
    hub.queue.add([{ text: 'pending' }]);

    hub.rewind(first, 'from', { interrupt: true });
    hub.report({ events: [event(running, 'turn.interrupted')] });

    expect(hub.queue.list().map((e) => e.text)).toEqual(['a', 'b', 'on air', 'pending']);
  });

  it('still empties the list for an interrupt sent after a rewind', () => {
    const id = spoke('a');
    hub.rewind(id, 'one', { interrupt: true });
    expect(hub.queue.list()).toHaveLength(1);

    hub.send({ type: 'command', commands: [{ cmd: 'interrupt' }] });
    expect(hub.queue.list()).toEqual([]);
  });

  it('answers null for an id the history does not have, after the initial queue sync', () => {
    const frames: StreamMessage[] = [];
    hub.subscribe((message) => frames.push(message));
    expect(hub.rewind('nope', 'from', { interrupt: true })).toBeNull();
    expect(frames).toEqual([{ type: 'command', commands: [{ cmd: 'queue', turns: [] }] }]);
  });
});

/**
 * What the event log does with the same thing reported more than once.
 *
 * More than one renderer is the ordinary case — the panel's preview, the stage
 * window, whatever OBS has open — and they are all doing the same thing, so one
 * line ending arrives once per renderer. An orchestrator polling `/api/events`
 * counts turns, and counting three of them per line is worse than useless: an
 * LLM loop waiting for the character to stop talking is woken twice too often.
 */
