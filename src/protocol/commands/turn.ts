import { z } from 'zod';
import type { Staging, TurnRequest } from '../../engine/types';
import { cameraFrameSchema, hasCueMarkup, isWellFormed } from '../cues';
import type { Equals, Expect } from './guards';
import { placeStageSchema } from './layout';
import { correlationId, emotionVectorSchema, sideSchema } from './primitives';

/**
 * A line of dialogue, and the four things that can be done to a run of them.
 *
 * `say` is the command the whole runtime exists for; `queue`, `interrupt`,
 * `clear` and `pause` are the ways the list of pending ones is edited, stopped
 * or held.
 */

/**
 * A shot, as a line can carry one. See `sayCommandSchema.stage`.
 *
 * Deliberately the persistent staging axes and nothing else. What belongs on a
 * turn is what the renderer can hold across it and hand back — a camera
 * framing, a backdrop, an acoustic, a document, a layout. A gesture or an
 * expression is already on the turn and is released with it, which is the
 * opposite lifetime, and putting both kinds under one key would make the field
 * mean two things.
 *
 * That test is the whole membership rule, and it is why this set has grown
 * since it was three: a page and a placement pass it, and `voice`, `wear` and
 * `tune` pass it too but are set once for a stream rather than per line.
 */
export const stageSchema = z.object({
  camera: cameraFrameSchema.optional(),
  backdrop: z.string().nullable().optional(),
  room: z.string().nullable().optional(),
  /** Which document is up. Normally set once before a segment; see `deckCommandSchema`. */
  deck: z.string().nullable().optional(),
  /**
   * Which page of it, 1 based and **absolute**.
   *
   * There is deliberately no relative form on a line. A queued line can be
   * dropped, reordered or sent round again, and a "next page" written into one
   * means a different page every time the script is edited — the rest of the
   * deck slips by one and nothing in the queue says why. `slide`'s `by` is for
   * the operator turning a page live, who is reacting rather than describing.
   */
  slide: z.number().int().min(1).optional(),
  /**
   * Where the two layers sit in the frame, exactly as `place` states it.
   *
   * The fourth axis a line may carry, and it is here for the same reason `deck`
   * is: putting a document up and moving the character out of its way is one
   * decision, and split across a turn and a standalone command it arrives as
   * two — with a frame in between where they overlap.
   */
  place: placeStageSchema.optional(),
});

type _StageIsStaging = Expect<Equals<z.infer<typeof stageSchema>, Staging>>;

/**
 * Queue one turn: a line of dialogue delivered with a face and a gesture.
 *
 * Everything optional applies for the duration of the turn — except the
 * emotion, which persists, because a mood does not end with the sentence.
 * `hold` keeps the drawn expression up after the line, which is off by default:
 * held past its line a drawn face stops reading as a reaction and starts
 * reading as the character's actual face.
 */
export const sayCommandSchema = z.object({
  cmd: z.literal('say'),
  /** Doubles as the turn id: `turn.start` and `turn.end` come back under it. */
  id: correlationId,
  /**
   * The line, with its cues in it: `[hello]こんばんは。[explain]今日は…`.
   *
   * A bracketed performance id starts that performance where it is written,
   * which is the only place a caller can put one inside a sentence — a second
   * turn would break the clause in half, and a separate `perform` command
   * cannot know when the first half has been said.
   *
   * **Brackets are reserved and are never spoken.** A line whose markup does
   * not parse fails this schema, and a failed command is dropped: the character
   * stays quiet and the caller is told, rather than being read a stray bracket
   * out loud. That is the one accident this field exists to prevent, so it is
   * checked here as well as being stripped in the engine — the caller is a
   * language model and everything it writes goes to the mouth.
   *
   * The ids themselves are not checked, exactly as `perform` below is not: the
   * performance table is engine data and the wire carries ids as plain strings.
   * One the table does not have is dropped when the line is played.
   */
  text: z.string().refine(isWellFormed, { error: 'malformed cue markup' }).optional(),
  /**
   * The reading of `text`, in kana, for the places where the writing does not
   * determine it — counters, dates, acronyms, names, and every homograph.
   *
   * Not a display string: `text` is what the line *is*, this is only how it
   * sounds. Both the mouth and the voice read it, so a caller spells a
   * pronunciation out once and gets a correct viseme track along with it.
   *
   * It carries no cues, and a bracket anywhere in it fails the command rather
   * than being quietly removed. Cues are positions in the line and belong with
   * the line; one written here would be silently doing nothing, which is worse
   * than being refused.
   */
  reading: z
    .string()
    .min(1, { error: 'reading may not be empty' })
    .refine((value) => !hasCueMarkup(value), { error: 'cue markup does not belong in a reading' })
    .optional(),
  emotion: emotionVectorSchema.nullable().optional(),
  expression: z.string().nullable().optional(),
  gesture: z.string().nullable().optional(),
  /**
   * A named face-and-movement, applied before the three fields above so a turn
   * can name one and then override a single part of it. Released with the turn
   * unless `hold`; its mood persists either way.
   */
  perform: z.string().nullable().optional(),
  /**
   * Which hand this turn's movement uses, pinning what the gesture layer would
   * otherwise pick at random. See `gestureCommandSchema.side` for what it does
   * and why absent is the ordinary case.
   *
   * One field for the line rather than one per field, because a turn plays one
   * movement — `gesture`'s, or the one `perform` names — and a hand stated
   * twice could only ever disagree with itself.
   */
  side: sideSchema.optional(),
  hold: z.boolean().optional(),
  /**
   * The shot this line is delivered in, applied when the turn starts.
   *
   * The same three things `camera`, `backdrop` and `room` say on their own, and
   * they still say it — this does not replace them. What it adds is *when*: a
   * standalone staging command takes effect the moment it arrives, which is
   * correct for a caller reacting to something, and wrong for a caller
   * describing a line it has not reached yet.
   *
   * That distinction is what makes a script sound like one. A caller sending a
   * line at a time and waiting for each to finish pays about 1.2 s of silence
   * between every pair of them, because the renderer asks for a line's audio
   * when the line is queued and a queue one deep leaves nothing to prepare
   * during. Sending the whole run at once takes that to 0.3 s — but only if the
   * staging can travel with the run, and before this it could not: four lines
   * in one request meant four camera moves at the top of the first one.
   *
   * Absent and null are different, here as everywhere: no `room` key leaves the
   * room alone, `room: null` takes the character out of one.
   *
   * These stay put after the turn, like the commands they mirror. A shot is
   * where the stream is, not a property of a sentence, and a caller that wants
   * it back says so on the line it wants it back for.
   */
  stage: stageSchema.optional(),
});

