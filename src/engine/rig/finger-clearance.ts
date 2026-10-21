/**
 * Hand frames and finger clearance.
 *
 * `handFrame` builds the orthonormal frame a hand's pointing direction and palm
 * normal make.
 */

import * as THREE from 'three';

const _hfY = new THREE.Vector3();
const _hfZ = new THREE.Vector3();
/**
 * The frame a hand's pointing direction and palm normal make, as columns:
 * pointing, palm, and their cross. Null when the two are parallel. Normalises
 * `point` in place.
 */
export function handFrame(
  point: THREE.Vector3,
  palm: THREE.Vector3,
  out: THREE.Matrix3,
): THREE.Matrix3 | null {
  const x = point.lengthSq() > 1e-12 ? point.normalize() : null;
  if (!x) return null;
  const y = _hfY.copy(palm).addScaledVector(x, -palm.dot(x));
  if (y.lengthSq() < 1e-8) return null;
  y.normalize();
  const z = _hfZ.crossVectors(x, y);
  return out.set(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z);
}
