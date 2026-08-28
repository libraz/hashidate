import { loadMotions } from '@/engine/motion';
import type { Session } from '@/engine/session';
import type { LabelledId, SessionEvent } from '@/engine/types';
import {
  type Command,
  motionsResponseSchema,
  parseCommand,
  RECORD_DEFAULTS,
  type ReportBody,
} from '@/protocol';

/**
 * Control channel.
 *
 * Carries the session's command set over the local HTTP server: commands come
 * down an SSE stream, state and turn events go back up by POST. Nothing here
 * decides anything — it is a translation between the wire format and `Session`
 * method calls, which is what keeps the command set honest. If a command cannot
 * be expressed as one call on the session, the session is missing something.
 *
 * The stream reconnects on its own. The server is a local process that gets
 * restarted during development, and a viewer that has to be reloaded by hand
 * every time is a viewer nobody leaves running.
 */

/**
 * The report doubles as the heartbeat, so it goes out on the timer whether or
 * not anything changed. Skipping identical states looks like an optimisation
 * and is a bug: an idle avatar reports the same thing every time, so the server
 * stops hearing from a viewer that is working perfectly and marks it
 * disconnected. On loopback the saving was never worth having.
 */
const REPORT_INTERVAL = 700;
const RETRY_DELAY = 1500;

/**
 * How many commands may pile up behind an avatar swap.
 *
 * A swap reads a model off disk, and everything sent meanwhile waits for it —
 * see `apply`. A load that never finishes would otherwise let the backlog grow
 * for as long as the page is open. The oldest go first, because two commands on
 * the same axis are a correction and the later one is the correction.
 */
const HELD_MAX = 200;

export type ControlStatus = 'online' | 'offline';

/**
 * The switches that belong to the renderer rather than to the session.
 *
 * Every other command in the set is one session call, which is what keeps the
 * command set honest — a verb that cannot be expressed as one means the session
 * is missing something. These three genuinely cannot be: `avatar` *replaces*
 * the session along with the scene, the rig and the wardrobe underneath it,
 * `debug` reaches nothing in the scene at all — it is a readout the page draws
 * over itself — and `record` is about the composed picture rather than about
 * anything in it. So they are named here as exceptions rather than smuggled in
 * as special cases.
 *
 * Absent on a renderer that loads one avatar and stays on it, which is every
 * test: `avatar` then does nothing, the roster it reports is empty, and a
 * `debug` or a `record` arriving on a page with nothing to draw over or capture
 * is dropped.
 */
export interface RendererControls {
  /** Every avatar this renderer can load, including the one it has. */
  readonly avatars: LabelledId[];
  /** Print the measurements over the frame, or stop. */
  setDebug(on: boolean): void;
  /**
   * Start or stop recording the composed frame.
   *
   * Whether *this* renderer is the one that should is decided by whoever
   * implements this and not here: the command goes to every viewer attached and
   * only one of them is going to air. See `recordCommandSchema`.
   */
  setRecording(
    on: boolean,
    take: { session: string; width: number; height: number; fps: number },
  ): void;
  /**
   * Start loading one. Answers whether anything is actually going to happen.
   *
   * False for an id this renderer does not have — a caller working from a stale
   * roster — and false for the avatar it is already showing or already loading.
   * Both matter for the same reason: the channel holds commands behind a swap,
   * and a hold that nothing will ever end is a renderer that has gone silent.
   * The second case is the common one, because the setup a viewer is handed on
   * connect names the avatar it is usually already on.
   */
  load(id: string): boolean;
}

export interface ControlOptions {
  base?: string;
  onStatus?: (status: ControlStatus) => void;
  /** Commands the wire carried but the schema rejected. Surfaced, not swallowed. */
  onRejected?: (raw: unknown) => void;
  renderer?: RendererControls;
}

export class ControlClient {
  private session: Session;
  private readonly base: string;
  private readonly onStatus: (status: ControlStatus) => void;
  private readonly onRejected: (raw: unknown) => void;
  private readonly renderer: RendererControls | null;

  status: ControlStatus = 'offline';

  private pending: SessionEvent[] = [];
  private chain: Promise<void> = Promise.resolve();
  private unbind: (() => void) | null = null;
  private source: EventSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /**
   * Commands waiting for an avatar to finish arriving, or null when none is.
   *
   * Empty and non-null is meaningful: it means a swap is in flight and nothing
   * has arrived behind it yet.
   */
  private held: Command[] | null = null;
  /** The avatar the hold is waiting for. Null when nothing is held. */
  private awaiting: string | null = null;

  constructor(session: Session, opts: ControlOptions = {}) {
    this.session = session;
    this.base = opts.base ?? '/api';
    this.onStatus = opts.onStatus ?? (() => {});
    this.onRejected = opts.onRejected ?? (() => {});
    this.renderer = opts.renderer ?? null;
    this.bind(session);
  }

