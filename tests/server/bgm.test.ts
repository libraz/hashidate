import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BgmReport, StreamMessage } from '@/protocol';
import { BgmLibrary, handleBgm } from '@/server/bgm';
import { BgmCoordinator } from '@/server/bgm-state';
import { Hub } from '@/server/hub';
import { handleApi } from '@/server/routes';

let root: string;
let library: BgmLibrary;
const servers: Server[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-bgm-'));
  library = new BgmLibrary(root);
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await rm(root, { recursive: true, force: true });
});

async function listenBgm(): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    if (!handleBgm(req, res, library)) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return { base: `http://127.0.0.1:${address.port}`, server };
}

async function listenApi(): Promise<{ base: string; server: Server }> {
  const hub = new Hub();
  const server = createServer((req, res) => {
    if (!handleApi(req, res, hub, { bgm: library })) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return { base: `http://127.0.0.1:${address.port}`, server };
}

function report(over: Partial<BgmReport> = {}): BgmReport {
  return {
    revision: 0,
    track: null,
    transport: 'stopped',
    position: 0,
    duration: null,
    muted: false,
    blocked: false,
    error: null,
    dspDegraded: false,
    ...over,
  };
}

describe('BgmLibrary', () => {
  it('lists only direct regular MP3 and FLAC files with NFC ids', async () => {
    await writeFile(join(root, 'opening.mp3'), Buffer.from('mp3'));
    await writeFile(join(root, 'closing.FLAC'), Buffer.from('flac'));
    await writeFile(join(root, 'notes.txt'), 'not audio');
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'hidden.mp3'), 'not direct');
    await symlink(join(root, 'opening.mp3'), join(root, 'linked.mp3'));
    await writeFile(join(root, 'e\u0301.mp3'), Buffer.from('nfc'));

    const tracks = await library.list();

    expect(tracks.map((track) => track.id)).toEqual(
      ['closing.FLAC', 'opening.mp3', 'é.mp3'].sort((a, b) => a.localeCompare(b)),
    );
    expect(tracks.find((track) => track.id === 'closing.FLAC')).toMatchObject({
      label: 'closing.FLAC',
      mime: 'audio/flac',
      bytes: 4,
    });
    expect(tracks.find((track) => track.id === 'é.mp3')?.label).toBe('é.mp3');
  });

  it('returns an empty roster when the root is missing', async () => {
    const missing = new BgmLibrary(join(root, 'not-created'));
    expect(await missing.list()).toEqual([]);
    expect(missing.current).toEqual([]);
  });

  it('refuses traversal and nested ids before touching the filesystem', () => {
    expect(library.path('../secret.mp3')).toBeNull();
    expect(library.path('nested/secret.mp3')).toBeNull();
    expect(library.path('.hidden.mp3')).toBeNull();
  });
});

