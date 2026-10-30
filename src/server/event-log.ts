import type { SessionEvent } from '../protocol';

/**
 * The history of what the renderers reported, and the memory that keeps several
 * renderers saying the same thing from being logged more than once.
 *
 * Holds the bounded event list, the sequence counter that numbers it, and the
 * arrival-ordered id sets behind `isEcho` and the cue claims. Knows nothing of
 * the queue or the viewers: the hub decides what is logged and what acts on it.
 */

/**
 * How many events the log keeps. Long enough that a caller polling once a
 * second never misses one, short enough that a viewer left running overnight
 * does not grow the process.
 */
export const EVENT_LOG_MAX = 512;

/**
 * How long an event already logged stays the same event when it arrives again.
 *
 * Every renderer reports what it did, and they are all doing the same thing —
 * so one line ending produces a `turn.end` per renderer, a fraction of a second
 * apart. Logged as they arrive, a queue of ten lines reads as thirty turns to
 * an orchestrator polling `/api/events`, and an LLM loop waiting for a line to
 * finish is woken once per renderer instead of once per line.
 *
 * Turn lifecycle events are not timed at all: a turn id names one line once —
 * the queue mints a fresh one for a line put back by a rewind — so its start is
 * kept once, and its ending once in whichever form arrived first, however far
 * apart renderers report them. See `turnKey`. This window is for the rest: a
 * drop names a set of lines, and the same set can be dropped again later.
 */
export const ECHO_SECONDS = 2.0;

/** The turn lifecycle events matched by id rather than by `ECHO_SECONDS`. */
const TURN_EVENTS = new Set<SessionEvent['type']>(['turn.start', 'turn.end', 'turn.interrupted']);

/**
 * The key a turn lifecycle event is kept once under. `turn.end` and
 * `turn.interrupted` share one: a line ends once, however each renderer saw it.
 */
function turnKey(type: SessionEvent['type'], turn: string): string {
  return type === 'turn.start' ? `turn.start:${turn}` : `turn.final:${turn}`;
}

/**
 * What an event is about, or null when it is about nothing in particular.
 *
 * Turn lifecycle events, drops and inline cue fires name something worth
 * matching across renderers. `queue.empty` and `queue.replaced` say that a list
 * reached a state rather than that a thing happened to a line, so a second
 * renderer saying it too is left in the log. BGM cue ids are additionally kept
 * beyond the short echo window by `acceptedCueIds` below.
 */
function eventSubject(event: SessionEvent): string | null {
  if (event.type === 'cue.fire' && event.cueId !== undefined) {
    return `cue:${event.cueId}`;
  }
  if (event.turn !== undefined) return `turn:${event.turn}`;
  if (event.turns !== undefined) return `turns:${event.turns.join(',')}`;
  return null;
}

/** Add a key to an arrival-ordered set, dropping the oldest past `EVENT_LOG_MAX`. */
function remember(keys: Set<string>, key: string): void {
  keys.add(key);
  if (keys.size <= EVENT_LOG_MAX) return;
  const oldest = keys.values().next().value;
  if (oldest !== undefined) keys.delete(oldest);
}

export class EventLog {
  private readonly events: SessionEvent[] = [];
  /**
   * BGM cues are emitted by every renderer, so the event log's short echo
   * window is not enough to keep a reload from applying one twice. Keep the
   * accepted cue ids in arrival order and bound the memory like the event log.
   */
  private readonly acceptedCueIds = new Set<string>();
  private counter = 0;
  /**
   * `turnKey`s of the lifecycle events already logged, in arrival order and
   * bounded like the event log. See `ECHO_SECONDS`.
   */
  private readonly acceptedTurnEvents = new Set<string>();

  /** The sequence number of the newest event logged. */
  get seq(): number {
    return this.counter;
  }

  /** Log an event under the next sequence number. */
  append(event: SessionEvent, at: number): void {
    this.counter += 1;
    this.events.push({ ...event, seq: this.counter, at });
  }

  /** Drop the oldest events past `EVENT_LOG_MAX`. */
  trim(): void {
    if (this.events.length > EVENT_LOG_MAX) {
      this.events.splice(0, this.events.length - EVENT_LOG_MAX);
    }
  }

  /** Every event still held, oldest first. */
  entries(): SessionEvent[] {
    return [...this.events];
  }

  /** Whether `id` is new; true consumes it, so a second claim gets false. */
  claimCue(id: string): boolean {
    if (this.acceptedCueIds.has(id)) return false;
    remember(this.acceptedCueIds, id);
    return true;
  }

  /** Record a lifecycle event the server logged itself, so a renderer's copy is an echo. */
  markFiled(event: SessionEvent & { turn: string }): void {
    remember(this.acceptedTurnEvents, turnKey(event.type, event.turn));
  }

  /**
   * Whether another renderer already reported this. See `ECHO_SECONDS`.
   *
   * Normal events that name a turn or a set of them are matched here: those are
   * the ones an orchestrator counts. Inline BGM cues take the stronger bounded
   * id path in `routeBgmCue`. We scan all recent events about the subject so a
   * coalesced [start, end] batch cannot hide an earlier same-type event behind
   * the other type.
   */
  isEcho(event: SessionEvent, at: number): boolean {
    if (TURN_EVENTS.has(event.type) && event.turn !== undefined) {
      const key = turnKey(event.type, event.turn);
      if (this.acceptedTurnEvents.has(key)) return true;
      remember(this.acceptedTurnEvents, key);
      return false;
    }
    const subject = eventSubject(event);
    if (subject === null) return false;
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const logged = this.events[i];
      if (eventSubject(logged) !== subject) continue;
      // A renderer may coalesce [start, end] while another renderer reports
      // those events separately. Compare both subject *and* type across the
      // whole short window; looking only at the newest subject lets the
      // different event type in the batch hide its own duplicate.
      if (logged.type === event.type && Math.abs(at - (logged.at ?? 0)) < ECHO_SECONDS) {
        return true;
      }
    }
    return false;
  }

  since(seq: number): SessionEvent[] {
    return this.events.filter((event) => (event.seq ?? 0) > seq);
  }
}
