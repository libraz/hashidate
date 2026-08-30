import { type ZodType, z } from 'zod';
import {
  type BgmResponse,
  type BgmTrack,
  bgmResponseSchema,
  type CommandRequest,
  type DecksResponse,
  type DeckTextResponse,
  decksResponseSchema,
  deckTextResponseSchema,
  type EventsResponse,
  eventsResponseSchema,
  type HistoryResponse,
  historyResponseSchema,
  type MotionsResponse,
  motionsResponseSchema,
  type QueueResponse,
  queueResponseSchema,
  type Snapshot,
  snapshotSchema,
  type TurnRequest,
  type Vocabulary,
  vocabularySchema,
} from '../protocol';

/**
 * HTTP transport for the control API, shared by every node-side caller.
 *
 * A thin wrapper over the endpoints and nothing more: an orchestrator would post
 * the same JSON directly, so anything clever here would be a behaviour the API
 * does not actually have.
 *
 * ## It reports failure by throwing, and that is the whole reason it lives here
 *
 * This started as the CLI's own transport and printed the failure and exited,
 * which is right for a command that does one thing and is done. It is wrong for
 * anything that outlives a request. The MCP adapter is running while the control
 * server is restarted — that is what `yarn dev` does all day — and a transport
 * that exits the process on a refused connection would take the adapter down
 * with it, leaving the model on the other end talking to nothing.
 *
 * So the failure is a `ControlError` and the caller decides. The CLI's decision
 * is still to print it and stop; see `src/cli/client.ts`.
 */

export const DEFAULT_BASE = 'http://127.0.0.1:8765/api';

/** Long enough to cover a `--wait` on a turn that runs its full course. */
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * The control server could not be reached, or answered something this client
 * cannot read. Its own class so that a caller can tell it from a programming
 * error and answer with it rather than dying of it.
 */
export class ControlError extends Error {}

/**
 * A queue reply, together with the failure the endpoint hands back with it.
 *
 * An edit naming an entry that is no longer pending answers 404 *and* the
 * current list — the ordinary outcome of editing a row that started playing
 * while the caller was writing the edit, so the list is worth more than the
 * status code (see `queue()` in `src/server/routes.ts`).
 *
 * `error` is carried explicitly because zod drops what a schema does not
 * mention: read through `queueResponseSchema` alone, a refused edit comes back
 * looking exactly like an applied one.
 */
export type QueueOutcome = QueueResponse & { error?: string };

const queueOutcomeSchema = queueResponseSchema.extend({ error: z.string().optional() });

/**
 * Read a response through its schema, so a field a caller acts on is a field the
 * server actually promised.
 */
function expect<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ControlError(`Unexpected response: ${JSON.stringify(body)}`);
  return parsed.data;
}

export class ControlClient {
  constructor(private readonly base: string = DEFAULT_BASE) {}

