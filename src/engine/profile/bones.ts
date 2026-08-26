/**
 * Bone resolution and measurement.
 *
 * Everything here reads the rest pose of the loaded scene: which bone fills
 * which canonical slot, which way each link points before anything poses it,
 * and how long the segments are in world units.
 */

import * as THREE from 'three';
import type { BodyFrame, BoneSlot, FingerKey, FingerName, Side } from '../types';
import {
  BONE_CANDIDATES,
  FINGER_ALIASES,
  FINGER_PATTERNS,
  FINGERS,
  type FingerCandidate,
  NEXT_IN_CHAIN,
} from './candidates';

const SIDES: readonly Side[] = ['L', 'R'];

/** The bones the profile resolved, by canonical slot. */
export type BoneMap = Partial<Record<BoneSlot, THREE.Bone>>;

/** Resolved finger chains, proximal first. */
export type FingerMap = Partial<Record<FingerKey, THREE.Bone[]>>;

/** A resolution pass: what it found, plus what it could not. */
export interface Resolved<T> {
  value: T;
  missing: string[];
}

const lower = (finger: FingerCandidate): FingerName =>
  finger.toLowerCase() as Lowercase<FingerCandidate>;

const worldPos = (b: THREE.Object3D): THREE.Vector3 => b.getWorldPosition(new THREE.Vector3());

/** Every bone in the scene, by name. The first of a duplicated name wins. */
export function collectBones(root: THREE.Object3D): Map<string, THREE.Bone> {
  const bonesByName = new Map<string, THREE.Bone>();
  root.traverse((o) => {
    if (o instanceof THREE.Bone && !bonesByName.has(o.name)) bonesByName.set(o.name, o);
  });
  return bonesByName;
}

/** Fill each canonical slot from the candidate lists, most specific first. */
export function resolveBones(bonesByName: Map<string, THREE.Bone>): Resolved<BoneMap> {
  const bones: BoneMap = {};
  const missing: string[] = [];
  for (const slot of Object.keys(BONE_CANDIDATES) as BoneSlot[]) {
    const hit = BONE_CANDIDATES[slot]
      .map((n) => bonesByName.get(n))
      .find((b): b is THREE.Bone => b !== undefined);
    if (hit) bones[slot] = hit;
    else missing.push(`bone:${slot}`);
  }
  return { value: bones, missing };
}

function resolveFinger(
  bonesByName: Map<string, THREE.Bone>,
  finger: FingerCandidate,
  side: Side,
): THREE.Bone[] | null {
  for (const alias of FINGER_ALIASES[finger]) {
    for (const pat of FINGER_PATTERNS) {
      const chain = [0, 1, 2].map((i) => bonesByName.get(pat(alias, side, i)));
      // A distal segment is often absent; proximal and intermediate are not.
      if (chain[0] && chain[1]) return chain.filter((b): b is THREE.Bone => b !== undefined);
    }
  }
  return null;
}

export function resolveFingers(bonesByName: Map<string, THREE.Bone>): Resolved<FingerMap> {
  const fingerBones: FingerMap = {};
  const missing: string[] = [];
  const noFingers: string[] = [];
  for (const side of SIDES) {
    for (const f of FINGERS) {
      const chain = resolveFinger(bonesByName, f, side);
      if (chain) fingerBones[`${lower(f)}.${side}`] = chain;
      else noFingers.push(`${lower(f)}.${side}`);
    }
  }
  // Fingers degrade gracefully — the hand just stops curling — but a rig whose
  // fingers all fail is a naming family we do not know, and that is worth
  // surfacing rather than discovering by noticing the hands never move.
  if (noFingers.length === FINGERS.length * 2) missing.push('fingers:none matched');
  else if (noFingers.length) missing.push(`fingers:${noFingers.join(',')}`);
  return { value: fingerBones, missing };
}

/** Bone-local direction toward the primary child, captured from the rest pose. */
export function childDirection(bone: THREE.Object3D): THREE.Vector3 {
  const child = bone.children.find((c): c is THREE.Bone => c instanceof THREE.Bone);
  if (!child) return new THREE.Vector3(0, 1, 0);
  const v = child.position.clone();
  return v.lengthSq() > 1e-12 ? v.normalize() : new THREE.Vector3(0, 1, 0);
}

/**
 * Bone-local direction from `bone` toward `next`.
 *
 * Never "the first child": that depends on the order the exporter happened to
 * write, and it is not even consistent between the two arms of one rig. On the
 * validation avatar `LowerArm_R` lists a twist bone first and the hand second
 * while `LowerArm_L` lists the hand first, and the two hands list their fingers
 * in different orders — so the right forearm aimed at a twist helper, the left
 * hand aimed down its thumb and the right hand down its index finger. The arms
 * then solved to visibly different poses from the same mirrored direction.
 */
export function chainDirection(bone: THREE.Object3D, next?: THREE.Object3D): THREE.Vector3 {
  if (!next) return childDirection(bone);
  if (next.parent === bone) {
    const v = next.position.clone();
    if (v.lengthSq() > 1e-12) return v.normalize();
    return childDirection(bone);
  }
  // Not a direct child — resolve through world space and bring it back local.
  bone.updateWorldMatrix(true, false);
  next.updateWorldMatrix(true, false);
  const v = worldPos(next)
    .sub(worldPos(bone))
    .applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()).invert());
  return v.lengthSq() > 1e-12 ? v.normalize() : childDirection(bone);
}

