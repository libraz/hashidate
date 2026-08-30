import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type BgmResponse,
  type Command,
  type CommandResponse,
  commandRequestSchema,
  type DecksResponse,
  type EventsResponse,
  type HistoryResponse,
  isPayloadIdCommand,
  type MotionsResponse,
  type QueueResponse,
  queueAddSchema,
  queueRewindSchema,
  queueUpdateSchema,
  recordStartSchema,
  recordStopSchema,
  rendererIdSchema,
  reportBodySchema,
  type ScriptRunResponse,
  type ScriptsResponse,
  scriptRunSchema,
} from '../protocol';
import { ScriptError } from '../script';
import { type BgmLibrary, listBgm } from './bgm';
import type { Decks } from './decks';
import type { Hub } from './hub';
import type { Motions } from './motions';
import type { Scripts } from './scripts';
import { handleSpeech } from './speech';

/**
 * The `/api/` surface: commands down, state and events back up.
 *
 * Everything here answers in JSON and nothing here is cacheable; see
 * `static.ts` for why that matters for the rest of the document root too.
 */

/**
 * A comment line every so often keeps proxies and the browser from timing the
 * stream out during a quiet stretch.
 */
export const SSE_PING_SECONDS = 15;

/** `?wait=1` on a command means "until the turn ends", with this cap. */
const COMMAND_WAIT_SECONDS = 120;

/** `?wait=1` on the event log is a long poll, and a much shorter one. */
const EVENTS_WAIT_SECONDS = 30;

/**
 * Endpoints that are traffic rather than events: the SSE stream sits open, the
 * report is a heartbeat every 700 ms, and the panel re-reads the state twice a
 * second for as long as it is open. Logging them buries the commands, which are
 * the only lines worth reading.
 */
const QUIET = ['/api/stream', '/api/report', '/api/speech', '/api/state', '/api/record/chunk'];

/**
 * The most one chunk of a recording may be.
 *
 * The renderer posts about a second at a time, which at 1080p is a few hundred
 * kilobytes. This is generous against that and still small enough that a
 * request naming the chunk route by mistake cannot be a way to fill memory.
 */
export const RECORD_CHUNK_MAX_BYTES = 64 * 1024 * 1024;

interface StampedCommand {
  command: Command;
  id: string;
}

let stampCounter = 0;

/**
 * The directory-backed stores a server was built with, if it was built with any.
 *
 * A bag rather than a run of positional arguments: they are all optional, they
 * are all "the filesystem, as this server sees it", and a fourth nullable
 * parameter in a row is how the third one ends up in the fourth one's place.
 * The recordings store is deliberately not here — a take is driven from the
 * hub, which is the thing that sees a line end.
 */
export interface Stores {
  decks?: Decks | null;
  motions?: Motions | null;
  scripts?: Scripts | null;
  bgm?: BgmLibrary | null;
}

/**
 * Route one request, or decline it.
 *
 * Returns false for anything outside `/api/`, which the caller then serves off
 * disk. Work that has to read a body or wait for the viewer continues after the
 * return — the boolean is about ownership, not about completion.
 */
export function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  hub: Hub,
  stores: Stores = {},
): boolean {
  const { pathname, params } = split(req.url ?? '/');
  if (!pathname.startsWith('/api/')) return false;
  logRequest(req, res, pathname);
  if (req.method === 'GET' || req.method === 'HEAD') {
    get(res, hub, stores, pathname, params);
    return true;
  }
  if (req.method === 'POST') {
    // Before the JSON body reader, and the only route that goes round it. A
    // chunk is the encoder's own bytes; everything else under `/api/` is JSON
    // in and JSON out, and this stays JSON out.
    if (pathname === '/api/record/chunk') {
      launch(res, recordChunk(req, res, hub, params));
      return true;
    }
    launch(res, post(req, res, hub, stores, pathname, params));
    return true;
  }
  json(res, { error: 'unknown endpoint' }, 404);
  return true;
}

// --- helpers ----------------------------------------------------------------

function split(url: string): { pathname: string; params: URLSearchParams } {
  const parsed = new URL(url, 'http://127.0.0.1');
  return { pathname: parsed.pathname, params: parsed.searchParams };
}