  /**
   * Point the channel at a different session.
   *
   * Switching avatars builds a new session over a new scene, and the connection
   * outlives it — reconnecting the stream on every switch would drop commands
   * for a second and make the server see the viewer disappear. The vocabulary
   * goes back up immediately, because that is the part that just changed: the
   * expression ids and wardrobe slots the caller was told about belong to the
   * avatar that is no longer loaded.
   *
   * This is also where a swap ends. Anything that arrived while the model was
   * being read is applied here, in order, onto the session it was meant for —
   * see `apply`.
   *
   * `avatar` says which one this session is of, and the hold ends only when it
   * is the one that was asked for. Not merely when *a* session arrives: a swap
   * requested while another model was still loading produces a session for the
   * intermediate avatar first, and flushing onto that one would dress, tune and
   * pose a character that is about to be replaced. A caller that does not know
   * — the constructor — passes null and releases, which is right, because
   * nothing can be held before the first command.
   */
  bind(session: Session, avatar: string | null = null): void {
    this.unbind?.();
    // A hold belongs to the run of turns, not to the character saying them, so
    // it survives a swap the way the queue itself does. The queue comes back
    // from the server — it is re-delivered on the next edit or on the next
    // connect — and without this the instruction not to start on it would not:
    // a fresh session begins moving, and a segment held for framing plays
    // itself out to nobody the moment somebody changes avatar.
    //
    // Carried here because this is the only place that can see both sessions.
    // The constructor binds the session it was given, where this is a no-op.
    session.paused = this.session.paused;
    this.session = session;
    this.unbind = session.on((ev) => {
      this.pending.push(ev);
      // Turn boundaries are what a caller blocks on, so they go up immediately
      // rather than on the next tick of the reporting timer.
      if (ev.type.startsWith('turn.')) void this.report();
    });
    if (this.awaiting === null || this.awaiting === avatar) this.flush();
    if (this.status === 'online') void this.report(true);
  }

  /**
   * Let go of the commands held behind a swap without applying them.
   *
   * For the load that never produced a session: a GLB that is missing, or one
   * the loader refused. The alternative is a renderer that goes quiet forever
   * because it is still waiting for an avatar that is not coming.
   */
  discardHeld(): void {
    this.held = null;
    this.awaiting = null;
  }

  private flush(): void {
    const held = this.held;
    this.held = null;
    this.awaiting = null;
    for (const command of held ?? []) this.apply(command);
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.timer = setInterval(() => void this.report(), REPORT_INTERVAL);
  }

  stop(): void {
    this.stopped = true;
    this.unbind?.();
    this.unbind = null;
    this.source?.close();
    this.source = null;
    if (this.timer !== null) clearInterval(this.timer);
    if (this.retry !== null) clearTimeout(this.retry);
    this.timer = null;
    this.retry = null;
  }

  private setStatus(s: ControlStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.onStatus(s);
  }

  /**
   * Open the command stream, if one is not open already.
   *
   * Both guards below are load-bearing, and the failure they prevent is one
   * stream per server restart rather than one stream. `onerror` fires more than
   * once for a single dropped connection, so a reconnect scheduled without
   * cancelling the last one lands twice, and each landing built another
   * `EventSource` over the top of the previous — which stayed subscribed,
   * because only the reference was replaced. Nothing looked wrong from the
   * viewer: the commands still arrived, they just arrived on every stream at
   * once, and the server's viewer count climbed with every restart.
   */
  private connect(): void {
    if (this.stopped || this.source) return;
    if (this.retry !== null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    const src = new EventSource(`${this.base}/stream`);
    this.source = src;

    src.onopen = () => {
      this.setStatus('online');
      // The vocabulary is discovered from the avatar, so the server cannot know
      // it until a viewer has loaded one. Push it on every connect — but after
      // the motions, because they are part of what it lists and a vocabulary
      // sent before them would advertise a shorter gesture set than the one
      // that is actually playable.
      void this.motions().then(() => this.report(true));
    };

    src.onmessage = (e) => {
      let msg: unknown;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!isCommandBatch(msg)) return;
      for (const raw of msg.commands) {
        const command = parseCommand(raw);
        if (command) this.apply(command);
        else this.onRejected(raw);
      }
    };

    src.onerror = () => {
      // Only the stream that is actually current may tear itself down. A late
      // error from one already replaced would otherwise drop the live one.
      if (this.source !== src) {
        src.close();
        return;
      }
      this.setStatus('offline');
      src.close();
      this.source = null;
      if (this.retry !== null) clearTimeout(this.retry);
      this.retry = setTimeout(() => this.connect(), RETRY_DELAY);
    };
  }

