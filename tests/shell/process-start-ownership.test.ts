import { type ChildProcess, type SpawnOptions, spawn as spawnProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServerRoots, Snapshot } from '@/protocol';
import type { ShellPaths } from '@/shell/config';
import { ControlProcess, TtsProcess } from '@/shell/process';

const snapshot = (roots: ServerRoots): Snapshot => ({
  connected: false,
  viewers: 0,
  seq: 0,
  state: {},
  vocabulary: {},
  events: [],
  voice: null,
  tuning: null,
  placement: null,
  avatars: [],
  decks: [],
  slides: null,
  speech: 'absent',
  queue: [],
  airing: [],
  paused: false,
  recording: null,
  roots,
});

function realSpawner() {
  const children: ChildProcess[] = [];
  const spawned: Promise<void>[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const child = spawnProcess(command, [...args], options);
    children.push(child);
    spawned.push(
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          child.off('spawn', onSpawn);
          reject(error);
        };
        const onSpawn = () => {
          child.off('error', onError);
          resolve();
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      }),
    );
    return child;
  };
  return { children, spawned, spawn };
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      child.off('exit', done);
      child.off('close', done);
      resolve();
    };
    child.once('exit', done);
    child.once('close', done);
  });
}

async function stopCaptured(children: readonly ChildProcess[]): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await Promise.all(children.map(waitForExit));
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address assigned');
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address assigned');
  return address.port;
}

function rootsFor(root: string): ServerRoots {
  return {
    document: join(root, 'dist'),
    slides: join(root, 'show', 'slides'),
    scripts: join(root, 'show', 'scripts'),
    motions: join(root, 'show', 'motions'),
    avatars: join(root, 'avatars'),
    bgm: join(root, 'show', 'bgm'),
    recordings: join(root, 'show', 'recordings'),
  };
}

async function makeControlFixture() {
  const root = await mkdtemp(join(tmpdir(), 'hashidate-control-start-'));
  const roots = rootsFor(root);
  const paths: ShellPaths = {
    root,
    dist: roots.document,
    slides: roots.slides,
    scripts: roots.scripts,
    motions: roots.motions,
    avatars: roots.avatars,
    bgm: roots.bgm ?? join(root, 'show', 'bgm'),
    recordings: roots.recordings,
    tts: join(root, 'tts'),
    ttsPython: process.execPath,
    tsx: join(root, 'loader.mjs'),
    server: join(root, 'server.mjs'),
  };
  await writeFile(paths.tsx, '');
  await writeFile(
    paths.server,
    `import { createServer } from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const body = ${JSON.stringify(snapshot(roots))};
createServer((request, response) => {
  if (request.url !== '/api/state') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}).listen(port, '127.0.0.1');
`,
  );
  return { root, roots, paths };
}

async function makeTtsFixture() {
  const root = await mkdtemp(join(tmpdir(), 'hashidate-tts-start-'));
  const socket = join(root, 'speech.sock');
  await writeFile(join(root, 'server.py'), 'setInterval(() => {}, 60_000);');
  const paths: ShellPaths = {
    root,
    dist: join(root, 'dist'),
    slides: join(root, 'show', 'slides'),
    scripts: join(root, 'show', 'scripts'),
    motions: join(root, 'show', 'motions'),
    avatars: join(root, 'avatars'),
    bgm: join(root, 'show', 'bgm'),
    recordings: join(root, 'show', 'recordings'),
    tts: root,
    ttsPython: process.execPath,
    tsx: join(root, 'loader.mjs'),
    server: join(root, 'server.mjs'),
  };
  return { root, paths, endpoint: { kind: 'socket', path: socket } as const };
}

