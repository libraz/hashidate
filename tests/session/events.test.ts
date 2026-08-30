import { describe, expect, it } from 'vitest';
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
});
