/**
 * Helpers for tools that run their own control server and dev server on free
 * loopback ports instead of borrowing a running `make dev`.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST = '127.0.0.1'; // loopback only; see AGENTS.md
export const READY_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 5_000;

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export interface Proc {
  child: ChildProcess;
  stderr: string;
}

const live = new Set<Proc>();

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** A port the OS just handed out and released. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

function accepting(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, HOST);
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

export async function until(
  what: string,
  ok: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** Start a detached process group so its whole tree can be signalled at once. */
function start(command: string, args: string[], env: Record<string, string> = {}): Proc {
  const child = spawn(join(ROOT, 'node_modules/.bin', command), args, {
    cwd: ROOT,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const proc: Proc = { child, stderr: '' };
  child.stderr?.on('data', (chunk: Buffer) => {
    proc.stderr = (proc.stderr + chunk.toString()).slice(-2048);
  });
  live.add(proc);
  return proc;
}

function signalGroup(proc: Proc, signal: NodeJS.Signals): void {
  if (proc.child.pid === undefined) return;
  try {
    process.kill(-proc.child.pid, signal);
  } catch {
    // The group is already gone.
  }
}

/** SIGTERM, then SIGKILL after a grace period; resolves once the child has exited. */
export async function stop(proc: Proc, port: number): Promise<void> {
  const exited =
    proc.child.exitCode !== null || proc.child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((done) => proc.child.once('exit', () => done()));
  signalGroup(proc, 'SIGTERM');
  const timer = setTimeout(() => signalGroup(proc, 'SIGKILL'), KILL_GRACE_MS);
  await exited;
  clearTimeout(timer);
  signalGroup(proc, 'SIGKILL');
  live.delete(proc);
  // The grandchild can outlive the launcher; wait for the port itself.
  await until(`port ${port} to close`, async () => !(await accepting(port)), 15_000);
}

export function killAll(): void {
  for (const proc of live) signalGroup(proc, 'SIGKILL');
}

export async function startControl(port: number): Promise<Proc> {
  const proc = start('tsx', ['src/server/main.ts', '--port', String(port)]);
  try {
    await until(
      'the control server',
      async () => {
        if (proc.child.exitCode !== null) throw new Error(`control server exited: ${proc.stderr}`);
        return fetch(`http://${HOST}:${port}/api/state`).then(
          (res) => res.ok,
          () => false,
        );
      },
      READY_TIMEOUT_MS,
    );
  } catch (error) {
    await stop(proc, port);
    throw error;
  }
  return proc;
}

/** The dev server, once it answers; `control` is the port its pages talk to. */
export async function startVite(port: number, control: number): Promise<Proc> {
  const proc = start('vite', ['--port', String(port), '--strictPort'], {
    HASHIDATE_CONTROL_PORT: String(control),
  });
  try {
    await until(
      'the dev server',
      async () => {
        if (proc.child.exitCode !== null) throw new Error(`dev server exited: ${proc.stderr}`);
        return fetch(`http://${HOST}:${port}/`).then(
          (res) => res.ok,
          () => false,
        );
      },
      READY_TIMEOUT_MS,
    );
  } catch (error) {
    await stop(proc, port).catch(killAll);
    throw error;
  }
  return proc;
}

export async function avatarReady(control: number, id: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${HOST}:${control}/api/state`);
    const snapshot = (await res.json()) as { avatar?: { phase?: string; id?: string } | null };
    return snapshot.avatar?.phase === 'ready' && snapshot.avatar.id === id;
  } catch {
    return false;
  }
}
