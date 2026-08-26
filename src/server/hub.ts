import type {
  ReportBody,
  SessionEvent,
  SessionState,
  Snapshot,
  StreamMessage,
  Vocabulary,
} from '../protocol';

/**
 * Fan-out to connected viewers, plus the last state they reported.
 *
 * Knows nothing about HTTP: the routes turn a request into one of these calls
 * and turn the result back into JSON, which keeps the interesting part — the
 * event log and the waiting — testable without a socket.
 */

/**
 * How many events the log keeps. Long enough that a caller polling once a
 * second never misses one, short enough that a viewer left running overnight
 * does not grow the process.
 */
export const EVENT_LOG_MAX = 512;

/**
 * How long a reported state stays believable.
 *
 * The viewer reports on a timer, so silence means it is gone — a tab that was
 * closed leaves its last state behind, and answering with it would tell the
 * orchestrator the avatar is still mid-sentence forever.
 */
export const STATE_STALE_SECONDS = 3.0;

/** One connected viewer's down-channel. */
export type ViewerListener = (message: StreamMessage) => void;

/** What `waitFor` settles with. */
export interface WaitResult {
  snapshot: Snapshot;
  /** False means the timeout expired, not that anything failed. */
  completed: boolean;
}

interface Waiter {
  predicate: (snapshot: Snapshot) => boolean;
  resolve: (result: WaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Epoch seconds, which is the unit the events carry their `at` in. */
function now(): number {
  return Date.now() / 1000;
}

export class Hub {
  // The original guarded every field here with a re-entrant lock and woke
  // waiters through a condition variable. Node runs one thread and nothing
  // below yields part-way through, so there is no window for a second caller
  // to see half a report: the lock is gone, and the condition variable is the
  // set of pending promises that `report` settles.
  private readonly clients = new Set<ViewerListener>();
  private readonly waiters = new Set<Waiter>();
  private readonly events: SessionEvent[] = [];
  private seq = 0;
  private state: Partial<SessionState> = {};
  private vocabulary: Partial<Vocabulary> = {};
  private stateAt = 0;

  // --- downstream (server -> viewer) ----------------------------------------

  /** Attach a viewer. Returns the detach. */
  subscribe(listener: ViewerListener): () => void {
    this.clients.add(listener);
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener: ViewerListener): void {
    this.clients.delete(listener);
  }

  /** Hand one message to every connected viewer. Returns the count. */
  send(message: StreamMessage): number {
    for (const listener of this.clients) listener(message);
    return this.clients.size;
  }

  get viewers(): number {
    return this.clients.size;
  }

  // --- upstream (viewer -> server) ------------------------------------------

  /** Take one report from a viewer. Returns the newest sequence number. */
  report(body: ReportBody): number {
    if (body.state !== undefined) {
      this.state = body.state;
      this.stateAt = now();
    }
    if (body.vocabulary) this.vocabulary = body.vocabulary;
    for (const event of body.events ?? []) {
      this.seq += 1;
      this.events.push({ ...event, seq: this.seq, at: event.at ?? now() });
    }
    if (this.events.length > EVENT_LOG_MAX) {
      this.events.splice(0, this.events.length - EVENT_LOG_MAX);
    }
    this.wake();
    return this.seq;
  }

  snapshot(since?: number): Snapshot {
    const fresh = now() - this.stateAt < STATE_STALE_SECONDS;
    return {
      connected: this.clients.size > 0 && fresh,
      viewers: this.clients.size,
      seq: this.seq,
      state: fresh ? this.state : {},
      vocabulary: this.vocabulary,
      events: since === undefined ? [...this.events] : this.since(since),
    };
  }

  /**
   * Settle when `predicate(snapshot)` holds, or when the timeout expires.
   *
   * Lets a caller say "play this line and tell me when it is done" in one
   * request instead of polling. The orchestrator is usually an LLM loop that
   * has nothing to do until the character stops talking.
   *
   * The predicate is evaluated once up front and then on every `report`, so a
   * turn that ended before the wait started still resolves it.
   */
  waitFor(predicate: (snapshot: Snapshot) => boolean, timeoutMs: number): Promise<WaitResult> {
    const immediate = this.snapshot();
    if (predicate(immediate)) return Promise.resolve({ snapshot: immediate, completed: true });
    return new Promise<WaitResult>((resolve) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve({ snapshot: this.snapshot(), completed: false });
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private since(seq: number): SessionEvent[] {
    return this.events.filter((event) => (event.seq ?? 0) > seq);
  }

  private wake(): void {
    if (this.waiters.size === 0) return;
    const snapshot = this.snapshot();
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(snapshot)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve({ snapshot, completed: true });
    }
  }
}
