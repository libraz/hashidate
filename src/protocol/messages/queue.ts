import { z } from 'zod';
import { turnSchema } from '../commands';

/**
 * The editable queue, and the history behind it.
 *
 * The queue lives in the control server rather than in the renderer — that is
 * what lets it survive a viewer reload and be reordered from a panel — so every
 * shape here is the server's own rather than the engine's.
 */

/**
 * One turn waiting to be said, as the control server holds it.
 *
 * A turn plus the three things only the server can know: which id it is filed
 * under, who put it there, and when. `id` is not optional here the way it is on
 * a `say` — an entry that cannot be named cannot be edited, moved or deleted,
 * and it is also the id `turn.start` and `turn.end` come back under, so the
 * panel can tell which row is being spoken without a second correlation.
 *
 * `source` and `note` are for the operator and are **never spoken**. They are
 * how a queue full of lines stays legible when they came from three places at
 * once — an orchestrator's script, a viewer's comment, something typed by hand
 * mid-stream — which is the normal case during a broadcast rather than an
 * unusual one.
 */
export const queueEntrySchema = turnSchema.extend({
  id: z.string(),
  /** Which producer put it here: an orchestrator, a comment, the panel. Free-form. */
  source: z.string().optional(),
  /** The operator's own note. Never spoken, never synthesised. */
  note: z.string().optional(),
  /** Epoch seconds it was queued, for ordering a display by age. */
  at: z.number(),
});

export type QueueEntry = z.infer<typeof queueEntrySchema>;

/**
 * A turn the renderer has finished with, as the server files it.
 *
 * The entry it was, plus the two things that only become true at the end: when
 * it stopped, and whether it got there. A line that was cut off is kept for the
 * same reason a finished one is — it is the line most likely to be wanted back,
 * because being cut off is usually the reason somebody reaches for the history
 * at all.
 *
 * The id is the one it was said under, so the event log for that turn and the
 * row an operator is looking at still name the same thing. Sending it round
 * again mints a new one; see `queueRewindSchema`.
 */
export const historyEntrySchema = queueEntrySchema.extend({
  /** Epoch seconds the renderer reported it done. */
  saidAt: z.number(),
  /** True when it was interrupted. Absent means it was said to the end. */
  interrupted: z.boolean().optional(),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/**
 * The body of a queue insertion.
 *
 * `turn` and `turns` both work, and the single form is not sugar: the caller
 * that matters most is a comment handler with exactly one line to say, and
 * making it wrap that line in an array it did not want is the kind of friction
 * that gets worked around with a helper in every consumer.
 */
export const queueAddSchema = z.object({
  turn: turnSchema.optional(),
  turns: z.array(turnSchema).optional(),
  /** Where it goes. Default is the end. */
  at: z.enum(['push', 'unshift']).optional(),
  /** Which producer this came from. Applied to every turn in the batch. Never spoken. */
  source: z.string().optional(),
  /** The operator's note. Never spoken. */
  note: z.string().optional(),
});

export type QueueAdd = z.infer<typeof queueAddSchema>;

/**
 * The body of an edit: which entry, and what to change about it.
 *
 * Every field is optional except the id, so a panel that is only fixing a
 * reading does not have to resend the emotion vector it never touched — and,
 * more to the point, cannot clobber one that changed underneath it.
 */
export const queueUpdateSchema = turnSchema.extend({
  id: z.string(),
  source: z.string().optional(),
  note: z.string().optional(),
});

export type QueueUpdate = z.infer<typeof queueUpdateSchema>;

/**
 * The body of `POST /api/queue/rewind`: send something already said round again.
 *
 * Two modes, because "again" means two different things during a broadcast and
 * the difference is where the script resumes.
 *
 * - `from` takes the named line **and everything said after it** out of the
 *   history and puts them back at the front of the queue, in order. The show
 *   carries on from that point, which is what a rewind is.
 * - `one` copies the named line to the front and leaves the history alone. For
 *   a line that was fluffed and wants saying again, without moving anything
 *   else.
 *
 * Either way the returned lines are new entries with new ids. Reusing the old
 * one would put a second `turn.end` under an id that has already ended, and
 * anything correlating against the event log would have no way to tell the two
 * apart.
 *
 * `interrupt` decides what happens to the line currently on air: cut it off
 * where it is, or let it finish and start the rewound script after it. It is a
 * choice per operation and has no default — cutting a character off mid-word is
 * sometimes exactly right and is never something to do by accident.
 */
export const queueRewindSchema = z.object({
  id: z.string(),
  mode: z.enum(['from', 'one']).default('from'),
  /** Cut the line being said. Absent lets it finish. */
  interrupt: z.boolean().optional(),
});

export type QueueRewind = z.infer<typeof queueRewindSchema>;

/** The reply to anything that reads or changes the queue. */
export const queueResponseSchema = z.object({
  queue: z.array(queueEntrySchema),
  /** How many viewers the resulting queue was delivered to. */
  viewers: z.number(),
});

export type QueueResponse = z.infer<typeof queueResponseSchema>;

/**
 * The reply to `GET /api/history`: what has been said, oldest first.
 *
 * Its own endpoint rather than a field on the snapshot, and the reason is the
 * polling rate. The panel re-reads the snapshot twice a second; a hundred spoken
 * lines riding along with every one of those would be the largest thing on the
 * wire by an order of magnitude, to say something that changes once a line.
 */
export const historyResponseSchema = z.object({
  history: z.array(historyEntrySchema),
});

export type HistoryResponse = z.infer<typeof historyResponseSchema>;
