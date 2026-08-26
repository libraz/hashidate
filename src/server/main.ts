import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Hub } from './hub';
import { handleApi } from './routes';
import { serveStatic } from './static';

/**
 * Local control API for the AITuber runtime.
 *
 * Serves the viewer and carries commands to it, so an orchestrator running in
 * another process can drive the avatar.
 *
 *     orchestrator  ──POST /api/command──►  this server  ──SSE──►  viewer
 *                   ◄──GET  /api/state───                ◄─POST──
 *
 * Commands go down over Server-Sent Events; the viewer posts its state and its
 * turn events back up. SSE rather than WebSocket because it needs no dependency
 * and no handshake, and the traffic is one-directional by nature: a few commands
 * a second down, a state snapshot a second up.
 *
 * **Binds to 127.0.0.1 only, and that is a licence condition, not a default.**
 * The avatar may not be published; see 02-license.md. There is deliberately no
 * CORS header either — the viewer is same-origin, so allowing another origin
 * would only ever serve a page that is not ours.
 *
 * usage: yarn start [--port 8765] [--root dist]
 */

const BIND = '127.0.0.1'; // do not change; see the module docstring
const DEFAULT_PORT = 8765;
const DEFAULT_ROOT = 'dist';

function main(): void {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      root: { type: 'string' },
    },
  });

  const port = values.port === undefined ? DEFAULT_PORT : Number.parseInt(values.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--port takes an integer between 1 and 65535: ${values.port}`);
    process.exit(2);
  }
  const root = resolve(values.root ?? DEFAULT_ROOT);

  const hub = new Hub();
  const server = createServer((req, res) => {
    if (handleApi(req, res, hub)) return;
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, root);
      return;
    }
    // Anything that is not a file read is an API call that named the wrong
    // path, so it is answered in the API's own terms rather than as a file.
    const body = Buffer.from(JSON.stringify({ error: 'unknown endpoint' }), 'utf8');
    res.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });

  // A half-written request from a browser that was closed mid-reload is
  // routine, and the default handling logs a stack trace for each one.
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('error', (error) => {
    console.error(String(error));
    process.exit(1);
  });

  server.listen(port, BIND, () => {
    console.log(`viewer   http://${BIND}:${port}/`);
    console.log(`control  http://${BIND}:${port}/api/`);
  });
}

main();
