import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerRoots, Snapshot } from '@/protocol';
import type { ShellPaths } from '@/shell/config';
import {
  ControlProcess,
  foreignServerMessage,
  probeControlAPI,
  TtsProcess,
  waitForControlAPI,
} from '@/shell/process';

/**
 * Whether the shell starts exactly one control server and takes it down again.
 *
 * Both halves of that are failures an operator meets as something else. A
 * server adopted from another checkout is two windows loaded from somebody
 * else's build, with nothing anywhere saying so — it reads as a renderer that
 * will not come up. A server left running after a quit holds the port, and the
 * next launch adopts the orphan: the shell appears to work and is driving a
 * process that belongs to a session that ended.
 */

const OURS: ServerRoots = {
  document: '/work/hashidate/dist',
  slides: '/work/hashidate/show/slides',
  scripts: '/work/hashidate/show/scripts',
  motions: '/work/hashidate/show/motions',
  bgm: '/work/hashidate/show/bgm',
  recordings: '/work/hashidate/show/recordings',
};

const THEIRS: ServerRoots = {
  document: '/elsewhere/hashidate/dist',
  slides: '/elsewhere/hashidate/show/slides',
  scripts: '/elsewhere/hashidate/show/scripts',
  motions: '/elsewhere/hashidate/show/motions',
  bgm: '/elsewhere/hashidate/show/bgm',
  recordings: '/elsewhere/hashidate/show/recordings',
};

const PATHS: ShellPaths = {
  root: '/work/hashidate',
  dist: OURS.document,
  slides: OURS.slides,
  scripts: OURS.scripts,
  motions: OURS.motions,
  bgm: '/work/hashidate/show/bgm',
  recordings: OURS.recordings,
  tts: '/work/hashidate/tools/tts',
  ttsPython: '/work/hashidate/tools/tts/.venv/bin/python',
  tsx: '/work/hashidate/node_modules/tsx/dist/loader.mjs',
  server: '/work/hashidate/src/server/main.ts',
};

/** Enough of a snapshot for the schema, which is what the probe validates. */
const snapshot = (roots?: ServerRoots): Snapshot => ({
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
  paused: false,
  recording: null,
  ...(roots === undefined ? {} : { roots }),
});

const answering = (body: unknown, ok = true) =>
  vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);

/** Nothing listening: what `fetch` does to a closed port. */
const closed = vi.fn(async () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:8765');
}) as unknown as typeof fetch;

/**
 * A child that behaves like one, so that a stop can be observed rather than
 * assumed.
 */
function fakeChild() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  Object.assign(child, {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: (signal?: NodeJS.Signals | number) => {
      signals.push(signal);
      // A well-behaved child goes down on the first one.
      (child as { signalCode: string | null }).signalCode = String(signal ?? 'SIGTERM');
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    },
  });
  return { child, signals };
}

function spawner() {
  const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    calls.push({ command, args, options });
    const made = fakeChild();
    children.push(made);
    return made.child;
  };
  return { calls, children, spawn };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what is on the control port', () => {
  it('is silent when nothing answers', async () => {
    expect(await probeControlAPI(8765, { fetch: closed })).toEqual({ kind: 'silent' });
  });

  it('is silent when something answers that is not this API', async () => {
    const fetcher = answering({ hello: 'world' });
    expect(await probeControlAPI(8765, { fetch: fetcher })).toEqual({ kind: 'silent' });
  });

  it('is silent when the answer is not a 200', async () => {
    const fetcher = answering(snapshot(OURS), false);
    expect(await probeControlAPI(8765, { fetch: fetcher })).toEqual({ kind: 'silent' });
  });

  it('is ours when nothing was asked of it beyond speaking the API', async () => {
    const fetcher = answering(snapshot());
    expect(await probeControlAPI(8765, { fetch: fetcher })).toEqual({ kind: 'ours' });
  });

  it('is ours when it is serving the directories this checkout would', async () => {
    const fetcher = answering(snapshot(OURS));
    expect(await probeControlAPI(8765, { fetch: fetcher, roots: OURS })).toEqual({ kind: 'ours' });
  });

  it('is foreign when it is serving another build', async () => {
    const fetcher = answering(snapshot(THEIRS));
    expect(await probeControlAPI(8765, { fetch: fetcher, roots: OURS })).toEqual({
      kind: 'foreign',
      roots: THEIRS,
    });
  });

  it('is foreign when it will not say where it is serving from', async () => {
    // An older server, or something else answering this shape. Absence reads as
    // "not the one I was looking for", which is the safe answer.
    const fetcher = answering(snapshot());
    expect(await probeControlAPI(8765, { fetch: fetcher, roots: OURS })).toEqual({
      kind: 'foreign',
      roots: null,
    });
  });

  it('is foreign when one of the compared directories differs', async () => {
    const fetcher = answering(snapshot({ ...OURS, slides: '/elsewhere/show/slides' }));
    expect((await probeControlAPI(8765, { fetch: fetcher, roots: OURS })).kind).toBe('foreign');
  });
});

