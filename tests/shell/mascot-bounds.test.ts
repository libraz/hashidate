import { describe, expect, it } from 'vitest';
import {
  findDisplay,
  type MascotAction,
  mascotBounds,
  nextMascotState,
  placeMascot,
} from '@/mascot/bounds';
import type { DisplayInfo } from '@/shell/displays';
import type { DisplayBounds, MascotMode, MascotSaved, MascotState } from '@/shell/state';
import type { WindowBounds } from '@/shell/types';

/**
 * Where the mascot window goes, and where it goes next.
 *
 * Both tables below are pairwise covering arrays, and the expected rectangle
 * is worked out here from the rule as it is stated rather than read back from
 * the code.
 *
 * Placement model, 23 rows:
 *   mode     full, bottom-right, bottom-left, free
 *   scale    0.25, 0.5, 1
 *   display  internal, external, external-left
 *   dock     bottom, left, hidden
 *   saved    none, same, renumbered, gone, overflow
 *
 * Transition model, 30 rows: the same five, and
 *   action   none, move, larger, smaller, reset
 *
 * `display` is the one the saved point names: the built-in screen alone, or an
 * external one to its right or to its left (negative coordinates). `saved` is
 * no point at all, a point on that display, the same with the display's id
 * changed, a point on a display that is no longer connected, or a point past
 * the corner of the work area.
 */

type DisplayCase = 'internal' | 'external' | 'external-left';
type Dock = 'bottom' | 'left' | 'hidden';
type SavedCase = 'none' | 'same' | 'renumbered' | 'gone' | 'overflow';
type ActionCase = 'none' | 'move' | 'larger' | 'smaller' | 'reset';

const MENU_BAR = 25;
const DOCK = 70;

function workArea(bounds: DisplayBounds, dock: Dock): DisplayBounds {
  const below = { ...bounds, y: bounds.y + MENU_BAR, height: bounds.height - MENU_BAR };
  if (dock === 'bottom') return { ...below, height: below.height - DOCK };
  if (dock === 'left') return { ...below, x: below.x + DOCK, width: below.width - DOCK };
  return below;
}

function display(
  id: number,
  label: string,
  internal: boolean,
  bounds: DisplayBounds,
  dock: Dock,
): DisplayInfo {
  return { id, label, internal, bounds, workArea: workArea(bounds, dock) };
}

interface Desk {
  /** The primary display first, as `nextMascotState` and `placeMascot` take them. */
  displays: DisplayInfo[];
  /** The display the saved point names. */
  target: DisplayInfo;
}

function desk(which: DisplayCase, dock: Dock): Desk {
  const internal = display(
    1,
    'Built-in Retina Display',
    true,
    { x: 0, y: 0, width: 1512, height: 982 },
    dock,
  );
  if (which === 'internal') return { displays: [internal], target: internal };
  const x = which === 'external' ? 1512 : -2560;
  const external = display(2, 'DELL U2720Q', false, { x, y: 0, width: 2560, height: 1440 }, dock);
  return { displays: [internal, external], target: external };
}

const keyOf = ({ id, label, bounds }: DisplayInfo): MascotSaved['display'] => ({
  id,
  label,
  width: bounds.width,
  height: bounds.height,
});

function savedFor(which: SavedCase, { target }: Desk): MascotSaved | undefined {
  const area = target.workArea;
  switch (which) {
    case 'none':
      return undefined;
    case 'same':
      return { x: area.x + 400, y: area.y + area.height - 40, display: keyOf(target) };
    case 'renumbered':
      return {
        x: area.x + 400,
        y: area.y + area.height - 40,
        display: { ...keyOf(target), id: target.id + 100 },
      };
    case 'gone':
      return {
        x: 9000,
        y: 500,
        display: { id: 99, label: 'Projector', width: 1920, height: 1080 },
      };
    case 'overflow':
      return {
        x: area.x + area.width + 300,
        y: area.y + area.height + 300,
        display: keyOf(target),
      };
  }
}

// --- the rule, as stated ------------------------------------------------------

const EDGE = 16;
const RATIO = 0.45;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

