import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackdropStage } from '@/viewer/scene/backdrop';
import { SceneryAssets } from '@/viewer/scene/backdrop/assets';
import { PATTERNS } from '@/viewer/scene/backdrop/patterns';
import type { StudioEnvironment } from '@/viewer/scene/environment';

const materialsIn = (root: THREE.Object3D): THREE.Material[] => {
  const materials: THREE.Material[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    materials.push(...(Array.isArray(object.material) ? object.material : [object.material]));
  });
  return materials;
};

const standardMaterialsIn = (root: THREE.Object3D): THREE.MeshStandardMaterial[] =>
  materialsIn(root).filter(
    (material): material is THREE.MeshStandardMaterial =>
      material instanceof THREE.MeshStandardMaterial,
  );

const meshMaterial = (mesh: THREE.Mesh): THREE.MeshStandardMaterial => {
  if (Array.isArray(mesh.material)) throw new Error('expected one material');
  if (!(mesh.material instanceof THREE.MeshStandardMaterial)) {
    throw new Error('expected a standard material');
  }
  return mesh.material;
};

const mountable = (environment: THREE.Texture) => {
  const scene = new THREE.Scene();
  const renderer = {
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    shadowMap: { enabled: false, type: THREE.BasicShadowMap },
  } as unknown as THREE.WebGLRenderer;
  const lights = new THREE.Group();
  const runtimeEnvironment = {
    get texture() {
      return environment;
    },
  } as StudioEnvironment;
  return { scene, stage: new BackdropStage(scene, renderer, [lights], runtimeEnvironment) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('backdrop reflection maps', () => {
  it('gives every room its borrowed map while preserving pane strengths', () => {
    const environment = new THREE.Texture();

    for (const pattern of PATTERNS) {
      const built = pattern.build([], environment);
      const reflective = standardMaterialsIn(built.root).filter(
        (material) => material.envMapIntensity > 2,
      );

      expect(reflective, pattern.id).toHaveLength(1);
      expect(
        reflective.every((material) => material.envMap === environment),
        pattern.id,
      ).toBe(true);
      expect(
        reflective.map((material) => material.envMapIntensity).sort((a, b) => a - b),
        pattern.id,
      ).toEqual([2.2]);

      built.root.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
    }
  });

  it('keeps the optional map absent for callers that build a pattern directly', () => {
    for (const pattern of PATTERNS) {
      const built = pattern.build([]);
      const reflective = standardMaterialsIn(built.root).filter(
        (material) => material.envMapIntensity > 2,
      );

      expect(reflective, pattern.id).toHaveLength(1);
      expect(
        reflective.every((material) => material.envMap === null),
        pattern.id,
      ).toBe(true);
      built.root.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
    }
  });

  it('passes the same borrowed map through the stage to a mounted room', () => {
    vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => ({}) as GLTFLoader);
    const environment = new THREE.Texture();
    const dispose = vi.spyOn(environment, 'dispose');
    const { scene, stage } = mountable(environment);

    stage.setBackdrop('rain');
    const reflective = standardMaterialsIn(scene).filter(
      (material) => material.envMapIntensity > 2,
    );

    expect(reflective).toHaveLength(1);
    expect(reflective.every((material) => material.envMap === environment)).toBe(true);
    stage.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('keeps the borrowed map through switching, suspension and clearing', () => {
    vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => ({}) as GLTFLoader);
    const environment = new THREE.Texture();
    const dispose = vi.spyOn(environment, 'dispose');
    const { scene, stage } = mountable(environment);

    for (const pattern of PATTERNS) {
      stage.setBackdrop(pattern.id);
      const beforeSuspend = standardMaterialsIn(scene).filter(
        (material) => material.envMapIntensity > 2,
      );
      expect(beforeSuspend, pattern.id).toHaveLength(1);
      expect(
        beforeSuspend.every((material) => material.envMap === environment),
        pattern.id,
      ).toBe(true);
      expect(scene.environment).toBe(environment);

      stage.suspend();
      stage.resume();
      const afterResume = standardMaterialsIn(scene).filter(
        (material) => material.envMapIntensity > 2,
      );
      expect(afterResume).toEqual(beforeSuspend);
      expect(afterResume.every((material) => material.envMap === environment)).toBe(true);

      stage.clear();
      expect(scene.environment).toBeNull();
    }

    stage.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });
});

describe('shared furniture reflection maps', () => {
  it('borrows the runtime map for late furniture loads and never disposes it', () => {
    const callbacks: ((gltf: GLTF) => void)[] = [];
    vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((_url, onLoad) => {
      if (onLoad) callbacks.push(onLoad);
      return {} as GLTFLoader;
    });

    const environment = new THREE.Texture();
    const environmentDispose = vi.spyOn(environment, 'dispose');
    let providerCalls = 0;
    const sourceMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const sourceDispose = vi.spyOn(sourceMaterial, 'dispose');
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), sourceMaterial));
    const assets = new SceneryAssets(() => {
      providerCalls += 1;
      return environment;
    });

    expect(callbacks).toHaveLength(15);
    expect(providerCalls).toBe(0);
    callbacks[0]?.({ scene } as GLTF);

    const mesh = scene.children[0];
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    const material = meshMaterial(mesh as THREE.Mesh);
    expect(material.envMap).toBe(environment);
    expect(material.envMapIntensity).toBe(0.7);
    expect(sourceDispose).toHaveBeenCalledOnce();
    expect(providerCalls).toBe(1);

    assets.dispose();

    const lateScene = new THREE.Group();
    lateScene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
    callbacks[1]?.({ scene: lateScene } as GLTF);
    expect(providerCalls).toBe(1);
    expect(environmentDispose).not.toHaveBeenCalled();
  });
});
