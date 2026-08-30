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
 * - a queue of turns, played in order          — `turns.ts`
 * - interruption, because a live stream needs a stop button
 * - the idle, suspended for the duration of a turn and resumed after it
 * - events, so the caller knows when a turn started and ended — `events.ts`
 * - the vocabulary, so the caller can be told what this avatar can do
 *   — `introspection.ts`
 *
 * plus the two things a turn shares with the commands that stand alone: where
 * the line is delivered (`stage.ts`) and the set-once layer under all of it
 * (`tuning.ts`).
 *
 * This file is the surface those meet at. It holds the ports the renderer
 * supplied, wires the parts to each other, and owns the one piece of timing
 * that belongs to none of them: when the idle is allowed back.
 *
 * It is transport-agnostic on purpose. The control server carries it over HTTP;
 * the UI calls the same methods in-process; a Unity build would implement the
 * same command set over whatever channel it prefers.
 */

import type { Director } from '../director';
import type { Wardrobe } from '../scene';
import type { Tuning, TuningPatch } from '../tuning';
import type {
  Composition,
  EmotionVector,
  FingerName,
  Placement,
  Scenery,
  SessionEvent,
  SessionState,
  Shading,
  Shot,
  Side,
  SlidePlacement,
  Slides,
  Turn,
  TurnRequest,
  Vocabulary,
  Voice,
  VoiceChainRequest,
} from '../types';
import { SessionEvents, type SessionListener } from './events';
import { describe, snapshot } from './introspection';
import { Stage } from './stage';
import { TuningControl } from './tuning';
import { TurnQueue } from './turns';

export type { SessionListener } from './events';

// How long the queue has to stay empty before the idle takes over. Short enough
// not to look dead between turns, long enough that the autopilot does not
// barge in during the pause in a two-part answer.
const IDLE_AFTER = 1.6;

export interface SessionOptions {
  wardrobe?: Wardrobe | null;
  /**
   * Where the camera stands. Absent means the renderer has no camera to move,
   * which is what every test is.
   */
  camera?: ((shot: Shot) => void) | null;
  /**
   * What the character is seen in front of. Absent means the renderer has no
   * backdrops, and `backdrop` does nothing — which is what every test is.
   */
  scenery?: Scenery | null;
  idle?: boolean;
  /**
   * Where lines go to be spoken. Absent means the mouth runs on the text
   * estimate, which is the only thing a machine without the voice can do — and
   * is what every test does.
   */
  voice?: Voice | null;
  /**
   * How the avatar's materials are drawn. Absent means the renderer draws only
   * one way, and the `render.toon` half of a tuning patch does nothing.
   */
  shading?: Shading | null;
  /**
   * The document the character presents from. Absent means the renderer has no
   * document layer, and `deck` and `slide` do nothing — which is every test.
   */
  slides?: Slides | null;
  /**
   * How the output frame is laid out. Absent means the renderer draws one way
   * and `place` does nothing, on the same footing as `shading`.
   */
  composition?: Composition | null;
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

export class Session {
  readonly d: Director;
  readonly wardrobe: Wardrobe | null;
  /** (frame) => void */
  readonly camera: ((shot: Shot) => void) | null;
  readonly scenery: Scenery | null;
  readonly voice: Voice | null;
  readonly shading: Shading | null;
  readonly slides: Slides | null;
  readonly composition: Composition | null;

  idleEnabled: boolean;

  private readonly _events = new SessionEvents();
  private readonly _stage: Stage;
  private readonly _turns: TurnQueue;
  private readonly _tuning: TuningControl;

  private _sinceBusy = 0;

  constructor(
    director: Director,
    {
      wardrobe = null,
      camera = null,
      scenery = null,
      idle = false,
      voice = null,
      shading = null,
      slides = null,
      composition = null,
    }: SessionOptions = {},
  ) {
    this.d = director;
    this.wardrobe = wardrobe;
    this.camera = camera;
    this.scenery = scenery;
    this.voice = voice;
    this.shading = shading;
    this.slides = slides;
    this.composition = composition;

    this._stage = new Stage(camera, scenery, voice, slides, composition);
    this._turns = new TurnQueue(director, voice, this._stage, this._events);
    this._tuning = new TuningControl(director, shading);

    // Off by default so opening the viewer gives a still character. An
    // orchestrator turns it on once at startup: between turns a character that
    // holds perfectly still reads as a frozen stream.
    this.idleEnabled = idle;
  }

  // --- the queue, as the outside sees it ------------------------------------
  //
  // Three properties rather than an exposed collaborator, because these are
  // what a control client reads and what the tests assert on — the queue is
  // part of this object's surface even though it is not part of its body.

  /** The turns waiting, in the order they will be said. */
  get queue(): Turn[] {
    return this._turns.queue;
  }

  /** The turn on air, or null between them. */
  get turn(): Turn | null {
    return this._turns.turn;
  }

  /** Whether the queue is held. See `TurnQueue.paused`. */
  get paused(): boolean {
    return this._turns.paused;
  }

  set paused(on: boolean) {
    this._turns.paused = on;
  }

  // --- events -------------------------------------------------------------

  on(fn: SessionListener): () => void {
    return this._events.on(fn);
  }

  /** Drain the events accumulated since the last call. */
  takeEvents(): SessionEvent[] {
    return this._events.take();
  }

