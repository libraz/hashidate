import { z } from 'zod';
import { correlationId, emotionVectorSchema } from './primitives';

/**
 * The face: the mood underneath it, the drawn expression over that, and the
 * effects over both.
 */

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
