import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlClient, ControlError } from '@/control/client';

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  const closing = server;
  server = undefined;
  closing.closeAllConnections();
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

async function listen(reply: (res: ServerResponse) => void): Promise<string> {
  server = createServer((_req, res) => reply(res));
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}/api`;
}

describe('ControlClient response body transport errors', () => {
  it('wraps a connection lost after the response headers in ControlError', async () => {
    const base = await listen((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"ok":');
      const timer = setTimeout(() => res.destroy(), 50);
      res.once('close', () => clearTimeout(timer));
    });
    const client = new ControlClient(base);

    const error = await client.request('/state').catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ControlError);
    expect(error).toHaveProperty('message', expect.stringContaining(base));
  });

  it('wraps a timeout while receiving the response body in ControlError', async () => {
    const base = await listen((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"ok":');
    });
    const client = new ControlClient(base);

    const error = await client
      .request('/state', undefined, 100)
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ControlError);
    expect(error).toHaveProperty('message', expect.stringContaining(base));
  });

  it.each([200, 503])('preserves a complete non-JSON HTTP %s response', async (status) => {
    const base = await listen((res) => {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end('unavailable');
    });

    const result = await new ControlClient(base).request('/state');

    expect(result).toEqual(status === 200 ? {} : { error: 'HTTP 503', body: 'unavailable' });
  });
});
