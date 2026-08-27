import { z } from 'zod';
import { hasCueMarkup, isWellFormed } from '../engine/cues';
import { TUNING_RANGES, type TuningPatch, type TuningRange } from '../engine/tuning';
import type {
  CameraFrame,
  EmotionName,
  FingerName,
  Side,
  Staging,
  TurnRequest,
} from '../engine/types';

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

/** Re-exported for the same reason as `TurnRequest` below: the guard above makes
 *  it the same type, so a caller building a command need not reach into the
 *  engine to name one. */
export type { CameraFrame };

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
/**
 * A shot, as a line can carry one. See `sayCommandSchema.stage`.
 *
 * Deliberately the three persistent staging axes and nothing else. What belongs
 * on a turn is what the renderer can hold across it and hand back — a camera
 * framing, a backdrop and an acoustic. A gesture or an expression is already on
 * the turn and is released with it, which is the opposite lifetime, and putting
 * both kinds under one key would make the field mean two things.
 */
export const stageSchema = z.object({
  camera: cameraFrameSchema.optional(),
  backdrop: z.string().nullable().optional(),
  room: z.string().nullable().optional(),
});

type _StageIsStaging = Expect<Equals<z.infer<typeof stageSchema>, Staging>>;

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
export type { TurnRequest };

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
 * Put the voice in a named acoustic space, or take it out of one.
 *
 * `id` here is the room's own id, not the correlation id, and `null` is dry.
 * The names come back in the vocabulary, like wardrobe slots and performances,
 * because what rooms exist is renderer data rather than something the wire
 * should be pinning down — an unknown one is dry rather than a rejected command.
 *
 * Persistent, like the camera and unlike everything under `say`. A room is
 * where the stream is happening; it does not end with a line.
 */
export const roomCommandSchema = z.object({
  cmd: z.literal('room'),
  id: z.string().nullable().optional(),
});

/**
 * Which room the character is *seen* in, as `room` is which one they are heard
 * in. No id renders the character against the flat background.
 *
 * The id is a bare string for the same reason `room`'s is: what backdrops exist
 * is renderer data, and an unknown one draws nothing rather than being rejected.
 *
 * ## It is not the same axis as `room`, and joining them would be wrong
 *
 * The temptation is obvious — a character in a small bedroom should sound like
 * one — and it does not survive contact with what a stream is. The set is
 * chosen for how it reads behind a face at a fixed framing; the acoustic is
 * chosen for how a voice sits in a mix. A backdrop can be swapped mid-stream
 * for a visual beat with no implication that the microphone moved, and the
 * reverb has to stay put across that or every cut is audible. Two commands, and
 * an orchestrator that wants them to agree says so twice.
 *
 * Persistent and survives an avatar swap, like the camera and the room.
 */
export const backdropCommandSchema = z.object({
  cmd: z.literal('backdrop'),
  id: z.string().nullable().optional(),
});

/**
 * How the voice is processed on its way out: pitch, formant, EQ, gate,
 * compressor, de-esser, reverb and limiter.
 *
 * ## The section names are the renderer's, deliberately
 *
 * Everywhere else at this boundary the wire uses its own vocabulary and the
 * renderer translates — `point` is in degrees because the engine's radians are
 * an internal form. This does the opposite and mirrors the processor's own
 * layout one for one, because here there is nothing to translate *to*: a
 * de-esser threshold is a de-esser threshold, and inventing a second set of
 * names for the same twenty-odd numbers would only produce a mapping table for
 * the two ends to drift across.
 *
 * ## Every field is optional and lands on top of a base preset
 *
 * `preset` names the starting point and the fields below override parts of it,
 * on the same rule `say` follows for a performance and its three overrides. The
 * renderer holds the base and merges, which is not merely convenient: the
 * processor refuses a partial configuration outright, so a complete one has to
 * be assembled *somewhere*, and the end that already has the preset table is
 * the end that can do it without shipping the table over the wire.
 *
 * `preset: null` is no processing at all — the take is played as the
 * synthesiser made it. Absent leaves the base where it was.
 *
 * ## Reverb is here and is not the room
 *
 * `reverb` is the tail this chain adds to the voice itself. The *room* — see
 * `roomCommandSchema` — is a convolution downstream of the whole chain, derived
 * from a physical space rather than dialled in as a decay time, and it is the
 * one to reach for. Both at once is two rooms and sounds like it.
 */
