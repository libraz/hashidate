import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SceneryAssets } from '@/viewer/scene/backdrop/assets';

const box = (min: THREE.Vector3, max: THREE.Vector3): THREE.BufferGeometry => {
  const positions = [
    [min.x, min.y, min.z],
    [max.x, min.y, min.z],
    [max.x, max.y, min.z],
    [min.x, max.y, min.z],
    [min.x, min.y, max.z],
    [max.x, min.y, max.z],
    [max.x, max.y, max.z],
    [min.x, max.y, max.z],
  ].flat();
  const indices = [
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 4, 0,
    3, 4, 3, 7,
  ];
  const uv = Array.from({ length: positions.length / 3 }, (_, i) => [i % 2, (i >> 1) % 2]).flat();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  return geometry;
};

const furnitureCallbacks = () => {
  const callbacks: ((gltf: GLTF) => void)[] = [];
  vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((_url, onLoad) => {
    if (onLoad) callbacks.push(onLoad);
    return {} as GLTFLoader;
  });
  return callbacks;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('imported furniture finishes', () => {
  it('keeps the bed duvet soft while every frame component stays ivory', () => {
    const callbacks = furnitureCallbacks();
    const assets = new SceneryAssets();
    const geometry = new THREE.BufferGeometry();
    const duvet = box(new THREE.Vector3(-0.75, 0.1, -0.9), new THREE.Vector3(0.75, 0.6, 0.9));
    const frame = box(new THREE.Vector3(-0.7, 0, -0.9), new THREE.Vector3(0.7, 0.08, 0.9));
    for (const name of ['position', 'uv'] as const) {
      const first = duvet.getAttribute(name);
      const second = frame.getAttribute(name);
      if (!(first && second)) throw new Error(`missing ${name}`);
      geometry.setAttribute(
        name,
        new THREE.BufferAttribute(
          new Float32Array([...first.array, ...second.array]),
          first.itemSize,
        ),
      );
    }
    const firstIndex = duvet.getIndex();
    const secondIndex = frame.getIndex();
    if (!(firstIndex && secondIndex)) throw new Error('missing index');
    geometry.setIndex([
      ...Array.from(firstIndex.array),
      ...Array.from(secondIndex.array, (index) => Number(index) + 8),
    ]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    mesh.name = 'GothicBed_01';
    const scene = new THREE.Group();
    scene.add(mesh);
    callbacks[0]?.({ scene } as GLTF);

    expect(Array.isArray(mesh.material)).toBe(true);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    expect(materials[0]).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(materials[1]).toMatchObject({ name: 'bed-frame-ivory-paint' });
    expect(mesh.geometry.getAttribute('position').count).toBe(16);
    expect(mesh.geometry.getAttribute('uv').count).toBe(16);
    expect(mesh.geometry.groups.some((group) => group.materialIndex === 0)).toBe(true);
    expect(mesh.geometry.groups.some((group) => group.materialIndex === 1)).toBe(true);
    assets.dispose();
  });

  it('uses the split sofa names so wood trim never receives the linen map', () => {
    const callbacks = furnitureCallbacks();
    const assets = new SceneryAssets();
    const scene = new THREE.Group();
    const upholstery = new THREE.Mesh(
      box(new THREE.Vector3(-0.8, 0.2, -0.3), new THREE.Vector3(0.8, 0.8, 0.3)),
      new THREE.MeshStandardMaterial(),
    );
    upholstery.name = 'Sofa_01_upholstery';
    const frame = new THREE.Mesh(
      box(new THREE.Vector3(-0.8, 0, -0.3), new THREE.Vector3(0.8, 0.2, 0.3)),
      new THREE.MeshStandardMaterial(),
    );
    frame.name = 'Sofa_01_frame';
    scene.add(upholstery, frame);
    callbacks[2]?.({ scene } as GLTF);

    expect(upholstery.material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(frame.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(frame.material).not.toBe(upholstery.material);
    expect((upholstery.material as THREE.MeshPhysicalMaterial).normalScale.x).toBeCloseTo(0.12);
    expect((frame.material as THREE.MeshStandardMaterial).normalScale.x).toBeCloseTo(0.08);
    assets.dispose();
  });

  it('releases owned PBR maps once while borrowing the environment map', () => {
    vi.stubGlobal('document', {});
    const loaded: THREE.Texture<HTMLImageElement>[] = [];
    vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => {
      const texture = new THREE.Texture<HTMLImageElement>();
      loaded.push(texture);
      return texture;
    });
    const environment = new THREE.Texture<HTMLImageElement>();
    const environmentDispose = vi.spyOn(environment, 'dispose');
    const callbacks = furnitureCallbacks();
    const assets = new SceneryAssets(() => environment);
    const scene = new THREE.Group();
    const duvet = new THREE.Mesh(
      box(new THREE.Vector3(-0.75, 0.1, -0.9), new THREE.Vector3(0.75, 0.6, 0.9)),
      new THREE.MeshStandardMaterial(),
    );
    duvet.name = 'GothicBed_01';
    scene.add(duvet);
    callbacks[0]?.({ scene } as GLTF);

    expect(loaded).toHaveLength(3);
    const mapDisposals = loaded.map((texture) => vi.spyOn(texture, 'dispose'));
    assets.dispose();

    expect(mapDisposals.every((spy) => spy.mock.calls.length === 1)).toBe(true);
    expect(environmentDispose).not.toHaveBeenCalled();
  });
});
