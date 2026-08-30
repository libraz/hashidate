import type { InlineCueAction } from '../../protocol/cues';
import { parseLine } from '../cues';
import type { Director } from '../director';
import { PERFORMANCE_TABLE } from '../performance';
import type { Cue, Turn, TurnRequest, Voice } from '../types';
import type { SessionEvents } from './events';
import type { Stage } from './stage';

/**
 * The queue, and the life of one turn in it.
 *
 * A turn is the unit of work: one line of dialogue, delivered with a face and a
 * gesture, followed by the next one. Everything about *when* — the beat between
 * lines, the wait for a take, which cue is due, what has to be put back when
 * the line ends — is here, and nothing else in the session has to know about
 * any of it.
 */

// A beat between turns. Lines that butt up against each other read as one long
// run-on utterance, and the breath the body layer takes at the start of a line
// has nowhere to land.
const TURN_GAP = 0.28;

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

function cueAction(cue: Cue): InlineCueAction | null {
  if (cue.action !== undefined) return cue.action;
  return cue.perform === undefined ? null : { kind: 'perform', id: cue.perform };
}

function playableCues(cues: Cue[]): Cue[] {
  return cues.filter((cue) => {
    const action = cueAction(cue);
    return (
      action !== null && (action.kind !== 'perform' || Object.hasOwn(PERFORMANCE_TABLE, action.id))
    );
  });
}

export class TurnQueue {
  readonly queue: Turn[] = [];
  turn: Turn | null = null;

  /**
   * Hold the queue where it is. The turn on air is not affected.
   *
   * Only `update` reads this, and only to decline to take the next turn off the
   * queue. Everything upstream of that — the parse, the cue filter, the request
   * to the voice — happens when a line *enters* the queue, so a held queue is
   * one that is already being synthesised. That is the point of holding here
   * rather than by simply not sending the list: a recording released against a
   * queue full of prepared audio opens on the first word instead of on the wait
   * for it.
   */
  paused = false;

  private _gap = 0;
  /** The queue head currently waiting on its voice, and how long it has waited. */
  private _waiting: { turn: Turn; seconds: number } | null = null;
  /**
   * The running turn's cues, in order, resolved to seconds and shortened from
   * the front as they fire.
   */
  private _cues: Array<{ cue: Cue; t: number; ordinal: number }> = [];
  /**
   * The performance this turn put up, which is the one it has to take down.
   *
   * Not `turn.perform`: a cue changes it partway through the line, and what a
   * turn leaves behind is whatever was showing last rather than whatever it
   * opened with.
   */
  private _performing: string | null = null;
  /** The last inline expression, which is released with its turn. */
  private _cuedExpression: string | null = null;
  /** Disambiguates ids minted inside the same millisecond. See `nextId`. */
  private _seq = 0;

