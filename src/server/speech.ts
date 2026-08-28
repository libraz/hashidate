import type { ServerResponse } from 'node:http';
import type { SpeechState } from '../protocol';

/**
 * The speech sidecar, reached from the browser through this server.
 *
 * The renderer needs audio and the synthesiser is a Python process on another
 * port. The viewer could in principle call it directly; it must not, and the
 * reason is the same one that governs everything else here. `tools/tts/` binds
 * loopback and sends no CORS header, because the voice is cloned from
 * recordings of a real person — so a browser page served from this origin
 * cannot reach that one, and the only ways to make it work would be to add a
 * CORS header to the sidecar or to move the voice off loopback. Both are
 * licensing decisions and neither is available.
 *
 * Proxying is the third way and it costs nothing: the viewer asks its own
 * origin, this server asks the sidecar, and nothing about either binding
 * changes. It also puts the sidecar's absence in one place — a machine without
 * the voice, which is most of them, gets a clean 503 rather than a page of
 * console errors.
 *
 *     viewer ──POST /api/speech──► this ──POST /speak──► tools/tts
 *            ◄─────── wav ────────      ◄───── wav ─────
 *
 * Being in the middle is also what makes it the only place that can see the
 * same line asked for by every renderer at once, which it answers once. See
 * `TAKE_TTL_MS` — that is about the mouth staying in step, not about speed.
 */

/**
 * Where the sidecar listens. Matches `DEFAULT_PORT` in `tools/tts/server.py`;
 * the environment variable is for running a second one beside it while
 * comparing voices.
 */
export const SIDECAR = `http://127.0.0.1:${process.env.HASHIDATE_TTS_PORT ?? 8770}`;

/**
 * Long enough for the slowest line the model will accept.
 *
 * Synthesis is roughly a second for a normal line and scales with length; the
 * model's own ceiling is thirty seconds of output. Half a minute of wall clock
 * is well past anything healthy, which is what a timeout is for — the session
 * has given up and started speaking silently long before this fires.
 */
const TIMEOUT_MS = 30_000;

/**
 * How long a take stays worth handing back, and how much of them to hold.
 *
 * **This is not a cache for speed, it is one for keeping renderers in step.**
 * Every viewer asks for every line — a muted one included, deliberately, so
 * that its mouth runs on the same clock as the one on air — and the sidecar
 * serialises the GPU under a lock. Three renderers is three synthesis passes
 * of the same sentence, one after another, and the third of them starts a
 * couple of seconds after the first: whichever renderer is served last has
 * already given up waiting and fallen back to the text estimate, which is the
 * "the mouth moved and nothing was said" failure with no fault anywhere to
 * find. Answered from here, the second and third renderer get the take the
 * first one waited for, and they get the *same* one — the model samples, so
 * two passes over one sentence are two different lengths, and identical audio
 * is what the muted preview was always supposed to be showing.
 *
 * Two minutes rather than the length of a broadcast, and a few takes rather
 * than all of them: what has to be caught is the same line asked for by every
 * renderer at once, and a line put back by a rewind a moment later. Anything
 * older is a line being said a second time on purpose, and the whole file
 * refuses to cache on the same grounds everywhere else does — see
 * `serveStatic`, which will not let a browser hold anything at all.
 */
export const TAKE_TTL_MS = 120_000;
export const TAKE_MAX = 16;
export const TAKE_MAX_BYTES = 32 * 1024 * 1024;

/** What the viewer asks for: a line, and how to pronounce it if that is known. */
export interface SpeechRequest {
  text: string;
  reading?: string;
}

/**
 * One answer to one line, held so that it can be given more than once.
 *
 * Errors are takes too, because a sidecar that is not running answers every
 * renderer the same way and there is no reason for three of them to each find
 * that out with their own round trip. They are shared while in flight and
 * never kept afterwards: the sidecar coming up between one line and the next
 * is the ordinary case on a machine where the model is still loading.
 */
export interface Take {
  status: number;
  contentType: string;
  body: Buffer;
  /** Whether this is audio. False for the JSON refusals below. */
  ok: boolean;
}

interface HeldTake {
  take: Take;
  at: number;
}