/** Which world X is the character's left. Derived, never assumed. */
export function deriveSideSign(root: THREE.Object3D, bones: BoneMap): number {
  const handL = bones['hand.L'];
  let sideSign = 1;
  if (handL) {
    root.updateMatrixWorld(true);
    sideSign = Math.sign(worldPos(handL).x) || 1;
  }
  return sideSign;
}

/** Rest directions for every resolved slot and every finger segment. */
export function buildRestDirections(
  bones: BoneMap,
  fingerBones: FingerMap,
): Record<string, THREE.Vector3> {
  const restDir: Record<string, THREE.Vector3> = {};
  for (const slot of Object.keys(BONE_CANDIDATES) as BoneSlot[]) {
    const bone = bones[slot];
    if (!bone) continue;
    // The hand aims where its fingers do, and the middle finger is the one that
    // runs straight out from the wrist.
    let next: THREE.Bone | undefined;
    if (slot === 'hand.L' || slot === 'hand.R') {
      next = fingerBones[`middle.${slot.slice(-1) as Side}`]?.[0];
    } else {
      const nextSlot = NEXT_IN_CHAIN[slot];
      next = nextSlot ? bones[nextSlot] : undefined;
    }
    restDir[slot] = chainDirection(bone, next);
  }
  for (const side of SIDES) {
    for (const f of FINGERS) {
      const key: FingerKey = `${lower(f)}.${side}`;
      const chain = fingerBones[key];
      if (!chain) continue;
      chain.forEach((b, i) => {
        restDir[`${key}.${i}`] = childDirection(b);
      });
    }
  }
  return restDir;
}

/**
 * Arm segment lengths, in world units.
 *
 * Measured between world positions, never from `bone.position.length()`. A
 * local translation is in the parent's units, and an avatar exported through
 * a chain of tools usually carries a scale somewhere up the hierarchy — this
 * one is authored in centimetres and scaled by 0.01 at the armature. The
 * reach solver compares these against world-space distances, so local lengths
 * put the numbers a hundred times apart: every target reads as far closer
 * than the arm's minimum extent, gets clamped to that minimum, and the elbow
 * solves to a fixed angle that has nothing to do with where the hand was
 * asked to go.
 */
export function measureLimbs(
  root: THREE.Object3D,
  bones: BoneMap,
  fingerBones: FingerMap,
): Record<string, number> {
  root.updateMatrixWorld(true);
  const limb: Record<string, number> = {};
  for (const side of SIDES) {
    const up = bones[`upperArm.${side}`];
    const lo = bones[`lowerArm.${side}`];
    const hd = bones[`hand.${side}`];
    if (up && lo && hd) {
      limb[`upper.${side}`] = worldPos(up).distanceTo(worldPos(lo));
      limb[`lower.${side}`] = worldPos(lo).distanceTo(worldPos(hd));
    }

    /**
     * Wrist to fingertip, per finger.
     *
     * Needed because a target given as a *fingertip* has to be turned into a
     * wrist position before a two-link solve can run, and the offset between
     * the two is a third of the forearm — far too much to ignore. Pointing at
     * something with the wrist where the finger should be puts the hand through
     * whatever is being pointed at.
     *
     * The last segment has no bone below it to measure against, so it is
     * estimated from the one above. A distal phalanx runs about three quarters
     * of its neighbour, and the error that leaves is a few millimetres on a
     * quantity that only sets how far the hand backs off.
     */
    if (hd) {
      for (const finger of FINGERS) {
        const f = lower(finger);
        const chain = fingerBones[`${f}.${side}`];
        if (!chain?.length) continue;
        let len = worldPos(hd).distanceTo(worldPos(chain[0]));
        let lastSeg = 0;
        for (let i = 1; i < chain.length; i++) {
          lastSeg = worldPos(chain[i - 1]).distanceTo(worldPos(chain[i]));
          len += lastSeg;
        }
        const last = chain[chain.length - 1];
        const tail = last.children.find((c): c is THREE.Bone => c instanceof THREE.Bone);
        len += tail ? worldPos(last).distanceTo(worldPos(tail)) : lastSeg * 0.75;
        limb[`tip.${side}.${f}`] = len;
      }
    }
  }
  return limb;
}

/**
 * Trunk half-width plus arm length, in world units.
 *
 * The unit body anchors are given in. Chosen over the trunk or the arm alone
 * because it is the reach the solver strains against — a target at 0.4 span is
 * comfortably inside it on any build — and because it is the one distance a
 * pose library can be calibrated against without knowing anything else about
 * the avatar it was authored on. A T-pose states it directly: the wrist sits at
 * exactly this distance from the midline.
 *
 * Half-width is taken to the upper arm rather than the clavicle for the reason
 * given in `anatomy/body-frame.ts` — the clavicle root sits beside the neck, and
 * measuring from there describes a trunk a fifth as wide as one arm segment.
 */
export function measureSpan(
  bones: BoneMap,
  body: BodyFrame,
  limb: Record<string, number>,
): number | null {
  const chest = bones.chest ?? bones.spine ?? bones.hips;
  const sL = bones['upperArm.L'];
  const sR = bones['upperArm.R'];
  if (!(chest && sL && sR)) return null;
  const up = body.up.clone().applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion()));
  const origin = worldPos(chest);
  const off = (b: THREE.Bone) => {
    const v = worldPos(b).sub(origin);
    v.addScaledVector(up, -v.dot(up));
    return v.length();
  };
  const halfWidth = (off(sL) + off(sR)) / 2;
  const arm =
    ((limb['upper.L'] ?? 0) +
      (limb['lower.L'] ?? 0) +
      (limb['upper.R'] ?? 0) +
      (limb['lower.R'] ?? 0)) /
    2;
  return arm > 0 ? halfWidth + arm : null;
}
