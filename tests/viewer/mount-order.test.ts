import type * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { AvatarDescriptor } from '@/engine/types';
import { mountAvatar } from '@/viewer/scene/runtime/mount';
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
    mounted.materials.dispose();
  });
});
