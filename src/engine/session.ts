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

import { parseLine } from './cues';
import type { Director } from './director';
import { EMOTION_LABELS, EMOTIONS } from './face';
import { GESTURES, HOP_IDS, HOPS } from './motion';
import { holdsUntilReleased, PERFORMANCE_IDS, PERFORMANCE_TABLE } from './performance';
import type { Wardrobe } from './scene';
import type { Tuning, TuningPatch } from './tuning';
import type {
  CameraFrame,
  EmotionName,
  EmotionVector,
  FingerName,
  GazeLimits,
  GestureDef,
  Scenery,
  SessionEvent,
  SessionEventType,
  SessionState,
  Shading,
  Side,
  Turn,
  TurnRequest,
  Vocabulary,
  Voice,
  VoiceChainRequest,
} from './types';

// A beat between turns. Lines that butt up against each other read as one long
// run-on utterance, and the breath the body layer takes at the start of a line
// has nowhere to land.
const TURN_GAP = 0.28;

// How long the queue has to stay empty before the idle takes over. Short enough
// not to look dead between turns, long enough that the autopilot does not
// barge in during the pause in a two-part answer.
const IDLE_AFTER = 1.6;

/**
 * How long a turn may sit at the head of the queue waiting to be synthesised
 * before it is played silently.
 *
 * The sidecar answers in about a second, and synthesis starts when the line is
 * queued rather than when it is played, so the wait is normally already over by
 * the time a turn reaches the front. Five seconds means the sidecar is wedged
 * or gone, and a stream that stops dead is worse than one that mouths a line:
 * the queue has to keep moving whatever the voice is doing.
 */
const VOICE_WAIT = 5;

export interface SessionOptions {
  wardrobe?: Wardrobe | null;
  camera?: ((frame: CameraFrame) => void) | null;
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
  readonly scenery: Scenery | null;
  readonly voice: Voice | null;
  readonly shading: Shading | null;

  idleEnabled: boolean;
  readonly queue: Turn[] = [];
  turn: Turn | null = null;

  private _gap = 0;
  private _sinceBusy = 0;
  /** Seconds the head of the queue has been waiting on its voice. See `VOICE_WAIT`. */
  private _waited = 0;
  /**
   * The running turn's cues, in order, resolved to seconds and shortened from
   * the front as they fire.
   */
  private _cues: Array<{ perform: string; t: number }> = [];
  /**
   * The performance this turn put up, which is the one it has to take down.
   *
   * Not `turn.perform`: a cue changes it partway through the line, and what a
   * turn leaves behind is whatever was showing last rather than whatever it
   * opened with.
   */
  private _performing: string | null = null;
  /** Disambiguates ids minted inside the same millisecond. See `nextId`. */
  private _seq = 0;
  private _events: SessionEvent[] = [];
  private readonly _listeners = new Set<SessionListener>();

  /**
   * The avatar's own eye limits, as they were measured.
   *
   * `tune`'s `eyeLimit` is a multiplier and the profile is what it multiplies,
   * so the figures it started from have to survive being scaled — reading the
   * current profile back would compound every drag of the fader. Captured per
   * session, which is per avatar: a swap builds a new one.
   */
  private readonly _baseGaze: GazeLimits;
  /** The last `eyeLimit` applied, so the layer can report what it is running. */
  private _eyeLimit = 1;

