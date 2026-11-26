// @vitest-environment happy-dom

import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProfile } from '@/engine/profile';
import type { Shot } from '@/protocol';
import {
  createHitTest,
  HIT_MARGIN,
  type MascotTouch,
  type PointerHit,
  watchPointer,
} from '@/viewer/mascot/pointer';
import { ShotCamera } from '@/viewer/scene/runtime/camera';
import type { MascotBridge } from '@/viewer/shell-bridge';
import { dragShot, wheelFactor } from '@/viewer/shot-gesture';
import { openingFrame, readStageMode } from '@/viewer/stage-mode';
import { addRigidMesh, addSkinnedRing, buildRig } from '../helpers/scene';

const WIDTH = 400;
const HEIGHT = 800;

/** The synthetic avatar, seen from the front through a canvas of a known size. */
function stage({ limbs = true } = {}) {
  const rig = buildRig({ legs: true, arkit: false });
  if (limbs) {
    for (const side of ['L', 'R']) {
      addSkinnedRing(rig, `UpperArm_${side}`, `Arm_${side}`);
      addSkinnedRing(rig, `Hand_${side}`, `Palm_${side}`, 0.02);
      addSkinnedRing(rig, `IndexDistal_${side}`, `Fingertip_${side}`, 0.01);
      addSkinnedRing(rig, `LowerLeg_${side}`, `Shin_${side}`);
    }
    addSkinnedRing(rig, 'Neck', 'Collar', 0.02);
    addRigidMesh(rig, 'Head', 'Ribbon', [0, 0.3, 0]);
  }
  const profile = buildProfile(rig.root, rig.descriptor);
  rig.root.updateMatrixWorld(true);

  const camera = new THREE.PerspectiveCamera(28, WIDTH / HEIGHT, 0.01, 100);
  camera.position.set(0, 0.9, -4.5);
  camera.lookAt(0, 0.9, 0);
  camera.updateMatrixWorld(true);

  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, WIDTH, HEIGHT);

  const meshes = (): THREE.Mesh[] => {
    const out: THREE.Mesh[] = [];
    rig.root.traverseVisible((o) => {
      if (o instanceof THREE.Mesh) out.push(o);
    });
    return out;
  };
  const hitTest = createHitTest({
    camera,
    renderer: { domElement: canvas },
    get raycastTargets() {
      return { meshes: meshes(), bones: profile.bones };
    },
  });

  /** Where a world point lands on the page. */
  const page = (point: THREE.Vector3): { x: number; y: number } => {
    const ndc = point.clone().project(camera);
    return { x: ((ndc.x + 1) / 2) * WIDTH, y: ((1 - ndc.y) / 2) * HEIGHT };
  };
  const at = (bone: string, dy = 0): { x: number; y: number } => {
    const b = rig.bones.get(bone);
    if (!b) throw new Error(`the rig has no ${bone}`);
    const world = b.getWorldPosition(new THREE.Vector3());
    world.y += dy;
    return page(world);
  };
  /** Whether a ray through exactly this pixel lands on the avatar. */
  const direct = (x: number, y: number): boolean => {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x / WIDTH) * 2 - 1, 1 - (y / HEIGHT) * 2), camera);
    return ray.intersectObjects(meshes(), false).length > 0;
  };

  return { rig, hitTest, at, page, direct, meshes };
}

