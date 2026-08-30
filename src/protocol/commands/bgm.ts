import { z } from 'zod';
import { bgmActionSchema, bgmTrackIdSchema } from '../cues';
import { correlationId } from './primitives';

/**
 * Background music: the transport the server owns, the transition policy, and
 * the fixed insert chain the renderer runs it through.
 *
 * The one command family whose timeline is server-generated — see
 * `bgmCommandSchema` for which fields a caller may set and which are stamped on
 * the way out.
 */

/** The defaults are intentionally quiet: BGM should sit under speech. */
export const BGM_DEFAULTS = { volume: 0.2, loop: true } as const;
export const BGM_DEFAULT_VOLUME = BGM_DEFAULTS.volume;
export const BGM_DEFAULT_LOOP = BGM_DEFAULTS.loop;

/**
 * Transition durations, deliberately short and bounded for live control.
 *
 * `outSeconds` is one number with one meaning — how the track that is sounding
 * leaves — and it is spent in both of the ways a track can leave: crossfaded
 * under an incoming one, or faded to silence by `stop`. Giving stop its own
 * duration would be a second answer to the same question, and an operator who
 * set one and not the other would get a segment whose two endings did not
 * match.
 *
 * `0` is therefore the hard edge, on either path. It is also the escape hatch
 * for a live stop that has to be instant. The stronger one is unloading the
 * track (`track: null`), which leaves no tail at all rather than a short one.
 *
 * `pause` is untouched by both and stays immediate: it is a hold, and a hold
 * that faded would have to decide what resuming from half a fade means.
 */
export const BGM_FADE_LIMITS = {
  inSeconds: { min: 0, max: 10 },
  outSeconds: { min: 0, max: 10 },
} as const;
export const BGM_FADE_DEFAULTS = { inSeconds: 1, outSeconds: 1 } as const;
export const BGM_FADE_DEFAULT_IN_SECONDS = BGM_FADE_DEFAULTS.inSeconds;
export const BGM_FADE_DEFAULT_OUT_SECONDS = BGM_FADE_DEFAULTS.outSeconds;

/** Fully resolved transition settings kept by the server and sent to viewers. */
export const bgmFadeSchema = z.object({
  inSeconds: z
    .number()
    .finite()
    .min(BGM_FADE_LIMITS.inSeconds.min)
    .max(BGM_FADE_LIMITS.inSeconds.max),
  outSeconds: z
    .number()
    .finite()
    .min(BGM_FADE_LIMITS.outSeconds.min)
    .max(BGM_FADE_LIMITS.outSeconds.max),
});

export type BgmFade = z.infer<typeof bgmFadeSchema>;

/** Partial crossfade settings; absent fields retain their server-side values. */
export const bgmFadePatchSchema = z.object({
  inSeconds: z
    .number()
    .finite()
    .min(BGM_FADE_LIMITS.inSeconds.min)
    .max(BGM_FADE_LIMITS.inSeconds.max)
    .optional(),
  outSeconds: z
    .number()
    .finite()
    .min(BGM_FADE_LIMITS.outSeconds.min)
    .max(BGM_FADE_LIMITS.outSeconds.max)
    .optional(),
});

export type BgmFadePatch = z.infer<typeof bgmFadePatchSchema>;

export type BgmAction = z.infer<typeof bgmActionSchema>;

/** The transport state that is synchronised to every renderer. */
export const bgmTransportSchema = z.enum(['playing', 'paused', 'stopped', 'ended']);
export type BgmTransport = z.infer<typeof bgmTransportSchema>;

/** Defaults for the fixed libsonare Mixer insert chain used by BGM. */
export const BGM_DSP_DEFAULTS = {
  toneDb: 0,
  compression: 0,
  width: 1,
  reverb: { mix: 0, decay: 0.5, damping: 0.5 },
} as const;

/** The fully resolved BGM DSP state, matching the Mixer controls. */
export const bgmDspSchema = z.object({
  toneDb: z.number().min(-6).max(6),
  compression: z.number().min(0).max(1),
  width: z.number().min(0).max(2),
  reverb: z.object({
    mix: z.number().min(0).max(0.5),
    decay: z.number().min(0).max(0.9),
    damping: z.number().min(0).max(1),
  }),
});

export type BgmDsp = z.infer<typeof bgmDspSchema>;

/** A partial patch for one or more independent BGM DSP controls. */
export const bgmDspPatchSchema = z.object({
  toneDb: z.number().min(-6).max(6).optional(),
  compression: z.number().min(0).max(1).optional(),
  width: z.number().min(0).max(2).optional(),
  reverb: z
    .object({
      mix: z.number().min(0).max(0.5).optional(),
      decay: z.number().min(0).max(0.9).optional(),
      damping: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

export type BgmDspPatch = z.infer<typeof bgmDspPatchSchema>;

/**
 * Change the server-owned BGM transport.
 *
 * The action, selection, level and DSP fields are caller input. `revision`,
 * `transport`, `position` and `at` may arrive from an older/newer peer, but are
 * server-generated and are overwritten by `BgmCoordinator` before the command
 * is sent to a viewer.
 * Keeping them in the schema lets the wire degrade across release cycles
 * without allowing a caller to forge the timeline.
 *
 * An absent action is a settings-only patch. An absent track leaves the
 * selection alone; `track: null` unloads it. The distinction is deliberate and
 * is resolved by the server rather than by each renderer.
 */
export const bgmCommandSchema = z.object({
  cmd: z.literal('bgm'),
  id: correlationId,
  action: bgmActionSchema.optional(),
  track: bgmTrackIdSchema.nullable().optional(),
  volume: z.number().finite().min(0).max(1).optional(),
  loop: z.boolean().optional(),
  /** A partial libsonare Mixer DSP patch; omitted leaves the active chain unchanged. */
  dsp: bgmDspPatchSchema.optional(),
  /** Partial crossfade durations; omitted leaves the active transition policy unchanged. */
  fade: bgmFadePatchSchema.optional(),
  revision: z.number().int().nonnegative().optional(),
  transport: bgmTransportSchema.optional(),
  position: z.number().finite().min(0).optional(),
  at: z.number().finite().nonnegative().optional(),
});

export type BgmCommand = z.infer<typeof bgmCommandSchema>;
