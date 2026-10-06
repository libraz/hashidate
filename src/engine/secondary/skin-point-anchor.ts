import * as THREE from 'three';
import type { SkinPointAnchorSpec } from '../types';

const WEIGHT_SUM_TOLERANCE = 1e-5;
const MANUAL_MATRIX_SCALE_TOLERANCE = 2e-7;
const UNIFORM_SCALE_TOLERANCE = 1e-5;
const ORTHOGONAL_TOLERANCE = 1e-6;

interface MatrixPath {
  nodes: THREE.Object3D[];
  transforms: TransformGuard[];
}

type TransformGuard =
  | { matrixAutoUpdate: true; scale: [number, number, number] }
  | { matrixAutoUpdate: false; scale: number; sign: number };

interface ResolvedInfluence {
  bone: THREE.Bone;
  weight: number;
  position: THREE.Vector3;
  path: MatrixPath;
}

export interface SkinPointAnchorDiagnostics {
  targetWorld: [number, number, number];
  rootWorld: [number, number, number];
  error: number;
}

function requireAnchor(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLocalMatrix(node: THREE.Object3D, out: THREE.Matrix4): THREE.Matrix4 {
  if (node.matrixAutoUpdate) return out.compose(node.position, node.quaternion, node.scale);
  return out.copy(node.matrix);
}

/** Validate affine, nearly uniform, orthogonal scale and return its magnitude/sign. */
function transformScale(node: THREE.Object3D, matrix: THREE.Matrix4): [number, number] {
  const e = matrix.elements;
  const element = (index: number): number => e[index] ?? Number.NaN;
  requireAnchor(
    e.every(Number.isFinite) &&
      Math.abs(element(3)) <= 1e-8 &&
      Math.abs(element(7)) <= 1e-8 &&
      Math.abs(element(11)) <= 1e-8 &&
      Math.abs(element(15) - 1) <= 1e-8,
    `anchor:${node.name} requires a finite affine local transform`,
  );
  const x = Math.hypot(element(0), element(1), element(2));
  const y = Math.hypot(element(4), element(5), element(6));
  const z = Math.hypot(element(8), element(9), element(10));
  const maximum = Math.max(x, y, z);
  requireAnchor(maximum > 1e-12, `anchor:${node.name} has a singular local transform`);
  requireAnchor(
    Math.abs(x - y) <= UNIFORM_SCALE_TOLERANCE * maximum &&
      Math.abs(x - z) <= UNIFORM_SCALE_TOLERANCE * maximum,
    `anchor:${node.name} does not support nonuniform scale`,
  );
  const xy = element(0) * element(4) + element(1) * element(5) + element(2) * element(6);
  const xz = element(0) * element(8) + element(1) * element(9) + element(2) * element(10);
  const yz = element(4) * element(8) + element(5) * element(9) + element(6) * element(10);
  requireAnchor(
    Math.abs(xy) <= ORTHOGONAL_TOLERANCE * x * y &&
      Math.abs(xz) <= ORTHOGONAL_TOLERANCE * x * z &&
      Math.abs(yz) <= ORTHOGONAL_TOLERANCE * y * z,
    `anchor:${node.name} does not support shear`,
  );
  return [(x + y + z) / 3, Math.sign(matrix.determinant())];
}

function snapshotTransform(node: THREE.Object3D, matrix: THREE.Matrix4): TransformGuard {
  const [scale, sign] = transformScale(node, matrix);
  if (node.matrixAutoUpdate) {
    return { matrixAutoUpdate: true, scale: [node.scale.x, node.scale.y, node.scale.z] };
  }
  return { matrixAutoUpdate: false, scale, sign };
}

function assertTransformStable(
  node: THREE.Object3D,
  matrix: THREE.Matrix4,
  expected: TransformGuard,
): void {
  requireAnchor(
    node.matrixAutoUpdate === expected.matrixAutoUpdate,
    `anchor:${node.name} transform mode changed after resolution`,
  );
  const [scale, sign] = transformScale(node, matrix);
  if (expected.matrixAutoUpdate) {
    // A changing quaternion can perturb composed column lengths by Float32
    // roundoff. The Object3D TRS scale itself is the immutable contract.
    requireAnchor(
      node.scale.x === expected.scale[0] &&
        node.scale.y === expected.scale[1] &&
        node.scale.z === expected.scale[2],
      `anchor:${node.name} scale changed after resolution`,
    );
    return;
  }
  requireAnchor(
    Math.abs(scale - expected.scale) <=
      MANUAL_MATRIX_SCALE_TOLERANCE * Math.max(1, expected.scale) && sign === expected.sign,
    `anchor:${node.name} scale changed after resolution`,
  );
}

function matrixPath(node: THREE.Object3D, local: THREE.Matrix4): MatrixPath {
  const nodes: THREE.Object3D[] = [];
  for (let current: THREE.Object3D | null = node; current; current = current.parent) {
    nodes.unshift(current);
  }
  const transforms: TransformGuard[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const current = nodes[i];
    requireAnchor(current, 'anchor path contains a missing node');
    requireAnchor(
      current.matrixWorldAutoUpdate,
      `anchor:${current.name} has a manual matrixWorld override`,
    );
    readLocalMatrix(current, local);
    transforms.push(snapshotTransform(current, local));
  }
  return { nodes, transforms };
}

function isRootOrDescendant(root: THREE.Object3D, node: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = node; current; current = current.parent) {
    if (current === root) return true;
  }
  return false;
}

