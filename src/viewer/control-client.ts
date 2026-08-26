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

  private connect(): void {
    if (this.stopped) return;
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
      this.setStatus('offline');
      src.close();
      this.source = null;
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
          emotion: c.emotion,
          expression: c.expression,
          gesture: c.gesture,
          hold: c.hold,
        });
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
      case 'gesture':
        if (c.id) s.gesture(c.id);
        else s.stopGesture();
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
