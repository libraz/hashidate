import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { refuseForeign } from '@/server/guard';
import { Hub } from '@/server/hub';
import { handleApi } from '@/server/routes';

/**
 * The loopback check in front of every route: a page in the operator's own
 * browser, from another origin or through a rebound hostname, must not be able
 * to drive the broadcast or read a licensed asset.
 */

let server: Server | null = null;

afterEach(async () => {
  const closing = server;
  server = null;
  if (closing !== null) await new Promise<void>((resolve) => closing.close(() => resolve()));
});

/** The server's own callback order: the guard, the API, then files. */
async function listen(hub: Hub): Promise<{ port: number; served: string[] }> {
  const served: string[] = [];
  server = createServer((req, res) => {
    if (refuseForeign(req, res)) return;
    if (handleApi(req, res, hub)) return;
    served.push(req.url ?? '');
    res.writeHead(200);
    res.end('model bytes');
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return { port: address.port, served };
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
}

/** A request with exactly the headers a browser or a rebinding page would send. */
function send(
  port: number,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'text/plain' }) },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
        res.destroy();
      },
    );
    req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const CAMERA = { cmd: 'camera', frame: 'full' };

describe('the loopback guard', () => {
  it('refuses a rebound hostname on every kind of route, before any state changes', async () => {
    const hub = new Hub();
    const { port, served } = await listen(hub);
    const host = { Host: `attacker.example:${port}` };

    for (const answer of [
      await send(port, '/api/command', host, CAMERA),
      await send(port, '/api/state', host),
      await send(port, '/models/avatar.glb', host),
    ]) {
      expect(answer.status).toBe(403);
      expect(answer.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(served).toEqual([]);
    expect(hub.command([]).viewers).toBe(0);
    expect(hub.snapshot().events).toEqual([]);
  });

  it('refuses a page from another origin, including another loopback port', async () => {
    const hub = new Hub();
    const { port } = await listen(hub);
    const seen: unknown[] = [];
    hub.subscribe((message) => seen.push(...message.commands));
    seen.length = 0;

    for (const origin of ['http://attacker.example', `http://localhost:${port + 1}`, 'null']) {
      const answer = await send(
        port,
        '/api/command',
        { Host: `127.0.0.1:${port}`, Origin: origin },
        CAMERA,
      );
      expect(answer.status).toBe(403);
    }
    // A no-cors request carries no Origin, and says where it came from instead.
    const stream = await send(port, '/api/stream', {
      Host: `127.0.0.1:${port}`,
      'Sec-Fetch-Site': 'cross-site',
    });
    expect(stream.status).toBe(403);
    expect(seen).toEqual([]);
    expect(hub.viewers).toBe(1);
  });

  it('serves a local caller with no Origin, and a page whose origin is the host it asked', async () => {
    const { port, served } = await listen(new Hub());

    expect((await send(port, '/api/command', { Host: `127.0.0.1:${port}` }, CAMERA)).status).toBe(
      200,
    );
    expect(
      (
        await send(
          port,
          '/api/command',
          { Host: `localhost:${port}`, Origin: `http://localhost:${port}` },
          CAMERA,
        )
      ).status,
    ).toBe(200);
    // The dev server forwards the browser's own Host and Origin.
    expect(
      (
        await send(port, '/models/avatar.glb', {
          Host: 'localhost:5173',
          Origin: 'http://localhost:5173',
          'Sec-Fetch-Site': 'same-origin',
        })
      ).status,
    ).toBe(200);
    expect(served).toEqual(['/models/avatar.glb']);
  });
});
