import * as THREE from 'three';

/** The material fields the shadow pass reads from the visible source slot. */
type ShadowSourceMaterial = THREE.Material & {
  map?: THREE.Texture | null;
  alphaMap?: THREE.Texture | null;
};

type ShadowMaterial = THREE.MeshDepthMaterial | THREE.MeshDistanceMaterial;
type ShadowHook = THREE.Object3D['onBeforeShadow'];
type ShadowGroup = { materialIndex?: number } | null;

export interface ShadowMaterialSet {
  dispose(): void;
}

const materialAt = (mesh: THREE.Mesh, group: ShadowGroup): ShadowSourceMaterial | null => {
  if (!Array.isArray(mesh.material)) return mesh.material as ShadowSourceMaterial;
  const index = group?.materialIndex;
  if (index === undefined) return null;
  return (mesh.material[index] as ShadowSourceMaterial | undefined) ?? null;
};

const hasFractionalBlend = (material: ShadowSourceMaterial | null, matches: RegExp): boolean => {
  if (!material) return false;
  matches.lastIndex = 0;
  return (
    matches.test(material.name || '') &&
    material.transparent === true &&
    material.alphaTest === 0 &&
    material.opacity < 1
  );
};

/** Three draws an alpha-to-coverage cutout's shadow at a fixed 0.5; its own threshold is tuned. */
const isCutout = (material: ShadowSourceMaterial | null): boolean =>
  material?.alphaToCoverage === true && material.alphaTest > 0;

const sourceKey = (material: ShadowSourceMaterial | null): string => {
  if (!material) return 'none';
  const map = material.map?.uuid ?? 'none';
  const alphaMap = material.alphaMap?.uuid ?? 'none';
  return `${material.uuid}:${map}:${alphaMap}:${material.map?.channel ?? 0}:${material.alphaMap?.channel ?? 0}`;
};

/**
 * Install alpha-aware shadow materials on meshes that have a fractional blend
 * slot. Three's stock shadow materials discard by alphaTest but treat a blend
 * material as fully opaque, which leaves an invisible sleeve casting a solid
 * shadow. The custom pair keeps the stock depth/distance vertex shaders (and
 * therefore skinning and morph targets) while multiplying the source opacity
 * before alphaTest/alphaHash in the fragment shader.
 */
