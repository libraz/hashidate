import { describe, expect, it } from 'vitest';
import { SESSION_EVENT_BUFFER_MAX, SessionEvents } from '@/engine/session/events';
import type { SessionEvent } from '@/engine/types';
import { build } from './harness';

/**
 * What the session says happened.
 */

describe('events', () => {
  it('takeEvents drains what it returns', () => {
    const { session } = build();
    session.say({ id: 'a' });
    expect(session.takeEvents()).toHaveLength(1);
    expect(session.takeEvents()).toEqual([]);
  });

  it('delivers to a listener and to takeEvents alike', () => {
    const { session } = build();
    const seen: SessionEvent[] = [];
    session.on((ev) => seen.push(ev));
    session.say({ id: 'a' });
    expect(seen).toEqual(session.takeEvents());
  });

  it('on() returns an unsubscribe that stops delivery', () => {
    const { session } = build();
    const seen: SessionEvent[] = [];
    const off = session.on((ev) => seen.push(ev));
    session.say({ id: 'a' });
    off();
    session.say({ id: 'b' });
    expect(seen.map((e) => e.turn)).toEqual(['a']);
  });

  it('leaves other listeners subscribed when one unsubscribes', () => {
    const { session } = build();
    const kept: string[] = [];
    const off = session.on(() => {});
    session.on((ev) => kept.push(ev.turn as string));
    off();
    session.say({ id: 'a' });
    expect(kept).toEqual(['a']);
  });

  it('bounds the unread buffer while listeners receive every event', () => {
    const events = new SessionEvents();
    const seen: SessionEvent[] = [];
    events.on((event) => seen.push(event));

    const total = SESSION_EVENT_BUFFER_MAX + 7;
    for (let i = 0; i < total; i += 1) {
      events.emit('turn.queued', { turn: `t${i}` });
    }

    expect(seen).toHaveLength(total);
    expect(events.take().map((event) => event.turn)).toEqual(
      Array.from({ length: SESSION_EVENT_BUFFER_MAX }, (_, i) => `t${i + 7}`),
    );
    expect(events.take()).toEqual([]);
  });
});