function sized(area: DisplayBounds, scale: number): { width: number; height: number } {
  const height = Math.round((area.height - EDGE) * scale);
  return { width: Math.round(height * RATIO), height };
}

function ruleFull(area: DisplayBounds): WindowBounds {
  const width = Math.round(area.height * RATIO);
  return { x: area.x + area.width - width, y: area.y, width, height: area.height };
}

function ruleCorner(area: DisplayBounds, scale: number, side: 'left' | 'right'): WindowBounds {
  const { width, height } = sized(area, scale);
  return {
    x: side === 'left' ? area.x + EDGE : area.x + area.width - EDGE - width,
    y: area.y + area.height - EDGE - height,
    width,
    height,
  };
}

function ruleFree(area: DisplayBounds, scale: number, foot: { x: number; y: number }) {
  const { width, height } = sized(area, scale);
  return {
    x: clamp(Math.round(foot.x - width / 2), area.x, area.x + area.width - width),
    y: clamp(Math.round(foot.y - height), area.y, area.y + area.height - height),
    width,
    height,
  };
}

const footOf = (rect: WindowBounds) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height });

/** A saved point moved the least it has to be for the mascot to stand wholly inside. */
function ruleSettle(area: DisplayBounds, scale: number, foot: { x: number; y: number }) {
  const { width, height } = sized(area, scale);
  return {
    x: clamp(foot.x, area.x + width / 2, area.x + area.width - width / 2),
    y: clamp(foot.y, area.y + height, area.y + area.height),
  };
}

/** Where a state belongs, given whether its saved display can still be found. */
function rulePlace(state: MascotState, { displays, target }: Desk, found: boolean): WindowBounds {
  const primary = displays[0] as DisplayInfo;
  const on = state.saved !== undefined && found ? target : primary;
  if (state.mode === 'full') return ruleFull(on.workArea);
  if (state.mode === 'bottom-left') return ruleCorner(on.workArea, state.scale, 'left');
  if (state.mode === 'bottom-right') return ruleCorner(on.workArea, state.scale, 'right');
  // A free mascot with nowhere to return to stands in the primary display's corner.
  if (state.saved === undefined || !found)
    return ruleCorner(primary.workArea, state.scale, 'right');
  return ruleFree(on.workArea, state.scale, state.saved);
}

function inside(rect: WindowBounds, area: DisplayBounds): boolean {
  return (
    rect.x >= area.x &&
    rect.y >= area.y &&
    rect.x + rect.width <= area.x + area.width &&
    rect.y + rect.height <= area.y + area.height
  );
}

// --- placement ----------------------------------------------------------------

const PLACEMENT: readonly [MascotMode, number, DisplayCase, Dock, SavedCase][] = [
  ['bottom-left', 0.25, 'internal', 'left', 'overflow'],
  ['bottom-left', 0.5, 'external-left', 'hidden', 'same'],
  ['bottom-right', 1, 'internal', 'bottom', 'same'],
  ['full', 1, 'external', 'left', 'none'],
  ['free', 1, 'external', 'hidden', 'renumbered'],
  ['free', 0.25, 'external', 'bottom', 'same'],
  ['full', 0.5, 'external-left', 'bottom', 'overflow'],
  ['bottom-right', 0.5, 'external', 'hidden', 'overflow'],
  ['full', 0.25, 'internal', 'hidden', 'gone'],
  ['bottom-left', 1, 'external', 'bottom', 'gone'],
  ['free', 0.5, 'internal', 'left', 'none'],
  ['bottom-right', 0.25, 'external', 'left', 'renumbered'],
  ['full', 0.5, 'external-left', 'left', 'renumbered'],
  ['full', 1, 'internal', 'left', 'same'],
  ['bottom-right', 0.25, 'external-left', 'hidden', 'none'],
  ['bottom-right', 0.5, 'external-left', 'hidden', 'gone'],
  ['bottom-left', 1, 'external-left', 'bottom', 'none'],
  ['bottom-right', 0.5, 'external', 'left', 'gone'],
  ['bottom-right', 1, 'internal', 'left', 'renumbered'],
  ['bottom-left', 0.5, 'internal', 'bottom', 'renumbered'],
  ['free', 0.25, 'external-left', 'hidden', 'overflow'],
  ['free', 1, 'external', 'left', 'overflow'],
  ['free', 0.5, 'external-left', 'hidden', 'gone'],
];

