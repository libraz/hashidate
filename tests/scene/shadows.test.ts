import * as THREE from 'three';
import { WebGLShadowMap } from 'three/src/renderers/webgl/WebGLShadowMap.js';
import { describe, expect, it, vi } from 'vitest';
import { setupMaterials } from '@/engine/scene/materials';
import type { AvatarDescriptor, MaterialRules } from '@/engine/types';

const avatar = (materials?: MaterialRules): AvatarDescriptor => ({
  id: 'shadow-test',
  label: { en: 'Shadow test', ja: '影テスト' },
  url: '/shadow-test.glb',
  ...(materials ? { materials } : {}),
});

interface ShadowDraw {
  depthMaterial: THREE.Material;
  group: THREE.Group | null;
  alphaTest: number;
  alphaHash: boolean;
  map: THREE.Texture | null;
  alphaMap: THREE.Texture | null;
  fragmentShader: string;
  programKey: string;
  uniformValues: Record<string, unknown>;
}

function renderShadow(
  root: THREE.Object3D,
  light: THREE.DirectionalLight | THREE.SpotLight | THREE.PointLight,
): ShadowDraw[] {
  const draws: ShadowDraw[] = [];
  const renderer = {
    state: {
      buffers: {
        depth: { getReversed: () => false, setTest() {} },
        color: { setClear() {} },
      },
      setBlending() {},
      setScissorTest() {},
      viewport() {},
    },
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget() {},
    clear() {},
    properties: { get: () => ({}) },
    renderBufferDirect(
      _camera: THREE.Camera,
      _scene: THREE.Scene | null,
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      object: THREE.Object3D,
      group: THREE.Group | null,
    ) {
      const shader = {
        uniforms: {},
        vertexShader:
          material instanceof THREE.MeshDistanceMaterial
            ? THREE.ShaderLib.distance.vertexShader
            : THREE.ShaderLib.depth.vertexShader,
        fragmentShader:
          material instanceof THREE.MeshDistanceMaterial
            ? THREE.ShaderLib.distance.fragmentShader
            : THREE.ShaderLib.depth.fragmentShader,
      };
      material.onBeforeCompile(shader as never, renderer as never);
      draws.push({
        depthMaterial: material,
        group,
        alphaTest: material.alphaTest,
        alphaHash: material.alphaHash,
        map: 'map' in material ? (material.map as THREE.Texture | null) : null,
        alphaMap: 'alphaMap' in material ? (material.alphaMap as THREE.Texture | null) : null,
        fragmentShader: shader.fragmentShader,
        programKey: material.customProgramCacheKey(),
        uniformValues: Object.fromEntries(
          Object.entries(shader.uniforms).map(([name, uniform]) => [
            name,
            (uniform as { value: unknown }).value,
          ]),
        ),
      });
      void geometry;
      void object;
    },
  };
  const scene = new THREE.Scene();
  scene.add(root, light);
  if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
    scene.add(light.target);
  }
  light.position.set(1, 2, 3);
  scene.updateMatrixWorld(true);
  const shadows = new WebGLShadowMap(
    renderer as never,
    { update: (object: THREE.Object3D) => (object as THREE.Mesh).geometry } as never,
    { maxTextureSize: 4096 } as never,
  );
  shadows.enabled = true;
  shadows.render([light], scene, new THREE.PerspectiveCamera());
  light.shadow.dispose();
  return draws;
}

function shadowMesh(material: THREE.Material | THREE.Material[]): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