/** Accept the identity spellings used by older and newer renderer clients. */
function rendererIdentity(params: URLSearchParams): string | undefined {
  const raw = params.get('renderer') ?? params.get('rendererId') ?? params.get('id');
  if (raw === null) return undefined;
  const parsed = rendererIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** A chunk must be attributable; anonymous legacy streams still may connect. */
function requiredRendererIdentity(
  params: URLSearchParams,
): { value: string } | { error: string; detail?: unknown } {
  const raw = params.get('renderer') ?? params.get('rendererId') ?? params.get('id');
  if (raw === null || raw === '') return { error: 'renderer id is required' };
  const parsed = rendererIdSchema.safeParse(raw);
  if (!parsed.success) return { error: 'invalid renderer id', detail: parsed.error.issues };
  return { value: parsed.data };
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  // A delayed route can finish after its caller has navigated away. Treat that
  // as a discarded response, including the successful path: writing headers
  // here would turn an ordinary client close into an uncaught server error.
  if (res.destroyed || res.writableEnded) return;
  // Headers cannot be changed once a route has started its response. Ending
  // that partial response is the only safe terminal action left.
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * Settle route work that continues after `handleApi` returns.
 *
 * Node does not do anything with a promise started from an HTTP callback. A
 * filesystem read or a renderer wait that rejects there would therefore be an
 * unhandled rejection, and in a process configured to treat those as fatal it
 * would take the control server down with it. The response may have gone away
 * while the work was waiting — the normal case when a browser tab is closed —
 * so the terminal path must be as quiet as the input path.
 */
function launch(res: ServerResponse, work: Promise<void>): void {
  void work.catch((error: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    console.error('API request failed:', error);
    try {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, { error: 'internal server error' }, 500);
    } catch {
      // The peer can close between the guard and the write. There is no useful
      // response left to send, and this path must never create another reject.
    }
  });
}

/**
 * Read a JSON body. `null` means the body was invalid or was discarded after
 * the peer went away; an empty body is an empty object, which is what a bare
 * POST means.
 */
async function readBody(req: IncomingMessage): Promise<{ value: unknown } | null> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) chunks.push(chunk as Buffer);
  } catch {
    // A renderer or panel going away mid-post is a discarded request, not a
    // server fault. Returning null lets the route classify it as invalid while
    // keeping the iterator rejection inside the body reader.
    return null;
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return { value: {} };
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return null;
  }
}

function toInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

