import type {
  Command,
  LabelledId,
  PlacementReport,
  QueueEntry,
  ReportBody,
  ServerRoots,
  SessionEvent,
  SessionState,
  SlideReport,
  Snapshot,
  SpeechState,
  StreamMessage,
  Tuning,
  Vocabulary,
  VoiceReport,
} from '../protocol';
import type { DeckSource } from './decks';
import { type RewindMode, TurnQueue } from './queue';
import type { SpeechSource } from './speech';
import { Standing } from './standing';

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

/**
 * How long an interrupt this server sent stays expected.
 *
 * A rewind that cuts the line on air sends `interrupt` and the rewound list in
 * the same breath, and the renderer answers with `turn.interrupted` a moment
 * later. That event normally means the operator hit the kill switch, and this
 * hub answers it by emptying the pending list — which, arriving just after a
 * rewind, would empty the list the rewind had only just filled.
 *
 * The window is long enough to cover a renderer that is a frame or two behind
 * and short enough that it cannot swallow a genuine interrupt the operator
 * meant.
 *
 * **What is expected is a turn, not a report.** More than one renderer is the
 * ordinary case rather than the odd one — the panel's preview and whatever is
 * on air are two, and the native shell's stage window is a third — and one
 * interrupt cuts the same line in all of them, so the same `turn.interrupted`
 * comes back once per renderer. Expecting a single report and then forgetting
 * meant the second renderer's echo read as the operator hitting stop, and the
 * list the rewind had just filled was emptied by the rewind's own answer. So
 * the first echo inside the window says which turn was cut, and every echo of
 * that same turn is the one interrupt being reported again. An echo naming a
 * *different* turn is somebody having pressed something, and still empties the
 * list: a rewind has already cut the turn it named, so a later interrupt can
 * only be about a line that came after it.
 */
export const EXPECTED_INTERRUPT_SECONDS = 5.0;

/**
 * How long an event already logged stays the same event when it arrives again.
 *
 * Every renderer reports what it did, and they are all doing the same thing —
 * so one line ending produces a `turn.end` per renderer, a fraction of a second
 * apart. Logged as they arrive, a queue of ten lines reads as thirty turns to
 * an orchestrator polling `/api/events`, and an LLM loop waiting for a line to
 * finish is woken once per renderer instead of once per line.
 *
 * A repeat is only an echo when nothing has happened to that turn in between:
 * a line put back by a rewind is said again under the same id, and its second
 * `turn.end` is a second ending rather than a second report of the first. The
 * `turn.start` that must sit between them is what tells the two apart, and the
 * window is a second guard for the same distinction.
 */
export const ECHO_SECONDS = 2.0;

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

/**
 * What an event is about, or null when it is about nothing in particular.
 *
 * Only the turn lifecycle and a drop name something, and only those are worth
 * matching a repeat against. `queue.empty` and `queue.replaced` say that a list
 * reached a state rather than that a thing happened to a line, so a second
 * renderer saying it too is left in the log.
 */