  constructor(
    private readonly d: Director,
    private readonly voice: Voice | null,
    private readonly stage: Stage,
    private readonly events: SessionEvents,
  ) {}

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
   * place. It is not defaulted here: an omitted reading falls back to the text,
   * while wire and script validation keep an empty reading out of the queue.
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
    this.events.emit('turn.queued', { turn: turn.id, queued: this.queue.length });
    return turn.id;
  }

  /** Keep only actions this renderer can safely apply at the cue's timestamp. */
  private playableCues(cues: Cue[]): Cue[] {
    return playableCues(cues).filter((cue) => {
      const action = cueAction(cue);
      return action?.kind !== 'expression' || this.d.presetById.has(action.id);
    });
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
    side,
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
      cues: this.playableCues(line.cues),
      reading,
      emotion,
      expression,
      gesture,
      perform,
      side,
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
    const next: Turn[] = [];
    for (const request of requests) {
      // The current turn is already on air. A server-side queue snapshot can
      // briefly contain its id while a start event is in flight, but publishing
      // that id back here must not create a second pending turn.
      if (request.id !== undefined && request.id === this.turn?.id) continue;
      const existing = request.id === undefined ? undefined : held.get(request.id);
      const line = parseLine(request.text ?? '');
      if (existing && existing.text === line.text) {
        if (existing.reading === request.reading) {
          held.delete(existing.id);
          // Markup-only edits keep the prepared take but replace the timed
          // actions that will be applied when this turn reaches the air.
          existing.cues = this.playableCues(line.cues);
          // Everything outside the line itself is applied at `start`, so it can
          // be updated in place without costing the take.
          Object.assign(existing, {
            emotion: request.emotion ?? null,
            expression: request.expression ?? null,
            gesture: request.gesture ?? null,
            perform: request.perform ?? null,
            side: request.side,
            hold: request.hold ?? false,
            stage: request.stage,
          });
          next.push(existing);
          continue;
        }
      }
      next.push(this.build(request));
    }

    // Whatever the new list did not claim is gone. Its take has to be stopped
    // even though it never played: a take still being synthesised arrives a
    // second later and would start talking over the line that replaced it,
    // which is the same failure `clear` during synthesis has.
    for (const dropped of held.values()) dropped.take?.stop();

    this.queue.length = 0;
    this.queue.push(...next);
    this.events.emit('queue.replaced', { queued: this.queue.length });
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
        if (this.turn === turn) {
          // VOICE_WAIT may have started this line silently. A late take must
          // not be assigned after the line opened: it has never been played,
          // and making it the clock would leave the turn running on a clock
          // that cannot advance.
          if (take) take.stop();
          turn.take = null;
        } else if (this.queue.includes(turn)) {
          turn.take = take;
        } else {
          // The turn was removed while synthesis was in flight. Do not let a
          // late answer resurrect audio for a line the queue no longer owns.
          take?.stop();
        }
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
      this.events.emit('turn.interrupted', { turn: id });
    }
    if (dropped.length) this.events.emit('queue.dropped', { turns: dropped });
    this._gap = 0;
  }

  /** Drop what is pending but let the current line finish. */
  clear(): void {
    const dropped = this.queue.map((t) => t.id);
    this.queue.length = 0;
    if (dropped.length) this.events.emit('queue.dropped', { turns: dropped });
  }

  /**
   * Whether something is happening that the idle must stay out of the way of.
   *
   * A held queue does not count. Lines waiting behind a hold are lines nobody
   * has asked for yet — the operator is framing a shot, and this is the stretch
   * where a character that holds perfectly still reads as a frozen stream. It
   * is also the stretch a recording opens on, which is the one place that
   * stillness would be kept.
   */
  get busy(): boolean {
    return !!this.turn || (this.queue.length > 0 && !this.paused) || this.d.mouth.speaking;
  }

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
        this.events.emit('turn.end', { turn: done.id });
        if (!this.queue.length) this.events.emit('queue.empty', {});
      }
    } else if (this.queue.length && !this.paused) {
      this._gap -= dt;
      // The gap runs down whether or not the voice has answered, so the wait
      // for a take and the beat between turns overlap instead of adding up.
      const head = this.queue[0];
      let waited = 0;
      if (head.take === undefined) {
        let waiting = this._waiting;
        if (waiting?.turn !== head) {
          waiting = { turn: head, seconds: 0 };
          this._waiting = waiting;
        }
        waiting.seconds += dt;
        waited = waiting.seconds;
      } else {
        this._waiting = null;
      }
      if (this._gap <= 0 && (head.take !== undefined || waited > VOICE_WAIT)) {
        this._waiting = null;
        this.start(this.queue.shift() as Turn);
      }
    }
  }

  private start(turn: Turn): void {
    this.turn = turn;
    const d = this.d;
    // The shot first, and before the audio below, so the frame the line opens
    // on is already the right one. See `Stage.apply` for the order the five
    // axes go in and why it is that order.
    if (turn.stage) this.stage.apply(turn.stage);
    // The autopilot has to be off before anything goes in. Its own timer would
    // otherwise cut the gesture short on the very next frame, and switching it
    // off releases the performance it was holding — which, done later, would
    // release this turn's instead.
    d.auto = false;
    // Then the performance, so the three fields below override parts of it
    // rather than being overwritten by it.
    // `side` reaches whichever of the two actually plays a movement. A turn
    // that names both overrides the performance's gesture with its own, so the
    // hand travels with the one that survives rather than being applied twice.
    if (turn.perform) d.perform(turn.perform, turn.side);
    this._performing = turn.perform ?? null;
    if (turn.emotion) d.setEmotion(turn.emotion);
    if (turn.expression !== null && turn.expression !== undefined) {
      d.setExpression(turn.expression);
    }
    if (turn.gesture) d.gesture(turn.gesture, turn.side);
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
    this._cuedExpression = null;
    this._cues = turn.cues.map((cue, ordinal) => ({
      cue,
      t: cue.at * seconds,
      ordinal: cue.ordinal ?? ordinal,
    }));
    // Anything sitting at the top of the line goes in now rather than a frame
    // later, so a turn that opens on a cue opens on it. A turn with no text
    // gets every cue here: it is over on the next frame and has no clock to
    // spread them along.
    this.fireCues(0);
    this.events.emit('turn.start', { turn: turn.id, seconds });
  }

  /**
   * Play every cue that is due, in order.
   *
   * `<=` and not `<`, so a cue written at the very start of a line fires at
   * time zero rather than one frame into it.
   */
  private fireCues(t: number): void {
    while (this._cues.length > 0 && this._cues[0].t <= t) {
      const scheduled = this._cues.shift() as { cue: Cue; t: number; ordinal: number };
      const action = cueAction(scheduled.cue);
      if (action === null) continue;
      switch (action.kind) {
        case 'perform':
          this.d.perform(action.id);
          this._performing = action.id;
          break;
        case 'expression':
          this.d.setExpression(action.id);
          this._cuedExpression = action.id;
          break;
        case 'gesture':
          this.d.gesture(action.id);
          break;
        case 'hop':
          this.d.hop(action.id);
          break;
        case 'camera':
          this.stage.setCamera({ frame: action.frame });
          break;
        case 'slide':
          this.stage.setSlide(action.page);
          break;
        case 'bgm':
          this.events.emit('cue.fire', {
            turn: this.turn?.id,
            cueId: `${this.turn?.id}:cue:${scheduled.ordinal}`,
            cue: action,
          });
          break;
      }
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
    const expression = this._cuedExpression;
    this._cuedExpression = null;
    if (expression && !turn.hold && this.d.pickedExpression === expression) {
      this.d.setExpression(null);
    }
  }
}
