import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { SHOT_LIMITS, type ShotAngle } from '../engine/types/staging';
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

/**
 * How the mascot window is placed: filling the display's height, standing in
 * a bottom corner, or wherever it was last dragged to.
 */
export const MASCOT_MODES = ['full', 'bottom-right', 'bottom-left', 'free'] as const;

export type MascotMode = (typeof MASCOT_MODES)[number];

/**
 * The mascot's size, as a share of the height it has to stand in. Above 1 the
 * window is taller than the work area. Unrelated to the bridge's `SCALE_BY_LIMITS`,
 * which bounds one request's factor.
 */
export const MASCOT_SCALE_MIN = 0.25;
export const MASCOT_SCALE_MAX = 2;
/** The size of a mascot filling the height. */
export const MASCOT_SCALE_FULL = 1;

/**
 * Where a dragged mascot stands: the middle of its bottom edge, in screen
 * pixels, and enough about the display it was on to find that display again
 * after its id has changed.
 */
export interface MascotSaved {
  x: number;
  y: number;
  display: { id: number; label: string; width: number; height: number };
}

/**
 * What the mascot window remembers. The shell's own windows never read it and
 * the mascot never reads theirs; the two share a profile, so they share a file.
 */
export interface MascotState {
  mode: MascotMode;
  scale: number;
  /** Whether the mascot opens silent. See `mascotPageURL`. */
  muted: boolean;
  saved?: MascotSaved;
  /** Which way the character faces; absent is the front. */
  angle?: ShotAngle;
}

function isValidMascotSaved(value: unknown): value is MascotSaved {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y, display } = value as Partial<Record<keyof MascotSaved, unknown>>;
  if (!(Number.isFinite(x) && Number.isFinite(y))) return false;
  if (typeof display !== 'object' || display === null) return false;
  const { id, label, width, height } = display as Partial<
    Record<keyof MascotSaved['display'], unknown>
  >;
  return (
    Number.isInteger(id) &&
    typeof label === 'string' &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  );
}

function isValidMascotAngle(value: unknown): value is ShotAngle {
  if (typeof value !== 'object' || value === null) return false;
  const { yaw, pitch } = value as Partial<Record<keyof ShotAngle, unknown>>;
  return (
    typeof yaw === 'number' &&
    typeof pitch === 'number' &&
    Number.isFinite(yaw) &&
    Number.isFinite(pitch) &&
    yaw >= SHOT_LIMITS.yaw.min &&
    yaw <= SHOT_LIMITS.yaw.max &&
    pitch >= SHOT_LIMITS.pitch.min &&
    pitch <= SHOT_LIMITS.pitch.max
  );
}

/** A placement read off disk is used whole or not at all. */
export function isValidMascotState(value: unknown): value is MascotState {
  if (typeof value !== 'object' || value === null) return false;
  const { mode, scale, muted, saved, angle } = value as Partial<Record<keyof MascotState, unknown>>;
  return (
    (MASCOT_MODES as readonly unknown[]).includes(mode) &&
    typeof scale === 'number' &&
    scale >= MASCOT_SCALE_MIN &&
    scale <= MASCOT_SCALE_MAX &&
    typeof muted === 'boolean' &&
    (saved === undefined || isValidMascotSaved(saved)) &&
    (angle === undefined || isValidMascotAngle(angle))
  );
}

/** What the settings file holds. `mascot` is absent until a mascot has run. */
interface StoredState {
  windows: Partial<Record<WindowKey, WindowBounds>>;
  stageMuted: boolean;
  mascot?: MascotState;
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
  private mascotState: MascotState | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;

  constructor(private readonly filePath: string) {
    const read = this.read();
    this.windows = read.windows;
    this.muted = read.stageMuted;
    this.mascotState = read.mascot;
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

  /** How the mascot was left, or null when none has been placed. */
  get mascot(): MascotState | null {
    return this.mascotState === undefined ? null : structuredClone(this.mascotState);
  }

  /** Written straight through, as `setStageMuted` is: the caller has already waited. */
  setMascot(value: MascotState): void {
    if (!isValidMascotState(value)) return;
    this.mascotState = structuredClone(value);
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
    // Temp file in the same directory, then rename: the file is always whole.
    const temp = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8');
      renameSync(temp, this.filePath);
    } catch {
      try {
        unlinkSync(temp);
      } catch {
        // Nothing was created, or it is already gone.
      }
      // A read-only profile should not prevent a shell from opening. The next
      // launch simply starts at its defaults again.
    }
  }

  private snapshot(): StoredState {
    return {
      windows: this.windows,
      stageMuted: this.muted,
      ...(this.mascotState === undefined ? {} : { mascot: this.mascotState }),
    };
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

  private read(): StoredState {
    const empty = { windows: {}, stageMuted: false };
    try {
      const value: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (typeof value !== 'object' || value === null) return empty;
      const record = value as { windows?: unknown; stageMuted?: unknown; mascot?: unknown };
      const windows: Partial<Record<WindowKey, WindowBounds>> = {};
      const saved = (
        typeof record.windows === 'object' && record.windows !== null ? record.windows : {}
      ) as Record<string, unknown>;
      for (const key of ['control', 'stage'] as const) {
        if (isValidWindowBounds(saved[key])) windows[key] = saved[key];
      }
      return {
        windows,
        stageMuted: record.stageMuted === true,
        ...(isValidMascotState(record.mascot) ? { mascot: record.mascot } : {}),
      };
    } catch {
      return empty;
    }
  }
}
