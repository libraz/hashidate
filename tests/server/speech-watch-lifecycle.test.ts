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
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.resetModules();
  ({ SpeechWatch } = await import('@/server/speech'));
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
