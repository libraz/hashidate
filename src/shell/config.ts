import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerRoots } from '../protocol';

/** The only address the native shell is allowed to load. */
export const LOOPBACK_HOST = '127.0.0.1';

/** The control server's command-line default. */
export const DEFAULT_CONTROL_PORT = 8765;

export const CONTROL_TITLE = 'hashidate — Control';
export const STAGE_TITLE = 'hashidate — Stage';

export const CONTROL_PATH = '/panel/';
export const STAGE_PATH = '/monitor/';

/**
 * A checkout layout as seen by the Electron main process.
 *
 * This is deliberately a path bundle rather than a set of paths handed to a
 * renderer.  The renderer only receives the two loopback URLs below; these
 * paths stay in the main process for starting children and opening show
 * directories in the user's file manager.
 */
export interface ShellPaths {
  root: string;
  dist: string;
  slides: string;
  scripts: string;
  motions: string;
  recordings: string;
  tts: string;
  ttsPython: string;
  /**
   * The TypeScript loader, as something to hand `node --import`.
   *
   * The loader rather than `tsx`'s own launcher, because the launcher starts a
   * second process to do the work and a signal sent to the first one does not
   * always reach it. See `ControlProcess.controlArgs`.
   */
  tsx: string;
  server: string;
}

/** What the children's output is appended to, under Electron's log directory. */
export const CONTROL_LOG_NAME = 'control.log';
export const TTS_LOG_NAME = 'speech.log';

/** Resolve the repository root from this source file in a development checkout. */
export function checkoutPaths(sourceFile = fileURLToPath(import.meta.url)): ShellPaths {
  const root = resolve(dirname(sourceFile), '../..');
  const tts = resolve(root, 'tools/tts');
  return {
    root,
    dist: resolve(root, 'dist'),
    slides: resolve(root, 'show/slides'),
    scripts: resolve(root, 'show/scripts'),
    motions: resolve(root, 'show/motions'),
    recordings: resolve(root, 'show/recordings'),
    tts,
    ttsPython: resolve(tts, '.venv/bin/python'),
    tsx: resolve(root, 'node_modules/tsx/dist/loader.mjs'),
    server: resolve(root, 'src/server/main.ts'),
  };
}

/** Read and validate a port without ever accepting an address override. */
export function portFromEnvironment(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : fallback;
}

export function controlPort(value = process.env.HASHIDATE_CONTROL_PORT): number {
  return portFromEnvironment(value, DEFAULT_CONTROL_PORT);
}

/**
 * The directories a server started on this checkout would report.
 *
 * The mirror of what `src/server/main.ts` hands its hub, and the thing a probe
 * compares against before deciding that a server already on the port is this
 * checkout's rather than another one's. See `serverRootsSchema`.
 */
export function expectedRoots(paths: ShellPaths): ServerRoots {
  return {
    document: paths.dist,
    slides: paths.slides,
    scripts: paths.scripts,
    motions: paths.motions,
    recordings: paths.recordings,
  };
}

export function loopbackURL(port: number, path: string): string {
  return `http://${LOOPBACK_HOST}:${port}${path}`;
}

/**
 * Where the stage window opens, silent or not.
 *
 * The mute is on the URL rather than sent to a page that is already up, which
 * costs a reload — the model is loaded again and the picture is black for a
 * second or two. That is the right trade here and would not have been for the
 * panel's preview: this is the "OBS is monitoring the browser source, so the
 * room is already hearing the character" case, and it is decided once while
 * the desk is being set up rather than reached for during a broadcast. The
 * page reads it as every other renderer does; see `stage-mode.ts`.
 */
export function stageURL(port: number, muted: boolean): string {
  return loopbackURL(port, muted ? `${STAGE_PATH}?mute=1` : STAGE_PATH);
}

export function controlURL(port: number): string {
  return loopbackURL(port, '/api/state');
}

/**
 * Whether a URL is a page that one of the shell's windows is expected to show.
 *
 * The path is exact, while a query and fragment are allowed for future page
 * settings.  In particular, this does not accept `/api/`, `/`, another port,
 * `localhost`, or any non-HTTP origin.
 */
export function isAllowedPageURL(url: string, path: string, port: number): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'http:' &&
      parsed.hostname === LOOPBACK_HOST &&
      parsed.port === String(port) &&
      parsed.pathname === path
    );
  } catch {
    return false;
  }
}