describe('where the mascot is put', () => {
  it.each(PLACEMENT)('%s at %s on %s, dock %s, saved %s', (mode, scale, on, dock, savedCase) => {
    const scene = desk(on, dock);
    const saved = savedFor(savedCase, scene);
    const state: MascotState = { mode, scale, muted: false, ...(saved ? { saved } : {}) };
    const found = savedCase !== 'gone';

    const placed = placeMascot(state, scene.displays);

    expect(placed).toEqual(rulePlace(state, scene, found));
    const home = saved !== undefined && found ? scene.target : (scene.displays[0] as DisplayInfo);
    expect(inside(placed, home.workArea)).toBe(true);
    // On a display that is there, the rectangle is the one the pure rule gives.
    if (found) expect(placed).toEqual(mascotBounds(mode, scale, home, saved));
  });
});

describe('the rectangle of each mode, in figures', () => {
  // The built-in screen with the dock at the bottom: 1512 × 887 from (0, 25).
  const screen = desk('internal', 'bottom').target;

  it('fills the height against the right edge, with no margin', () => {
    expect(mascotBounds('full', 0.5, screen)).toEqual({ x: 1113, y: 25, width: 399, height: 887 });
  });

  it('stands 16 px in from the bottom and the right', () => {
    expect(mascotBounds('bottom-right', 0.5, screen)).toEqual({
      x: 1300,
      y: 460,
      width: 196,
      height: 436,
    });
  });

  it('stands 16 px in from the bottom and the left', () => {
    expect(mascotBounds('bottom-left', 0.25, screen)).toEqual({
      x: 16,
      y: 678,
      width: 98,
      height: 218,
    });
  });

  it('puts the middle of its bottom edge on the saved point', () => {
    expect(mascotBounds('free', 0.5, screen, { x: 700, y: 800 })).toEqual({
      x: 602,
      y: 364,
      width: 196,
      height: 436,
    });
  });

  it('is pushed back inside the work area, not left hanging over its edge', () => {
    expect(mascotBounds('free', 0.5, screen, { x: 5000, y: 5000 })).toEqual({
      x: 1316,
      y: 476,
      width: 196,
      height: 436,
    });
    expect(mascotBounds('free', 0.5, screen, { x: -5000, y: -5000 })).toEqual({
      x: 0,
      y: 25,
      width: 196,
      height: 436,
    });
  });

  it('is 0.45 as wide as it is tall at every size', () => {
    for (let step = 5; step <= 20; step += 1) {
      const { width, height } = mascotBounds('bottom-right', step / 20, screen);
      expect(width).toBe(Math.round(height * 0.45));
    }
  });

  it('ignores the size while it fills the height', () => {
    expect(mascotBounds('full', 0.25, screen)).toEqual(mascotBounds('full', 1, screen));
  });
});

describe('telling a saved display from the ones connected', () => {
  const { displays, target } = desk('external', 'hidden');

  it('finds it by id', () => {
    expect(findDisplay(keyOf(target), displays)).toBe(target);
  });

  it('prefers the id over a display that merely looks the same', () => {
    const twin = { ...target, id: 3, bounds: { ...target.bounds, x: -2560 } };
    expect(findDisplay(keyOf(target), [twin, target])).toBe(target);
  });

  it('falls back to the name and the size when the id has changed', () => {
    expect(findDisplay({ ...keyOf(target), id: 4242 }, displays)).toBe(target);
  });

  it('needs the name and both dimensions to agree', () => {
    const key = { ...keyOf(target), id: 4242 };
    expect(findDisplay({ ...key, label: 'LG UltraFine' }, displays)).toBeNull();
    expect(findDisplay({ ...key, width: 3840 }, displays)).toBeNull();
    expect(findDisplay({ ...key, height: 1600 }, displays)).toBeNull();
  });

  it('finds nothing when nothing is connected', () => {
    expect(findDisplay(keyOf(target), [])).toBeNull();
  });
});

// --- transitions --------------------------------------------------------------

