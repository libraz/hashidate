import * as THREE from 'three';
import { fingerCurl } from '../anatomy';
import {
  FINGER_NAMES,
  type FingerName,
  type FingerSpec,
  type JointTable,
  type Profile,
  type Side,
} from '../types';
import { solveFingerAxes } from './finger-axes';

/**
 * The fingers.
 *
 * Kept apart from the arm chain because nothing about them is aimed: a finger
 * is a curl about an axis this rig worked out once at load, and the arm's whole
 * apparatus of world directions, palm rolls and anatomical clamping has no
 * bearing on it.
 */

const _q = new THREE.Quaternion();

/** A fresh all-zero value per finger, keys in `FINGER_NAMES` order. */
export const mkFingerSpread = (): Record<FingerName, number> => ({
  thumb: 0,
  index: 0,
  middle: 0,
  ring: 0,
  little: 0,
});

/** Compose the bind rotation with the same optional splay-then-curl order everywhere. */
export function composeFingerRotation(
  out: THREE.Quaternion,
  rest: THREE.Quaternion,
  curlAxis: THREE.Vector3,
  curl: number,
  splayAxis: THREE.Vector3 | undefined,
  spread: number,
  scratch: THREE.Quaternion,
): THREE.Quaternion {
  out.copy(rest);
  if (splayAxis && spread !== 0) {
    out.multiply(scratch.setFromAxisAngle(splayAxis, spread));
  }
  return out.multiply(scratch.setFromAxisAngle(curlAxis, curl));
}

export class Hands {
  /** Curl axis per finger bone, in that bone's own space. */
  readonly axis: Map<THREE.Bone, THREE.Vector3>;
  /** Splay axis for proximal finger bones, in that bone's own space. */
  readonly splayAxis: Map<THREE.Bone, THREE.Vector3>;
  /** Palm normal in hand-bone space. */
  readonly palmLocal: Partial<Record<Side, THREE.Vector3>>;

  constructor(
    private readonly p: Profile,
    private readonly joints: JointTable,
    private readonly restOf: (bone: THREE.Bone) => THREE.Quaternion,
  ) {
    const fingers = solveFingerAxes(p);
    this.axis = fingers.axes;
    this.splayAxis = fingers.splayAxes;
    this.palmLocal = fingers.palmLocal;
  }

  /**
   * Curl a finger. 0 = straight, 1 = the joint's natural full flexion.
   *
   * One number per finger is the right control — nobody flexes a single
   * interphalangeal joint on purpose — but the three segments do not share a
   * range, and the taper that used to spread one number across them was
   * guessed. It had the middle joint travelling 102 degrees and the knuckle 89,
   * which is roughly right, and the fingertip 93, which is 20 degrees more than
   * a fingertip has. Each joint now takes its own range from the joint table.
   *
   * Above 1 is the strained band: available, and nothing reaches it by
   * accident. Below 0 is hyperextension, which the knuckles have and the middle
   * joints do not — also from the table, rather than a blanket floor of zero.
   */
  curlFinger(name: FingerName, side: Side, amount: number): void {
    const chain = this.p.fingerBones[`${name}.${side}`];
    if (!chain) return;
    const joints = this.joints[name === 'thumb' ? 'thumb' : 'finger'];
    for (let i = 0; i < chain.length; i++) {
      const bone = chain[i];
      const axis = this.axis.get(bone);
      if (!axis) continue;
      composeFingerRotation(
        bone.quaternion,
        this.restOf(bone),
        axis,
        fingerCurl(joints, i, amount),
        undefined,
        0,
        _q,
      );
    }
  }

  curlHand(side: Side, spec: FingerSpec, spread: FingerSpec = {}): void {
    for (const f of FINGER_NAMES) {
      const chain = this.p.fingerBones[`${f}.${side}`];
      if (!chain) continue;
      const joints = this.joints[f === 'thumb' ? 'thumb' : 'finger'];
      for (let i = 0; i < chain.length; i++) {
        const bone = chain[i];
        const curlAxis = this.axis.get(bone);
        if (!curlAxis) continue;
        composeFingerRotation(
          bone.quaternion,
          this.restOf(bone),
          curlAxis,
          fingerCurl(joints, i, spec[f] ?? 0),
          i === 0 ? this.splayAxis.get(bone) : undefined,
          i === 0 ? (spread[f] ?? 0) : 0,
          _q,
        );
      }
    }
  }
}