  /**
   * Read the operator's own gestures off the control server and register them.
   *
   * On every connect rather than once for the life of the page. The directory
   * is read afresh at the other end, so restarting the server is how an edited
   * motion reaches a renderer that is already running — and a page that cached
   * the first answer would keep playing the version from before the edit with
   * nothing on screen saying so.
   *
   * Every failure is quiet in the same way: no server, no directory, a reply
   * that does not parse, all leave the built-in gesture table exactly as it is.
   * The set this project ships is complete on its own, and a renderer that
   * refused to come up because a file somebody was editing had a typo in it
   * would be trading a missing gesture for a missing stream.
   */
  private async motions(): Promise<void> {
    try {
      const response = await fetch(`${this.base}/motions`);
      if (!response.ok) return;
      const parsed = motionsResponseSchema.safeParse(await response.json());
      if (!parsed.success) return;
      for (const { id, error } of parsed.data.errors) {
        console.warn(`motion ${id}: ${error}`);
      }
      const { rejected } = loadMotions(parsed.data.motions);
      for (const { id, reason } of rejected) {
        console.warn(
          reason === 'reserved'
            ? `motion ${id}: a built-in gesture already has that name`
            : `motion ${id}: listed twice`,
        );
      }
    } catch {
      // The stream is up and the motions are not, which is a server that has
      // just started and a directory it cannot read. Nothing to do about it
      // here; the next connect asks again.
    }
  }

  /**
   * Reports are serialised through a promise chain.
   *
   * Firing them concurrently lets two POSTs arrive at the server out of order,
   * and an event log in which `turn.end` precedes `turn.start` is far worse
   * than one that lags by a few milliseconds. Queueing three turns in one batch
   * reproduced it immediately.
   */
  private report(withVocabulary = false): Promise<void> {
    this.chain = this.chain.then(
      () => this.post(withVocabulary),
      () => {},
    );
    return this.chain;
  }

