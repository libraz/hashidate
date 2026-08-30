import { z } from 'zod';
import { RECORD_DEFAULTS, RECORD_LIMITS } from '../commands';

/**
 * The take being written, and the two routes that open and close it.
 *
 * Everything here is the *server's* observation rather than a renderer's: the
 * bytes are arriving here and the file is open here — see `recordingSchema`.
 */

/**
 * The recording the server has open, if there is one.
 *
 * The server's own observation rather than a viewer's report, on the same
 * footing as `speech`: the bytes are arriving here and the file is open here,
 * so this is the one process that can say whether a recording is actually
 * being written. A renderer that believed it was recording into a file that
 * was never opened is the failure this shape exists to make impossible.
 *
 * `bytes` is what has landed on disk. It is the only honest progress figure —
 * a recorder that has silently stopped producing chunks looks exactly like one
 * that is still going until this stops climbing.
 */
export const recordingSchema = z.object({
  session: z.string(),
  /** Absolute path of the file being written. */
  file: z.string(),
  /**
   * What the renderer's encoder actually chose, or null before the first chunk.
   * The container decides the extension, so this is what says whether the
   * result is the mp4 that was asked for.
   */
  mime: z.string().nullable(),
  /** Epoch seconds the recording was opened. */
  since: z.number(),
  bytes: z.number(),
  /** Whether the end of the queue ends the recording. See `Recordings`. */
  autoStop: z.boolean(),
  /** The output frame, as the renderer was asked for it. */
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  /** Failure observed while opening or writing this take, if any. */
  error: z.string().nullable().default(null),
});

export type Recording = z.infer<typeof recordingSchema>;

/**
 * The body of `POST /api/record/start`.
 *
 * The size is the output frame and is unrelated to the size of the window the
 * stage happens to be in; see `recordCommandSchema`. The defaults are applied
 * here rather than in the renderer so that what the panel asked for and what
 * the server has open are the same numbers.
 */
export const recordStartSchema = z.object({
  /** What to call the file. A script id, usually. Timestamped either way. */
  name: z.string().optional(),
  width: z
    .number()
    .int()
    .min(RECORD_LIMITS.width.min)
    .max(RECORD_LIMITS.width.max)
    .default(RECORD_DEFAULTS.width),
  height: z
    .number()
    .int()
    .min(RECORD_LIMITS.height.min)
    .max(RECORD_LIMITS.height.max)
    .default(RECORD_DEFAULTS.height),
  fps: z
    .number()
    .int()
    .min(RECORD_LIMITS.fps.min)
    .max(RECORD_LIMITS.fps.max)
    .default(RECORD_DEFAULTS.fps),
  /** End the take when the queue runs out. See `RECORD_TAIL_SECONDS`. */
  autoStop: z.boolean().default(true),
  /**
   * Let a held queue go once the recording is actually rolling, rather than
   * when this request is answered. The whole reason the two are one call.
   */
  release: z.boolean().default(false),
});

export type RecordStart = z.infer<typeof recordStartSchema>;

/**
 * The body of `POST /api/record/stop`.
 *
 * `session` is optional and is a guard rather than a selector — there is only
 * ever one take open. Given, it refuses to stop a take that is not the one the
 * caller was looking at, which is the case an operator hits by leaving a stale
 * panel open on a second screen.
 */
export const recordStopSchema = z.object({
  session: z.string().optional(),
});

export type RecordStop = z.infer<typeof recordStopSchema>;

/** The reply to either recording route: the take, or null once it has closed. */
export const recordResponseSchema = z.object({
  recording: recordingSchema.nullable(),
});

export type RecordResponse = z.infer<typeof recordResponseSchema>;