describe('BGM byte serving', () => {
  it('serves full, head and single-range requests with the audio metadata', async () => {
    await writeFile(join(root, 'song.mp3'), Buffer.from('abcdefgh'));
    const { base } = await listenBgm();

    const full = await fetch(`${base}/bgm/song.mp3`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('audio/mpeg');
    expect(full.headers.get('cache-control')).toBe('no-store');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer()).toString()).toBe('abcdefgh');

    const head = await fetch(`${base}/bgm/song.mp3`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('8');
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const range = await fetch(`${base}/bgm/song.mp3`, {
      headers: { Range: 'bytes=1-3' },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 1-3/8');
    expect(Buffer.from(await range.arrayBuffer()).toString()).toBe('bcd');
  });

  it('supports suffix/open ranges and rejects multi or unsatisfiable ranges', async () => {
    await writeFile(join(root, 'song.mp3'), Buffer.from('abcdefgh'));
    const { base } = await listenBgm();

    const suffix = await fetch(`${base}/bgm/song.mp3`, {
      headers: { Range: 'bytes=-3' },
    });
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer()).toString()).toBe('fgh');

    const open = await fetch(`${base}/bgm/song.mp3`, {
      headers: { Range: 'bytes=5-' },
    });
    expect(open.status).toBe(206);
    expect(Buffer.from(await open.arrayBuffer()).toString()).toBe('fgh');

    const invalid = await fetch(`${base}/bgm/song.mp3`, {
      headers: { Range: 'bytes=1-2,4-5' },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe('bytes */8');
    expect((await invalid.arrayBuffer()).byteLength).toBe(0);
  });

  it('does not serve an encoded path separator or another missing file', async () => {
    await writeFile(join(root, 'song.mp3'), Buffer.from('abcdefgh'));
    const { base } = await listenBgm();

    expect((await fetch(`${base}/bgm/${encodeURIComponent('../song.mp3')}`)).status).toBe(404);
    expect((await fetch(`${base}/bgm/missing.flac`)).status).toBe(404);
  });
});

describe('BGM roster route', () => {
  it('returns a fresh roster for each API request', async () => {
    await writeFile(join(root, 'first.mp3'), Buffer.from('first'));
    const { base } = await listenApi();

    const first = await fetch(`${base}/api/bgm`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ tracks: [{ id: 'first.mp3', mime: 'audio/mpeg' }] });

    await writeFile(join(root, 'second.flac'), Buffer.from('second'));
    const second = await fetch(`${base}/api/bgm`);
    expect(await second.json()).toMatchObject({
      tracks: [{ id: 'first.mp3' }, { id: 'second.flac' }],
    });
  });
});

describe('BgmCoordinator', () => {
  it('owns transport semantics, position and the independent DSP patch', () => {
    let at = 100;
    const coordinator = new BgmCoordinator(() => at);

    const started = coordinator.apply({
      cmd: 'bgm',
      id: 'start',
      action: 'play',
      track: 'song.mp3',
      revision: 999,
      position: 77,
      at: 1,
      dsp: { reverb: { mix: 0.3 } },
      fade: { inSeconds: 2 },
    });
    expect(started).toMatchObject({
      id: 'start',
      action: 'play',
      track: 'song.mp3',
      position: 0,
      revision: 1,
      at: 100,
      dsp: {
        toneDb: 0,
        compression: 0,
        width: 1,
        reverb: { mix: 0.3, decay: 0.5, damping: 0.5 },
      },
      fade: { inSeconds: 2, outSeconds: 1 },
    });
    expect(started).not.toHaveProperty('inputGainDb');

    at = 105;
    expect(coordinator.state()).toMatchObject({ transport: 'playing', position: 5 });

    const paused = coordinator.apply({ cmd: 'bgm', action: 'pause' });
    expect(paused).toMatchObject({ action: 'pause', position: 5, revision: 2 });
    at = 115;
    expect(coordinator.state()).toMatchObject({ transport: 'paused', position: 5 });

    const settings = coordinator.apply({
      cmd: 'bgm',
      volume: 0.45,
      dsp: { toneDb: 2, reverb: { damping: 0.6 } },
      fade: { outSeconds: 3 },
    });
    expect(settings.action).toBeUndefined();
    expect(settings).toMatchObject({
      volume: 0.45,
      position: 5,
      transport: 'paused',
      dsp: {
        toneDb: 2,
        compression: 0,
        width: 1,
        reverb: { mix: 0.3, decay: 0.5, damping: 0.6 },
      },
      fade: { inSeconds: 2, outSeconds: 3 },
    });

    const selected = coordinator.apply({ cmd: 'bgm', track: 'next.flac' });
    expect(selected).toMatchObject({ track: 'next.flac', transport: 'stopped', position: 0 });
    const pausedStopped = coordinator.apply({ cmd: 'bgm', action: 'pause' });
    expect(pausedStopped).toMatchObject({ action: 'pause', transport: 'stopped', position: 0 });
    const selectedPaused = coordinator.apply({ cmd: 'bgm', track: 'paused.flac', action: 'pause' });
    expect(selectedPaused).toMatchObject({
      track: 'paused.flac',
      transport: 'stopped',
      position: 0,
    });
    expect(
      coordinator.report(report({ revision: 6, track: 'paused.flac', transport: 'ended' })),
    ).toBeNull();
    const resumed = coordinator.apply({ cmd: 'bgm', action: 'play' });
    expect(resumed).toMatchObject({ action: 'play', track: 'paused.flac', position: 0 });
    const stopped = coordinator.apply({ cmd: 'bgm', action: 'stop' });
    expect(stopped).toMatchObject({ action: 'stop', track: 'paused.flac', position: 0 });
    const unloaded = coordinator.apply({ cmd: 'bgm', track: null, action: 'play' });
    expect(unloaded).toMatchObject({ track: null, transport: 'stopped', position: 0 });
  });

  it('accepts one audible end, loops or stops, and rejects stale renderer echoes', () => {
    const at = 100;
    const looped = new BgmCoordinator(() => at);
    looped.apply({ cmd: 'bgm', track: 'loop.mp3', action: 'play' });
    const diagnostic = looped.report(
      report({ revision: 1, track: 'loop.mp3', transport: 'paused', position: 4, duration: 4 }),
    );
    expect(diagnostic).toBeNull();
    expect(looped.state()).toMatchObject({ transport: 'playing', position: 0, at: 100 });
    const first = looped.report(
      report({ revision: 1, track: 'loop.mp3', transport: 'ended', position: 4, duration: 4 }),
    );
    expect(first).toMatchObject({ action: 'play', revision: 2, position: 0, transport: 'playing' });
    expect(
      looped.report(
        report({ revision: 1, track: 'loop.mp3', transport: 'ended', position: 4, duration: 4 }),
      ),
    ).toBeNull();

    const stopped = new BgmCoordinator(() => at);
    stopped.apply({ cmd: 'bgm', track: 'once.mp3', action: 'play', loop: false });
    expect(
      stopped.report(
        report({ revision: 1, track: 'once.mp3', transport: 'ended', position: 9, duration: 9 }),
      ),
    ).toMatchObject({ action: 'stop', revision: 2, position: 0, transport: 'stopped' });

    const empty = new BgmCoordinator(() => at);
    empty.apply({ cmd: 'bgm', track: 'empty.flac', action: 'play' });
    expect(
      empty.report(
        report({
          revision: 1,
          track: 'empty.flac',
          transport: 'ended',
          position: 0,
          duration: 0,
        }),
      ),
    ).toMatchObject({ action: 'play', revision: 2, position: 0, transport: 'playing' });
  });

  it('lets muted renderers contribute duration but not clear audible failure state', () => {
    const at = 100;
    const coordinator = new BgmCoordinator(() => at);
    coordinator.apply({ cmd: 'bgm', track: 'song.mp3', action: 'play' });
    coordinator.report(
      report({
        revision: 1,
        track: 'song.mp3',
        transport: 'playing',
        position: 1,
        duration: null,
        blocked: true,
        error: 'autoplay blocked',
      }),
    );
    coordinator.report(
      report({
        revision: 1,
        track: 'song.mp3',
        muted: true,
        duration: 42,
        blocked: false,
        error: null,
      }),
    );
    expect(coordinator.state()).toMatchObject({
      duration: 42,
      blocked: true,
      error: 'autoplay blocked',
    });
  });

  it('keeps DSP degradation sticky for a revision and clears it on a new command', () => {
    const coordinator = new BgmCoordinator(() => 100);
    coordinator.apply({ cmd: 'bgm', track: 'song.mp3', action: 'play' });
    coordinator.report(
      report({ revision: 1, track: 'song.mp3', transport: 'playing', dspDegraded: true }),
    );
    expect(coordinator.state().dspDegraded).toBe(true);

    coordinator.report(
      report({ revision: 1, track: 'song.mp3', transport: 'paused', dspDegraded: false }),
    );
    expect(coordinator.state().dspDegraded).toBe(true);

    coordinator.apply({ cmd: 'bgm', volume: 0.4 });
    const muted = coordinator.report(
      report({ revision: 2, track: 'song.mp3', muted: true, dspDegraded: true, duration: 42 }),
    );
    expect(muted).toBeNull();
    expect(coordinator.state().dspDegraded).toBe(false);

    coordinator.report(
      report({ revision: 2, track: 'song.mp3', transport: 'playing', dspDegraded: true }),
    );
    expect(coordinator.state().dspDegraded).toBe(true);

    coordinator.apply({ cmd: 'bgm', volume: 0.5 });
    expect(coordinator.state()).toMatchObject({ revision: 3, dspDegraded: false });
  });

  it('ignores divergent renderer positions, timestamps, and transports', () => {
    let at = 100;
    const coordinator = new BgmCoordinator(() => at);
    coordinator.apply({ cmd: 'bgm', track: 'song.mp3', action: 'play' });
    coordinator.report(
      report({
        revision: 1,
        track: 'song.mp3',
        transport: 'paused',
        position: 90,
        at: 1,
      }),
    );
    expect(coordinator.state()).toMatchObject({ transport: 'playing', position: 0, at: 100 });

    at = 105;
    coordinator.report(
      report({
        revision: 1,
        track: 'song.mp3',
        transport: 'stopped',
        position: 0,
        at: 105,
      }),
    );
    expect(coordinator.state()).toMatchObject({ transport: 'playing', position: 5, at: 105 });
  });

  it('returns the resolved fade policy on every canonical and late-join command', () => {
    let at = 100;
    const coordinator = new BgmCoordinator(() => at);
    const started = coordinator.apply({
      cmd: 'bgm',
      track: 'first.mp3',
      action: 'play',
      fade: { inSeconds: 0, outSeconds: 2.5 },
      position: 900,
      at: 1,
    });
    expect(started).toMatchObject({ fade: { inSeconds: 0, outSeconds: 2.5 } });

    at = 105;
    const selected = coordinator.apply({ cmd: 'bgm', track: 'second.flac' });
    expect(selected).toMatchObject({
      track: 'second.flac',
      transport: 'stopped',
      position: 0,
      fade: { inSeconds: 0, outSeconds: 2.5 },
    });
    expect(coordinator.currentCommand()).toMatchObject({
      track: 'second.flac',
      fade: { inSeconds: 0, outSeconds: 2.5 },
    });
  });

  it('does not turn an audible failure into an automatic loop', () => {
    const coordinator = new BgmCoordinator(() => 100);
    coordinator.apply({ cmd: 'bgm', track: 'song.mp3', action: 'play' });
    expect(
      coordinator.report(
        report({
          revision: 1,
          track: 'song.mp3',
          transport: 'ended',
          position: 4,
          duration: 4,
          blocked: true,
          error: 'autoplay blocked',
        }),
      ),
    ).toBeNull();
    expect(coordinator.state()).toMatchObject({
      transport: 'playing',
      position: 0,
      revision: 1,
      blocked: true,
    });
  });

  it('waits at a non-looping boundary for a healthy renderer end report', () => {
    let at = 100;
    const coordinator = new BgmCoordinator(() => at);
    coordinator.apply({ cmd: 'bgm', track: 'once.mp3', action: 'play', loop: false });
    coordinator.report(
      report({
        revision: 1,
        track: 'once.mp3',
        transport: 'playing',
        duration: 4,
        blocked: true,
      }),
    );

    at = 110;
    expect(coordinator.state()).toMatchObject({
      transport: 'playing',
      position: 4,
      revision: 1,
      blocked: true,
    });

    expect(
      coordinator.report(
        report({ revision: 1, track: 'once.mp3', transport: 'ended', duration: 4 }),
      ),
    ).toMatchObject({ action: 'stop', transport: 'stopped', position: 0, revision: 2 });
  });
});

describe('Hub BGM integration', () => {
  it('replays the canonical BGM command to late subscribers and deduplicates ends', async () => {
    const at = 100;
    await writeFile(join(root, 'song.mp3'), 'audio');
    await library.list();
    const coordinator = new BgmCoordinator(() => at);
    const hub = new Hub(null, null, null, null, library, coordinator);
    const seen: StreamMessage[] = [];
    hub.subscribe((message) => seen.push(message));

    hub.send({ type: 'command', commands: [{ cmd: 'bgm', track: 'song.mp3', action: 'play' }] });
    expect(seen[0].commands[0]).toMatchObject({
      cmd: 'bgm',
      track: 'song.mp3',
      revision: 1,
      action: 'play',
    });

    const late: StreamMessage[] = [];
    hub.subscribe((message) => late.push(message));
    expect(late[0].commands[0]).toMatchObject({ cmd: 'bgm', track: 'song.mp3', revision: 1 });
    expect(hub.snapshot()).toMatchObject({
      bgm: { track: 'song.mp3', transport: 'playing' },
      bgmTracks: [{ id: 'song.mp3' }],
    });

    const ended = report({
      revision: 1,
      track: 'song.mp3',
      transport: 'ended',
      position: 8,
      duration: 8,
    });
    hub.report({ bgm: ended });
    expect(seen).toHaveLength(2);
    hub.report({ bgm: ended });
    expect(seen).toHaveLength(2);
  });
});