export const voiceDspSchema = z.object({
  /** Level into the chain, before anything else. */
  inputGainDb: z.number().finite().optional(),
  /** Level out of it, after everything but the limiter. */
  outputGainDb: z.number().finite().optional(),
  /** How much of the processed signal is heard against the untouched one. */
  wetMix: z.number().min(0).max(1).optional(),
  /** Pitch, moved without moving the formants — which is what keeps it a voice. */
  retune: z
    .object({
      semitones: z.number().finite().optional(),
      mix: z.number().min(0).max(1).optional(),
      grainSize: z.number().finite().optional(),
    })
    .optional(),
  /** The resonances that decide who it sounds like, moved without moving the pitch. */
  formant: z
    .object({
      factor: z.number().finite().optional(),
      amount: z.number().min(0).max(1).optional(),
      body: z.number().finite().optional(),
      brightness: z.number().finite().optional(),
      nasal: z.number().finite().optional(),
    })
    .optional(),
  eq: z
    .object({
      highpassHz: z.number().finite().optional(),
      bodyDb: z.number().finite().optional(),
      presenceDb: z.number().finite().optional(),
      airDb: z.number().finite().optional(),
    })
    .optional(),
  gate: z
    .object({
      thresholdDb: z.number().finite().optional(),
      attackMs: z.number().finite().optional(),
      releaseMs: z.number().finite().optional(),
      rangeDb: z.number().finite().optional(),
    })
    .optional(),
  compressor: z
    .object({
      thresholdDb: z.number().finite().optional(),
      ratio: z.number().finite().optional(),
      attackMs: z.number().finite().optional(),
      releaseMs: z.number().finite().optional(),
      makeupGainDb: z.number().finite().optional(),
    })
    .optional(),
  deesser: z
    .object({
      frequencyHz: z.number().finite().optional(),
      thresholdDb: z.number().finite().optional(),
      ratio: z.number().finite().optional(),
      rangeDb: z.number().finite().optional(),
    })
    .optional(),
  reverb: z
    .object({
      mix: z.number().min(0).max(1).optional(),
      timeMs: z.number().finite().optional(),
      damping: z.number().min(0).max(1).optional(),
      seed: z.number().finite().optional(),
    })
    .optional(),
  limiter: z
    .object({
      ceilingDb: z.number().finite().optional(),
      releaseMs: z.number().finite().optional(),
      enableIspLimiter: z.boolean().optional(),
      ispCeilingDbtp: z.number().finite().optional(),
    })
    .optional(),
});

export type VoiceDsp = z.infer<typeof voiceDspSchema>;

/**
 * Set the voice chain, or take it out of the way.
 *
 * Persistent, like the camera and the room and unlike everything under `say`:
 * how the voice is processed is a property of the stream, not of a line. It
 * applies from the next line synthesised — a take already made was made with
 * the chain that was up at the time, and re-making the queue on every knob turn
 * would send the whole thing back to the sidecar.
 *
 * `id` here is the correlation id; the base preset travels under `preset`,
 * because unlike `expression` and `perform` this command has fields of its own
 * and there is no ambiguity to resolve by spending `id` on the payload.
 */
