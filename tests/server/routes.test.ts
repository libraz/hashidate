import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import {
  type ClientRequest,
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '@/server/hub';
import { Recordings } from '@/server/recordings';
import { handleApi, JSON_BODY_MAX_BYTES } from '@/server/routes';

let server: Server | null = null;
let streamRequest: ClientRequest | null = null;
let streamResponse: IncomingMessage | null = null;
let recordings: Recordings | null = null;
let recordingsRoot: string | null = null;
let eventsWriteAfterDestroy = 0;
let resolveEventsStarted: (() => void) | null = null;

afterEach(async () => {
  streamRequest?.destroy();
  streamResponse?.destroy();
  streamRequest = null;
  streamResponse = null;
  resolveEventsStarted = null;
  if (server !== null) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => {
      if (!closing.listening) {
        resolve();
        return;
      }
      closing.close(() => resolve());
    });
  }
  await recordings?.close();
  recordings = null;
  if (recordingsRoot !== null) await rm(recordingsRoot, { recursive: true, force: true });
  recordingsRoot = null;
});

async function listenApi(
  providedHub?: Hub,
): Promise<{ origin: string; hub: Hub; eventsStarted: Promise<void> }> {
  const hub = providedHub ?? new Hub();
  eventsWriteAfterDestroy = 0;
  const eventsStarted = new Promise<void>((resolve) => {
    resolveEventsStarted = resolve;
  });
  server = createServer((req, res) => {
    if (req.url?.startsWith('/api/events')) {
      const writeHead = res.writeHead.bind(res);
      const write = res.write.bind(res);
      res.writeHead = ((...args: Parameters<ServerResponse['writeHead']>) => {
        if (res.destroyed) eventsWriteAfterDestroy += 1;
        return writeHead(...args);
      }) as ServerResponse['writeHead'];
      res.write = ((...args: Parameters<ServerResponse['write']>) => {
        if (res.destroyed) eventsWriteAfterDestroy += 1;
        return write(...args);
      }) as ServerResponse['write'];
      resolveEventsStarted?.();
      resolveEventsStarted = null;
    }
    if (handleApi(req, res, hub)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return { origin: `http://127.0.0.1:${address.port}`, hub, eventsStarted };
}

async function openStream(origin: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(`${origin}/api/stream`, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`stream status ${res.statusCode ?? 'unknown'}`));
        return;
      }
      res.setEncoding('utf8');
      res.once('data', (chunk) => {
        expect(String(chunk)).toBe(': connected\n\n');
        resolve(res);
      });
    });
    req.once('error', reject);
    streamRequest = req;
    req.end();
  });
}

async function nextStreamData(res: IncomingMessage): Promise<string> {
  const [chunk] = await once(res, 'data');
  return String(chunk);
}

