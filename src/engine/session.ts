/**
 * Session — the thing an orchestrator actually talks to.
 *
 * `Director` exposes state: set an emotion, play a gesture, start a mouth. That
 * is the right shape for a control panel and the wrong shape for an AITuber,
 * where the unit of work is a **turn**: one line of dialogue, delivered with a
 * face and a gesture, followed by the next one. An orchestrator driving the
 * director directly has to keep its own clock, know when the mouth stops, and
 * remember to put the idle back afterwards. It would get that wrong.
 *
 * So this layer owns:
 *
 * - a queue of turns, played in order
 * - interruption, because a live stream needs a stop button
 * - the idle, suspended for the duration of a turn and resumed after it
 * - events, so the caller knows when a turn started and ended
 * - the vocabulary, so the caller can be told what this avatar can do
 *
 * It is transport-agnostic on purpose. The control server carries it over HTTP;
 * the UI calls the same methods in-process; a Unity build would implement the
 * same command set over whatever channel it prefers.
 */

import type { Director } from './director';
import { EMOTION_LABELS, EMOTIONS } from './face';
import { GESTURES } from './motion';
import type { Wardrobe } from './scene';
import type {
  CameraFrame,
  EmotionName,
  EmotionVector,
  FingerName,
  GestureDef,
  SessionEvent,
  SessionEventType,
  SessionState,
  Side,
  Turn,
  TurnRequest,
  Vocabulary,
} from './types';

// A beat between turns. Lines that butt up against each other read as one long
// run-on utterance, and the breath the body layer takes at the start of a line
// has nowhere to land.
const TURN_GAP = 0.28;

// How long the queue has to stay empty before the idle takes over. Short enough
// not to look dead between turns, long enough that the autopilot does not
// barge in during the pause in a two-part answer.
const IDLE_AFTER = 1.6;

export interface SessionOptions {
  wardrobe?: Wardrobe | null;
  camera?: ((frame: CameraFrame) => void) | null;
  idle?: boolean;
}

/**
 * A bearing for the fingertip, in **degrees**, as the control API states it.
 * It stays in degrees down to the body layer, which converts.
 */
export interface PointOptions {
  side?: Side;
  azimuth?: number;
  elevation?: number;
  extent?: number;
  finger?: FingerName;
}

/** One wardrobe change: a slot to dress, or a whole preset to apply. */
export interface WearRequest {
  slot?: string;
  item?: string | null;
  preset?: string;
}

/** Everything an event carries besides the type it is. */
type EventPayload = Omit<SessionEvent, 'type'>;

export type SessionListener = (ev: SessionEvent) => void;

export class Session {
  readonly d: Director;
  readonly wardrobe: Wardrobe | null;
  /** (frame) => void */
  readonly camera: ((frame: CameraFrame) => void) | null;

  idleEnabled: boolean;
  readonly queue: Turn[] = [];
  turn: Turn | null = null;

  private _gap = 0;
  private _sinceBusy = 0;
  /** Disambiguates ids minted inside the same millisecond. See `nextId`. */
  private _seq = 0;
  private _events: SessionEvent[] = [];
  private readonly _listeners = new Set<SessionListener>();

  constructor(
    director: Director,
    { wardrobe = null, camera = null, idle = false }: SessionOptions = {},
  ) {
    this.d = director;
    this.wardrobe = wardrobe;
    this.camera = camera;

    // Off by default so opening the viewer gives a still character. An
    // orchestrator turns it on once at startup: between turns a character that
    // holds perfectly still reads as a frozen stream.
    this.idleEnabled = idle;
  }

  // --- events -------------------------------------------------------------

