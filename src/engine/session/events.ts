import type { SessionEvent, SessionEventType } from '../types';

/**
 * What the session tells the outside world happened.
 *
 * Production code consumes this through the live listener path, which delivers
 * each event as it happens. `take()` is the observation and drain surface used
 * by tests; its unread buffer is bounded and keeps the newest events.
 */

export type SessionListener = (ev: SessionEvent) => void;

/**
 * How many unread events the test-observation buffer keeps.
 *
 * This matches the server's `EVENT_LOG_MAX`, keeping the in-process surface
 * bounded without limiting live listener delivery.
 */
export const SESSION_EVENT_BUFFER_MAX = 512;

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
    if (this._events.length > SESSION_EVENT_BUFFER_MAX) {
      this._events.splice(0, this._events.length - SESSION_EVENT_BUFFER_MAX);
    }
    for (const fn of this._listeners) fn(ev);
  }

  /** Drain the events accumulated since the last call. */
  take(): SessionEvent[] {
    const out = this._events;
    this._events = [];
    return out;
  }
}
