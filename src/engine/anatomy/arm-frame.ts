import type * as THREE from 'three';

/**
 * Zero-rotation reference for the humerus: the direction the elbow points
 * when the arm is neutral, which is forward on a hanging arm.
 *
 * In front of the shoulder it is where the shoulder carries that forward
 * elbow on swinging straight to `u`: up at a horizontal flexion, back over
 * the shoulder above it. Projecting forward onto the arm's normal plane
 * instead flips half a turn as the arm passes straight forward, and every
 * hand brought to the face read as rotated past its stop and was whipped
 * sideways on the way in. Behind the shoulder it is still that projection,
 * which matches how an elbow is taken back and has its own flip only straight
 * behind, past the elevation ceiling. The two agree on the frontal plane, and
 * the one singular direction left is straight up.
 *
 * Rotation about a swinging axis is path-dependent in general, so this is a
 * reference rather than a measurement of how the arm got there.
 */
export function humeralReference(
  u: THREE.Vector3,
  up: THREE.Vector3,
  forward: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  const ahead = u.dot(forward);
  const lift = 1 - u.dot(up);
  out.copy(forward);
  if (ahead > 0 && lift > 1e-6) {
    out.addScaledVector(u, -ahead / lift).addScaledVector(up, ahead / lift);
  }
  out.addScaledVector(u, -out.dot(u));
  if (out.lengthSq() < 1e-8) out.copy(up);
  return out.normalize();
}

/**
 * Orthonormal partner to `ref` in the plane normal to `u`, toward outside.
 *
 * Handed rather than projected off the lateral axis, which lies in that plane
 * once the arm is out at the side and flips the sign of every rotation above it.
 */
export function lateralReference(
  u: THREE.Vector3,
  ref: THREE.Vector3,
  up: THREE.Vector3,
  forward: THREE.Vector3,
  lateral: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  out.crossVectors(ref, u);
  const handedness =
    up.x * (forward.y * lateral.z - forward.z * lateral.y) +
    up.y * (forward.z * lateral.x - forward.x * lateral.z) +
    up.z * (forward.x * lateral.y - forward.y * lateral.x);
  if (handedness < 0) out.negate();
  return out.normalize();
}