const TRANSITIONS: readonly [MascotMode, number, DisplayCase, Dock, SavedCase, ActionCase][] = [
  ['bottom-left', 1, 'internal', 'left', 'gone', 'reset'],
  ['full', 0.5, 'external-left', 'hidden', 'overflow', 'reset'],
  ['bottom-left', 0.25, 'external', 'hidden', 'none', 'none'],
  ['bottom-right', 0.25, 'external-left', 'bottom', 'same', 'move'],
  ['free', 1, 'internal', 'hidden', 'same', 'larger'],
  ['bottom-right', 0.5, 'internal', 'hidden', 'renumbered', 'move'],
  ['free', 0.5, 'external', 'bottom', 'same', 'reset'],
  ['full', 1, 'external', 'bottom', 'renumbered', 'smaller'],
  ['bottom-left', 0.5, 'internal', 'bottom', 'none', 'larger'],
  ['free', 0.25, 'internal', 'left', 'overflow', 'smaller'],
  ['free', 0.5, 'external-left', 'left', 'none', 'none'],
  ['bottom-right', 0.5, 'external-left', 'hidden', 'gone', 'smaller'],
  ['free', 0.25, 'external', 'left', 'renumbered', 'move'],
  ['free', 0.25, 'external', 'bottom', 'gone', 'larger'],
  ['full', 0.25, 'internal', 'left', 'gone', 'move'],
  ['bottom-left', 0.25, 'external-left', 'left', 'same', 'smaller'],
  ['bottom-right', 1, 'external-left', 'left', 'renumbered', 'larger'],
  ['full', 1, 'internal', 'bottom', 'overflow', 'none'],
  ['free', 0.25, 'external-left', 'left', 'none', 'reset'],
  ['bottom-right', 0.25, 'external', 'bottom', 'overflow', 'none'],
  ['bottom-right', 1, 'internal', 'bottom', 'none', 'smaller'],
  ['bottom-left', 0.5, 'external-left', 'left', 'overflow', 'move'],
  ['bottom-left', 0.25, 'external-left', 'hidden', 'renumbered', 'none'],
  ['full', 0.5, 'external', 'hidden', 'same', 'smaller'],
  ['full', 1, 'external-left', 'hidden', 'none', 'larger'],
  ['bottom-right', 1, 'external', 'bottom', 'renumbered', 'reset'],
  ['full', 0.25, 'internal', 'left', 'gone', 'none'],
  ['free', 1, 'external-left', 'hidden', 'none', 'move'],
  ['full', 0.25, 'internal', 'left', 'gone', 'none'],
  ['bottom-left', 1, 'external', 'left', 'overflow', 'larger'],
];

/** Where a drag leaves the window: well inside the display the saved point names. */
function dragged({ target }: Desk): WindowBounds {
  return { x: target.workArea.x + 300, y: target.workArea.y + 100, width: 180, height: 400 };
}

const stepped = (scale: number, dir: 1 | -1) => clamp(Math.round(scale * 20 + dir) / 20, 0.25, 1);

/** What the transition table says the state becomes, and whether its display is found after. */
function ruleNext(
  state: MascotState,
  action: ActionCase,
  scene: Desk,
  found: boolean,
): { state: MascotState; found: boolean } {
  const area = scene.target.workArea;
  switch (action) {
    case 'none':
      return { state, found };
    case 'reset':
      return { state: { ...state, mode: 'bottom-right', scale: 0.5 }, found };
    case 'move': {
      // A mascot filling the height is as large as one can be, and stays so.
      const scale = state.mode === 'full' ? 1 : state.scale;
      const foot = ruleSettle(area, scale, footOf(dragged(scene)));
      return {
        state: { ...state, mode: 'free', scale, saved: { ...foot, display: keyOf(scene.target) } },
        found: true,
      };
    }
    case 'larger':
    case 'smaller': {
      const dir = action === 'larger' ? 1 : -1;
      if (state.mode === 'full') {
        return {
          state: dir === 1 ? state : { ...state, mode: 'bottom-right', scale: 0.95 },
          found,
        };
      }
      const scale = stepped(state.scale, dir);
      // At either end of the range a step changes nothing at all.
      if (scale === state.scale) return { state, found };
      if (state.mode !== 'free' || state.saved === undefined || !found) {
        return { state: { ...state, scale }, found };
      }
      const foot = ruleSettle(area, scale, state.saved);
      return {
        state: { ...state, scale, saved: { ...foot, display: keyOf(scene.target) } },
        found,
      };
    }
  }
}

