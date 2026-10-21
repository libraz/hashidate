import * as THREE from 'three';
import type { Profile, Side } from '../types';

/** Signed rest-pose palm normals in world space, shared by fingers and wrist limits. */
export function restPalmNormals(p: Profile): Partial<Record<Side, THREE.Vector3>> {
  const palm: Partial<Record<Side, THREE.Vector3>> = {};
  const sides: readonly Side[] = ['L', 'R'];
  const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

  // The profile frame is chest-local; the measured finger geometry is world-space.
  // Without a body frame, retain the coordinate-axis fallback used by partial rigs,
  // facing the way a person with that up and right would.
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3(1, 0, 0);
  const forward = new THREE.Vector3().crossVectors(up, right);
  const chest = p.bones.chest ?? p.bones.spine ?? p.bones.hips;
  if (p.body && chest) {
    chest.updateWorldMatrix(true, false);
    // The full matrix rather than its rotation, so a mirrored armature keeps
    // its handedness.
    up.copy(p.body.up).transformDirection(chest.matrixWorld);
    right.copy(p.body.right).transformDirection(chest.matrixWorld);
    forward.copy(p.body.forward).transformDirection(chest.matrixWorld);
  }

  // The sign comes from the hand's chirality. `along × (little − index)` leaves
  // the palm of a right hand and the back of a left one, whatever the bind
  // does with the arm; which hand is the right one is the body frame's
  // handedness, read the same way `lateralReference` reads it. Guessing from
  // the bind instead — palms face down — fails wherever a palm is level, which
  // is every palms-in bind.
  const lateral = new THREE.Vector3();
  const facing = new THREE.Vector3();
  for (const side of sides) {
    const hand = p.bones[`hand.${side}`];
    const index = p.fingerBones[`index.${side}`]?.[0];
    const little = p.fingerBones[`little.${side}`]?.[0];
    const middle = p.fingerBones[`middle.${side}`]?.[0];
    if (!(hand && index && little && middle)) continue;
    hand.updateWorldMatrix(true, false);
    const across = wp(little).sub(wp(index)).normalize();
    const along = wp(middle).sub(wp(hand)).normalize();
    const normal = new THREE.Vector3().crossVectors(along, across).normalize();
    lateral.copy(right);
    if (side === 'L') lateral.negate();
    if (up.dot(facing.crossVectors(forward, lateral)) > 0) normal.negate();
    palm[side] = normal;
  }
  return palm;
}
