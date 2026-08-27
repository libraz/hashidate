import type { ServerResponse } from 'node:http';

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
 */

/**
 * Where the sidecar listens. Matches `DEFAULT_PORT` in `tools/tts/server.py`;
 * the environment variable is for running a second one beside it while
 * comparing voices.
 */
const SIDECAR = `http://127.0.0.1:${process.env.AITUBER_TTS_PORT ?? 8770}`;

/**
 * Long enough for the slowest line the model will accept.
 *
 * Synthesis is roughly a second for a normal line and scales with length; the
 * model's own ceiling is thirty seconds of output. Half a minute of wall clock
 * is well past anything healthy, which is what a timeout is for — the session
 * has given up and started speaking silently long before this fires.
 */
const TIMEOUT_MS = 30_000;

/** What the viewer asks for: a line, and how to pronounce it if that is known. */
export interface SpeechRequest {
  text: string;
  reading?: string;
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

  let upstream: Response;
  try {
    upstream = await fetch(`${SIDECAR}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: request.reading ?? request.text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Not running, or wedged. Expected rather than exceptional: the sidecar is
    // optional, and the renderer's whole point is that it works without one.
    return fail(res, 503, 'speech sidecar not reachable');
  }

  if (!upstream.ok) {
    return fail(res, 502, `speech sidecar answered ${upstream.status}`);
  }

  // The sidecar's `X-Speech-Seconds` is deliberately not forwarded. The viewer
  // decodes the audio before it plays any of it, and the decoded buffer's own
  // duration is the length that will actually be heard — measuring it there
  // leaves one number where two could disagree.
  const audio = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') ?? 'audio/wav',
    'Content-Length': String(audio.length),
    'Cache-Control': 'no-store',
  });
  res.end(audio);
}
