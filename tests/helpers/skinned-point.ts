import * as THREE from 'three';
import type { SkinPointAnchorSpec } from '@/engine/types';

/**
 * Where a skin point is, recomputed from its producer bones alone: the
 * weighted sum of each influence's bone-local position through that bone's
 * world matrix, after a fresh world update from `root`.
 *
 * Independent of `SkinPointAnchor`, which walks cached local paths of its own,
 * so an anchor that placed itself from a stale producer pose disagrees with it.
 */
export function skinnedPoint(
  root: THREE.Object3D,
  influences: SkinPointAnchorSpec['influences'],
  bone: (name: string) => THREE.Object3D | undefined,
): THREE.Vector3 {
  root.updateMatrixWorld(true);
  const out = new THREE.Vector3();
  const point = new THREE.Vector3();
  for (const influence of influences) {
    const source = bone(influence.bone);
    if (!source) throw new Error(`skin point names a missing bone: ${influence.bone}`);
    out.addScaledVector(
      point.fromArray(influence.position).applyMatrix4(source.matrixWorld),
      influence.weight,
    );
  }
  return out;
}