function actionFor(which: Exclude<ActionCase, 'none'>, scene: Desk): MascotAction {
  if (which === 'move') return { type: 'move', bounds: dragged(scene) };
  if (which === 'reset') return { type: 'reset' };
  return { type: 'stepScale', dir: which === 'larger' ? 1 : -1 };
}

describe('what the mascot becomes', () => {
  it.each(TRANSITIONS)(
    '%s at %s on %s, dock %s, saved %s: %s',
    (mode, scale, on, dock, savedCase, action) => {
      const scene = desk(on, dock);
      const saved = savedFor(savedCase, scene);
      const state: MascotState = { mode, scale, muted: true, ...(saved ? { saved } : {}) };
      const before = structuredClone(state);
      const expected = ruleNext(state, action, scene, savedCase !== 'gone');

      const next =
        action === 'none'
          ? state
          : nextMascotState(state, actionFor(action, scene), scene.displays);

      expect(next).toEqual(expected.state);
      // Silence is not a placement, and no transition touches it.
      expect(next.muted).toBe(true);
      expect(state).toEqual(before);
      expect(placeMascot(next, scene.displays)).toEqual(
        rulePlace(expected.state, scene, expected.found),
      );
    },
  );
});

describe('each transition, in figures', () => {
  const scene = desk('internal', 'bottom');
  const { displays, target } = scene;
  const at = (mode: MascotMode, scale: number, saved?: MascotSaved): MascotState => ({
    mode,
    scale,
    muted: false,
    ...(saved ? { saved } : {}),
  });

  it('becomes free the moment it is dragged, from any mode', () => {
    const bounds = { x: 600, y: 300, width: 196, height: 436 };
    for (const mode of ['full', 'bottom-right', 'bottom-left', 'free'] as const) {
      const next = nextMascotState(at(mode, 0.5), { type: 'move', bounds }, displays);
      expect(next.mode).toBe('free');
      expect(next.saved?.display).toEqual(keyOf(target));
    }
  });

  it('saves the middle of the bottom edge where the drag ended', () => {
    const bounds = { x: 600, y: 300, width: 196, height: 436 };
    const next = nextMascotState(at('bottom-right', 0.5), { type: 'move', bounds }, displays);
    expect(next.saved).toEqual({ x: 698, y: 736, display: keyOf(target) });
    expect(placeMascot(next, displays)).toEqual(bounds);
  });

  it('saves the point it was pushed back to when dropped over an edge', () => {
    const bounds = { x: 1450, y: 700, width: 196, height: 436 };
    const next = nextMascotState(at('free', 0.5), { type: 'move', bounds }, displays);
    expect(next.saved).toEqual({ x: 1414, y: 912, display: keyOf(target) });
  });

  it('belongs to the display its centre is over when it straddles two', () => {
    const two = desk('external', 'hidden');
    const edge = 1512;
    const mostlyRight = { x: edge - 80, y: 300, width: 196, height: 436 };
    const mostlyLeft = { x: edge - 110, y: 300, width: 196, height: 436 };
    const move = (bounds: WindowBounds) =>
      nextMascotState(at('free', 0.5), { type: 'move', bounds }, two.displays).saved?.display.id;
    expect(move(mostlyRight)).toBe(2);
    expect(move(mostlyLeft)).toBe(1);
  });

  it('goes to the primary display when dropped where there is none', () => {
    const bounds = { x: 9000, y: 9000, width: 196, height: 436 };
    const next = nextMascotState(at('free', 0.5), { type: 'move', bounds }, displays);
    expect(next.saved?.display).toEqual(keyOf(target));
    expect(inside(placeMascot(next, displays), target.workArea)).toBe(true);
  });

  it('keeps its corner while it changes size', () => {
    const right = placeMascot(
      nextMascotState(at('bottom-right', 0.5), { type: 'stepScale', dir: 1 }, displays),
      displays,
    );
    expect(right.x + right.width).toBe(1512 - 16);
    expect(right.y + right.height).toBe(25 + 887 - 16);
    const left = placeMascot(
      nextMascotState(at('bottom-left', 0.5), { type: 'stepScale', dir: -1 }, displays),
      displays,
    );
    expect(left.x).toBe(16);
    expect(left.y + left.height).toBe(25 + 887 - 16);
  });

  it('keeps its feet where they are while it changes size in the open', () => {
    const saved = { x: 700, y: 800, display: keyOf(target) };
    const next = nextMascotState(at('free', 0.5, saved), { type: 'stepScale', dir: 1 }, displays);
    expect(next.scale).toBe(0.55);
    expect(next.saved).toEqual(saved);
    expect(footOf(placeMascot(next, displays)).y).toBe(800);
  });

  it('saves its feet again when growing pushes it off an edge', () => {
    // Standing against the top: 436 px tall with its feet at 470 leaves 9 px above.
    const saved = { x: 700, y: 470, display: keyOf(target) };
    const next = nextMascotState(at('free', 0.5, saved), { type: 'stepScale', dir: 1 }, displays);
    // 0.55 of 871 is 479 px, which no longer fits above 470.
    expect(next.saved).toEqual({ x: 700, y: 25 + 479, display: keyOf(target) });
  });

  it('steps down from the full height into the corner at 0.95', () => {
    expect(nextMascotState(at('full', 0.5), { type: 'stepScale', dir: -1 }, displays)).toEqual(
      at('bottom-right', 0.95),
    );
  });

  it('has nowhere to step up to from the full height', () => {
    const state = at('full', 0.5);
    expect(nextMascotState(state, { type: 'stepScale', dir: 1 }, displays)).toEqual(state);
  });

  it('walks the whole range in steps of 0.05 and stops at each end', () => {
    let state = at('bottom-right', 1);
    const seen: number[] = [];
    for (let i = 0; i < 17; i += 1) {
      state = nextMascotState(state, { type: 'stepScale', dir: -1 }, displays);
      seen.push(state.scale);
    }
    expect(seen).toEqual([
      0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.25, 0.25,
    ]);
    for (let i = 0; i < 17; i += 1) {
      state = nextMascotState(state, { type: 'stepScale', dir: 1 }, displays);
    }
    expect(state.scale).toBe(1);
  });

  it('returns to the bottom right at half size when its position is reset', () => {
    const saved = { x: 700, y: 800, display: keyOf(target) };
    expect(nextMascotState(at('free', 0.85, saved), { type: 'reset' }, displays)).toEqual(
      at('bottom-right', 0.5, saved),
    );
  });

  it('stands in the primary corner at its own size when its display is gone', () => {
    const gone = savedFor('gone', scene) as MascotSaved;
    const state = at('free', 0.75, gone);
    expect(placeMascot(state, displays)).toEqual(mascotBounds('bottom-right', 0.75, target));
    // Nothing was asked of it, so the save is still there for when the display returns.
    expect(state.saved).toEqual(gone);
    const resized = nextMascotState(state, { type: 'stepScale', dir: -1 }, displays);
    expect(resized).toEqual(at('free', 0.7, gone));
  });

  it('takes a mode from the menu and keeps where it was', () => {
    const saved = { x: 700, y: 800, display: keyOf(target) };
    for (const mode of ['full', 'bottom-right', 'bottom-left', 'free'] as const) {
      expect(nextMascotState(at('free', 0.5, saved), { type: 'mode', mode }, displays)).toEqual(
        at(mode, 0.5, saved),
      );
    }
  });

  it('is set free where it stands when it has never been dragged', () => {
    const next = nextMascotState(at('bottom-left', 0.5), { type: 'mode', mode: 'free' }, displays);
    expect(next.mode).toBe('free');
    expect(placeMascot(next, displays)).toEqual(mascotBounds('bottom-left', 0.5, target));
  });
});

