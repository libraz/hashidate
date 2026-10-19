import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechWatch as SpeechWatchInstance } from '@/server/speech';

let directory: string;
let socket: string;
let server: Server;
let SpeechWatch: typeof import('@/server/speech').SpeechWatch;
let EXPECTED_GRACE_MS: number;
let watch: SpeechWatchInstance;
let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

function nextResponse(): Promise<ServerResponse> {
  return new Promise((resolve) => {
    server.once('request', (_request, response) => resolve(response));
  });
}

function reply(response: ServerResponse, ready: boolean | null, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(ready === null ? '{}' : JSON.stringify({ ready }));
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hashidate-speech-watch-'));
  socket = join(directory, 'speech.sock');
  vi.stubEnv('HASHIDATE_TTS_SOCKET', socket);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.resetModules();
  ({ SpeechWatch, EXPECTED_GRACE_MS } = await import('@/server/speech'));
  watch = new SpeechWatch();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => resolve());
  });
});

afterEach(async () => {
  watch.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});

/** Let socket I/O land; fake timers do not move it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Answer every probe with `ready`, and count them. */
function answering(ready: boolean | null): { probes: () => number } {
  let count = 0;
  server.on('request', (_request, response) => {
    count += 1;
    reply(response, ready, ready === null ? 503 : 200);
  });
  return { probes: () => count };
}

describe('SpeechWatch cadence', () => {
  it('probes every second while the model loads', async () => {
    const served = answering(false);
    expect(await watch.start()).toBe('loading');
    expect(served.probes()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    await settle();
    expect(served.probes()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(served.probes()).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(served.probes()).toBe(3);
  });

  it('probes every five seconds otherwise, and slows down once ready', async () => {
    const served = answering(false);
    expect(await watch.start()).toBe('loading');
    server.removeAllListeners('request');
    const ready = answering(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(ready.probes()).toBe(1);
    expect(watch.current).toBe('ready');

    await vi.advanceTimersByTimeAsync(4_999);
    await settle();
    expect(ready.probes()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(ready.probes()).toBe(2);
    expect(served.probes()).toBe(1);
  });

  it('keeps five seconds for a sidecar that is not there', async () => {
    const served = answering(null);
    expect(await watch.start()).toBe('absent');

    await vi.advanceTimersByTimeAsync(4_999);
    await settle();
    expect(served.probes()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(served.probes()).toBe(2);
  });
});

describe('SpeechWatch with a sidecar the shell started', () => {
  beforeEach(() => {
    watch = new SpeechWatch({ expected: true });
  });

  it('reports loading before any answer, and probes every second', async () => {
    const served = answering(null);
    expect(watch.current).toBe('loading');
    expect(await watch.start()).toBe('loading');

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(served.probes()).toBe(2);
    expect(watch.current).toBe('loading');
  });

  it('follows the sidecar from its first answer on', async () => {
    answering(true);
    expect(await watch.start()).toBe('ready');
  });

  it('gives up and reports down once the grace has passed with no answer', async () => {
    answering(null);
    await watch.start();

    vi.setSystemTime(Date.now() + EXPECTED_GRACE_MS - 1);
    expect(await watch.check()).toBe('loading');

    vi.setSystemTime(Date.now() + 1);
    expect(await watch.check()).toBe('down');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('SpeechWatch lifecycle', () => {
  it('ignores a first start reply that arrives after stop', async () => {
    const incoming = nextResponse();
    const starting = watch.start();
    const response = await incoming;

    watch.stop();
    reply(response, true);

    expect.soft(await starting).toBe('absent');
    expect.soft(watch.current).toBe('absent');
    expect.soft(vi.getTimerCount()).toBe(0);

    const nextIncoming = nextResponse();
    const checking = watch.check();
    reply(await nextIncoming, null, 503);
    expect.soft(await checking).toBe('absent');
    expect.soft(watch.current).toBe('absent');
    expect.soft(vi.getTimerCount()).toBe(0);
    expect.soft(log).not.toHaveBeenCalled();
    expect.soft(warn).not.toHaveBeenCalled();
  });

  it('does not report a failed check that completes after stop', async () => {
    const initial = nextResponse();
    const starting = watch.start();
    reply(await initial, true);
    expect(await starting).toBe('ready');
    expect(vi.getTimerCount()).toBe(1);

    const incoming = nextResponse();
    const checking = watch.check();
    const response = await incoming;
    watch.stop();
    reply(response, null, 503);

    expect.soft(await checking).toBe('ready');
    expect.soft(watch.current).toBe('ready');
    expect.soft(vi.getTimerCount()).toBe(0);
    expect.soft(warn).not.toHaveBeenCalled();
  });

  it('does not let a late ready check make a never-seen sidecar count as down', async () => {
    const initial = nextResponse();
    const starting = watch.start();
    reply(await initial, null, 503);
    expect(await starting).toBe('absent');

    const incoming = nextResponse();
    const checking = watch.check();
    const response = await incoming;
    watch.stop();
    reply(response, true);
    expect.soft(await checking).toBe('absent');

    const missing = nextResponse();
    const checkingMissing = watch.check();
    reply(await missing, null, 503);
    expect.soft(await checkingMissing).toBe('absent');
    expect.soft(watch.current).toBe('absent');
    expect.soft(log).not.toHaveBeenCalled();
    expect.soft(warn).not.toHaveBeenCalled();
  });

  it('does not let an older start overwrite a newer start after restart', async () => {
    const oldIncoming = nextResponse();
    const oldStart = watch.start();
    const oldResponse = await oldIncoming;
    watch.stop();

    const newIncoming = nextResponse();
    const newStart = watch.start();
    reply(await newIncoming, false);
    expect(await newStart).toBe('loading');
    expect(vi.getTimerCount()).toBe(1);

    reply(oldResponse, true);
    expect.soft(await oldStart).toBe('loading');
    expect.soft(watch.current).toBe('loading');
    expect.soft(vi.getTimerCount()).toBe(1);
  });

  it('keeps live start, stop, restart, and manual checks working', async () => {
    const initial = nextResponse();
    const starting = watch.start();
    reply(await initial, true);
    expect(await starting).toBe('ready');
    expect(vi.getTimerCount()).toBe(1);
    expect(log).not.toHaveBeenCalled();

    watch.stop();
    expect(vi.getTimerCount()).toBe(0);

    const missing = nextResponse();
    const manual = watch.check();
    reply(await missing, null, 503);
    expect(await manual).toBe('down');
    expect(watch.current).toBe('down');
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);

    const restartedResponse = nextResponse();
    const restarted = watch.start();
    reply(await restartedResponse, false);
    expect(await restarted).toBe('loading');
    expect(vi.getTimerCount()).toBe(1);

    watch.stop();
    const stillMissing = nextResponse();
    const manualAfterRestart = watch.check();
    reply(await stillMissing, null, 503);
    expect(await manualAfterRestart).toBe('down');
    expect(watch.current).toBe('down');
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
