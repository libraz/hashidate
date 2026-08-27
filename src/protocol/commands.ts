import { z } from 'zod';
import { hasCueMarkup, isWellFormed } from '../engine/cues';
import type { CameraFrame, EmotionName, FingerName, Side, TurnRequest } from '../engine/types';

/**
 * The command vocabulary, as it travels on the wire.
 *
 * One definition for the three processes that speak it: the viewer applies a
 * command onto `Session`, the server stamps and fans it out, the CLI builds it.
 * The set here is exactly the set the viewer's control channel switches on —
 * one command is one session call, and a command that cannot be expressed as
 * one call means the session is missing something rather than that this file
 * needs a special case.
 *
 * Everything is JSON: no dates, no classes, no undefined-as-a-value. Angles are
 * in degrees here and only here; see `pointCommandSchema`.
 */

// --- type-level guards ------------------------------------------------------

/**
 * True only when `A` and `B` are the same type, rather than merely mutually
 * assignable. Assignability tolerates an extra optional field on either side,
 * which is precisely the drift these guards exist to catch.
 */
export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Turns a failed `Equals` into a compile error at the point of use. */
export type Expect<T extends true> = T;

/**
 * `Assert<A, B>` compiles only if `A` is assignable to `B`. Used in pairs where
 * `Equals` is too literal — an intersection and the flat object with the same
 * members are interchangeable but not identical.
 */
export type Assert<A extends B, B = A> = A;

// --- shared primitives ------------------------------------------------------

/** Canonical emotion names, pinned to the engine's own list. */
export const emotionNameSchema = z.enum([
  'neutral',
  'joy',
  'anger',
  'sadness',
  'surprise',
  'relaxed',
  'thinking',
  'shy',
]);
type _EmotionNamesMatchEngine = Expect<Equals<z.infer<typeof emotionNameSchema>, EmotionName>>;

/**
 * A blend, not a choice. Weights need not sum to one and are not bounded here:
 * the layers that consume the vector normalise where normalising is meaningful.
 *
 * A name outside the canonical list fails the command it arrived on rather than
 * being quietly dropped from the blend: the vocabulary advertises exactly which
 * names exist, so an unknown one means the caller is working from a list that no
 * longer matches the avatar, and half-applying that blend hides it.
 */
export const emotionVectorSchema = z.partialRecord(emotionNameSchema, z.number());

/** Which arm, in the character's own terms. Never a world direction. */
export const sideSchema = z.enum(['L', 'R']);
type _SidesMatchEngine = Expect<Equals<z.infer<typeof sideSchema>, Side>>;

export const fingerNameSchema = z.enum(['thumb', 'index', 'middle', 'ring', 'little']);
type _FingersMatchEngine = Expect<Equals<z.infer<typeof fingerNameSchema>, FingerName>>;

export const cameraFrameSchema = z.enum(['face', 'bust', 'upper', 'full']);
type _CameraFramesMatchEngine = Expect<Equals<z.infer<typeof cameraFrameSchema>, CameraFrame>>;

/**
 * Correlation id, carried by every command.
 *
 * The server stamps one on arrival if the caller did not supply it, so the turn
 * events that come back can be matched to the command that caused them. Three
 * commands — `expression`, `overlay`, `gesture` — spend the same field on their
 * own payload id instead; those are noted where they are defined, because a
 * server that stamps an id onto one of them changes what the command means.
 */
const correlationId = z.string().optional();

// --- turns ------------------------------------------------------------------

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
  hold: z.boolean().optional(),
});

/**
 * The payload is a `TurnRequest` and nothing else — the command is that
 * interface with a `cmd` tag on it, so the guard trips if the engine's notion
 * of a turn moves without this schema following.
 */
type _SayPayloadIsTurnRequest = Expect<
  Equals<Omit<z.infer<typeof sayCommandSchema>, 'cmd'>, TurnRequest>
>;

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

// --- face -------------------------------------------------------------------

/**
 * Set the persistent emotion vector.
 *
 * The weights arrive under `vec` or under `emotion`; both spellings are live on
 * the wire and `vec` wins when both are given. Neither means `{ neutral: 1 }`,
 * so an argument-less `emotion` command is a reset rather than an error. The
 * default is not applied here: it would have to pick a spelling to land in, and
 * a parsed command is also a command the server forwards on unchanged.
 */
export const emotionCommandSchema = z.object({
  cmd: z.literal('emotion'),
  id: correlationId,
  vec: emotionVectorSchema.optional(),
  emotion: emotionVectorSchema.optional(),
});

/**
 * Show one of the avatar's drawn expressions.
 *
 * `id` here is the expression's own id, not the correlation id, and `null`
 * hands the face back to the emotion vector. Absent is the same as null.
 */
export const expressionCommandSchema = z.object({
  cmd: z.literal('expression'),
  id: z.string().nullable().optional(),
});

/**
 * Raise or lower one drawn effect. Effects layer over whatever face is showing,
 * so several can be up at once and each is cleared by name.
 *
 * `weight` and not a flag, because an effect can be brought partly up; `on:
 * false` is the same thing said the short way, and means weight 0. Absent
 * weight with no `on` means fully up. `id` is the effect's id, not the
 * correlation id.
 */
export const overlayCommandSchema = z.object({
  cmd: z.literal('overlay'),
  id: z.string(),
  weight: z.number().min(0).max(1).optional(),
  on: z.boolean().optional(),
});

