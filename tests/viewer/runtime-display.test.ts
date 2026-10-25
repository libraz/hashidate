// @vitest-environment happy-dom

import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarRuntime } from '@/viewer/scene/runtime';

type Internals = {
  fps: number;
  tick(): void;
  updateBackground(): void;
  resize(): void;
  watchPixelRatio(): void;
  applyPixelRatio(): void;
};

/** Only the fields the frame loop and the display watcher read; no GL context. */
function bareRuntime(fields: Record<string, unknown>): Internals {
  const runtime = Object.create(AvatarRuntime.prototype) as Internals;
  Object.assign(runtime as object, {
    disposed: false,
    current: null,
    documentUp: false,
    fpsAcc: 0,
    fpsFrames: 0,
    fps: 0,
    hudAcc: 0,
    frameListeners: new Set(),
    hudListeners: new Set(),
    shotCamera: { update: vi.fn(), camera: new THREE.PerspectiveCamera() },
    slides: { up: false },
    backdrop: { update: vi.fn() },
    postStage: { render: vi.fn() },
    ...fields,
  });
  return runtime;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('frame-rate readout', () => {
  it('counts real time below 20 fps while the simulation keeps its cap', () => {
    const update = vi.fn();
    const runtime = bareRuntime({
      timer: { update: vi.fn(), getDelta: () => 0.1 },
      backdrop: { update },
    });

    for (let i = 0; i < 6; i++) runtime.tick();

    expect(runtime.fps).toBe(10);
    expect(update.mock.calls.every(([dt]) => dt === 0.05)).toBe(true);
  });
});

describe('display pixel ratio', () => {
  it('reapplies the ratio and resizes on a display change, re-armed for the new one', () => {
    const queries: { media: string; listeners: Set<() => void> }[] = [];
    vi.stubGlobal('matchMedia', (media: string) => {
      const listeners = new Set<() => void>();
      queries.push({ media, listeners });
      return {
        media,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      };
    });
    vi.stubGlobal('devicePixelRatio', 1);
    const setPixelRatio = vi.fn();
    const runtime = bareRuntime({ preview: false, renderer: { setPixelRatio } });
    const resize = vi.fn();
    runtime.resize = resize;
    // The bound listener is a constructor-made field; this is what it calls.
    Object.assign(runtime as object, { onPixelRatioChange: () => runtime.applyPixelRatio() });

    runtime.watchPixelRatio();
    expect(queries[0]?.media).toBe('(resolution: 1dppx)');

    vi.stubGlobal('devicePixelRatio', 3);
    for (const fn of queries[0]?.listeners ?? []) fn();

    expect(setPixelRatio).toHaveBeenLastCalledWith(2);
    expect(resize).toHaveBeenCalledOnce();
    expect(queries[1]?.media).toBe('(resolution: 3dppx)');
    expect(queries[0]?.listeners.size).toBe(0);
    expect(queries[1]?.listeners.size).toBe(1);
  });

  it('renders the panel preview at 1x whatever the display', () => {
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal('devicePixelRatio', 2);
    const setPixelRatio = vi.fn();
    const runtime = bareRuntime({ preview: true, renderer: { setPixelRatio } });
    runtime.resize = vi.fn();

    runtime.applyPixelRatio();

    expect(setPixelRatio).toHaveBeenLastCalledWith(1);
  });
});

describe('output alpha follows the background', () => {
  function background(state: { documentUp: boolean; room: string | null; transparent: boolean }) {
    const setOpaque = vi.fn();
    const runtime = bareRuntime({
      slides: { up: state.documentUp },
      backdrop: { suspend: vi.fn(), resume: vi.fn(), current: state.room },
      scene: new THREE.Scene(),
      flat: new THREE.Color(0x0f1115),
      transparent: state.transparent,
      renderer: { setClearAlpha: vi.fn() },
      postStage: { render: vi.fn(), setOpaque, setFinish: vi.fn() },
    });
    runtime.updateBackground();
    return setOpaque.mock.calls.at(-1)?.[0];
  }

  it('is opaque behind a room or the flat colour, and not over a document or for keying', () => {
    expect(background({ documentUp: false, room: 'study', transparent: false })).toBe(true);
    expect(background({ documentUp: false, room: 'study', transparent: true })).toBe(true);
    expect(background({ documentUp: false, room: null, transparent: false })).toBe(true);
    expect(background({ documentUp: false, room: null, transparent: true })).toBe(false);
    expect(background({ documentUp: true, room: 'study', transparent: false })).toBe(false);
  });
});

describe('the finish follows the room', () => {
  const finish = {
    blur: { radius: 6, ramp: 2 },
    grade: { gain: [1, 1, 1], saturation: 1, contrast: 1 },
    vignette: 0.2,
  };

  function finished(state: { documentUp: boolean; room: string | null; transparent: boolean }) {
    const setFinish = vi.fn();
    const suspend = vi.fn();
    const runtime = bareRuntime({
      slides: { up: state.documentUp },
      backdrop: {
        suspend,
        resume: vi.fn(),
        current: state.room,
        finish: state.room === null ? null : finish,
      },
      scene: new THREE.Scene(),
      flat: new THREE.Color(0x0f1115),
      transparent: state.transparent,
      renderer: { setClearAlpha: vi.fn() },
      postStage: { render: vi.fn(), setOpaque: vi.fn(), setFinish },
    });
    runtime.updateBackground();
    expect(setFinish).toHaveBeenCalledOnce();
    return { finish: setFinish.mock.calls[0]?.[0], suspended: suspend.mock.calls.length > 0 };
  }

  it("passes a shown room's finish on", () => {
    expect(finished({ documentUp: false, room: 'study', transparent: false }).finish).toBe(finish);
    expect(finished({ documentUp: false, room: 'study', transparent: true }).finish).toBe(finish);
  });

  it('clears it with no room, flat or keyed', () => {
    expect(finished({ documentUp: false, room: null, transparent: false }).finish).toBeNull();
    expect(finished({ documentUp: false, room: null, transparent: true }).finish).toBeNull();
  });

  it('clears it while a document suspends the room', () => {
    const result = finished({ documentUp: true, room: 'study', transparent: false });
    expect(result.suspended).toBe(true);
    expect(result.finish).toBeNull();
  });
});

describe('the focus follows the avatar', () => {
  it('hands the stage and the key shadow the measured sphere in world space before each render', () => {
    const order: string[] = [];
    const seen: { centre: THREE.Vector3; radius: number }[] = [];
    const setFocus = vi.fn((centre: THREE.Vector3, radius: number) => {
      order.push('focus');
      seen.push({ centre: centre.clone(), radius });
    });
    const root = new THREE.Group();
    root.position.set(0.5, 0, -1);
    root.updateMatrixWorld();
    const runtime = bareRuntime({
      timer: { update: vi.fn(), getDelta: () => 1 / 60 },
      camWorld: new THREE.Vector3(),
      shotCamera: {
        update: vi.fn(),
        camera: new THREE.PerspectiveCamera(),
        takeCut: () => false,
      },
      current: {
        root,
        session: { update: vi.fn() },
        director: { update: vi.fn() },
      },
      focusSphere: { centre: new THREE.Vector3(0, 1.2, 0), radius: 0.9 },
      focusWorld: new THREE.Vector3(),
      postStage: { render: () => order.push('render'), setFocus, target: null },
      defaultRig: {
        fitShadow: (centre: THREE.Vector3, radius: number) => {
          order.push('shadow');
          seen.push({ centre: centre.clone(), radius });
        },
      },
      warmedTarget: null,
    });

    runtime.tick();

    expect(order).toEqual(['focus', 'shadow', 'render']);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0].centre.toArray()).toEqual([0.5, 1.2, -1]);
    expect(seen[0].radius).toBe(0.9);
  });

  it('gives no focus with no avatar', () => {
    const setFocus = vi.fn();
    const runtime = bareRuntime({
      timer: { update: vi.fn(), getDelta: () => 1 / 60 },
      focusSphere: null,
      postStage: { render: vi.fn(), setFocus, target: null },
      warmedTarget: null,
    });
    runtime.tick();
    expect(setFocus).not.toHaveBeenCalled();
  });
});