describe('hit testing', () => {
  it('names the part under the pointer, with a side only where the body has one', () => {
    const { hitTest, at, page, rig } = stage();
    const on = (bone: string, dy = 0) => {
      const p = at(bone, dy);
      return hitTest(p.x, p.y);
    };

    expect(on('Head', 0.06)).toEqual({ part: 'head' });
    expect(on('Spine')).toEqual({ part: 'torso' });
    expect(on('UpperArm_L')).toEqual({ part: 'arm', side: 'L' });
    expect(on('UpperArm_R')).toEqual({ part: 'arm', side: 'R' });
    expect(on('Hand_L')).toEqual({ part: 'hand', side: 'L' });
    expect(on('Hand_R')).toEqual({ part: 'hand', side: 'R' });
    expect(on('LowerLeg_L')).toEqual({ part: 'leg', side: 'L' });
    expect(on('LowerLeg_R')).toEqual({ part: 'leg', side: 'R' });
    // A bone the profile gives no slot answers for the slot it hangs from.
    expect(on('IndexDistal_R')).toEqual({ part: 'hand', side: 'R' });
    expect(on('Neck')).toEqual({ part: 'head' });
    // An unskinned accessory answers for the bone it is parented to.
    const ribbon = rig.root.getObjectByName('Ribbon')?.getWorldPosition(new THREE.Vector3());
    if (!ribbon) throw new Error('no ribbon');
    const p = page(ribbon);
    expect(hitTest(p.x, p.y)).toEqual({ part: 'head' });
  });

  it('takes the bone that weighs most on the face that was hit', () => {
    const { hitTest, at, rig } = stage();
    const arm = rig.meshes.get('Arm_L');
    const skeleton = arm?.skeleton;
    if (!(arm && skeleton)) throw new Error('no arm');
    const index = arm.geometry.getAttribute('skinIndex');
    const weight = arm.geometry.getAttribute('skinWeight');
    const chest = skeleton.bones.findIndex((b) => b.name === 'UpperChest');
    const set = (share: number) => {
      for (let i = 0; i < index.count; i++) {
        index.setY(i, chest);
        weight.setX(i, 1 - share);
        weight.setY(i, share);
      }
    };
    const p = at('UpperArm_L');

    set(0.4);
    expect(hitTest(p.x, p.y)).toEqual({ part: 'arm', side: 'L' });
    set(0.6);
    expect(hitTest(p.x, p.y)).toEqual({ part: 'torso' });
  });

  it('misses a mesh that is not being drawn', () => {
    const { hitTest, at, rig } = stage();
    const p = at('Hand_L');
    for (const name of ['Palm_L', 'Fingertip_L']) {
      const mesh = rig.meshes.get(name);
      if (mesh) mesh.visible = false;
    }
    expect(hitTest(p.x, p.y)).toBeNull();
  });

  it('reaches a margin past the silhouette and no further', () => {
    const { hitTest, at, direct } = stage({ limbs: false });
    const y = Math.round(at('Spine').y);
    let edge = 0;
    while (!direct(edge, y)) edge++;
    expect(edge).toBeGreaterThan(HIT_MARGIN + 2);
    expect(HIT_MARGIN).toBe(6);

    expect(direct(edge - 1, y)).toBe(false);
    expect(hitTest(edge - HIT_MARGIN, y)).toEqual({ part: 'torso' });
    expect(hitTest(edge - HIT_MARGIN - 1, y)).toBeNull();
  });

  it('hits nothing with no avatar standing', () => {
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, WIDTH, HEIGHT);
    const hitTest = createHitTest({
      camera: new THREE.PerspectiveCamera(),
      renderer: { domElement: canvas },
      raycastTargets: null,
    });
    expect(hitTest(WIDTH / 2, HEIGHT / 2)).toBeNull();
  });
});

