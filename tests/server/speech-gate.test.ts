import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechState } from '@/protocol';
import { Hub } from '@/server/hub';
import { Recordings } from '@/server/recordings';
import { handleApi, type Stores } from '@/server/routes';
import { Scripts } from '@/server/scripts';
import { forgetTakes } from '@/server/speech';
import { askSidecar } from '@/speech/sidecar';

/**
 * Playback is refused while the voice cannot be heard, and only then.
 *
 * Over real HTTP, because the part under test is the status and body a caller
 * sees. The sidecar's state is a stub the test moves by hand.
 */

vi.mock('@/speech/sidecar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/speech/sidecar')>()),
  askSidecar: vi.fn(),
}));

const LOADING = 'speech sidecar is loading its model; playback cannot start until it is ready';
const DOWN = 'speech sidecar is not answering; playback cannot start until it is back';

let server: Server | null = null;
let root: string;
let speech: { current: SpeechState };
let hub: Hub;
let base: string;

async function listen(stores: Stores): Promise<string> {
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
  return `http://127.0.0.1:${address.port}`;
}

/** The fields these tests read off a reply; anything else is left unread. */
type Reply = { error?: string; queue: Array<{ id: string }> } & Record<string, unknown>;

async function post(path: string, body: unknown): Promise<{ status: number; body: Reply }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Reply };
}

const command = (...commands: unknown[]) => post('/api/command', { batch: commands });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-gate-'));
  await writeFile(join(root, 'demo.yaml'), 'lines: [{ text: あ }, { text: い }]');
  speech = { current: 'loading' };
  hub = new Hub(null, speech, null, new Recordings(join(root, 'takes')));
  base = await listen({ scripts: new Scripts(root) });
  forgetTakes();
  vi.mocked(askSidecar).mockReset();
});

afterEach(async () => {
  hub.dispose();
  await hub.closeRecording();
  const closing = server;
  server = null;
  await new Promise<void>((resolve) => (closing ? closing.close(() => resolve()) : resolve()));
  await rm(root, { recursive: true, force: true });
});

describe('releasing the hold', () => {
  it('is refused while the model loads, with an error and nothing else', async () => {
    await command({ cmd: 'pause', on: true });

    const result = await command({ cmd: 'pause', on: false });

    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: LOADING });
    expect(hub.snapshot().paused).toBe(true);
  });

  it('is refused when the sidecar has stopped answering', async () => {
    speech.current = 'down';
    await command({ cmd: 'pause', on: true });

    const result = await command({ cmd: 'say', text: 'あ' }, { cmd: 'pause', on: false });

    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: DOWN });
    expect(hub.snapshot().paused).toBe(true);
    expect(hub.queue.list()).toHaveLength(0);
  });

  it('is allowed when the same batch holds again at the end', async () => {
    const result = await command({ cmd: 'pause', on: false }, { cmd: 'pause', on: true });
    expect(result.status).toBe(200);
  });

  it('is allowed when nothing is wrong with the voice', async () => {
    for (const state of ['absent', 'ready'] as const) {
      speech.current = state;
      await command({ cmd: 'pause', on: true });
      expect((await command({ cmd: 'pause', on: false })).status).toBe(200);
    }
  });
});

describe('adding to a queue that is not moving', () => {
  it('refuses a say, a queue and every add route when idle and unheld', async () => {
    for (const [path, body] of [
      ['/api/command', { cmd: 'say', text: 'あ' }],
      ['/api/command', { cmd: 'queue', turns: [{ text: 'あ' }] }],
      ['/api/queue', { turns: [{ text: 'あ' }] }],
      ['/api/queue/push', { turn: { text: 'あ' } }],
      ['/api/queue/unshift', { turn: { text: 'あ' } }],
    ] as const) {
      const result = await post(path, body);
      expect.soft(result.status, path).toBe(409);
      expect.soft(result.body.error, path).toBe(LOADING);
      expect.soft(result.body, path).not.toHaveProperty('fates');
    }
    expect(hub.queue.list()).toHaveLength(0);
  });

  it('answers a queue refusal in the shape of a queue outcome', async () => {
    const result = await post('/api/queue', { turns: [{ text: 'あ' }] });
    expect(result.body).toEqual({ queue: [], viewers: 0, error: LOADING });
  });

  it('refuses a rewind that would start an unheld queue', async () => {
    speech.current = 'ready';
    const added = await post('/api/queue', { turns: [{ text: 'あ' }] });
    const id = added.body.queue[0].id;
    hub.queue.start(id);
    hub.queue.complete(id, {});
    speech.current = 'loading';

    const result = await post('/api/queue/rewind', { id, mode: 'one' });

    expect(result.status).toBe(409);
    expect(result.body.error).toBe(LOADING);
    expect(hub.queue.list()).toHaveLength(0);
  });

  it('accepts the same adds while held', async () => {
    await command({ cmd: 'pause', on: true });

    expect((await post('/api/queue', { turns: [{ text: 'あ' }] })).status).toBe(200);
    expect((await command({ cmd: 'say', text: 'い' })).status).toBe(200);
    expect(hub.queue.list()).toHaveLength(2);
  });

  it('accepts an add while the queue is already moving', async () => {
    speech.current = 'ready';
    await post('/api/queue', { turns: [{ text: 'あ' }] });
    speech.current = 'down';

    expect((await post('/api/queue', { turns: [{ text: 'い' }] })).status).toBe(200);
    expect(hub.queue.list()).toHaveLength(2);
  });

  it('accepts everything when the sidecar is absent or ready', async () => {
    for (const state of ['absent', 'ready'] as const) {
      speech.current = state;
      expect((await command({ cmd: 'say', text: 'あ' })).status).toBe(200);
      hub.queue.clear();
    }
  });
});

describe('running a script', () => {
  it('is refused when it would play, leaving the queue as it was', async () => {
    const result = await post('/api/scripts/run', { id: 'demo', pause: false });

    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: LOADING });
    expect(hub.queue.list()).toHaveLength(0);
  });

  it('loads held, which is the default', async () => {
    const result = await post('/api/scripts/run', { id: 'demo' });

    expect(result.status).toBe(200);
    expect(hub.queue.list()).toHaveLength(2);
    expect(hub.snapshot().paused).toBe(true);
  });
});

describe('starting a recording', () => {
  const START = { width: 640, height: 360, fps: 30, release: true };

  it('is refused when it would release the hold', async () => {
    await command({ cmd: 'pause', on: true });

    const result = await post('/api/record/start', START);

    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: LOADING, recording: null });
    expect(hub.recording).toBeNull();
  });

  it('starts when it releases nothing', async () => {
    expect((await post('/api/record/start', { ...START, release: false })).status).toBe(200);
  });
});

describe('the speech proxy', () => {
  it('answers 503 when the sidecar is still loading, not 502', async () => {
    vi.mocked(askSidecar).mockResolvedValue({
      status: 503,
      contentType: 'application/json',
      body: Buffer.from('{"error":"loading"}'),
    });

    const result = await post('/api/speech', { text: 'あ' });

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'speech sidecar is loading its model' });
  });

  it('keeps any other failure at 502', async () => {
    vi.mocked(askSidecar).mockResolvedValue({
      status: 500,
      contentType: 'application/json',
      body: Buffer.from('{}'),
    });

    expect((await post('/api/speech', { text: 'い' })).status).toBe(502);
  });
});
