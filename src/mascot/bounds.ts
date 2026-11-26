import { SHOT_LIMITS, type ShotAngle, wrapYaw } from '../engine/types/staging';
import { type DisplayInfo, displayUnder } from '../shell/displays';
import {
  MASCOT_SCALE_FULL,
  MASCOT_SCALE_MAX,
  MASCOT_SCALE_MIN,
  type MascotMode,
  type MascotSaved,
  type MascotState,
} from '../shell/state';
import type { WindowBounds } from '../shell/types';

/**
 * Where the mascot window goes, and what a drag, a size step or a menu choice
 * makes of that.
 *
 * Pure, so the arithmetic is checked without Electron: `main.ts` feeds it
 * `screen.getAllDisplays()` with the primary display first, and applies the
 * rectangle it is given. A size is a share of the height the display leaves
 * between the menu bar and the dock, so the same setting reads the same on a
 * laptop and on the monitor beside it. In a corner a window taller than the work
 * area is lined up with its top and its feet hang below; in the open it stays
 * where it was dropped while its head is on a work area. Its display is the one
 * its head is on.
 */

/**
 * The window's width as a share of its height. Wide enough that a full-length
 * figure with its arms out is not cut at the hands, and no wider, since every
 * pixel of the window is one the pointer has to be tested against.
 */
export const WIDTH_RATIO = 0.45;

/**
 * The head point is the window's horizontal centre, this share of its height
 * below its top.
 */
export const HEAD_DEPTH = 0.08;

/** How far a mascot in a corner stands from the edges of the work area, in pixels. */
export const EDGE_MARGIN = 16;

/**
 * One step of size, and the number of them in a unit. The grid is where the
 * menu's steps land, not an invariant of a saved size.
 */
export const SCALE_STEP = 0.05;
const STEPS_PER_UNIT = 20;

/** Where "reset position" puts the mascot, and where a first run starts. */
export const RESET_MODE = 'bottom-right' satisfies MascotMode;
export const RESET_SCALE = 0.5;

/** The size a mascot filling the height steps down to. */
const BELOW_FULL_SCALE = MASCOT_SCALE_FULL - SCALE_STEP;
const ABOVE_FULL_SCALE = MASCOT_SCALE_FULL + SCALE_STEP;

/**
 * How long after the last movement of a drag the placement is saved, in ms.
 * The bridge reports movement and never the release, so the end of a drag is
 * the movement that nothing followed.
 */
export const DRAG_SETTLE_MS = 300;

export const DEFAULT_MASCOT_STATE: MascotState = {
  mode: RESET_MODE,
  scale: RESET_SCALE,
  muted: false,
};

export type MascotAction =
  /** The window was dragged, and is now here. */
  | { type: 'move'; bounds: WindowBounds }
  | { type: 'stepScale'; dir: 1 | -1 }
  /** A continuous resize by a factor. */
  | { type: 'scaleBy'; factor: number }
  /** The character turned to face this way. */
  | { type: 'turn'; angle: ShotAngle }
  | { type: 'faceFront' }
  /** A mode chosen from a menu. */
  | { type: 'mode'; mode: MascotMode }
  | { type: 'reset' };

interface Point {
  x: number;
  y: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(value, high));

function sizeAt(scale: number, display: DisplayInfo): { width: number; height: number } {
  const { workArea } = display;
  // Capped so the width stays inside the work area; the saved scale is untouched.
  const height = Math.min(
    Math.round((workArea.height - EDGE_MARGIN) * scale),
    Math.floor((workArea.width - 2 * EDGE_MARGIN) / WIDTH_RATIO),
  );
  return { width: Math.round(height * WIDTH_RATIO), height };
}

/** The middle of a rectangle's bottom edge: where the character's feet are. */
function footOf(bounds: WindowBounds): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
}

/**
 * A foot point moved the least it has to be for the head point to lie in the
 * closed work area, on whole pixels that keep it there. A head already inside
 * leaves the foot as it is; the rest of the window may hang outside.
 */