export function installTransparentShadowMaterials(
  root: THREE.Object3D,
  blendTransparent: RegExp,
): ShadowMaterialSet {
  const owned = new Map<
    THREE.Mesh,
    {
      depth: THREE.MeshDepthMaterial;
      distance: THREE.MeshDistanceMaterial;
      priorHook: ShadowHook;
      hadOwnHook: boolean;
      priorDepth: THREE.Material | undefined;
      priorDistance: THREE.Material | undefined;
      hadOwnDepth: boolean;
      hadOwnDistance: boolean;
    }
  >();

  const installCompileHook = (
    material: ShadowMaterial,
    opacity: { value: number },
    activeKey: { value: string },
  ): void => {
    const priorCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      priorCompile(shader, renderer);
      shader.uniforms.shadowOpacity = opacity;
      const marker = '#include <alphatest_fragment>';
      if (!shader.fragmentShader.includes(marker)) {
        throw new Error(`Shadow material ${material.type} lost its alpha test include`);
      }
      if (!shader.fragmentShader.includes('uniform float shadowOpacity;')) {
        shader.fragmentShader = `uniform float shadowOpacity;\n${shader.fragmentShader}`;
      }
      shader.fragmentShader = shader.fragmentShader.replace(
        marker,
        `diffuseColor.a *= shadowOpacity;\n\t${marker}`,
      );
    };
    // The source slot is selected in onBeforeShadow. A distinct key forces
    // WebGLRenderer to bind the matching uniform set when groups share one
    // custom shadow material but carry different maps or opacities.
    material.customProgramCacheKey = () => `hashidate-shadow:${activeKey.value}`;
  };

  // What each target was last compiled for. Only a change here needs a new
  // program; the opacity uniform is read live.
  const applied = new WeakMap<ShadowMaterial, { hash: boolean; key: string }>();

  const sync = (
    target: ShadowMaterial,
    source: ShadowSourceMaterial | null,
    opacity: { value: number },
    activeKey: { value: string },
  ): void => {
    // Three has already copied the current slot's masks, culling, clipping and
    // displacement. Only blend coverage is missing from its shadow material.
    const fractional = hasFractionalBlend(source, blendTransparent);
    const key = sourceKey(source);
    target.alphaHash = fractional;
    opacity.value = fractional ? (source?.opacity ?? 1) : 1;
    activeKey.value = key;
    const last = applied.get(target);
    if (last?.hash === fractional && last.key === key) return;
    applied.set(target, { hash: fractional, key });
    target.needsUpdate = true;
  };

  const thresholds = new Map<THREE.Mesh, { priorHook: ShadowHook; hadOwnHook: boolean }>();

  // For a mesh with no fractional blend: only the cutout's own threshold is put back.
  const holdThreshold = (object: THREE.Mesh): void => {
    const priorHook = object.onBeforeShadow;
    thresholds.set(object, { priorHook, hadOwnHook: Object.hasOwn(object, 'onBeforeShadow') });
    object.onBeforeShadow = (r, current, camera, shadowCamera, geometry, depth, group) => {
      const source = materialAt(object, group as ShadowGroup);
      if (source && isCutout(source)) depth.alphaTest = source.alphaTest;
      priorHook.call(current, r, current, camera, shadowCamera, geometry, depth, group);
    };
  };

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const sources = Array.isArray(object.material) ? object.material : [object.material];
    if (
      !sources.some((material) =>
        hasFractionalBlend(material as ShadowSourceMaterial, blendTransparent),
      )
    ) {
      if (sources.some((material) => isCutout(material as ShadowSourceMaterial))) {
        holdThreshold(object);
      }
      return;
    }

    const hadOwnHook = Object.hasOwn(object, 'onBeforeShadow');
    const hadOwnDepth = Object.hasOwn(object, 'customDepthMaterial');
    const hadOwnDistance = Object.hasOwn(object, 'customDistanceMaterial');
    const priorHook = object.onBeforeShadow;
    const priorDepth = object.customDepthMaterial;
    const priorDistance = object.customDistanceMaterial;
    // A custom shadow material may carry vertex/displacement logic owned by a
    // loader or another pass. Leave that complete contract untouched rather
    // than composing two callbacks over an unknown shader.
    if (priorDepth !== undefined || priorDistance !== undefined) return;

    const activeKey = { value: 'none' };
    const depthOpacity = { value: 1 };
    const distanceOpacity = { value: 1 };
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    const distance = new THREE.MeshDistanceMaterial();
    installCompileHook(depth, depthOpacity, activeKey);
    installCompileHook(distance, distanceOpacity, activeKey);

    const record = {
      depth,
      distance,
      priorHook,
      hadOwnHook,
      priorDepth,
      priorDistance,
      hadOwnDepth,
      hadOwnDistance,
    };
    owned.set(object, record);
    object.customDepthMaterial = depth;
    object.customDistanceMaterial = distance;
    object.onBeforeShadow = (
      renderer,
      currentObject,
      camera,
      shadowCamera,
      geometry,
      depthMaterial,
      group,
    ) => {
      const source = materialAt(object, group as ShadowGroup);
      const target = depthMaterial as ShadowMaterial;
      const opacity = target instanceof THREE.MeshDistanceMaterial ? distanceOpacity : depthOpacity;
      sync(target, source, opacity, activeKey);
      if (source && isCutout(source)) target.alphaTest = source.alphaTest;
      priorHook.call(
        currentObject,
        renderer,
        currentObject,
        camera,
        shadowCamera,
        geometry,
        depthMaterial,
        group,
      );
    };
  });

  return {
    dispose(): void {
      for (const [mesh, record] of owned) {
        if (record.hadOwnHook) mesh.onBeforeShadow = record.priorHook;
        else delete (mesh as unknown as { onBeforeShadow?: ShadowHook }).onBeforeShadow;
        if (record.hadOwnDepth) mesh.customDepthMaterial = record.priorDepth;
        else delete mesh.customDepthMaterial;
        if (record.hadOwnDistance) mesh.customDistanceMaterial = record.priorDistance;
        else delete mesh.customDistanceMaterial;
        record.depth.dispose();
        record.distance.dispose();
      }
      owned.clear();
      for (const [mesh, record] of thresholds) {
        if (record.hadOwnHook) mesh.onBeforeShadow = record.priorHook;
        else delete (mesh as unknown as { onBeforeShadow?: ShadowHook }).onBeforeShadow;
      }
      thresholds.clear();
    },
  };
}