export const voiceCommandSchema = z.object({
  cmd: z.literal('voice'),
  id: correlationId,
  /** Base preset id. `null` bypasses the chain; absent keeps the current base. */
  preset: z.string().nullable().optional(),
  dsp: voiceDspSchema.optional(),
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

// --- the renderer -----------------------------------------------------------
//
// Neither a performance nor a shot: which character is on screen, and how the
// layers underneath it are set. Both are things an operator decides before a
// stream rather than during one, and both were reachable only from a console
// running on the same page as the renderer until they were named here.

/**
 * Load a different avatar.
 *
 * `id` is the avatar's own id, not the correlation id, on the same rule as
 * `expression` and `perform`. An id the renderer does not have is ignored: what
 * avatars exist is renderer data, reported alongside the vocabulary, and a
 * caller working from a stale list should not be able to blank the stream.
 *
 * This is the one command that replaces the thing every other command talks to.
 * The swap builds a new scene and a new session, which takes as long as reading
 * a model off disk, so commands that arrive behind it are held until the new
 * avatar is standing and then applied to it — see `ControlClient.apply`. Sending
 * `avatar` and then dressing it in the same breath does what it reads like.
 */
export const avatarCommandSchema = z.object({
  cmd: z.literal('avatar'),
  id: z.string(),
});

/** A number stated as far as its control may travel. See `TUNING_RANGES`. */
const within = (range: TuningRange) => z.number().min(range.min).max(range.max);

/**
 * Move part of the set-once layer: breath, sway, jump, tail, shading.
 *
 * ## The field names are the engine's, deliberately
 *
 * The same trade `voiceDspSchema` makes, for the same reason: there is nothing
 * to translate *to*. A spring stiffness scale is a spring stiffness scale, and
 * a second set of names for these fourteen numbers would only produce a mapping
 * table for the two ends to drift across. The one place the wire does insist on
 * its own unit is `hop.height`, which is metres here because metres is what the
 * body layer holds — both panels state it in centimetres, and that is theirs.
 *
 * ## Bounded, unlike `point`
 *
 * The ranges come from `TUNING_RANGES` and a value outside one fails the
 * command. `point` deliberately accepts a bearing the arm cannot reach, because
 * reaching as far as it can is a real answer and the strain readout is how a
 * caller learns what the pose cost. Nothing here has that shape: a breath
 * period of zero is not an ambitious breath, and there is no readout that would
 * tell the caller so.
 *
 * ## Everything is optional and merges onto what is running
 *
 * A surface with one fader under the mouse sends one number. Absent means "leave
 * it", never "reset it" — which is what makes a knob turn cost one small message
 * rather than a full statement of the layer.
 */
export const tuneCommandSchema = z.object({
  cmd: z.literal('tune'),
  id: correlationId,
  idle: z
    .object({
      breathDepth: within(TUNING_RANGES.idle.breathDepth).optional(),
      breathPeriod: within(TUNING_RANGES.idle.breathPeriod).optional(),
      idleAmount: within(TUNING_RANGES.idle.idleAmount).optional(),
      weightShift: within(TUNING_RANGES.idle.weightShift).optional(),
      gazeAmount: within(TUNING_RANGES.idle.gazeAmount).optional(),
      /** A multiplier over the avatar's measured limits, not an angle. */
      eyeLimit: within(TUNING_RANGES.idle.eyeLimit).optional(),
      blink: z.boolean().optional(),
    })
    .optional(),
  sway: z
    .object({
      enabled: z.boolean().optional(),
      stiffness: within(TUNING_RANGES.sway.stiffness).optional(),
      inertia: within(TUNING_RANGES.sway.inertia).optional(),
      gravity: within(TUNING_RANGES.sway.gravity).optional(),
    })
    .optional(),
  hop: z
    .object({
      /** Metres. */
      height: within(TUNING_RANGES.hop.height).optional(),
      gravity: within(TUNING_RANGES.hop.gravity).optional(),
    })
    .optional(),
  tail: z.object({ amount: within(TUNING_RANGES.tail.amount).optional() }).optional(),
  render: z.object({ toon: z.boolean().optional(), arkit: z.boolean().optional() }).optional(),
  /** Snap the spring chains to rest, after the values above have landed. */
  settle: z.boolean().optional(),
});

/**
 * The payload is a `TuningPatch` and nothing else, on the same footing as `say`
 * and its `TurnRequest`: the guard trips if the engine's notion of what is
 * tunable moves without this schema following.
 */
type _TunePayloadIsPatch = Expect<
  Equals<Omit<z.infer<typeof tuneCommandSchema>, 'cmd' | 'id'>, TuningPatch>
>;

export type { TuningPatch };

// --- the set ----------------------------------------------------------------

/**
 * Every command the viewer accepts, and no others. Discriminated on `cmd` so
 * that the switch which applies them narrows exhaustively.
 */
export const commandSchema = z.discriminatedUnion('cmd', [
  sayCommandSchema,
  queueCommandSchema,
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
  roomCommandSchema,
  backdropCommandSchema,
  voiceCommandSchema,
  wearCommandSchema,
  avatarCommandSchema,
  tuneCommandSchema,
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
