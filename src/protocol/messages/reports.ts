import { z } from 'zod';
import type { Tuning as EngineTuning } from '../../engine/tuning';
import type {
  PlacementReport as EnginePlacementReport,
  SlideReport as EngineSlideReport,
  VoiceReport as EngineVoiceReport,
} from '../../engine/types';
import {
  type Assert,
  type Equals,
  type Expect,
  placementSchema,
  slidePlacementSchema,
} from '../commands';
import { bgmReportSchema } from './bgm';
import { labelledIdSchema } from './primitives';
import { sessionEventSchema, sessionStateSchema, vocabularySchema } from './session';

/**
 * What a renderer says about itself, and the one body it says all of it in.
 *
 * Every schema here is a *readout* rather than a request, and each exists for
 * the same reason: the answer is only known where the work happens. A panel
 * that drew its faders from its own command history would be wrong from the
 * moment it opened — a browser source opened on `?place=bottom-right:0.32x0.6`
 * was never told to be there by anything the panel saw.
 */

/**
 * What the voice says about itself, so a control surface can draw the chain it
 * is actually running rather than the one it last asked for.
 *
 * `dsp` is the *resolved* configuration — the base preset with every override
 * merged in — and is stated loosely here on purpose. The strict shape is
 * `voiceDspSchema`, which governs what may be *sent*; what comes back is a
 * readout, and a renderer on a newer libsonare that grew a processor should be
 * able to report it rather than have the field stripped on the way through.
 */
export const voiceReportSchema = z.object({
  preset: z.string().nullable(),
  dsp: z.record(z.string(), z.unknown()).nullable(),
  room: z.string().nullable(),
  /** Integrated loudness of the last take, LUFS. Null before anything is spoken. */
  lufs: z.number().nullable(),
  /** True peak of the last take, dBTP. */
  truePeakDb: z.number().nullable(),
  /**
   * Whether the browser is refusing that viewer an audio device until somebody
   * touches the page. See `VoiceReport` in the engine — it is on the wire
   * because it is the one fault here that a control surface cannot fix by
   * sending anything, only by telling the operator where to click.
   */
  blocked: z.boolean(),
});

export type VoiceReport = z.infer<typeof voiceReportSchema>;
type _VoiceReportMatchesEngine = Assert<VoiceReport, EngineVoiceReport>;
type _EngineMatchesVoiceReport = Assert<EngineVoiceReport, VoiceReport>;

/**
 * What the document layer is showing, so a control surface can draw it.
 *
 * On the same footing as `VoiceReport`: the page count is discovered by opening
 * the file, and `ready` is the difference between a page that is up and one
 * that is still being drawn — which is the only thing an operator holding an
 * arrow key needs to know and the one thing the command cannot tell them.
 *
 * `error` is here for the same reason `blocked` is on the voice report: it is a
 * fault nothing can be sent to fix, only reported to whoever can put the file
 * back.
 */
export const slideReportSchema = z.object({
  deck: z.string().nullable(),
  page: z.number(),
  pages: z.number(),
  ready: z.boolean(),
  error: z.string().nullable(),
});

export type SlideReport = z.infer<typeof slideReportSchema>;
type _SlideReportMatchesEngine = Expect<Equals<SlideReport, EngineSlideReport>>;

/**
 * What the set-once layer is running, so a remote fader can be drawn at the
 * value that is actually in force rather than at the one somebody last sent.
 *
 * Reported for the same reason `VoiceReport` is: the defaults belong to the
 * engine objects that own them and differ per avatar, so a panel that inferred
 * them from its own command history would be wrong from the moment it opened
 * and wrong again after every swap.
 *
 * `has` is what makes the difference between a control that is off and a
 * control that is not there. An avatar with no spring bones has no sway to
 * tune, and a fader for a chain that does not exist is a dead one.
 */
export const tuningSchema = z.object({
  idle: z.object({
    breathDepth: z.number(),
    breathPeriod: z.number(),
    idleAmount: z.number(),
    weightShift: z.number(),
    gazeAmount: z.number(),
    eyeLimit: z.number(),
    blink: z.boolean(),
  }),
  sway: z.object({
    enabled: z.boolean(),
    stiffness: z.number(),
    inertia: z.number(),
    gravity: z.number(),
  }),
  /** `height` is metres here, as it is in the command. */
  hop: z.object({ height: z.number(), gravity: z.number() }),
  tail: z.object({ amount: z.number() }),
  render: z.object({ toon: z.boolean(), arkit: z.boolean() }),
  has: z.object({ sway: z.boolean(), tail: z.boolean(), arkit: z.boolean() }),
});