/**
 * The payload is a `TurnRequest` and nothing else — the command is that
 * interface with a `cmd` tag on it, so the guard trips if the engine's notion
 * of a turn moves without this schema following.
 */
type _SayPayloadIsTurnRequest = Expect<
  Equals<Omit<z.infer<typeof sayCommandSchema>, 'cmd'>, TurnRequest>
>;

/**
 * One turn as it travels inside a queue: the `say` payload without the verb.
 *
 * Derived from `sayCommandSchema` rather than written out again, so a field
 * added to a spoken line cannot be one a queued line silently loses.
 */
export const turnSchema = sayCommandSchema.omit({ cmd: true });

type _TurnPayloadIsTurnRequest = Expect<Equals<z.infer<typeof turnSchema>, TurnRequest>>;

/**
 * Re-exported so that a caller building a turn can reach the type without
 * reaching into the engine. The guard above is what makes that honest: the two
 * names are the same type, checked at compile time, so the protocol is not
 * publishing a second opinion about what a turn is.
 */
export type { Staging, TurnRequest };

/**
 * Replace everything pending with this list, in order.
 *
 * The editable queue lives in the control server — that is what lets it survive
 * a viewer reload and be reordered from a panel — and this is how an edit to it
 * reaches the renderer. The whole list travels rather than a diff, because a
 * diff would have to be applied against whatever the renderer's queue happened
 * to hold at the moment it arrived, and the two ends disagree constantly by
 * nature: a turn starts playing here while an edit is in flight from there.
 *
 * Sending the whole list is not as wasteful as it looks. A turn already queued
 * under the same id, with the same words, keeps the audio that was made for it;
 * see `Session.replaceQueue`. So a reorder costs one message and no synthesis,
 * and only a line whose text actually changed is spoken again.
 *
 * The turn being said right now is not in this list and is not affected. It is
 * already out of the queue; stopping it is what `interrupt` is for.
 */
export const queueCommandSchema = z.object({
  cmd: z.literal('queue'),
  id: correlationId,
  turns: z.array(turnSchema),
});

/** Stop mid-sentence and drop everything pending. The stream's kill switch. */
export const interruptCommandSchema = z.object({
  cmd: z.literal('interrupt'),
  id: correlationId,
});

/** Drop what is pending but let the current line finish. */
export const clearCommandSchema = z.object({
  cmd: z.literal('clear'),
  id: correlationId,
});

/**
 * Hold the queue where it is, or let it move again. Absent `on` means hold.
 *
 * The third thing that can be done to a run of turns, and the only one that
 * keeps them: `interrupt` cuts the line and drops the rest, `clear` drops the
 * rest and keeps the line, and this drops nothing at all. What it stops is the
 * queue *advancing* — the turn on air finishes normally and no next one starts
 * until the hold comes off.
 *
 * **Held is not unsynthesised.** A line's audio is made when it enters the
 * queue rather than when it is played, so a script loaded into a held queue is
 * already being spoken to the sidecar while the operator is still framing the
 * shot. That is the whole reason this is a renderer-side hold rather than the
 * server simply not delivering the list: withholding the turns would mean the
 * first line of every recording began with the wait for its own audio.
 *
 * A `say` sent while held is held too. It goes onto the same queue as anything
 * else — see `Session.say` — and a hold that some lines could walk past would
 * not be one.
 */
export const pauseCommandSchema = z.object({
  cmd: z.literal('pause'),
  id: correlationId,
  on: z.boolean().optional(),
});
