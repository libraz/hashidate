import { z } from 'zod';
import { correlationId } from './primitives';

/**
 * Recording the composed frame.
 *
 * The limits and defaults live beside the command rather than in the route that
 * applies them, because both ends need the same numbers — see `RECORD_DEFAULTS`.
 */

/**
 * The widest and tallest a recording may be asked for, and the fastest.
 *
 * The same ceiling `?size=` is guarded by, and for the same reason: the number
 * arrives from outside and backs a framebuffer. See `MAX_DIMENSION` in
 * `stage-mode.ts`.
 */
export const RECORD_LIMITS = {
  width: { min: 16, max: 7680 },
  height: { min: 16, max: 7680 },
  fps: { min: 1, max: 60 },
} as const;

/**
 * The frame a take is recorded at when nobody says otherwise.
 *
 * Here rather than in the route that applies them, because both ends need the
 * same numbers: the server opens the file at these dimensions and the renderer
 * composes at them, and a default that lived on one side would be a recording
 * whose reported size and actual size disagreed.
 */
export const RECORD_DEFAULTS = { width: 1920, height: 1080, fps: 30 } as const;

/**
 * Start or stop recording the composed frame.
 *
 * **Only one renderer acts on this: the one that is not muted.** The command
 * goes to every viewer attached, as they all do, and every viewer but one is a
 * monitor — the panel's preview opens on `?mute=1` and exists to watch what is
 * going to air. Recording in all of them would write the same segment several
 * times over, so the rule is the one the mute already draws: the renderer
 * making the sound is the renderer worth recording. A stage muted because OBS
 * is monitoring it is a stage OBS should be recording.
 *
 * `session` is the file the server has open, and it travels on the stop as
 * well as the start. A stop that named nothing would end whichever recording
 * happened to be running, which is the wrong one exactly when it matters — an
 * operator who started a second take while a stale stop was in flight.
 *
 * The size is the *output* size and is unrelated to how large the stage window
 * is: the frame is composed into a canvas of these dimensions, and whatever the
 * renderer is drawing at is scaled to fit inside it. A window smaller than this
 * therefore records soft rather than small, which is a trade the panel reports
 * rather than one this schema can prevent.
 */
export const recordCommandSchema = z.object({
  cmd: z.literal('record'),
  id: correlationId,
  on: z.boolean(),
  /** The recording this refers to, minted by the server. */
  session: z.string().min(1),
  width: z.number().int().min(RECORD_LIMITS.width.min).max(RECORD_LIMITS.width.max).optional(),
  height: z.number().int().min(RECORD_LIMITS.height.min).max(RECORD_LIMITS.height.max).optional(),
  fps: z.number().int().min(RECORD_LIMITS.fps.min).max(RECORD_LIMITS.fps.max).optional(),
});
