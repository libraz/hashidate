import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionState, StreamMessage, Vocabulary } from '@/protocol';
import { EVENT_LOG_MAX, Hub, STATE_STALE_SECONDS } from '@/server/hub';

/**
 * Fan-out, the sequenced event log and the waiting.
 *
 * Freshness and `waitFor` are both wall-clock bound, so the clock is faked for
 * the whole file: the hub reads `Date.now()` for the `at` stamp and for the
 * staleness cut-off, and a real one makes those tests either slow or flaky.
 */

/** A fixed point to run the clock from, so `at` stamps are exact. */
const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

const frame = (id: string): StreamMessage => ({
  type: 'command',
  commands: [{ cmd: 'gesture', id }],
});

const event = (turn: string, type: SessionEvent['type'] = 'turn.end'): SessionEvent => ({
  type,
  turn,
});

/** A minimal but complete state, so the freshness tests carry something real. */
const state = (over: Partial<SessionState> = {}): SessionState => ({
  speaking: false,
  turn: null,
  queued: 0,
  busy: false,
  idle: false,
  idleEnabled: true,
  emotion: { neutral: 1 },
  expression: null,
  pickedExpression: null,
  overlays: {},
  performance: null,
  gesture: null,
  hopping: false,
  strain: { L: 0, R: 0 },
  lookAt: 1,
  wardrobe: null,
  ...over,
});

/** A complete vocabulary, since a report carries the whole thing or none of it. */
const vocabulary = (): Vocabulary => ({
  avatar: { id: 'synthetic', label: '合成リグ' },
  emotions: [{ id: 'joy', label: '喜' }],
  expressions: [{ id: 'F_DOYA', label: 'F_DOYA' }],
  overlays: [],
  performances: [
    {
      id: 'hello',
      label: 'あいさつ',
      group: 'greeting',
      emotion: { joy: 0.85 },
      gesture: 'wave',
      hop: null,
      sustain: false,
    },
  ],
  gestures: [{ id: 'wave', label: '手を振る', group: 'greeting', sustain: false }],
  hops: [{ id: 'hop', label: 'ぴょん' }],
  cue: { syntax: '[performance]', note: '' },
  cameras: ['bust', 'upper', 'face', 'full'],
  pointing: {
    side: ['L', 'R'],
    azimuth: [-120, 120],
    elevation: [-70, 110],
    extent: [0.1, 1],
    finger: ['thumb', 'index', 'middle', 'ring', 'little'],
    note: '',
  },
  wardrobe: {},
  wardrobePresets: [],
});

let hub: Hub;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH_MS);
  hub = new Hub();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('subscription', () => {
  it('counts every attached viewer', () => {
    expect(hub.viewers).toBe(0);
    hub.subscribe(() => {});
    hub.subscribe(() => {});
    expect(hub.viewers).toBe(2);
  });

  it('hands one message to every subscriber and returns how many got it', () => {
    const a: StreamMessage[] = [];
    const b: StreamMessage[] = [];
    hub.subscribe((m) => a.push(m));
    hub.subscribe((m) => b.push(m));

    const delivered = hub.send(frame('wave'));

    expect(delivered).toBe(2);
    expect(a).toEqual([frame('wave')]);
    expect(b).toEqual([frame('wave')]);
  });

  it('returns zero from send when nothing is attached', () => {
    expect(hub.send(frame('wave'))).toBe(0);
  });

  it('subscribe returns a detach that stops delivery', () => {
    const seen: StreamMessage[] = [];
    const detach = hub.subscribe((m) => seen.push(m));
    hub.send(frame('nod'));
    detach();
    expect(hub.send(frame('wave'))).toBe(0);
    expect(seen).toEqual([frame('nod')]);
  });

  it('unsubscribe drops only the listener it names', () => {
    const kept: StreamMessage[] = [];
    const gone = (): void => {
      throw new Error('an unsubscribed viewer was still delivered to');
    };
    hub.subscribe(gone);
    hub.subscribe((m) => kept.push(m));

    hub.unsubscribe(gone);

    expect(hub.send(frame('wave'))).toBe(1);
    expect(kept).toEqual([frame('wave')]);
  });

  it('detaching twice is harmless', () => {
    const detach = hub.subscribe(() => {});
    detach();
    detach();
    expect(hub.viewers).toBe(0);
  });
});

