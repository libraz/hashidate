import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hub } from '@/server/hub';
import { Recordings } from '@/server/recordings';
import { handleApi } from '@/server/routes';
import { Scripts } from '@/server/scripts';

/**
 * Running a script from a page part-way through it, over real HTTP: what the
 * roster says each page starts at, and what a run from one of those puts on the
 * queue.
 */

const TALK = `
setup:
  - { cmd: deck, id: talk }
lines:
  - { text: 表紙, stage: { camera: bust } }
  - { text: 二枚目, stage: { slide: 2 } }
  - { text: 三枚目, stage: { slide: 3, camera: upper } }
  - { text: おわり }
`;

let server: Server | null = null;
let root: string;
let hub: Hub;
let base: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-from-'));
  await writeFile(join(root, 'talk.yaml'), TALK);
  hub = new Hub(null, null, null, new Recordings(join(root, 'takes')));
  const stores = { scripts: new Scripts(root) };
  server = createServer((req, res) => {
    if (handleApi(req, res, hub, stores)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  hub.dispose();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  await rm(root, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('a script run from a page', () => {
  it('lists where each page starts', async () => {
    const res = await fetch(`${base}/api/scripts`);
    const { scripts } = (await res.json()) as { scripts: Array<{ pages: unknown }> };
    expect(scripts[0]?.pages).toEqual([
      { line: 0, deck: 'talk', page: 1 },
      { line: 1, deck: 'talk', page: 2 },
      { line: 2, deck: 'talk', page: 3 },
    ]);
  });

  it('queues from that line on, staged as the run would have left it', async () => {
    const result = await post('/api/scripts/run', { id: 'talk', from: 1 });
    expect(result.status).toBe(200);
    const queued = hub.queue.list();
    expect(queued.map((entry) => entry.text)).toEqual(['二枚目', '三枚目', 'おわり']);
    expect(queued[0]?.stage).toEqual({ camera: 'bust', slide: 2 });
    expect(queued[1]?.stage).toEqual({ slide: 3, camera: 'upper' });
    expect(queued.every((entry) => entry.source === 'talk')).toBe(true);
  });

  it('queues the whole script when no line is given', async () => {
    await post('/api/scripts/run', { id: 'talk' });
    expect(hub.queue.list()).toHaveLength(4);
  });

  it('refuses a line past the end, and queues nothing', async () => {
    const result = await post('/api/scripts/run', { id: 'talk', from: 4 });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'the script has 4 lines' });
    expect(hub.queue.list()).toEqual([]);
  });
});
