import * as THREE from 'three';
import { pbrMaps, type TextureBin } from './textures';

interface SurfaceSpan {
  width: number;
  height: number;
}

/** Fabric036 has no published physical size; this weave scale is tuned in the room. */
export function linenMaterial(
  bin: TextureBin,
  color: number,
  span: SurfaceSpan,
): THREE.MeshPhysicalMaterial {
  const maps = pbrMaps(
    bin,
    {
      color: '/textures/fabric-linen-base.jpg',
      normal: '/textures/fabric-linen-normal.jpg',
      roughness: '/textures/fabric-linen-roughness.jpg',
    },
    span.width / 0.25,
    span.height / 0.25,
  );
  return new THREE.MeshPhysicalMaterial({
    color,
    map: maps.color,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(0.12, 0.12),
    roughnessMap: maps.roughness,
    roughness: 0.95,
    sheen: 0.35,
    sheenColor: new THREE.Color(color),
    sheenRoughness: 0.85,
  });
}

/** Pale Wood095 grain, sized independently from the cloth's finer weave. */
export function timberMaterial(bin: TextureBin, span: SurfaceSpan): THREE.MeshStandardMaterial {
  const maps = pbrMaps(
    bin,
    {
      color: '/textures/wood-shelf-base.jpg',
      normal: '/textures/wood-shelf-normal.jpg',
      roughness: '/textures/wood-shelf-roughness.jpg',
    },
    span.width / 0.7,
    span.height / 0.35,
  );
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: maps.color,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(0.08, 0.08),
    roughnessMap: maps.roughness,
    roughness: 0.9,
  });
}