describe('waiting for the API', () => {
  const fast = { pollIntervalMs: 1, probeTimeoutMs: 5, timeoutMs: 50 };

  it('returns as soon as it answers', async () => {
    let asked = 0;
    const fetcher = vi.fn(async () => {
      asked += 1;
      if (asked < 3) throw new Error('not yet');
      return { ok: true, json: async () => snapshot(OURS) } as unknown as Response;
    });
    await expect(
      waitForControlAPI(8765, { ...fast, fetch: fetcher, roots: OURS }),
    ).resolves.toBeUndefined();
  });

  it('gives up when the child it was waiting for has gone', async () => {
    await expect(
      waitForControlAPI(8765, { ...fast, fetch: closed, isAlive: () => false }),
    ).rejects.toThrow(/exited before its API became ready/);
  });

  it('says what is on the port when the wait runs out against another checkout', async () => {
    const fetcher = answering(snapshot(THEIRS));
    // The one failure that is otherwise impossible to read: the port answers,
    // the schema fits, and the windows would have come up on another build.
    await expect(waitForControlAPI(8765, { ...fast, fetch: fetcher, roots: OURS })).rejects.toThrow(
      /elsewhere\/hashidate\/dist/,
    );
  });

  it('says only that nothing answered when nothing did', async () => {
    await expect(waitForControlAPI(8765, { ...fast, fetch: closed, roots: OURS })).rejects.toThrow(
      /did not answer/,
    );
  });
});

describe('the message about a server from another checkout', () => {
  it('names both builds and what to do about it', () => {
    const message = foreignServerMessage(8765, THEIRS, OURS);
    expect(message).toContain('/elsewhere/hashidate/dist');
    expect(message).toContain('/work/hashidate/dist');
    expect(message).toContain('HASHIDATE_CONTROL_PORT');
  });

  it('still says something useful when the other server would not say', () => {
    expect(foreignServerMessage(8765, null, OURS)).toContain('does not say where');
  });
});

