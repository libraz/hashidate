import { z } from 'zod';
import { BGM_FADE_DEFAULTS, bgmDspSchema, bgmFadeSchema, bgmTransportSchema } from '../commands';

/**
 * Background music, from the server's side: what is on disk, what the timeline
 * says, and what each renderer reports back about it.
 *
 * The server's coordinator is the timeline authority; everything a renderer
 * sends here is a diagnostic rather than a fact — see `bgmReportSchema`.
 */

/** One playable file in the server's direct BGM directory. */
export const bgmTrackSchema = z.object({
  /** The NFC-normalised filename, including `.mp3` or `.flac`. */
  id: z.string(),
  /** The filename is the display label; BGM has no second localisation source. */
  label: z.string(),
  /** `audio/mpeg` for MP3 and `audio/flac` for FLAC. */
  mime: z.enum(['audio/mpeg', 'audio/flac']),
  bytes: z.number().finite().nonnegative(),
  /** Epoch seconds of the file's last modification. */
  at: z.number().finite().nonnegative(),
});

export type BgmTrack = z.infer<typeof bgmTrackSchema>;

/** The server's canonical BGM transport and timeline. */
export const bgmStateSchema = z.object({
  track: z.string().nullable(),
  volume: z.number().min(0).max(1),
  loop: z.boolean(),
  /** The server-owned libsonare DSP patch for the BGM stream. */
  dsp: bgmDspSchema,
  /** Resolved crossfade durations used for future track transitions. */
  fade: bgmFadeSchema.default(() => ({ ...BGM_FADE_DEFAULTS })),
  transport: bgmTransportSchema,
  position: z.number().finite().nonnegative(),
  revision: z.number().int().nonnegative(),
  /** Epoch seconds at which `position` was measured. */
  at: z.number().finite().nonnegative(),
  /** Duration reported by a renderer, if it has decoded the selected track. */
  duration: z.number().finite().nonnegative().nullable(),
  /** An audible renderer's inability to play the selected track. */
  blocked: z.boolean(),
  error: z.string().nullable(),
  /** True when the renderer had to fall back to a dry BGM worklet path. */
  dspDegraded: z.boolean().default(false),
});

export type BgmState = z.infer<typeof bgmStateSchema>;

/**
 * What a renderer reports about the BGM command it most recently received.
 *
 * `revision` is echoed so the server can reject a delayed report from an old
 * command. `muted` identifies preview renderers: they may contribute a decoded
 * duration, but their blocked/error status must never hide a problem on the
 * audible renderer. Position, timestamp and transport are diagnostics; the
 * server's coordinator remains the timeline authority. `dspDegraded` reports
 * a dry-worklet fallback and is sticky on the server for the current revision.
 */
export const bgmReportSchema = z.object({
  revision: z.number().int().nonnegative(),
  track: z.string().nullable().default(null),
  /** Optional resolved readout; the server does not accept it as authority. */
  dsp: bgmDspSchema.optional(),
  transport: bgmTransportSchema.default('stopped'),
  position: z.number().finite().min(0).default(0),
  duration: z.number().finite().nonnegative().nullable().default(null),
  muted: z.boolean().default(false),
  blocked: z.boolean().default(false),
  error: z.string().nullable().default(null),
  /** Sticky for the current revision on audible renderers; muted reports omit its effect. */
  dspDegraded: z.boolean().default(false),
  /** Epoch seconds at which the renderer sampled its position. */
  at: z.number().finite().nonnegative().optional(),
});

export type BgmReport = z.infer<typeof bgmReportSchema>;

/** The fresh response to `GET /api/bgm`. */
export const bgmResponseSchema = z.object({
  tracks: z.array(bgmTrackSchema),
});

export type BgmResponse = z.infer<typeof bgmResponseSchema>;
