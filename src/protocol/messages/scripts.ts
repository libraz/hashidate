import { z } from 'zod';
import { queueResponseSchema } from './queue';

/**
 * The scripts on disk, and putting one on the queue.
 *
 * A script is run *by the server* rather than by whoever asked for it, because
 * the panel has no filesystem — see `scriptRunSchema`.
 */

/**
 * One script on disk, as much of it as a picker needs.
 *
 * Not the script itself. A run of turns is the largest thing in `show/` that is
 * text, and the panel draws a row per file — so what travels is what a row
 * shows and what a decision is made on: what it is called, how long it is, and
 * when it was saved. The turns arrive by being queued, which is the only thing
 * anybody does with them.
 *
 * `title` is the script's own, a plain string rather than a `Localized`, on the
 * rule `scriptSchema` states: a script is written in one language because its
 * lines are. Absent when the file gives none, and then the id is the name.
 */
export const scriptSummarySchema = z.object({
  /** The filename without its extension. See `loadScript`. */
  id: z.string(),
  title: z.string().optional(),
  /** How many turns it queues, and how many commands it sets up first. */
  lines: z.number(),
  setup: z.number(),
  bytes: z.number(),
  /** Epoch seconds of the file's last modification, as a document's is. */
  at: z.number(),
});

export type ScriptSummary = z.infer<typeof scriptSummarySchema>;

/**
 * The reply to `GET /api/scripts`: what is there, and what would not parse.
 *
 * Both halves, on the same rule the motion roster follows. A file an operator
 * saved into the directory and that is not a script has to be visible as
 * exactly that — a name missing from a list reads as a name typed wrong, which
 * is the one thing it is not.
 */
export const scriptsResponseSchema = z.object({
  scripts: z.array(scriptSummarySchema),
  errors: z.array(z.object({ id: z.string(), error: z.string() })),
});

export type ScriptsResponse = z.infer<typeof scriptsResponseSchema>;

/**
 * The body of `POST /api/scripts/run`: put a script on the queue.
 *
 * Doing on the server what `runScript` does from a client — clear, setup, queue
 * — so that a panel can run a file it cannot read. The panel has no filesystem;
 * the alternative was shipping the whole script to the browser so it could send
 * the turns back, which is the same run of turns crossing the wire twice for
 * nothing.
 *
 * `pause` is why this exists as more than a convenience. A script queued to be
 * *recorded* must not start on arrival: the shot is framed after the lines are
 * loaded and before the first one is said. Holding is therefore the default,
 * and a caller that wants the old behaviour — an orchestrator running a segment
 * live — says `pause: false`.
 *
 * `replace` is not the default, on the rule the queue follows everywhere else:
 * dropping what somebody else queued is a decision, not a side effect of
 * loading a file.
 */
export const scriptRunSchema = z.object({
  id: z.string(),
  /** Empty the queue first. Absent adds to the end of it. */
  replace: z.boolean().optional(),
  /** Hold the queue rather than letting it start. Absent holds. */
  pause: z.boolean().optional(),
});

export type ScriptRun = z.infer<typeof scriptRunSchema>;

/**
 * The reply to `POST /api/scripts/run`.
 *
 * The queue as it now stands, plus what was run and whether the setup got
 * anywhere. Those last two are separate because they have separate fates: the
 * lines belong to the server's queue and survive having no renderer attached,
 * while the setup is live commands and is simply refused when there is nothing
 * to apply them to. A caller told only "ok" would have no way to know that the
 * avatar, the costume and the framing its script asked for never happened.
 */
export const scriptRunResponseSchema = queueResponseSchema.extend({
  id: z.string(),
  /** How many setup commands were sent, and how many viewers took them. */
  setup: z.number(),
  setupDelivered: z.number(),
  /** Whether the queue was left held. See `pauseCommandSchema`. */
  paused: z.boolean(),
});

export type ScriptRunResponse = z.infer<typeof scriptRunResponseSchema>;
