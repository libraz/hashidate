import * as THREE from 'three';
import type { GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import type { AvatarDescriptor } from '@/engine/types';
import { disposeAvatar, mountAvatar } from '@/viewer/scene/runtime/mount';
import { resolveTransparentTriangleTargets } from '@/viewer/scene/runtime/transparent-triangle-policy';
import type { LoadedAvatar } from '@/viewer/scene/runtime/types';
import { buildRig } from '../helpers/scene';

/** Construction order, and how many outline hulls each step saw on the avatar. */
const seen = vi.hoisted(() => {
  const hulls = (root: THREE.Object3D | null): number => {
    let n = 0;
    root?.traverse((o) => {
      if (o.userData.outline === true) n++;
    });
    return n;
  };
  return {
    order: [] as string[],
    hullsAt: {} as Record<string, number>,
    root: null as THREE.Object3D | null,
    hulls,
  };
});

vi.mock('@/engine/director', () => ({
  Director: class {
    presets = [];
    spring = { missing: [] };
    tail = { missing: [] };
    rig = { armSolverOff: [] };
    constructor() {
      seen.order.push('Director');
      seen.hullsAt.Director = seen.hulls(seen.root);
    }
  },
}));

vi.mock('@/engine/scene', async (importActual) => {
  const actual = await importActual<typeof import('@/engine/scene')>();
  return {
    ...actual,
    Wardrobe: class {
      missing: string[] = [];
      constructor(root: THREE.Object3D) {
        seen.order.push('Wardrobe');
        seen.hullsAt.Wardrobe = seen.hulls(root);
      }
    },
    setupMaterials: (...args: Parameters<typeof actual.setupMaterials>) => {
      const set = actual.setupMaterials(...args);
      return {
        ...set,
        installOutlines: () => {
          seen.order.push('installOutlines');
          set.installOutlines();
        },
      };
    },
  };
});

describe('mountAvatar', () => {
  it('installs the outlines only after the director and the wardrobe have walked the meshes', () => {
    const rig = buildRig();
    seen.root = rig.root;
    const descriptor: AvatarDescriptor = {
      ...rig.descriptor,
      materials: {
        toon: {
          Body: {
            shadow: { color: [1, 1, 1], border: 0.5, blur: 0.1, strength: 1, normalStrength: 1 },
            outline: { width: 0.08, color: [0, 0, 0, 1], fixWidth: 0 },
          },
        },
      },
    };

    const mounted = mountAvatar(rig.root, descriptor, true, () => null);

    expect(seen.order).toEqual(['Director', 'Wardrobe', 'installOutlines']);
    expect(seen.hullsAt).toEqual({ Director: 0, Wardrobe: 0 });
    // The hull did go on, so the zeros above are about order, not absence.
    expect(seen.hulls(rig.root)).toBe(1);
    mounted.transparentTriangles.dispose();
    mounted.materials.dispose();
  });

  it('disposes transparent sorting before source materials and geometry', () => {
    const order: string[] = [];
    const root = new THREE.Group();
    const geometry = new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    root.add(mesh);
    geometry.addEventListener('dispose', () => order.push('geometry'));
    const loaded = {
      root,
      transparentTriangles: { dispose: () => order.push('transparent-triangles') },
      director: { spring: { dispose: () => undefined } },
      materials: { dispose: () => order.push('materials') },
    } as unknown as LoadedAvatar;

    disposeAvatar(loaded);

    expect(order).toEqual(['transparent-triangles', 'materials', 'geometry']);
  });
});

describe('embedded transparent triangle resolution', () => {
  function parserFor(
    policy?: unknown,
    associations: Map<object, { nodes?: number; meshes?: number; primitives?: number }> = new Map(),
  ): Pick<GLTFParser, 'json' | 'associations'> {
    return {
      json: {
        asset: {
          version: '2.0',
          extras: {
            mimesis: {
              physics: { profile: 'preserved-unrelated-data' },
              rendering: policy === undefined ? {} : { transparentTriangles: policy },
            },
          },
        },
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{}, {}] }],
      },
      associations,
    } as unknown as Pick<GLTFParser, 'json' | 'associations'>;
  }

  it('resolves only the exact original parser association, not an unassociated geometry clone', () => {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.MeshBasicMaterial();
    const original = new THREE.Mesh(geometry, material);
    const variant = new THREE.Mesh(geometry, material);
    variant.userData.sourcePartVariantId = 'sleeve-copy';
    const root = new THREE.Group().add(original, variant);
    const associations = new Map<object, { nodes?: number; meshes?: number; primitives?: number }>([
      [original, { nodes: 0, meshes: 0, primitives: 0 }],
      [variant, { nodes: 0, meshes: 0, primitives: 0 }],
    ]);
    const parser = parserFor(
      {
        method: 'camera-depth@1',
        targets: [{ nodeIndex: 0, primitiveIndex: 0, category: 'clothing' }],
      },
      associations,
    );

    expect(resolveTransparentTriangleTargets(root, parser)).toEqual([
      { key: 'node:0:primitive:0', mesh: original },
    ]);
    expect(resolveTransparentTriangleTargets(root, parserFor())).toEqual([]);
  });

  it('maps a multi-primitive node through its mesh group and primitive association', () => {
    const first = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    const selected = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    const meshGroup = new THREE.Group().add(first, selected);
    const root = new THREE.Group().add(meshGroup);
    const associations = new Map<object, { nodes?: number; meshes?: number; primitives?: number }>([
      [meshGroup, { nodes: 0, meshes: 0 }],
      [first, { meshes: 0, primitives: 0 }],
      [selected, { meshes: 0, primitives: 1 }],
    ]);
    const parser = parserFor(
      {
        method: 'camera-depth@1',
        targets: [{ nodeIndex: 0, primitiveIndex: 1, category: 'clothing' }],
      },
      associations,
    );

    expect(resolveTransparentTriangleTargets(root, parser)).toEqual([
      { key: 'node:0:primitive:1', mesh: selected },
    ]);
  });

  it('rejects stale and non-triangle primitive associations instead of widening the target', () => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    const root = new THREE.Group().add(mesh);
    const associations = new Map([[mesh, { nodes: 0, meshes: 0, primitives: 0 }]]);
    const policy = (primitiveIndex: number) => ({
      method: 'camera-depth@1',
      targets: [{ nodeIndex: 0, primitiveIndex, category: 'accessory' }],
    });

    expect(() =>
      resolveTransparentTriangleTargets(root, parserFor(policy(2), associations)),
    ).toThrow(/node 0 primitive 2/i);

    const lineParser = parserFor(policy(0), associations);
    (lineParser.json.meshes[0]!.primitives[0] as { mode?: number }).mode = 1;
    expect(() => resolveTransparentTriangleTargets(root, lineParser)).toThrow(/TRIANGLES/i);
  });

  it('rejects malformed or unsupported embedded policy values', () => {
    const root = new THREE.Group();
    expect(() =>
      resolveTransparentTriangleTargets(
        root,
        parserFor({
          method: 'camera-depth@1',
          targets: [{ nodeIndex: 0, primitiveIndex: 0, category: 'body' }],
        }),
      ),
    ).toThrow();
  });
});
