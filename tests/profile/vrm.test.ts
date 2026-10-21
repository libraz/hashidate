import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { loadedNodeNames, readVrmHumanoid } from '@/engine/profile';
import { collectBones, resolveBones } from '@/engine/profile/bones';

/** The extension keys, as the specs spell them. */
const VRM_1 = 'VRMC_vrm';
const VRM_0 = 'VRM';

const nodes = [
  { name: 'Root' },
  { name: 'J_Hips' },
  { name: 'J_Chest' },
  { name: 'J_UpperChest' },
  { name: 'J_LUpper' },
  { name: 'J_LThumb0' },
  { name: 'J_LThumb1' },
  { name: 'J_LThumb2' },
  { name: 'J_LIndex1' },
  { name: 'J_LIndex2' },
  { name: 'J_REye' },
];

const v1 = {
  nodes,
  extensions: {
    [VRM_1]: {
      humanoid: {
        humanBones: {
          hips: { node: 1 },
          chest: { node: 2 },
          upperChest: { node: 3 },
          leftUpperArm: { node: 4 },
          rightEye: { node: 10 },
          leftThumbMetacarpal: { node: 5 },
          leftThumbProximal: { node: 6 },
          leftThumbDistal: { node: 7 },
          leftIndexProximal: { node: 8 },
          leftIndexIntermediate: { node: 9 },
        },
      },
    },
  },
};

const v0 = {
  nodes,
  extensions: {
    [VRM_0]: {
      humanoid: {
        humanBones: [
          { bone: 'hips', node: 1 },
          { bone: 'leftUpperArm', node: 4 },
          { bone: 'leftThumbProximal', node: 5 },
          { bone: 'leftThumbIntermediate', node: 6 },
          { bone: 'leftThumbDistal', node: 7 },
        ],
      },
    },
  },
};

describe('readVrmHumanoid', () => {
  it('reads a VRM 1.0 map', () => {
    const map = readVrmHumanoid(v1);

    expect(map?.legacy).toBe(false);
    expect(map?.bones.hips).toEqual(['J_Hips']);
    expect(map?.bones['upperArm.L']).toEqual(['J_LUpper']);
    expect(map?.bones['eye.R']).toEqual(['J_REye']);
  });

  it('lists the upper chest before the chest', () => {
    expect(readVrmHumanoid(v1)?.bones.chest).toEqual(['J_UpperChest', 'J_Chest']);
  });

  it('starts the 1.0 thumb at its metacarpal', () => {
    const fingers = readVrmHumanoid(v1)?.fingers;

    expect(fingers?.['thumb.L']).toEqual(['J_LThumb0', 'J_LThumb1', 'J_LThumb2']);
    expect(fingers?.['index.L']).toEqual(['J_LIndex1', 'J_LIndex2']);
    expect(fingers?.['index.R']).toBeUndefined();
  });

  it('reads a VRM 0.x map and says so', () => {
    const map = readVrmHumanoid(v0);

    expect(map?.legacy).toBe(true);
    expect(map?.bones.hips).toEqual(['J_Hips']);
    expect(map?.fingers['thumb.L']).toEqual(['J_LThumb0', 'J_LThumb1', 'J_LThumb2']);
  });

  it('skips a bone whose node does not exist', () => {
    const map = readVrmHumanoid({
      nodes: [{ name: 'A' }],
      extensions: {
        [VRM_1]: { humanoid: { humanBones: { hips: { node: 9 }, head: { node: 0 } } } },
      },
    });

    expect(map?.bones).toEqual({ head: ['A'] });
  });

  it.each([[null], [{}], [{ extensions: {} }], [{ nodes, extensions: { [VRM_0]: {} } }], ['x']])(
    'returns null without a humanoid map: %j',
    (gltf) => {
      expect(readVrmHumanoid(gltf)).toBeNull();
    },
  );
});

describe('readVrmHumanoid against a loaded scene', () => {
  /** Two joints share a name; the humanoid map points at the second. */
  const duplicated = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Armature', children: [1, 2] }, { name: 'Hips' }, { name: 'Hips' }],
    skins: [{ joints: [1, 2] }],
    extensions: { [VRM_1]: { humanoid: { humanBones: { hips: { node: 2 } } } } },
  };

  it('binds the node the map names, not the first node with its name', async () => {
    const gltf = await new GLTFLoader().parseAsync(JSON.stringify(duplicated), '');
    const second = [...gltf.parser.associations].find(([, ref]) => ref.nodes === 2)?.[0];

    const map = readVrmHumanoid(gltf.parser.json, loadedNodeNames(gltf.parser.associations));
    const { value: bones } = resolveBones(collectBones(gltf.scene), map?.bones);

    expect(second).toBeDefined();
    expect(bones.hips).toBe(second as THREE.Object3D);
  });
});