describe('the event log', () => {
  it('stamps monotonically increasing seq across reports', () => {
    expect(hub.report({ events: [event('a'), event('b')] })).toBe(2);
    expect(hub.report({ events: [event('c')] })).toBe(3);
    expect(hub.snapshot().events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('stamps an arrival time on an event that carries none', () => {
    hub.report({ events: [event('a')] });
    expect(hub.snapshot().events[0].at).toBe(EPOCH_MS / 1000);
  });

  it('keeps an at the viewer supplied rather than restamping it', () => {
    hub.report({ events: [{ ...event('a'), at: 42 }] });
    expect(hub.snapshot().events[0].at).toBe(42);
  });

  it('preserves the payload of each event alongside the stamps', () => {
    hub.report({ events: [{ type: 'turn.start', turn: 'a', seconds: 1.5 }] });
    expect(hub.snapshot().events[0]).toEqual({
      type: 'turn.start',
      turn: 'a',
      seconds: 1.5,
      seq: 1,
      at: EPOCH_MS / 1000,
    });
  });

  it('returns the newest sequence number from report', () => {
    hub.report({ events: [event('a')] });
    expect(hub.report({ events: [event('b'), event('c')] })).toBe(3);
    expect(hub.snapshot().seq).toBe(3);
  });

  it('leaves seq alone for a report carrying no events', () => {
    hub.report({ events: [event('a')] });
    expect(hub.report({ state: state() })).toBe(1);
  });

  it(`caps the log at EVENT_LOG_MAX, keeping the newest`, () => {
    const many = Array.from({ length: EVENT_LOG_MAX + 88 }, (_, i) => event(`t${i}`));
    hub.report({ events: many });

    const events = hub.snapshot().events;
    expect(events).toHaveLength(EVENT_LOG_MAX);
    expect(events[0].seq).toBe(89);
    expect(events[events.length - 1].seq).toBe(EVENT_LOG_MAX + 88);
    expect(events[events.length - 1].turn).toBe(`t${EVENT_LOG_MAX + 87}`);
  });

  it('caps across several reports as well as within one', () => {
    for (let i = 0; i < 20; i++) {
      hub.report({ events: Array.from({ length: 40 }, (_, k) => event(`r${i}-${k}`)) });
    }
    const events = hub.snapshot().events;
    expect(events).toHaveLength(EVENT_LOG_MAX);
    expect(events[events.length - 1].seq).toBe(800);
  });

  it('keeps counting seq past the cap, so a poller never sees one reused', () => {
    hub.report({ events: Array.from({ length: EVENT_LOG_MAX + 5 }, (_, i) => event(`t${i}`)) });
    expect(hub.report({ events: [event('next')] })).toBe(EVENT_LOG_MAX + 6);
  });
});

describe('snapshot(since)', () => {
  beforeEach(() => {
    hub.report({ events: [event('a'), event('b'), event('c')] });
  });

  it('returns only the events past the sequence number given', () => {
    expect(hub.snapshot(1).events.map((e) => e.turn)).toEqual(['b', 'c']);
    expect(hub.snapshot(2).events.map((e) => e.turn)).toEqual(['c']);
  });

  it('returns nothing when the caller is already current', () => {
    expect(hub.snapshot(3).events).toEqual([]);
    expect(hub.snapshot(99).events).toEqual([]);
  });

  it('returns the whole log for since 0 and for no since at all', () => {
    expect(hub.snapshot(0).events).toHaveLength(3);
    expect(hub.snapshot().events).toHaveLength(3);
  });

  it('hands back a copy, so a caller cannot edit the log', () => {
    const events = hub.snapshot().events;
    events.length = 0;
    expect(hub.snapshot().events).toHaveLength(3);
  });
});

describe('state freshness', () => {
  it('reports connected while a viewer is attached and its report is recent', () => {
    hub.subscribe(() => {});
    hub.report({ state: state({ speaking: true }) });
    const snapshot = hub.snapshot();
    expect(snapshot.connected).toBe(true);
    expect(snapshot.state.speaking).toBe(true);
  });

  it('is not connected before anything has been reported, viewer or not', () => {
    hub.subscribe(() => {});
    const snapshot = hub.snapshot();
    expect(snapshot.connected).toBe(false);
    expect(snapshot.state).toEqual({});
    expect(snapshot.viewers).toBe(1);
  });

  it('is not connected with a fresh report but no viewer attached', () => {
    hub.report({ state: state() });
    expect(hub.snapshot().connected).toBe(false);
  });

  it('holds the state right up to the staleness cut-off', () => {
    hub.subscribe(() => {});
    hub.report({ state: state({ speaking: true }) });
    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 - 1);
    const snapshot = hub.snapshot();
    expect(snapshot.connected).toBe(true);
    expect(snapshot.state.speaking).toBe(true);
  });

  it('withholds the state once the report goes stale, even with a viewer subscribed', () => {
    hub.subscribe(() => {});
    hub.report({ state: state({ speaking: true }) });

    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000);

    const snapshot = hub.snapshot();
    // A tab that was closed leaves its last state behind, and answering with it
    // would say the avatar is mid-sentence forever.
    expect(snapshot.connected).toBe(false);
    expect(snapshot.state).toEqual({});
    expect(snapshot.viewers).toBe(1);
  });

  it('becomes fresh again on the next report', () => {
    hub.subscribe(() => {});
    hub.report({ state: state() });
    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 + 500);
    expect(hub.snapshot().connected).toBe(false);

    hub.report({ state: state({ queued: 2 }) });

    expect(hub.snapshot().connected).toBe(true);
    expect(hub.snapshot().state.queued).toBe(2);
  });

  it('does not refresh the clock for a report that carries no state', () => {
    hub.subscribe(() => {});
    hub.report({ state: state() });
    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000);
    hub.report({ events: [event('a')] });
    expect(hub.snapshot().connected).toBe(false);
  });

  it('keeps serving the vocabulary and the event log while the state is stale', () => {
    hub.subscribe(() => {});
    hub.report({ state: state(), events: [event('a')], vocabulary: vocabulary() });
    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 + 1000);

    const snapshot = hub.snapshot();
    expect(snapshot.state).toEqual({});
    expect(snapshot.vocabulary).toEqual(vocabulary());
    expect(snapshot.events).toHaveLength(1);
  });
});

