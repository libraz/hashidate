import type { InlineCueAction } from '../../protocol/cues';
import type { EmotionVector, Side } from './primitives';
import type { Staging } from './staging';

/**
 * One turn: a line of dialogue delivered with a face and a gesture, from the
 * request a caller sends to the queued object the engine plays.
 */

/**
 * One turn: a line of dialogue delivered with a face and a gesture.
 *
 * Everything optional applies for the duration of the turn — except the
 * emotion, which persists, because a mood does not end with the sentence, and
 * the staging, which persists because a shot is not a property of a sentence.
 */
export interface TurnRequest {
  id?: string;
  /**
   * The line, with its cues in it.
   *
   * `[hello]こんばんは。[explain]今日はこの話をします。` — a bracketed id starts
   * that performance at the point it is written, which is the only way to place
   * one inside a sentence: a second turn would put a gap in the middle of a
   * clause, and a separate `perform` command cannot know when the first half
   * has been said.
   *
   * Brackets are reserved and are never spoken. See `cues.ts` — the guarantee
   * is structural, and it is the reason this field is parsed on the way into
   * the queue rather than on the way out of it.
   */
  text?: string;
  /**
   * How `text` is pronounced, in kana. Optional, and only worth supplying where
   * the writing is ambiguous.
   *
   * Japanese writing does not carry its own reading, and nothing downstream can
   * recover one: the mouth counts a kanji as two morae because most are, which
   * is a guess, and the speech model has no dictionary to consult — it reads
   * whatever its text encoder learned, with no way to correct it. So both the
   * viseme track and the voice are driven from this when it is given, and from
   * `text` when it is not.
   *
   * It is the same field for both on purpose. A reading supplied to fix "3件"
   * fixes the mouth as a side effect, and a caller that had to think about the
   * pronunciation once should not have to think about it again.
   *
   * It carries no cues. Those are positions in the line and belong with the
   * line; a reading is kana and a bracket in one is a mistake, which the wire
   * format refuses rather than strips.
   */
  reading?: string;
  emotion?: EmotionVector | null;
  expression?: string | null;
  gesture?: string | null;
  /**
   * A named face-and-movement from the performance table, applied before the
   * three fields above so they can override parts of it. Released with the turn
   * unless `hold`; its mood persists either way.
   */
  perform?: string | null;
  /**
   * Which hand the turn's movement uses, pinning what the gesture layer would
   * otherwise draw at random. Applies to whichever gesture the turn plays —
   * `gesture`'s, or the one `perform` names — because a line has one movement
   * in it and stating the hand twice could only ever disagree with itself.
   *
   * Absent is the ordinary case and stays random: the table is authored so that
   * either hand reads, and a character that always waves with the same arm
   * reads as a mechanism. A line pins it when the shot gives it a reason — the
   * hand away from the slide, or the one the line before used.
   */
  side?: Side;
  /** Keep the drawn face up after the line ends. Off by default: held past its
   *  line a drawn face stops reading as a reaction and starts reading as a mask. */
  hold?: boolean;
  /**
   * The shot this line is delivered in, applied as the turn begins.
   *
   * Everything else here describes the character. This describes where they are
   * being seen and heard, and it is on a turn for one reason: timing. The
   * standalone calls take effect when they are made, which is what a caller
   * reacting to something wants and the opposite of what a caller writing a
   * script wants — a script knows its fourth line needs a wide shot long before
   * the first line has been said, and had no way to say so without waiting.
   *
   * Waiting is what this exists to avoid. A caller that sends one line and waits
   * for it pays the whole of the next line's synthesis as silence; sending the
   * run at once hides it behind playback. See `Staging` for the field itself.
   */
  stage?: Staging;
}

/**
 * One timed action lifted out of a line, and where in it that happens.
 *
 * The grammar and the guarantee that goes with it are in `cues.ts`; this is
 * only the shape the rest of the engine sees.
 */
export interface Cue {
  /** The legacy `[performanceId]` shorthand, when this cue used it. */
  perform?: string;
  /** A typed cue action. Legacy shorthand is represented by `perform`. */
  action?: InlineCueAction;
  /** Source order, kept non-enumerable by `parseLine` for stable event ids. */
  ordinal?: number;
  /**
   * Where it lands, as a fraction of the line: 0 at the first mora, 1 at the
   * last.
   *
   * A fraction and not a time, because the line is not necessarily as long as
   * the estimate it was measured against. A supplied `reading` is a different
   * string of a different length, and TTS audio is a different length again;
   * the fraction survives both, and a time in seconds would be wrong the moment
   * the utterance was not exactly as long as guessed.
   */
  at: number;
}

/**
 * One synthesised line, ready to play.
 *
 * Stated here and implemented in the viewer, which is the only layer that has
 * an `AudioContext` to implement it with. The engine holds the shape so that
 * the turn queue can wait for one, stretch a track onto its length and read its
 * envelope, without importing a browser.
 */
export interface Take {
  /**
   * How long the audio actually is. Measured off the decoded buffer rather than
   * taken from whatever the synthesiser claimed — the buffer is the thing that
   * will be played, and it is the only number both sides can agree on.
   */
  seconds: number;
  /**
   * Seconds since `play`, on the audio device's own clock rather than the
   * frame's.
   *
   * Keeps counting past `seconds` once the audio has finished, and has to: the
   * mouth decides it has stopped speaking by the clock running past the end of
   * its track, so a clock that stopped at the last mora would leave the turn
   * open for good.
   */
  readonly elapsed: number;
  /** How loud it is right now, 0..1, normalised against this take's own peak. */
  readonly amplitude: number;
  play(): void;
  stop(): void;
}

/**
 * A queued turn: a request with its id minted and its line already parsed.
 *
 * `text` here is what is *said* — the markup came out in `Session.say`, and
 * nothing downstream of the queue has to know that there was any.
 */
export interface Turn extends TurnRequest {
  id: string;
  text: string;
  cues: Cue[];
  /**
   * The audio for this line. Three states and each means something different:
   *
   * - **absent** — the voice has not answered yet, and the turn waits.
   * - **null** — there will be no audio, and the turn plays on the estimate.
   * - **a take** — ready, and the turn will run on its clock.
   *
   * Synthesis starts when the turn is *queued*, not when it is played, so a
   * caller that sends three lines in one batch has all three being made while
   * the first is still being said. The wait is therefore paid once, at the top
   * of a run, rather than between every line.
   */
  take?: Take | null;
}
