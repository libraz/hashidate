import * as THREE from 'three';
import { restPalmNormals } from '../anatomy/palm-frame';
import { FINGER_NAMES, type Profile, type Side } from '../types';

/**
 * Finger hinge axes, derived from the rest pose.
 *
 * Split out of the rig because it runs once, at construction, and reads only
 * the profile: which way a finger bends is a property of how the hand was
 * modelled, not of anything a frame does.
 */

const SIDES: readonly Side[] = ['L', 'R'];
/** What the rig keeps from the rest-pose hand. */
export interface FingerAxes {
  /** Curl axis per finger bone, in that bone's own space. */
  axes: Map<THREE.Bone, THREE.Vector3>;
  /** Splay axis for each proximal finger bone, in that bone's own space. */
  splayAxes: Map<THREE.Bone, THREE.Vector3>;
  /** Palm normal per hand, in the hand bone's own space. */
  palmLocal: Partial<Record<Side, THREE.Vector3>>;
}

/**
 * Curl axis for every finger bone, in that bone's own space.
 *
 * Derived from the rest geometry: the axis is perpendicular to both the bone
 * direction and the palm normal, which is what a finger actually hinges about.
 */
export function solveFingerAxes(p: Profile): FingerAxes {
  const axes = new Map<THREE.Bone, THREE.Vector3>();
  const splayAxes = new Map<THREE.Bone, THREE.Vector3>();
  const palmLocal: Partial<Record<Side, THREE.Vector3>> = {};
  const { fingerBones, bones, restDir } = p;
  const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

  // --- palm normal per hand, in world space -------------------------------
  const palm = restPalmNormals(p);

  // --- curl axes, plus the palm kept for roll targeting --------------------
  for (const side of SIDES) {
    const palmNormal = palm[side];
    const hand = bones[`hand.${side}`];
    if (!(palmNormal && hand)) continue;

    // Stored in the hand bone's own space so the hand can be rolled to face a
    // given direction later: aiming the hand fixes only where the fingers
    // point and leaves the roll about that axis free.
    palmLocal[side] = palmNormal
      .clone()
      .applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()).invert())
      .normalize();

    // Splay is a turn in the palm plane, so its axis is the palm normal. The
    // sign is settled from the rest-pose finger bases rather than world X:
    // positive always fans toward the little finger, even when a hand or the
    // whole character is rotated. A single little-minus-index vector gives
    // the semantic lateral direction for every proximal phalanx.
    const index = fingerBones[`index.${side}`]?.[0];
    const little = fingerBones[`little.${side}`]?.[0];
    let towardLittle = index && little ? wp(little).sub(wp(index)) : null;
    if (towardLittle) {
      towardLittle.addScaledVector(palmNormal, -towardLittle.dot(palmNormal));
      if (towardLittle.lengthSq() > 1e-10) towardLittle.normalize();
      else towardLittle = null;
    }

    for (const f of FINGER_NAMES) {
      const chain = fingerBones[`${f}.${side}`];
      if (!chain) continue;
      for (let i = 0; i < chain.length; i++) {
        const bone = chain[i];
        const boneQ = bone.getWorldQuaternion(new THREE.Quaternion());
        const nLocal = palmNormal.clone().applyQuaternion(boneQ.clone().invert()).normalize();
        const dir = restDir[`${f}.${side}.${i}`] ?? new THREE.Vector3(0, 1, 0);

        if (i === 0 && towardLittle) {
          const splay = nLocal.clone();
          const dirWorld = dir.clone().applyQuaternion(boneQ).normalize();
          const positiveTurn = new THREE.Vector3().crossVectors(palmNormal, dirWorld);
          if (positiveTurn.dot(towardLittle) < 0) splay.negate();
          splayAxes.set(bone, splay);
        }

        const axis = new THREE.Vector3().crossVectors(dir, nLocal);
        if (axis.lengthSq() > 1e-10) axis.normalize();
        else axis.set(1, 0, 0);

        // The cross product gives the hinge line but not which way it turns.
        // Here the test is not marginal — the palm side is already known, so
        // ask directly whether the tip moves toward it.
        const segLen = chain[i + 1]?.position.length() ?? 1;
        const at = bone.getWorldPosition(new THREE.Vector3());
        const before = at.clone().addScaledVector(dir.clone().applyQuaternion(boneQ), segLen);
        const spun = dir
          .clone()
          .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, 0.4))
          .applyQuaternion(boneQ);
        const after = at.clone().addScaledVector(spun, segLen);
        if (after.sub(before).dot(palmNormal) < 0) axis.negate();

        axes.set(bone, axis);
      }
    }
  }
  return { axes, splayAxes, palmLocal };
}
