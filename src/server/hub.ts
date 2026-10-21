import { Autopilot, IDLE_AFTER } from '../engine/autopilot';
import type {
  AvatarStatus,
  BloomReport,
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
import { EventLog } from './event-log';
import { type RewindMode, TurnQueue } from './queue';
import type { AppendResult, OpenOptions, RecordingStore } from './recordings';
import { type Random, withSide } from './side';
import type { SpeechSource } from './speech';
import { Standing } from './standing';
import { TakeControl } from './take';

export { ECHO_SECONDS, EVENT_LOG_MAX } from './event-log';
export { RECORD_FLUSH_SECONDS, RECORD_ORPHAN_SECONDS, RECORD_TAIL_SECONDS } from './take';

/**
 * Fan-out to connected viewers, plus the last state they reported.
 *
 * Knows nothing about HTTP: the routes turn a request into one of these calls
 * and turn the result back into JSON, which keeps the interesting part — the
 * event log and the waiting — testable without a socket.
 */

/**
 * How long a reported state stays believable.
 *
 * The viewer reports on a timer, so silence means it is gone — a tab that was
 * closed leaves its last state behind, and answering with it would tell the
 * orchestrator the avatar is still mid-sentence forever.
 */
export const STATE_STALE_SECONDS = 3.0;

/** The verbs that act on the server's queue, and are applied to it before any renderer. */
const QUEUE_VERBS = new Set<Command['cmd']>(['say', 'queue', 'clear', 'interrupt']);

/**
 * How often the idle clock ticks. A choice lands within one tick of falling
 * due, which nobody watching a pose held for seconds can see.
 */
export const IDLE_TICK_MS = 100;

/**
 * The direct face and body verbs. Each restarts the renderer's grace before the
 * idle resumes (`Session.wake`), so each restarts the idle clock's here too.
 */
const WAKE_VERBS = new Set<Command['cmd']>([
  'emotion',
  'expression',
  'overlay',
  'reset',
  'gesture',
  'perform',
  'hop',
  'point',
  'look',
]);

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
  private readonly log = new EventLog();
  private state: Partial<SessionState> = {};
  private vocabulary: Partial<Vocabulary> = {};
  private voice: VoiceReport | null = null;
  private tuning: Tuning | null = null;
  private slides: SlideReport | null = null;
  private placement: PlacementReport | null = null;
  private bloom: BloomReport | null = null;
  private avatars: LabelledId[] = [];
  private avatar: AvatarStatus | null = null;
  /** Last valid report, including avatar-only heartbeats. */
  private heartbeatAt = 0;
  private stateAt = 0;
  /**
   * The pending turns, and the authority on what they are. See `queue.ts`.
   *
   * It lives here rather than beside the routes because both of the things that
   * keep it true are things the hub already sees: a viewer attaching, which is
   * when the list has to be re-delivered, and a `turn.end` arriving, which is
   * when an entry stops being pending.
   */
  readonly queue: TurnQueue;
  private readonly take: TakeControl;

  /**
   * The setup, so a renderer opened at the top of the broadcast is not opened on
   * defaults. See `standing.ts` for what counts as one and what does not.
   */
  private readonly standing: Standing;

  /**
   * The idle autopilot, run here once rather than in each renderer, so the
   * preview shows the idle that is on air. See `engine/autopilot.ts`.
   */
  private readonly autopilot: Autopilot;
  private idleClock: ReturnType<typeof setInterval> | null = null;
  /** Seconds with nothing to say and no direct face or body command. */
  private idleQuiet = 0;

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
    recordings: RecordingStore | null = null,
    private readonly bgmLibrary: BgmSource | null = null,
    private readonly bgmCoordinator: BgmCoordinator = new BgmCoordinator(),
    private readonly random: Random = Math.random,
  ) {
    this.queue = new TurnQueue(random);
    this.take = new TakeControl(
      recordings,
      this.queue,
      (message) => this.send(message),
      (owner) => this.rendererConnections.get(owner) ?? 0,
      () => this.state.speaking === true,
    );
    this.autopilot = new Autopilot(random);
    this.standing = new Standing(
      (deckId) => this.decks?.current.find((deck) => deck.id === deckId)?.pages,
    );
  }

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
      this.take.cancelOrphan(rendererId);
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
    this.take.observeQueue();
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
    this.take.armOrphan(rendererId);
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
    this.log.append({ type: 'turn.end', turn: turnId, interrupted: true }, at);
    // The end this files stands for every renderer's, should one still arrive.
    this.log.markFiled(`turn.end:${turnId}`);
    this.queue.complete(turnId, { interrupted: true });
    this.log.trim();
    this.take.observeQueue();
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
    if (!this.log.claimCue(cueId)) return true;

    const at = event.at ?? now();
    this.log.append(event, at);

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
    if (!this.log.claimCue(event.cueId)) return;
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
    commands.forEach((original, index) => {
      const command = withSide(original, this.random);
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
    this.observeIdle(commands);
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
   * Why this batch may not be applied, or null when it may.
   *
   * Refuses only what would start a stopped queue while the voice cannot be
   * heard: lifting the hold, or adding to a queue that is idle and unheld.
   * `absent` is not refused (a machine without a voice mouths in silence on
   * purpose), and a queue already moving is left alone because a probe that
   * flaps must not cost a caller its lines. `adding` marks a caller that adds
   * lines without a `say`/`queue` command in the batch.
   */
  refuseStart(commands: readonly Command[], adding = false): string | null {
    const speech = this.speech?.current;
    if (speech !== 'loading' && speech !== 'down') return null;
    let paused = this.standing.paused;
    let resumes = false;
    let adds = adding;
    for (const command of commands) {
      if (command.cmd === 'pause') {
        // Absent `on` means hold, as the schema states.
        paused = command.on ?? true;
        if (!paused) resumes = true;
      } else if (command.cmd === 'say') adds = true;
      else if (command.cmd === 'queue' && command.turns.length > 0) adds = true;
    }
    if (paused || !(resumes || (adds && !this.queue.hasWork))) return null;
    return speech === 'loading'
      ? 'speech sidecar is loading its model; playback cannot start until it is ready'
      : 'speech sidecar is not answering; playback cannot start until it is back';
  }

  /**
   * Record and fan out commands exactly as given, with no queue verb applied.
   *
   * For the hub's own frames, which already carry the canonical list: a rewind's
   * `interrupt` cuts the line on air and must not empty the list beside it.
   * Answers the viewer count and, per command, whether the standing kept it.
   */
  private dispatch(commands: Command[]): { viewers: number; kept: boolean[] } {
    this.take.observeQueue();
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

  // --- idle -----------------------------------------------------------------

  /** Restart the quiet for a direct command, and run the clock while idle is on. */
  private observeIdle(commands: readonly Command[]): void {
    for (const command of commands) {
      if (WAKE_VERBS.has(command.cmd)) this.idleQuiet = 0;
      if (command.cmd === 'reset') this.autopilot.holdFace();
    }
    if (!this.standing.idle) {
      this.stopIdleClock();
      return;
    }
    if (this.idleClock !== null) return;
    this.idleQuiet = 0;
    this.idleClock = setInterval(() => this.idleTick(), IDLE_TICK_MS);
    this.idleClock.unref?.();
  }

  private stopIdleClock(): void {
    if (this.idleClock === null) return;
    clearInterval(this.idleClock);
    this.idleClock = null;
    this.autopilot.advance(0, false);
  }

  /**
   * One tick of the idle clock: engaged once the queue has been quiet for
   * `IDLE_AFTER`, by the same rule each renderer gates its own idle on — a held
   * queue's lines are not work. Each choice goes to every renderer as it is,
   * with its side drawn here; a renderer whose idle is not engaged drops it.
   */
  private idleTick(): void {
    const dt = IDLE_TICK_MS / 1000;
    const working =
      this.queue.airing().length > 0 || (this.queue.length > 0 && !this.standing.paused);
    this.idleQuiet = working ? 0 : this.idleQuiet + dt;
    const choices = this.autopilot.advance(dt, this.idleQuiet > IDLE_AFTER);
    if (choices.length === 0) return;
    const commands = choices.map(
      (choice): Command =>
        'act' in choice
          ? withSide({ cmd: 'idleAct', act: choice.act }, this.random)
          : { cmd: 'idleFace', draw: choice.face },
    );
    // Not through `dispatch`: a choice is a moment, never part of the setup.
    this.broadcast({ type: 'command', commands });
  }

  // --- recording ------------------------------------------------------------

  /**
   * Open a take and tell the renderers to roll. See `TakeControl.startRecording`.
   */
  startRecording(options: OpenOptions & { release?: boolean }): Recording | null {
    return this.take.startRecording(options);
  }

  /** Tell the renderers to stop, and start the watchdog on the flush. */
  stopRecording(session?: string): Recording | null {
    return this.take.stopRecording(session);
  }

  /** Take one chunk from the renderer. Answers whether it was ours. */
  recordChunk(
    session: string,
    owner: string,
    mime: string,
    chunk: Buffer,
    options: { final?: boolean } = {},
  ): Promise<AppendResult> {
    return this.take.recordChunk(session, owner, mime, chunk, options);
  }

  /** The take in flight, as the snapshot reports it. */
  get recording(): Recording | null {
    return this.take.recording;
  }

  /** Wind everything down for a server shutting down with a take still open. */
  closeRecording(): Promise<void> {
    return this.take.closeRecording();
  }

  /** Stop Hub-owned timers when the control server is torn down. */
  dispose(): void {
    this.stopIdleClock();
    this.take.dispose();
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
    if (body.bloom !== undefined) this.bloom = body.bloom;
    // Rides with the vocabulary rather than on the timer. Replaced by each
    // report that carries one, since a renderer refetches it on every stream
    // open; not cleared by a report that omits it.
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
      if (this.log.isEcho(event, at)) continue;
      this.log.append(event, at);
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
    this.log.trim();
    // After the events, because every one of them above can be the thing that
    // emptied the queue. See `considerTail`.
    this.take.observeQueue(previousWork);
    this.releaseHeld();
    this.wake();
    return this.log.seq;
  }

  snapshot(since?: number): Snapshot {
    const heartbeatFresh = now() - this.heartbeatAt < STATE_STALE_SECONDS;
    const stateFresh = now() - this.stateAt < STATE_STALE_SECONDS;
    return {
      connected: this.clients.size > 0 && heartbeatFresh,
      viewers: this.clients.size,
      seq: this.log.seq,
      state: stateFresh ? this.state : {},
      vocabulary: this.vocabulary,
      events: since === undefined ? this.log.entries() : this.since(since),
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
      bloom: this.bloom,
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
      recording: this.take.recording,
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
    return this.log.since(seq);
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
