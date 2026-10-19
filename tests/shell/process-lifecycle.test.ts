import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellPaths } from '@/shell/config';
import { ControlProcess, TtsProcess } from '@/shell/process';

/**
 * What the shell passes its children, and what it does when the sidecar dies
 * on its own: restart it, but not forever, and not after a quit.
 */

const PATHS: ShellPaths = {
  root: '/work/hashidate',
  dist: '/work/hashidate/dist',
  slides: '/work/hashidate/show/slides',
  scripts: '/work/hashidate/show/scripts',
  motions: '/work/hashidate/show/motions',
  avatars: '/work/hashidate/avatars',
  bgm: '/work/hashidate/show/bgm',
  recordings: '/work/hashidate/show/recordings',
  tts: '/work/hashidate/tools/tts',
  // Any file that is executable, so the sidecar counts as installed.
  ttsPython: process.execPath,
  tsx: '/work/hashidate/node_modules/tsx/dist/loader.mjs',
  server: '/work/hashidate/src/server/main.ts',
};

/** A child that stays up until the test says it died. */
function liveChild() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  Object.assign(child, {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: (signal?: NodeJS.Signals | number) => {
      signals.push(signal);
      (child as { signalCode: string | null }).signalCode = String(signal ?? 'SIGTERM');
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    },
  });
  const die = () => {
    (child as { exitCode: number | null }).exitCode = 1;
    child.emit('exit', 1, null);
  };
  return { child, signals, die };
}

function spawner() {
  const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const children: ReturnType<typeof liveChild>[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    calls.push({ command, args, options });
    const made = liveChild();
    children.push(made);
    return made.child;
  };
  return { calls, children, spawn };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('what the control child is told', () => {
  // The snapshot schema is the probe's business; an answer that fails it is
  // simply "silent", which is what lets the spawn happen.
  const silent = vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;

  async function envOf(speechExpected?: boolean) {
    const { calls, children, spawn } = spawner();
    const control = new ControlProcess({
      paths: PATHS,
      port: 8765,
      spawn,
      fetch: silent,
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    await control.start(speechExpected === undefined ? {} : { speechExpected }).catch(() => {});
    await control.stop();
    expect(children).toHaveLength(1);
    return calls[0]?.options.env ?? {};
  }

  it('names the shell so that it can stop when the shell is gone', async () => {
    expect((await envOf()).HASHIDATE_SHELL_PID).toBe(String(process.pid));
  });

  it('says a voice is expected only when told so', async () => {
    expect((await envOf(true)).HASHIDATE_SPEECH_EXPECTED).toBe('1');
    expect((await envOf(false)).HASHIDATE_SPEECH_EXPECTED).toBeUndefined();
    expect((await envOf()).HASHIDATE_SPEECH_EXPECTED).toBeUndefined();
  });
});

describe('the sidecar being started again after it dies', () => {
  const options = (over = {}) => ({
    paths: PATHS,
    // Nothing can be listening here, so the probe never adopts anything.
    endpoint: { kind: 'socket', path: '/nonexistent/speech.sock' } as const,
    probeTimeoutMs: 5,
    stopTimeoutMs: 20,
    ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  it('knows whether it would start, and passes the shell pid on', async () => {
    const { calls, spawn } = spawner();
    const tts = new TtsProcess(options({ spawn }));
    expect(await tts.expected()).toBe(true);
    expect(
      await new TtsProcess(options({ paths: { ...PATHS, ttsPython: '/nope' } })).expected(),
    ).toBe(false);
    expect(
      await new TtsProcess(options({ endpoint: { kind: 'port', port: 8770 } })).expected(),
    ).toBe(false);

    await tts.start();
    expect(calls[0]?.options.env?.HASHIDATE_SHELL_PID).toBe(String(process.pid));
    await tts.stop();
  });

  it('starts it again two seconds after it exits unasked', async () => {
    const { children, spawn } = spawner();
    const tts = new TtsProcess(options({ spawn }));
    await tts.start();
    children[0]?.die();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(tts.available).toBe(true);
    await tts.stop();
  });

  it('gives up on the third exit within five minutes, and says why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { children, spawn } = spawner();
    const tts = new TtsProcess(options({ spawn }));
    await tts.start();

    for (let exit = 0; exit < 2; exit += 1) {
      children[exit]?.die();
      await vi.advanceTimersByTimeAsync(2_020);
      // The restart probes the filesystem and the socket for real.
      await vi.waitFor(() => expect(children).toHaveLength(exit + 2));
    }
    children[2]?.die();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(children).toHaveLength(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not restarting'));
  });

  it('forgets exits older than five minutes', async () => {
    const { children, spawn } = spawner();
    const tts = new TtsProcess(options({ spawn }));
    await tts.start();

    for (let exit = 0; exit < 4; exit += 1) {
      children[exit]?.die();
      await vi.advanceTimersByTimeAsync(2_020);
      await vi.waitFor(() => expect(children).toHaveLength(exit + 2));
      await vi.advanceTimersByTimeAsync(180_000);
    }
    expect(children).toHaveLength(5);
    await tts.stop();
  });

  it('does not restart after stop, and stop cancels one already pending', async () => {
    const { children, spawn } = spawner();
    const tts = new TtsProcess(options({ spawn }));
    await tts.start();
    children[0]?.die();
    await tts.stop();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(children).toHaveLength(1);
  });

  it('does not treat the exit it asked for as a crash', async () => {
    const { children, spawn } = spawner();
    const tts = new TtsProcess(options({ spawn }));
    await tts.start();
    await tts.stop();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(children).toHaveLength(1);
  });
});