/** `?wait=1` and `?wait=true` mean the default; anything else is seconds. */
function waitSeconds(raw: string, fallback: number): number {
  if (raw === '1' || raw === 'true') return fallback;
  const seconds = Number.parseFloat(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

/** One line per command is useful; one line per texture request is not. */
function logRequest(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (QUIET.some((quiet) => pathname.startsWith(quiet))) return;
  res.on('finish', () => {
    console.log(
      `${new Date().toISOString()} ${req.method ?? '?'} ${req.url ?? ''} ${res.statusCode}`,
    );
  });
}

// --- routes -----------------------------------------------------------------

function get(
  res: ServerResponse,
  hub: Hub,
  stores: Stores,
  pathname: string,
  params: URLSearchParams,
): void {
  const { decks = null, motions = null, scripts = null, bgm = null } = stores;
  switch (pathname) {
    case '/api/stream':
      stream(res, hub, rendererIdentity(params));
      return;
    case '/api/state':
      json(res, hub.snapshot(toInt(params.get('since'))));
      return;
    case '/api/vocabulary':
      json(res, hub.snapshot().vocabulary);
      return;
    case '/api/events':
      launch(res, events(res, hub, params));
      return;
    case '/api/queue':
      json(res, { queue: hub.queue.list(), viewers: hub.viewers } satisfies QueueResponse);
      return;
    // Read separately from the snapshot on purpose. See `historyResponseSchema`.
    case '/api/history':
      json(res, { history: hub.queue.history() } satisfies HistoryResponse);
      return;
    // The roster rides on the snapshot as well; this is the form that waits for
    // a rescan rather than answering with the last one. See `Decks.list`.
    case '/api/decks':
      launch(res, listDecks(res, decks));
      return;
    // Read fresh rather than off the snapshot, unlike the document roster. A
    // renderer asks for this once when it connects and then plays what it was
    // given for the life of the page, so there is nothing for a cached copy to
    // save and one stale read would be a motion edited and apparently ignored.
    case '/api/motions':
      launch(res, listMotions(res, motions));
      return;
    // Read fresh for the reason the motion roster is, and one more: a script is
    // edited in a text editor beside the panel, and the loop an operator runs
    // is save, press the chip again. A cached roster would answer that with the
    // run of turns from before the edit.
    case '/api/scripts':
      launch(res, listScripts(res, scripts));
      return;
    case '/api/bgm':
      launch(res, listBackgroundMusic(res, bgm));
      return;
    default:
      // `/api/decks/<id>/text` is the one route here with a name in it, so it
      // cannot be a case above. Nothing else under `/api/` is patterned.
      if (pathname.startsWith('/api/decks/')) {
        launch(res, deckText(res, decks, pathname, params));
        return;
      }
      json(res, { error: 'unknown endpoint' }, 404);
  }
}

/**
 * The documents on disk. Empty rather than absent on a server started without a
 * document directory, which is the same answer the snapshot gives.
 */
async function listDecks(res: ServerResponse, decks: Decks | null): Promise<void> {
  const listed = decks === null ? [] : await decks.list();
  json(res, { decks: listed } satisfies DecksResponse);
}

/** The operator's own gestures, and the files that were meant to be some. */
async function listMotions(res: ServerResponse, motions: Motions | null): Promise<void> {
  const listed = motions === null ? { motions: [], errors: [] } : await motions.list();
  json(res, listed satisfies MotionsResponse);
}

/** The runs of turns written down, and the files that were meant to be some. */
async function listScripts(res: ServerResponse, scripts: Scripts | null): Promise<void> {
  const listed = scripts === null ? { scripts: [], errors: [] } : await scripts.list();
  json(res, listed satisfies ScriptsResponse);
}

/** The operator's BGM files, rescanned for every roster request. */
async function listBackgroundMusic(res: ServerResponse, bgm: BgmLibrary | null): Promise<void> {
  const listed = await listBgm(bgm);
  json(res, listed satisfies BgmResponse);
}

/**
 * What a document says, page by page.
 *
 * `?from=` and `?to=` are both 1 based and inclusive, and the whole document is
 * the default — a caller that means "the deck" writes nothing. The span is
 * clamped to the document and capped at `DECK_TEXT_MAX_PAGES`; see there for
 * why one request may not return a novel.
 *
 * An id with no file behind it is a 404 rather than an empty reply. A document
 * is a file an operator dropped in a directory, so telling a caller that the
 * name it asked about is not there is the useful answer.
 */
async function deckText(
  res: ServerResponse,
  decks: Decks | null,
  pathname: string,
  params: URLSearchParams,
): Promise<void> {
  const parts = pathname.split('/');
  if (parts.length !== 5 || parts[4] !== 'text')
    return json(res, { error: 'unknown endpoint' }, 404);
  // Decoded here and nowhere else in this file: this is the only route with a
  // name in its path, and a document may be called 資料.pdf — which arrives
  // percent-encoded and matches nothing on disk if it is read raw.
  let id: string;
  try {
    id = decodeURIComponent(parts[3]);
  } catch {
    return json(res, { error: 'no such deck' }, 404);
  }
  const found = await decks?.text(id, toInt(params.get('from')), toInt(params.get('to')));
  if (!found) return json(res, { error: 'no such deck' }, 404);
  return json(res, found);
}

async function post(
  req: IncomingMessage,
  res: ServerResponse,
  hub: Hub,
  stores: Stores,
  pathname: string,
  params: URLSearchParams,
): Promise<void> {
  const body = await readBody(req);
  if (body === null) {
    if (!(req.destroyed || res.destroyed || res.writableEnded)) {
      json(res, { error: 'invalid json' }, 400);
    }
    return;
  }
  if (pathname === '/api/command') return command(res, hub, body.value, params);
  if (pathname === '/api/report') return report(res, hub, body.value);
  if (pathname === '/api/speech') return handleSpeech(res, body.value);
  if (pathname === '/api/scripts/run')
    return runScript(res, hub, stores.scripts ?? null, body.value);
  if (pathname === '/api/record/start') return recordStart(res, hub, body.value);
  if (pathname === '/api/record/stop') return recordStop(res, hub, body.value);
  if (pathname.startsWith('/api/queue')) return queue(res, hub, pathname, body.value);
  return json(res, { error: 'unknown endpoint' }, 404);
}

// --- scripts ----------------------------------------------------------------

/**
 * Put a script on the queue: clear, setup, queue — the order `runScript` uses.
 *
 * The same three steps a client makes over three requests, made here in one,
 * and made here at all because the panel cannot read a file. See
 * `scriptRunSchema` for why holding the queue is the default.
 *
 * The setup and the lines are answered on separately. A setup refused for want
 * of a renderer is not a failed run — the lines are on the server's queue and
 * will be delivered to whatever attaches next — but it does mean the avatar,
 * the costume and the framing the script asked for did not happen, and a caller
 * that is about to press record needs to know that before it does.
 */
async function runScript(
  res: ServerResponse,
  hub: Hub,
  scripts: Scripts | null,
  body: unknown,
): Promise<void> {
  const parsed = scriptRunSchema.safeParse(body);
  if (!parsed.success) {
    return json(res, { error: 'invalid run', detail: parsed.error.issues }, 400);
  }
  if (scripts === null) return json(res, { error: 'no script directory' }, 404);

  let loaded: Awaited<ReturnType<Scripts['get']>>;
  try {
    loaded = await scripts.get(parsed.data.id);
  } catch (error) {
    // A file that is there and is not a script. Its own status, because the
    // fix is to edit the file rather than to pick a different name.
    return json(res, { error: error instanceof ScriptError ? error.message : String(error) }, 422);
  }
  if (loaded === null) return json(res, { error: 'no such script' }, 404);

  if (parsed.data.replace) hub.queue.clear();
  hub.queue.add(loaded.script.lines, { source: loaded.id });

  const setup = loaded.script.setup ?? [];
  const paused = parsed.data.pause ?? true;
  // One frame, in the order `Hub.subscribe` uses and for the same reason: a
  // script whose setup swaps the avatar makes the renderer hold everything
  // behind the load, and a queue sent as a second frame would arrive after that
  // hold ended and be applied to the scene it was not written for.
  //
  // The hold sits between them rather than after the queue so that there is no
  // arrangement of these commands in which a renderer holds a full queue with
  // nothing yet telling it not to start.
  const commands: Command[] = [...setup, { cmd: 'pause', on: paused }, hub.queue.command()];
  const viewers = hub.send({ type: 'command', commands });

  const payload: ScriptRunResponse = {
    queue: hub.queue.list(),
    viewers,
    id: loaded.id,
    setup: setup.length,
    setupDelivered: setup.length === 0 ? 0 : viewers,
    paused,
  };
  return json(res, payload);
}

// --- recording --------------------------------------------------------------

function recordStart(res: ServerResponse, hub: Hub, body: unknown): void {
  const parsed = recordStartSchema.safeParse(body);
  if (!parsed.success) {
    json(res, { error: 'invalid recording', detail: parsed.error.issues }, 400);
    return;
  }
  const opened = hub.startRecording(parsed.data);
  if (opened === null) {
    // Either there is no recordings directory or a take is already running, and
    // the current one says which: null for the first, present for the second.
    const running = hub.recording;
    json(
      res,
      {
        error: running === null ? 'no recordings directory' : 'a recording is already running',
        recording: running,
      },
      409,
    );
    return;
  }
  json(res, { recording: opened });
}

function recordStop(res: ServerResponse, hub: Hub, body: unknown): void {
  const parsed = recordStopSchema.safeParse(body);
  if (!parsed.success) {
    json(res, { error: 'invalid stop', detail: parsed.error.issues }, 400);
    return;
  }
  const stopped = hub.stopRecording(parsed.data.session);
  if (stopped === null) {
    json(res, { error: 'no recording', recording: null }, 404);
    return;
  }
  // Still open: the encoder's last second is on its way. See `Hub.stopRecording`.
  json(res, { recording: stopped });
}

/**
 * Take one chunk of an encoded recording.
 *
 * The only route here that reads a body which is not JSON. It still answers
 * JSON, which is the part of the rule that matters: a caller that trusts every
 * reply under `/api/` to parse can go on doing so.
 *
 * The session and the media type ride on the query string rather than in the
 * body for the obvious reason — the body is the file.
 */
async function recordChunk(
  req: IncomingMessage,
  res: ServerResponse,
  hub: Hub,
  params: URLSearchParams,
): Promise<void> {
  const session = params.get('session') ?? '';
  if (session === '') return json(res, { error: 'no session' }, 400);
  const owner = requiredRendererIdentity(params);
  if ('error' in owner) return json(res, owner, 400);
  const mime = params.get('mime') ?? 'application/octet-stream';
  const final = params.get('final') === '1';

  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += (chunk as Buffer).byteLength;
      if (bytes > RECORD_CHUNK_MAX_BYTES) {
        req.destroy();
        return json(res, { error: 'chunk too large' }, 413);
      }
      chunks.push(chunk as Buffer);
    }
  } catch {
    // The page was closed mid-post. Nothing to report and nothing to write.
    if (!(req.destroyed || res.destroyed || res.writableEnded)) {
      json(res, { error: 'chunk was cut off' }, 400);
    }
    return;
  }

  const outcome = await hub.recordChunk(session, owner.value, mime, Buffer.concat(chunks), {
    final,
  });
  if (outcome.status === 'stale') {
    return json(res, { error: 'not the recording in flight', recording: hub.recording }, 409);
  }
  if (outcome.status === 'conflict') {
    return json(
      res,
      { error: 'recording belongs to another renderer', recording: hub.recording },
      409,
    );
  }
  if (outcome.status === 'failed') {
    return json(res, { error: 'recording write failed', recording: hub.recording }, 500);
  }
  return json(res, { ok: true, recording: hub.recording });
}

