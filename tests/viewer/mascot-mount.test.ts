// @vitest-environment happy-dom

import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShotAngle } from '@/engine/types';
import type { Shot } from '@/protocol';
import { mountMascot } from '@/viewer/mascot';
import type { AvatarRuntime } from '@/viewer/scene/runtime';
import type { MascotBridge } from '@/viewer/shell-bridge';

/** As much of the runtime as the mount reads: a camera with nothing to hit, and the shot. */
function fakeRuntime() {
  const setShot = vi.fn<(shot: Shot) => void>();
  const runtime = {
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: document.createElement('canvas') },
    raycastTargets: null,
    shot: { frame: 'full', yaw: 0, pitch: 0, zoom: 1 } satisfies Required<Shot>,
    setShot,
  };
  return { runtime: runtime as unknown as AvatarRuntime, setShot };
}

/** A bridge whose shot listeners the test calls by hand. */
function fakeBridge() {
  const listeners = new Set<(angle: ShotAngle) => void>();
  const bridge: MascotBridge = {
    setInteractive: vi.fn(),
    moveBy: vi.fn(),
    scaleBy: vi.fn(),
    turnTo: vi.fn(),
    onShot: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const send = (angle: ShotAngle) => {
    for (const fn of listeners) fn(angle);
  };
  return { bridge, send, listeners };
}

const client = { pushEvent: vi.fn() };

afterEach(() => {
  delete window.hashidateMascot;
});

describe('mounting a mascot', () => {
  it('shows each angle the window hands it, until stopped', () => {
    const { runtime, setShot } = fakeRuntime();
    const { bridge, send, listeners } = fakeBridge();
    window.hashidateMascot = bridge;

    const stop = mountMascot(runtime, client);
    expect(listeners.size).toBe(1);
    send({ yaw: 30, pitch: -10 });
    send({ yaw: 0, pitch: 0 });
    expect(setShot.mock.calls).toEqual([[{ yaw: 30, pitch: -10 }], [{ yaw: 0, pitch: 0 }]]);

    stop();
    expect(listeners.size).toBe(0);
    send({ yaw: 90, pitch: 20 });
    expect(setShot).toHaveBeenCalledTimes(2);
  });

  it('does nothing on a page no mascot window opened', () => {
    const { runtime, setShot } = fakeRuntime();
    const stop = mountMascot(runtime, client);
    stop();
    expect(setShot).not.toHaveBeenCalled();
  });
});