describe('pointer', () => {
  /** Only this square of the page is the avatar. */
  const inside = (x: number, y: number): boolean => x >= 100 && x < 200 && y >= 100 && y < 200;

  let target: EventTarget;
  let bridge: { [K in keyof MascotBridge]: ReturnType<typeof vi.fn<MascotBridge[K]>> };
  let touches: MascotTouch[];
  let hit: PointerHit;
  let stop: () => void;
  /** The camera the pointer turns, and every shot it was handed. */
  let current: Required<Shot>;
  let shots: Shot[];
  let cursors: Array<'grab' | 'grabbing' | null>;
  /** The window's top left on the screen. */
  let corner: { x: number; y: number };

  /** The frames asked for and not yet drawn, by handle. */
  let pending: Map<number, () => void>;
  let cancelled: number[];
  let tests: number;
  const frame = () => {
    const due = [...pending.values()];
    pending.clear();
    for (const fn of due) fn();
  };

  const raw = (type: string, x: number, y: number, init: MouseEventInit = {}) =>
    target.dispatchEvent(
      new MouseEvent(type, { clientX: x, clientY: y, screenX: x, screenY: y, button: 0, ...init }),
    );
  /** An event, and the frame after it. */
  const mouse = (type: string, x: number, y: number, init: MouseEventInit = {}) => {
    raw(type, x, y, init);
    frame();
  };
  const tap = (x = 150, y = 150) => {
    mouse('mousedown', x, y);
    mouse('mouseup', x, y);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    target = new EventTarget();
    bridge = {
      setInteractive: vi.fn(),
      moveBy: vi.fn(),
      scaleBy: vi.fn(),
      turnTo: vi.fn(),
      onShot: vi.fn(() => () => {}),
    };
    current = { frame: 'full', yaw: 10, pitch: 5, zoom: 1 };
    shots = [];
    cursors = [];
    corner = { x: 0, y: 0 };
    touches = [];
    hit = { part: 'head' };
    pending = new Map();
    cancelled = [];
    tests = 0;
    let handle = 0;
    stop = watchPointer({
      target,
      bridge,
      hitTest: (x, y) => {
        tests++;
        return inside(x, y) ? hit : null;
      },
      onTouch: (touch) => touches.push(touch),
      shot: {
        get: () => ({ ...current }),
        set: (shot) => {
          shots.push(shot);
          current = { ...current, ...shot };
        },
      },
      height: () => HEIGHT,
      origin: () => corner,
      cursor: (kind) => cursors.push(kind),
      frames: {
        request: (fn) => {
          pending.set(++handle, fn);
          return handle;
        },
        cancel: (id) => {
          cancelled.push(id);
          pending.delete(id);
        },
      },
    });
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('takes the mouse the moment the pointer is on the avatar', () => {
    mouse('mousemove', 50, 50);
    expect(bridge.setInteractive).not.toHaveBeenCalled();

    mouse('mousemove', 150, 150);
    mouse('mousemove', 151, 150);
    expect(bridge.setInteractive.mock.calls).toEqual([[true]]);
  });

  it('tests a run of moves once a frame, at the last place the pointer was', () => {
    raw('mousemove', 50, 50);
    raw('mousemove', 150, 150);
    raw('mousemove', 151, 150);
    expect(tests).toBe(0);
    expect(pending.size).toBe(1);

    frame();
    expect(tests).toBe(1);
    expect(bridge.setInteractive.mock.calls).toEqual([[true]]);

    // Passing over the avatar between two frames is not seen at all.
    raw('mousemove', 150, 150);
    raw('mousemove', 50, 50);
    frame();
    expect(tests).toBe(2);
    vi.advanceTimersByTime(200);
    expect(bridge.setInteractive.mock.calls).toEqual([[true], [false]]);
  });

  it('answers a press and a release without waiting for a frame', () => {
    raw('mousedown', 150, 150);
    raw('mouseup', 150, 150);
    expect(touches).toEqual([{ kind: 'tap', part: 'head', count: 1 }]);
    expect(bridge.setInteractive.mock.calls).toEqual([[true]]);
    expect(pending.size).toBe(0);
  });

  it('lets the mouse through only after the pointer has been off for 200 ms', () => {
    mouse('mousemove', 150, 150);
    mouse('mousemove', 50, 50);
    vi.advanceTimersByTime(199);
    expect(bridge.setInteractive.mock.calls).toEqual([[true]]);

    vi.advanceTimersByTime(1);
    expect(bridge.setInteractive.mock.calls).toEqual([[true], [false]]);
  });

  it('keeps the mouse when the pointer comes back inside the delay', () => {
    mouse('mousemove', 150, 150);
    mouse('mousemove', 50, 50);
    vi.advanceTimersByTime(150);
    mouse('mousemove', 150, 150);
    vi.advanceTimersByTime(1000);
    expect(bridge.setInteractive.mock.calls).toEqual([[true]]);

    // The delay runs from when it left, however much it moves while off.
    mouse('mousemove', 50, 50);
    vi.advanceTimersByTime(150);
    mouse('mousemove', 51, 50);
    vi.advanceTimersByTime(50);
    expect(bridge.setInteractive.mock.calls).toEqual([[true], [false]]);
  });

  it('reads a press that stays within 4 px as a touch', () => {
    hit = { part: 'arm', side: 'L' };
    mouse('mousedown', 150, 150);
    mouse('mousemove', 154, 150);
    mouse('mouseup', 154, 150);

    expect(bridge.moveBy).not.toHaveBeenCalled();
    expect(touches).toEqual([{ kind: 'tap', part: 'arm', side: 'L', count: 1 }]);
  });

  it('reads a press that travels past 4 px as moving the window', () => {
    mouse('mousedown', 150, 150);
    mouse('mousemove', 155, 150);
    mouse('mousemove', 160, 153);
    mouse('mouseup', 160, 153);

    expect(bridge.moveBy.mock.calls).toEqual([
      [5, 0],
      [5, 3],
    ]);
    expect(touches).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(touches).toEqual([]);
  });

  it('measures the travel diagonally', () => {
    mouse('mousedown', 150, 150);
    mouse('mousemove', 153, 153);
    expect(bridge.moveBy).toHaveBeenCalledWith(3, 3);
  });

  it('ignores a press that lands off the avatar, and any button but the first', () => {
    mouse('mousedown', 50, 50);
    mouse('mousemove', 80, 80);
    mouse('mouseup', 80, 80);
    mouse('mousedown', 150, 150, { button: 2 });
    mouse('mouseup', 150, 150, { button: 2 });
    vi.advanceTimersByTime(1000);

    expect(bridge.moveBy).not.toHaveBeenCalled();
    expect(touches).toEqual([]);
  });

  it('reports one hold at 600 ms and no tap on release', () => {
    hit = { part: 'hand', side: 'R' };
    mouse('mousedown', 150, 150);
    vi.advanceTimersByTime(599);
    expect(touches).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(touches).toEqual([{ kind: 'hold', part: 'hand', side: 'R', count: 1 }]);

    vi.advanceTimersByTime(5000);
    mouse('mouseup', 150, 150);
    vi.advanceTimersByTime(1000);
    expect(touches).toHaveLength(1);
  });

  it('counts a hold as 1 even in the middle of a run of taps', () => {
    tap();
    tap();
    mouse('mousedown', 150, 150);
    vi.advanceTimersByTime(600);
    mouse('mouseup', 150, 150);
    tap();

    expect(touches.map((t) => [t.kind, t.count])).toEqual([
      ['tap', 1],
      ['tap', 2],
      ['hold', 1],
      ['tap', 1],
    ]);
  });

  it('moves the window when the pointer travels after a hold', () => {
    mouse('mousedown', 150, 150);
    vi.advanceTimersByTime(600);
    mouse('mousemove', 152, 150);
    expect(bridge.moveBy).not.toHaveBeenCalled();

    mouse('mousemove', 160, 150);
    mouse('mouseup', 160, 150);
    expect(bridge.moveBy.mock.calls).toEqual([[10, 0]]);
    expect(touches).toHaveLength(1);
  });

  it('does not hold once the press has become a move', () => {
    mouse('mousedown', 150, 150);
    mouse('mousemove', 160, 150);
    vi.advanceTimersByTime(1000);
    expect(touches).toEqual([]);
  });

  it('keeps the mouse for as long as a button is down', () => {
    mouse('mousemove', 150, 150);
    mouse('mousedown', 150, 150);
    mouse('mousemove', 50, 50);
    vi.advanceTimersByTime(1000);
    expect(bridge.setInteractive.mock.calls).toEqual([[true]]);

    mouse('mouseup', 50, 50);
    vi.advanceTimersByTime(200);
    expect(bridge.setInteractive.mock.calls).toEqual([[true], [false]]);
  });

  it('counts taps that follow within 350 ms, one report each', () => {
    tap();
    vi.advanceTimersByTime(349);
    tap();
    vi.advanceTimersByTime(349);
    tap();
    expect(touches.map((t) => t.count)).toEqual([1, 2, 3]);

    vi.advanceTimersByTime(350);
    tap();
    expect(touches.map((t) => t.count)).toEqual([1, 2, 3, 1]);
  });

  it('stops counting at 10 and keeps reporting', () => {
    for (let i = 0; i < 12; i++) tap();
    expect(touches).toHaveLength(12);
    expect(touches.map((t) => t.count)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10]);
  });

  /** A wheel event, which the page may or may not swallow. */
  const wheel = (deltaY: number, keys: { ctrlKey?: boolean } = {}) => {
    // happy-dom's WheelEvent drops the modifier keys a real one carries.
    const event = Object.assign(new WheelEvent('wheel', { deltaY, cancelable: true }), keys);
    target.dispatchEvent(event);
    return event;
  };
  /** Whether the character has the focus, read off what the wheel does. */
  const isFocused = (): boolean => {
    const taken = wheel(0).defaultPrevented;
    frame();
    return taken;
  };
  /** Tap the character into focus, and let the run of taps lapse. */
  const focus = () => {
    tap();
    vi.advanceTimersByTime(1000);
    touches.length = 0;
    cursors.length = 0;
    bridge.setInteractive.mockClear();
  };

  it('takes the focus on a tap, which is still reported as a touch', () => {
    expect(isFocused()).toBe(false);
    tap();
    expect(touches).toEqual([{ kind: 'tap', part: 'head', count: 1 }]);
    expect(cursors).toEqual(['grab']);
    expect(isFocused()).toBe(true);
  });

  it('turns the camera on a focused drag, once a frame, and keeps the angle on release', () => {
    focus();
    const start = { ...current };
    raw('mousedown', 150, 150);
    raw('mousemove', 155, 150);
    raw('mousemove', 160, 153);
    expect(shots).toEqual([]);
    expect(cursors).toEqual(['grabbing']);

    frame();
    const first = dragShot(start, 10, 3, HEIGHT);
    expect(shots).toEqual([{ yaw: first.yaw, pitch: first.pitch }]);
    frame();
    expect(shots).toHaveLength(1);

    // The last move is applied on release even though its frame has not come.
    raw('mousemove', 170, 140);
    raw('mouseup', 170, 140);
    const last = dragShot(start, 20, -10, HEIGHT);
    expect(shots).toEqual([
      { yaw: first.yaw, pitch: first.pitch },
      { yaw: last.yaw, pitch: last.pitch },
    ]);
    expect(bridge.turnTo.mock.calls).toEqual([[{ yaw: last.yaw, pitch: last.pitch }]]);
    expect(cursors).toEqual(['grabbing', 'grab']);
    expect(pending.size).toBe(0);

    expect(bridge.moveBy).not.toHaveBeenCalled();
    expect(touches).toEqual([]);
    expect(isFocused()).toBe(true);
  });

  it('does not focus on a hold released, and turns after a hold when focused', () => {
    mouse('mousedown', 150, 150);
    vi.advanceTimersByTime(600);
    mouse('mouseup', 150, 150);
    expect(cursors).toEqual([]);
    expect(isFocused()).toBe(false);

    focus();
    mouse('mousedown', 150, 150);
    vi.advanceTimersByTime(600);
    mouse('mousemove', 160, 150);
    mouse('mouseup', 160, 150);
    expect(bridge.moveBy).not.toHaveBeenCalled();
    expect(bridge.turnTo).toHaveBeenCalledTimes(1);
    expect(cursors).toEqual(['grabbing', 'grab']);
  });

  it('leaves the wheel alone when not focused', () => {
    expect(wheel(-120).defaultPrevented).toBe(false);
    expect(wheel(-120, { ctrlKey: true }).defaultPrevented).toBe(false);
    frame();
    expect(bridge.scaleBy).not.toHaveBeenCalled();
  });

  it('resizes by the product of a frame of wheel events, sent once, pinch or not', () => {
    focus();
    expect(wheel(-100).defaultPrevented).toBe(true);
    expect(wheel(-40, { ctrlKey: true }).defaultPrevented).toBe(true);
    wheel(15);
    expect(bridge.scaleBy).not.toHaveBeenCalled();

    frame();
    expect(bridge.scaleBy.mock.calls).toEqual([
      [1 * wheelFactor(-100) * wheelFactor(-40) * wheelFactor(15)],
    ]);
    expect(bridge.scaleBy.mock.calls[0][0]).toBeGreaterThan(1);

    wheel(30, { ctrlKey: true });
    frame();
    expect(bridge.scaleBy.mock.calls[1]).toEqual([wheelFactor(30)]);
    expect(wheelFactor(30)).toBeLessThan(1);
    frame();
    expect(bridge.scaleBy).toHaveBeenCalledTimes(2);
  });

  it('clamps a frame of wheel to what one resize may carry', () => {
    focus();
    for (let i = 0; i < 4; i++) wheel(-10000);
    frame();
    for (let i = 0; i < 4; i++) wheel(10000);
    frame();
    expect(bridge.scaleBy.mock.calls).toEqual([[2], [0.5]]);
  });

  it('swallows and drops the wheel while a button is down', () => {
    focus();
    mouse('mousedown', 150, 150);
    expect(wheel(-120).defaultPrevented).toBe(true);
    frame();
    mouse('mousemove', 160, 150);
    expect(wheel(-120).defaultPrevented).toBe(true);
    frame();
    mouse('mouseup', 160, 150);
    expect(bridge.scaleBy).not.toHaveBeenCalled();

    wheel(-120);
    frame();
    expect(bridge.scaleBy.mock.calls).toEqual([[wheelFactor(-120)]]);
  });

  it('tests the pointer again when a resize lands, and lets go if the character left it', () => {
    focus();
    // The window moving without a resize behind it is not tested.
    corner = { x: 100, y: 0 };
    target.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);
    expect(bridge.setInteractive).not.toHaveBeenCalled();

    wheel(120);
    frame();
    expect(bridge.scaleBy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(bridge.setInteractive).not.toHaveBeenCalled();
    expect(cursors).toEqual([]);

    target.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(199);
    expect(bridge.setInteractive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(bridge.setInteractive.mock.calls).toEqual([[false]]);
    expect(cursors).toEqual([null]);
    expect(isFocused()).toBe(false);
  });

  it('keeps the focus when a resize leaves the character under the pointer', () => {
    focus();
    wheel(120);
    frame();
    corner = { x: 20, y: 20 };
    target.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);
    expect(bridge.setInteractive).not.toHaveBeenCalled();
    expect(isFocused()).toBe(true);
  });

  it('lets go of the focus when the pointer goes off the character', () => {
    focus();
    mouse('mousemove', 50, 50);
    vi.advanceTimersByTime(199);
    expect(cursors).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(bridge.setInteractive.mock.calls).toEqual([[false]]);
    expect(cursors).toEqual([null]);
    expect(isFocused()).toBe(false);
  });

  it('lets go of the focus when the pointer leaves the page, and not when it moves within it', () => {
    focus();
    target.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: document.body }));
    vi.advanceTimersByTime(1000);
    expect(cursors).toEqual([]);
    expect(isFocused()).toBe(true);

    // A move inside the page whose frame has not come yet does not keep the mouse.
    raw('mousemove', 150, 150);
    target.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: null }));
    expect(cursors).toEqual([null]);
    frame();
    vi.advanceTimersByTime(200);
    expect(bridge.setInteractive.mock.calls).toEqual([[false]]);
    expect(isFocused()).toBe(false);
  });

  it('keeps the focus and the mouse when the pointer leaves the page with a button down', () => {
    focus();
    mouse('mousedown', 150, 150);
    target.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: null }));
    vi.advanceTimersByTime(1000);
    expect(bridge.setInteractive).not.toHaveBeenCalled();
    mouse('mouseup', 150, 150);
    expect(isFocused()).toBe(true);
  });

  it('keeps the focus when the window loses the keyboard with the pointer still on the character', () => {
    focus();
    target.dispatchEvent(new Event('blur'));
    expect(cursors).toEqual([]);
    expect(isFocused()).toBe(true);
    mouse('mousedown', 150, 150);
    mouse('mousemove', 160, 150);
    frame();
    expect(cursors).toEqual(['grabbing']);
    expect(bridge.moveBy).not.toHaveBeenCalled();
  });

  it('gives the cursor back when stopped while focused', () => {
    focus();
    stop();
    expect(cursors).toEqual([null]);
  });

  /**
   * Every combination of focus, where the press lands, how far it travels, a
   * hold and the button: 2 x 2 x 3 x 2 x 2 is small enough to take whole.
   */
  describe.each(
    [false, true].flatMap((focused) =>
      [true, false].flatMap((onAvatar) =>
        [0, 4, 5].flatMap((travel) =>
          [false, true].flatMap((held) =>
            [0, 2].map((button) => ({ focused, onAvatar, travel, held, button })),
          ),
        ),
      ),
    ),
  )(
    'a press with focus $focused, on the avatar $onAvatar, travelling $travel px, held $held, button $button',
    ({ focused, onAvatar, travel, held, button }) => {
      it('does what the state table says', () => {
        if (focused) focus();
        const start = { ...current };
        const x = onAvatar ? 150 : 50;
        mouse('mousedown', x, x, { button });
        if (held) vi.advanceTimersByTime(600);
        mouse('mousemove', x + travel, x, { button });
        mouse('mouseup', x + travel, x, { button });
        vi.advanceTimersByTime(1000);

        const pressed = onAvatar && button === 0;
        const travelled = pressed && travel > 4;
        // A pointer resting off the character hands the mouse back, and the focus with it.
        const lost = focused && !onAvatar;
        const kinds = touches.map((t) => t.kind);
        expect(kinds).toEqual([
          ...(pressed && held ? ['hold'] : []),
          ...(pressed && !held && !travelled ? ['tap'] : []),
        ]);

        if (travelled && focused) {
          const turned = dragShot(start, travel, 0, HEIGHT);
          expect(shots).toEqual([{ yaw: turned.yaw, pitch: turned.pitch }]);
          expect(bridge.turnTo.mock.calls).toEqual([[{ yaw: turned.yaw, pitch: turned.pitch }]]);
          expect(bridge.moveBy).not.toHaveBeenCalled();
          expect(cursors).toEqual(['grabbing', 'grab']);
        } else {
          expect(shots).toEqual([]);
          expect(bridge.turnTo).not.toHaveBeenCalled();
          expect(bridge.moveBy.mock.calls).toEqual(travelled ? [[travel, 0]] : []);
          expect(cursors).toEqual(pressed && !held && !travelled ? ['grab'] : lost ? [null] : []);
        }
        expect(isFocused()).toBe((focused && !lost) || (pressed && !held && !travelled));
      });
    },
  );

  it('drops the frame it was waiting on when stopped', () => {
    raw('mousemove', 150, 150);
    stop();
    expect(cancelled).toHaveLength(1);
    frame();
    expect(tests).toBe(0);
    expect(bridge.setInteractive).not.toHaveBeenCalled();
  });

  it('hears nothing once stopped', () => {
    mouse('mousedown', 150, 150);
    stop();
    vi.advanceTimersByTime(1000);
    mouse('mousemove', 150, 150);
    tap();
    expect(touches).toEqual([]);
    expect(bridge.setInteractive).not.toHaveBeenCalled();
  });
});

describe('the shot a mascot opens on', () => {
  it('is the full figure, and the default everywhere else', () => {
    expect(readStageMode('?mascot=1&transparent=1').mascot).toBe(true);
    expect(readStageMode('').mascot).toBe(false);
    expect(openingFrame(readStageMode('?mascot=1&transparent=1'))).toBe('full');
    expect(openingFrame(readStageMode('?transparent=1'))).toBeUndefined();

    const host = document.createElement('div');
    const mascot = new ShotCamera(host, { pointer: false, frame: 'full' }, () => {});
    const stage = new ShotCamera(host, { pointer: false }, () => {});
    expect(mascot.cameraFrame).toBe('full');
    expect(stage.cameraFrame).toBe('bust');
  });
});
