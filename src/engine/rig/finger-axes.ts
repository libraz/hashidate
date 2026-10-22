import * as THREE from 'three';
import { THUMB_FLEXION_TILT, THUMB_OPPOSITION } from '../anatomy/joints';
import { restPalmNormals } from '../anatomy/palm-frame';
import { FINGER_NAMES, type Profile, type Side } from '../types';

/**
 * Finger hinge axes, derived from the rest pose.
 *
 * The thumb is the exception to the finger rule: it hinges about the palm normal tilted toward
 * the finger fold and splays perpendicular to that, the reverse of a finger. The distal hinge
 * additionally turns about the phalanx with the curl (opposition, in `hands.ts`); the axes stored
 * here do not change, only the direction of that turn is settled here per hand.
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
  /** Sign of the opposition turn for each thumb's distal bone: the one that folds the tip toward the palm. */
  oppositionSign: Map<THREE.Bone, number>;
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
  const oppositionSign = new Map<THREE.Bone, number>();
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

        if (f === 'thumb') {
          const dirWorld = dir.clone().applyQuaternion(boneQ).normalize();
          const fold = new THREE.Vector3().crossVectors(dir, nLocal);
          if (fold.lengthSq() > 1e-10) fold.normalize();
          else fold.set(1, 0, 0);
          // Turning about the fold lifts the tip toward the palm, which is what
          // palmar abduction is.
          if (i === 0) splayAxes.set(bone, fold.clone());
          // Flexion sweeps the tip toward the little finger; the tilt toward
          // the fold stays on the palm side, so only the normal term flips.
          const sweep = new THREE.Vector3().crossVectors(palmNormal, dirWorld);
          const lean = towardLittle && sweep.dot(towardLittle) < 0 ? -1 : 1;
          const hinge = nLocal
            .clone()
            .multiplyScalar(lean * Math.cos(THUMB_FLEXION_TILT))
            .addScaledVector(fold, Math.sin(THUMB_FLEXION_TILT))
            .normalize();
          axes.set(bone, hinge);
          if (i === 2) {
            // A turn about the phalanx mirrors with the hand, so ask which way folds the tip
            // further toward the palm side rather than assuming a sign.
            const folded = (sign: number) =>
              dir
                .clone()
                .applyAxisAngle(hinge, 1)
                .applyAxisAngle(dir, sign * THUMB_OPPOSITION)
                .dot(nLocal);
            oppositionSign.set(bone, folded(1) <= folded(-1) ? 1 : -1);
          }
          continue;
        }

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
  return { axes, splayAxes, palmLocal, oppositionSign };
}