function eventSubject(event: SessionEvent): string | null {
  if (event.turn !== undefined) return `turn:${event.turn}`;
  if (event.turns !== undefined) return `turns:${event.turns.join(',')}`;
  return null;
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
  private tuning: Tuning | null = null;
  private slides: SlideReport | null = null;
  private placement: PlacementReport | null = null;
  private avatars: LabelledId[] = [];
  private stateAt = 0;
  /** See `EXPECTED_INTERRUPT_SECONDS`. Epoch seconds, zero for none pending. */
  private interruptExpectedUntil = 0;
  /**
   * Which turn the interrupt inside that window cut, once a renderer has said.
   *
   * Null until the first echo arrives, because the line on air is the
   * renderer's to name: this hub knows it only from the last report, which may
   * be a report behind by the time the interrupt lands.
   */
  private interruptExpectedTurn: string | null = null;

  /**
   * The pending turns, and the authority on what they are. See `queue.ts`.
   *
   * It lives here rather than beside the routes because both of the things that
   * keep it true are things the hub already sees: a viewer attaching, which is
   * when the list has to be re-delivered, and a `turn.end` arriving, which is
   * when an entry stops being pending.
   */
  readonly queue = new TurnQueue();

  /**
   * The setup, so a renderer opened at the top of the broadcast is not opened on
   * defaults. See `standing.ts` for what counts as one and what does not.
   */
  private readonly standing = new Standing();

  /**
   * The documents on disk, or nothing when the server was started without any.
   *
   * Handed in rather than reached for, because it is the one thing here that
   * touches the filesystem: a hub built with none is a server with no document
   * directory and says so with an empty roster, and a test can point one at a
   * directory it made itself. See `decks.ts`.
   *
   * The speech watch arrives the same way and for the same reason: it is the
   * server's own observation of another process rather than anything a viewer
   * reported, and a hub built without one is a hub that was never told to look.
   *
   * The roots are the third of the same kind: paths belong to the process that
   * parsed them, and a hub built without any is a hub that cannot say which
   * checkout it is. See `serverRootsSchema` for who asks and why.
   */
  constructor(
    private readonly decks: DeckSource | null = null,
    private readonly speech: SpeechSource | null = null,
    private readonly roots: ServerRoots | null = null,
  ) {}

  // --- downstream (server -> viewer) ----------------------------------------

  /**
   * Attach a viewer. Returns the detach.
   *
   * The setup and the pending queue both go down the new connection
   * immediately. That is what makes a viewer reload survivable mid-stream: the
   * renderer comes back with nothing and is handed the avatar, the costume, the
   * set and the script back before it has said anything, so the only thing lost
   * is the line that was in the air.
   *
   * The setup goes first, in one frame with the queue. A renderer told to load a
   * different avatar holds everything behind it until that avatar is standing —
   * including the queue, which is why the two cannot be sent as two frames: the
   * queue arriving on its own after the hold had ended would be applied to the
   * old scene.
   */
  subscribe(listener: ViewerListener): () => void {
    this.clients.add(listener);
    const commands = this.standing.commands();
    if (this.queue.length > 0) commands.push(this.queue.command());
    if (commands.length > 0) listener({ type: 'command', commands });
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

  /**
   * Send something already said round again, and push the result.
   *
   * Here rather than beside the routes because it is the one queue operation
   * that also has to talk to the renderer about something other than the list:
   * cutting the line on air is a command, and it has to travel in the same frame
   * as the new list. Sent as two, a renderer that applied the interrupt and then
   * lost the connection would be left holding a queue that had just been
   * rewound out from under it.
   *
   * Returns the entries that went back, or null for an id the history no longer
   * has.
   */
  rewind(id: string, mode: RewindMode, { interrupt = false } = {}): QueueEntry[] | null {
    const added = this.queue.rewind(id, mode);
    if (added === null) return null;
    const commands: Command[] = [];
    if (interrupt) {
      // Before the send, not after: the report can come back inside the same
      // tick as the write on loopback.
      this.interruptExpectedUntil = now() + EXPECTED_INTERRUPT_SECONDS;
      this.interruptExpectedTurn = null;
      commands.push({ cmd: 'interrupt' });
    }
    commands.push(this.queue.command());
    this.send({ type: 'command', commands });
    return added;
  }

  /**
   * Whether this interrupt is one we asked for. True for every renderer's echo
   * of it, and false for an interrupt that names any other turn.
   *
   * See `EXPECTED_INTERRUPT_SECONDS` for why it is counted by turn rather than
   * by report.
   */
  private isExpectedInterrupt(turn: string | undefined): boolean {
    if (now() >= this.interruptExpectedUntil) return false;
    // An interrupt that names nothing is still one interrupt, and every
    // renderer answers it the same way, so the empty string is a turn like any
    // other here.
    const named = turn ?? '';
    if (this.interruptExpectedTurn === null) {
      this.interruptExpectedTurn = named;
      return true;
    }
    return this.interruptExpectedTurn === named;
  }

  /**
   * Whether another renderer already reported this. See `ECHO_SECONDS`.
   *
   * Only events that name a turn or a set of them are matched: those are the
   * ones an orchestrator counts, and they are the ones with a subject to match
   * on. The scan stops at the newest event about the same subject, so a repeat
   * only counts as an echo while nothing has happened to that turn in between.
   */
  private isEcho(event: SessionEvent, at: number): boolean {
    const subject = eventSubject(event);
    if (subject === null) return false;
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const logged = this.events[i];
      if (eventSubject(logged) !== subject) continue;
      return logged.type === event.type && at - (logged.at ?? 0) < ECHO_SECONDS;
    }
    return false;
  }

  /**
   * Hand one message to every connected viewer. Returns the count.
   *
   * Every command this server sends passes through here, which is why the setup
   * is folded in here rather than beside the route that received it: the count
   * this answers is how many viewers heard it, and a viewer that will only
   * connect later has to be able to hear it too.
   */
  send(message: StreamMessage): number {
    for (const command of message.commands) this.standing.record(command);
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
    if (body.tuning !== undefined) this.tuning = body.tuning;
    if (body.slides !== undefined) this.slides = body.slides;
    if (body.placement !== undefined) this.placement = body.placement;
    // Fixed for the life of a renderer, so it rides with the vocabulary rather
    // than on the timer. Not cleared by a report that omits it.
    if (body.avatars) this.avatars = body.avatars;
    for (const event of body.events ?? []) {
      const at = event.at ?? now();
      // Dropped before anything acts on it, not merely kept out of the log:
      // the second renderer's answer to one interrupt must not reach the kill
      // switch below, and a turn that has already been filed does not need
      // filing again. See `ECHO_SECONDS`.
      if (this.isEcho(event, at)) continue;
      this.seq += 1;
      this.events.push({ ...event, seq: this.seq, at });
      // A line the renderer has finished with stops being pending and starts
      // being history. Driven off the event rather than off the reported
      // `queued` count, because the count says how many are left and not which
      // one left — and the panel is looking at rows, not at a number.
      if (event.type === 'turn.end' && event.turn) this.queue.complete(event.turn);
      // An interrupt drops everything pending in the renderer. Mirroring it here
      // is what keeps the two lists the same: without it the queue would be
      // re-delivered on the next edit and the stream would resume a script the
      // operator had just killed. The line that was cut off is filed rather than
      // dropped — it was said, if only partly, and it is the one most likely to
      // be wanted back.
      if (event.type === 'turn.interrupted') {
        if (event.turn) this.queue.complete(event.turn, { interrupted: true });
        if (!this.isExpectedInterrupt(event.turn)) this.queue.clear();
      }
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
      // Settings too, and on the same footing: a fader is worth drawing at the
      // value it will resume at.
      tuning: this.tuning,
      // And the layout, for the same reason again — with nothing connected it
      // is the last shape the frame had, which is the shape it will come back
      // in when the source is reopened.
      placement: this.placement,
      avatars: this.avatars,
      // The roster the store last read, not one read here: the snapshot is
      // assembled in one turn and the directory is on disk. See `Decks.current`
      // for who pays for the rescan and why the answer may be a poll behind.
      decks: this.decks?.current ?? [],
      // A renderer with no document layer never reports one, which is how a
      // panel tells "no such layer" from "nothing up".
      slides: this.slides,
      // A hub with nothing watching says `absent`, which is the truthful answer
      // to "is the voice up" from a server that is not looking at it.
      speech: this.speech?.current ?? ('absent' satisfies SpeechState),
      queue: this.queue.list(),
      // Omitted rather than sent as null when there are none: the field means
      // "this server knows where it is serving from", and a key holding null
      // would be a server claiming to know and answering nowhere.
      ...(this.roots === null ? {} : { roots: this.roots }),
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