/**
 * Translate one spring root to a weighted, skinned point without refreshing any
 * source Object3D matrices. All source transforms are composed in private scratch.
 */
export class SkinPointAnchor {
  readonly root: THREE.Bone;
  readonly influences: readonly ResolvedInfluence[];
  readonly targetWorld = new THREE.Vector3();
  readonly rootWorld = new THREE.Vector3();
  error = 0;

  readonly #parentPath: MatrixPath;
  readonly #subtreeTransforms = new Map<THREE.Object3D, TransformGuard>();
  readonly #local = new THREE.Matrix4();
  readonly #world = new THREE.Matrix4();
  readonly #parentWorld = new THREE.Matrix4();
  readonly #inverseParent = new THREE.Matrix4();
  readonly #rootMatrix = new THREE.Matrix4();
  readonly #point = new THREE.Vector3();
  readonly #rootTransform: TransformGuard;

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
    const resolved: ResolvedInfluence[] = [];
    let sum = 0;
    let positiveCount = 0;
    this.#local.identity();
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
      const matches = bonesByName.get(bone) ?? [];
      requireAnchor(matches.length === 1, `anchor source bone must resolve uniquely: ${bone}`);
      const source = matches[0];
      requireAnchor(source, `anchor source bone must resolve uniquely: ${bone}`);
      requireAnchor(
        !isRootOrDescendant(root, source),
        `anchor source cannot be root or descendant: ${bone}`,
      );
      const path = matrixPath(source, this.#local);
      const record: ResolvedInfluence = {
        bone: source,
        weight,
        position: new THREE.Vector3(position[0], position[1], position[2]),
        path,
      };
      resolved.push(record);
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
    this.#parentPath = matrixPath(root.parent, this.#local);
    this.#rootTransform = snapshotTransform(root, readLocalMatrix(root, this.#local));
    this.#readSubtreeTransforms(root);
  }

  get diagnostics(): SkinPointAnchorDiagnostics {
    return {
      targetWorld: this.targetWorld.toArray() as [number, number, number],
      rootWorld: this.rootWorld.toArray() as [number, number, number],
      error: this.error,
    };
  }

