import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlClient } from '@/control/client';
import type { ReportBody } from '@/protocol';
import { Hub } from '@/server/hub';
import { handleApi } from '@/server/routes';

/**
 * A log written by a newer renderer holds events this reader has no name for.
 * Both ways to read it drop those elements and keep the rest.
 */

let server: Server | null = null;

afterEach(async () => {
  if (server === null) return;
  const closing = server;
  server = null;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

async function listen(hub: Hub): Promise<string> {
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

function seeded(): Hub {
  const hub = new Hub();
  // Past the report schema, as a renderer from a later release would be.
  hub.report({
    events: [
      { type: 'touch.tap', part: 'head', count: 1 },
      { type: 'touch.nuzzle', part: 'head' },
      { type: 'touch.tap', part: 'tail' },
      { type: 'touch.hold', part: 'hand', side: 'R', count: 1 },
    ],
  } as unknown as ReportBody);
  return hub;
}

const kept = [
  { type: 'touch.tap', part: 'head', count: 1 },
  { type: 'touch.hold', part: 'hand', side: 'R', count: 1 },
];

describe('ControlClient over a log with elements it does not know', () => {
  it('events() drops only those elements', async () => {
    const client = new ControlClient(await listen(seeded()));
    const reply = await client.events(0, 0);
    expect(reply.events).toMatchObject(kept);
    expect(reply.events).toHaveLength(2);
  });

  it('state() drops only those elements', async () => {
    const client = new ControlClient(await listen(seeded()));
    const snapshot = await client.state();
    expect(snapshot.events).toMatchObject(kept);
    expect(snapshot.events).toHaveLength(2);
  });
});