  constructor(
    director: Director,
    {
      wardrobe = null,
      camera = null,
      scenery = null,
      idle = false,
      voice = null,
      shading = null,
    }: SessionOptions = {},
  ) {
    this.d = director;
    this.wardrobe = wardrobe;
    this.camera = camera;
    this.scenery = scenery;
    this.voice = voice;
    this.shading = shading;
    this._baseGaze = { ...director.p.gaze };

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
   *
   * `perform` is the short way to say most of that — a named face-and-movement
   * from the performance table, which sets the mood and plays the gesture
   * together. It is applied first, so a turn may name one and then override a
   * single part of it.
   *
   * `reading` is the kana pronunciation of `text` and drives the mouth in its
   * place. It is not defaulted here: absent means "no reading was supplied",
   * which is different from an empty one, and the mouth needs to be able to
   * tell those apart to fall back to the text.
   *
   * The line is parsed *here*, on the way into the queue, rather than at the
   * moment it is played. Its cue markup comes out and the turn carries what is
   * actually spoken, so there is no point downstream of this call at which a
   * bracket still exists to be read out by mistake — including the queue that
   * `state()` reports on. See `cues.ts`.
   *
   * Synthesis starts here too, for the same reason and one more: a batch of
   * three lines is three requests in flight at once, so only the first turn of
   * a run ever waits. The turn is held back until the voice answers — the whole
   * point of a speech model that hands back the finished take is that the line
   * can be planned against a length that is known before it opens, rather than
   * started on a guess and jerked into place when the audio turns up.
   */
  say(request: TurnRequest = {}): string {
    const turn = this.build(request);
    this.queue.push(turn);
    this.emit('turn.queued', { turn: turn.id, queued: this.queue.length });
    return turn.id;
  }

  /**
   * Turn a request into a queued turn, and start its line being made.
   *
   * Shared by `say` and `replaceQueue` so the two cannot come to disagree about
   * what queueing a line involves — the parse, the cue filter and the moment
   * synthesis starts are all properties of *entering the queue*, not of the call
   * that put it there.
   */
  private build({
    id,
    text = '',
    reading,
    emotion = null,
    expression = null,
    gesture = null,
    perform = null,
    hold = false,
    stage,
  }: TurnRequest): Turn {
    const line = parseLine(text);
    const turn: Turn = {
      id: id ?? this.nextId(),
      text: line.text,
      // A cue naming a performance the table does not have is dropped, not
      // played. `perform()` on an unknown id releases whatever is showing —
      // right for a caller who asked for a face and can see they got none,
      // wrong mid-sentence, where it would take the character's expression away
      // in the middle of a word over a typo.
      cues: line.cues.filter((cue) => Object.hasOwn(PERFORMANCE_TABLE, cue.perform)),
      reading,
      emotion,
      expression,
      gesture,
      perform,
      hold,
      stage,
      // Absent means "still being made". A session with no voice, and a turn
      // with no words in it, are settled as null right away so nothing waits.
      ...(this.voice && line.text ? {} : { take: null }),
    };
    if (this.voice && line.text) this.synthesise(turn, this.voice);
    return turn;
  }

  /**
   * Replace everything pending with a new list, in order.
   *
   * The control API's queue lives in the server so that it survives a reload and
   * can be reordered from a panel; this is how an edit to it lands here. The
   * whole list travels rather than a diff, because a diff would have to be
   * applied against whatever this queue happened to hold, and the two ends
   * disagree constantly by nature — a turn starts here while an edit is in
   * flight from there.
   *
   * **A line that has not changed keeps its take.** That is the entire reason
   * this is not `clearQueue` followed by six `say` calls: the audio for a queued
   * line is already made or already being made, and throwing it away would send
   * the whole queue back to the sidecar on every reorder — which at a second per
   * line means a stream that goes quiet every time the operator drags a row.
   * Identity is `id` plus the words: an edited line is a different line and has
   * to be spoken again, a moved one is the same line in a new place.
   *
   * The running turn is not touched. It is already being said, and a queue edit
   * is about what comes next; stopping it is what `interrupt` is for.
   */
  replaceQueue(requests: TurnRequest[]): void {
    const held = new Map(this.queue.map((turn) => [turn.id, turn]));
    const next = requests.map((request) => {
      const existing = request.id === undefined ? undefined : held.get(request.id);
      if (existing && existing.text === parseLine(request.text ?? '').text) {
        if (existing.reading === request.reading) {
          held.delete(existing.id);
          // Everything outside the line itself is applied at `start`, so it can
          // be updated in place without costing the take.
          return Object.assign(existing, {
            emotion: request.emotion ?? null,
            expression: request.expression ?? null,
            gesture: request.gesture ?? null,
            perform: request.perform ?? null,
            hold: request.hold ?? false,
            stage: request.stage,
          });
        }
      }
      return this.build(request);
    });

    // Whatever the new list did not claim is gone. Its take has to be stopped
    // even though it never played: a take still being synthesised arrives a
    // second later and would start talking over the line that replaced it,
    // which is the same failure `clear` during synthesis has.
    for (const dropped of held.values()) dropped.take?.stop();

    this.queue.length = 0;
    this.queue.push(...next);
    this.emit('queue.replaced', { queued: this.queue.length });
  }

  /**
   * Send one line to be spoken, and settle the turn either way.
   *
   * Nothing awaits this. A rejection settles the turn as "no audio" rather than
   * propagating: a voice that is down must cost the line its sound and nothing
   * else, and an unhandled rejection on the render path would take the frame
   * loop with it.
   *
   * A turn dropped from the queue while its line was still being made gets its
   * take stopped on arrival. Without that, a `clear` during synthesis is a line
   * that starts talking a second later over whatever came next.
   */
  private synthesise(turn: Turn, voice: Voice): void {
    voice
      .prepare(turn.text, turn.reading)
      .catch(() => null)
      .then((take) => {
        turn.take = take;
        if (take && this.turn !== turn && !this.queue.includes(turn)) take.stop();
      });
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
   * Play a named performance — a face and a movement together — or release the
   * current one with `null`.
   *
   * The coarsest of the direct controls and the one to reach for first: the
   * finer ones below it exist for what the table has no name for.
   */
  perform(id: string | null): void {
    this.d.perform(id);
  }

  /** A run of hops. Runs alongside whatever the arms are doing. */
  hop(id?: string): void {
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

  /**
   * Put the voice in a named room, or take it out of one.
   *
   * Staging rather than performance, which is why it sits beside the camera and
   * not beside the face: it says where the character is being heard, not what
   * they are doing. It persists until it is changed, and it survives an avatar
   * swap the way the camera does — the room is the set, not the actor.
   *
   * A renderer with no voice has no rooms and this does nothing, which is the
   * same shape as `wear` on an avatar with no wardrobe.
   */
  setRoom(id: string | null): void {
    this.voice?.setRoom(id);
  }

  /**
   * Put the character in front of a named backdrop, or take it away.
   *
   * Staging, beside the camera and the room and for the same reason. It is
   * deliberately *not* chained to `setRoom`: how a set looks and how a voice
   * sits in a mix are chosen for different reasons and changed at different
   * moments, and a renderer that quietly moved the reverb every time the
   * backdrop changed would make every visual cut audible.
   */
  setBackdrop(id: string | null): void {
    this.scenery?.setBackdrop(id);
  }

  /**
   * Set how the voice is processed on its way out.
   *
   * Staging, like the room beside it, and passed straight through for the same
   * reason: what a chain is belongs to whatever provides the voice. It takes
   * effect from the next line synthesised rather than retroactively — a take
   * already in the queue was made with the chain that was up when it was made.
   */
  setVoiceChain(request: VoiceChainRequest): void {
    this.voice?.setChain(request);
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

  /**
   * Move part of the set-once layer. See `tuning.ts` for what is in it.
   *
   * Absent is not the same as a value, all the way down: a patch names the
   * faders that moved and leaves every other number exactly where it was. That
   * is what lets a surface send one knob per drag instead of the whole layer,
   * and it is the same rule `setVoiceChain` follows for the same reason.
   *
   * A group this avatar does not have is a no-op rather than an error — sway on
   * a model with no spring bones, a tail on a model with no tail — which is the
   * shape `wear` and `setRoom` already have.
   */
  tune(patch: TuningPatch): void {
    const d = this.d;
    const { idle, sway, hop, tail, render, settle } = patch;

    if (idle) {
      if (idle.breathDepth !== undefined) d.body.breathDepth = idle.breathDepth;
      if (idle.breathPeriod !== undefined) d.body.breathPeriod = idle.breathPeriod;
      if (idle.idleAmount !== undefined) d.body.idleAmount = idle.idleAmount;
      if (idle.weightShift !== undefined) d.body.weightShift = idle.weightShift;
      if (idle.gazeAmount !== undefined) d.body.gazeAmount = idle.gazeAmount;
      if (idle.blink !== undefined) d.blinkEnabled = idle.blink;
      // Scaled off the measured limits rather than off the current ones, so
      // dragging the fader twice does not square the multiplier.
      if (idle.eyeLimit !== undefined) {
        this._eyeLimit = idle.eyeLimit;
        d.p.gaze.eyeYaw = this._baseGaze.eyeYaw * idle.eyeLimit;
        d.p.gaze.eyePitch = this._baseGaze.eyePitch * idle.eyeLimit;
      }
    }

    if (sway) {
      if (sway.enabled !== undefined) d.spring.enabled = sway.enabled;
      if (sway.stiffness !== undefined) d.spring.stiffnessScale = sway.stiffness;
      if (sway.inertia !== undefined) d.spring.inertiaScale = sway.inertia;
      if (sway.gravity !== undefined) d.spring.gravityScale = sway.gravity;
    }

    if (hop) {
      if (hop.height !== undefined) d.body.jumpHeight = hop.height;
      if (hop.gravity !== undefined) d.body.gravity = hop.gravity;
    }

    if (tail?.amount !== undefined) d.tail.amount = tail.amount;

    if (render) {
      if (render.toon !== undefined) this.shading?.setToon(render.toon);
      // Asked for on an avatar with no ARKit shapes, this stays where it is:
      // the director reads it together with `arkit.supported`, so setting it
      // would advertise a mode the face cannot actually be driven in.
      if (render.arkit !== undefined && d.p.arkit.supported) d.useArkit = render.arkit;
    }

    // Last, so that a patch which changes the stiffness and asks for a
    // standstill in one breath gets the standstill under the new stiffness.
    if (settle) d.spring.reset();
  }

  /**
   * What that layer is running, and what this avatar has to run it with.
   *
   * Reported rather than remembered, on the same footing as `Voice.report`: a
   * fader drawn from the last command sent is a fader that lies about an avatar
   * that was swapped underneath it, and every default here belongs to the
   * engine object that owns it rather than to whoever last touched a panel.
   */
  tuning(): Tuning {
    const d = this.d;
    return {
      idle: {
        breathDepth: d.body.breathDepth,
        breathPeriod: d.body.breathPeriod,
        idleAmount: d.body.idleAmount,
        weightShift: d.body.weightShift,
        gazeAmount: d.body.gazeAmount,
        eyeLimit: this._eyeLimit,
        blink: d.blinkEnabled,
      },
      sway: {
        enabled: d.spring.enabled,
        stiffness: d.spring.stiffnessScale,
        inertia: d.spring.inertiaScale,
        gravity: d.spring.gravityScale,
      },
      hop: { height: d.body.jumpHeight, gravity: d.body.gravity },
      tail: { amount: d.tail.amount },
      render: { toon: this.shading?.toon ?? true, arkit: d.useArkit },
      has: { sway: d.spring.active, tail: d.tail.active, arkit: d.p.arkit.supported },
    };
  }

  // --- per-frame ----------------------------------------------------------

  update(dt: number): void {
    const d = this.d;

    if (this.turn) {
      const take = this.turn.take;
      if (take) {
        // The audio is the clock, and the mouth is put on it every frame rather
        // than left to add up `dt`. Both the visemes and the cues below read
        // this, so one call keeps the whole line together across a dropped
        // frame — and the travel is scaled by how loud the take is right now,
        // which is what closes the mouth through a pause the text never
        // predicted.
        d.mouth.sync(take.elapsed);
        d.mouth.setAmplitude(take.amplitude);
      }
      // Cues ride the mouth's own clock rather than a clock of the session's,
      // so they stay attached to the line: text estimate or real audio, the cue
      // lands at the same point in the sentence.
      this.fireCues(d.mouth.time);
      // A turn ends when the mouth is done with it. Driving this off the
      // duration `speak()` returned would drift: the mouth is the thing that
      // actually knows, and with a take it is the audio.
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
      // The gap runs down whether or not the voice has answered, so the wait
      // for a take and the beat between turns overlap instead of adding up.
      this._waited = this.queue[0].take === undefined ? this._waited + dt : 0;
      if (this._gap <= 0 && (this.queue[0].take !== undefined || this._waited > VOICE_WAIT)) {
        this._waited = 0;
        this.start(this.queue.shift() as Turn);
      }
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
    // The shot first, and before the audio below, so the frame the line opens
    // on is already the right one. It goes through the same three calls a
    // standalone `camera`, `backdrop` or `room` would, which is the whole point
    // of putting it on a turn: not a second way to stage, the same way, said
    // early enough to travel with the line it belongs to.
    //
    // "Before" is exact for the camera and the backdrop and approximate for the
    // room, which is not something this can fix from here. A renderer builds an
    // impulse response to change the acoustic and that is asynchronous — 2 ms
    // for the smallest of the current set and 62 for the largest — so a line
    // that moves rooms opens dry for about a frame. Standalone `room` has
    // always behaved that way; nothing here makes it worse.
    //
    // `undefined` and `null` are not the same and the difference is load
    // bearing — an axis the caller left out keeps what it had, an axis set to
    // null is emptied. `??` here would quietly turn the first into the second.
    if (turn.stage) {
      const { camera, backdrop, room } = turn.stage;
      if (camera !== undefined) this.setCamera(camera);
      if (backdrop !== undefined) this.setBackdrop(backdrop);
      if (room !== undefined) this.setRoom(room);
    }
    // The autopilot has to be off before anything goes in. Its own timer would
    // otherwise cut the gesture short on the very next frame, and switching it
    // off releases the performance it was holding — which, done later, would
    // release this turn's instead.
    d.auto = false;
    // Then the performance, so the three fields below override parts of it
    // rather than being overwritten by it.
    if (turn.perform) d.perform(turn.perform);
    this._performing = turn.perform ?? null;
    if (turn.emotion) d.setEmotion(turn.emotion);
    if (turn.expression !== null && turn.expression !== undefined) {
      d.setExpression(turn.expression);
    }
    if (turn.gesture) d.gesture(turn.gesture);
    // The audio starts and the track is stretched onto its length, in that
    // order: `elapsed` is measured from `play`, so a track scheduled first
    // would be read against a clock that had not started.
    turn.take?.play();
    // Whose envelope drives the travel is decided per turn, so a silent line
    // following a spoken one goes back to moving the mouth fully. Left alone it
    // would inherit whatever the last take's envelope stopped on — a mouth a
    // third open for a whole turn, with nothing near the cause to explain it.
    if (!turn.take) d.mouth.setAmplitude(1);
    // A turn with no text is a pose change. It has no mouth to wait on, so the
    // end check finds the mouth idle and closes it on the next frame.
    const seconds = turn.text ? d.speak(turn.text, turn.reading, turn.take?.seconds) : 0;
    // The cues arrived as fractions of the line and become seconds here,
    // against the length the mouth actually reported — which is the reading's
    // length when one was given, and will be the audio's once there is any.
    this._cues = turn.cues.map((cue) => ({ perform: cue.perform, t: cue.at * seconds }));
    // Anything sitting at the top of the line goes in now rather than a frame
    // later, so a turn that opens on a cue opens on it. A turn with no text
    // gets every cue here: it is over on the next frame and has no clock to
    // spread them along.
    this.fireCues(0);
    this.emit('turn.start', { turn: turn.id, seconds });
  }

  /**
   * Play every cue that is due, in order.
   *
   * `<=` and not `<`, so a cue written at the very start of a line fires at
   * time zero rather than one frame into it.
   */
  private fireCues(t: number): void {
    while (this._cues.length > 0 && this._cues[0].t <= t) {
      const cue = this._cues.shift() as { perform: string; t: number };
      this.d.perform(cue.perform);
      this._performing = cue.perform;
    }
  }

  private release(turn: Turn): void {
    // Whatever is left unfired goes with the turn. A line that was cut short
    // should not go on changing face after it stopped being spoken.
    this._cues.length = 0;
    // Stopping a take that has already finished is a no-op; stopping one that
    // has not is the difference between `interrupt` being a kill switch and
    // being a kill switch for everything except the voice.
    turn.take?.stop();
    // The emotion stays — a mood outlives the sentence that carried it. The
    // drawn face does not: held past its line it stops reading as a reaction
    // and starts reading as the character's actual face.
    if (turn.expression && !turn.hold) this.d.setExpression(null);
    // A performance goes the same way and for the same reason: what it holds —
    // folded arms, lowered lids — is a reaction to the line, not the character's
    // resting state. Only if it is still the one showing, so a turn that was
    // followed by something else does not reach back and cancel it. Its mood
    // stays behind, like any other.
    const showing = this._performing;
    this._performing = null;
    if (showing && !turn.hold && this.d.performance === showing) {
      this.d.perform(null);
    }
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
      // First among the body entries, because it is the one an orchestrator
      // should be reaching for: a performance names a face and a movement
      // together, and the two lists after it are its parts.
      performances: PERFORMANCE_IDS.map((id) => {
        const def = PERFORMANCE_TABLE[id];
        return {
          id,
          label: def.label,
          group: def.group,
          emotion: { ...def.emotion },
          gesture: def.gesture ?? null,
          hop: def.hop ?? null,
          sustain: holdsUntilReleased(def),
        };
      }),
      gestures: (Object.entries(GESTURES) as Array<[string, GestureDef]>).map(([id, g]) => ({
        id,
        label: g.label,
        group: g.group,
        sustain: !!g.sustain,
      })),
      hops: HOP_IDS.map((id) => ({ id, label: HOPS[id].label })),
      cue: {
        syntax: '[performance]',
        note: 'say の text に直接書く。書いた位置でその performance が始まる。[] の中身は読み上げられない — 角括弧は予約されていて台詞には書けない。例: [hello]こんばんは。[explain]今日はこの話をします。',
      },
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
      rooms: this.voice?.rooms ?? [],
      backdrops: this.scenery?.backdrops ?? [],
      voicePresets: this.voice?.presets ?? [],
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
      performance: d.performance,
      gesture: d.body.gesture?.id ?? null,
      hopping: d.body.jumping,
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