// --- the queue --------------------------------------------------------------

/**
 * Everything that changes the pending list.
 *
 * One handler rather than a route per verb, because every one of them ends the
 * same way — mutate, push the whole list to the renderer, answer with the list —
 * and splitting that tail across nine functions is how two of them come to
 * differ. `DELETE` and `PATCH` are spelled as POSTs to sub-paths for the same
 * reason the rest of this API is: it is read from a `fetch` in a panel and from
 * `curl` at a prompt, and a verb nobody has to remember is worth more here than
 * REST manners.
 *
 * An operation naming an entry that is no longer pending answers 404 with the
 * current list attached. That is the ordinary outcome of editing a row that
 * started playing while the form was open, and the caller needs the list it
 * *should* have been looking at more than it needs the error.
 */
function queue(res: ServerResponse, hub: Hub, pathname: string, body: unknown): void {
  const done = (ok: boolean): void => {
    const viewers = hub.publishQueue();
    const payload: QueueResponse = { queue: hub.queue.list(), viewers };
    json(res, ok ? payload : { ...payload, error: 'no such entry' }, ok ? 200 : 404);
  };
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const id = typeof fields.id === 'string' ? fields.id : '';

  switch (pathname) {
    case '/api/queue':
    case '/api/queue/push':
    case '/api/queue/unshift': {
      const parsed = queueAddSchema.safeParse(body);
      if (!parsed.success) {
        json(res, { error: 'invalid turns', detail: parsed.error.issues }, 400);
        return;
      }
      // `turns` for a batch, `turn` for the single line that is the common case
      // from a comment handler. Both, rather than making every caller wrap one
      // line in an array it did not want.
      const turns = parsed.data.turns ?? (parsed.data.turn ? [parsed.data.turn] : []);
      if (turns.length === 0) {
        json(res, { error: 'no turns' }, 400);
        return;
      }
      hub.queue.add(turns, {
        at: pathname === '/api/queue/unshift' ? 'unshift' : (parsed.data.at ?? 'push'),
        source: parsed.data.source,
        note: parsed.data.note,
      });
      done(true);
      return;
    }
    case '/api/queue/update': {
      const parsed = queueUpdateSchema.safeParse(body);
      if (!parsed.success) {
        json(res, { error: 'invalid patch', detail: parsed.error.issues }, 400);
        return;
      }
      const { id: target, ...patch } = parsed.data;
      done(hub.queue.update(target, patch));
      return;
    }
    case '/api/queue/remove':
      done(id !== '' && hub.queue.remove(id));
      return;
    case '/api/queue/move': {
      const to = typeof fields.to === 'number' ? fields.to : Number.NaN;
      if (!Number.isFinite(to)) {
        json(res, { error: 'move needs a numeric to' }, 400);
        return;
      }
      done(id !== '' && hub.queue.move(id, to));
      return;
    }
    // These two answer with the entry they removed as well as the new list: the
    // caller asked for a turn, not for a deletion, and a `pop` that does not
    // hand back what was popped cannot be undone by the operator who ran it.
    case '/api/queue/shift':
    case '/api/queue/pop': {
      const taken = pathname.endsWith('pop') ? hub.queue.pop() : hub.queue.shift();
      const viewers = hub.publishQueue();
      const payload: QueueResponse = { queue: hub.queue.list(), viewers, entry: taken };
      json(res, payload);
      return;
    }
    case '/api/queue/clear':
      hub.queue.clear();
      done(true);
      return;
    // Not routed through `done`: a rewind that cuts the line on air has to send
    // the interrupt and the new list in one frame, which is `Hub.rewind`, and
    // publishing a second time here would deliver the list twice.
    case '/api/queue/rewind': {
      const parsed = queueRewindSchema.safeParse(body);
      if (!parsed.success) {
        json(res, { error: 'invalid rewind', detail: parsed.error.issues }, 400);
        return;
      }
      const added = hub.rewind(parsed.data.id, parsed.data.mode, {
        interrupt: parsed.data.interrupt ?? false,
      });
      const payload: QueueResponse = { queue: hub.queue.list(), viewers: hub.viewers };
      if (added === null) {
        json(res, { ...payload, error: 'no such entry' }, 404);
        return;
      }
      json(res, payload);
      return;
    }
    default:
      json(res, { error: 'unknown endpoint' }, 404);
  }
}