describe('process start ownership', () => {
  it('keeps its control child owned on a repeated start, then stops that same child', async () => {
    const fixture = await makeControlFixture();
    const port = await reservePort();
    const recorder = realSpawner();
    const control = new ControlProcess({
      paths: fixture.paths,
      roots: fixture.roots,
      port,
      nodePath: process.execPath,
      spawn: recorder.spawn,
      readyTimeoutMs: 2_000,
      probeTimeoutMs: 50,
      pollIntervalMs: 10,
      stopTimeoutMs: 500,
    });

    try {
      await control.start();
      await Promise.all(recorder.spawned);
      const child = recorder.children[0];
      if (child === undefined) throw new Error('control start did not spawn a child');

      await control.start();
      expect(recorder.children).toHaveLength(1);
      expect(control.running).toBe(true);
      expect(control.ownsChild).toBe(true);
      expect(recorder.children[0]).toBe(child);

      await control.stop();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(control.ownsChild).toBe(false);
    } finally {
      await Promise.allSettled(recorder.spawned);
      await stopCaptured(recorder.children);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('does not claim or stop a real pre-existing control server after repeated starts', async () => {
    const fixture = await makeControlFixture();
    const payload = JSON.stringify(snapshot(fixture.roots));
    const external = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(payload);
    });
    const port = await listen(external);
    const recorder = realSpawner();
    const control = new ControlProcess({
      paths: fixture.paths,
      roots: fixture.roots,
      port,
      nodePath: process.execPath,
      spawn: recorder.spawn,
      probeTimeoutMs: 100,
    });

    try {
      await control.start();
      await control.start();
      await control.stop();

      expect(recorder.children).toEqual([]);
      expect(control.running).toBe(false);
      expect(control.ownsChild).toBe(false);
      const response = await fetch(`http://127.0.0.1:${port}/api/state`);
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual(snapshot(fixture.roots));
    } finally {
      await Promise.allSettled(recorder.spawned);
      await stopCaptured(recorder.children);
      external.closeAllConnections();
      await new Promise<void>((resolve) => external.close(() => resolve()));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('coalesces concurrent and repeated TTS starts while the socket is absent', async () => {
    const fixture = await makeTtsFixture();
    const recorder = realSpawner();
    const tts = new TtsProcess({
      paths: fixture.paths,
      endpoint: fixture.endpoint,
      spawn: recorder.spawn,
      probeTimeoutMs: 50,
      stopTimeoutMs: 500,
    });

    try {
      await Promise.all([tts.start(), tts.start()]);
      await Promise.all(recorder.spawned);
      expect.soft(recorder.children).toHaveLength(1);
      const child = recorder.children[0];
      if (child === undefined) throw new Error('TTS start did not spawn a child');
      expect
        .soft(
          recorder.children.filter(
            (candidate) => candidate.exitCode === null && candidate.signalCode === null,
          ),
        )
        .toHaveLength(1);
      expect(tts.available).toBe(true);
      expect(tts.ownsChild).toBe(true);

      await tts.start();
      await Promise.all(recorder.spawned);
      expect.soft(recorder.children).toHaveLength(1);
      expect.soft(recorder.children[0]).toBe(child);
      expect(tts.available).toBe(true);

      await tts.stop();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      await Promise.allSettled(recorder.spawned);
      await stopCaptured(recorder.children);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('allows a control supervisor to restart after its child exits', async () => {
    const fixture = await makeControlFixture();
    const port = await reservePort();
    const recorder = realSpawner();
    const control = new ControlProcess({
      paths: fixture.paths,
      roots: fixture.roots,
      port,
      nodePath: process.execPath,
      spawn: recorder.spawn,
      readyTimeoutMs: 2_000,
      probeTimeoutMs: 50,
      pollIntervalMs: 10,
      stopTimeoutMs: 500,
    });

    try {
      await control.start();
      await Promise.all(recorder.spawned);
      const first = recorder.children[0];
      if (first === undefined) throw new Error('first control start did not spawn');
      first.kill('SIGTERM');
      await waitForExit(first);

      await control.start();
      await Promise.all(recorder.spawned);
      const second = recorder.children[1];
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      expect(control.running).toBe(true);
      expect(control.ownsChild).toBe(true);
      if (second !== undefined) await control.stop();
    } finally {
      await Promise.allSettled(recorder.spawned);
      await stopCaptured(recorder.children);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('allows a TTS supervisor to restart after its child exits', async () => {
    const fixture = await makeTtsFixture();
    const recorder = realSpawner();
    const tts = new TtsProcess({
      paths: fixture.paths,
      endpoint: fixture.endpoint,
      spawn: recorder.spawn,
      probeTimeoutMs: 50,
      stopTimeoutMs: 500,
    });

    try {
      await tts.start();
      await Promise.all(recorder.spawned);
      const first = recorder.children[0];
      if (first === undefined) throw new Error('first TTS start did not spawn');
      first.kill('SIGTERM');
      await waitForExit(first);

      await tts.start();
      await Promise.all(recorder.spawned);
      const second = recorder.children[1];
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      expect(tts.available).toBe(true);
      expect(tts.ownsChild).toBe(true);
      if (second !== undefined) await tts.stop();
    } finally {
      await Promise.allSettled(recorder.spawned);
      await stopCaptured(recorder.children);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
