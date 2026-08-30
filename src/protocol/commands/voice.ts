import { z } from 'zod';
import { correlationId } from './primitives';

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
