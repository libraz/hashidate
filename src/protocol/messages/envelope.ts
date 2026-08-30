import { z } from 'zod';
import { commandSchema } from '../commands';
import { sessionStateSchema } from './session';

/**
 * How a command travels: what an orchestrator POSTs, what comes back, and what
 * goes down the stream to the viewers.
 *
 * The command vocabulary itself is in `../commands`; these are only the
 * envelopes around it.
 */

/**
 * The body of `POST /api/command`: one command, or several under `batch` to be
 * delivered together. A batch is not a transaction — it is one round trip.
 */
export const commandRequestSchema = z.union([
  commandSchema,
  z.object({ batch: z.array(commandSchema) }),
]);

export type CommandRequest = z.infer<typeof commandRequestSchema>;

/**
 * The reply to a command.
 *
 * `ok` is about delivery, not about the avatar: it says a viewer was connected
 * to receive this, nothing about whether the pose looked right. `ids` are the
 * stamped correlation ids, in the order the commands were given, and are what a
 * caller matches the turn events against. `completed` and `state` appear only
 * for a request that asked to wait, and `completed: false` there means the wait
 * timed out rather than that anything failed.
 */
export const commandResponseSchema = z.object({
  ok: z.boolean(),
  viewers: z.number(),
  ids: z.array(z.string()),
  error: z.string().optional(),
  completed: z.boolean().optional(),
  state: sessionStateSchema.partial().optional(),
});

export type CommandResponse = z.infer<typeof commandResponseSchema>;

/**
 * One SSE frame. `type` is already a discriminant even though there is only one
 * kind of frame today, so a second one can be added without every viewer having
 * to guess from the shape.
 *
 * The stream also carries bare comment lines as keepalives; those never reach a
 * JSON parser, so they are not part of this union.
 */
export const streamMessageSchema = z.object({
  type: z.literal('command'),
  commands: z.array(commandSchema),
});

export type StreamMessage = z.infer<typeof streamMessageSchema>;
