import * as THREE from 'three';
import type { BoneSlot, Side } from '@/engine/types';
import type { SessionEvent } from '@/protocol';
import type { RaycastTargets } from '../scene/runtime';
import type { MascotBridge } from '../shell-bridge';

/**
 * The pointer on a mascot: which pixels are the character, and what a press on
 * them means.
 *
 * The window lets the mouse through wherever the character is not, so the page
 * tests every pointer move against the drawn meshes and tells the shell when
 * the answer changes. A press on the character is a touch if it stays put and
 * a grab of the window if it travels; nothing is decided by a modifier key.
 */

/** A part of the body a touch is reported against. */
export type TouchPart = NonNullable<SessionEvent['part']>;

/** What the pointer is on. A surface no bone slot answers for has no part. */
export interface PointerHit {
  part?: TouchPart;
  side?: Side;
}

/** A touch, as the pointer makes it out. */
export interface MascotTouch extends PointerHit {
  kind: 'tap' | 'hold';
  /** Taps in the run so far; always 1 for a hold. */
  count: number;
}

/**
 * How far past the silhouette the character still counts as hit, in CSS pixels.
 * With the miss delay it keeps the window from flickering at the outline, where
 * a click landing in the gap would go to whatever is underneath.
 */
export const HIT_MARGIN = 6;
/** How long the pointer has to stay off the character before the mouse is let through, in ms. */
export const MISS_DELAY = 200;
/** A press that travels further than this, in pixels, moves the window. */
export const MOVE_THRESHOLD = 4;
/** A press held this long, in ms, is a hold. */
export const HOLD_DELAY = 600;
/** A tap this soon after the last, in ms, continues its run. */
export const TAP_WINDOW = 350;
/** Where a run stops counting, which is the most the wire carries. */
export const MAX_COUNT = 10;
/** How long after a size step further wheel events are ignored, in ms: a trackpad swipe is many. */
export const WHEEL_STEP_GAP = 150;

/**
 * The five parts the wire names, by bone slot. Above the shoulders is the
 * head; the clavicle goes with the arm, as it does in an arm pose.
 */
const PART_OF: Record<BoneSlot, TouchPart> = {
  head: 'head',
  neck: 'head',
  'eye.L': 'head',
  'eye.R': 'head',
  chest: 'torso',
  spine: 'torso',
  hips: 'torso',
  'shoulder.L': 'arm',
  'shoulder.R': 'arm',
  'upperArm.L': 'arm',
  'upperArm.R': 'arm',
  'lowerArm.L': 'arm',
  'lowerArm.R': 'arm',
  'hand.L': 'hand',
  'hand.R': 'hand',
  'upperLeg.L': 'leg',
  'upperLeg.R': 'leg',
  'lowerLeg.L': 'leg',
  'lowerLeg.R': 'leg',
  'foot.L': 'leg',
  'foot.R': 'leg',
  'toe.L': 'leg',
  'toe.R': 'leg',
};

/** The parts with no left and right, whatever slot the hit resolved to. */
const UNSIDED: ReadonlySet<TouchPart> = new Set(['head', 'torso']);

/** The part a slot belongs to, and its side where the part has one. */
export function partOf(slot: BoneSlot): PointerHit {
  const part = PART_OF[slot];
  if (UNSIDED.has(part)) return { part };
  return { part, side: slot.endsWith('.L') ? 'L' : 'R' };
}

/** Where a hit test looks: `AvatarRuntime`, or as much of it as a test builds. */
export interface HitSource {
  camera: THREE.Camera;
  renderer: { domElement: Element };
  raycastTargets: RaycastTargets | null;
}

/** The margin's probes: eight directions around the pointer, as unit offsets. */
const RING: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2],
  [-Math.SQRT1_2, -Math.SQRT1_2],
];

/**
 * Build the test for "is this point of the page the character, and which part".
 *
 * A ray through the point decides it; where that misses, eight more a margin
 * away do, so the answer reaches `HIT_MARGIN` past the silhouette.
 *
 * @returns A function of client coordinates giving the hit, or null for a miss.
 */
