import { z } from 'zod';
import { TUNING_RANGES, type TuningPatch } from '../../engine/tuning';
import type { Equals, Expect } from './guards';
import { correlationId, within } from './primitives';

/**
 * The renderer and the character it has loaded.
 *
 * Neither a performance nor a shot: which avatar is on screen, what it is
 * wearing, how the layers underneath it are set, and whether it prints its own
 * measurements over the frame. All of them are things an operator decides
 * before a stream rather than during one, and all were reachable only from a
 * console running on the same page as the renderer until they were named here.
 */

/**
 * Print the measurements over the frame, or stop. Absent `on` means on.
 *
 * The one verb here that reaches nothing in the session and changes nothing
 * about the performance. It says what a renderer *draws over itself* — the
 * breath, the gaze, the frame rate, which document is up — and every renderer
 * attached does it, including the one going to air, because the operator asking
 * for it is usually asking about that one.
 *
 * **It is deliberately not a standing setting.** Every other command that
 * outlives a turn is folded into the setup a renderer is handed on connect, and
 * this one must not be: a readout raised to answer a question during rehearsal
 * would then come back by itself on the source OBS reloads at the top of the
 * broadcast, which is the one way a debugging tool can end up on a stream. Off
 * is what a fresh renderer is, always. See `Persistent` in `server/standing.ts`,
 * which is an allowlist for exactly this reason.
 */
export const debugCommandSchema = z.object({
  cmd: z.literal('debug'),
  id: correlationId,
  on: z.boolean().optional(),
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
