// @vitest-environment happy-dom

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { AvatarDescriptor } from '@/engine/types';
import { same } from '@/i18n/locale';
import { AvatarRuntime } from '@/viewer/scene/runtime';
import { disposeRawAvatar } from '@/viewer/scene/runtime/mount';
import type { RuntimeStatus } from '@/viewer/scene/runtime/types';

type Pending<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function pending<T>(): Pending<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const avatar = (id: string): AvatarDescriptor => ({
  id,
  label: same(id),
  url: `/${id}.glb`,
});

/**
 * Build only the lifecycle state used by `load` and `dispose`.
 *
 * A WebGL context is a browser resource rather than part of this regression:
 * the real loader seam and a real three.js scene are enough to exercise the
 * continuation that used to publish after teardown.
 */
function bareRuntime(loader: { loadAsync: (url: string) => Promise<unknown> }): AvatarRuntime {
  const runtime = Object.create(AvatarRuntime.prototype) as AvatarRuntime;
  Object.assign(runtime as object, {
    loader,
    current: null,
    loading: null,
    queued: null,
    disposed: false,
    loadGeneration: 0,
    status: { phase: 'idle' } satisfies RuntimeStatus,
    statusListeners: new Set<(status: RuntimeStatus) => void>(),
    hudListeners: new Set(),
    frameListeners: new Set(),
    scene: { add: vi.fn(), remove: vi.fn() },
    renderer: {
      setAnimationLoop: vi.fn(),
      dispose: vi.fn(),
      domElement: { remove: vi.fn() },
    },
    resizeObserver: { disconnect: vi.fn() },
    timer: { dispose: vi.fn() },
    recorder: { dispose: vi.fn(async () => {}) },
    bgm: { dispose: vi.fn() },
    voice: { dispose: vi.fn() },
    audio: { dispose: vi.fn() },
    slides: { dispose: vi.fn() },
    backdrop: { dispose: vi.fn() },
    environment: { dispose: vi.fn() },
    shotCamera: { dispose: vi.fn() },
  });
  return runtime;
}

describe('raw avatar disposal', () => {
  it('releases shared geometry, skeleton, material, texture and image once', () => {
    const root = new THREE.Group();
    const image = { close: vi.fn() };
    const map = new THREE.Texture(image as unknown as HTMLImageElement);
    const material = new THREE.MeshBasicMaterial({ map });
    const geometry = new THREE.BufferGeometry();
    const bone = new THREE.Bone();
    const skeleton = new THREE.Skeleton([bone]);
    const plain = new THREE.Mesh(geometry, material);
    const skinned = new THREE.SkinnedMesh(geometry, material);
    skinned.add(bone);
    skinned.bind(skeleton);
    root.add(plain, skinned);

    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    const textureDispose = vi.spyOn(map, 'dispose');
    const skeletonDispose = vi.spyOn(skeleton, 'dispose');

    disposeRawAvatar(root);

    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
    expect(skeletonDispose).toHaveBeenCalledOnce();
    expect(image.close).toHaveBeenCalledOnce();
  });
});

describe('avatar load teardown', () => {
  it('discards a resolved load and its queued successor after disposal', async () => {
    const load = pending<unknown>();
    const calls: string[] = [];
    const runtime = bareRuntime({
      loadAsync: async (url) => {
        calls.push(url);
        return load.promise;
      },
    });
    const statuses: RuntimeStatus[] = [];
    runtime.onStatus((status) => statuses.push(status));

    const first = runtime.load(avatar('one'));
    void runtime.load(avatar('two'));
    runtime.dispose();
    load.resolve({ scene: new THREE.Group() });
    await first;

    expect(calls).toEqual(['/one.glb']);
    expect(runtime.avatarId).toBeNull();
    expect(statuses.map((status) => status.phase)).toEqual(['idle', 'loading']);
    expect((runtime as unknown as { current: unknown }).current).toBeNull();
  });

  it('does not publish a late load failure after disposal', async () => {
    const load = pending<unknown>();
    const runtime = bareRuntime({ loadAsync: () => load.promise });
    const statuses: RuntimeStatus[] = [];
    runtime.onStatus((status) => statuses.push(status));

    const request = runtime.load(avatar('missing'));
    runtime.dispose();
    load.reject(new Error('late failure'));
    await request;

    expect(statuses.map((status) => status.phase)).toEqual(['idle', 'loading']);
    expect(runtime.avatarId).toBeNull();
  });
});