export function createHitTest(source: HitSource): (x: number, y: number) => PointerHit | null {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  /** Which slot each resolved bone fills, per profile. */
  const slotTables = new WeakMap<RaycastTargets['bones'], Map<THREE.Object3D, BoneSlot>>();

  const slotsOf = (bones: RaycastTargets['bones']): Map<THREE.Object3D, BoneSlot> => {
    let table = slotTables.get(bones);
    if (!table) {
      table = new Map();
      for (const [slot, bone] of Object.entries(bones)) table.set(bone, slot as BoneSlot);
      slotTables.set(bones, table);
    }
    return table;
  };

  const cast = (
    targets: RaycastTargets,
    rect: DOMRect,
    x: number,
    y: number,
  ): PointerHit | null => {
    ndc.set(((x - rect.left) / rect.width) * 2 - 1, 1 - ((y - rect.top) / rect.height) * 2);
    raycaster.setFromCamera(ndc, source.camera);
    const [nearest] = raycaster.intersectObjects(targets.meshes, false);
    if (!nearest) return null;
    const slots = slotsOf(targets.bones);
    // A finger, a twist helper or a lock of hair fills no slot of its own, and
    // answers for the nearest bone above it that does.
    for (let o = carrier(nearest); o; o = o.parent) {
      const slot = slots.get(o);
      if (slot) return partOf(slot);
    }
    return {};
  };

  return (x, y) => {
    const targets = source.raycastTargets;
    if (!targets) return null;
    const rect = source.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const direct = cast(targets, rect, x, y);
    if (direct) return direct;
    for (const [dx, dy] of RING) {
      const near = cast(targets, rect, x + dx * HIT_MARGIN, y + dy * HIT_MARGIN);
      if (near) return near;
    }
    return null;
  };
}

/**
 * What carries the surface that was hit: the bone weighing most on the face's
 * three vertices, or an unskinned mesh's parent.
 */
function carrier(hit: THREE.Intersection): THREE.Object3D | null {
  const mesh = hit.object;
  if (!(mesh instanceof THREE.SkinnedMesh && hit.face)) return mesh.parent;
  const index = mesh.geometry.getAttribute('skinIndex');
  const weight = mesh.geometry.getAttribute('skinWeight');
  if (!(index && weight)) return mesh.parent;
  const totals = new Map<number, number>();
  for (const vertex of [hit.face.a, hit.face.b, hit.face.c]) {
    for (let k = 0; k < 4; k++) {
      const w = weight.getComponent(vertex, k);
      if (w === 0) continue;
      const bone = index.getComponent(vertex, k);
      totals.set(bone, (totals.get(bone) ?? 0) + w);
    }
  }
  let heaviest = -1;
  let most = 0;
  for (const [bone, total] of totals) {
    if (total > most) {
      most = total;
      heaviest = bone;
    }
  }
  return mesh.skeleton.bones[heaviest] ?? mesh.parent;
}

export interface PointerOptions {
  /** Where the mouse is heard: the window, on a page. */
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  bridge: MascotBridge;
  /** See `createHitTest`. */
  hitTest: (x: number, y: number) => PointerHit | null;
  onTouch: (touch: MascotTouch) => void;
  /** The frame clock hover tests are held to; the page's own unless a test supplies one. */
  frames?: {
    request: (fn: () => void) => number;
    cancel: (id: number) => void;
  };
}

/** A press in progress: where it began, where it was last seen, and what it has become. */
interface Press {
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  hit: PointerHit;
  phase: 'pressed' | 'held' | 'moving';
}

/**
 * Listen to the mouse on a mascot's page.
 *
 * @returns A function that stops listening and hands the mouse back.
 */