  #readSubtreeTransforms(node: THREE.Object3D): void {
    for (const child of node.children) {
      requireAnchor(
        child.matrixWorldAutoUpdate,
        `anchor:${child.name} has a manual matrixWorld override`,
      );
      const transform = snapshotTransform(child, readLocalMatrix(child, this.#local));
      this.#subtreeTransforms.set(child, transform);
      this.#readSubtreeTransforms(child);
    }
  }

  #walk(
    path: MatrixPath,
    out: THREE.Matrix4,
    inputs: ReadonlyMap<THREE.Object3D, THREE.Matrix4> | undefined,
  ): THREE.Matrix4 {
    out.identity();
    // Compose from the deepest node given a world matrix, guarding the whole path.
    let start = 0;
    if (inputs) {
      for (let i = path.nodes.length - 1; i >= 0; i--) {
        const world = inputs.get(path.nodes[i]);
        if (world) {
          out.copy(world);
          start = i + 1;
          break;
        }
      }
    }
    for (let i = 0; i < path.nodes.length; i++) {
      const node = path.nodes[i];
      const expected = path.transforms[i];
      requireAnchor(node && expected, 'anchor path changed after resolution');
      if (i > 0) {
        requireAnchor(
          node.parent === path.nodes[i - 1],
          `anchor path was reparented at ${node.name}`,
        );
      } else {
        requireAnchor(node.parent === null, `anchor path root was reparented at ${node.name}`);
      }
      requireAnchor(
        node.matrixWorldAutoUpdate,
        `anchor:${node.name} has a manual matrixWorld override`,
      );
      readLocalMatrix(node, this.#local);
      assertTransformStable(node, this.#local, expected);
      if (i >= start) out.multiply(this.#local);
    }
    return out;
  }

  #refreshSubtree(node: THREE.Object3D): void {
    for (const child of node.children) {
      const expected = this.#subtreeTransforms.get(child);
      requireAnchor(expected, `anchor subtree changed at ${child.name}`);
      requireAnchor(
        child.matrixWorldAutoUpdate,
        `anchor:${child.name} has a manual matrixWorld override`,
      );
      if (child.matrixAutoUpdate) child.updateMatrix();
      assertTransformStable(child, child.matrix, expected);
      requireAnchor(child.parent === node, `anchor subtree was reparented at ${child.name}`);
      child.matrixWorld.multiplyMatrices(node.matrixWorld, child.matrix);
      child.matrixWorldNeedsUpdate = false;
      this.#refreshSubtree(child);
    }
  }

  /**
   * @param inputs  world matrices standing in for nodes no chain moves, so a
   *                step between two frames composes from the body between them
   */
  place(inputs?: ReadonlyMap<THREE.Object3D, THREE.Matrix4>): void {
    requireAnchor(
      this.root.parent === this.#parentPath.nodes.at(-1),
      `anchor root was reparented at ${this.root.name}`,
    );
    requireAnchor(
      this.root.matrixWorldAutoUpdate,
      `anchor:${this.root.name} has a manual matrixWorld override`,
    );
    this.targetWorld.set(0, 0, 0);
    for (const influence of this.influences) {
      if (influence.weight === 0) continue;
      this.#walk(influence.path, this.#world, inputs);
      this.#point.copy(influence.position).applyMatrix4(this.#world);
      this.targetWorld.addScaledVector(this.#point, influence.weight);
    }

    this.#walk(this.#parentPath, this.#parentWorld, inputs);
    const determinant = this.#parentWorld.determinant();
    requireAnchor(
      Number.isFinite(determinant) && Math.abs(determinant) > 1e-18,
      'anchor parent world is singular',
    );
    this.#inverseParent.copy(this.#parentWorld).invert();
    this.root.position.copy(this.targetWorld).applyMatrix4(this.#inverseParent);
    assertTransformStable(this.root, readLocalMatrix(this.root, this.#local), this.#rootTransform);
    this.root.updateMatrix();
    this.#rootMatrix.multiplyMatrices(this.#parentWorld, this.root.matrix);
    this.root.matrixWorld.copy(this.#rootMatrix);
    this.root.matrixWorldNeedsUpdate = false;
    this.#refreshSubtree(this.root);
    this.rootWorld.setFromMatrixPosition(this.#rootMatrix);
    this.error = this.rootWorld.distanceTo(this.targetWorld);
  }
}
