// @vitest-environment happy-dom

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { CameraFrame } from '@/engine/types';
import type { Framings } from '@/viewer/scene/framing';
import { AvatarRuntime } from '@/viewer/scene/runtime';
import { ShotCamera } from '@/viewer/scene/runtime/camera';

function framings(): Framings {
  const one = (y: number) => ({
    target: new THREE.Vector3(0, y, 0),
    position: new THREE.Vector3(0, y, 2),
    height: 1,
    halfWidth: 0.3,
  });
  const frames: Record<CameraFrame, ReturnType<typeof one>> = {
    face: one(1.5),
    bust: one(1.4),
    upper: one(1.2),
    full: one(0.9),
  };
  return frames;
}

function shotCamera(): ShotCamera {
  const camera = new ShotCamera(
    document.createElement('div'),
    { pointer: true, embedded: false },
    () => {},
  );
  camera.rebuild(framings());
  camera.takeCut();
  return camera;
}

describe('camera cut', () => {
  it('reports a placement once, and nothing for a frame that placed nothing', () => {
    const camera = shotCamera();
    expect(camera.takeCut()).toBe(false);
    camera.setShot({ yaw: 30 });
    expect(camera.takeCut()).toBe(true);
    expect(camera.takeCut()).toBe(false);
    camera.update();
    expect(camera.takeCut()).toBe(false);
    camera.rebuild(framings());
    expect(camera.takeCut()).toBe(true);
  });

  it('hands the director the shot a cue cut to in the same frame', () => {
    const shot = shotCamera();
    const seen: { target: THREE.Vector3; cut: boolean }[] = [];
    const runtime = Object.create(AvatarRuntime.prototype) as { tick(): void };
    Object.assign(runtime as object, {
      disposed: false,
      documentUp: false,
      fpsAcc: 0,
      fpsFrames: 0,
      fps: 0,
      hudAcc: 0,
      frameListeners: new Set(),
      hudListeners: new Set(),
      camWorld: new THREE.Vector3(),
      shotCamera: shot,
      slides: { up: false },
      backdrop: { update: vi.fn() },
      postStage: { render: vi.fn() },
      timer: { update: vi.fn(), getDelta: () => 1 / 60 },
      current: {
        session: { update: () => shot.setShot({ frame: 'full', yaw: 40 }) },
        director: {
          update: (_dt: number, ctx: { headWorldTarget: THREE.Vector3; cameraCut: boolean }) =>
            seen.push({ target: ctx.headWorldTarget.clone(), cut: ctx.cameraCut }),
        },
      },
    });
    runtime.tick();
    expect(seen[0].cut).toBe(true);
    expect(seen[0].target.distanceTo(shot.camera.getWorldPosition(new THREE.Vector3()))).toBe(0);
  });
});
