import type {
  ReportBody,
  SessionEvent,
  SessionState,
  Snapshot,
  StreamMessage,
  Vocabulary,
  VoiceReport,
} from '../protocol';
import { TurnQueue } from './queue';

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
  private voice: VoiceReport | null = null;
  private stateAt = 0;

  /**
   * The pending turns, and the authority on what they are. See `queue.ts`.
   *
   * It lives here rather than beside the routes because both of the things that
   * keep it true are things the hub already sees: a viewer attaching, which is
   * when the list has to be re-delivered, and a `turn.end` arriving, which is
   * when an entry stops being pending.
   */
  readonly queue = new TurnQueue();

  // --- downstream (server -> viewer) ----------------------------------------

  /**
   * Attach a viewer. Returns the detach.
   *
   * The pending queue goes down the new connection immediately. That is what
   * makes a viewer reload survivable mid-stream: the renderer comes back with an
   * empty queue and is handed the script back before it has said anything, so
   * the only thing lost is the line that was in the air.
   */
  subscribe(listener: ViewerListener): () => void {
    this.clients.add(listener);
    if (this.queue.length > 0) listener({ type: 'command', commands: [this.queue.command()] });
    return () => this.unsubscribe(listener);
  }

  /**
   * Push the queue to every viewer, and answer how many got it.
   *
   * Every edit ends here. Sending the whole list on each one is the deliberate
   * trade `queueCommandSchema` describes: a renderer keeps the audio it has
   * already made for any line whose words did not change, so a reorder costs one
   * message and no synthesis.
   */
  publishQueue(): number {
    return this.send({ type: 'command', commands: [this.queue.command()] });
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
    if (body.voice !== undefined) this.voice = body.voice;
    for (const event of body.events ?? []) {
      this.seq += 1;
      this.events.push({ ...event, seq: this.seq, at: event.at ?? now() });
      // A line the renderer has finished with stops being pending. Driven off
      // the event rather than off the reported `queued` count, because the count
      // says how many are left and not which one left — and the panel is looking
      // at rows, not at a number.
      if (event.type === 'turn.end' && event.turn) this.queue.complete(event.turn);
      // An interrupt drops everything pending in the renderer. Mirroring it here
      // is what keeps the two lists the same: without it the queue would be
      // re-delivered on the next edit and the stream would resume a script the
      // operator had just killed.
      if (event.type === 'turn.interrupted') this.queue.clear();
      if (event.type === 'queue.dropped') for (const id of event.turns ?? []) this.queue.remove(id);
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
      // Not gated on `fresh`, unlike the state above. A stale state is a lie
      // about what the avatar is doing right now; the chain and the queue are
      // settings and a script, and both are still true with nothing connected —
      // which is exactly when an operator is most likely to be looking at them.
      voice: this.voice,
      queue: this.queue.list(),
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
