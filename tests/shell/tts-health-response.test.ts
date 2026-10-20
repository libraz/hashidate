import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkoutPaths } from '@/shell/config';
import { TtsProcess } from '@/shell/process';

let root: string;
let server: Server | undefined;
let tts: TtsProcess | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-health-'));
});

afterEach(async () => {
  await tts?.stop();
  tts = undefined;
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  { body: { ready: true }, spawnExpected: false },
  { body: { ready: false }, spawnExpected: false },
  { body: { ready: 'false' }, spawnExpected: true },
  { body: { ready: null }, spawnExpected: true },
  { body: { ready: 0 }, spawnExpected: true },
  { body: {}, spawnExpected: true },
])('validates the health reply $body', async ({ body, spawnExpected }) => {
  const path = join(root, 'speech.sock');
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server?.listen(path, resolve));

  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals) {
      Object.assign(child, { signalCode: signal });
      child.emit('exit', null, signal);
      return true;
    },
  });
  const spawn = vi.fn(() => child);
  tts = new TtsProcess({
    paths: { ...checkoutPaths(), ttsPython: process.execPath },
    endpoint: { kind: 'socket', path },
    spawn,
  });

  await tts.start();

  // The shell must agree with the control server about what counts as health.
  vi.stubEnv('HASHIDATE_TTS_SOCKET', path);
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { SpeechWatch } = await import('@/server/speech');
  const watch = new SpeechWatch();
  expect(await watch.check()).toBe(spawnExpected ? 'absent' : body.ready ? 'ready' : 'loading');
  watch.stop();

  expect(spawn).toHaveBeenCalledTimes(spawnExpected ? 1 : 0);
  expect(tts.ownsChild).toBe(spawnExpected);
});
