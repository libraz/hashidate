import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlClient } from '@/control/client';
import { Hub } from '@/server/hub';
import { handleApi } from '@/server/routes';

let server: Server | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (server === null) return;
  const closing = server;
  server = null;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

async function listen(hub = new Hub()): Promise<string> {
  server = createServer((req, res) => {
    if (handleApi(req, res, hub)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}/api`;
}

describe('ControlClient command responses', () => {
  it('preserves a real HTTP 503 command response for callers to classify', async () => {
    const client = new ControlClient(await listen());

    const result = await client.command({ cmd: 'gesture', id: 'wave' });

    expect(result).toMatchObject({
      ok: false,
      viewers: 0,
      fates: ['lost'],
      error: 'no viewer connected',
    });
  });

  it('answers ok for a setting the server keeps for a renderer that attaches later', async () => {
    const client = new ControlClient(await listen());

    const result = await client.command({
      batch: [
        { cmd: 'pause', on: true },
        { cmd: 'say', text: 'あ' },
      ],
    });

    expect(result).toMatchObject({ ok: true, viewers: 0, fates: ['retained', 'retained'] });
    expect(result).not.toHaveProperty('error');
  });

  it('preserves a real HTTP 400 command body', async () => {
    const client = new ControlClient(await listen());

    const result = await client.command({ batch: [] });

    expect(result).toMatchObject({ error: 'no command' });
  });

  it('keeps the queue 404 outcome parseable with its current queue', async () => {
    const client = new ControlClient(await listen());

    const result = await client.queueRemove('already-said');

    expect(result).toMatchObject({ queue: [], viewers: 0, error: 'no such entry' });
  });
});

describe('command wait timeout', () => {
  it.each([
    [undefined, 180_000],
    ['1', 150_000],
    ['true', 150_000],
    ['300', 330_000],
    ['0', 150_000],
  ])('uses the server wait semantics for %s', async (wait, expected) => {
    let timeout = -1;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      timeout = milliseconds;
      return new AbortController().signal;
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const client = new ControlClient('http://127.0.0.1:1/api');

    await client.command({ cmd: 'pause', on: true }, wait);

    expect(timeout).toBe(expected);
  });
});
