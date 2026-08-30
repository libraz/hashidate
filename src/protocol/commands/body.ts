import { z } from 'zod';
import { correlationId, fingerNameSchema, sideSchema } from './primitives';

/**
 * What the body does: a whole performance, its parts, and the two continuous
 * aims — a fingertip and the gaze — that no table of canned poses can express.
 */

/**
 * Play a named performance — a face and a movement together — or release the
 * one that is up.
 *
 * The command to reach for first. `gesture`, `emotion` and `hop` are its parts,
 * and are for what the performance table has no name for.
 *
 * No `id` means *release*, on the same rule as `gesture`. `id` is the
 * performance's id, not the correlation id.
 */
export const performCommandSchema = z.object({
  cmd: z.literal('perform'),
  id: z.string().nullable().optional(),
  /** Which hand the movement it names uses. See `gestureCommandSchema.side`. */
  side: sideSchema.optional(),
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
  /**
   * Which hand acts, pinning what is otherwise drawn per playback.
   *
   * Absent is the ordinary case and stays random. The built-in table authors
   * one pose and mirrors it onto whichever hand is free — every entry was
   * checked on both — and a character that always waves with the same arm reads
   * as a mechanism rather than a person. So this is for the caller that has a
   * reason: the hand away from the document, or the one the line before used.
   *
   * On a two-handed gesture there is no hand to choose and it fixes which way
   * the head turns instead, which is the same axis seen from the other end. On
   * a motion loaded from disk it does nothing: a file states `L` or `R` itself.
   */
  side: sideSchema.optional(),
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
