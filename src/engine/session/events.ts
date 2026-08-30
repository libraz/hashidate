import type { SessionEvent, SessionEventType } from '../types';

/**
 * What the session tells the outside world happened.
 *
 * Two ways out, and both are live at once: a listener is called as the event
 * happens, which is what the renderer's control client wants, and the same
 * event is kept in a buffer for whoever polls. The control server does the
 * second — it reports on a timer and must not lose an event that landed
 * between two of them.
 */

export type SessionListener = (ev: SessionEvent) => void;

/** Everything an event carries besides the type it is. */
type EventPayload = Omit<SessionEvent, 'type'>;

export class SessionEvents {
  private _events: SessionEvent[] = [];
  private readonly _listeners = new Set<SessionListener>();

  on(fn: SessionListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit(type: SessionEventType, extra: EventPayload = {}): void {
    const ev: SessionEvent = { type, ...extra };
    this._events.push(ev);
    for (const fn of this._listeners) fn(ev);
  }

  /** Drain the events accumulated since the last call. */
  take(): SessionEvent[] {
    const out = this._events;
    this._events = [];
    return out;
  }
}