export type Tuning = z.infer<typeof tuningSchema>;
type _TuningMatchesEngine = Expect<Equals<Tuning, EngineTuning>>;

/**
 * A rectangle of the frame as it is *in force*, rather than as somebody asked
 * for it.
 *
 * ## Why this is not `placementSchema`
 *
 * That one governs what may be **sent**, so every field on it is optional and an
 * absent one means "leave it alone" — which is what lets a slider under the
 * pointer send one number. Read back, the same shape would be useless: a report
 * with three fields missing says what the last patch happened to name, and the
 * surface asking has no way to tell an anchor that is centred from an anchor
 * nobody has mentioned. So the limits, the anchor list and the fit stay stated
 * once, in the command schema, and this is that schema with the optionality
 * taken off.
 */
const resolvedPlacementSchema = placementSchema.required();
const resolvedSlidePlacementSchema = slidePlacementSchema.required();

/**
 * How the frame is laid out, so a control surface can draw the layout that is
 * actually going to air.
 *
 * Reported for the same reason `tuningSchema` is: the value belongs to whatever
 * is applying it, and a panel that inferred it from its own command history
 * would be wrong from the moment it opened. Here that is not a corner case but
 * the ordinary one — a browser source opened on `?place=bottom-right:0.32x0.6`
 * is showing a corner that no command ever asked for.
 */
export const placementReportSchema = z.object({
  avatar: resolvedPlacementSchema,
  slide: resolvedSlidePlacementSchema,
});

export type PlacementReport = z.infer<typeof placementReportSchema>;
type _PlacementReportMatchesEngine = Assert<PlacementReport, EnginePlacementReport>;
type _EngineMatchesPlacementReport = Assert<EnginePlacementReport, PlacementReport>;

/** The renderer's avatar loading lifecycle, independent of the heartbeat. */
export const avatarStatusPhaseSchema = z.enum(['idle', 'loading', 'ready', 'failed']);

export type AvatarStatusPhase = z.infer<typeof avatarStatusPhaseSchema>;

/**
 * What the renderer knows about its avatar load.
 *
 * This is separate from `connected`: a renderer can keep reporting heartbeats
 * while a model is loading or after it failed to load. The optional error is
 * bounded so a loader cannot turn a periodic report into an unbounded payload.
 */
export const avatarStatusSchema = z.object({
  phase: avatarStatusPhaseSchema,
  error: z.string().max(1024).nullable().optional(),
});

export type AvatarStatus = z.infer<typeof avatarStatusSchema>;

/**
 * What the viewer POSTs to `/api/report`, on a timer.
 *
 * The report doubles as the heartbeat, so it goes out whether or not anything
 * changed — a server that stops hearing from a viewer marks it disconnected.
 * The vocabulary rides along only when it just changed (on connect, and when
 * the avatar is swapped), because it is the largest thing here and the least
 * volatile.
 */
export const reportBodySchema = z.object({
  state: sessionStateSchema.optional(),
  events: z.array(sessionEventSchema).optional(),
  /** Avatar loading is reported even before a session exists. */
  avatar: avatarStatusSchema.optional(),
  vocabulary: vocabularySchema.optional(),
  voice: voiceReportSchema.optional(),
  tuning: tuningSchema.optional(),
  /**
   * What the document layer is showing. Absent from a renderer that has none,
   * which is how a panel tells "no document layer" from "no document up".
   */
  slides: slideReportSchema.optional(),
  /**
   * How this renderer is laying the frame out. Absent from one that draws only
   * one way, on the same footing as the slide report above.
   */
  placement: placementReportSchema.optional(),
  /** What this renderer is doing with the server-owned background track. */
  bgm: bgmReportSchema.optional(),
  /**
   * Every avatar this renderer can load, which is not the same question as what
   * the loaded one can do. It rides with the vocabulary rather than on the timer
   * — the roster is fixed for the life of the process — and it is here at all so
   * that a surface offering a picker is offering the renderer's own list rather
   * than a copy of the registry it happens to share a bundle with.
   */
  avatars: z.array(labelledIdSchema).optional(),
});

export type ReportBody = z.infer<typeof reportBodySchema>;
