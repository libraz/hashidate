import { z } from 'zod';
import { bgmStateSchema, bgmTrackSchema } from './bgm';
import { deckSchema } from './decks';
import { labelledIdSchema } from './primitives';
import { queueEntrySchema } from './queue';
import { recordingSchema } from './recording';
import {
  avatarStatusSchema,
  placementReportSchema,
  slideReportSchema,
  tuningSchema,
  voiceReportSchema,
} from './reports';
import { sessionEventSchema, sessionStateSchema, vocabularySchema } from './session';

/**
 * Everything the control server knows, in one object.
 *
 * The snapshot is what a panel polls: the renderer's last report, the server's
 * own observations — the queue, the sidecar, the take being written — and the
 * directory listings only a process with a filesystem can produce.
 */

/**
 * What the control server last saw of the speech sidecar.
 *
 * Four states rather than a flag, because "there is no voice on this machine"
 * and "the voice stopped answering" deserve opposite treatment. Most machines
 * never have `tools/tts/` running — the model is another three gigabytes and
 * the recordings behind the voice are not ours — so a server that has never
 * reached it is working as designed, and `absent` says that quietly.
 *
 * `down` is the one worth interrupting somebody over: something was answering
 * on that port and has stopped, which on air means every line from here is
 * mouthed in silence. Telling the two apart is the whole reason this is not a
 * boolean, because a panel that cried about a missing sidecar on every machine
 * without one would be ignored by the time it mattered.
 */
export const speechStateSchema = z.enum(['absent', 'loading', 'ready', 'down']);

export type SpeechState = z.infer<typeof speechStateSchema>;

/**
 * The directories a control server was started on.
 *
 * Here because a listener on the port is not the same thing as *this* server.
 * Two checkouts of this project answer `/api/state` identically, and a launcher
 * that finds one already running has to decide whether to use it or to start
 * its own — a decision that cannot be made from a port number. The document
 * root is the one that decides it, since it is the build the windows would be
 * loaded from; the show directories are here because a launcher that opens them
 * in a file manager would otherwise open its own while driving somebody else's.
 *
 * Absolute paths, and loopback-only by the same licence condition as the rest
 * of this API. See `src/shell/process.ts` for the only consumer.
 */
export const serverRootsSchema = z.object({
  /** What `/` is served from. `dist` unless `--root` said otherwise. */
  document: z.string(),
  slides: z.string(),
  scripts: z.string(),
  motions: z.string(),
  recordings: z.string(),
  /** The direct BGM asset directory, when this server was started with one. */
  bgm: z.string().optional(),
});

export type ServerRoots = z.infer<typeof serverRootsSchema>;

/**
 * The reply to `GET /api/state`.
 *
 * `state` and `vocabulary` are partial because the server genuinely may have
 * neither: nothing has been reported yet, or the last report is stale and the
 * server is withholding it. `connected` is the flag to branch on — it is false
 * both when no viewer is attached and when the attached one has gone quiet.
 * `events` is the log since `?since=`, oldest first.
 */
export const snapshotSchema = z.object({
  connected: z.boolean(),
  viewers: z.number(),
  /** Sequence number of the newest event. Feed it back as `?since=`. */
  seq: z.number(),
  state: sessionStateSchema.partial(),
  vocabulary: vocabularySchema.partial(),
  events: z.array(sessionEventSchema),
  /** The renderer's avatar lifecycle, if a renderer has reported one. */
  avatar: avatarStatusSchema.nullable().optional(),
  /** What the voice is running. Null until a viewer with a voice has reported. */
  voice: voiceReportSchema.nullable(),
  /** What the set-once layer is running. Null until a viewer has reported. */
  tuning: tuningSchema.nullable(),
  /** How the frame is laid out. Null until a viewer has reported one. */
  placement: placementReportSchema.nullable(),
  /** What this renderer can load. Empty until a viewer has reported. */
  avatars: z.array(labelledIdSchema),
  /**
   * The documents on disk, as the server last read them. Empty when there is no
   * document directory or nothing in it — see `deckSchema` for why this is here
   * rather than in the vocabulary.
   */
  decks: z.array(deckSchema),
  /** What the document layer is showing. Null until a viewer with one reports. */
  slides: slideReportSchema.nullable(),
  /** The server-owned BGM transport and timeline. */
  bgm: bgmStateSchema.optional(),
  /** The current fresh roster from the direct BGM directory. */
  bgmTracks: z.array(bgmTrackSchema).optional(),
  /**
   * Whether the voice is answering. This one is the server's own observation
   * rather than a viewer's report — the sidecar is reached from here and only
   * from here. See `speechStateSchema`.
   */
  speech: speechStateSchema,
  /** The pending turns, in the order they will be said. See `queue.ts`. */
  queue: z.array(queueEntrySchema),
  /**
   * The turns a renderer has started and not yet reported an end for.
   *
   * `state.turn` says *which* line is being said and this says *what it says* —
   * a panel otherwise has an id and no words, because a started line is out of
   * `queue` by then and does not reach the history until it is over.
   *
   * A list rather than a single entry, because that is what the server holds:
   * a start is filed per turn id, and an end that never arrives leaves its
   * entry here. A reader after the line on air matches `state.turn` against it
   * rather than taking the first.
   *
   * Only what went through this server's queue is here. A `say` posted straight
   * to `/api/command` never enters it, so its text is not the server's to
   * report — the same boundary the history draws.
   *
   * Optional, like the fields added after it were: the shell probes a port and
   * adopts whatever control server answers, which may have been started from an
   * older checkout. Absent has to read as "this server does not say", because a
   * required field would make that server fail the probe and stop being usable
   * at all over one readout.
   */
  airing: z.array(queueEntrySchema).optional(),
  /**
   * Whether the queue is held. See `pauseCommandSchema`.
   *
   * The server's own, read off the setup it re-delivers on connect rather than
   * off a viewer's report — it is a standing setting, and a renderer that has
   * not attached yet has no opinion about it. That is what makes a script
   * loaded into a held queue stay held through a reload of the stage.
   */
  paused: z.boolean(),
  /**
   * The recording being written, or null. See `recordingSchema` for why this
   * is the server's observation rather than a renderer's.
   */
  recording: recordingSchema.nullable(),
  /**
   * Where this server is serving from. See `serverRootsSchema`.
   *
   * Optional because a hub can be built without them — every test does, and so
   * does anything embedding the hub for a purpose that has no directories. A
   * launcher deciding whether to adopt a running server reads the absence as
   * "not the one I was looking for", which is the safe answer.
   */
  roots: serverRootsSchema.optional(),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

/** The reply to `GET /api/events`, which is the snapshot's event tail alone. */
export const eventsResponseSchema = z.object({
  seq: z.number(),
  events: z.array(sessionEventSchema),
});

export type EventsResponse = z.infer<typeof eventsResponseSchema>;