const inFlight = new Map<string, Promise<Take>>();
const held = new Map<string, HeldTake>();
let heldBytes = 0;

/**
 * What the sidecar is actually asked for, which is what a take is worth reusing
 * against.
 *
 * The reading wins upstream, so two lines written differently that spell the
 * same pronunciation are one synthesis and not two. See `handleSpeech`.
 */
const takeKey = (request: SpeechRequest): string => request.reading ?? request.text;

/** Drop everything held. For tests, and for nothing else. */
export function forgetTakes(): void {
  inFlight.clear();
  held.clear();
  heldBytes = 0;
}

function keepTake(key: string, take: Take): void {
  if (take.body.length > TAKE_MAX_BYTES) return;
  held.set(key, { take, at: Date.now() });
  heldBytes += take.body.length;
  // Insertion order is age order, so the oldest is the first key the map hands
  // back. Both caps are enforced together: a handful of long lines can reach
  // the byte budget well before the count.
  while (held.size > TAKE_MAX || heldBytes > TAKE_MAX_BYTES) {
    const oldest = held.keys().next();
    if (oldest.done) break;
    const dropped = held.get(oldest.value);
    held.delete(oldest.value);
    if (dropped) heldBytes -= dropped.take.body.length;
  }
}

/**
 * Ask for a line, once, however many renderers want it.
 *
 * A request that arrives while an identical one is in flight waits on that one
 * rather than starting a second, which is the case this exists for: the
 * renderers are all reading the same queue and reach the same line within a
 * few hundred milliseconds of each other.
 */
