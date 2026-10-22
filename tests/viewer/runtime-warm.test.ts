// @vitest-environment happy-dom

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { AvatarDescriptor } from '@/engine/types';
import { same } from '@/i18n/locale';
import { FULL_AVATAR } from '@/viewer/scene/placement';
import { AvatarRuntime } from '@/viewer/scene/runtime';
import type { RuntimeStatus } from '@/viewer/scene/runtime/types';

/** Which material set was on the avatar at each compile, as `apply` last left it. */
const applied: boolean[] = [];
const materials = {
  apply: vi.fn((useToon: boolean) => applied.push(useToon)),
  dispose: vi.fn(),
  rebindEnvironment: vi.fn(),
  names: [],
};

vi.mock('@/viewer/scene/runtime/mount', async (importActual) => ({
  ...(await importActual<typeof import('@/viewer/scene/runtime/mount')>()),
  mountAvatar: () => ({
    profile: {},
    director: {},
    wardrobe: {},
    materials,
    problems: [],
  }),
}));
vi.mock('@/viewer/scene/framing', () => ({ buildFramings: () => [] }));
vi.mock('@/engine/session', () => ({
  Session: class {
    dispose(): void {}
  },
}));

const avatar: AvatarDescriptor = { id: 'warm', label: same('warm'), url: '/warm.glb' };

function runtime(root: THREE.Group, compiles: Array<{ toon: boolean; visible: boolean }>) {
  let release!: () => void;
  const compiled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const instance = Object.create(AvatarRuntime.prototype) as AvatarRuntime;
  Object.assign(instance as object, {
    loader: { loadAsync: async () => ({ scene: root }) },
    current: null,
    loading: null,
    queued: null,
    warming: null,
    disposed: false,
    loadGeneration: 0,
    toon: true,
    avatarPlacement: FULL_AVATAR,
    status: { phase: 'idle' } satisfies RuntimeStatus,
    statusListeners: new Set<(status: RuntimeStatus) => void>(),
    scene: { add: vi.fn(), remove: vi.fn() },
    host: { clientWidth: 0, clientHeight: 0 },
    shotCamera: { rebuild: vi.fn(), camera: new THREE.PerspectiveCamera() },
    environment: { texture: null },
    postStage: { target: null },
    backdrop: {
      prewarm: () => {
        compiles.push({ toon: applied.at(-1) ?? true, visible: root.visible });
        return compiled;
      },
    },
  });
  return { instance, release };
}

describe('avatar shader warm-up', () => {
  it('compiles both material sets before the model is first drawn', async () => {
    applied.length = 0;
    const root = new THREE.Group();
    const compiles: Array<{ toon: boolean; visible: boolean }> = [];
    const { instance, release } = runtime(root, compiles);
    const phases: string[] = [];
    instance.onStatus((status) => phases.push(status.phase));

    const loading = instance.load(avatar);
    await vi.waitFor(() => expect(compiles).toHaveLength(2));

    expect(compiles).toEqual([
      { toon: true, visible: false },
      { toon: false, visible: false },
    ]);
    // The set the operator chose is put back synchronously.
    expect(applied.at(-1)).toBe(true);
    instance.setPlacement({ avatar: { visible: true } });
    expect(root.visible).toBe(false);
    expect(phases.at(-1)).toBe('loading');

    release();
    await loading;
    expect(root.visible).toBe(true);
    expect(phases.at(-1)).toBe('ready');
  });

  it('leaves a model torn down mid-warm hidden and unannounced', async () => {
    applied.length = 0;
    const root = new THREE.Group();
    const { instance, release } = runtime(root, []);
    const phases: string[] = [];
    instance.onStatus((status) => phases.push(status.phase));

    const loading = instance.load(avatar);
    await vi.waitFor(() => expect(instance.current).not.toBeNull());
    Object.assign(instance as object, { disposed: true });
    release();
    await loading;

    expect(root.visible).toBe(false);
    expect(phases).not.toContain('ready');
  });
});