describe('a continuous resize', () => {
  const { displays, target } = desk('internal', 'bottom');
  const at = (mode: MascotMode, scale: number, saved?: MascotSaved): MascotState => ({
    mode,
    scale,
    muted: false,
    ...(saved ? { saved } : {}),
  });
  const by = (state: MascotState, factor: number) =>
    nextMascotState(state, { type: 'scaleBy', factor }, displays);

  it('multiplies the size and keeps the corner', () => {
    expect(by(at('bottom-left', 0.5), 1.2)).toEqual(at('bottom-left', 0.5 * 1.2));
  });

  it('stops at each end of the range and then changes nothing', () => {
    expect(by(at('bottom-right', 0.5), 0.1).scale).toBe(0.25);
    expect(by(at('bottom-right', 0.5), 10).scale).toBe(1);
    const small = at('bottom-right', 0.25);
    expect(by(small, 0.5)).toBe(small);
    const large = at('bottom-right', 1);
    expect(by(large, 2)).toBe(large);
  });

  it('returns the same state for a factor of 1', () => {
    for (const mode of ['full', 'bottom-right', 'free'] as const) {
      const state = at(mode, 0.6);
      expect(by(state, 1)).toBe(state);
    }
  });

  it('leaves the full height alone when growing and steps down into the corner when shrinking', () => {
    const full = at('full', 0.5);
    expect(by(full, 1)).toBe(full);
    expect(by(full, 1.5)).toBe(full);
    expect(by(full, 0.8)).toEqual(at('bottom-right', 0.8));
    expect(by(full, 0.1)).toEqual(at('bottom-right', 0.25));
  });

  it('keeps the feet in the open and the pushed-back point when the size no longer fits', () => {
    const saved = { x: 700, y: 800, display: keyOf(target) };
    expect(by(at('free', 0.5, saved), 0.8)).toEqual(at('free', 0.5 * 0.8, saved));
    const edge = { x: 700, y: 400, display: keyOf(target) };
    const grown = by(at('free', 0.5, edge), 2);
    expect(grown.scale).toBe(1);
    expect(grown.saved?.y).toBe(25 + 871);
  });

  it('does not match the menu steps off the grid and lands on it again at the next step', () => {
    const off = by(at('bottom-right', 0.5), 1.04);
    expect(off.scale).toBeCloseTo(0.52, 12);
    expect(nextMascotState(off, { type: 'stepScale', dir: 1 }, displays).scale).toBe(0.55);
  });
});

