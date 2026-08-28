import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { same } from '@/i18n/locale';
import type {
  Deck,
  PlacementReport,
  SessionEvent,
  SessionState,
  SlideReport,
  StreamMessage,
  Vocabulary,
} from '@/protocol';
import {
  ECHO_SECONDS,
  EVENT_LOG_MAX,
  EXPECTED_INTERRUPT_SECONDS,
  Hub,
  STATE_STALE_SECONDS,
} from '@/server/hub';

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
  avatar: { id: 'synthetic', label: same('合成リグ') },
  emotions: [{ id: 'joy', label: same('喜') }],
  expressions: [{ id: 'F_DOYA', label: same('F_DOYA') }],
  overlays: [],
  performances: [
    {
      id: 'hello',
      label: same('あいさつ'),
      group: 'greeting',
      emotion: { joy: 0.85 },
      gesture: 'wave',
      hop: null,
      sustain: false,
    },
  ],
  gestures: [{ id: 'wave', label: same('手を振る'), group: 'greeting', sustain: false }],
  hops: [{ id: 'hop', label: same('ぴょん') }],
  cue: { syntax: '[performance]', note: same('') },
  cameras: ['bust', 'upper', 'face', 'full'],
  pointing: {
    side: ['L', 'R'],
    azimuth: [-120, 120],
    elevation: [-70, 110],
    extent: [0.1, 1],
    finger: ['thumb', 'index', 'middle', 'ring', 'little'],
    note: same(''),
  },
  wardrobe: {},
  wardrobePresets: [],
  rooms: [],
  backdrops: [],
  voicePresets: [],
});

/** One document, as a store would have found it on disk. */
const deck = (id: string): Deck => ({
  id,
  label: same(`${id}.pdf`),
  pages: 12,
  bytes: 4096,
  at: 1,
});

/** What a renderer with a document layer says about it. */
const slides = (over: Partial<SlideReport> = {}): SlideReport => ({
  deck: 'intro',
  page: 3,
  pages: 12,
  ready: true,
  error: null,
  ...over,
});

