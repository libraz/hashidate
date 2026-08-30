import * as THREE from 'three';
import type { EyeSlot, Profile, Side, SpineSlot } from '../types';

/**
 * The additive half of a frame.
 *
 * The arm chains are *aimed* — told a world direction and rotated onto it — and
 * the spine is not: a breath, a lean and a head turn are small rotations that
 * add up, and there is no direction to aim a hip at. So the layers above stack
 * radians per slot over a frame and this bakes the sum into local quaternions
 * once, after everything has had its say.
 *
 * The eyes ride along because they are the same shape of problem: a gaze offset
 * is additive on top of a rest orientation, and nothing aims an eyeball.
 */

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

const SPINE_CHAIN: readonly SpineSlot[] = ['hips', 'spine', 'chest', 'neck', 'head'];
const SIDES: readonly Side[] = ['L', 'R'];

/** Spine-chain slots plus the eyes, which take the same additive treatment. */
export type OffsetSlot = SpineSlot | EyeSlot;

/** Radians about each axis, accumulated over a frame. */
interface Offset {
  x: number;
  y: number;
  z: number;
}

export class SpineOffsets {
  /** slot -> additive Euler offset for this frame */
  readonly offset = new Map<OffsetSlot, Offset>();

  clear(): void {
    this.offset.clear();
  }

  /** Accumulate a small additive rotation on a spine-chain slot (radians). */
  add(slot: OffsetSlot, x: number, y: number, z: number): void {
    const o = this.offset.get(slot) ?? { x: 0, y: 0, z: 0 };
    o.x += x;
    o.y += y;
    o.z += z;
    this.offset.set(slot, o);
  }

  /** Bake accumulated spine offsets into local quaternions. */
  commit(p: Profile, restOf: (bone: THREE.Bone) => THREE.Quaternion): void {
    for (const slot of SPINE_CHAIN) {
      const bone = p.bones[slot];
      const o = this.offset.get(slot);
      if (!(bone && o)) continue;
      _e.set(o.x, o.y, o.z, 'XYZ');
      bone.quaternion.copy(restOf(bone)).multiply(_q.setFromEuler(_e));
    }
    for (const side of SIDES) {
      const bone = p.bones[`eye.${side}`];
      const o = this.offset.get(`eye.${side}`);
      if (!(bone && o)) continue;
      _e.set(o.x, o.y, o.z, 'XYZ');
      bone.quaternion.copy(restOf(bone)).multiply(_q.setFromEuler(_e));
    }
  }
}
