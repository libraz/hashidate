/**
 * Copies of caller-owned objects into the rig's scratch and back, in the record layouts of
 * `src/core/abi/rig.ts`. Every writer takes the heap and an f64 index; `writeSpec` returns the
 * presence bits the export takes alongside a FingerSpec.
 */

import type * as THREE from 'three';
import { FINGERS, SIDES } from '../../../core/abi/profile';
import type { FingerSpec, Side, Vec3Tuple } from '../../types';
import type { ArmForwardContext, ArmForwardResult } from '../arm-configuration';
import type { ArmSolution } from '../reach';

/** A tuple's x, y, z or a vector's, a tuple's missing element as 0. */
export function writeVec(f: Float64Array, at: number, v: THREE.Vector3 | Vec3Tuple): void {
  if (Array.isArray(v)) {
    f[at] = v[0] ?? 0;
    f[at + 1] = v[1] ?? 0;
    f[at + 2] = v[2] ?? 0;
  } else {
    const o = v as THREE.Vector3;
    f[at] = o.x;
    f[at + 1] = o.y;
    f[at + 2] = o.z;
  }
}

export function readVec(f: Float64Array, at: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(f[at], f[at + 1], f[at + 2]);
}

export function readTuple(f: Float64Array, at: number, out: Vec3Tuple): Vec3Tuple {
  out[0] = f[at];
  out[1] = f[at + 1];
  out[2] = f[at + 2];
  return out;
}

export function writeQuat(f: Float64Array, at: number, q: THREE.Quaternion): void {
  f[at] = q.x;
  f[at + 1] = q.y;
  f[at + 2] = q.z;
  f[at + 3] = q.w;
}

export function readQuat(f: Float64Array, at: number, out: THREE.Quaternion): THREE.Quaternion {
  return out.set(f[at], f[at + 1], f[at + 2], f[at + 3]);
}

/** Five f64 in FINGERS order; bit `i` set where finger `i` is given. */
export function writeSpec(f: Float64Array, at: number, spec: FingerSpec): number {
  let bits = 0;
  for (const [i, finger] of FINGERS.entries()) {
    const v = spec[finger];
    if (v === undefined) continue;
    f[at + i] = v;
    bits |= 1 << i;
  }
  return bits;
}

/** Five f64 in FINGERS order from a record that names every finger. */
export function writeFingers(f: Float64Array, at: number, values: FingerSpec): void {
  for (const [i, finger] of FINGERS.entries()) f[at + i] = values[finger] as number;
}

export function sideCode(side: Side): number {
  const s = SIDES.indexOf(side);
  if (s < 0) throw new Error(`CoreRig: unknown side ${String(side)}`);
  return s;
}

const FORWARD_VECTORS = ['u', 'l', 'h', 'palm', 'elbow', 'wrist'] as const;
const FORWARD_QUATERNIONS = [
  'upperWorld',
  'lowerWorld',
  'handWorld',
  'upperLocal',
  'lowerLocal',
  'handLocal',
] as const;

export function writeForward(f: Float64Array, at: number, r: ArmForwardResult): void {
  for (const [k, key] of FORWARD_VECTORS.entries()) writeVec(f, at + 3 * k, r[key]);
  for (const [k, key] of FORWARD_QUATERNIONS.entries()) writeQuat(f, at + 18 + 4 * k, r[key]);
}

export function writeContext(f: Float64Array, at: number, c: ArmForwardContext): void {
  f[at] = sideCode(c.side);
  writeVec(f, at + 1, c.shoulder);
  f[at + 4] = c.upperLength;
  f[at + 5] = c.lowerLength;
  writeVec(f, at + 6, c.up);
  writeVec(f, at + 9, c.right);
  writeVec(f, at + 12, c.forward);
  writeQuat(f, at + 15, c.upperParentWorld);
}

/** A context the facade owns per side, refilled by each read. */
export interface MutableContext {
  side: Side;
  shoulder: THREE.Vector3;
  upperLength: number;
  lowerLength: number;
  up: THREE.Vector3;
  right: THREE.Vector3;
  forward: THREE.Vector3;
  upperParentWorld: THREE.Quaternion;
}

export function readContext(f: Float64Array, at: number, out: MutableContext): MutableContext {
  out.side = SIDES[f[at]];
  readVec(f, at + 1, out.shoulder);
  out.upperLength = f[at + 4];
  out.lowerLength = f[at + 5];
  readVec(f, at + 6, out.up);
  readVec(f, at + 9, out.right);
  readVec(f, at + 12, out.forward);
  readQuat(f, at + 15, out.upperParentWorld);
  return out;
}

export function writeSolution(f: Float64Array, at: number, o: ArmSolution): void {
  writeVec(f, at, o.upperArm);
  writeVec(f, at + 3, o.lowerArm);
  writeVec(f, at + 6, o.hand);
  writeVec(f, at + 9, o.palm);
  writeVec(f, at + 12, o.tip);
  f[at + 15] = o.twist;
  f[at + 16] = o.strain === undefined ? 0 : 1;
  f[at + 17] = o.strain ?? 0;
  writeVec(f, at + 18, o.swivelDir);
  f[at + 21] = o.clasp === undefined ? 0 : 1;
  f[at + 22] = o.clasp ? 1 : 0;
}

export function readSolution(f: Float64Array, at: number, o: ArmSolution): void {
  readVec(f, at, o.upperArm);
  readVec(f, at + 3, o.lowerArm);
  readVec(f, at + 6, o.hand);
  readVec(f, at + 9, o.palm);
  readVec(f, at + 12, o.tip);
  o.twist = f[at + 15];
  if (f[at + 16] !== 0) o.strain = f[at + 17];
  else if (o.strain !== undefined) o.strain = undefined;
  readVec(f, at + 18, o.swivelDir);
  if (f[at + 21] !== 0) o.clasp = f[at + 22] !== 0;
  else if (o.clasp !== undefined) o.clasp = undefined;
}
