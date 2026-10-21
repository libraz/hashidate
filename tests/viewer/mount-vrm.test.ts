import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AvatarDescriptor } from '@/engine/types';
import { mountAvatar, withVrmHumanoid } from '@/viewer/scene/runtime/mount';

const base: AvatarDescriptor = {
  id: 'vrm',
  label: { en: 'VRM', ja: 'VRM' },
  url: '/vrm.glb',
};

describe('withVrmHumanoid', () => {
  it('tries the descriptor bone names first and appends the VRM ones per slot', () => {
    const merged = withVrmHumanoid(
      { ...base, bones: { head: ['Kopf'], 'hand.L': ['HandL'] } },
      { bones: { head: ['J_Bip_C_Head', 'Kopf'], neck: ['J_Bip_C_Neck'] }, fingers: {} },
    );
    expect(merged.bones?.head).toEqual(['Kopf', 'J_Bip_C_Head']);
    expect(merged.bones?.neck).toEqual(['J_Bip_C_Neck']);
    expect(merged.bones?.['hand.L']).toEqual(['HandL']);
  });

  it('keeps a stated finger chain whole and fills only the keys it leaves out', () => {
    const merged = withVrmHumanoid(
      { ...base, fingers: { 'index.L': ['a', 'b'] } },
      {
        bones: {},
        fingers: { 'index.L': ['x', 'y', 'z'], 'index.R': ['p', 'q'] },
      },
    );
    expect(merged.fingers).toEqual({ 'index.L': ['a', 'b'], 'index.R': ['p', 'q'] });
  });

  it('does not change the descriptor it was given', () => {
    const input = { ...base, bones: { head: ['Kopf'] } };
    withVrmHumanoid(input, { bones: { head: ['H'] }, fingers: {} });
    expect(input.bones).toEqual({ head: ['Kopf'] });
  });
});

describe('mountAvatar with VRM data', () => {
  /** Where the root's local +Z points in the world, on Z. */
  const forward = (root: THREE.Object3D): number => root.localToWorld(new THREE.Vector3(0, 0, 1)).z;

  const json = (legacy: boolean) =>
    legacy
      ? {
          nodes: [{ name: 'H' }],
          extensions: { VRM: { humanoid: { humanBones: [{ bone: 'head', node: 0 }] } } },
        }
      : {
          nodes: [{ name: 'H' }],
          extensions: { VRMC_vrm: { humanoid: { humanBones: { head: { node: 0 } } } } },
        };

  const mount = (root: THREE.Object3D, json: unknown): void => {
    const parser = json === undefined ? undefined : { json, associations: new Map() };
    try {
      mountAvatar(root, base, true, () => null, parser);
    } catch {
      // A bare group has no skeleton; only the root's orientation is under test.
    }
  };

  it('turns a VRM 0.x root to face +Z before measuring', () => {
    const root = new THREE.Group();
    mount(root, json(true));
    expect(forward(root)).toBeCloseTo(-1);
  });

  it('leaves a VRM 1.0 root and a plain glTF alone', () => {
    const modern = new THREE.Group();
    mount(modern, json(false));
    const plain = new THREE.Group();
    mount(plain, undefined);
    expect(forward(modern)).toBeCloseTo(1);
    expect(forward(plain)).toBeCloseTo(1);
  });
});
