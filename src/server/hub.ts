import type {
  AvatarStatus,
  Command,
  LabelledId,
  PlacementReport,
  QueueEntry,
  Recording,
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
import type { CommandFate } from '../protocol/messages';
import type { BgmSource } from './bgm';
import { BgmCoordinator } from './bgm-state';
import type { DeckSource } from './decks';
import { type RewindMode, TurnQueue } from './queue';
import type { AppendResult, OpenOptions, RecordingStore } from './recordings';
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
 * How long a recording keeps rolling after the last line of a script.
 *
 * A take that cuts on the same frame the last syllable ends reads as a
 * dropped connection rather than as an ending — the mouth is still closing and
 * the character is still coming back to rest. This is long enough for both and
 * short enough that nobody trims it.
 *
 * It is a delay rather than a fixed tail because the queue can refill inside
 * it: a line queued while this is counting down cancels the stop, and the
 * recording carries straight on.
 */
export const RECORD_TAIL_SECONDS = 1.2;

/**
 * How long a stopped recording waits for the renderer's last chunk.
 *
 * `stop` goes down the same one-way channel every command does, so the file
 * cannot be closed on the send: the encoder still has a second of frames in it
 * and posts them after it has wound down. Normally the flush arrives flagged as
 * the last one and closes the file immediately; this is the answer for the case
 * where it never arrives at all, because the renderer was closed or reloaded
 * between the stop and the flush. A file left open forever would be worse than
 * one missing its final second.
 */
export const RECORD_FLUSH_SECONDS = 6.0;

/** How long an owner-less live renderer may be absent before its take is closed. */
export const RECORD_ORPHAN_SECONDS = 6.0;

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
 * the queue mints a fresh one for a line put back by a rewind — so its start,
 * end and interrupt are each kept once however far apart renderers report them.
 * See `acceptedTurnEvents`. This window is for the rest: a drop names a set of
 * lines, and the same set can be dropped again later.
 */
export const ECHO_SECONDS = 2.0;

/** The turn lifecycle events matched by id rather than by `ECHO_SECONDS`. */
const TURN_EVENTS = new Set<SessionEvent['type']>(['turn.start', 'turn.end', 'turn.interrupted']);

/** The verbs that act on the server's queue, and are applied to it before any renderer. */
const QUEUE_VERBS = new Set<Command['cmd']>(['say', 'queue', 'clear', 'interrupt']);

/** What became of one command in a caller's batch. See `commandFateSchema`. */
export interface CommandOutcome {
  /** How many viewers the batch was handed to. */
  viewers: number;
  /** One per command, in order. */
  fates: CommandFate[];
  /** The turn id each `say` was queued under, by position; undefined for the rest. */
  ids: (string | undefined)[];
}

/** One connected viewer's down-channel. */
export type ViewerListener = (message: StreamMessage) => void;

/** One SSE connection, optionally identified by the renderer that owns it. */
interface ViewerClient {
  listener: ViewerListener;
  rendererId?: string;
  /** Attached mid-line, and held until the line on air ends. See `subscribe`. */
  held?: boolean;
}

/** Internal owner marker for a legacy report that carried no renderer id. */
const ANONYMOUS_OWNER = '';

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

export class Hub {
  // The original guarded every field here with a re-entrant lock and woke
  // waiters through a condition variable. Node runs one thread and nothing
  // below yields part-way through, so there is no window for a second caller
  // to see half a report: the lock is gone, and the condition variable is the
  // set of pending promises that `report` settles.
  private readonly clients = new Set<ViewerClient>();
  /** Number of live SSE connections for each renderer identity. */
  private readonly rendererConnections = new Map<string, number>();
  /** Distinct renderers that have acknowledged each line currently on air. */
  private readonly onAirOwners = new Map<string, Set<string>>();
  /** Grace timers for lines whose last known owner disconnected. */
  private readonly onAirTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly waiters = new Set<Waiter>();
  private readonly events: SessionEvent[] = [];
  /**
   * BGM cues are emitted by every renderer, so the event log's short echo
   * window is not enough to keep a reload from applying one twice. Keep the
   * accepted cue ids in arrival order and bound the memory like the event log.
   */
  private readonly acceptedCueIds = new Set<string>();
  private seq = 0;
  private state: Partial<SessionState> = {};
  private vocabulary: Partial<Vocabulary> = {};
  private voice: VoiceReport | null = null;
  private tuning: Tuning | null = null;
  private slides: SlideReport | null = null;
  private placement: PlacementReport | null = null;
  private avatars: LabelledId[] = [];
  private avatar: AvatarStatus | null = null;
  /** Last valid report, including avatar-only heartbeats. */
  private heartbeatAt = 0;
  private stateAt = 0;
  /**
   * `type:turn` keys of the lifecycle events already logged, in arrival order
   * and bounded like the event log. See `ECHO_SECONDS`.
   */
  private readonly acceptedTurnEvents = new Set<string>();

  /**
   * The pending turns, and the authority on what they are. See `queue.ts`.
   *
   * It lives here rather than beside the routes because both of the things that
   * keep it true are things the hub already sees: a viewer attaching, which is
   * when the list has to be re-delivered, and a `turn.end` arriving, which is
   * when an entry stops being pending.
   */
  readonly queue = new TurnQueue();
  /** Last queue state observed at a hub boundary, for edits outside reports. */
  private queueWorkObserved = false;

  /**
   * The setup, so a renderer opened at the top of the broadcast is not opened on
   * defaults. See `standing.ts` for what counts as one and what does not.
   */
  private readonly standing: Standing;

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
   *
   * The recordings store is the fourth, and is here rather than beside the
   * routes for the reason the queue is: what a take has to know about — a line
   * ending, a renderer attaching, the hold coming off — are all things this
   * already sees.
   */
  constructor(
    private readonly decks: DeckSource | null = null,
    private readonly speech: SpeechSource | null = null,
    private readonly roots: ServerRoots | null = null,
    private readonly recordings: RecordingStore | null = null,
    private readonly bgmLibrary: BgmSource | null = null,
    private readonly bgmCoordinator: BgmCoordinator = new BgmCoordinator(),
  ) {
    this.standing = new Standing(
      (deckId) => this.decks?.current.find((deck) => deck.id === deckId)?.pages,
    );
  }

  /**
   * The stop scheduled for the end of the script, if one is counting down.
   * See `RECORD_TAIL_SECONDS`.
   */
  private tailTimer: ReturnType<typeof setTimeout> | null = null;

  /** The watchdog on a stopped recording's last chunk. See `RECORD_FLUSH_SECONDS`. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** The bounded safety net for a renderer that disappears mid-take. */
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;
  private orphanOwner: string | null = null;

  /** True after this take has observed at least one pending/on-air line. */
  private recordingQueueSeen = false;
  /** Mirrors the store's synchronous first-owner pin for the watchdog. */
  private recordingOwner: string | null = null;

  /**
   * A hold waiting on proof that the recording is rolling.
   *
   * Set by a `start` that asked for it and spent by the first chunk that
   * arrives. Releasing on a timer instead would be releasing on a guess about
   * how long an encoder takes to produce its first second — and a guess that is
   * short by anything at all clips the front of the first line, which is
   * exactly the frame the take opens on.
   */
  private releaseOn: string | null = null;

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
   *
   * A renderer attaching while a line is on air is handed the queue held, and
   * released when that line ends. The on-air line is not replayed, so without
   * the hold it would start the next line while every other renderer is still
   * saying this one, and run a line ahead of them for the rest of the show.
   */
  subscribe(listener: ViewerListener, rendererId?: string): () => void {
    const client: ViewerClient = { listener, rendererId };
    this.clients.add(client);
    if (rendererId !== undefined) {
      this.rendererConnections.set(rendererId, (this.rendererConnections.get(rendererId) ?? 0) + 1);
      this.cancelOrphan(rendererId);
      this.rendererConnected(rendererId);
    }
    // After the ownership pass, which may have filed an abandoned line.
    client.held = this.queue.airing().length > 0;
    const commands = this.standing.commands();
    const bgm = this.bgmCoordinator.currentCommand();
    if (bgm !== null) commands.push(bgm);
    // Always replace the renderer's local queue on connect, including with an
    // empty list. A reconnect may have missed the server's last clear or
    // completion; silence would leave stale local rows available to play.
    // Only pending entries are re-delivered. The on-air copy is owned by the
    // renderer that started it and must not be replayed on reconnect.
    if (client.held) commands.push({ cmd: 'pause', on: true });
    commands.push(this.queue.command());
    this.observeQueue();
    if (commands.length > 0) listener({ type: 'command', commands });
    return () => this.detach(client);
  }

  /** Hand the hold back to renderers that attached mid-line, once nothing is on air. */
  private releaseHeld(): void {
    if (this.queue.airing().length > 0) return;
    for (const client of this.clients) {
      if (!client.held) continue;
      client.held = false;
      client.listener({ type: 'command', commands: [{ cmd: 'pause', on: this.standing.paused }] });
    }
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
    return this.dispatch([this.queue.command()]).viewers;
  }

  unsubscribe(listener: ViewerListener, rendererId?: string): void {
    for (const client of [...this.clients]) {
      if (client.listener !== listener) continue;
      if (rendererId !== undefined && client.rendererId !== rendererId) continue;
      this.detach(client);
    }
  }

  private detach(client: ViewerClient): void {
    if (!this.clients.delete(client)) return;
    const rendererId = client.rendererId;
    if (rendererId === undefined) return;
    const count = (this.rendererConnections.get(rendererId) ?? 1) - 1;
    if (count > 0) {
      this.rendererConnections.set(rendererId, count);
      return;
    }
    this.rendererConnections.delete(rendererId);
    this.rendererDisconnected(rendererId);
    this.armOrphan(rendererId);
  }

  /** Cancel or recover on-air grace when a renderer attaches. */
  private rendererConnected(rendererId: string): void {
    for (const [turnId, owners] of [...this.onAirOwners]) {
      if (owners.has(ANONYMOUS_OWNER)) continue;
      if (owners.has(rendererId)) {
        this.clearOnAirTimer(turnId);
        continue;
      }
      // Another connected page may still be posting its first turn.start.
      // A newcomer must not shorten that page's report grace and prematurely
      // file its live line as interrupted.
      if (!this.hasLiveOwner(owners)) {
        if ([...this.clients].some((client) => client.rendererId !== rendererId)) {
          this.armOnAirTimer(turnId);
        } else {
          this.recoverOnAir(turnId);
        }
      }
    }
  }

  /** Arm grace for every on-air line owned by a renderer that just left. */
  private rendererDisconnected(rendererId: string): void {
    for (const [turnId, owners] of this.onAirOwners) {
      if (!owners.has(rendererId) || owners.has(ANONYMOUS_OWNER)) continue;
      if (!this.hasLiveOwner(owners)) this.armOnAirTimer(turnId);
    }
  }

  private hasLiveOwner(owners: Set<string>): boolean {
    for (const owner of owners) {
      if (owner !== ANONYMOUS_OWNER && (this.rendererConnections.get(owner) ?? 0) > 0) {
        return true;
      }
    }
    return false;
  }

  /** Remember one renderer's ownership of a line, including duplicate starts. */
  private noteTurnOwner(turnId: string, rendererId?: string): void {
    const known = this.onAirOwners.get(turnId);
    const active =
      known !== undefined ||
      this.queue.list().some((entry) => entry.id === turnId) ||
      this.queue.airing().some((entry) => entry.id === turnId);
    if (!active) return;

    const owners = known ?? new Set<string>();
    owners.add(rendererId ?? ANONYMOUS_OWNER);
    this.onAirOwners.set(turnId, owners);
    if (rendererId !== undefined && (this.rendererConnections.get(rendererId) ?? 0) > 0) {
      this.clearOnAirTimer(turnId);
    } else if (rendererId !== undefined) {
      // A report may race the stream handshake (or come from a caller that
      // never opened SSE). Treat that owner as already absent until it connects.
      this.armOnAirTimer(turnId);
    }
  }

  /** Start a grace timer after all named owners of a line have disconnected. */
  private armOnAirTimer(turnId: string): void {
    if (this.onAirTimers.has(turnId)) return;
    const owners = this.onAirOwners.get(turnId);
    if (owners === undefined || owners.has(ANONYMOUS_OWNER) || this.hasLiveOwner(owners)) return;
    const timer = setTimeout(() => {
      this.onAirTimers.delete(turnId);
      const current = this.onAirOwners.get(turnId);
      if (current === undefined || current.has(ANONYMOUS_OWNER) || this.hasLiveOwner(current)) {
        return;
      }
      this.recoverOnAir(turnId);
    }, STATE_STALE_SECONDS * 1000);
    timer.unref?.();
    this.onAirTimers.set(turnId, timer);
  }

  private clearOnAirTimer(turnId: string): void {
    const timer = this.onAirTimers.get(turnId);
    if (timer !== undefined) clearTimeout(timer);
    this.onAirTimers.delete(turnId);
  }

  /** Forget owner state when a turn completes normally or by an interrupt. */
  private clearTurnOwners(turnId: string): void {
    this.clearOnAirTimer(turnId);
    this.onAirOwners.delete(turnId);
  }

  /** Finish an abandoned line, preserving every pending line behind it. */
  private recoverOnAir(turnId: string): void {
    if (!this.queue.airing().some((entry) => entry.id === turnId)) {
      this.clearTurnOwners(turnId);
      return;
    }
    this.clearTurnOwners(turnId);
    const at = now();
    this.seq += 1;
    this.events.push({ type: 'turn.end', turn: turnId, interrupted: true, seq: this.seq, at });
    // The end this files stands for every renderer's, should one still arrive.
    remember(this.acceptedTurnEvents, `turn.end:${turnId}`);
    this.queue.complete(turnId, { interrupted: true });
    if (this.events.length > EVENT_LOG_MAX) {
      this.events.splice(0, this.events.length - EVENT_LOG_MAX);
    }
    this.observeQueue();
    this.releaseHeld();
    this.wake();
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
   * The interrupt is dispatched rather than sent: it cuts the line on air and
   * must not empty the list it travels with, which an `interrupt` from a caller
   * does. Nothing a renderer reports back removes a pending line either, so
   * however many renderers answer the cut, the rewound list stands.
   *
   * Returns the entries that went back, or null for an id the history no longer
   * has.
   */
  rewind(id: string, mode: RewindMode, { interrupt = false } = {}): QueueEntry[] | null {
    const added = this.queue.rewind(id, mode, { cut: interrupt });
    if (added === null) return null;
    const commands: Command[] = interrupt ? [{ cmd: 'interrupt' }] : [];
    commands.push(this.queue.command());
    this.dispatch(commands);
    return added;
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
  private isEcho(event: SessionEvent, at: number): boolean {
    if (TURN_EVENTS.has(event.type) && event.turn !== undefined) {
      const key = `${event.type}:${event.turn}`;
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

  /**
   * Route one inline BGM cue from an audible renderer.
   *
   * A muted preview still runs the same session clock and therefore still
   * emits the cue. It cannot be the source of truth for the shared transport,
   * though: wait for an explicit `muted: false` report and leave the cue id
   * untouched so an audible renderer can claim it later. The normal `send`
   * path is intentional — it is where BgmCoordinator stamps the revision,
   * position and timestamp and where the standing state is fanned out.
   */
  private routeBgmCue(event: SessionEvent, report: ReportBody['bgm']): boolean {
    if (report?.muted !== false) return false;
    if (event.type !== 'cue.fire') return false;
    if (
      typeof event.turn !== 'string' ||
      event.turn.length === 0 ||
      typeof event.cueId !== 'string' ||
      event.cueId.length === 0 ||
      event.cue?.kind !== 'bgm'
    ) {
      return false;
    }

    const { cueId, cue } = event;
    if (this.acceptedCueIds.has(cueId)) return true;
    remember(this.acceptedCueIds, cueId);

    const at = event.at ?? now();
    this.seq += 1;
    this.events.push({ ...event, seq: this.seq, at });

    const command: Command =
      cue.action === 'set'
        ? { cmd: 'bgm', ...cue.settings }
        : {
            cmd: 'bgm',
            action: cue.action,
            ...('track' in cue && cue.track !== undefined ? { track: cue.track } : {}),
          };
    this.send({ type: 'command', commands: [command] });
    return true;
  }

  /**
   * Fold one fired camera, page or performance cue into the setup.
   *
   * Every renderer fires the same cue and any of them may report it first; the
   * id is consumed once, as a BGM cue's is. Not logged: what it changes is the
   * setup, which a renderer is handed rather than told about.
   */
  private foldCue(event: SessionEvent): void {
    if (event.cueId === undefined || event.cue === undefined) return;
    if (this.acceptedCueIds.has(event.cueId)) return;
    remember(this.acceptedCueIds, event.cueId);
    this.standing.recordCue(event.cue);
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
    return this.command(message.commands).viewers;
  }

  /**
   * Apply a caller's batch, and say what became of each command in it.
   *
   * The queue verbs act on the server's list before any renderer hears of them:
   * `say` queues its line, `queue` replaces the list, `clear` and `interrupt`
   * empty it. The list then travels as one canonical `queue` after the last of
   * them and after any avatar swap, so a renderer never holds a line the server
   * does not, and a later publish cannot bring back a line a clear dropped.
   *
   * Nothing is lost for want of a renderer if the server keeps it: a queued
   * line, a cleared list, the BGM transport and the standing setup all reach a
   * renderer that attaches later, and are `retained` rather than `lost`.
   */
  command(commands: Command[]): CommandOutcome {
    const out: Command[] = [];
    /** Which input each outgoing command came from; -1 for the canonical queue. */
    const origin: number[] = [];
    const ids: (string | undefined)[] = commands.map(() => undefined);
    let queueAt = -1;
    let avatarAt = -1;
    commands.forEach((command, index) => {
      switch (command.cmd) {
        case 'say': {
          const { cmd: _cmd, ...turn } = command;
          ids[index] = this.queue.say(turn).id;
          queueAt = out.length;
          return;
        }
        case 'queue':
          this.queue.replace(command.turns);
          queueAt = out.length;
          return;
        case 'clear':
        case 'interrupt':
          this.queue.clear();
          queueAt = out.length + 1;
          break;
        case 'avatar':
          avatarAt = out.length;
          break;
      }
      out.push(command);
      origin.push(index);
    });
    if (queueAt !== -1 || avatarAt !== -1) {
      const at = Math.max(queueAt, avatarAt + 1);
      out.splice(at, 0, this.queue.command());
      origin.splice(at, 0, -1);
    }
    const { viewers, kept } = this.dispatch(out);
    const fates: CommandFate[] = commands.map((command) =>
      viewers > 0
        ? 'delivered'
        : QUEUE_VERBS.has(command.cmd) || command.cmd === 'bgm'
          ? 'retained'
          : 'lost',
    );
    if (viewers === 0) {
      origin.forEach((index, i) => {
        if (index !== -1 && kept[i]) fates[index] = 'retained';
      });
    }
    return { viewers, fates, ids };
  }

  /**
   * Record and fan out commands exactly as given, with no queue verb applied.
   *
   * For the hub's own frames, which already carry the canonical list: a rewind's
   * `interrupt` cuts the line on air and must not empty the list beside it.
   * Answers the viewer count and, per command, whether the standing kept it.
   */
  private dispatch(commands: Command[]): { viewers: number; kept: boolean[] } {
    this.observeQueue();
    const canonical = commands.map((command) =>
      command.cmd === 'bgm' ? this.bgmCoordinator.apply(command) : command,
    );
    const kept = canonical.map((command) => this.standing.record(command));
    this.broadcast({ type: 'command', commands: canonical });
    return { viewers: this.clients.size, kept };
  }

  /**
   * Fan out an already canonical message without applying it a second time.
   *
   * A renderer held mid-line keeps its hold through any `pause` sent meanwhile;
   * `releaseHeld` hands it the standing value when the line ends.
   */
  private broadcast(message: StreamMessage): void {
    const holding = message.commands.some((command) => command.cmd === 'pause');
    for (const client of this.clients) {
      if (client.held && holding) {
        client.listener({
          type: 'command',
          commands: message.commands.map((command) =>
            command.cmd === 'pause' ? { ...command, on: true } : command,
          ),
        });
      } else {
        client.listener(message);
      }
    }
  }

  get viewers(): number {
    return this.clients.size;
  }

  // --- recording ------------------------------------------------------------

  /**
   * Observe the queue at a server boundary.
   *
   * `TurnQueue.list()` intentionally exposes pending lines only, while a take
   * must stay alive for a line that has already started. The recording latch is
   * per take: an empty take has never had work and therefore cannot be stopped
   * merely because it remains empty for a few heartbeats.
   */
  private observeQueue(previousWork = this.queueWorkObserved): void {
    const currentWork = this.queue.hasWork;
    // `previousWork` is also an observation: a report may be the first
    // boundary after a pending line was drained, so looking only at the state
    // after its events would miss the non-empty half of the transition.
    if (this.recordings !== null && (currentWork || previousWork)) {
      this.recordingQueueSeen = true;
    }
    this.queueWorkObserved = currentWork;
    if (!currentWork) {
      // A stopped take remains live while its encoder flushes. A record-off
      // command itself passes through send(), so never arm the queue tail again
      // during that bounded flush window.
      if (this.flushTimer === null) this.considerTail();
      else this.clearTail();
    } else this.clearTail();
  }

  /** Arm the orphan safety net when the last connection for an owner leaves. */
  private armOrphan(rendererId: string): void {
    const live = this.recordings?.current ?? null;
    if (live === null || this.recordingOwner !== rendererId) return;
    this.clearOrphan();
    this.orphanOwner = rendererId;
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = null;
      this.orphanOwner = null;
      const still = this.recordings?.current ?? null;
      if (still === null || this.recordingOwner !== rendererId) return;
      if ((this.rendererConnections.get(rendererId) ?? 0) > 0) return;
      // No renderer remains to deliver the encoder's terminal chunk. Send the
      // normal stop command for observers, then close the sink immediately
      // rather than waiting for the ordinary renderer-flush watchdog; this is
      // the bounded orphan path itself.
      this.stopRecording(still.session);
      this.clearFlush();
      void this.finishRecording(still.session);
    }, RECORD_ORPHAN_SECONDS * 1000);
    this.orphanTimer.unref?.();
  }

  /** Reconnection of the same renderer makes the orphan timer unnecessary. */
  private cancelOrphan(rendererId: string): void {
    if (this.orphanOwner !== rendererId) return;
    this.clearOrphan();
  }

  private clearOrphan(): void {
    if (this.orphanTimer !== null) clearTimeout(this.orphanTimer);
    this.orphanTimer = null;
    this.orphanOwner = null;
  }

  /**
   * Open a take and tell the renderers to roll.
   *
   * Null when one is already running, or when this server was built without a
   * recordings directory. Both are refusals rather than errors and the caller
   * says which; see `Recordings.open`.
   *
   * `release` is the recording flow's whole point. A script is loaded into a
   * held queue so the shot can be framed, and the hold has to come off at the
   * moment the take is genuinely rolling — not when the command was sent. See
   * `releaseOn`.
   */
  startRecording(options: OpenOptions & { release?: boolean }): Recording | null {
    if (this.recordings === null) return null;
    const opened = this.recordings.open(options);
    if (opened === null) return null;
    this.clearTimers();
    this.clearOrphan();
    this.recordingOwner = null;
    this.recordingQueueSeen = this.queue.hasWork;
    this.queueWorkObserved = this.queue.hasWork;
    this.releaseOn = options.release ? opened.session : null;
    this.send({
      type: 'command',
      commands: [
        {
          cmd: 'record',
          on: true,
          session: opened.session,
          width: opened.width,
          height: opened.height,
          fps: opened.fps,
        },
      ],
    });
    return opened;
  }

  /**
   * Tell the renderers to stop, and start the watchdog on the flush.
   *
   * The file is not closed here. What is still to come is the second or so the
   * encoder is holding, and closing on the send would truncate every take by
   * exactly that much. See `RECORD_FLUSH_SECONDS`.
   */
  stopRecording(session?: string): Recording | null {
    const live = this.recordings?.current ?? null;
    if (live === null) return null;
    if (session !== undefined && session !== live.session) return null;
    this.clearTail();
    this.releaseOn = null;
    this.clearOrphan();
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.finishRecording(live.session);
      }, RECORD_FLUSH_SECONDS * 1000);
      this.flushTimer.unref?.();
    }
    this.send({
      type: 'command',
      commands: [{ cmd: 'record', on: false, session: live.session }],
    });
    return live;
  }

  /**
   * Take one chunk from the renderer. Answers whether it was ours.
   *
   * The first chunk is the proof the take is rolling, and is what releases a
   * hold that was waiting for it. The last one closes the file, because the
   * renderer is the only thing that knows its encoder has finished.
   */
  async recordChunk(
    session: string,
    owner: string,
    mime: string,
    chunk: Buffer,
    { final = false }: { final?: boolean } = {},
  ): Promise<AppendResult> {
    if (this.recordings === null) {
      return { status: 'stale', first: false, recording: null };
    }
    const current = this.recordings.current;
    if (current === null || current.session !== session) {
      return { status: 'stale', first: false, recording: current };
    }
    // Keep this synchronous with the store's owner pin. A second renderer can
    // reach this method before the first write callback, but it must still see
    // a conflict rather than interleave bytes into the same take.
    if (this.recordingOwner === null) this.recordingOwner = owner;
    // A renderer can disappear after the take starts but before its first
    // chunk arrives. In that case detach() had no owner to arm against; once
    // this synchronous pin identifies the owner, arm the same bounded orphan
    // watchdog if no connection for it remains.
    if ((this.rendererConnections.get(owner) ?? 0) === 0) this.armOrphan(owner);
    const result = await this.recordings.append(session, owner, mime, chunk);
    if (result.status === 'failed') {
      // A sink that failed takes no more bytes, so the take ends here: the
      // renderers stop encoding, the file is closed, and a hold that was waiting
      // for this take to roll comes off rather than holding the queue for a
      // recording that is not happening. Stale and conflict responses must never
      // close a live take they do not own.
      const held = this.releaseOn === session;
      if (!final) this.stopRecording(session);
      this.releaseOn = null;
      this.clearFlush();
      await this.recordings.close(session);
      this.clearFinishedRecording(session);
      if (held) this.send({ type: 'command', commands: [{ cmd: 'pause', on: false }] });
      return result;
    }
    if (result.status !== 'accepted') return result;
    if (result.first && this.releaseOn === session) {
      this.releaseOn = null;
      this.send({ type: 'command', commands: [{ cmd: 'pause', on: false }] });
    }
    if (final) {
      this.clearFlush();
      await this.recordings.close(session);
      this.clearFinishedRecording(session);
    }
    return result;
  }

  /** The take in flight, as the snapshot reports it. */
  get recording(): Recording | null {
    return this.recordings?.current ?? null;
  }

  /**
   * Wind everything down. For a server shutting down with a take still open,
   * which would otherwise leave a truncated file with no moov box in it.
   */
  async closeRecording(): Promise<void> {
    this.clearTimers();
    this.clearOrphan();
    this.recordingOwner = null;
    this.recordingQueueSeen = false;
    await this.recordings?.close();
  }

  /** Stop Hub-owned timers when the control server is torn down. */
  dispose(): void {
    this.clearTimers();
    this.clearOrphan();
    for (const timer of this.onAirTimers.values()) clearTimeout(timer);
    this.onAirTimers.clear();
    this.onAirOwners.clear();
    const snapshot = this.snapshot();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ snapshot, completed: false });
    }
    this.waiters.clear();
  }

  private async finishRecording(session: string): Promise<void> {
    await this.recordings?.close(session);
    this.clearFinishedRecording(session);
  }

  /** Clear take-local state unless a newer take won the close race. */
  private clearFinishedRecording(session: string): void {
    const current = this.recordings?.current ?? null;
    if (current !== null && current.session !== session) return;
    this.clearOrphan();
    this.recordingOwner = null;
    this.recordingQueueSeen = false;
  }

  /**
   * Arm the end-of-script stop, or stand it down.
   *
   * Called from `report` whenever the queue has just changed length. The stop
   * is scheduled rather than immediate — see `RECORD_TAIL_SECONDS` — and the
   * schedule is dropped the moment there is another line to say, which is what
   * makes a comment queued during the tail extend the take instead of ending
   * it early.
   */
  private considerTail(): void {
    const live = this.recordings?.current ?? null;
    if (live === null || !live.autoStop || !this.recordingQueueSeen || this.queue.hasWork) {
      this.clearTail();
      return;
    }
    if (this.tailTimer !== null) return;
    this.tailTimer = setTimeout(() => {
      this.tailTimer = null;
      // Re-read rather than trusting the schedule: the queue may have been
      // refilled and drained again inside the tail, and a turn may have been
      // started by a `say` that never touched the queue length this saw.
      const still = this.recordings?.current ?? null;
      if (still === null || !still.autoStop) return;
      if (this.queue.hasWork || this.state.speaking || !this.recordingQueueSeen) return;
      this.stopRecording(still.session);
    }, RECORD_TAIL_SECONDS * 1000);
    this.tailTimer.unref?.();
  }

  private clearTail(): void {
    if (this.tailTimer === null) return;
    clearTimeout(this.tailTimer);
    this.tailTimer = null;
  }

  private clearFlush(): void {
    if (this.flushTimer === null) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private clearTimers(): void {
    this.clearTail();
    this.clearFlush();
  }

  // --- upstream (viewer -> server) ------------------------------------------

  /** Take one report from a viewer. Returns the newest sequence number. */
  report(body: ReportBody, rendererId?: string): number {
    // Avatar loading can be reported before a Session exists. Keep connection
    // liveness on its own clock so that a failed/early renderer is visible as
    // connected while its state clock remains unset and its state stays empty.
    this.heartbeatAt = now();
    const previousWork = this.queue.hasWork;
    if (body.state !== undefined) {
      this.state = body.state;
      this.stateAt = now();
    }
    if (body.avatar !== undefined) this.avatar = body.avatar;
    if (body.vocabulary) this.vocabulary = body.vocabulary;
    if (body.voice !== undefined) this.voice = body.voice;
    if (body.tuning !== undefined) this.tuning = body.tuning;
    if (body.slides !== undefined) this.slides = body.slides;
    if (body.placement !== undefined) this.placement = body.placement;
    // Fixed for the life of a renderer, so it rides with the vocabulary rather
    // than on the timer. Not cleared by a report that omits it.
    if (body.avatars) this.avatars = body.avatars;
    const bgmTransition = body.bgm === undefined ? null : this.bgmCoordinator.report(body.bgm);
    if (bgmTransition !== null) {
      // The coordinator has already advanced the revision. Bypass `send`,
      // which is for caller input and would apply the transition a second time.
      this.broadcast({ type: 'command', commands: [bgmTransition] });
    }
    for (const event of body.events ?? []) {
      // Record ownership before echo filtering: the same start is expected from
      // every connected renderer, and each distinct renderer must be eligible to
      // keep the line alive if another owner disappears.
      if (event.type === 'turn.start' && event.turn) {
        this.noteTurnOwner(event.turn, rendererId);
      }
      // BGM cues are transport intents, not renderer observations. A muted or
      // unknown renderer is deliberately ignored, and its id is left free for
      // the audible renderer's report. Once accepted, the id is consumed even
      // if another renderer reports the same cue much later.
      if (event.type === 'cue.fire') {
        if (event.cue?.kind === 'bgm') this.routeBgmCue(event, body.bgm);
        else this.foldCue(event);
        continue;
      }
      const at = event.at ?? now();
      // Dropped before anything acts on it, not merely kept out of the log: a
      // turn that has already been filed does not need filing again, and a
      // start already handed off must not fold its line a second time. See
      // `ECHO_SECONDS`.
      if (this.isEcho(event, at)) continue;
      this.seq += 1;
      this.events.push({ ...event, seq: this.seq, at });
      // A start is the hand-off from the server's pending list to the
      // renderer-owned on-air set, and the moment what the line leaves behind —
      // its stage and its mood — becomes the setup a later renderer is handed.
      if (event.type === 'turn.start' && event.turn) {
        const started = this.queue.start(event.turn);
        if (started !== null) this.standing.recordTurn(started);
      }
      // A line the renderer has finished with stops being pending and starts
      // being history. Driven off the event rather than off the reported
      // `queued` count, because the count says how many are left and not which
      // one left — and the panel is looking at rows, not at a number.
      if (event.type === 'turn.end' && event.turn) {
        this.queue.complete(event.turn, { interrupted: event.interrupted });
        this.clearTurnOwners(event.turn);
      }
      // The line that was cut off is filed rather than dropped — it was said, if
      // only partly, and it is the one most likely to be wanted back. The
      // pending list is not touched: the interrupt that caused this emptied it
      // when the server sent it, and a rewind's interrupt travelled with the
      // list that must survive it. `queue.dropped` is logged for the same reason
      // and acts on nothing.
      if (event.type === 'turn.interrupted' && event.turn) {
        this.queue.complete(event.turn, { interrupted: true });
        this.clearTurnOwners(event.turn);
      }
    }
    if (this.events.length > EVENT_LOG_MAX) {
      this.events.splice(0, this.events.length - EVENT_LOG_MAX);
    }
    // After the events, because every one of them above can be the thing that
    // emptied the queue. See `considerTail`.
    this.observeQueue(previousWork);
    this.releaseHeld();
    this.wake();
    return this.seq;
  }

  snapshot(since?: number): Snapshot {
    const heartbeatFresh = now() - this.heartbeatAt < STATE_STALE_SECONDS;
    const stateFresh = now() - this.stateAt < STATE_STALE_SECONDS;
    return {
      connected: this.clients.size > 0 && heartbeatFresh,
      viewers: this.clients.size,
      seq: this.seq,
      state: stateFresh ? this.state : {},
      vocabulary: this.vocabulary,
      events: since === undefined ? [...this.events] : this.since(since),
      avatar: this.avatar,
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
      // BGM is owned by this server rather than any one renderer, so it remains
      // available even while all renderer state has gone stale.
      bgm: this.bgmCoordinator.state(),
      bgmTracks: this.bgmLibrary?.current ?? [],
      // A hub with nothing watching says `absent`, which is the truthful answer
      // to "is the voice up" from a server that is not looking at it.
      speech: this.speech?.current ?? ('absent' satisfies SpeechState),
      queue: this.queue.list(),
      // Beside the pending list rather than folded into it: these have started
      // and are no longer editable, and a panel reading one is reading what is
      // being said right now. See `airing` on the schema.
      airing: this.queue.airing(),
      // Read off the setup rather than held beside it. See `Standing.paused`.
      paused: this.standing.paused,
      // The server's own, like `speech` and for the same reason: the bytes are
      // arriving here. See `recordingSchema`.
      recording: this.recordings?.current ?? null,
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
