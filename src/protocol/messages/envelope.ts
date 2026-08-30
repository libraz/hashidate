import { z } from 'zod';
import { type Command, parseCommand } from '../commands';
import { sessionStateSchema } from './session';

/**
 * How a command travels: what an orchestrator POSTs, what comes back, and what
 * goes down the stream to the viewers.
 *
 * The command vocabulary itself is in `../commands`; these are only the
 * envelopes around it.
 */

export interface ParsedCommandElements {
  commands: Command[];
  rejected: unknown[];
}

/** Parse each candidate independently, retaining the raw values that failed. */
function parseCommandElements(candidates: readonly unknown[]): ParsedCommandElements {
  const commands: Command[] = [];
  const rejected: unknown[] = [];
  for (const candidate of candidates) {
    const command = parseCommand(candidate);
    if (command) commands.push(command);
    else rejected.push(candidate);
  }
  return { commands, rejected };
}

/**
 * Select request elements using the same rule as the HTTP route: an array in
 * `batch` wins over a `cmd` on the containing object. A non-array `batch` is
 * just an unknown field on a direct command and therefore does not win.
 */
function commandCandidates(value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [value];
  const batch = (value as { batch?: unknown }).batch;
  return Array.isArray(batch) ? batch : [value];
}

/**
 * Decode a command request while retaining rejected elements for callers that
 * want to report them. A request with no known command is invalid and returns
 * `null`, matching the route's 400 response.
 */
export function parseCommandRequest(value: unknown): ParsedCommandElements | null {
  const parsed = parseCommandElements(commandCandidates(value));
  return parsed.commands.length > 0 ? parsed : null;
}

/**
 * The body of `POST /api/command`: one command, or several under `batch` to be
 * delivered together. A batch is not a transaction — it is one round trip.
 *
 * The schema's output is always the canonical command list. Unknown or
 * malformed elements in a mixed batch are dropped; a request with no known
 * elements fails. Use `parseCommandRequest` when the caller also needs the raw
 * rejected elements for diagnostics.
 */
export const commandRequestSchema = z.unknown().transform((value, ctx): Command[] => {
  const parsed = parseCommandRequest(value);
  if (parsed === null) {
    ctx.addIssue({ code: 'custom', message: 'request contains no known commands' });
    return z.NEVER;
  }
  return parsed.commands;
});

/** Input shape accepted by the command endpoint. The schema output is `Command[]`. */
export type CommandRequest = Command | { batch: Command[] };
export type ParsedCommandRequest = ParsedCommandElements;

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
const streamMessageInputSchema = z.object({
  type: z.literal('command'),
  commands: z.array(z.unknown()),
});

/**
 * One SSE command frame, canonicalized element-wise. An all-unknown frame is
 * valid and becomes an empty command list: the stream itself remains healthy.
 */
export const streamMessageSchema = streamMessageInputSchema.transform(({ commands }) => ({
  type: 'command' as const,
  commands: parseCommandElements(commands).commands,
}));

export type StreamMessage = z.infer<typeof streamMessageSchema>;

export type ParsedStreamMessage = StreamMessage & { rejected: unknown[] };

/**
 * Decode a stream frame while retaining raw elements the viewer can surface.
 * The returned `commands` list is canonical and may be empty.
 */
export function parseStreamMessage(value: unknown): ParsedStreamMessage | null {
  const envelope = streamMessageInputSchema.safeParse(value);
  if (!envelope.success) return null;
  const parsed = parseCommandElements(envelope.data.commands);
  return { type: 'command', commands: parsed.commands, rejected: parsed.rejected };
}