describe('the direction the character faces', () => {
  const { displays, target } = desk('internal', 'bottom');
  const base: MascotState = {
    mode: 'free',
    scale: 0.5,
    muted: true,
    saved: { x: 700, y: 800, display: keyOf(target) },
  };
  const turn = (state: MascotState, yaw: number, pitch: number) =>
    nextMascotState(state, { type: 'turn', angle: { yaw, pitch } }, displays);

  it('wraps the yaw and stops the pitch where the wire does', () => {
    expect(turn(base, 270, 90).angle).toEqual({ yaw: -90, pitch: 85 });
    expect(turn(base, -180, -100).angle).toEqual({ yaw: 180, pitch: -85 });
    expect(turn(base, -0, 10).angle?.yaw).toBe(0);
    expect(turn(base, 45, -30).angle).toEqual({ yaw: 45, pitch: -30 });
  });

  it('touches nothing else, and nothing else touches it', () => {
    const turned = turn(base, 20, 10);
    expect({ ...turned, angle: undefined }).toEqual({ ...base, angle: undefined });
    for (const action of [
      { type: 'reset' },
      { type: 'stepScale', dir: -1 },
      { type: 'scaleBy', factor: 0.8 },
      { type: 'mode', mode: 'bottom-left' },
    ] as const) {
      expect(nextMascotState(turned, action, displays).angle, action.type).toEqual({
        yaw: 20,
        pitch: 10,
      });
    }
  });

  it('faces front by dropping the angle, and is a no-op where there is none', () => {
    const turned = turn(base, 20, 10);
    const front = nextMascotState(turned, { type: 'faceFront' }, displays);
    expect(front).toEqual(base);
    expect('angle' in front).toBe(false);
    expect(nextMascotState(base, { type: 'faceFront' }, displays)).toEqual(base);
  });
});