describe('Hub.waitFor', () => {
  it('resolves immediately when the predicate already holds', async () => {
    hub.report({ events: [event('a')] });
    const result = await hub.waitFor((s) => s.seq >= 1, 5_000);
    expect(result.completed).toBe(true);
    expect(result.snapshot.seq).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves when a later report makes the predicate hold', async () => {
    const pending = hub.waitFor((s) => s.events.some((e) => e.type === 'turn.end'), 5_000);
    hub.report({ events: [event('a', 'turn.start')] });
    hub.report({ events: [event('a', 'turn.end')] });

    const result = await pending;
    expect(result.completed).toBe(true);
    expect(result.snapshot.events.map((e) => e.type)).toEqual(['turn.start', 'turn.end']);
  });

  it('clears its timeout once the predicate holds', async () => {
    const pending = hub.waitFor((s) => s.seq > 0, 5_000);
    expect(vi.getTimerCount()).toBe(1);
    hub.report({ events: [event('a')] });
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves rather than rejects on timeout, reporting that it timed out', async () => {
    const pending = hub.waitFor(() => false, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    // False means the timeout expired, not that anything failed.
    expect(result.completed).toBe(false);
    expect(result.snapshot).toMatchObject({ connected: false, viewers: 0, seq: 0 });
  });

  it('carries the state as of the timeout, not as of the call', async () => {
    hub.subscribe(() => {});
    const pending = hub.waitFor((s) => s.state.speaking === false, 1_000);
    hub.report({ state: state({ speaking: true }) });
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    expect(result.completed).toBe(false);
    expect(result.snapshot.state.speaking).toBe(true);
  });

  it('does not settle before its timeout while the predicate stays false', async () => {
    let settled = false;
    const pending = hub
      .waitFor(() => false, 1_000)
      .then((r) => {
        settled = true;
        return r;
      });
    hub.report({ events: [event('a')] });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it('settles every waiter whose predicate the same report satisfies', async () => {
    const first = hub.waitFor((s) => s.seq >= 1, 5_000);
    const second = hub.waitFor((s) => s.seq >= 1, 5_000);
    const third = hub.waitFor((s) => s.seq >= 5, 5_000);

    hub.report({ events: [event('a')] });

    expect((await first).completed).toBe(true);
    expect((await second).completed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    hub.report({ events: [event('b'), event('c'), event('d'), event('e')] });
    expect((await third).completed).toBe(true);
  });

  it('lets a caller block on the turn it just queued', async () => {
    hub.subscribe(() => {});
    hub.report({ state: state({ speaking: true, turn: 'turn-1', busy: true }) });

    const pending = hub.waitFor(
      (s) => s.events.some((e) => e.type === 'turn.end' && e.turn === 'turn-1'),
      2_000,
    );
    hub.report({ state: state(), events: [event('turn-1')] });

    const result = await pending;
    expect(result.completed).toBe(true);
    expect(result.snapshot.state.busy).toBe(false);
  });
});
