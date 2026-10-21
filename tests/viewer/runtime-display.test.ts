// @vitest-environment happy-dom

import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarRuntime } from '@/viewer/scene/runtime';

type Internals = {
  fps: number;
  tick(): void;
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
    bloomStage: { render: vi.fn() },
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
    const runtime = bareRuntime({ embedded: false, renderer: { setPixelRatio } });
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

  it('renders the framed preview at 1x whatever the display', () => {
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal('devicePixelRatio', 2);
    const setPixelRatio = vi.fn();
    const runtime = bareRuntime({ embedded: true, renderer: { setPixelRatio } });
    runtime.resize = vi.fn();

    runtime.applyPixelRatio();

    expect(setPixelRatio).toHaveBeenLastCalledWith(1);
  });
});
