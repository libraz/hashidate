import * as THREE from 'three';
import { fingerCurl, thumbOpposition } from '../anatomy';
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
 * bearing on it. The thumb's distal hinge also turns about the phalanx with the
 * curl (opposition); the stored axes do not change.
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

/** Compose the bind rotation with the same optional splay-turn-curl order everywhere. */
export function composeFingerRotation(
  out: THREE.Quaternion,
  rest: THREE.Quaternion,
  curlAxis: THREE.Vector3,
  curl: number,
  splayAxis: THREE.Vector3 | undefined,
  spread: number,
  turnAxis: THREE.Vector3 | undefined,
  turn: number,
  scratch: THREE.Quaternion,
): THREE.Quaternion {
  out.copy(rest);
  if (splayAxis && spread !== 0) {
    out.multiply(scratch.setFromAxisAngle(splayAxis, spread));
  }
  if (turnAxis && turn !== 0) {
    out.multiply(scratch.setFromAxisAngle(turnAxis, turn));
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
  /** Direction of the opposition turn per thumb distal bone. */
  private readonly oppositionSign: Map<THREE.Bone, number>;

  constructor(
    private readonly p: Profile,
    private readonly joints: JointTable,
    private readonly restOf: (bone: THREE.Bone) => THREE.Quaternion,
  ) {
    const fingers = solveFingerAxes(p);
    this.axis = fingers.axes;
    this.splayAxis = fingers.splayAxes;
    this.palmLocal = fingers.palmLocal;
    this.oppositionSign = fingers.oppositionSign;
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
   *
   * `spread` is the knuckle's splay, kept as `curlHand` would apply it.
   */
  curlFinger(name: FingerName, side: Side, amount: number, spread = 0): void {
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
        i === 0 ? this.splayAxis.get(bone) : undefined,
        i === 0 ? spread : 0,
        ...this.opposition(name, side, bone, i, amount),
        _q,
      );
    }
  }

  /** The turn axis and angle of a bone: only the thumb's distal hinge turns. */
  private opposition(
    name: FingerName,
    side: Side,
    bone: THREE.Bone,
    i: number,
    amount: number,
  ): [THREE.Vector3 | undefined, number] {
    if (name !== 'thumb' || i !== 2) return [undefined, 0];
    const sign = this.oppositionSign.get(bone) ?? 1;
    return [this.p.restDir[`thumb.${side}.2`], sign * thumbOpposition(amount)];
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
          ...this.opposition(f, side, bone, i, spec[f] ?? 0),
          _q,
        );
      }
    }
  }
}
