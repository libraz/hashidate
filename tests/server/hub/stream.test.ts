import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamMessage } from '@/protocol';
import { ECHO_SECONDS, EVENT_LOG_MAX, Hub } from '@/server/hub';
import { EPOCH_MS, event, frame, state } from './fixtures';

/**
 * Fan-out and the sequenced event log: who hears a command, what comes
 * back, and what happens when three renderers report the same thing.
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