/** SSE down-channel. One per open viewer. */
function stream(res: ServerResponse, hub: Hub, rendererId?: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  // The browser navigated away or was reloaded mid-transfer. Routine during
  // development, and one stack trace per reload hides anything that actually
  // went wrong.
  res.on('error', () => {});
  res.write(': connected\n\n');
  const unsubscribe = hub.subscribe((message) => {
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  }, rendererId);
  const ping = setInterval(() => {
    res.write(': ping\n\n');
  }, SSE_PING_SECONDS * 1000);
  res.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

function report(res: ServerResponse, hub: Hub, body: unknown): void {
  // Validated rather than trusted: the snapshot this feeds is what an
  // orchestrator branches on, and a state that does not match the schema would
  // be served back as if it did.
  const parsed = reportBodySchema.safeParse(body);
  if (!parsed.success) {
    json(res, { error: 'invalid report', detail: parsed.error.issues }, 400);
    return;
  }
  json(res, { ok: true, seq: hub.report(parsed.data) });
}

async function command(
  res: ServerResponse,
  hub: Hub,
  body: unknown,
  params: URLSearchParams,
): Promise<void> {
  const parsed = commandRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json(res, { error: 'no command', detail: parsed.error.issues }, 400);
  }
  const commands: StampedCommand[] = parsed.data.map(stamp);

  const delivered = hub.send({ type: 'command', commands: commands.map((c) => c.command) });
  const result: CommandResponse = {
    ok: delivered > 0,
    viewers: delivered,
    ids: commands.map((c) => c.id),
  };
  if (delivered === 0) {
    result.error = 'no viewer connected';
    return json(res, result, 503);
  }

  const wait = params.get('wait');
  if (wait) {
    // Resolve when the last queued turn has ended. Anything that is not a turn
    // completes on arrival, so only "say" is worth waiting on.
    const last = commands.filter((c) => c.command.cmd === 'say').at(-1);
    if (last) {
      const { snapshot, completed } = await hub.waitFor(
        (snap) => snap.events.some((e) => e.type === 'turn.end' && e.turn === last.id),
        waitSeconds(wait, COMMAND_WAIT_SECONDS) * 1000,
      );
      result.completed = completed;
      result.state = snapshot.state;
    }
  }
  return json(res, result);
}

/** Stamp an id so the caller can correlate the turn events that come back. */
function stamp(command: Command): StampedCommand {
  stampCounter = (stampCounter + 1) % 9973;
  const generated = `c${Date.now() % 1_000_000_000}-${stampCounter}`;
  if (isPayloadIdCommand(command)) return { command, id: generated };
  const id = command.id ?? generated;
  return { command: { ...command, id }, id };
}

async function events(res: ServerResponse, hub: Hub, params: URLSearchParams): Promise<void> {
  const since = toInt(params.get('since')) ?? 0;
  const wait = params.get('wait');
  const snapshot = wait
    ? (await hub.waitFor((s) => s.seq > since, waitSeconds(wait, EVENTS_WAIT_SECONDS) * 1000))
        .snapshot
    : hub.snapshot();
  const body: EventsResponse = {
    seq: snapshot.seq,
    events: snapshot.events.filter((event) => (event.seq ?? 0) > since),
  };
  return json(res, body);
}
