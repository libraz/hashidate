import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createAvatarLoader,
  resolveTransparentTriangleTargets,
} from '@/viewer/scene/runtime/transparent-triangle-policy';

interface FixtureTarget {
  nodeIndex: number;
  primitiveIndex: number;
  category: 'clothing' | 'accessory';
}

interface FixturePrimitive {
  attributes: { POSITION: number };
  indices: number;
  material: number;
  mode?: number;
}

interface FixtureJson {
  asset: {
    version: '2.0';
    extras: { mimesis: { physics: { keep: boolean }; rendering: Record<string, unknown> } };
  };
  scene: number;
  scenes: Array<{ nodes: number[] }>;
  nodes: Array<{ mesh: number; name?: string }>;
  meshes: Array<{ name?: string; primitives: FixturePrimitive[] }>;
  materials: Array<{ alphaMode: 'BLEND'; doubleSided: true }>;
  buffers: Array<{ byteLength: number }>;
  bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }>;
  accessors: Array<{
    bufferView: number;
    componentType: number;
    count: number;
    type: 'VEC3' | 'SCALAR';
    min?: number[];
    max?: number[];
  }>;
}

const targetSet: FixtureTarget[] = [
  { nodeIndex: 0, primitiveIndex: 1, category: 'clothing' },
  { nodeIndex: 1, primitiveIndex: 0, category: 'accessory' },
  { nodeIndex: 2, primitiveIndex: 0, category: 'clothing' },
];

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}

