import { z } from 'zod';

/** The transport verbs accepted by BGM commands and inline cue settings. */
export const bgmActionSchema = z.enum(['play', 'pause', 'stop']);
export type BgmAction = z.infer<typeof bgmActionSchema>;

/** BGM filenames are flat, direct-directory ids, just like the BGM endpoint. */
export const bgmTrackIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => {
    if (value.startsWith('.') || /[/\\[\]]/u.test(value)) return false;
    return !/\p{Cc}/u.test(value);
  }, 'invalid BGM filename')
  .regex(/\.(?:mp3|flac)$/iu, 'BGM tracks must be .mp3 or .flac');

export const bgmVolumeSchema = z.number().finite().min(0).max(1);
export const bgmLoopSchema = z.boolean();

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

const fadeInSecondsSchema = z
  .number()
  .finite()
  .min(BGM_FADE_LIMITS.inSeconds.min)
  .max(BGM_FADE_LIMITS.inSeconds.max);
const fadeOutSecondsSchema = z
  .number()
  .finite()
  .min(BGM_FADE_LIMITS.outSeconds.min)
  .max(BGM_FADE_LIMITS.outSeconds.max);

/** Fully resolved transition settings kept by the server and sent to viewers. */
export const bgmFadeSchema = z.object({
  inSeconds: fadeInSecondsSchema,
  outSeconds: fadeOutSecondsSchema,
});

export type BgmFade = z.infer<typeof bgmFadeSchema>;

/** Partial crossfade settings; absent fields retain their server-side values. */
export const bgmFadePatchSchema = z.object({
  inSeconds: fadeInSecondsSchema.optional(),
  outSeconds: fadeOutSecondsSchema.optional(),
});

export type BgmFadePatch = z.infer<typeof bgmFadePatchSchema>;

/** Defaults for the fixed libsonare Mixer insert chain used by BGM. */
export const BGM_DSP_DEFAULTS = {
  toneDb: 0,
  compression: 0,
  width: 1,
  reverb: { mix: 0, decay: 0.5, damping: 0.5 },
  pitch: { semitones: 0, mix: 0 },
  presence: { amount: 0, drive: 2, frequencyHz: 3200 },
} as const;

const toneDbSchema = z.number().finite().min(-6).max(6);
const compressionSchema = z.number().finite().min(0).max(1);
const widthSchema = z.number().finite().min(0).max(2);
const reverbMixSchema = z.number().finite().min(0).max(0.5);
const reverbDecaySchema = z.number().finite().min(0).max(0.9);
const reverbDampingSchema = z.number().finite().min(0).max(1);
const pitchSemitonesSchema = z.number().finite().min(-24).max(24);
const pitchMixSchema = z.number().finite().min(0).max(1);
const presenceAmountSchema = z.number().finite().min(0).max(1);
const presenceDriveSchema = z.number().finite().min(0).max(8);
const presenceFrequencyHzSchema = z.number().finite().min(500).max(8000);

const bgmPitchSchema = z.object({
  semitones: pitchSemitonesSchema,
  mix: pitchMixSchema,
});

const bgmPresenceSchema = z.object({
  amount: presenceAmountSchema,
  drive: presenceDriveSchema,
  frequencyHz: presenceFrequencyHzSchema,
});

/** The fully resolved BGM DSP state, matching the Mixer controls. */
export const bgmDspSchema = z.object({
  toneDb: toneDbSchema,
  compression: compressionSchema,
  width: widthSchema,
  reverb: z.object({
    mix: reverbMixSchema,
    decay: reverbDecaySchema,
    damping: reverbDampingSchema,
  }),
  /** Optional on the wire for older reports; always resolved in parsed state. */
  pitch: bgmPitchSchema.default(() => ({ ...BGM_DSP_DEFAULTS.pitch })),
  /** Optional on the wire for older reports; always resolved in parsed state. */
  presence: bgmPresenceSchema.default(() => ({ ...BGM_DSP_DEFAULTS.presence })),
});

export type BgmDsp = z.infer<typeof bgmDspSchema>;

/** A partial patch for one or more independent BGM DSP controls. */
export const bgmDspPatchSchema = z.object({
  toneDb: toneDbSchema.optional(),
  compression: compressionSchema.optional(),
  width: widthSchema.optional(),
  reverb: z
    .object({
      mix: reverbMixSchema.optional(),
      decay: reverbDecaySchema.optional(),
      damping: reverbDampingSchema.optional(),
    })
    .optional(),
  pitch: z
    .object({
      semitones: pitchSemitonesSchema.optional(),
      mix: pitchMixSchema.optional(),
    })
    .optional(),
  presence: z
    .object({
      amount: presenceAmountSchema.optional(),
      drive: presenceDriveSchema.optional(),
      frequencyHz: presenceFrequencyHzSchema.optional(),
    })
    .optional(),
});

export type BgmDspPatch = z.infer<typeof bgmDspPatchSchema>;

/** Require at least one supplied value while allowing a value of zero/false. */
export const hasBgmSetting = (value: Record<string, unknown>): boolean =>
  Object.values(value).some((entry) => entry !== undefined);

/** Strict crossfade settings accepted inside an inline `@bgm set` cue. */
export const bgmCueFadeSchema = bgmFadePatchSchema
  .strict()
  .refine(hasBgmSetting, { error: 'BGM fade settings may not be empty' });

const bgmCueReverbSchema = bgmDspPatchSchema.shape.reverb
  .unwrap()
  .strict()
  .refine(hasBgmSetting, { error: 'BGM reverb settings may not be empty' });

const bgmCuePitchSchema = bgmDspPatchSchema.shape.pitch
  .unwrap()
  .strict()
  .refine(hasBgmSetting, { error: 'BGM pitch settings may not be empty' });

const bgmCuePresenceSchema = bgmDspPatchSchema.shape.presence
  .unwrap()
  .strict()
  .refine(hasBgmSetting, { error: 'BGM presence settings may not be empty' });

/** Strict DSP settings accepted inside an inline `@bgm set` cue. */
export const bgmCueDspSchema = bgmDspPatchSchema
  .extend({
    reverb: bgmCueReverbSchema.optional(),
    pitch: bgmCuePitchSchema.optional(),
    presence: bgmCuePresenceSchema.optional(),
  })
  .strict()
  .refine(hasBgmSetting, { error: 'BGM DSP settings may not be empty' });

/** Fields shared by a caller command and a timed settings cue. */
export const bgmControlFieldsSchema = z.object({
  action: bgmActionSchema.optional(),
  track: bgmTrackIdSchema.nullable().optional(),
  volume: bgmVolumeSchema.optional(),
  loop: bgmLoopSchema.optional(),
  /** A partial libsonare Mixer DSP patch; omitted leaves the active chain unchanged. */
  dsp: bgmDspPatchSchema.optional(),
  /** Partial crossfade durations; omitted leaves the active transition policy unchanged. */
  fade: bgmFadePatchSchema.optional(),
});

/**
 * A complete inline settings patch. Unlike commands, cue settings are strict
 * at every level so a typo cannot silently turn a timed control into a no-op.
 * The nonempty check preserves the distinction between selecting/unloading a
 * track and an ineffective empty patch.
 */
export const bgmCueSettingsSchema = bgmControlFieldsSchema
  .extend({
    fade: bgmCueFadeSchema.optional(),
    dsp: bgmCueDspSchema.optional(),
  })
  .strict()
  .refine(hasBgmSetting, { error: 'BGM settings may not be empty' });

export type BgmCueSettings = z.infer<typeof bgmCueSettingsSchema>;
