import { readFileSync, writeFileSync } from 'node:fs';
import type { WindowBounds } from './types';

/**
 * What the native shell remembers between runs.
 *
 * Two things, and they are here together because they are the same kind of
 * thing: how the operator left the windows, and whether the stage window is
 * allowed to make a sound. Neither is a setting the control API has any
 * business knowing — one is where a window is on a desk, the other is which
 * speakers a broadcast comes out of on this machine — so neither travels on
 * the wire, and both live in a small file beside the profile.
 */

export type WindowKey = 'control' | 'stage';

/** A display rectangle is all that is needed to answer the visibility check. */
export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const STATE_FILE_NAME = 'shell-state.json';

const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;

/**
 * How long a move or a resize waits before it is written down.
 *
 * Dragging a window fires `move` for every frame of the drag, and the store
 * writes synchronously — see below for why. Written on each one, a window
 * pushed across a desk is a few hundred synchronous file writes on the main
 * process, which is the process holding the audio of the renderer in the other
 * window. Coalescing costs nothing that matters: what is being remembered is
 * where the drag *ended*.
 */
export const WRITE_DELAY_MS = 400;

/** Keep malformed or stale settings from making a window impossible to reach. */
export function isValidWindowBounds(value: unknown): value is WindowBounds {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WindowBounds>;
  return (
    typeof candidate.x === 'number' &&
    typeof candidate.y === 'number' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    Number.isInteger(candidate.x) &&
    Number.isInteger(candidate.y) &&
    Number.isInteger(candidate.width) &&
    Number.isInteger(candidate.height) &&
    candidate.width >= MIN_WIDTH &&
    candidate.height >= MIN_HEIGHT
  );
}

/** A saved rectangle is usable when any portion remains on a current display. */
export function isVisibleWindowBounds(
  bounds: WindowBounds,
  displays: readonly DisplayBounds[],
): boolean {
  return displays.some((display) => {
    const right = Math.min(bounds.x + bounds.width, display.x + display.width);
    const bottom = Math.min(bounds.y + bounds.height, display.y + display.height);
    const left = Math.max(bounds.x, display.x);
    const top = Math.max(bounds.y, display.y);
    return right > left && bottom > top;
  });
}

/** Restore only a valid, currently visible rectangle. */
export function restoreWindowBounds(
  value: unknown,
  fallback: WindowBounds,
  displays: readonly DisplayBounds[],
): WindowBounds {
  return isValidWindowBounds(value) && isVisibleWindowBounds(value, displays) ? value : fallback;
}

/**
 * Durable shell settings.
 *
 * Writes are synchronous because a change immediately followed by quit must not
 * be lost, and the file is a few hundred bytes. They are also delayed, because
 * the change that arrives most often arrives hundreds of times in a row; see
 * `WRITE_DELAY_MS`. `flush` is the pairing of those two: a window closing or an
 * application quitting takes the pending write now rather than losing it to the
 * timer that was still counting.
 */
export class ShellState {
  private readonly windows: Partial<Record<WindowKey, WindowBounds>> = {};
  private muted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;

  constructor(private readonly filePath: string) {
    const read = this.read();
    this.windows = read.windows;
    this.muted = read.stageMuted;
  }

  restore(
    key: WindowKey,
    fallback: WindowBounds,
    displays: readonly DisplayBounds[],
  ): WindowBounds {
    return restoreWindowBounds(this.windows[key], fallback, displays);
  }

  remember(key: WindowKey, bounds: WindowBounds): void {
    if (!isValidWindowBounds(bounds)) return;
    const held = this.windows[key];
    if (
      held !== undefined &&
      held.x === bounds.x &&
      held.y === bounds.y &&
      held.width === bounds.width &&
      held.height === bounds.height
    ) {
      return;
    }
    this.windows[key] = { ...bounds };
    this.schedule();
  }

  /** Whether the stage window opens silent. See `src/shell/main.ts`. */
  get stageMuted(): boolean {
    return this.muted;
  }

  /**
   * Written straight through rather than scheduled: this one is a deliberate
   * click, it happens once a session, and the window reload that follows it
   * wants the file already true.
   */
  setStageMuted(value: boolean): void {
    if (this.muted === value) return;
    this.muted = value;
    this.pending = true;
    this.flush();
  }

  /** Take any delayed write now. Safe to call when there is nothing to take. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    this.pending = false;
    try {
      writeFileSync(this.filePath, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8');
    } catch {
      // A read-only profile should not prevent a shell from opening. The next
      // launch simply starts at its defaults again.
    }
  }

  private snapshot(): { windows: Partial<Record<WindowKey, WindowBounds>>; stageMuted: boolean } {
    return { windows: this.windows, stageMuted: this.muted };
  }

  private schedule(): void {
    this.pending = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, WRITE_DELAY_MS);
    // A pending placement must never be the reason a process stays up.
    this.timer.unref?.();
  }

  private read(): {
    windows: Partial<Record<WindowKey, WindowBounds>>;
    stageMuted: boolean;
  } {
    const empty = { windows: {}, stageMuted: false };
    try {
      const value: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (typeof value !== 'object' || value === null) return empty;
      const record = value as { windows?: unknown; stageMuted?: unknown };
      const windows: Partial<Record<WindowKey, WindowBounds>> = {};
      const saved = (
        typeof record.windows === 'object' && record.windows !== null ? record.windows : {}
      ) as Record<string, unknown>;
      for (const key of ['control', 'stage'] as const) {
        if (isValidWindowBounds(saved[key])) windows[key] = saved[key];
      }
      return { windows, stageMuted: record.stageMuted === true };
    } catch {
      return empty;
    }
  }
}
