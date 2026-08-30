import { z } from 'zod';
import { labelledIdSchema } from './primitives';

/**
 * The documents on disk, as the control server found them.
 *
 * Not in the vocabulary, and that is the point — see `deckSchema`.
 */

/**
 * One document the control server can serve, as it found it on disk.
 *
 * Not in the vocabulary, and that is the point: the vocabulary is what the
 * loaded avatar can be asked to do, discovered from the avatar. This is a
 * directory listing, it changes when somebody saves a file, and it is re-read
 * rather than cached — so it rides on the snapshot the panel is already polling
 * and comes from the only process that can see the filesystem.
 *
 * `pages` is counted without rasterising anything, so it is known before the
 * document has ever been shown.
 */
export const deckSchema = labelledIdSchema.extend({
  pages: z.number(),
  bytes: z.number(),
  /** Epoch seconds of the file's last modification, for sorting by newest. */
  at: z.number(),
});

export type Deck = z.infer<typeof deckSchema>;

/** The reply to `GET /api/decks`, and to a rescan. */
export const decksResponseSchema = z.object({
  decks: z.array(deckSchema),
});

export type DecksResponse = z.infer<typeof decksResponseSchema>;

/**
 * The reply to `GET /api/decks/<id>/text`: what a document says, page by page.
 *
 * The piece that makes a document narratable. An orchestrator writing a script
 * needs the words on the pages before it can write anything about them, and it
 * cannot get them from the renderer — the control channel carries commands one
 * way and a report the other, and a request for a document's contents is
 * neither. So the server reads the text itself, which it can do without drawing
 * anything.
 *
 * `pages` is 1 based and in order, with an entry for every page asked for —
 * including the empty string for a page that is all picture, because a gap in
 * the list would be indistinguishable from a page that was not requested.
 */
export const deckTextResponseSchema = z.object({
  id: z.string(),
  pages: z.number(),
  from: z.number(),
  text: z.array(z.string()),
});

export type DeckTextResponse = z.infer<typeof deckTextResponseSchema>;