function reach(foot: Point, scale: number, display: DisplayInfo): Point {
  const area = display.workArea;
  const { height } = sizeAt(scale, display);
  const headY = (y: number): number => y - height + height * HEAD_DEPTH;
  return {
    x: pull(foot.x, (x) => x, area.x, area.x + area.width),
    y: pull(foot.y, headY, area.y, area.y + area.height),
  };
}

/** One axis of `reach`: `headOf` maps a foot coordinate to its head's. */
function pull(foot: number, headOf: (foot: number) => number, low: number, high: number): number {
  const head = headOf(foot);
  if (head >= low && head <= high) return foot;
  const target = head < low ? low : high;
  let landed = Math.round(foot + (target - head));
  // Rounding may land a hair outside: step back in, by whole pixels.
  while (headOf(landed) < low) landed += 1;
  while (headOf(landed) > high) landed -= 1;
  return landed;
}

const keyOf = ({ id, label, bounds }: DisplayInfo): MascotSaved['display'] => ({
  id,
  label,
  width: bounds.width,
  height: bounds.height,
});

/**
 * The window's rectangle on one display.
 *
 * `scale` is ignored while the mascot fills the height, and `saved` by every
 * mode but `free` — which, with no point to return to, stands in the bottom
 * right corner.
 */
export function mascotBounds(
  mode: MascotMode,
  scale: number,
  display: DisplayInfo,
  saved?: Point,
): WindowBounds {
  const area = display.workArea;
  if (mode === 'full') {
    const width = Math.round(area.height * WIDTH_RATIO);
    return { x: area.x + area.width - width, y: area.y, width, height: area.height };
  }
  const { width, height } = sizeAt(scale, display);
  if (mode === 'free' && saved !== undefined) {
    const foot = reach(saved, scale, display);
    return { x: Math.round(foot.x - width / 2), y: Math.round(foot.y - height), width, height };
  }
  return {
    x: mode === 'bottom-left' ? area.x + EDGE_MARGIN : area.x + area.width - EDGE_MARGIN - width,
    y: Math.max(area.y, area.y + area.height - EDGE_MARGIN - height),
    width,
    height,
  };
}

/**
 * The connected display a saved one refers to, or null when it is gone.
 *
 * By id first. An id does not always survive a reconnect, so failing that the
 * display with the same name and the same size is taken to be the same one.
 */
export function findDisplay(
  saved: MascotSaved['display'],
  displays: readonly DisplayInfo[],
): DisplayInfo | null {
  return (
    displays.find((display) => display.id === saved.id) ??
    displays.find(
      ({ label, bounds }) =>
        label === saved.label && bounds.width === saved.width && bounds.height === saved.height,
    ) ??
    null
  );
}

/**
 * The display a state belongs to, or null when the one it names is gone. A
 * state that names none belongs to the primary display.
 */
function homeOf(state: MascotState, displays: readonly DisplayInfo[]): DisplayInfo | null {
  if (state.saved === undefined) return displays[0] ?? null;
  return findDisplay(state.saved.display, displays);
}

/**
 * Where the window goes for a state, given the displays connected now with the
 * primary one first.
 *
 * A mascot whose display is gone moves to the primary one: a corner mode keeps
 * its corner there, and a free one stands in the bottom right at its own size.
 * The state is not changed by this, so plugging the display back in puts the
 * mascot back where it was.
 */
export function placeMascot(state: MascotState, displays: readonly DisplayInfo[]): WindowBounds {
  const primary = displays[0];
  if (primary === undefined) throw new Error('a mascot needs a display to stand on');
  const home = homeOf(state, displays);
  if (home !== null) return mascotBounds(state.mode, state.scale, home, state.saved);
  return mascotBounds(state.mode === 'free' ? RESET_MODE : state.mode, state.scale, primary);
}

/**
 * The display a window belongs to: the one its head point is on, so a tall
 * window hanging below one display stays with the display of its head.
 * Failing that the one its centre is over, then the primary.
 */
export function mascotDisplayOf(
  bounds: WindowBounds,
  displays: readonly DisplayInfo[],
): DisplayInfo | undefined {
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height * HEAD_DEPTH;
  return (
    displays.find(
      ({ bounds: b }) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height,
    ) ??
    displayUnder(bounds, displays) ??
    displays[0]
  );
}