  private async post(withVocabulary: boolean): Promise<void> {
    const events = this.pending;
    this.pending = [];
    // The set-once layer rides on the timer beside the state rather than only
    // when it changes, for the same reason the voice report does: it is what a
    // remote fader is drawn from, and a fader that only updates when somebody
    // moves it cannot show what an avatar swap did to it.
    const body: ReportBody = {
      state: this.session.state(),
      events,
      tuning: this.session.tuning(),
    };
    if (withVocabulary) {
      body.vocabulary = this.session.vocabulary();
      // Fixed for the life of the page, so it goes with the vocabulary rather
      // than every 700 ms.
      if (this.renderer) body.avatars = this.renderer.avatars;
    }
    // The chain the renderer is *actually* running, so a panel draws that rather
    // than what it last sent — see `VoiceReport`. On the report timer and not
    // only on change, because it carries the loudness of the last take and a
    // meter that only updates when a setting moves is not a meter.
    const voice = this.session.voice?.report();
    if (voice) body.voice = voice;
    // Beside the voice and on the timer for the same reason: how many pages a
    // document has is discovered by opening it, and whether the page asked for
    // is the page showing changes without anything being sent.
    const slides = this.session.slides?.report();
    if (slides) body.slides = slides;
    // And the layout beside it, on the timer for the reason the tuning report
    // is: it is what a remote control surface draws its composition controls
    // from, and most of the layouts that reach a renderer were never sent as a
    // command at all — a browser source carries its own on the URL it was
    // opened with.
    const placement = this.session.composition?.report();
    if (placement) body.placement = placement;

    try {
      await fetch(`${this.base}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Put the events back: losing a turn.end silently strands a caller that
      // is blocked waiting for it.
      this.pending = events.concat(this.pending);
      this.setStatus('offline');
    }
  }

  /**
   * One command -> one session call.
   *
   * A command the schema does not recognise never reaches here; one it does but
   * this switch has not caught up with falls through to the default rather than
   * throwing. The orchestrator and the renderer are separate processes with
   * separate release cycles, and a newer caller talking to an older renderer
   * should degrade, not crash the stream.
   *
   * ## `avatar` holds everything behind it
   *
   * The one command that is not a session call, because it replaces the session.
   * A model takes a second or two to read, and the session that exists during
   * that window is the *old* one — so a caller that swaps the avatar and dresses
   * it in the same breath would otherwise dress the character being replaced,
   * and then watch the new one arrive undressed. Anything that arrives while a
   * swap is in flight is queued and applied when the new session is bound.
   */
  apply(c: Command): void {
    // Ahead of the hold, and the only command that goes ahead of it. It never
    // touches the session, so there is nothing about a swap for it to wait
    // for — and an operator switching the readout on to watch a slow avatar
    // load would otherwise be given it once the load had finished, which is
    // exactly when it has stopped being the question.
    if (c.cmd === 'debug') {
      this.renderer?.setDebug(c.on ?? true);
      return;
    }
    // Ahead of the hold for the same reason, and one of its own: a take is
    // started to capture what happens next, and an avatar arriving is part of
    // what happens next. Held behind the load, the recording would open after
    // the thing it was started to record.
    if (c.cmd === 'record') {
      this.renderer?.setRecording(c.on, {
        session: c.session,
        width: c.width ?? RECORD_DEFAULTS.width,
        height: c.height ?? RECORD_DEFAULTS.height,
        fps: c.fps ?? RECORD_DEFAULTS.fps,
      });
      return;
    }
    if (this.held) {
      this.held.push(c);
      if (this.held.length > HELD_MAX) this.held.splice(0, this.held.length - HELD_MAX);
      return;
    }
    const s = this.session;
    switch (c.cmd) {
      // Not `s.something`: see the note above. A load the renderer refuses —
      // an id it does not have, or the avatar it is already showing — is not
      // held for, since nothing is going to arrive to end the hold.
      case 'avatar':
        if (this.renderer?.load(c.id)) {
          this.held = [];
          this.awaiting = c.id;
        }
        return;
      case 'say':
        s.say({
          id: c.id,
          text: c.text,
          reading: c.reading,
          emotion: c.emotion,
          expression: c.expression,
          gesture: c.gesture,
          perform: c.perform,
          hold: c.hold,
          stage: c.stage,
        });
        return;
      // The whole pending list, in order. Not `clear` plus a run of `say`: the
      // session matches the new list against what it already holds and keeps the
      // audio for any line whose words did not change, which is what makes a
      // reorder cost one message instead of re-synthesising the script.
      case 'queue':
        s.replaceQueue(c.turns);
        return;
      case 'interrupt':
        s.interrupt();
        return;
      case 'clear':
        s.clearQueue();
        return;
      // Held rather than emptied, and the line on air is left alone. See
      // `pauseCommandSchema`.
      case 'pause':
        s.paused = c.on ?? true;
        return;
      case 'emotion':
        s.setEmotion(c.vec ?? c.emotion ?? { neutral: 1 });
        return;
      case 'expression':
        s.setExpression(c.id ?? null);
        return;
      // Weight, not a flag, so an effect can be brought partly up; `on: false`
      // is the same thing said the short way.
      case 'overlay':
        s.setOverlay(c.id, c.weight ?? (c.on === false ? 0 : 1));
        return;
      case 'reset':
        s.resetExpression();
        return;
      // No id means release, on the same rule as `gesture` below.
      case 'perform':
        s.perform(c.id ?? null);
        return;
      case 'gesture':
        if (c.id) s.gesture(c.id);
        else s.stopGesture();
        return;
      case 'hop':
        s.hop(c.hop);
        return;
      // No bearing means "stop pointing", for the same reason `gesture` with no
      // id means "stop": one command, and the release is not a second verb the
      // caller has to remember.
      case 'point':
        if (c.azimuth === undefined && c.elevation === undefined) s.stopGesture();
        else s.point(c);
        return;
      case 'look':
        s.lookAt(c.amount ?? 1);
        return;
      case 'idle':
        s.setIdle(c.on ?? true);
        return;
      // The whole shot, not just the framing: an absent field is left where it
      // was, so a drag on the panel's preview sends two angles and nothing else.
      case 'camera':
        s.setCamera(c);
        return;
      // No id means dry, on the same rule as `gesture` and `perform`.
      case 'room':
        s.setRoom(c.id ?? null);
        return;
      // And no id means the flat background, which is the visual equivalent of
      // dry and follows the same rule.
      case 'backdrop':
        s.setBackdrop(c.id ?? null);
        return;
      // Same rule again for the document, and `page` is where to open it —
      // absent is the first page rather than the page the last document was on.
      case 'deck':
        s.setDeck(c.id ?? null, c.page);
        return;
      // An absolute page wins over a relative move, and neither given is
      // "next": the bare command is the one an operator sends all broadcast.
      case 'slide':
        if (c.page !== undefined) s.setSlide(c.page);
        else s.turnSlide(c.by ?? 1);
        return;
      // Both halves in one call, because they are one decision — sent as two,
      // the frame is briefly wrong in the way that shows most, with the
      // character over the document.
      case 'place':
        s.setPlacement({ avatar: c.avatar, slide: c.slide });
        return;
      // Both fields are passed through as given. Absent `preset` means "keep the
      // base", which is not the same as null, so it must not be defaulted here.
      case 'voice':
        s.setVoiceChain({ preset: c.preset, dsp: c.dsp });
        return;
      case 'wear':
        s.wear(c);
        return;
      case 'tune':
        s.tune(c);
        return;
      default:
        return;
    }
  }
}

function isCommandBatch(msg: unknown): msg is { type: 'command'; commands: unknown[] } {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { type?: unknown; commands?: unknown };
  return m.type === 'command' && Array.isArray(m.commands);
}