  /** GET when there is no payload, POST when there is. */
  async request(path: string, payload?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ControlError(
        `Cannot reach the control server (${this.base}): ${reason(error)}\n  start it with yarn dev`,
      );
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // An error page rather than an error object: hand the body back so the
      // caller can see what answered.
      return response.ok ? {} : { error: `HTTP ${response.status}`, body: text };
    }
  }

  /**
   * Send one command, or several under `batch` to travel together. The reply is
   * passed through unread — `ok` is about delivery, and what the caller wants to
   * see is whatever the server said.
   */
  command(command: CommandRequest, wait?: string): Promise<unknown> {
    return this.request(`/command${wait ? `?wait=${wait}` : ''}`, command);
  }

  async state(): Promise<Snapshot> {
    return expect(snapshotSchema, await this.request('/state'));
  }

  /** Empty until a viewer has connected: it is discovered from the avatar. */
  async vocabulary(): Promise<Partial<Vocabulary>> {
    return expect(vocabularySchema.partial(), await this.request('/vocabulary'));
  }

  /** Long poll: returns as soon as there is an event newer than `since`. */
  async events(since: number, waitSeconds: number): Promise<EventsResponse> {
    const body = await this.request(
      `/events?since=${since}&wait=${waitSeconds}`,
      undefined,
      (waitSeconds + 30) * 1000,
    );
    return expect(eventsResponseSchema, body);
  }

  /**
   * Put turns on the server's queue — the copy that survives a viewer reload and
   * that the panel can edit. Not the same thing as a `say` command, which goes
   * straight to the renderer and is visible nowhere.
   *
   * `source` is stamped on every turn in the batch and is never spoken. It is
   * what keeps a queue legible when a script, a comment and something typed by
   * hand are all landing in it at once.
   */
  async queueAdd(
    turns: TurnRequest[],
    { at, source, note }: { at?: 'push' | 'unshift'; source?: string; note?: string } = {},
  ): Promise<QueueResponse> {
    const body = await this.request('/queue', { turns, at, source, note });
    return expect(queueResponseSchema, body);
  }

  /**
   * Change a pending entry. Only the fields given move: a caller fixing a
   * reading does not resend the emotion vector, and so cannot clobber one that
   * changed underneath it.
   */
  async queueUpdate(id: string, patch: TurnRequest & { note?: string }): Promise<QueueOutcome> {
    return expect(queueOutcomeSchema, await this.request('/queue/update', { ...patch, id }));
  }

  async queueRemove(id: string): Promise<QueueOutcome> {
    return expect(queueOutcomeSchema, await this.request('/queue/remove', { id }));
  }

  /** Move an entry to a position counted from the front of the pending list. */
  async queueMove(id: string, to: number): Promise<QueueOutcome> {
    return expect(queueOutcomeSchema, await this.request('/queue/move', { id, to }));
  }

  /**
   * Drop everything pending. The line on air is already out of the queue and is
   * unaffected; stopping that one is `interrupt`.
   */
  async queueClear(): Promise<QueueOutcome> {
    return expect(queueOutcomeSchema, await this.request('/queue/clear', {}));
  }

  /**
   * Send something already said round again: `from` takes that line and
   * everything after it back out of the history, `one` repeats just that line.
   * `interrupt` decides what happens to the line currently being said, and is
   * required here for the reason `queueRewindSchema` gives it no default.
   */
  async queueRewind(
    id: string,
    mode: 'from' | 'one',
    { interrupt }: { interrupt: boolean },
  ): Promise<QueueOutcome> {
    const body = await this.request('/queue/rewind', { id, mode, interrupt });
    return expect(queueOutcomeSchema, body);
  }

  /** What has been said, oldest first. Its own endpoint; see `historyResponseSchema`. */
  async history(): Promise<HistoryResponse> {
    return expect(historyResponseSchema, await this.request('/history'));
  }

  /**
   * The documents the control server can see, as it finds them now.
   *
   * A directory listing rather than renderer data, which is why it is not in the
   * vocabulary: what documents exist is a question only the process with a
   * filesystem can answer, and it changes when somebody saves a file.
   */
  async decks(): Promise<DecksResponse> {
    return expect(decksResponseSchema, await this.request('/decks'));
  }

  /**
   * The motions the control server can see, and the files that were meant to be
   * some.
   *
   * A directory listing, like `decks` above and for the same reason. The
   * renderer reads this on connect and registers what is in it; a caller asking
   * here is asking what the *next* renderer to connect would get, which is the
   * question worth asking after editing a file.
   */
  async motions(): Promise<MotionsResponse> {
    return expect(motionsResponseSchema, await this.request('/motions'));
  }

  /**
   * The playable BGM files the control server can see right now.
   *
   * Unlike the snapshot's cached state, this endpoint rescans the direct BGM
   * directory for every request. A track added beside a running show therefore
   * becomes available without restarting either the server or this client.
   */
  async bgm(): Promise<BgmResponse> {
    return expect(bgmResponseSchema, await this.request('/bgm'));
  }

  /** The track roster alone, for callers that do not need the response wrapper. */
  async bgmTracks(): Promise<BgmTrack[]> {
    return (await this.bgm()).tracks;
  }

  /**
   * What a document says, page by page.
   *
   * The piece that makes a document narratable: a caller writing a script about
   * a deck needs the words on its pages, and there is nowhere else to get them —
   * the control channel carries commands one way and a report the other, and the
   * renderer is not asked. `from` and `to` are 1 based and inclusive; leaving
   * them off reads the whole document.
   */
  async deckText(
    id: string,
    { from, to }: { from?: number; to?: number } = {},
  ): Promise<DeckTextResponse> {
    const query = new URLSearchParams();
    if (from !== undefined) query.set('from', String(from));
    if (to !== undefined) query.set('to', String(to));
    const suffix = query.size > 0 ? `?${query}` : '';
    const body = await this.request(`/decks/${encodeURIComponent(id)}/text${suffix}`);
    return expect(deckTextResponseSchema, body);
  }
}

/** The bit of a fetch failure worth showing: usually ECONNREFUSED. */
function reason(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error) return cause.message;
    return error.message;
  }
  return String(error);
}