function fixture(
  options: {
    defaultSceneIndex?: number;
    reuseNodeInAlternateScene?: boolean;
    targets?: FixtureTarget[] | null;
    modeForNode0Primitive1?: number;
  } = {},
): { bytes: Uint8Array; json: FixtureJson } {
  const defaultSceneIndex = options.defaultSceneIndex ?? 0;
  const alternateNodes = options.reuseNodeInAlternateScene ? [0, 3] : [3];
  const scenes: FixtureJson['scenes'] = [{ nodes: [] }, { nodes: [] }];
  if (defaultSceneIndex === 0 || defaultSceneIndex === 1) {
    scenes[defaultSceneIndex] = { nodes: [0, 1, 2] };
    scenes[1 - defaultSceneIndex] = { nodes: alternateNodes };
  }

  const primitive = (): FixturePrimitive => ({
    attributes: { POSITION: 0 },
    indices: 1,
    material: 0,
  });
  const meshZeroPrimitives = [primitive(), primitive()];
  if (options.modeForNode0Primitive1 !== undefined) {
    meshZeroPrimitives[1]!.mode = options.modeForNode0Primitive1;
  }

  const json: FixtureJson = {
    asset: {
      version: '2.0',
      extras: { mimesis: { physics: { keep: true }, rendering: {} } },
    },
    scene: defaultSceneIndex,
    scenes,
    nodes: [
      { mesh: 0, name: 'same-name' },
      { mesh: 0, name: 'same-name' },
      { mesh: 1, name: '' },
      { mesh: 0, name: 'same-name' },
    ],
    meshes: [
      { name: 'same-mesh-name', primitives: meshZeroPrimitives },
      { name: '', primitives: [primitive()] },
    ],
    materials: [{ alphaMode: 'BLEND', doubleSided: true }],
    buffers: [{ byteLength: 42 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [-0.5, -0.5, -1],
        max: [0.5, 0.5, -1],
      },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  };
  if (options.targets !== null) {
    json.asset.extras.mimesis.rendering.transparentTriangles = {
      method: 'camera-depth@1',
      targets: options.targets ?? targetSet,
    };
  }

  const binary = new Uint8Array(44);
  const binaryView = new DataView(binary.buffer);
  const positions = [-0.5, -0.5, -1, 0.5, -0.5, -1, 0, 0.5, -1];
  for (let index = 0; index < positions.length; index += 1) {
    binaryView.setFloat32(index * 4, positions[index]!, true);
  }
  for (const [index, value] of [0, 1, 2].entries()) {
    binaryView.setUint16(36 + index * 2, value, true);
  }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(jsonBytes.byteLength);
  const totalLength = 20 + jsonLength + 8 + binary.byteLength;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(jsonBytes, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binary.byteLength, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true);
  bytes.set(binary, binaryHeader + 8);
  return { bytes, json };
}

async function parseFixture(options: Parameters<typeof fixture>[0] = {}) {
  const source = fixture(options);
  const before = source.bytes.slice();
  const input = new ArrayBuffer(source.bytes.byteLength);
  new Uint8Array(input).set(source.bytes);
  const gltf = await createAvatarLoader().parseAsync(input, '');
  return { ...source, before, gltf };
}

function primitiveMeshes(node: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  node.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  return meshes;
}

function arraySnapshots(meshes: readonly THREE.Mesh[]) {
  return meshes.map((mesh) => {
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.index;
    return {
      position,
      positionValues: Array.from(position.array),
      index,
      indexValues: index === null ? null : Array.from(index.array),
    };
  });
}

function expectArraysUnchanged(
  meshes: readonly THREE.Mesh[],
  snapshots: ReturnType<typeof arraySnapshots>,
) {
  expect(meshes).toHaveLength(snapshots.length);
  for (let index = 0; index < meshes.length; index += 1) {
    const mesh = meshes[index]!;
    const snapshot = snapshots[index]!;
    expect(mesh.geometry.getAttribute('position')).toBe(snapshot.position);
    expect(Array.from(snapshot.position.array)).toEqual(snapshot.positionValues);
    expect(mesh.geometry.index).toBe(snapshot.index);
    expect(mesh.geometry.index === null ? null : Array.from(mesh.geometry.index.array)).toEqual(
      snapshot.indexValues,
    );
  }
}

describe('production transparent-triangle loader associations', () => {
  it.each([
    { defaultSceneIndex: 0, reuseNodeInAlternateScene: false },
    { defaultSceneIndex: 0, reuseNodeInAlternateScene: true },
    { defaultSceneIndex: 1, reuseNodeInAlternateScene: false },
    { defaultSceneIndex: 1, reuseNodeInAlternateScene: true },
  ])(
    'resolves exact default-scene primitives after alternate scene pruning: %o',
    async (options) => {
      const { bytes, before, gltf } = await parseFixture(options);
      const root = gltf.scene;
      const defaultNodes = root.children.slice(0, 3);
      expect(defaultNodes).toHaveLength(3);
      const expected = [
        primitiveMeshes(defaultNodes[0]!)[1]!,
        primitiveMeshes(defaultNodes[1]!)[0]!,
        primitiveMeshes(defaultNodes[2]!)[0]!,
      ];
      expect(expected.every((mesh) => mesh !== undefined)).toBe(true);
      expect(primitiveMeshes(defaultNodes[0]!)[0]!.geometry).toBe(
        primitiveMeshes(defaultNodes[1]!)[0]!.geometry,
      );
      expect(primitiveMeshes(defaultNodes[0]!)[1]!.geometry).toBe(
        primitiveMeshes(defaultNodes[1]!)[1]!.geometry,
      );
      expect(new Set(expected).size).toBe(3);

      const defaultMeshes = defaultNodes.flatMap(primitiveMeshes);
      const arrays = arraySnapshots(defaultMeshes);
      const originalNames = expected.map((mesh) => mesh.name);
      const unassociatedClone = expected[0]!.clone();
      unassociatedClone.name = expected[0]!.name;
      const taggedVariant = expected[0]!.clone();
      taggedVariant.name = expected[0]!.name;
      taggedVariant.userData.sourcePartVariantId = 'synthetic-variant';
      root.add(unassociatedClone, taggedVariant);
      gltf.parser.associations.set(taggedVariant, { nodes: 0, meshes: 0, primitives: 1 });

      const nodeAssociations = [...gltf.parser.associations.values()]
        .filter((association) => association.nodes !== undefined)
        .map((association) => association.nodes);
      expect(nodeAssociations).toContain(3);
      expect(nodeAssociations).not.toContain(1);
      expect(nodeAssociations).not.toContain(2);
      const targets = resolveTransparentTriangleTargets(root, gltf.parser);
      expect(targets.map(({ mesh }) => mesh)).toEqual(expected);
      expect(targets.map(({ mesh }) => mesh.name)).toEqual(originalNames);
      expect(targets.some(({ mesh }) => mesh === unassociatedClone)).toBe(false);
      expect(targets.some(({ mesh }) => mesh === taggedVariant)).toBe(false);
      expectArraysUnchanged(defaultMeshes, arrays);
      expect(bytes).toEqual(before);
      expect(gltf.parser.associations.set).toBe(Map.prototype.set);
      expect(Object.getOwnPropertyDescriptor(gltf.parser, 'associations')?.get).toBeUndefined();
    },
  );

  it.each([
    { label: 'absent', targets: null },
    { label: 'empty', targets: [] },
  ])('does not select or alter the loader path when policy is $label', async ({ targets }) => {
    const { bytes, before, gltf } = await parseFixture({ targets });
    const originalAssociations = gltf.parser.associations;
    const originalMapSet = originalAssociations.set;
    const meshes = primitiveMeshes(gltf.scene);
    const arrays = arraySnapshots(meshes);

    expect(resolveTransparentTriangleTargets(gltf.scene, gltf.parser)).toEqual([]);
    expect(gltf.scene.children).toHaveLength(3);
    expect(gltf.parser.associations).toBe(originalAssociations);
    expect(originalMapSet).toBe(Map.prototype.set);
    expectArraysUnchanged(meshes, arrays);
    expect(bytes).toEqual(before);
  });

  it('rejects targets outside the default scene, stale primitives, and non-TRIANGLES modes', async () => {
    const nondefault = await parseFixture();
    nondefault.gltf.parser.json.asset.extras.mimesis.rendering.transparentTriangles = {
      method: 'camera-depth@1',
      targets: [{ nodeIndex: 3, primitiveIndex: 0, category: 'clothing' }],
    };
    expect(() =>
      resolveTransparentTriangleTargets(nondefault.gltf.scene, nondefault.gltf.parser),
    ).toThrow(/default scene/i);

    const stale = await parseFixture();
    stale.gltf.parser.json.asset.extras.mimesis.rendering.transparentTriangles = {
      method: 'camera-depth@1',
      targets: [{ nodeIndex: 0, primitiveIndex: 2, category: 'clothing' }],
    };
    expect(() => resolveTransparentTriangleTargets(stale.gltf.scene, stale.gltf.parser)).toThrow(
      /node 0 primitive 2/i,
    );

    const lines = await parseFixture({
      targets: [{ nodeIndex: 0, primitiveIndex: 1, category: 'clothing' }],
      modeForNode0Primitive1: 1,
    });
    expect(() => resolveTransparentTriangleTargets(lines.gltf.scene, lines.gltf.parser)).toThrow(
      /TRIANGLES/i,
    );
  });

  it('rejects an invalid declared default scene index before resolving targets', async () => {
    await expect(parseFixture({ defaultSceneIndex: 7 })).rejects.toThrow(/default scene index/i);
  });

  it('rejects a mounted root other than the captured default-scene root', async () => {
    const { gltf } = await parseFixture();
    expect(() => resolveTransparentTriangleTargets(new THREE.Group(), gltf.parser)).toThrow(
      /default scene provenance/i,
    );
  });
});
