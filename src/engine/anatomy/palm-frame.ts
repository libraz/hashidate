import * as THREE from 'three';
import type { Profile, Side } from '../types';

/** Signed rest-pose palm normals in world space, shared by fingers and wrist limits. */
export function restPalmNormals(p: Profile): Partial<Record<Side, THREE.Vector3>> {
  const palm: Partial<Record<Side, THREE.Vector3>> = {};
  const sides: readonly Side[] = ['L', 'R'];
  const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
  for (const side of sides) {
    const hand = p.bones[`hand.${side}`];
    const index = p.fingerBones[`index.${side}`]?.[0];
    const little = p.fingerBones[`little.${side}`]?.[0];
    const middle = p.fingerBones[`middle.${side}`]?.[0];
    if (!(hand && index && little && middle)) continue;
    hand.updateWorldMatrix(true, false);
    const across = wp(little).sub(wp(index)).normalize();
    const along = wp(middle).sub(wp(hand)).normalize();
    palm[side] = new THREE.Vector3().crossVectors(along, across).normalize();
  }

  // The profile frame is chest-local; the measured finger geometry is world-space.
  // Without a body frame, retain the coordinate-axis fallback used by partial rigs.
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3(1, 0, 0);
  const chest = p.bones.chest ?? p.bones.spine ?? p.bones.hips;
  if (p.body && chest) {
    chest.updateWorldMatrix(true, false);
    const q = chest.getWorldQuaternion(new THREE.Quaternion());
    up.copy(p.body.up).applyQuaternion(q).normalize();
    right.copy(p.body.right).applyQuaternion(q).normalize();
  }

  // The sign has to be settled for both hands together.
  //
  // Deciding it per hand by simulation does not work: bending a finger a
  // little brings its tip closer to the wrist whichever way it bends, so the
  // test is marginal, and a marginal test run twice independently lands on
  // opposite answers — which is what it did, leaving the two palms 180 degrees
  // apart. Bind poses put the arms out with the palms facing down and never
  // up, which settles one hand; the other is its mirror by construction.
  if (palm.L && palm.R) {
    if (palm.L.dot(up) > 0) palm.L.negate();
    const mirrored = palm.L.clone().addScaledVector(right, -2 * palm.L.dot(right));
    if (palm.R.dot(mirrored) < 0) palm.R.negate();
  } else {
    for (const side of sides) {
      const normal = palm[side];
      if (normal && normal.dot(up) > 0) normal.negate();
    }
  }
  return palm;
}
