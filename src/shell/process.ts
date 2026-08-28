import { type ChildProcess, type SpawnOptions, spawn as spawnProcess } from 'node:child_process';
import { closeSync, constants as fsConstants, openSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { type ServerRoots, snapshotSchema } from '../protocol';
import { askSidecar, type SpeechEndpoint, speechEndpoint } from '../speech/sidecar';
import { controlPort, controlURL, type ShellPaths } from './config';

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STOP_TIMEOUT_MS = 4_000;

type FetchLike = typeof fetch;
type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ControlProcessOptions {
  paths: ShellPaths;
  port?: number;
  nodePath?: string;
  /** What a server on this port must say it is serving to count as ours. */
  roots?: ServerRoots | null;
  /** Where the child's output goes. Absent means nowhere. */
  logFile?: string;
  spawn?: SpawnLike;
  fetch?: FetchLike;
  readyTimeoutMs?: number;
  probeTimeoutMs?: number;
  pollIntervalMs?: number;
  stopTimeoutMs?: number;
}

export interface TtsProcessOptions {
  paths: ShellPaths;
  /** Where the sidecar answers. Defaults to this checkout's socket. */
  endpoint?: SpeechEndpoint;
  logFile?: string;
  spawn?: SpawnLike;
  probeTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/**
 * What is on the control port.
 *
 * Three answers rather than a boolean, because the middle one is the whole
 * reason this exists. A listener that speaks this API is not necessarily
 * *ours*: two checkouts of this project answer `/api/state` identically, and
 * adopting the wrong one gives an operator two windows loaded from somebody
 * else's build, a menu that opens this checkout's show directories while
 * driving another, and no error anywhere — the failure looks like a blank
 * renderer. So a server is only adopted when it says it is serving the
 * directories this checkout would serve. See `serverRootsSchema`.
 */
export type ControlProbe =
  | { kind: 'silent' }
  | { kind: 'ours' }
  | { kind: 'foreign'; roots: ServerRoots | null };

/** Whether two servers were started on the same three directories. */
function sameRoots(found: ServerRoots | undefined, expected: ServerRoots): boolean {
  return (
    found !== undefined &&
    found.document === expected.document &&
    found.slides === expected.slides &&
    found.motions === expected.motions
  );
}

/**
 * Fetch `/api/state` and work out what answered.
 *
 * With no `roots` to compare against, any valid snapshot counts as ours, which
 * is the answer a caller that only wants to know whether the API is up wants.
 */
export async function probeControlAPI(
  port: number,
  {
    fetch: fetchImpl = fetch,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    roots = null,
  }: { fetch?: FetchLike; timeoutMs?: number; roots?: ServerRoots | null } = {},
): Promise<ControlProbe> {
  try {
    const response = await fetchImpl(controlURL(port), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { kind: 'silent' };
    const body: unknown = await response.json();
    const parsed = snapshotSchema.safeParse(body);
    if (!parsed.success) return { kind: 'silent' };
    if (roots === null || sameRoots(parsed.data.roots, roots)) return { kind: 'ours' };
    return { kind: 'foreign', roots: parsed.data.roots ?? null };
  } catch {
    return { kind: 'silent' };
  }
}

/** The probe as a yes or no, for callers with nothing to decide. */
export async function controlAPIReady(
  port: number,
  options: { fetch?: FetchLike; timeoutMs?: number; roots?: ServerRoots | null } = {},
): Promise<boolean> {
  return (await probeControlAPI(port, options)).kind === 'ours';
}

/** How a foreign server on the port is explained to whoever started this one. */
export function foreignServerMessage(
  port: number,
  found: ServerRoots | null,
  expected: ServerRoots,
): string {
  const serving =
    found === null
      ? 'a control server that does not say where it is serving from'
      : `a control server for ${found.document}`;
  return [
    `:${port} is held by ${serving},`,
    `but this checkout serves ${expected.document}.`,
    'Stop it, or start this one on another port with HASHIDATE_CONTROL_PORT.',
  ].join(' ');
}

/** Poll an HTTP API until it answers, or explain why startup could not continue. */
export async function waitForControlAPI(
  port: number,
  {
    fetch: fetchImpl = fetch,
    timeoutMs = DEFAULT_READY_TIMEOUT_MS,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    roots = null,
    isAlive,
  }: {
    fetch?: FetchLike;
    timeoutMs?: number;
    probeTimeoutMs?: number;
    pollIntervalMs?: number;
    roots?: ServerRoots | null;
    /** Optional early-stop hook used by a process supervisor. */
    isAlive?: () => boolean;
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await probeControlAPI(port, {
      fetch: fetchImpl,
      timeoutMs: probeTimeoutMs,
      roots,
    });
    if (probe.kind === 'ours') return;
    if (isAlive && !isAlive()) {
      throw new Error(`control server exited before its API became ready on :${port}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (probe.kind === 'foreign' && roots !== null) {
        throw new Error(foreignServerMessage(port, probe.roots, roots));
      }
      throw new Error(`control server did not answer on http://127.0.0.1:${port}/api/state`);
    }
    await delay(Math.min(pollIntervalMs, remaining));
  }
}

/**
 * The environment a child gets: this process's, minus what only applies here.
 *
 * `NODE_OPTIONS` is the one that matters. The shell is launched with a loader
 * flag in it so that Electron can run this TypeScript directly, and inherited
 * unchanged that flag is applied a second time to a child that is already
 * being started with its own loader — and to the Python sidecar, which has no
 * use for it at all. Nothing downstream needs to be told how this process was
 * started.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { NODE_OPTIONS: _dropped, ...rest } = process.env;
  return { ...rest, ...extra };
}

/**
 * Where a child's output goes, as `spawn` wants it.
 *
 * Silence was the earlier answer and it was the wrong one: a speech sidecar
 * that fails to load its model, or a control server that throws on startup, is
 * exactly the failure an operator later describes as "there is no sound", and
 * with the pipe thrown away there is nothing anywhere to read. The file is
 * appended to rather than truncated, so a crash loop leaves its whole history.
 */
function logStdio(logFile: string | undefined): {
  stdio: SpawnOptions['stdio'];
  fd: number | null;
} {
  if (logFile === undefined) return { stdio: 'ignore', fd: null };
  try {
    const fd = openSync(logFile, 'a');
    return { stdio: ['ignore', fd, fd], fd };
  } catch {
    // An unwritable log directory is not a reason to refuse to start.
    return { stdio: 'ignore', fd: null };
  }
}

/**
 * Owns the control child only when this shell started it.
 *
 * The first probe is important: a developer may already have `yarn dev` up,
 * and taking that process down on Electron quit would be a surprising and
 * destructive side effect. If a child loses a port race, a final probe gives a
 * pre-existing server the same adoption treatment. What is adopted is checked
 * rather than assumed — see `ControlProbe`.
 */
export class ControlProcess {
  readonly port: number;
  private readonly paths: ShellPaths;
  private readonly nodePath: string;
  private readonly roots: ServerRoots | null;
  private readonly logFile: string | undefined;
  private readonly spawn: SpawnLike;
  private readonly fetch: FetchLike;
  private readonly readyTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly stopTimeoutMs: number;
  private child: ChildProcess | null = null;
  private owned = false;
  private exited = false;
  private starting: Promise<void> | null = null;
  /**
   * Set by `stop`, and never unset.
   *
   * Startup waits on the API before any window exists, so the only thing on
   * screen during it is the menu — and quitting from there runs `stop` while
   * `start` is still inside its first probe, with no child to stop yet. Without
   * this the spawn that follows would leave a server running after the
   * application it belonged to had gone.
   */
  private stopped = false;

  constructor(options: ControlProcessOptions) {
    this.paths = options.paths;
    this.port = options.port ?? controlPort();
    this.nodePath = options.nodePath ?? process.execPath;
    this.roots = options.roots ?? null;
    this.logFile = options.logFile;
    this.spawn = options.spawn ?? spawnProcess;
    this.fetch = options.fetch ?? fetch;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  /** True only for a child this process launched and may therefore stop. */
  get ownsChild(): boolean {
    return this.owned;
  }

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startOnce();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // A start still in flight may be between its probe and its spawn. Letting
    // it finish first is what makes the flag above enough: whatever it starts,
    // it will not keep.
    if (this.starting !== null) await this.starting.catch(() => {});

    const child = this.child;
    if (!this.owned || child === null) return;

    this.owned = false;
    if (this.exited || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }

    child.kill('SIGTERM');
    const stopped = await waitForChild(child, this.stopTimeoutMs);
    if (!(stopped || this.exited)) {
      child.kill('SIGKILL');
      await waitForChild(child, this.stopTimeoutMs);
    }
    this.child = null;
  }

  private async startOnce(): Promise<void> {
    const found = await probeControlAPI(this.port, {
      fetch: this.fetch,
      timeoutMs: this.probeTimeoutMs,
      roots: this.roots,
    });
    if (found.kind === 'ours') {
      // A pre-existing server is deliberately not assigned to `child`.
      this.owned = false;
      this.child = null;
      this.exited = false;
      return;
    }
    // Somebody else's server, on the port this one needs. Said rather than
    // worked around: starting a child now only loses the bind, and adopting it
    // would drive one checkout from another's windows.
    if (found.kind === 'foreign' && this.roots !== null) {
      throw new Error(foreignServerMessage(this.port, found.roots, this.roots));
    }
    if (this.stopped) return;

    const log = logStdio(this.logFile);
    let child: ChildProcess;
    try {
      child = this.spawn(this.nodePath, this.controlArgs(), {
        cwd: this.paths.root,
        // Electron's executable can run as its bundled Node when this is set.
        // It keeps the checkout runnable without assuming a second system Node
        // path, while remaining harmless if nodePath is `node`.
        env: childEnv({ ELECTRON_RUN_AS_NODE: '1' }),
        stdio: log.stdio,
        windowsHide: true,
      });
    } catch (error) {
      if (await controlAPIReady(this.port, { fetch: this.fetch, timeoutMs: this.probeTimeoutMs })) {
        this.owned = false;
        this.child = null;
        return;
      }
      throw new Error(`could not start control server: ${reason(error)}`);
    } finally {
      // The child has its own copy of the descriptor by now.
      if (log.fd !== null) closeSync(log.fd);
    }

    this.child = child;
    this.owned = true;
    this.exited = false;
    child.once('exit', () => {
      this.exited = true;
    });
    child.once('error', (error) => {
      // The child is intentionally not restarted. A shell that silently
      // starts a second server can take over a port after an operator has
      // diagnosed the first failure; status polling will show it as down.
      console.error(`control server child failed: ${reason(error)}`);
      this.exited = true;
    });

    try {
      await waitForControlAPI(this.port, {
        fetch: this.fetch,
        timeoutMs: this.readyTimeoutMs,
        probeTimeoutMs: this.probeTimeoutMs,
        pollIntervalMs: this.pollIntervalMs,
        roots: this.roots,
        // A quit gives up on the wait as flatly as a dead child does. Twenty
        // seconds of a window nobody will see is twenty seconds an operator
        // spends looking at an application that will not close.
        isAlive: () => !(this.exited || this.stopped),
      });
    } catch (error) {
      // A listener can win the bind race between our first probe and spawn.
      // Adopt it as external, and never kill it during quit — but only if it
      // is this checkout's, on the same rule as the first probe.
      const adopted = await controlAPIReady(this.port, {
        fetch: this.fetch,
        timeoutMs: this.probeTimeoutMs,
        roots: this.roots,
      });
      this.owned = false;
      await terminateChild(child, this.stopTimeoutMs);
      this.child = null;
      // A shell that is closing has nothing to report and nowhere to report it.
      if (adopted || this.stopped) return;
      throw error;
    }
  }

  /**
   * The server, run directly rather than under `tsx`'s launcher.
   *
   * `tsx <file>` starts a wrapper that starts the process that binds the port,
   * so the listener is a grandchild. It forwards a `SIGTERM`, which covers the
   * ordinary stop — but not the `SIGKILL` a wedged child gets, which kills the
   * wrapper and leaves the listener holding :8765 with nothing to answer to.
   * The next launch then finds an orphan on the port and adopts it. Registering
   * the loader with `--import` puts the server in the child itself, so there is
   * only ever one process to signal.
   */
  private controlArgs(): string[] {
    return [
      '--import',
      this.paths.tsx,
      this.paths.server,
      '--port',
      String(this.port),
      '--root',
      this.paths.dist,
      '--slides',
      this.paths.slides,
      '--scripts',
      this.paths.scripts,
      '--motions',
      this.paths.motions,
      '--recordings',
      this.paths.recordings,
    ];
  }
}

/** A sidecar child is optional and is also never claimed when already running. */
export class TtsProcess {
  readonly endpoint: SpeechEndpoint;
  private readonly paths: ShellPaths;
  private readonly logFile: string | undefined;
  private readonly spawn: SpawnLike;
  private readonly probeTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private child: ChildProcess | null = null;
  private owned = false;
  private exited = false;
  /** See `ControlProcess.stopped`. This one is started without being waited on. */
  private stopped = false;

  constructor(options: TtsProcessOptions) {
    this.paths = options.paths;
    this.endpoint = options.endpoint ?? speechEndpoint();
    this.logFile = options.logFile;
    this.spawn = options.spawn ?? spawnProcess;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  get available(): boolean {
    return this.child !== null && !this.exited;
  }

  get ownsChild(): boolean {
    return this.owned;
  }

  /** Start only when the checkout has the private Python environment. */
  async start(): Promise<void> {
    if (!(await executable(this.paths.ttsPython))) return;
    if (await ttsAPIReady(this.endpoint, this.probeTimeoutMs)) return;
    // Model loading takes the better part of a minute, so this one is started
    // and never awaited — which leaves a longer gap than the control server's
    // between a quit and the spawn it has to beat.
    if (this.stopped) return;

    const log = logStdio(this.logFile);
    let child: ChildProcess;
    try {
      child = this.spawn(this.paths.ttsPython, ['server.py', ...sidecarArgs(this.endpoint)], {
        cwd: this.paths.tts,
        // Told on the command line and in the environment both. The argument is
        // what this child binds; the variable is what a process it starts would
        // read, and it is also what makes a `ps` line say where the voice is
        // rather than only that there is one.
        env: childEnv(sidecarEnv(this.endpoint)),
        stdio: log.stdio,
        windowsHide: true,
      });
    } catch (error) {
      console.error(`could not start optional speech sidecar: ${reason(error)}`);
      return;
    } finally {
      if (log.fd !== null) closeSync(log.fd);
    }

    this.child = child;
    this.owned = true;
    this.exited = false;
    child.once('exit', () => {
      this.exited = true;
    });
    child.once('error', (error) => {
      console.error(`speech sidecar child failed: ${reason(error)}`);
      this.exited = true;
    });

    if (this.stopped) await this.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!this.owned || child === null) return;
    this.owned = false;
    if (!this.exited && child.exitCode === null && child.signalCode === null) {
      await terminateChild(child, this.stopTimeoutMs);
    }
    this.child = null;
  }
}

/** How the sidecar is told where to answer, on its own command line. */
function sidecarArgs(endpoint: SpeechEndpoint): string[] {
  return endpoint.kind === 'socket' ? ['--uds', endpoint.path] : ['--port', String(endpoint.port)];
}

/** The same thing as an environment, for a child that reads it that way. */
function sidecarEnv(endpoint: SpeechEndpoint): Record<string, string> {
  return endpoint.kind === 'socket'
    ? { HASHIDATE_TTS_SOCKET: endpoint.path }
    : { HASHIDATE_TTS_PORT: String(endpoint.port) };
}

/**
 * Whether a sidecar is already answering, which is the only reason this shell
 * does not start one. A socket file with nothing behind it fails to connect and
 * is therefore not one — the sidecar clears it on the way up.
 */
async function ttsAPIReady(endpoint: SpeechEndpoint, timeoutMs: number): Promise<boolean> {
  try {
    const reply = await askSidecar(endpoint, '/health', { timeoutMs });
    if (reply.status < 200 || reply.status > 299) return false;
    const body: unknown = JSON.parse(reply.body.toString('utf8'));
    return typeof body === 'object' && body !== null && 'ready' in body;
  } catch {
    return false;
  }
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function terminateChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForChild(child, timeoutMs)) return;
  child.kill('SIGKILL');
  await waitForChild(child, timeoutMs);
}

function waitForChild(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (stopped: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('close', onClose);
      resolve(stopped);
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    child.once('close', onClose);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
