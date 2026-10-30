// @vitest-environment happy-dom

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { TransparentTriangleController } from '@/engine/scene/transparent-triangles';
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
let inTriangleDraw = false;
const triangleDraws: number[] = [];

vi.mock('@/viewer/scene/runtime/mount', async (importActual) => ({
  ...(await importActual<typeof import('@/viewer/scene/runtime/mount')>()),
  mountAvatar: () => ({
    profile: {},
    director: {},
    wardrobe: {},
    materials,
    transparentTriangles: {
      withDraw: (_camera: THREE.Camera, draw: () => unknown) => {
        triangleDraws.push(1);
        inTriangleDraw = true;
        try {
          return draw();
        } finally {
          inTriangleDraw = false;
        }
      },
      dispose: vi.fn(),
    },
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

function runtime(
  root: THREE.Group,
  compiles: Array<{ toon: boolean; visible: boolean; wrapped: boolean }>,
) {
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
    scene: { add: vi.fn(), remove: vi.fn(), updateMatrixWorld: vi.fn() },
    host: { clientWidth: 0, clientHeight: 0 },
    shotCamera: { rebuild: vi.fn(), camera: new THREE.PerspectiveCamera() },
    environment: { texture: null },
    postStage: { target: null },
    backdrop: {
      prewarm: () => {
        compiles.push({
          toon: applied.at(-1) ?? true,
          visible: root.visible,
          wrapped: inTriangleDraw,
        });
        return compiled;
      },
    },
  });
  return { instance, release };
}

describe('avatar shader warm-up', () => {
  it('compiles both material sets before the model is first drawn', async () => {
    applied.length = 0;
    triangleDraws.length = 0;
    const root = new THREE.Group();
    const compiles: Array<{ toon: boolean; visible: boolean; wrapped: boolean }> = [];
    const { instance, release } = runtime(root, compiles);
    const phases: string[] = [];
    instance.onStatus((status) => phases.push(status.phase));

    const loading = instance.load(avatar);
    await vi.waitFor(() => expect(compiles).toHaveLength(2));

    expect(compiles).toEqual([
      { toon: true, visible: true, wrapped: true },
      { toon: false, visible: true, wrapped: true },
    ]);
    expect(root.visible).toBe(false);
    expect(triangleDraws).toHaveLength(2);
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
    triangleDraws.length = 0;
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

  it('starts prewarm with sorted clones installed and restores them before compilation awaits', async () => {
    let release!: () => void;
    const compiled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const root = new THREE.Group();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, -1, 1, -1, -2, 0, 1, -3], 3),
    );
    geometry.setIndex([0, 1, 2]);
    const first = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });
    const second = first.clone();
    const mesh = new THREE.Mesh(geometry, first);
    root.add(mesh);
    root.visible = false;
    const sourceGeometry = mesh.geometry;
    const controller = new TransparentTriangleController();
    controller.reconcile([{ key: 'node:0:primitive:0', mesh }]);
    const scene = new THREE.Scene().add(root);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 8;
    scene.add(camera);
    const observations: Array<{ visible: boolean; swapped: boolean }> = [];
    const materialSet = {
      apply: vi.fn((toon: boolean) => {
        mesh.material = toon ? first : second;
      }),
      dispose: vi.fn(),
      rebindEnvironment: vi.fn(),
      names: [],
    };
    const instance = Object.create(AvatarRuntime.prototype) as AvatarRuntime;
    Object.assign(instance as object, {
      disposed: false,
      current: { root, materials: materialSet, transparentTriangles: controller },
      toon: true,
      postStage: { target: null },
      scene,
      shotCamera: { camera },
      backdrop: {
        prewarm: () => {
          observations.push({ visible: root.visible, swapped: mesh.geometry !== sourceGeometry });
          expect(mesh.material).not.toBe(first);
          expect(mesh.material).not.toBe(second);
          return compiled;
        },
      },
    });

    const prewarming = (instance as unknown as { prewarm: () => Promise<void> }).prewarm();

    expect(observations).toEqual([
      { visible: true, swapped: true },
      { visible: true, swapped: true },
    ]);
    expect(root.visible).toBe(false);
    expect(mesh.geometry).toBe(sourceGeometry);
    expect(mesh.material).toBe(first);
    expect(controller.inspect().counters.materialClonesCreated).toBe(2);
    expect(controller.inspect().counters.geometryShellsCreated).toBe(1);
    release();
    await prewarming;
    controller.dispose();
    first.dispose();
    second.dispose();
    geometry.dispose();
  });

  it('keeps both selected and opposite triangle clones warm through deferred compilation', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const root = new THREE.Group();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, -1, 1, -1, -3, 0, 1, -2], 3),
    );
    geometry.setIndex([0, 1, 2]);
    const toon = transparentMaterialForWarmup();
    const imported = transparentMaterialForWarmup();
    const mesh = new THREE.Mesh(geometry, toon);
    root.add(mesh);
    root.visible = false;
    const controller = new TransparentTriangleController();
    controller.reconcile([{ key: 'warm-cache', mesh }]);
    const scene = new THREE.Scene().add(root);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 8;
    const materials = {
      apply: vi.fn((useToon: boolean) => {
        mesh.material = useToon ? toon : imported;
      }),
      dispose: vi.fn(),
      rebindEnvironment: vi.fn(),
      names: [],
    };
    const startedMaterials: THREE.Material[] = [];
    const disposed = new Set<THREE.Material>();
    let compileCalls = 0;
    const instance = Object.create(AvatarRuntime.prototype) as AvatarRuntime;
    Object.assign(instance as object, {
      disposed: false,
      current: { root, materials, transparentTriangles: controller },
      toon: true,
      postStage: { target: null },
      scene,
      shotCamera: { camera },
      backdrop: {
        prewarm: () => {
          compileCalls += 1;
          const compiled = mesh.material as THREE.Material;
          startedMaterials.push(compiled);
          compiled.addEventListener('dispose', () => disposed.add(compiled));
          expect(mesh.geometry).not.toBe(geometry);
          return compileCalls <= 2 ? pending : Promise.resolve();
        },
      },
    });

    const warming = (instance as unknown as { prewarm: () => Promise<void> }).prewarm();
    expect(startedMaterials).toHaveLength(2);
    expect(startedMaterials[0]).not.toBe(startedMaterials[1]);
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(toon);
    expect(root.visible).toBe(false);
    expect(disposed.size).toBe(0);
    expect(controller.inspect().counters.materialClonesCreated).toBe(2);
    expect(controller.inspect().counters.materialClonesDisposed).toBe(0);
    expect(controller.inspect().counters.geometryShellsCreated).toBe(1);

    root.visible = true;
    materials.apply(false);
    let firstOppositeMaterial: THREE.Material | undefined;
    controller.withDraw(camera, () => {
      firstOppositeMaterial = mesh.material as THREE.Material;
    });
    expect(firstOppositeMaterial).toBe(startedMaterials[1]);
    materials.apply(true);
    let firstVisibleMaterial: THREE.Material | undefined;
    controller.withDraw(camera, () => {
      firstVisibleMaterial = mesh.material as THREE.Material;
    });
    expect(firstVisibleMaterial).toBe(startedMaterials[0]);
    const beforeModeRevisit = controller.inspect().counters;
    release();
    await warming;
    await (instance as unknown as { prewarm: () => Promise<void> }).prewarm();
    const afterModeRevisit = controller.inspect().counters;
    expect(afterModeRevisit.vertexEvaluations).toBe(beforeModeRevisit.vertexEvaluations);
    expect(afterModeRevisit.sorts).toBe(beforeModeRevisit.sorts);
    expect(afterModeRevisit.indexUploads).toBe(beforeModeRevisit.indexUploads);
    expect(afterModeRevisit.materialClonesCreated).toBe(2);
    expect(afterModeRevisit.materialClonesDisposed).toBe(0);
    expect(afterModeRevisit.geometryShellsCreated).toBe(1);
    controller.dispose();
    expect(disposed).toEqual(new Set(startedMaterials));
    toon.dispose();
    imported.dispose();
    geometry.dispose();
  });

  it('restores source material and visibility if opposite warm-up throws synchronously', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const root = new THREE.Group();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, -1, 1, -1, -3, 0, 1, -2], 3),
    );
    geometry.setIndex([0, 1, 2]);
    const toon = transparentMaterialForWarmup();
    const imported = transparentMaterialForWarmup();
    const mesh = new THREE.Mesh(geometry, toon);
    root.add(mesh);
    root.visible = false;
    const controller = new TransparentTriangleController();
    controller.reconcile([{ key: 'warm-throw', mesh }]);
    const scene = new THREE.Scene().add(root);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 8;
    const materials = {
      apply: vi.fn((useToon: boolean) => {
        mesh.material = useToon ? toon : imported;
      }),
      dispose: vi.fn(),
      rebindEnvironment: vi.fn(),
      names: [],
    };
    let compileCalls = 0;
    const instance = Object.create(AvatarRuntime.prototype) as AvatarRuntime;
    Object.assign(instance as object, {
      disposed: false,
      current: { root, materials, transparentTriangles: controller },
      toon: true,
      postStage: { target: null },
      scene,
      shotCamera: { camera },
      backdrop: {
        prewarm: () => {
          compileCalls += 1;
          if (compileCalls === 2) throw new Error('opposite compile start failed');
          return pending;
        },
      },
    });

    const warming = (instance as unknown as { prewarm: () => Promise<void> }).prewarm();
    expect(compileCalls).toBe(2);
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(toon);
    expect(root.visible).toBe(false);
    release();
    await warming;
    controller.dispose();
    toon.dispose();
    imported.dispose();
    geometry.dispose();
  });
});

function transparentMaterialForWarmup() {
  return new THREE.MeshStandardMaterial({
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
  });
}
