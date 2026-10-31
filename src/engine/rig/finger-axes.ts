import type * as THREE from 'three';
import type { Side } from '../types';
import type { Rig } from './rig';

/**
 * Finger hinge axes, derived once from the rest pose when the rig is built.
 *
 * Which way a finger bends is a property of how the hand was modelled, not of
 * anything a frame does, so the core works it out at construction and keeps it.
 */

/** What the rig keeps from the rest-pose hand. */
export interface FingerAxes {
  /** Curl axis per finger bone, in that bone's own space. */
  axes: Map<THREE.Bone, THREE.Vector3>;
  /** Splay axis for each proximal finger bone, in that bone's own space. */
  splayAxes: Map<THREE.Bone, THREE.Vector3>;
  /** Palm normal per hand, in the hand bone's own space. */
  palmLocal: Partial<Record<Side, THREE.Vector3>>;
}

/** The finger axes `rig` derived from its avatar's rest pose. */
export function solveFingerAxes(rig: Rig): FingerAxes {
  return { axes: rig.fingerAxis, splayAxes: rig.fingerSplayAxis, palmLocal: rig.palmLocal };
}