function step(scale: number, dir: 1 | -1): number {
  return clamp(
    Math.round(scale * STEPS_PER_UNIT + dir) / STEPS_PER_UNIT,
    MASCOT_SCALE_MIN,
    MASCOT_SCALE_MAX,
  );
}

function moved(
  state: MascotState,
  bounds: WindowBounds,
  displays: readonly DisplayInfo[],
): MascotState {
  const display = mascotDisplayOf(bounds, displays);
  if (display === undefined) return state;
  // Dragged out of the full height it keeps its size.
  const scale = state.mode === 'full' ? MASCOT_SCALE_FULL : state.scale;
  return {
    ...state,
    mode: 'free',
    scale,
    saved: { ...reach(footOf(bounds), scale, display), display: keyOf(display) },
  };
}

/** The state at a new size: a corner holds itself, and in the open the feet stay put. */
function rescaled(
  state: MascotState,
  scale: number,
  displays: readonly DisplayInfo[],
): MascotState {
  if (state.mode === 'full') {
    return scale === MASCOT_SCALE_FULL ? state : { ...state, mode: RESET_MODE, scale };
  }
  if (scale === state.scale) return state;
  // Unless the head no longer fits there — then the point it was pushed back to is the one kept.
  const home = state.mode === 'free' && state.saved !== undefined ? homeOf(state, displays) : null;
  if (home === null || state.saved === undefined) return { ...state, scale };
  return {
    ...state,
    scale,
    saved: { ...reach(state.saved, scale, home), display: keyOf(home) },
  };
}

function scaled(state: MascotState, dir: 1 | -1, displays: readonly DisplayInfo[]): MascotState {
  if (state.mode === 'full') {
    return rescaled(state, dir === 1 ? ABOVE_FULL_SCALE : BELOW_FULL_SCALE, displays);
  }
  return rescaled(state, step(state.scale, dir), displays);
}

function scaledBy(
  state: MascotState,
  factor: number,
  displays: readonly DisplayInfo[],
): MascotState {
  // The full height is a size of its own, so from there a factor is taken against that.
  const base = state.mode === 'full' ? MASCOT_SCALE_FULL : state.scale;
  return rescaled(state, clamp(base * factor, MASCOT_SCALE_MIN, MASCOT_SCALE_MAX), displays);
}

function turned(state: MascotState, { yaw, pitch }: ShotAngle): MascotState {
  return {
    ...state,
    angle: { yaw: wrapYaw(yaw), pitch: clamp(pitch, SHOT_LIMITS.pitch.min, SHOT_LIMITS.pitch.max) },
  };
}

function switched(
  state: MascotState,
  mode: MascotMode,
  displays: readonly DisplayInfo[],
): MascotState {
  if (mode !== 'free' || state.saved !== undefined) return { ...state, mode };
  // Never dragged, so there is no point to go back to: it is set free where it stands.
  const primary = displays[0];
  if (primary === undefined) return { ...state, mode };
  const scale = state.mode === 'full' ? MASCOT_SCALE_FULL : state.scale;
  const foot = footOf(mascotBounds(state.mode, state.scale, primary));
  return {
    ...state,
    mode,
    scale,
    saved: { ...reach(foot, scale, primary), display: keyOf(primary) },
  };
}

/**
 * What a state becomes. `displays` are the ones connected now, primary first.
 *
 * `muted` is carried through untouched: silence is not a placement.
 */
export function nextMascotState(
  state: MascotState,
  action: MascotAction,
  displays: readonly DisplayInfo[],
): MascotState {
  switch (action.type) {
    case 'move':
      return moved(state, action.bounds, displays);
    case 'stepScale':
      return scaled(state, action.dir, displays);
    case 'scaleBy':
      return scaledBy(state, action.factor, displays);
    case 'turn':
      return turned(state, action.angle);
    case 'faceFront': {
      const { angle: _front, ...rest } = state;
      return rest;
    }
    case 'mode':
      return switched(state, action.mode, displays);
    case 'reset':
      return { ...state, mode: RESET_MODE, scale: RESET_SCALE };
  }
}
