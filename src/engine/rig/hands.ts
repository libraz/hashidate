import type * as THREE from 'three';
import { allocating, core } from '../../core';
import { HAND_FRAME } from '../../core/abi/rig';
import type { FingerName } from '../types';
import { heap, rebindHeap } from './views';

/** A fresh all-zero value per finger, keys in `FINGER_NAMES` order. */
export const mkFingerSpread = (): Record<FingerName, number> => ({
  thumb: 0,
  index: 0,
  middle: 0,
  ring: 0,
  little: 0,
});

/** f64 index of the HAND_FRAME block `handFrame` passes the core, made on first use. */
let frameAt = -1;

/**
 * The frame a hand's pointing direction and palm normal make, as columns:
 * pointing, palm, and their cross. Null when the two are parallel. Normalises
 * `point` in place.
 */
export function handFrame(
  point: THREE.Vector3,
  palm: THREE.Vector3,
  out: THREE.Matrix3,
): THREE.Matrix3 | null {
  if (frameAt < 0) {
    frameAt = allocating(() => core().hd_alloc(8 * HAND_FRAME)) / 8;
    rebindHeap();
  }
  const at = frameAt;
  const f = heap();
  f[at] = point.x;
  f[at + 1] = point.y;
  f[at + 2] = point.z;
  f[at + 3] = palm.x;
  f[at + 4] = palm.y;
  f[at + 5] = palm.z;
  f.set(out.elements, at + 6);
  const ok = core().hd_rig_hand_frame(8 * at) === 1;
  point.set(f[at], f[at + 1], f[at + 2]);
  if (!ok) return null;
  return out.fromArray(f, at + 6);
}
