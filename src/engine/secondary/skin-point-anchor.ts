import * as THREE from 'three';
import { hypot3 } from '../../core/math';
import { normaliseBoneName } from '../profile/candidates';
import type { SkinPointAnchorSpec } from '../types';

const WEIGHT_SUM_TOLERANCE = 1e-5;
const UNIFORM_SCALE_TOLERANCE = 1e-5;
const ORTHOGONAL_TOLERANCE = 1e-6;

interface ResolvedInfluence {
  bone: THREE.Bone;
  weight: number;
  position: THREE.Vector3;
}

export interface SkinPointAnchorDiagnostics {
  targetWorld: [number, number, number];
  rootWorld: [number, number, number];
  error: number;
}

function requireAnchor(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLocalMatrix(node: THREE.Object3D, out: THREE.Matrix4): THREE.Matrix4 {
  if (node.matrixAutoUpdate) return out.compose(node.position, node.quaternion, node.scale);
  return out.copy(node.matrix);
}

/** Reject a local transform that is not finite affine, nearly uniform in scale and orthogonal. */
function checkTransform(node: THREE.Object3D, matrix: THREE.Matrix4): void {
  const e = matrix.elements;
  const element = (index: number): number => e[index] ?? Number.NaN;
  if (
    !(
      e.every(Number.isFinite) &&
      Math.abs(element(3)) <= 1e-8 &&
      Math.abs(element(7)) <= 1e-8 &&
      Math.abs(element(11)) <= 1e-8 &&
      Math.abs(element(15) - 1) <= 1e-8
    )
  ) {
    fail(`anchor:${node.name} requires a finite affine local transform`);
  }
  const x = hypot3(element(0), element(1), element(2));
  const y = hypot3(element(4), element(5), element(6));
  const z = hypot3(element(8), element(9), element(10));
  const maximum = Math.max(x, y, z);
  if (!(maximum > 1e-12)) fail(`anchor:${node.name} has a singular local transform`);
  if (
    !(
      Math.abs(x - y) <= UNIFORM_SCALE_TOLERANCE * maximum &&
      Math.abs(x - z) <= UNIFORM_SCALE_TOLERANCE * maximum
    )
  ) {
    fail(`anchor:${node.name} does not support nonuniform scale`);
  }
  const xy = element(0) * element(4) + element(1) * element(5) + element(2) * element(6);
  const xz = element(0) * element(8) + element(1) * element(9) + element(2) * element(10);
  const yz = element(4) * element(8) + element(5) * element(9) + element(6) * element(10);
  if (
    !(
      Math.abs(xy) <= ORTHOGONAL_TOLERANCE * x * y &&
      Math.abs(xz) <= ORTHOGONAL_TOLERANCE * x * z &&
      Math.abs(yz) <= ORTHOGONAL_TOLERANCE * y * z
    )
  ) {
    fail(`anchor:${node.name} does not support shear`);
  }
}

/** Check every node from the scene root down to `node`, each once across `checked`. */
function checkPath(node: THREE.Object3D, local: THREE.Matrix4, checked: Set<THREE.Object3D>): void {
  const chain: THREE.Object3D[] = [];
  for (let current: THREE.Object3D | null = node; current; current = current.parent) {
    chain.unshift(current);
  }
  for (const current of chain) {
    requireAnchor(
      current.matrixWorldAutoUpdate,
      `anchor:${current.name} has a manual matrixWorld override`,
    );
    if (checked.has(current)) continue;
    checked.add(current);
    checkTransform(current, readLocalMatrix(current, local));
  }
}

function isRootOrDescendant(root: THREE.Object3D, node: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = node; current; current = current.parent) {
    if (current === root) return true;
  }
  return false;
}

/**
 * A spring root's skinned-point attachment, as declared: the spec checked, its bones resolved,
 * and the transforms its paths and subtree stand on verified. The placement is the core's.
 *
 * Bone skinning only. The spec names bones and bind-space positions rather than
 * a mesh vertex, so there is no morph data to read: a shape key that moves the
 * skin under the point is not followed, and the root sits where the skeleton
 * alone puts the skin.
 */
export class SkinPointAnchor {
  readonly root: THREE.Bone;
  readonly influences: readonly ResolvedInfluence[];

  constructor(
    root: THREE.Bone,
    spec: SkinPointAnchorSpec,
    bonesByName: ReadonlyMap<string, readonly THREE.Bone[]>,
  ) {
    requireAnchor(root.parent, `anchor:${root.name} requires a parent`);
    requireAnchor(root.matrixAutoUpdate, `anchor:${root.name} requires matrixAutoUpdate`);
    requireAnchor(
      root.matrixWorldAutoUpdate,
      `anchor:${root.name} has a manual matrixWorld override`,
    );
    requireAnchor(isRecord(spec) && Array.isArray(spec.influences), 'anchor requires influences');
    requireAnchor(
      spec.influences.length >= 1 && spec.influences.length <= 4,
      'anchor requires 1–4 influences',
    );

    const names = new Set<string>();
    const checked = new Set<THREE.Object3D>();
    const local = new THREE.Matrix4().identity();
    const resolved: ResolvedInfluence[] = [];
    let sum = 0;
    let positiveCount = 0;
    for (const [index, value] of spec.influences.entries()) {
      requireAnchor(isRecord(value), `anchor influence ${index} must be an object`);
      const { bone, weight, position } = value;
      requireAnchor(
        typeof bone === 'string' && bone.length > 0,
        `anchor influence ${index} needs a bone name`,
      );
      requireAnchor(!names.has(bone), `anchor has duplicate influence bone ${bone}`);
      names.add(bone);
      requireAnchor(
        typeof weight === 'number' && Number.isFinite(weight) && weight >= 0,
        `anchor weight is invalid: ${bone}`,
      );
      requireAnchor(
        Array.isArray(position) &&
          position.length === 3 &&
          position.every(
            (coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate),
          ),
        `anchor position is invalid: ${bone}`,
      );
      const matches = bonesByName.get(normaliseBoneName(bone)) ?? [];
      requireAnchor(matches.length === 1, `anchor source bone must resolve uniquely: ${bone}`);
      const source = matches[0];
      requireAnchor(source, `anchor source bone must resolve uniquely: ${bone}`);
      requireAnchor(
        !isRootOrDescendant(root, source),
        `anchor source cannot be root or descendant: ${bone}`,
      );
      checkPath(source, local, checked);
      resolved.push({
        bone: source,
        weight,
        position: new THREE.Vector3(position[0], position[1], position[2]),
      });
      if (weight > 0) {
        positiveCount++;
        sum += weight;
      }
    }
    requireAnchor(
      positiveCount >= 1 && positiveCount <= 4,
      'anchor requires 1–4 positive influences',
    );
    requireAnchor(
      Math.abs(sum - 1) <= WEIGHT_SUM_TOLERANCE,
      `anchor weights must sum to one: ${sum}`,
    );
    this.root = root;
    this.influences = resolved;
    checkPath(root.parent, local, checked);
    checkTransform(root, readLocalMatrix(root, local));
    this.#checkSubtree(root, local);
  }

  #checkSubtree(node: THREE.Object3D, local: THREE.Matrix4): void {
    for (const child of node.children) {
      requireAnchor(
        child.matrixWorldAutoUpdate,
        `anchor:${child.name} has a manual matrixWorld override`,
      );
      checkTransform(child, readLocalMatrix(child, local));
      this.#checkSubtree(child, local);
    }
  }
}
