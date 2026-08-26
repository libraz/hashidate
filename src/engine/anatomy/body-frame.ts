import * as THREE from 'three';
import type { BodyFrame, BoneSlot } from '../types';

/**
 * Body frame, in chest-local coordinates.
 *
 * Every anatomical angle is measured against the torso, not against the world:
 * an arm raised to the side is raised to the side whether the character is
 * standing straight or leaning, and a limit that drifts when the chest turns is
 * not a limit. Derived from geometry for the same reason the face frame is —
 * the chest bone's own axes are whatever the exporter wrote.
 */
export function buildBodyFrame(
  root: THREE.Object3D,
  bones: Partial<Record<BoneSlot, THREE.Bone>>,
): BodyFrame | null {
  const chest = bones.chest ?? bones.spine ?? bones.hips;
  const sL = bones['shoulder.L'] ?? bones['upperArm.L'];
  const sR = bones['shoulder.R'] ?? bones['upperArm.R'];
  const above = bones.neck ?? bones.head;
  if (!(chest && sL && sR && above)) return null;
  root.updateMatrixWorld(true);

  const inv = new THREE.Matrix4().copy(chest.matrixWorld).invert();
  const at = (b: THREE.Bone) => b.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);

  // Up first: the chest points at the neck, and that is true on any humanoid
  // however the joint is oriented.
  const up = at(above);
  if (up.lengthSq() < 1e-10) return null;
  up.normalize();

  // The character's own right, from its own shoulders. No world axis enters,
  // so an avatar authored facing away is handled without a special case.
  const right = at(sR).sub(at(sL));
  right.addScaledVector(up, -right.dot(up));
  if (right.lengthSq() < 1e-10) return null;
  right.normalize();

  // Fixed by handedness, not measured — see the note on the face frame for
  // what happens when this is settled geometrically instead.
  const forward = new THREE.Vector3().crossVectors(up, right).normalize();
  return { right, up, forward };
}
