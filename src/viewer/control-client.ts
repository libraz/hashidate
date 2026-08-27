import type { Session } from '@/engine/session';
import type { SessionEvent } from '@/engine/types';
import { type Command, parseCommand, type ReportBody } from '@/protocol';

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

export type ControlStatus = 'online' | 'offline';

export interface ControlOptions {
  base?: string;
  onStatus?: (status: ControlStatus) => void;
  /** Commands the wire carried but the schema rejected. Surfaced, not swallowed. */
  onRejected?: (raw: unknown) => void;
}

export class ControlClient {
  private session: Session;
  private readonly base: string;
  private readonly onStatus: (status: ControlStatus) => void;
  private readonly onRejected: (raw: unknown) => void;

  status: ControlStatus = 'offline';

  private pending: SessionEvent[] = [];
  private chain: Promise<void> = Promise.resolve();
  private unbind: (() => void) | null = null;
  private source: EventSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(session: Session, opts: ControlOptions = {}) {
    this.session = session;
    this.base = opts.base ?? '/api';
    this.onStatus = opts.onStatus ?? (() => {});
    this.onRejected = opts.onRejected ?? (() => {});
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
   */
  bind(session: Session): void {
    this.unbind?.();
    this.session = session;
    this.unbind = session.on((ev) => {
      this.pending.push(ev);
      // Turn boundaries are what a caller blocks on, so they go up immediately
      // rather than on the next tick of the reporting timer.
      if (ev.type.startsWith('turn.')) void this.report();
    });
    if (this.status === 'online') void this.report(true);
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
      // it until a viewer has loaded one. Push it on every connect.
      void this.report(true);
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
    const body: ReportBody = { state: this.session.state(), events };
    if (withVocabulary) body.vocabulary = this.session.vocabulary();
    // The chain the renderer is *actually* running, so a panel draws that rather
    // than what it last sent — see `VoiceReport`. On the report timer and not
    // only on change, because it carries the loudness of the last take and a
    // meter that only updates when a setting moves is not a meter.
    const voice = this.session.voice?.report();
    if (voice) body.voice = voice;

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
   */
  apply(c: Command): void {
    const s = this.session;
    switch (c.cmd) {
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
      case 'camera':
        s.setCamera(c.frame);
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
      // Both fields are passed through as given. Absent `preset` means "keep the
      // base", which is not the same as null, so it must not be defaulted here.
      case 'voice':
        s.setVoiceChain({ preset: c.preset, dsp: c.dsp });
        return;
      case 'wear':
        s.wear(c);
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