  // --- turns --------------------------------------------------------------

  /** Queue one turn. See `TurnQueue.say`. */
  say(request: TurnRequest = {}): string {
    return this._turns.say(request);
  }

  /** Replace everything pending with a new list. See `TurnQueue.replaceQueue`. */
  replaceQueue(requests: TurnRequest[]): void {
    this._turns.replaceQueue(requests);
  }

  /** Stop mid-sentence and drop everything pending. The stream's kill switch. */
  interrupt(): void {
    this._turns.interrupt();
  }

  /** Drop what is pending but let the current line finish. */
  clearQueue(): void {
    this._turns.clear();
  }

  /** Whether something is happening that the idle must stay out of the way of. */
  get busy(): boolean {
    return this._turns.busy;
  }

  // --- direct control -----------------------------------------------------
  //
  // For everything that is not a turn: the state an orchestrator sets between
  // lines, or a control surface pokes at directly.

  /**
   * Give a direct face/body command a quiet window before idle resumes.
   *
   * This does not disable idle. It only restarts the same grace period used
   * after a turn, and it is intentionally called by the public wrappers only;
   * turn-internal release paths call the director directly so they cannot wake
   * idle by accident.
   */
  private wake(): void {
    this._sinceBusy = 0;
    this.d.auto = false;
  }

  setEmotion(vec: EmotionVector): void {
    this.wake();
    this.d.setEmotion(vec);
  }

  setExpression(id: string | null): void {
    this.wake();
    this.d.setExpression(id);
  }

  setOverlay(id: string, weight?: number): void {
    this.wake();
    this.d.setOverlay(id, weight);
  }

  resetExpression(): void {
    this.wake();
    this.d.resetExpression();
  }

  /** One movement. `side` pins the hand; absent leaves it to the per-playback draw. */
  gesture(id: string, side?: Side): void {
    this.wake();
    this.d.gesture(id, side);
  }

  stopGesture(): void {
    this.wake();
    this.d.body.stopGesture();
  }

  /**
   * Play a named performance — a face and a movement together — or release the
   * current one with `null`.
   *
   * The coarsest of the direct controls and the one to reach for first: the
   * finer ones below it exist for what the table has no name for.
   *
   * `side` pins the hand of the movement it names, exactly as it does on
   * `gesture`. A release carries none: there is no hand in stopping.
   */
  perform(id: string | null, side?: Side): void {
    this.wake();
    this.d.perform(id, side);
  }

  /** A run of hops. Runs alongside whatever the arms are doing. */
  hop(id?: string): void {
    this.wake();
    this.d.hop(id);
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
    this.wake();
    this.d.point(side, { azimuth, elevation, extent, finger });
  }

  lookAt(v: number): void {
    this.wake();
    this.d.lookAt(v);
  }

  setIdle(on: boolean): void {
    this.idleEnabled = !!on;
    if (!this.idleEnabled) this.d.auto = false;
  }

  // --- staging ------------------------------------------------------------
  //
  // Where the line is delivered. Every one of these is the same call a turn's
  // `stage` makes, said now rather than with a line — see `stage.ts`.

  setCamera(shot: Shot): void {
    this._stage.setCamera(shot);
  }

  setRoom(id: string | null): void {
    this._stage.setRoom(id);
  }

  setBackdrop(id: string | null): void {
    this._stage.setBackdrop(id);
  }

  setDeck(id: string | null, page?: number): void {
    this._stage.setDeck(id, page);
  }

  setSlide(page: number): void {
    this._stage.setSlide(page);
  }

  turnSlide(by: number): void {
    this._stage.turnSlide(by);
  }

  setPlacement(placement: { avatar?: Placement; slide?: SlidePlacement }): void {
    this._stage.setPlacement(placement);
  }

  setVoiceChain(request: VoiceChainRequest): void {
    this._stage.setVoiceChain(request);
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

  /** Move part of the set-once layer. See `TuningControl.apply`. */
  tune(patch: TuningPatch): void {
    this._tuning.apply(patch);
  }

  /** What that layer is running. See `TuningControl.report`. */
  tuning(): Tuning {
    return this._tuning.report();
  }

  // --- per-frame ----------------------------------------------------------

  update(dt: number): void {
    this._turns.update(dt);

    // The idle is suspended while a turn is in flight and for a moment after,
    // so the autopilot cannot overwrite the emotion the orchestrator just set
    // or throw a gesture into the middle of a line.
    this._sinceBusy = this.busy ? 0 : this._sinceBusy + dt;
    this.d.auto =
      this.idleEnabled && !this.d.baselinePerformanceHeld && this._sinceBusy > IDLE_AFTER;
  }

  // --- introspection ------------------------------------------------------

  /** What this avatar can be asked to do. See `describe`. */
  vocabulary(): Vocabulary {
    return describe(this.d, {
      wardrobe: this.wardrobe,
      voice: this.voice,
      scenery: this.scenery,
    });
  }

  /** Everything an orchestrator might branch on, cheap enough to poll. */
  state(): SessionState {
    return snapshot(this.d, {
      turn: this.turn,
      queued: this.queue.length,
      busy: this.busy,
      idleEnabled: this.idleEnabled,
      wardrobe: this.wardrobe,
    });
  }
}