export function watchPointer({
  target,
  bridge,
  hitTest,
  onTouch,
  frames = { request: (fn) => requestAnimationFrame(fn), cancel: (id) => cancelAnimationFrame(id) },
}: PointerOptions): () => void {
  let interactive = false;
  /** Where the pointer was last seen, in client coordinates. */
  const seen = { x: 0, y: 0 };
  let hoverFrame: number | null = null;
  let wheelTimer: ReturnType<typeof setTimeout> | null = null;
  let missTimer: ReturnType<typeof setTimeout> | null = null;
  let press: Press | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let run = 0;
  let runTimer: ReturnType<typeof setTimeout> | null = null;

  const clear = (timer: ReturnType<typeof setTimeout> | null): null => {
    if (timer !== null) clearTimeout(timer);
    return null;
  };

  /** Tell the shell when on-the-character changes; going off waits out the delay. */
  const hover = (): void => {
    // A press keeps the mouse wherever it goes: the window is moving under it.
    if (press !== null || hitTest(seen.x, seen.y) !== null) {
      missTimer = clear(missTimer);
      if (!interactive) {
        interactive = true;
        bridge.setInteractive(true);
      }
    } else if (interactive && missTimer === null) {
      missTimer = setTimeout(() => {
        missTimer = null;
        interactive = false;
        bridge.setInteractive(false);
      }, MISS_DELAY);
    }
  };

  const onDown = (event: Event): void => {
    const e = event as MouseEvent;
    if (e.button !== 0) return;
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;
    missTimer = clear(missTimer);
    holdTimer = clear(holdTimer);
    press = {
      x: e.screenX,
      y: e.screenY,
      lastX: e.screenX,
      lastY: e.screenY,
      hit,
      phase: 'pressed',
    };
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (!press) return;
      press.phase = 'held';
      // A hold is not part of a run of taps, and ends one.
      run = 0;
      runTimer = clear(runTimer);
      onTouch({ kind: 'hold', ...press.hit, count: 1 });
    }, HOLD_DELAY);
  };

  const onMove = (event: Event): void => {
    const e = event as MouseEvent;
    if (!press) {
      // A click-through window forwards every move and a hit test skins the
      // meshes on the CPU, so only the latest position is tested, once a frame.
      seen.x = e.clientX;
      seen.y = e.clientY;
      hoverFrame ??= frames.request(() => {
        hoverFrame = null;
        hover();
      });
      return;
    }
    // Screen coordinates: the window follows the pointer, so the page's own stand still.
    if (press.phase !== 'moving') {
      if (Math.hypot(e.screenX - press.x, e.screenY - press.y) <= MOVE_THRESHOLD) return;
      press.phase = 'moving';
      holdTimer = clear(holdTimer);
    }
    bridge.moveBy(e.screenX - press.lastX, e.screenY - press.lastY);
    press.lastX = e.screenX;
    press.lastY = e.screenY;
  };

  const onUp = (event: Event): void => {
    const e = event as MouseEvent;
    if (e.button !== 0 || !press) return;
    const { phase, hit } = press;
    press = null;
    holdTimer = clear(holdTimer);
    if (phase === 'pressed') {
      run = Math.min(run + 1, MAX_COUNT);
      clear(runTimer);
      runTimer = setTimeout(() => {
        runTimer = null;
        run = 0;
      }, TAP_WINDOW);
      onTouch({ kind: 'tap', ...hit, count: run });
    }
    seen.x = e.clientX;
    seen.y = e.clientY;
    hover();
  };

  const onWheel = (event: Event): void => {
    const e = event as WheelEvent;
    if (!e.altKey || e.deltaY === 0) return;
    e.preventDefault();
    if (wheelTimer !== null) return;
    bridge.stepScale(e.deltaY < 0 ? 1 : -1);
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
    }, WHEEL_STEP_GAP);
  };

  target.addEventListener('mousemove', onMove);
  target.addEventListener('mousedown', onDown);
  target.addEventListener('mouseup', onUp);
  target.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    target.removeEventListener('mousemove', onMove);
    target.removeEventListener('mousedown', onDown);
    target.removeEventListener('mouseup', onUp);
    target.removeEventListener('wheel', onWheel);
    missTimer = clear(missTimer);
    holdTimer = clear(holdTimer);
    runTimer = clear(runTimer);
    wheelTimer = clear(wheelTimer);
    if (hoverFrame !== null) frames.cancel(hoverFrame);
    hoverFrame = null;
    press = null;
    // Nobody is left to hand the mouse back when the pointer leaves.
    if (interactive) bridge.setInteractive(false);
    interactive = false;
  };
}
