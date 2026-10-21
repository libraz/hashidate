import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackdropStage } from '@/viewer/scene/backdrop';
import { SceneryAssets } from '@/viewer/scene/backdrop/assets';
import { PATTERNS } from '@/viewer/scene/backdrop/patterns';
import { StudioEnvironment } from '@/viewer/scene/environment';

const furnitureCallbacks = () => {
  const callbacks: ((gltf: GLTF) => void)[] = [];
  vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((_url, onLoad) => {
    if (onLoad) callbacks.push(onLoad);
    return {} as GLTFLoader;
  });
  return callbacks;
};

/** A one-box glTF scene whose material furniture keeps and gives the borrowed map. */
const piece = (): { scene: THREE.Group; material: () => THREE.MeshStandardMaterial } => {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  scene.add(mesh);
  return { scene, material: () => mesh.material as THREE.MeshStandardMaterial };
};

/** A backdrop over a fixed borrowed map, standing in for the runtime's PMREM. */
const mountable = (texture: () => THREE.Texture) => {
  const scene = new THREE.Scene();
  const renderer = {
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    shadowMap: { enabled: false, type: THREE.BasicShadowMap },
  } as unknown as THREE.WebGLRenderer;
  const environment = {
    get texture() {
      return texture();
    },
  } as StudioEnvironment;
  return { scene, stage: new BackdropStage(scene, renderer, [new THREE.Group()], environment) };
};

const roomMaterials = (root: THREE.Object3D, map: THREE.Texture): THREE.MeshStandardMaterial[] => {
  const found: THREE.MeshStandardMaterial[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(object.material) ? object.material : [object.material]) {
      if (m instanceof THREE.MeshStandardMaterial && m.envMap === map) found.push(m);
    }
  });
  return found;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shared furniture loading', () => {
  it('fetches nothing until a room first shows it, and only once', () => {
    const callbacks = furnitureCallbacks();
    let providerCalls = 0;
    const assets = new SceneryAssets(() => {
      providerCalls += 1;
      return null;
    });

    expect(callbacks).toHaveLength(0);
    expect(providerCalls).toBe(0);

    const scene = new THREE.Scene();
    assets.attach(scene);
    assets.detach(scene);
    assets.attach(scene);
    expect(callbacks).toHaveLength(15);
    expect(assets.root.parent).toBe(scene);
    assets.dispose();
  });

  it('never starts loading once disposed', () => {
    const callbacks = furnitureCallbacks();
    const assets = new SceneryAssets();
    assets.dispose();
    const scene = new THREE.Scene();
    assets.attach(scene);

    expect(callbacks).toHaveLength(0);
    expect(scene.children).toHaveLength(0);
  });

  it('does not build the reflection map for a stage that never mounts a room', () => {
    furnitureCallbacks();
    const provider = vi.fn(() => new THREE.Texture());
    const { stage } = mountable(provider);

    expect(provider).not.toHaveBeenCalled();
    stage.dispose();
  });
});

describe('furniture reflection strength', () => {
  it('follows the mounted room, including furniture that lands afterwards', () => {
    const callbacks = furnitureCallbacks();
    const map = new THREE.Texture();
    const { stage } = mountable(() => map);
    const [dim, bright] = [...PATTERNS].sort(
      (a, b) => a.build([]).environmentIntensity - b.build([]).environmentIntensity,
    );
    if (!(dim && bright)) throw new Error('expected two patterns');
    const dimIntensity = dim.build([]).environmentIntensity;
    const brightIntensity = bright.build([]).environmentIntensity;
    expect(dimIntensity).not.toBe(brightIntensity);

    stage.setBackdrop(bright.id);
    const early = piece();
    callbacks[6]?.({ scene: early.scene } as GLTF);
    expect(early.material().envMap).toBe(map);
    expect(early.material().envMapIntensity).toBeCloseTo(0.7 * brightIntensity);

    stage.setBackdrop(dim.id);
    expect(early.material().envMapIntensity).toBeCloseTo(0.7 * dimIntensity);

    const late = piece();
    callbacks[7]?.({ scene: late.scene } as GLTF);
    expect(late.material().envMapIntensity).toBeCloseTo(0.7 * dimIntensity);
    stage.dispose();
  });
});

describe('reflection map after a lost context', () => {
  it('forgets the map without disposing it and builds a fresh one next', () => {
    vi.stubGlobal('document', {});
    const first = new THREE.WebGLRenderTarget(16, 8);
    const second = new THREE.WebGLRenderTarget(16, 8);
    vi.spyOn(THREE.PMREMGenerator.prototype, 'fromScene')
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const firstDispose = vi.spyOn(first, 'dispose');
    const environment = new StudioEnvironment({} as THREE.WebGLRenderer);

    expect(environment.invalidate()).toBeNull();
    expect(environment.texture).toBe(first.texture);
    expect(environment.invalidate()).toBe(first.texture);
    expect(firstDispose).not.toHaveBeenCalled();
    expect(environment.texture).toBe(second.texture);
    environment.dispose();
  });

  it('moves the room, its furniture and the scene onto the rebuilt map', () => {
    const callbacks = furnitureCallbacks();
    const lost = new THREE.Texture();
    const rebuilt = new THREE.Texture();
    let current = lost;
    const { scene, stage } = mountable(() => current);
    const room = PATTERNS[0];
    if (!room) throw new Error('expected a pattern');

    stage.setBackdrop(room.id);
    const loaded = piece();
    callbacks[6]?.({ scene: loaded.scene } as GLTF);
    expect(roomMaterials(scene, lost).length).toBeGreaterThan(1);

    // A suspended room is out of the scene and still has to come back working.
    stage.suspend();
    current = rebuilt;
    stage.rebindEnvironment(lost, rebuilt);
    stage.resume();

    expect(roomMaterials(scene, lost)).toHaveLength(0);
    expect(loaded.material().envMap).toBe(rebuilt);
    expect(scene.environment).toBe(rebuilt);
    stage.dispose();
  });
});