describe('API request lifetime', () => {
  it('survives a client abort while reading a POST and keeps existing SSE viewers', async () => {
    const { origin } = await listenApi();
    streamResponse = await openStream(origin);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const partial = request(`${origin}/api/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '64',
        },
      });
      const closed = new Promise<void>((resolve) => {
        partial.once('close', () => resolve());
      });
      partial.once('error', () => {});
      partial.write('{"state":');
      setTimeout(() => partial.destroy(), 25).unref();
      await closed;

      const state = await fetch(`${origin}/api/state`);
      expect(state.status).toBe(200);

      const delivered = nextStreamData(streamResponse);
      const command = await fetch(`${origin}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'pause', on: true }),
      });
      expect(command.status).toBe(200);
      expect(await delivered).toContain('"cmd":"pause"');
      expect(streamResponse.destroyed).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not write a delayed response after its client aborts', async () => {
    const { origin, eventsStarted } = await listenApi();
    streamResponse = await openStream(origin);

    const delayed = request(`${origin}/api/events?since=0&wait=0.1`);
    const closed = new Promise<void>((resolve) => {
      delayed.once('close', () => resolve());
    });
    delayed.once('error', () => {});
    delayed.end();
    await eventsStarted;
    delayed.destroy();
    await closed;
    // Let the bounded wait finish and exercise the successful json() path.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(eventsWriteAfterDestroy).toBe(0);

    const delivered = nextStreamData(streamResponse);
    const command = await fetch(`${origin}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'pause', on: true }),
    });
    expect(command.status).toBe(200);
    expect(await delivered).toContain('"cmd":"pause"');
    expect(streamResponse.destroyed).toBe(false);
  });
});

describe('command validation and stamping', () => {
  it('rejects an extensionless BGM track before changing server state', async () => {
    const { origin, hub } = await listenApi();
    const before = hub.snapshot().bgm;
    const response = await fetch(`${origin}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'bgm', action: 'play', track: 'opening' }),
    });

    expect(response.status).toBe(400);
    const after = hub.snapshot().bgm;
    expect(after).toMatchObject({
      track: before?.track,
      transport: before?.transport,
      revision: before?.revision,
      volume: before?.volume,
      loop: before?.loop,
      dsp: before?.dsp,
      fade: before?.fade,
    });
  });

  it('keeps a payload id while returning an independent correlation id', async () => {
    const { origin } = await listenApi();
    streamResponse = await openStream(origin);
    const nullDelivered = nextStreamData(streamResponse);
    const nullResponse = await fetch(`${origin}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'room', id: null }),
    });
    const nullResult = (await nullResponse.json()) as { ids: string[] };

    expect(nullResponse.status).toBe(200);
    expect(nullResult.ids).toHaveLength(1);
    expect(nullResult.ids[0]).not.toBeNull();
    expect(await nullDelivered).toContain('"cmd":"room","id":null');

    const namedDelivered = nextStreamData(streamResponse);
    const namedResponse = await fetch(`${origin}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'room', id: 'hall' }),
    });
    const namedResult = (await namedResponse.json()) as { ids: string[] };

    expect(namedResponse.status).toBe(200);
    expect(namedResult.ids).toHaveLength(1);
    expect(namedResult.ids[0]).not.toBe('hall');
    expect(await namedDelivered).toContain('"cmd":"room","id":"hall"');
  });

  it('delivers known commands from a mixed batch and rejects an all-unknown batch', async () => {
    const { origin } = await listenApi();
    streamResponse = await openStream(origin);
    const delivered = nextStreamData(streamResponse);
    const mixed = await fetch(`${origin}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: [{ cmd: 'pause', on: true }, { cmd: 'future-command' }] }),
    });

    expect(mixed.status).toBe(200);
    expect(await delivered).toContain('"cmd":"pause"');

    const unknown = await fetch(`${origin}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: [{ cmd: 'future-command' }] }),
    });
    expect(unknown.status).toBe(400);
  });

  it('queues a say as a server turn and completes the wait under the id it returned', async () => {
    const { origin, hub } = await listenApi();
    const pending = fetch(`${origin}/api/command?wait=5`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'say', text: 'あ' }),
    });
    // The line is on the server's list before any renderer has seen it, so a
    // queue edit made meanwhile republishes it rather than erasing it.
    await vi.waitFor(() => expect(hub.queue.list()).toHaveLength(1));
    const [entry] = hub.queue.list();
    hub.queue.add([{ text: 'い' }]);
    hub.publishQueue();
    expect(hub.queue.list().map((e) => e.id)).toContain(entry.id);

    hub.report({ events: [{ type: 'turn.start', turn: entry.id }] });
    hub.report({ events: [{ type: 'turn.end', turn: entry.id }] });
    const response = await pending;
    const body = (await response.json()) as { ids: string[]; completed: boolean; fates: string[] };

    expect(response.status).toBe(200);
    expect(body.ids).toEqual([entry.id]);
    expect(body.fates).toEqual(['retained']);
    expect(body.completed).toBe(true);
  });

  it('answers 503 only for a command neither delivered nor kept', async () => {
    const { origin } = await listenApi();
    const post = (body: unknown) =>
      fetch(`${origin}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const kept = await post({ batch: [{ cmd: 'camera', frame: 'bust' }, { cmd: 'clear' }] });
    expect(kept.status).toBe(200);
    expect(await kept.json()).toMatchObject({ ok: true, fates: ['retained', 'retained'] });

    const mixed = await post({
      batch: [
        { cmd: 'camera', frame: 'bust' },
        { cmd: 'gesture', id: 'wave' },
      ],
    });
    expect(mixed.status).toBe(503);
    expect(await mixed.json()).toMatchObject({ ok: false, fates: ['retained', 'lost'] });
  });

  it('answers 413 to a JSON body past the cap, declared or streamed', async () => {
    const { origin, hub } = await listenApi();
    const url = new URL(`${origin}/api/command`);
    const post = (headers: Record<string, string>, write: (req: ClientRequest) => void) =>
      new Promise<number>((resolve) => {
        const req = request(
          { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        // The connection is dropped after the answer; a write still in flight may fail.
        req.on('error', () => resolve(-1));
        write(req);
      });

    // Declared too long: refused before a byte of it is read.
    expect(
      await post({ 'Content-Length': String(JSON_BODY_MAX_BYTES + 1) }, (req) =>
        req.flushHeaders(),
      ),
    ).toBe(413);
    // Streamed with no length: reading stops at the cap. The answer races the
    // reset of a body still being sent, so either is the server refusing it.
    const streamed = await post({}, (req) => {
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      for (let sent = 0; sent <= JSON_BODY_MAX_BYTES; sent += chunk.length) req.write(chunk);
      req.end();
    });
    expect([413, -1]).toContain(streamed);
    expect(hub.snapshot().events).toEqual([]);
    expect((await fetch(`${origin}/api/state`)).status).toBe(200);
  });

  it('requires a renderer identity and rejects a second owner without mixing bytes', async () => {
    recordingsRoot = await mkdtemp(join(tmpdir(), 'hashidate-route-takes-'));
    recordings = new Recordings(recordingsRoot);
    const { origin } = await listenApi(new Hub(null, null, null, recordings));
    const started = await fetch(`${origin}/api/record/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'route', width: 640, height: 480, fps: 30 }),
    });
    const opened = (await started.json()) as { recording: { session: string; file: string } };
    const session = opened.recording.session;

    const missing = await fetch(`${origin}/api/record/chunk?session=${session}`, {
      method: 'POST',
      body: Buffer.from('missing'),
    });
    expect(missing.status).toBe(400);

    const first = await fetch(
      `${origin}/api/record/chunk?session=${session}&renderer=renderer-a&mime=video%2Fmp4`,
      { method: 'POST', body: Buffer.from('one') },
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { recording: { file: string } };
    const conflict = await fetch(
      `${origin}/api/record/chunk?session=${session}&renderer=renderer-b&mime=video%2Fmp4`,
      { method: 'POST', body: Buffer.from('two') },
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).recording).toMatchObject({ bytes: 3, error: null });

    const finished = await fetch(
      `${origin}/api/record/chunk?session=${session}&renderer=renderer-a&mime=video%2Fmp4&final=1`,
      { method: 'POST', body: Buffer.alloc(0) },
    );
    expect(finished.status).toBe(200);
    expect(await readFile(firstBody.recording.file, 'utf8')).toBe('one');
  });

  it('returns a recording snapshot when the sink fails', async () => {
    recordingsRoot = await mkdtemp(join(tmpdir(), 'hashidate-route-fail-'));
    recordings = new Recordings(
      recordingsRoot,
      () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error('route sink offline'));
          },
        }),
    );
    const { origin } = await listenApi(new Hub(null, null, null, recordings));
    const started = await fetch(`${origin}/api/record/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const opened = (await started.json()) as { recording: { session: string } };

    const failed = await fetch(
      `${origin}/api/record/chunk?session=${opened.recording.session}&renderer=renderer-a&mime=video%2Fmp4`,
      { method: 'POST', body: Buffer.from('x') },
    );
    expect(failed.status).toBe(500);
    expect((await failed.json()).recording).toMatchObject({
      bytes: 0,
      mime: null,
      error: 'route sink offline',
    });
  });
});
