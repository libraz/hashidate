import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Command,
  type CommandName,
  type CommandResponse,
  type EventsResponse,
  parseCommand,
  reportBodySchema,
} from '../protocol';
import type { Hub } from './hub';

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
 * Endpoints that are traffic rather than events: the SSE stream sits open, and
 * the report is a heartbeat every 700 ms. Logging them buries the commands,
 * which are the only lines worth reading.
 */
const QUIET = ['/api/stream', '/api/report'];

/**
 * The three commands that spend `id` on their own payload id rather than on a
 * correlation id. Stamping one of those would change which expression is shown,
 * which effect is raised, which gesture is played — so their correlation id is
 * reported back to the caller and never written onto the command.
 */
const PAYLOAD_ID_COMMANDS = new Set<CommandName>(['expression', 'overlay', 'gesture']);

interface StampedCommand {
  command: Command;
  id: string;
}

let stampCounter = 0;

/**
 * Route one request, or decline it.
 *
 * Returns false for anything outside `/api/`, which the caller then serves off
 * disk. Work that has to read a body or wait for the viewer continues after the
 * return — the boolean is about ownership, not about completion.
 */
export function handleApi(req: IncomingMessage, res: ServerResponse, hub: Hub): boolean {
  const { pathname, params } = split(req.url ?? '/');
  if (!pathname.startsWith('/api/')) return false;
  logRequest(req, res, pathname);
  if (req.method === 'GET' || req.method === 'HEAD') {
    get(res, hub, pathname, params);
    return true;
  }
  if (req.method === 'POST') {
    void post(req, res, hub, pathname, params);
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

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * Read a JSON body. `null` means the body was there and was not JSON; an empty
 * body is an empty object, which is what a bare POST means.
 */
async function readBody(req: IncomingMessage): Promise<{ value: unknown } | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
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

function get(res: ServerResponse, hub: Hub, pathname: string, params: URLSearchParams): void {
  switch (pathname) {
    case '/api/stream':
      stream(res, hub);
      return;
    case '/api/state':
      json(res, hub.snapshot(toInt(params.get('since'))));
      return;
    case '/api/vocabulary':
      json(res, hub.snapshot().vocabulary);
      return;
    case '/api/events':
      void events(res, hub, params);
      return;
    default:
      json(res, { error: 'unknown endpoint' }, 404);
  }
}

async function post(
  req: IncomingMessage,
  res: ServerResponse,
  hub: Hub,
  pathname: string,
  params: URLSearchParams,
): Promise<void> {
  const body = await readBody(req);
  if (body === null) return json(res, { error: 'invalid json' }, 400);
  if (pathname === '/api/command') return command(res, hub, body.value, params);
  if (pathname === '/api/report') return report(res, hub, body.value);
  return json(res, { error: 'unknown endpoint' }, 404);
}

/** SSE down-channel. One per open viewer. */
function stream(res: ServerResponse, hub: Hub): void {
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
  });
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
  const commands: StampedCommand[] = [];
  for (const candidate of batch(body)) {
    // A command this server does not understand is dropped rather than failing
    // the request: the caller and the renderer have separate release cycles,
    // and the rest of the batch is still deliverable.
    const parsed = parseCommand(candidate);
    if (parsed) commands.push(stamp(parsed));
  }
  if (commands.length === 0) return json(res, { error: 'no command' }, 400);

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

/** One command, or several under `batch` to be delivered together. */
function batch(body: unknown): unknown[] {
  if (typeof body !== 'object' || body === null) return [];
  const inner = (body as { batch?: unknown }).batch;
  return Array.isArray(inner) ? inner : [body];
}

/** Stamp an id so the caller can correlate the turn events that come back. */
function stamp(command: Command): StampedCommand {
  stampCounter = (stampCounter + 1) % 9973;
  const generated = `c${Date.now() % 1_000_000_000}-${stampCounter}`;
  if (PAYLOAD_ID_COMMANDS.has(command.cmd)) return { command, id: generated };
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