/** Back to nothing: drop the drawn expression and every overlay, emotion to neutral. */
export const resetCommandSchema = z.object({
  cmd: z.literal('reset'),
  id: correlationId,
});

// --- body -------------------------------------------------------------------

/**
 * Play a named performance — a face and a movement together — or release the
 * one that is up.
 *
 * The command to reach for first. `gesture`, `emotion` and `hop` below are its
 * parts, and are for what the performance table has no name for.
 *
 * No `id` means *release*, on the same rule as `gesture`. `id` is the
 * performance's id, not the correlation id.
 */
export const performCommandSchema = z.object({
  cmd: z.literal('perform'),
  id: z.string().nullable().optional(),
});

/**
 * Play a gesture, or stop the one that is running.
 *
 * No `id` means *stop*, not an error: the release is not a second verb the
 * caller has to remember. `id` is the gesture's id, not the correlation id.
 */
export const gestureCommandSchema = z.object({
  cmd: z.literal('gesture'),
  id: z.string().optional(),
});

/**
 * A run of hops, by name from the hop table.
 *
 * Its own command rather than a gesture because it translates the whole
 * skeleton instead of posing it, and runs alongside whatever the arms are
 * doing — a character can hop while waving. Absent `id` is the default single
 * hop.
 */
export const hopCommandSchema = z.object({
  cmd: z.literal('hop'),
  id: correlationId,
  hop: z.string().optional(),
});

/**
 * Point a fingertip at a bearing, held until released.
 *
 * Distinct from `gesture` because the target is continuous: an orchestrator
 * indicating something on screen has a direction, not the name of one of a
 * fixed list of canned poses. Neither `azimuth` nor `elevation` means *release*,
 * for the same reason `gesture` with no id means stop.
 *
 * **The angles on the wire are DEGREES.** `PointSpec` in the engine is radians;
 * that is the engine-internal form and the conversion belongs at the boundary
 * that applies this command.
 *
 * The angles are deliberately *not* bounded to the range the vocabulary
 * advertises. Those bounds are anatomical, and reaching past them is a
 * supported outcome rather than an error: the arm goes as far as it can, which
 * is what a person does, and `state.strain` reports what the pose cost. That
 * readout is the whole reason the solver returns a cost — rejecting the command
 * instead would take away the only way a caller can tell an aim that was met
 * from one the arm could only approximate.
 */
export const pointCommandSchema = z.object({
  cmd: z.literal('point'),
  id: correlationId,
  side: sideSchema.optional(),
  /** Degrees. 0 straight ahead, positive toward the character's right. */
  azimuth: z.number().finite().optional(),
  /** Degrees. 0 at shoulder height, positive up. */
  elevation: z.number().finite().optional(),
  /** Fraction of the arm's full reach, fingertip included. The solver clamps to 0.1..1. */
  extent: z.number().finite().optional(),
  finger: fingerNameSchema.optional(),
});

/**
 * How much the gaze tracks the camera: a blend factor, not an angle. 0 is
 * straight ahead, 1 is full camera-eye. Absent means 1.
 */
export const lookCommandSchema = z.object({
  cmd: z.literal('look'),
  id: correlationId,
  amount: z.number().min(0).max(1).optional(),
});

/** Turn the idle autopilot on or off. Absent `on` means on. */
export const idleCommandSchema = z.object({
  cmd: z.literal('idle'),
  id: correlationId,
  on: z.boolean().optional(),
});

// --- staging ----------------------------------------------------------------

/** Frame the shot. The viewer owns the camera; this only names a framing. */
export const cameraCommandSchema = z.object({
  cmd: z.literal('camera'),
  id: correlationId,
  frame: cameraFrameSchema,
});

/**
 * Dress the avatar: one `slot` to an `item`, or a whole `preset` at once.
 *
 * `item: null` takes the slot's garment off. Slot and item names are avatar
 * data — they come back in the vocabulary — so they stay plain strings here.
 * Neither field given is a no-op rather than an error, which is also what a
 * `wear` sent to an avatar with no wardrobe at all does.
 */
export const wearCommandSchema = z.object({
  cmd: z.literal('wear'),
  id: correlationId,
  slot: z.string().optional(),
  item: z.string().nullable().optional(),
  preset: z.string().optional(),
});

// --- the set ----------------------------------------------------------------

/**
 * Every command the viewer accepts, and no others. Discriminated on `cmd` so
 * that the switch which applies them narrows exhaustively.
 */
export const commandSchema = z.discriminatedUnion('cmd', [
  sayCommandSchema,
  interruptCommandSchema,
  clearCommandSchema,
  emotionCommandSchema,
  expressionCommandSchema,
  overlayCommandSchema,
  resetCommandSchema,
  performCommandSchema,
  gestureCommandSchema,
  hopCommandSchema,
  pointCommandSchema,
  lookCommandSchema,
  idleCommandSchema,
  cameraCommandSchema,
  wearCommandSchema,
]);

export type Command = z.infer<typeof commandSchema>;

/** The `cmd` tag on its own, for a caller that only needs the verb. */
export type CommandName = Command['cmd'];

/**
 * Parse one command, returning null rather than throwing.
 *
 * The orchestrator and the renderer are separate processes with separate
 * release cycles, and a newer caller talking to an older renderer should
 * degrade rather than crash the stream: the command it does not understand is
 * dropped and everything else keeps flowing. Unknown *fields* are stripped for
 * the same reason, so a command that gained an argument upstream still applies
 * here, minus the argument.
 */
export function parseCommand(value: unknown): Command | null {
  const parsed = commandSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