  on(fn: SessionListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private emit(type: SessionEventType, extra: EventPayload = {}): void {
    const ev: SessionEvent = { type, ...extra };
    this._events.push(ev);
    for (const fn of this._listeners) fn(ev);
  }

  /** Drain the events accumulated since the last call. */
  takeEvents(): SessionEvent[] {
    const out = this._events;
    this._events = [];
    return out;
  }

  // --- turns --------------------------------------------------------------

  /**
   * Queue one turn.
   *
   * Everything except `text` is optional, and everything optional applies for
   * the duration of the turn: the emotion persists afterwards (a mood does not
   * end with the sentence), the expression is released unless `hold` is set (a
   * drawn face left up becomes a mask), and the gesture ends on its own.
   */
  say({
    id,
    text = '',
    emotion = null,
    expression = null,
    gesture = null,
    hold = false,
  }: TurnRequest = {}): string {
    const turn: Turn = {
      id: id ?? this.nextId(),
      text,
      emotion,
      expression,
      gesture,
      hold,
    };
    this.queue.push(turn);
    this.emit('turn.queued', { turn: turn.id, queued: this.queue.length });
    return turn.id;
  }

  /**
   * A turn id that is actually unique.
   *
   * The timestamp alone is not: a caller queueing three lines in one round trip
   * — which the wire format explicitly supports, and which the command handler
   * applies in a tight loop — gets three ids from the same millisecond. The
   * whole point of the id is that `turn.start` and `turn.end` come back under
   * it, so a collision leaves the caller unable to tell which turn ended.
   */
  private nextId(): string {
    this._seq += 1;
    return `t${Date.now().toString(36)}-${this._seq.toString(36)}`;
  }

  /** Stop mid-sentence and drop everything pending. The stream's kill switch. */
  interrupt(): void {
    const dropped = this.queue.map((t) => t.id);
    this.queue.length = 0;
    this.d.mouth.stop();
    this.d.body.stopGesture();
    if (this.turn) {
      const id = this.turn.id;
      this.release(this.turn);
      this.turn = null;
      this.emit('turn.interrupted', { turn: id });
    }
    if (dropped.length) this.emit('queue.dropped', { turns: dropped });
    this._gap = 0;
  }

  /** Drop what is pending but let the current line finish. */
  clearQueue(): void {
    const dropped = this.queue.map((t) => t.id);
    this.queue.length = 0;
    if (dropped.length) this.emit('queue.dropped', { turns: dropped });
  }

  get busy(): boolean {
    return !!this.turn || this.queue.length > 0 || this.d.mouth.speaking;
  }

  // --- direct control -----------------------------------------------------
  //
  // For everything that is not a turn: the state an orchestrator sets between
  // lines, or a control surface pokes at directly.

  setEmotion(vec: EmotionVector): void {
    this.d.setEmotion(vec);
  }

  setExpression(id: string | null): void {
    this.d.setExpression(id);
  }

  setOverlay(id: string, weight?: number): void {
    this.d.setOverlay(id, weight);
  }

  resetExpression(): void {
    this.d.resetExpression();
  }

  gesture(id: string): void {
    this.d.gesture(id);
  }

  stopGesture(): void {
    this.d.body.stopGesture();
  }

  /**
   * Point a fingertip at a bearing. Held until released, like any pose.
   *
   * Distinct from `gesture` because the target is continuous: an orchestrator
   * indicating something on screen has a direction, not the name of one of
   * thirty-five canned poses.
   */
  point({
    side = 'R',
    azimuth = 0,
    elevation = 0,
    extent = 0.8,
    finger = 'index',
  }: PointOptions = {}): void {
    this.d.point(side, { azimuth, elevation, extent, finger });
  }

  lookAt(v: number): void {
    this.d.lookAt(v);
  }

  setIdle(on: boolean): void {
    this.idleEnabled = !!on;
  }

  setCamera(frame: CameraFrame): void {
    this.camera?.(frame);
  }

  wear({ slot, item, preset }: WearRequest): boolean {
    if (!this.wardrobe) return false;
    if (preset) {
      this.wardrobe.applyPreset(preset);
      return true;
    }
    if (slot) {
      this.wardrobe.set(slot, item ?? null);
      return true;
    }
    return false;
  }

  // --- per-frame ----------------------------------------------------------

  update(dt: number): void {
    const d = this.d;

    if (this.turn) {
      // A turn ends when the mouth is done with it. Driving this off the
      // duration `speak()` returned would drift: the mouth is the thing that
      // actually knows, and once TTS is wired in it will be the audio.
      if (!d.mouth.speaking) {
        const done = this.turn;
        this.release(done);
        this.turn = null;
        this._gap = TURN_GAP;
        this.emit('turn.end', { turn: done.id });
        if (!this.queue.length) this.emit('queue.empty', {});
      }
    } else if (this.queue.length) {
      this._gap -= dt;
      if (this._gap <= 0) this.start(this.queue.shift() as Turn);
    }

    // The idle is suspended while a turn is in flight and for a moment after,
    // so the autopilot cannot overwrite the emotion the orchestrator just set
    // or throw a gesture into the middle of a line.
    this._sinceBusy = this.busy ? 0 : this._sinceBusy + dt;
    d.auto = this.idleEnabled && this._sinceBusy > IDLE_AFTER;
  }

  private start(turn: Turn): void {
    this.turn = turn;
    const d = this.d;
    if (turn.emotion) d.setEmotion(turn.emotion);
    if (turn.expression !== null && turn.expression !== undefined) {
      d.setExpression(turn.expression);
    }
    // The autopilot has to be off before the gesture goes in, or its own timer
    // can cut this one short on the very next frame.
    d.auto = false;
    if (turn.gesture) d.gesture(turn.gesture);
    // A turn with no text is a pose change. It has no mouth to wait on, so the
    // end check finds the mouth idle and closes it on the next frame.
    const seconds = turn.text ? d.speak(turn.text) : 0;
    this.emit('turn.start', { turn: turn.id, seconds });
  }

  private release(turn: Turn): void {
    // The emotion stays — a mood outlives the sentence that carried it. The
    // drawn face does not: held past its line it stops reading as a reaction
    // and starts reading as the character's actual face.
    if (turn.expression && !turn.hold) this.d.setExpression(null);
  }

  // --- introspection ------------------------------------------------------

  /**
   * What this avatar can be asked to do.
   *
   * Discovered, not declared: the expression list comes from the avatar's own
   * shape groups and the wardrobe from its meshes, so swapping the avatar
   * changes what the orchestrator is offered. This is the object to paste into
   * an LLM's system prompt.
   */
  vocabulary(): Vocabulary {
    const d = this.d;
    return {
      // Which avatar this vocabulary describes. Everything below it is that
      // avatar's, and an orchestrator holding a cached copy needs to be able to
      // tell that the thing on screen changed under it.
      avatar: { id: d.a.id ?? null, label: d.a.label ?? null },
      emotions: (Object.keys(EMOTIONS) as EmotionName[]).map((id) => ({
        id,
        label: EMOTION_LABELS[id] ?? id,
      })),
      expressions: d.presets.map((p) => ({ id: p.id, label: p.label })),
      overlays: d.overlays.map((o) => ({ id: o.id, label: o.label })),
      gestures: (Object.entries(GESTURES) as Array<[string, GestureDef]>).map(([id, g]) => ({
        id,
        label: g.label,
        group: g.group,
        sustain: !!g.sustain,
      })),
      cameras: ['bust', 'upper', 'face', 'full'],
      // Continuous, so it is stated as ranges rather than as a list of ids.
      // The bounds are the anatomical ones: past them the arm still goes as far
      // as it can, but the pose is a strained one and reads that way.
      pointing: {
        side: ['L', 'R'],
        azimuth: [-120, 120],
        elevation: [-70, 110],
        extent: [0.1, 1],
        finger: ['thumb', 'index', 'middle', 'ring', 'little'],
        note: 'azimuth 0 = 正面、+ がキャラクターから見て右。elevation 0 = 肩の高さ。extent は腕の全長に対する割合',
      },
      // Read off the loaded wardrobe rather than a module-level table: the slot
      // names themselves are avatar data, so an orchestrator that cached this
      // for one avatar holds nothing that applies to the next.
      wardrobe: Object.fromEntries(
        Object.entries(this.wardrobe?.slots ?? {}).map(([slot, def]) => [
          slot,
          { label: def.label, items: def.items.map((i) => ({ id: i.id, label: i.label })) },
        ]),
      ),
      wardrobePresets: Object.entries(this.wardrobe?.presetDefs ?? {}).map(([id, p]) => ({
        id,
        label: p.label,
      })),
    };
  }

  /** Everything an orchestrator might branch on, cheap enough to poll. */
  state(): SessionState {
    const d = this.d;
    return {
      speaking: d.mouth.speaking,
      turn: this.turn?.id ?? null,
      queued: this.queue.length,
      busy: this.busy,
      idle: d.auto,
      idleEnabled: this.idleEnabled,
      emotion: Object.fromEntries(
        (Object.entries(d.target) as Array<[EmotionName, number]>)
          .filter(([, v]) => v > 0.01)
          .map(([k, v]) => [k, +v.toFixed(2)]),
      ) as EmotionVector,
      expression: d.expression,
      pickedExpression: d.pickedExpression,
      overlays: d.overlayState,
      gesture: d.body.gesture?.id ?? null,
      // Joint strain from the last fingertip solve, per arm. 0 is a pose that
      // sits entirely inside comfortable range; above about 1 the arm is
      // reaching for something it cannot comfortably get to, which is the only
      // way a caller can tell that without looking at the render.
      strain: { L: +d.body.pointStrain.L.toFixed(2), R: +d.body.pointStrain.R.toFixed(2) },
      lookAt: d.body.lookAt,
      wardrobe: this.wardrobe ? { ...this.wardrobe.state } : null,
    };
  }
}
