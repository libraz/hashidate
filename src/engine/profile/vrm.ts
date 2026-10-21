/**
 * VRM humanoid map to bone overrides.
 *
 * A VRM file states which node fills each humanoid slot, which is better
 * evidence than any naming guess. This reads that map out of a glTF JSON object
 * and spells it as the descriptor's `bones` and `fingers`, naming each node as
 * the loader did when the parser's associations are at hand.
 */

import * as THREE from 'three';
import type { BoneOverrides, BoneSlot, FingerKey, FingerOverrides, Side } from '../types';

/** What a glTF's VRM humanoid says, in the descriptor's vocabulary. */
export interface VrmHumanoid {
  bones: BoneOverrides;
  fingers: FingerOverrides;
  /** True for VRM 0.x, whose models face the opposite way to 1.0's. */
  legacy: boolean;
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const SIDE_PREFIX: Record<Side, string> = { L: 'left', R: 'right' };

/** VRM bone name to slot. The chest slot lists upperChest first, as the candidates do. */
const BODY: Array<[string, BoneSlot]> = [
  ['hips', 'hips'],
  ['spine', 'spine'],
  ['upperChest', 'chest'],
  ['chest', 'chest'],
  ['neck', 'neck'],
  ['head', 'head'],
];

const LIMBS: Array<[string, string]> = [
  ['Eye', 'eye'],
  ['Shoulder', 'shoulder'],
  ['UpperArm', 'upperArm'],
  ['LowerArm', 'lowerArm'],
  ['Hand', 'hand'],
  ['UpperLeg', 'upperLeg'],
  ['LowerLeg', 'lowerLeg'],
  ['Foot', 'foot'],
  ['Toes', 'toe'],
];

const FINGERS: Array<[string, string]> = [
  ['Thumb', 'thumb'],
  ['Index', 'index'],
  ['Middle', 'middle'],
  ['Ring', 'ring'],
  ['Little', 'little'],
];

/**
 * VRM 1.0 gives the thumb a metacarpal where 0.x calls the same bone
 * `Proximal`, so both land on the first segment of the chain.
 */
const SEGMENTS = ['Proximal', 'Intermediate', 'Distal'];
const THUMB_V1 = ['Metacarpal', 'Proximal', 'Distal'];

/** VRM bone name to node name, for whichever version the file carries. */
function readNodeNames(
  gltf: Json,
  loadedName?: (index: number) => string | undefined,
): { names: Map<string, string>; legacy: boolean } | null {
  const nodes = Array.isArray(gltf.nodes) ? (gltf.nodes as unknown[]) : [];
  const extensions = isRecord(gltf.extensions) ? gltf.extensions : {};
  const nameOf = (index: unknown): string | undefined => {
    if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
    if (loadedName) return loadedName(index) || undefined;
    const node = nodes[index];
    const name = isRecord(node) ? node.name : undefined;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  };

  const v1 = isRecord(extensions.VRMC_vrm) ? extensions.VRMC_vrm : null;
  const humanBones1 = isRecord(v1?.humanoid) ? v1.humanoid.humanBones : undefined;
  if (isRecord(humanBones1)) {
    const names = new Map<string, string>();
    for (const [bone, entry] of Object.entries(humanBones1)) {
      const name = isRecord(entry) ? nameOf(entry.node) : undefined;
      if (name) names.set(bone, name);
    }
    return { names, legacy: false };
  }

  const v0 = isRecord(extensions.VRM) ? extensions.VRM : null;
  const humanBones0 = isRecord(v0?.humanoid) ? v0.humanoid.humanBones : undefined;
  if (Array.isArray(humanBones0)) {
    const names = new Map<string, string>();
    for (const entry of humanBones0) {
      if (!isRecord(entry) || typeof entry.bone !== 'string') continue;
      const name = nameOf(entry.node);
      if (name) names.set(entry.bone, name);
    }
    return { names, legacy: true };
  }
  return null;
}

/**
 * Node index to the name the loader gave it.
 *
 * GLTFLoader suffixes a repeated name (`Hips`, `Hips_1`), so the file's name
 * can belong to a different node than the one the map points at. `associations`
 * is the parser's own record of which object each node index became.
 */
export function loadedNodeNames(
  associations: ReadonlyMap<unknown, { nodes?: number }>,
): (index: number) => string | undefined {
  const names = new Map<number, string>();
  for (const [object, ref] of associations) {
    if (object instanceof THREE.Object3D && ref.nodes !== undefined && !names.has(ref.nodes)) {
      names.set(ref.nodes, object.name);
    }
  }
  return (index) => names.get(index);
}

/**
 * Read a glTF JSON object's VRM humanoid map as bone overrides.
 *
 * Returns null when the file carries no humanoid map. With `loadedName` (see
 * `loadedNodeNames`) each bone is named as the loader named its node; without
 * it, by the file's name, which a duplicated name makes ambiguous.
 */
export function readVrmHumanoid(
  gltf: unknown,
  loadedName?: (index: number) => string | undefined,
): VrmHumanoid | null {
  if (!isRecord(gltf)) return null;
  const found = readNodeNames(gltf, loadedName);
  if (!found) return null;
  const { names, legacy } = found;

  const bones: BoneOverrides = {};
  const add = (slot: BoneSlot, vrm: string): void => {
    const name = names.get(vrm);
    if (name) bones[slot] = [...(bones[slot] ?? []), name];
  };
  for (const [vrm, slot] of BODY) add(slot, vrm);
  for (const side of ['L', 'R'] as const) {
    for (const [vrm, slot] of LIMBS)
      add(`${slot}.${side}` as BoneSlot, `${SIDE_PREFIX[side]}${vrm}`);
  }

  const fingers: FingerOverrides = {};
  for (const side of ['L', 'R'] as const) {
    for (const [vrm, finger] of FINGERS) {
      const segments = vrm === 'Thumb' && !legacy ? THUMB_V1 : SEGMENTS;
      const chain: string[] = [];
      for (const segment of segments) {
        const name = names.get(`${SIDE_PREFIX[side]}${vrm}${segment}`);
        if (!name) break;
        chain.push(name);
      }
      if (chain.length > 0) fingers[`${finger}.${side}` as FingerKey] = chain;
    }
  }
  return { bones, fingers, legacy };
}