describe('starting the control server', () => {
  const options = (over: Partial<ConstructorParameters<typeof ControlProcess>[0]> = {}) => ({
    paths: PATHS,
    port: 8765,
    roots: OURS,
    nodePath: '/usr/bin/node',
    pollIntervalMs: 1,
    probeTimeoutMs: 5,
    readyTimeoutMs: 50,
    stopTimeoutMs: 20,
    ...over,
  });

  it('uses a server already running on this checkout instead of starting a second', async () => {
    const { calls, spawn } = spawner();
    const control = new ControlProcess(options({ spawn, fetch: answering(snapshot(OURS)) }));

    await control.start();

    // A developer with `yarn dev` up must not have it taken down on quit.
    expect(calls).toEqual([]);
    expect(control.ownsChild).toBe(false);
  });

  it('refuses to drive another checkout rather than adopting it silently', async () => {
    const { calls, spawn } = spawner();
    const control = new ControlProcess(options({ spawn, fetch: answering(snapshot(THEIRS)) }));

    await expect(control.start()).rejects.toThrow(/elsewhere\/hashidate\/dist/);
    // And it does not try to start one either: the port is taken, so a child
    // would only lose the bind and die.
    expect(calls).toEqual([]);
  });

  it('starts one when the port is free, and waits for it to answer', async () => {
    const { calls, spawn } = spawner();
    let started = false;
    const fetcher = vi.fn(async () => {
      if (!started) throw new Error('not yet');
      return { ok: true, json: async () => snapshot(OURS) } as unknown as Response;
    });
    const control = new ControlProcess(options({ spawn, fetch: fetcher }));

    const starting = control.start();
    started = true;
    await starting;

    expect(control.ownsChild).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('/usr/bin/node');
  });

  it('runs the server itself rather than under a launcher that outlives it', async () => {
    const { calls, spawn } = spawner();
    let started = false;
    const fetcher = vi.fn(async () => {
      if (!started) throw new Error('not yet');
      return { ok: true, json: async () => snapshot(OURS) } as unknown as Response;
    });
    const control = new ControlProcess(options({ spawn, fetch: fetcher }));

    const starting = control.start();
    started = true;
    await starting;

    // `tsx <file>` starts a wrapper that starts the process which binds the
    // port, and a SIGKILL to the wrapper leaves the listener holding :8765 for
    // the next launch to adopt as an orphan. Registering the loader instead
    // leaves one process to signal.
    expect(calls[0]?.args).toEqual([
      '--import',
      PATHS.tsx,
      PATHS.server,
      '--port',
      '8765',
      '--root',
      PATHS.dist,
      '--slides',
      PATHS.slides,
      '--scripts',
      PATHS.scripts,
      '--motions',
      PATHS.motions,
      '--bgm',
      PATHS.bgm,
      '--recordings',
      PATHS.recordings,
    ]);
  });

  it('hands the child an environment without this process own loader flag', async () => {
    const { calls, spawn } = spawner();
    vi.stubEnv('NODE_OPTIONS', '--import=tsx');
    let started = false;
    const fetcher = vi.fn(async () => {
      if (!started) throw new Error('not yet');
      return { ok: true, json: async () => snapshot(OURS) } as unknown as Response;
    });
    const control = new ControlProcess(options({ spawn, fetch: fetcher }));

    const starting = control.start();
    started = true;
    await starting;

    const env = calls[0]?.options.env ?? {};
    // Applied a second time to a child that is already being started with its
    // own, and to the Python sidecar, which has no use for it at all.
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    vi.unstubAllEnvs();
  });

  it('takes its own child down again', async () => {
    const { children, spawn } = spawner();
    let started = false;
    const fetcher = vi.fn(async () => {
      if (!started) throw new Error('not yet');
      return { ok: true, json: async () => snapshot(OURS) } as unknown as Response;
    });
    const control = new ControlProcess(options({ spawn, fetch: fetcher }));
    const starting = control.start();
    started = true;
    await starting;

    await control.stop();

    expect(children[0]?.signals).toEqual(['SIGTERM']);
    expect(control.ownsChild).toBe(false);
  });

  it('leaves a server it adopted running', async () => {
    const { children, spawn } = spawner();
    const control = new ControlProcess(options({ spawn, fetch: answering(snapshot(OURS)) }));
    await control.start();

    await control.stop();

    expect(children).toEqual([]);
  });

  it('does not leave a server behind when the quit beats the spawn', async () => {
    // Startup waits for the API before any window exists, so the only thing on
    // screen during it is the menu — and quitting from there runs `stop` while
    // `start` is still inside its first probe, with no child to stop yet.
    const { calls, spawn } = spawner();
    const control = new ControlProcess(options({ spawn, fetch: closed }));

    const starting = control.start();
    await control.stop();
    await starting;

    expect(calls).toEqual([]);
    expect(control.ownsChild).toBe(false);
  });

  it('takes down a child it had already started when the quit arrives mid-wait', async () => {
    const { children, calls, spawn } = spawner();
    const control = new ControlProcess(options({ spawn, fetch: closed, readyTimeoutMs: 5_000 }));

    const starting = control.start();
    // Let the probe fail and the spawn happen, then quit while it is waiting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(1);

    await control.stop();
    await starting;

    expect(children[0]?.signals.length).toBeGreaterThan(0);
    expect(control.ownsChild).toBe(false);
  });
});

describe('the optional speech sidecar', () => {
  const options = (over = {}) => ({
    paths: PATHS,
    // A path that nothing can be listening on, so the probe cannot adopt a
    // sidecar that happens to be running on the machine the tests are on.
    endpoint: { kind: 'socket', path: '/nonexistent/speech.sock' } as const,
    probeTimeoutMs: 5,
    stopTimeoutMs: 20,
    ...over,
  });

  it('starts nothing on a machine without the private Python environment', async () => {
    // Which is most of them: the model is another three gigabytes and the
    // recordings behind the voice are not ours.
    const { calls, spawn } = spawner();
    const tts = new TtsProcess(options({ spawn }));

    await tts.start();

    expect(calls).toEqual([]);
    expect(tts.available).toBe(false);
  });

  it('does not start one after a quit has already been asked for', async () => {
    const { calls, spawn } = spawner();
    const tts = new TtsProcess(options({ spawn }));

    await tts.stop();
    await tts.start();

    expect(calls).toEqual([]);
  });
});
