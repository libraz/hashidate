import * as THREE from 'three';
import { fingerCurl } from '../anatomy';
import type { FingerName, FingerSpec, JointTable, Profile, Side } from '../types';
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

const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];

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
      bone.quaternion
        .copy(this.restOf(bone))
        .multiply(_q.setFromAxisAngle(axis, fingerCurl(joints, i, amount)));
    }
  }

  curlHand(side: Side, spec: FingerSpec, spread: FingerSpec = {}): void {
    for (const f of FINGERS) {
      const chain = this.p.fingerBones[`${f}.${side}`];
      if (!chain) continue;
      const joints = this.joints[f === 'thumb' ? 'thumb' : 'finger'];
      for (let i = 0; i < chain.length; i++) {
        const bone = chain[i];
        const curlAxis = this.axis.get(bone);
        if (!curlAxis) continue;
        bone.quaternion.copy(this.restOf(bone));
        if (i === 0) {
          const splayAxis = this.splayAxis.get(bone);
          const splay = spread[f] ?? 0;
          if (splayAxis && splay !== 0) {
            bone.quaternion.multiply(_q.setFromAxisAngle(splayAxis, splay));
          }
        }
        bone.quaternion.multiply(
          _q.setFromAxisAngle(curlAxis, fingerCurl(joints, i, spec[f] ?? 0)),
        );
      }
    }
  }
}
