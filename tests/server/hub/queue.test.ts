import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, StreamMessage } from '@/protocol';
import { EXPECTED_INTERRUPT_SECONDS, Hub, STATE_STALE_SECONDS } from '@/server/hub';
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
    expect(reconnect).toEqual([{ type: 'command', commands: [{ cmd: 'queue', turns: [] }] }]);
    expect(hub.queue.airing().map((entry) => entry.id)).toEqual([running.id]);
  });

  it('drops an entry when the renderer reports its turn ended', () => {
    const [a, b] = hub.queue.add([{ text: 'あ' }, { text: 'い' }]);
    hub.report({ events: [event(a.id)] });
    // Driven off the event and not off the reported depth: the count says how
    // many are left, not which one left, and the panel is looking at rows.
    expect(hub.queue.list().map((e) => e.id)).toEqual([b.id]);
  });

  it('empties itself when the renderer reports an interrupt', () => {
    hub.queue.add([{ text: 'あ' }, { text: 'い' }]);
    hub.report({ events: [{ type: 'turn.interrupted', turn: 'x' }] });
    // Without this the list would be re-delivered on the next edit and the
    // stream would resume a script the operator had just killed.
    expect(hub.queue.list()).toEqual([]);
  });

  it('drops exactly the entries a clear dropped', () => {
    const [a, b, c] = hub.queue.add([{ text: 'あ' }, { text: 'い' }, { text: 'う' }]);
    hub.report({ events: [{ type: 'queue.dropped', turns: [a.id, c.id] }] });
    expect(hub.queue.list().map((e) => e.id)).toEqual([b.id]);
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

  it('files the line that was cut off, and drops the rest of the list', () => {
    const [running] = hub.queue.add([{ text: 'running' }]);
    hub.queue.add([{ text: 'pending' }]);
    hub.report({ events: [event(running.id, 'turn.interrupted')] });

    // Everything pending goes: the operator killed the script. The line that was
    // being said is kept, because it was said, if only partly.
    expect(hub.queue.list()).toEqual([]);
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

  it('does not empty the queue on the interrupt its own rewind caused', () => {
    const first = spoke('a');
    const second = spoke('b');
    const running = hub.queue.add([{ text: 'on air' }])[0].id;

    hub.rewind(first, 'from', { interrupt: true });
    // The renderer answers the interrupt a moment later.
    hub.report({ events: [event(running, 'turn.interrupted')] });

    expect(hub.queue.list().map((e) => e.text)).toEqual(['a', 'b']);
    expect(second).not.toBe(first);
  });

  /**
   * The case the interrupt window is actually for.
   *
   * Every renderer answers one cut, so the same `turn.interrupted` comes back
   * once per renderer — and read as a report each, the second one is the
   * operator hitting stop and empties the list the rewind had just filled. The
   * reports are spaced past `ECHO_SECONDS` on purpose: this is the window doing
   * the work and not the echo filter, and both have to hold on their own.
   */
  it('takes one cut answered by three renderers as the one interrupt it caused', () => {
    const said = spoke('a');
    const running = hub.queue.add([{ text: 'on air' }])[0].id;
    hub.queue.add([{ text: 'pending' }]);

    hub.rewind(said, 'one', { interrupt: true });
    for (let i = 0; i < 3; i += 1) {
      hub.report({ events: [event(running, 'turn.interrupted')] });
      vi.advanceTimersByTime(1_200);
    }

    expect(hub.queue.list().map((e) => e.text)).toEqual(['a', 'pending']);
  });

  it('empties it for an interrupt naming another turn, however late in the window', () => {
    const said = spoke('a');
    hub.rewind(said, 'one', { interrupt: true });
    hub.report({ events: [event('on-air', 'turn.interrupted')] });
    expect(hub.queue.list()).toHaveLength(1);

    // Still inside the window, and still not ours: the rewind cut the turn it
    // named, so anything after it is a line that came later.
    vi.advanceTimersByTime((EXPECTED_INTERRUPT_SECONDS - 1) * 1000);
    hub.report({ events: [event('the-next-one', 'turn.interrupted')] });
    expect(hub.queue.list()).toEqual([]);
  });

  it('expects one interrupt only, so the next genuine one still empties it', () => {
    const id = spoke('a');
    hub.rewind(id, 'one', { interrupt: true });
    hub.report({ events: [event('on-air-1', 'turn.interrupted')] });
    expect(hub.queue.list()).toHaveLength(1);

    // The operator hits stop. Nothing about this one was asked for.
    hub.report({ events: [event('on-air-2', 'turn.interrupted')] });
    expect(hub.queue.list()).toEqual([]);
  });

  it('stops expecting an interrupt that never came', () => {
    const id = spoke('a');
    hub.rewind(id, 'one', { interrupt: true });
    vi.advanceTimersByTime(EXPECTED_INTERRUPT_SECONDS * 1000);

    hub.report({ events: [event('on-air', 'turn.interrupted')] });

    // A renderer that never answered must not leave the kill switch disarmed.
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
