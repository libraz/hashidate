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
const _rootInverse = new THREE.Matrix4();
const _relativeRest = new THREE.Matrix4();
const _relativePosition = new THREE.Vector3();
const _relativeScale = new THREE.Vector3();
const _relativeQ = new THREE.Quaternion();

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

  /**
   * Basis that turns a root-authored rotation into this bone's rest frame.
   *
   * A pose describes the spine in one vocabulary: XYZ about the avatar's
   * root. A model is free to put a bone's local axes somewhere else, though,
   * and `restLocal * authored` consequently makes the same cue mean a
   * different thing on every such model. Capture the change of basis once,
   * while the profile is still in its rest pose, so committing a frame remains
   * a fixed amount of quaternion work with no per-frame matrix or object
   * creation.
   */
  private readonly basis = new Map<
    OffsetSlot,
    { q: THREE.Quaternion; inverse: THREE.Quaternion }
  >();

  constructor(profile: Profile) {
    // World quaternions are only meaningful after the hierarchy has been
    // walked. This root-authored XYZ contract deliberately keeps the runtime
    // vocabulary independent of each model's bone roll and pitch.
    profile.root.updateMatrixWorld(true);
    // Extract in root space rather than from each world matrix directly. A
    // nonuniform root scale makes the world matrix affine, and extracting its
    // rotation first would turn that scale into a small, bone-dependent axis
    // skew. Removing the root matrix first leaves the actual rest hierarchy.
    _rootInverse.copy(profile.root.matrixWorld).invert();

    for (const slot of [...SPINE_CHAIN, 'eye.L', 'eye.R'] as OffsetSlot[]) {
      const bone = profile.bones[slot];
      if (!bone) continue;
      _relativeRest
        .multiplyMatrices(_rootInverse, bone.matrixWorld)
        .decompose(_relativePosition, _relativeQ, _relativeScale);
      const q = _relativeQ.clone().invert();
      this.basis.set(slot, { q, inverse: q.clone().invert() });
    }
  }

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
      const authored = _q.setFromEuler(_e);
      const basis = this.basis.get(slot);
      if (basis) authored.premultiply(basis.q).multiply(basis.inverse);
      bone.quaternion.copy(restOf(bone)).multiply(authored);
    }
    for (const side of SIDES) {
      const bone = p.bones[`eye.${side}`];
      const o = this.offset.get(`eye.${side}`);
      if (!(bone && o)) continue;
      _e.set(o.x, o.y, o.z, 'XYZ');
      const authored = _q.setFromEuler(_e);
      const basis = this.basis.get(`eye.${side}`);
      if (basis) authored.premultiply(basis.q).multiply(basis.inverse);
      bone.quaternion.copy(restOf(bone)).multiply(authored);
    }
  }
}