export async function speak(request: SpeechRequest): Promise<Take> {
  const key = takeKey(request);

  const kept = held.get(key);
  if (kept !== undefined) {
    if (Date.now() - kept.at < TAKE_TTL_MS) return kept.take;
    held.delete(key);
    heldBytes -= kept.take.body.length;
  }

  const flying = inFlight.get(key);
  if (flying !== undefined) return flying;

  const attempt = synthesise(key)
    .then((take) => {
      if (take.ok) keepTake(key, take);
      return take;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, attempt);
  return attempt;
}

/** One round trip to the sidecar. Never rejects: a failure is a take too. */
async function synthesise(line: string): Promise<Take> {
  let upstream: Response;
  try {
    upstream = await fetch(`${SIDECAR}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: line }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Not running, or wedged. Expected rather than exceptional: the sidecar is
    // optional, and the renderer's whole point is that it works without one.
    return refusal(503, 'speech sidecar not reachable');
  }

  if (!upstream.ok) return refusal(502, `speech sidecar answered ${upstream.status}`);

  let body: Buffer;
  try {
    body = Buffer.from(await upstream.arrayBuffer());
  } catch {
    return refusal(502, 'speech sidecar cut the audio short');
  }

  // The sidecar's `X-Speech-Seconds` is deliberately not forwarded. The viewer
  // decodes the audio before it plays any of it, and the decoded buffer's own
  // duration is the length that will actually be heard — measuring it there
  // leaves one number where two could disagree.
  return {
    status: 200,
    contentType: upstream.headers.get('content-type') ?? 'audio/wav',
    body,
    ok: true,
  };
}

function refusal(status: number, error: string): Take {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify({ error }), 'utf8'),
    ok: false,
  };
}

const parse = (body: unknown): SpeechRequest | null => {
  if (typeof body !== 'object' || body === null) return null;
  const { text, reading } = body as { text?: unknown; reading?: unknown };
  if (typeof text !== 'string' || text === '') return null;
  if (reading !== undefined && typeof reading !== 'string') return null;
  return reading === undefined ? { text } : { text, reading };
};

const fail = (res: ServerResponse, status: number, error: string): void => {
  const payload = Buffer.from(JSON.stringify({ error }), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
};

/**
 * Forward one line to the sidecar and hand the audio back.
 *
 * The reading wins when there is one, for the same reason it wins at the mouth:
 * Japanese writing does not carry its own reading and the speech model has no
 * dictionary to look one up in, so a caller who spelled the pronunciation out
 * is the only source of it.
 */
export async function handleSpeech(res: ServerResponse, body: unknown): Promise<void> {
  const request = parse(body);
  if (!request) return fail(res, 400, 'speech needs a non-empty text');

  const take = await speak(request);
  // `no-store` still, and on the audio most of all. What is shared is one
  // answer between the renderers asking for it at the same moment, inside this
  // process; a browser holding onto a line would be a browser that keeps
  // saying it after the voice was retuned.
  res.writeHead(take.status, {
    'Content-Type': take.contentType,
    'Content-Length': String(take.body.length),
    'Cache-Control': 'no-store',
  });
  res.end(take.body);
}

// --- watching ---------------------------------------------------------------

/**
 * How often the sidecar is asked whether it is still there, and how long it
 * gets to answer.
 *
 * `/health` stays answerable while a line is being made — `tools/tts/server.py`
 * serialises the GPU under a lock rather than a single worker for exactly that
 * reason — so a probe that times out means gone or wedged, never busy.
 *
 * Five seconds is chosen against the operator rather than the machine. A voice
 * that dies on air is worth naming before the next line is written, and the
 * cost of asking is a loopback round trip to a port that is doing nothing.
 */
const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 2_000;

/** What the hub reads off the watch. See `SpeechWatch`. */
export interface SpeechSource {
  readonly current: SpeechState;
}

/**
 * Ask the sidecar how it is. `null` means it did not answer, for any reason.
 *
 * A reply that is not `/health`'s counts as no answer rather than as a fault of
 * its own: something else is on the port, and the one thing worth reporting
 * about that is the same thing — there is no voice here.
 */
async function ask(): Promise<'ready' | 'loading' | null> {
  try {
    const res = await fetch(`${SIDECAR}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ready?: unknown };
    // `ready` is false for the sixteen seconds the model takes to load, which
    // is a real state and not a failure: a line sent during it comes back 503.
    return body.ready === true ? 'ready' : 'loading';
  } catch {
    return null;
  }
}

const ANNOUNCE: Record<SpeechState, string> = {
  absent: `speech sidecar not running at ${SIDECAR}`,
  loading: 'speech sidecar loading its model',
  ready: `speech sidecar answering at ${SIDECAR}`,
  down: `speech sidecar stopped answering at ${SIDECAR}; lines will be mouthed in silence`,
};

/**
 * Whether the voice is up, kept current so that its absence is something the
 * server knows rather than something an operator infers from silence.
 *
 * The sidecar is optional and its being missing is the normal case, so this
 * distinguishes never-answered from stopped-answering and only the second one
 * is a warning. See `speechStateSchema` for why that difference is on the wire.
 *
 * Polled rather than inferred from `/api/speech`. A voice is checked before a
 * broadcast, which is precisely when nothing is being said — a server that only
 * learned about the sidecar by failing to reach it would stay quiet until the
 * first line went out silently, which is the one moment it is too late.
 */
export class SpeechWatch implements SpeechSource {
  private state: SpeechState = 'absent';
  /** Whether anything ever answered. What separates `absent` from `down`. */
  private seen = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  get current(): SpeechState {
    return this.state;
  }

  /**
   * Probe now, then keep probing. Settles with the first answer, which is what
   * the startup banner prints.
   *
   * The first answer is deliberately not announced: it would say "not running"
   * on every machine without a voice, every start, one line under a banner that
   * has already said so.
   */
  async start(): Promise<SpeechState> {
    this.state = await this.look();
    if (this.timer === null) {
      this.timer = setInterval(() => void this.check(), HEALTH_INTERVAL_MS);
      // Nothing here should hold the process open: a server whose last socket
      // closed is finished, and a five-second timer would keep it running.
      this.timer.unref?.();
    }
    return this.state;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One probe, folded in, announcing a change and only a change. */
  async check(): Promise<SpeechState> {
    const next = await this.look();
    if (next !== this.state) {
      this.state = next;
      const line = `${new Date().toISOString()} ${ANNOUNCE[next]}`;
      if (next === 'down') console.warn(line);
      else console.log(line);
    }
    return next;
  }

  private async look(): Promise<SpeechState> {
    const answer = await ask();
    if (answer !== null) this.seen = true;
    return answer ?? (this.seen ? 'down' : 'absent');
  }
}