describe('fractional material shadows', () => {
  it('uses alpha-hashed depth for a zero-opacity blend slot', () => {
    const source = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0 });
    source.name = 'Cloth';
    const object = shadowMesh(source);
    const root = new THREE.Group().add(object);
    const materials = setupMaterials(root, avatar({ blendTransparent: /^Cloth$/ }));

    expect(object.customDepthMaterial).toBeInstanceOf(THREE.MeshDepthMaterial);
    expect((object.customDepthMaterial as THREE.MeshDepthMaterial).depthPacking).toBe(
      THREE.RGBADepthPacking,
    );
    materials.apply(true);
    for (const light of [new THREE.DirectionalLight(), new THREE.SpotLight()]) {
      const draw = renderShadow(root, light)[0];
      expect(draw.alphaHash).toBe(true);
      expect(draw.alphaTest).toBe(0);
      expect(draw.uniformValues.shadowOpacity).toBe(0);
      expect(draw.fragmentShader).toContain('uniform float shadowOpacity;');
    }
    materials.dispose();
  });

  it('selects the current material for every mixed geometry group', () => {
    const map = new THREE.Texture();
    const alphaMap = new THREE.Texture();
    const blend = new THREE.MeshStandardMaterial({
      map,
      alphaMap,
      transparent: true,
      opacity: 0.25,
    });
    blend.name = 'Cloth';
    const blendSecondMap = new THREE.Texture();
    const blendSecondAlphaMap = new THREE.Texture();
    const blendSecond = new THREE.MeshStandardMaterial({
      map: blendSecondMap,
      alphaMap: blendSecondAlphaMap,
      transparent: true,
      opacity: 0.8,
    });
    blendSecond.name = 'ClothSecond';
    const opaque = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    opaque.name = 'Body';
    const cutout = new THREE.MeshStandardMaterial({
      map: new THREE.Texture(),
      transparent: true,
      alphaTest: 0.25,
    });
    cutout.name = 'Mask';
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, 1, 0], 3),
    );
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(0, 3, 1);
    geometry.addGroup(0, 3, 2);
    geometry.addGroup(0, 3, 3);
    const object = new THREE.Mesh(geometry, [blend, blendSecond, opaque, cutout]);
    object.castShadow = true;
    object.frustumCulled = false;
    const root = new THREE.Group().add(object);
    const materials = setupMaterials(root, avatar({ blendTransparent: /^Cloth(?:Second)?$/ }));
    materials.apply(true);

    const draws = renderShadow(root, new THREE.DirectionalLight());
    expect(draws).toHaveLength(4);
    expect(draws.map((draw) => draw.alphaHash)).toEqual([true, true, false, false]);
    expect(draws.map((draw) => draw.alphaTest)).toEqual([0, 0, 0, 0.25]);
    expect(draws.map((draw) => draw.uniformValues.shadowOpacity)).toEqual([0.25, 0.8, 1, 1]);
    expect(draws[0].map).toBe(map);
    expect(draws[0].alphaMap).toBe(alphaMap);
    expect(draws[1].map).toBe(blendSecondMap);
    expect(draws[1].alphaMap).toBe(blendSecondAlphaMap);
    expect(draws[0].programKey).not.toBe(draws[1].programKey);
    expect(draws[0].depthMaterial).toBe(draws[1].depthMaterial);

    materials.apply(false);
    const importedDraws = renderShadow(root, new THREE.DirectionalLight());
    expect(importedDraws.map((draw) => draw.uniformValues.shadowOpacity)).toEqual([
      0.25, 0.8, 1, 1,
    ]);
    materials.apply(true);

    const pointDraws = renderShadow(root, new THREE.PointLight());
    expect(pointDraws[0].programKey).not.toBe(pointDraws[1].programKey);
    expect(pointDraws.slice(0, 2).map((draw) => draw.uniformValues.shadowOpacity)).toEqual([
      0.25, 0.8,
    ]);
    materials.dispose();
  });

  it('uses the distance variant for point-light shadows and restores hooks on dispose', () => {
    const source = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.8 });
    source.name = 'Cloth';
    const object = shadowMesh(source);
    const priorHook = vi.fn();
    object.onBeforeShadow = priorHook;
    const root = new THREE.Group().add(object);
    const materials = setupMaterials(root, avatar({ blendTransparent: /^Cloth$/ }));
    const depth = object.customDepthMaterial as THREE.MeshDepthMaterial;
    const distance = object.customDistanceMaterial as THREE.MeshDistanceMaterial;
    const depthDispose = vi.spyOn(depth, 'dispose');
    const distanceDispose = vi.spyOn(distance, 'dispose');

    const draws = renderShadow(root, new THREE.PointLight());
    expect(draws[0].depthMaterial).toBe(distance);
    expect(draws[0].uniformValues.shadowOpacity).toBe(0.8);
    expect(priorHook).toHaveBeenCalledTimes(6);

    materials.dispose();
    expect(depthDispose).toHaveBeenCalledOnce();
    expect(distanceDispose).toHaveBeenCalledOnce();
    expect(object.customDepthMaterial).toBeUndefined();
    expect(object.customDistanceMaterial).toBeUndefined();
    expect(object.onBeforeShadow).toBe(priorHook);
  });

  it('does not replace a mesh that already owns custom shadow materials', () => {
    const source = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 });
    source.name = 'Cloth';
    const customDepth = new THREE.MeshDepthMaterial();
    const customDistance = new THREE.MeshDistanceMaterial();
    const customDepthDispose = vi.spyOn(customDepth, 'dispose');
    const customDistanceDispose = vi.spyOn(customDistance, 'dispose');
    const object = shadowMesh(source);
    object.customDepthMaterial = customDepth;
    object.customDistanceMaterial = customDistance;
    const priorHook = vi.fn();
    object.onBeforeShadow = priorHook;
    const materials = setupMaterials(
      new THREE.Group().add(object),
      avatar({ blendTransparent: /^Cloth$/ }),
    );

    expect(object.customDepthMaterial).toBe(customDepth);
    expect(object.customDistanceMaterial).toBe(customDistance);
    expect(object.onBeforeShadow).toBe(priorHook);
    materials.dispose();
    expect(customDepthDispose).not.toHaveBeenCalled();
    expect(customDistanceDispose).not.toHaveBeenCalled();
  });

  it('does not draw a hidden fractional mesh into a shadow map', () => {
    const source = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 });
    source.name = 'Cloth';
    const object = shadowMesh(source);
    object.visible = false;
    const root = new THREE.Group().add(object);
    const materials = setupMaterials(root, avatar({ blendTransparent: /^Cloth$/ }));

    expect(renderShadow(root, new THREE.DirectionalLight())).toHaveLength(0);
    materials.dispose();
  });
});
