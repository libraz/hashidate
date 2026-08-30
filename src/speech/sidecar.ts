import { request } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the speech sidecar is, and how this side reaches it.
 *
 * Named once here because three processes have to agree on the answer without
 * being told it: the control server proxies to the sidecar, the Electron shell
 * starts one and probes it, and `tools/tts/server.py` binds it. Two of those
 * are started independently — `make dev` and `make tts` are separate commands —
 * so the default has to be something each of them can work out alone.
 *
 * **A UNIX socket rather than a port, and that is the licence condition again.**
 * Nothing outside this machine's own control server ever calls the synthesiser:
 * the renderer asks its own origin and is proxied, deliberately, so the voice
 * has no second caller to be reachable for. A loopback port is reachable by
 * every process and every user on the machine; a socket in a directory this
 * process owns is reachable by this user alone. The voice is cloned from
 * recordings of a real person and the reference material is not ours to publish
 * in any form, which makes the stronger of the two enforcements the right one.
 *
 * The port is kept as an override rather than removed, because it is what a
 * different synthesiser is stood up behind. Anything answering `POST /speak`
 * and `GET /health` can take this one's place, and something written to be a
 * local HTTP service will bind a port; `HASHIDATE_TTS_PORT` points this side at
 * it without either end learning about the other's transport.
 */
export type SpeechEndpoint =
  | { readonly kind: 'socket'; readonly path: string }
  | { readonly kind: 'port'; readonly port: number };

/** Where `HASHIDATE_TTS_PORT` starts from when it is set to nothing useful. */
export const DEFAULT_TTS_PORT = 8770;

/**
 * The socket, and the directory that is the actual permission boundary.
 *
 * The mode on a socket file is honoured on this platform, but the directory is
 * what makes that irrelevant: `0700` on it means no other user can reach the
 * path at all, whatever the socket inside says. It is created by the sidecar,
 * which is the only process that binds — see `tools/tts/server.py`.
 *
 * Beside the sidecar rather than in a temporary directory, so that two
 * checkouts running at once get two sockets without anybody arranging it. That
 * is the failure the control server needs a whole probe for (see
 * `ControlProbe`), and it is worth not having twice.
 */
export const SOCKET_DIR = '.run';
export const SOCKET_NAME = 'speech.sock';

/**
 * The socket path for this checkout, resolved from this file rather than from
 * the working directory: the control server, the shell and the sidecar are
 * started from three different places and have to arrive at one path.
 */
export function defaultSocketPath(sourceFile = fileURLToPath(import.meta.url)): string {
  const root = resolve(dirname(sourceFile), '../..');
  return resolve(root, 'tools/tts', SOCKET_DIR, SOCKET_NAME);
}

/** A port, or null for anything that is not one. Loopback is the only host. */
function portOf(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  if (!/^\d+$/.test(value)) return null;
  const significant = value.replace(/^0+/, '') || '0';
  if (significant.length > 5) return null;
  const port = Number(significant);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

/**
 * Which sidecar this process talks to.
 *
 * The socket wins when it is named, because naming it is the more specific act;
 * a port is the fallback for a stand-in synthesiser, and the default is the
 * socket beside the sidecar. `HASHIDATE_TTS_PORT` set to something that is not
 * a port is treated as not set rather than as a request for :8770 — a typo
 * there would otherwise silently point the voice at a port nobody is on.
 */
export function speechEndpoint(env: NodeJS.ProcessEnv = process.env): SpeechEndpoint {
  const socket = env.HASHIDATE_TTS_SOCKET;
  if (socket !== undefined && socket !== '') return { kind: 'socket', path: resolve(socket) };
  const port = portOf(env.HASHIDATE_TTS_PORT);
  if (port !== null) return { kind: 'port', port };
  return { kind: 'socket', path: defaultSocketPath() };
}

/** The endpoint as an operator reads it, in a banner or a warning. */
export function describeEndpoint(endpoint: SpeechEndpoint): string {
  return endpoint.kind === 'socket' ? endpoint.path : `http://127.0.0.1:${endpoint.port}`;
}

/** What the sidecar said. Anything below this is transport and rejects. */
export interface SidecarReply {
  status: number;
  contentType: string;
  body: Buffer;
}

export interface SidecarAsk {
  method?: 'GET' | 'POST';
  /** A JSON body, already serialised. Absent for a GET. */
  body?: string;
  timeoutMs: number;
}

/**
 * One round trip to the sidecar, over whichever transport it is on.
 *
 * `node:http` rather than `fetch`, because a socket is not something a URL can
 * name: the two cases differ by one field of the options object and nothing
 * else, which is the whole reason the transport can be a setting at all.
 *
 * The body is read whole rather than streamed. A take is one utterance — a few
 * hundred kilobytes, capped by the model's own thirty-second ceiling — and the
 * layer above holds it anyway so that every renderer asking for the same line
 * gets the same bytes. See `TAKE_TTL_MS`.
 */
export function askSidecar(
  endpoint: SpeechEndpoint,
  path: string,
  ask: SidecarAsk,
): Promise<SidecarReply> {
  const target =
    endpoint.kind === 'socket'
      ? { socketPath: endpoint.path }
      : { host: '127.0.0.1', port: endpoint.port };
  const payload = ask.body === undefined ? null : Buffer.from(ask.body, 'utf8');

  return new Promise((settle, fail) => {
    const req = request(
      {
        ...target,
        path,
        method: ask.method ?? 'GET',
        headers:
          payload === null
            ? {}
            : { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) },
        signal: AbortSignal.timeout(ask.timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          settle({
            status: res.statusCode ?? 0,
            contentType: res.headers['content-type'] ?? 'application/octet-stream',
            body: Buffer.concat(chunks),
          });
        });
        // A connection cut mid-answer is a failure of the round trip and not a
        // short reply: half a WAV plays as a click and then silence.
        res.on('error', fail);
      },
    );
    req.on('error', fail);
    if (payload !== null) req.write(payload);
    req.end();
  });
}