/** And how it is laying the frame out: both rectangles, resolved. */
const placement = (over: Partial<PlacementReport> = {}): PlacementReport => ({
  avatar: { anchor: 'bottom-right', width: 0.32, height: 0.6, margin: 0.04 },
  slide: { anchor: 'center', width: 1, height: 1, margin: 0, fit: 'contain' },
  ...over,
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

describe('the pending queue', () => {
  it('hands the queue to a viewer the moment it attaches', () => {
    hub.queue.add([{ text: 'あ' }, { text: 'い' }]);
    const seen: StreamMessage[] = [];
    hub.subscribe((message) => seen.push(message));
    // A reload mid-stream comes back with an empty renderer queue. Re-delivering
    // on connect is what makes the only thing lost the line that was in the air.
    expect(seen).toHaveLength(1);
    expect(seen[0].commands[0]).toMatchObject({ cmd: 'queue' });
  });

  it('says nothing to a viewer attaching to an empty queue', () => {
    const seen: StreamMessage[] = [];
    hub.subscribe((message) => seen.push(message));
    expect(seen).toEqual([]);
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

/**
 * The document half of the snapshot: what is on disk, and what is up.
 *
 * The two come from opposite directions and are on the snapshot together because
 * a panel needs both to draw one control — the roster is a directory only this
 * process can see, and the page is a readout only the renderer can give.
 */
describe('documents', () => {
  it('reports no documents on a server started without a directory', () => {
    // Not an error and not an absent field: the feature is optional, and a hub
    // with no store must answer exactly as one with an empty directory does.
    expect(hub.snapshot().decks).toEqual([]);
  });

  it('reports the roster the store last read', () => {
    const withDecks = new Hub({ current: [deck('intro'), deck('closing')] });
    expect(withDecks.snapshot().decks.map((found) => found.id)).toEqual(['intro', 'closing']);
  });

  it('reads the roster on each snapshot, since the directory changes underneath', () => {
    const store = { current: [deck('intro')] };
    const withDecks = new Hub(store);
    store.current = [deck('intro'), deck('late')];
    // An operator saving a file three minutes into a broadcast is the ordinary
    // case, not an unusual one.
    expect(withDecks.snapshot().decks).toHaveLength(2);
  });

  it('says nothing about the document layer until a renderer with one reports', () => {
    // Null is how a panel tells a renderer that has no document layer from one
    // that simply has nothing up.
    expect(hub.snapshot().slides).toBeNull();
    hub.report({ state: state() });
    expect(hub.snapshot().slides).toBeNull();
  });

  it('keeps the last slide report a renderer sent', () => {
    hub.report({ slides: slides() });
    expect(hub.snapshot().slides).toEqual(slides());
    hub.report({ slides: slides({ page: 4, ready: false }) });
    expect(hub.snapshot().slides).toMatchObject({ page: 4, ready: false });
  });

  it('leaves the slide report alone for a report that omits it', () => {
    hub.report({ slides: slides() });
    hub.report({ state: state() });
    expect(hub.snapshot().slides).toEqual(slides());
  });

  it('says nothing about the frame until a renderer that composes one reports', () => {
    // Null is how a panel tells a renderer that lays the frame out from one
    // that draws only one way, exactly as it does for the document layer.
    expect(hub.snapshot().placement).toBeNull();
    hub.report({ state: state() });
    expect(hub.snapshot().placement).toBeNull();
  });

  it('serves the layout a renderer reported, so a control is drawn at what is in force', () => {
    hub.report({ placement: placement() });
    expect(hub.snapshot().placement).toEqual(placement());
    // A layout nothing sent as a command: the source was opened on it.
    const moved = placement({ avatar: { anchor: 'left', width: 0.5, height: 0.5, margin: 0 } });
    hub.report({ placement: moved });
    expect(hub.snapshot().placement).toEqual(moved);
  });

  it('leaves the layout alone for a report that omits it', () => {
    hub.report({ placement: placement() });
    hub.report({ state: state() });
    expect(hub.snapshot().placement).toEqual(placement());
  });

  it('keeps serving both while the state is stale', () => {
    hub.subscribe(() => {});
    const withDecks = new Hub({ current: [deck('intro')] });
    withDecks.subscribe(() => {});
    withDecks.report({ state: state(), slides: slides(), placement: placement() });
    vi.advanceTimersByTime((STATE_STALE_SECONDS + 1) * 1000);

    const snapshot = withDecks.snapshot();
    // A stale state is a lie about what the avatar is doing right now. What is
    // in the directory, which page was reached and what shape the frame was in
    // are still true, and are what an operator with nothing connected is most
    // likely to be looking at.
    expect(snapshot.state).toEqual({});
    expect(snapshot.decks).toHaveLength(1);
    expect(snapshot.slides).toEqual(slides());
    expect(snapshot.placement).toEqual(placement());
  });
});

/**
 * The setup a renderer opened at the top of the broadcast has to be handed.
 *
 * `standing.ts` decides *what* is kept; this is about the hub actually keeping
 * it and getting it to a viewer that was not there when it was chosen. That is
 * the whole reason a control panel and a renderer can be two pages: the panel is
 * where the show is set up, and the renderer is opened last.
 */
describe('the setup, replayed on connect', () => {
  /** Attach a viewer and hand back the commands it was given on connect. */
  const attach = (): StreamMessage['commands'] => {
    const seen: StreamMessage[] = [];
    hub.subscribe((message) => seen.push(message));
    return seen.flatMap((message) => message.commands);
  };

  it('hands a late viewer the shot, the set and the costume', () => {
    hub.send({
      type: 'command',
      commands: [
        { cmd: 'camera', frame: 'full' },
        { cmd: 'backdrop', id: 'night' },
        { cmd: 'wear', slot: 'top', item: 'coat' },
      ],
    });
    expect(attach()).toEqual([
      { cmd: 'wear', slot: 'top', item: 'coat' },
      { cmd: 'camera', frame: 'full' },
      { cmd: 'backdrop', id: 'night' },
    ]);
  });

  it('says nothing to a viewer attaching before anything has been set', () => {
    expect(attach()).toEqual([]);
  });

  it('leaves out the commands that were a moment rather than a setting', () => {
    hub.send({
      type: 'command',
      commands: [
        { cmd: 'camera', frame: 'face' },
        { cmd: 'gesture', id: 'wave' },
        { cmd: 'say', text: 'あ' },
        { cmd: 'perform', id: 'hello' },
      ],
    });
    expect(attach()).toEqual([{ cmd: 'camera', frame: 'face' }]);
  });

  it('sends the setup and the queue in one frame, setup first', () => {
    // Two frames would be wrong rather than merely untidy: a renderer told to
    // load a different avatar holds everything behind it until that avatar is
    // standing, and a queue arriving on its own after the hold had ended would
    // be applied to the scene that was being replaced.
    hub.send({ type: 'command', commands: [{ cmd: 'avatar', id: 'other' }] });
    hub.queue.add([{ text: 'あ' }]);
    const seen: StreamMessage[] = [];
    hub.subscribe((message) => seen.push(message));
    expect(seen).toHaveLength(1);
    expect(seen[0].commands.map((c) => c.cmd)).toEqual(['avatar', 'queue']);
  });

  it('keeps the setup for every later viewer, not just the first', () => {
    hub.send({ type: 'command', commands: [{ cmd: 'room', id: 'hall' }] });
    expect(attach()).toEqual([{ cmd: 'room', id: 'hall' }]);
    expect(attach()).toEqual([{ cmd: 'room', id: 'hall' }]);
  });

  it('does not record what it replays, so a reconnect cannot double an outfit', () => {
    hub.send({ type: 'command', commands: [{ cmd: 'wear', slot: 'top', item: 'coat' }] });
    attach();
    expect(attach()).toEqual([{ cmd: 'wear', slot: 'top', item: 'coat' }]);
  });

  it('carries the newest value of a setting that was changed twice', () => {
    hub.send({ type: 'command', commands: [{ cmd: 'camera', frame: 'face' }] });
    hub.send({ type: 'command', commands: [{ cmd: 'camera', frame: 'bust' }] });
    expect(attach()).toEqual([{ cmd: 'camera', frame: 'bust' }]);
  });

  it('is not disturbed by the queue frames the hub sends on its own', () => {
    hub.send({ type: 'command', commands: [{ cmd: 'camera', frame: 'upper' }] });
    hub.queue.add([{ text: 'あ' }]);
    hub.publishQueue();
    expect(attach().map((c) => c.cmd)).toEqual(['camera', 'queue']);
  });
});

/**
 * What the hub does with a turn that has ended, and with a rewind.
 *
 * The interesting case is the interaction between the two: a rewind that cuts
 * the line on air produces the same `turn.interrupted` the kill switch does, and
 * the hub has to tell them apart — one empties the pending list, the other must
 * leave the list the rewind had just filled.
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

  it('answers null for an id the history does not have, and sends nothing', () => {
    const frames: StreamMessage[] = [];
    hub.subscribe((message) => frames.push(message));
    expect(hub.rewind('nope', 'from', { interrupt: true })).toBeNull();
    expect(frames).toEqual([]);
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
describe('an event reported by more than one renderer', () => {
  const ending = (turn: string) => hub.snapshot().events.filter((e) => e.turn === turn);

  it('is logged once, however many renderers say it', () => {
    const id = hub.queue.add([{ text: 'a' }])[0].id;
    for (let i = 0; i < 3; i += 1) {
      hub.report({ events: [event(id, 'turn.end')] });
      vi.advanceTimersByTime(200);
    }
    expect(ending(id)).toHaveLength(1);
  });

  it('still files the turn, since the first of them did', () => {
    const id = hub.queue.add([{ text: 'a' }])[0].id;
    hub.report({ events: [event(id, 'turn.end')] });
    hub.report({ events: [event(id, 'turn.end')] });
    expect(hub.queue.list()).toEqual([]);
    expect(hub.queue.history().map((e) => e.id)).toEqual([id]);
  });

  it('does not swallow a line said a second time under the same id', () => {
    const id = hub.queue.add([{ text: 'a' }])[0].id;
    hub.report({ events: [event(id, 'turn.end')] });
    // Put back by a rewind and said again. The start between the two endings is
    // what tells a second ending from a second report of the first.
    hub.report({ events: [event(id, 'turn.start')] });
    hub.report({ events: [event(id, 'turn.end')] });

    expect(ending(id).map((e) => e.type)).toEqual(['turn.end', 'turn.start', 'turn.end']);
  });

  it('stops treating a repeat as an echo once it is old enough to be a second one', () => {
    const id = hub.queue.add([{ text: 'a' }])[0].id;
    hub.report({ events: [event(id, 'turn.end')] });
    vi.advanceTimersByTime(ECHO_SECONDS * 1000);
    hub.report({ events: [event(id, 'turn.end')] });

    expect(ending(id)).toHaveLength(2);
  });

  it('leaves alone an event that is about no turn in particular', () => {
    // `queue.empty` says a list reached a state rather than that something
    // happened to a line, so there is nothing to match a repeat against.
    hub.report({ events: [{ type: 'queue.empty' }] });
    hub.report({ events: [{ type: 'queue.empty' }] });
    expect(hub.snapshot().events.filter((e) => e.type === 'queue.empty')).toHaveLength(2);
  });
});

/**
 * Where the server says it is serving from.
 *
 * Read by the native shell, which finds a listener on the control port and has
 * to decide whether it is this checkout's server or another one's. See
 * `serverRootsSchema`.
 */
describe('the directories on the snapshot', () => {
  const roots = {
    document: '/work/hashidate/dist',
    slides: '/work/hashidate/show/slides',
    motions: '/work/hashidate/show/motions',
  };

  it('carries the three a server was started on', () => {
    expect(new Hub(null, null, roots).snapshot().roots).toEqual(roots);
  });

  it('says nothing at all from a hub that was never told', () => {
    // Absent rather than null: a key holding null would be a server claiming to
    // know where it is serving from and answering nowhere.
    expect(new Hub().snapshot()).not.toHaveProperty('roots');
  });
});
