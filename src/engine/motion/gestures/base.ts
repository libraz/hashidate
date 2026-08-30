import * as THREE from 'three';
import type { ArmSlot, FingerName } from '../../types';

/**
 * The pose an arm falls back to, and the one helper every direction in this
 * table is written with.
 *
 * A gesture states only the links it moves; everything it leaves out reads
 * these. They are therefore the shape of a character standing still, and the
 * palm in particular is load-bearing — see `BASE_PALM`.
 */

export const V = (x: number, y: number, z: number): THREE.Vector3 =>
  new THREE.Vector3(x, y, z).normalize();

export const BASE_POSE: Record<ArmSlot, THREE.Vector3> = {
  shoulder: V(0.95, -0.26, 0.06),
  upperArm: V(0.3, -0.94, 0.14),
  lowerArm: V(0.17, -0.95, 0.26),
  hand: V(0.13, -0.96, 0.24),
};

/**
 * Which way the palm faces, in character space.
 *
 * Aiming the hand only says where the fingers point; the roll about that axis
 * is a second degree of freedom and has to be given, or it falls out of the
 * rest pose as an accident. A hand at rest by the side turns its palm inward
 * toward the thigh and slightly back — hanging it palm-forward is the single
 * most common tell of an unposed rig.
 */
export const BASE_PALM: THREE.Vector3 = V(-0.88, 0.06, -0.47);

export const BASE_FINGERS: Record<FingerName, number> = {
  thumb: 0.22,
  index: 0.28,
  middle: 0.34,
  ring: 0.4,
  little: 0.46,
};
