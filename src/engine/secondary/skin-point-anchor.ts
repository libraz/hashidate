import * as THREE from 'three';
import { normaliseBoneName } from '../profile/candidates';
import type { SkinPointAnchorSpec } from '../types';

const WEIGHT_SUM_TOLERANCE = 1e-5;
const MANUAL_MATRIX_SCALE_TOLERANCE = 2e-7;
const UNIFORM_SCALE_TOLERANCE = 1e-5;
const ORTHOGONAL_TOLERANCE = 1e-6;

/** One node on a matrix path, shared by every path of an anchor that passes through it. */
interface PathNode {
  readonly node: THREE.Object3D;
  readonly transform: TransformGuard;
  /** The node's local matrix as last read; see `passed`. */
  readonly local: THREE.Matrix4;
  /** Position, quaternion and scale `local` was composed from and passed the guard with. */
  readonly passed: Float64Array;
  hasPassed: boolean;
  /** The placement that last guarded this node; see `SkinPointAnchor#walk`. */
  guarded: number;
  /** The path's product down to this node in placement `formed`, starting after `from`. */
  readonly world: THREE.Matrix4;
  formed: number;
  from: PathNode | null;
}

/**
 * Whether `entry.local` still stands for the node: a composed local matrix and
 * its guard depend on nothing else, so the same values compose and pass the same.
 * Only values that passed are kept, and a NaN never passes, so `Object.is` cannot
 * match one; it also tells the two zeros apart, as composing does.
 */
function stillPassed(entry: PathNode): boolean {
  const { node, passed } = entry;
  if (!(entry.hasPassed && node.matrixAutoUpdate)) return false;
  const { position: p, quaternion: q, scale: k } = node;
  return (
    Object.is(p.x, passed[0]) &&
    Object.is(p.y, passed[1]) &&
    Object.is(p.z, passed[2]) &&
    Object.is(q.x, passed[3]) &&
    Object.is(q.y, passed[4]) &&
    Object.is(q.z, passed[5]) &&
    Object.is(q.w, passed[6]) &&
    Object.is(k.x, passed[7]) &&
    Object.is(k.y, passed[8]) &&
    Object.is(k.z, passed[9])
  );
}

function rememberPassed(entry: PathNode): void {
  const { node, passed } = entry;
  entry.hasPassed = node.matrixAutoUpdate;
  if (!entry.hasPassed) return;
  node.position.toArray(passed, 0);
  node.quaternion.toArray(passed, 3);
  node.scale.toArray(passed, 7);
}

interface MatrixPath {
  nodes: PathNode[];
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

/** The same failure for a guard run on every placement, whose message is only built when it trips. */
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

/** Validate affine, nearly uniform, orthogonal scale and return its magnitude. */
function transformScale(node: THREE.Object3D, matrix: THREE.Matrix4): number {
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
  const x = Math.hypot(element(0), element(1), element(2));
  const y = Math.hypot(element(4), element(5), element(6));
  const z = Math.hypot(element(8), element(9), element(10));
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
  return (x + y + z) / 3;
}

function snapshotTransform(node: THREE.Object3D, matrix: THREE.Matrix4): TransformGuard {
  const scale = transformScale(node, matrix);
  if (node.matrixAutoUpdate) {
    return { matrixAutoUpdate: true, scale: [node.scale.x, node.scale.y, node.scale.z] };
  }
  return { matrixAutoUpdate: false, scale, sign: Math.sign(matrix.determinant()) };
}

function assertTransformStable(
  node: THREE.Object3D,
  matrix: THREE.Matrix4,
  expected: TransformGuard,
): void {
  if (node.matrixAutoUpdate !== expected.matrixAutoUpdate) {
    fail(`anchor:${node.name} transform mode changed after resolution`);
  }
  const scale = transformScale(node, matrix);
  if (expected.matrixAutoUpdate) {
    // A changing quaternion can perturb composed column lengths by Float32
    // roundoff. The Object3D TRS scale itself is the immutable contract.
    if (
      !(
        node.scale.x === expected.scale[0] &&
        node.scale.y === expected.scale[1] &&
        node.scale.z === expected.scale[2]
      )
    ) {
      fail(`anchor:${node.name} scale changed after resolution`);
    }
    return;
  }
  if (
    !(
      Math.abs(scale - expected.scale) <=
        MANUAL_MATRIX_SCALE_TOLERANCE * Math.max(1, expected.scale) &&
      Math.sign(matrix.determinant()) === expected.sign
    )
  ) {
    fail(`anchor:${node.name} scale changed after resolution`);
  }
}

function matrixPath(
  node: THREE.Object3D,
  local: THREE.Matrix4,
  shared: Map<THREE.Object3D, PathNode>,
): MatrixPath {
  const chain: THREE.Object3D[] = [];
  for (let current: THREE.Object3D | null = node; current; current = current.parent) {
    chain.unshift(current);
  }
  const nodes: PathNode[] = [];
  for (let i = 0; i < chain.length; i++) {
    const current = chain[i];
    requireAnchor(current, 'anchor path contains a missing node');
    requireAnchor(
      current.matrixWorldAutoUpdate,
      `anchor:${current.name} has a manual matrixWorld override`,
    );
    let entry = shared.get(current);
    if (!entry) {
      readLocalMatrix(current, local);
      entry = {
        node: current,
        transform: snapshotTransform(current, local),
        local: new THREE.Matrix4(),
        passed: new Float64Array(10),
        hasPassed: false,
        guarded: -1,
        world: new THREE.Matrix4(),
        formed: -1,
        from: null,
      };
      shared.set(current, entry);
    }
    nodes.push(entry);
  }
  return { nodes };
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
 *
 * Bone skinning only. The spec names bones and bind-space positions rather than
 * a mesh vertex, so there is no morph data to read: a shape key that moves the
 * skin under the point is not followed, and the root sits where the skeleton
 * alone puts the skin.
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
  /** Counts placements, so a path node shared by several paths is handled once in each. */
  #placement = 0;

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
    const shared = new Map<THREE.Object3D, PathNode>();
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
      const matches = bonesByName.get(normaliseBoneName(bone)) ?? [];
      requireAnchor(matches.length === 1, `anchor source bone must resolve uniquely: ${bone}`);
      const source = matches[0];
      requireAnchor(source, `anchor source bone must resolve uniquely: ${bone}`);
      requireAnchor(
        !isRootOrDescendant(root, source),
        `anchor source cannot be root or descendant: ${bone}`,
      );
      const path = matrixPath(source, this.#local, shared);
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
    this.#parentPath = matrixPath(root.parent, this.#local, shared);
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
        const world = inputs.get(path.nodes[i].node);
        if (world) {
          out.copy(world);
          start = i + 1;
          break;
        }
      }
    }
    const from = start > 0 ? path.nodes[start - 1] : null;
    const placement = this.#placement;
    for (let i = 0; i < path.nodes.length; i++) {
      const entry = path.nodes[i];
      // Nothing a placement does moves a path node, so one guarded by an earlier
      // path of this placement passes again, and a product formed from the same
      // start comes out the same.
      if (entry.guarded === placement) {
        if (i >= start) this.#extend(entry, out, from, placement);
        continue;
      }
      const node = entry.node;
      requireAnchor(node && entry.transform, 'anchor path changed after resolution');
      if (i > 0) {
        if (node.parent !== path.nodes[i - 1].node) {
          fail(`anchor path was reparented at ${node.name}`);
        }
      } else if (node.parent !== null) {
        fail(`anchor path root was reparented at ${node.name}`);
      }
      if (!node.matrixWorldAutoUpdate) {
        fail(`anchor:${node.name} has a manual matrixWorld override`);
      }
      // A node shared by several paths, or one nothing has moved since the last
      // placement, is read and guarded once.
      if (!(entry.transform.matrixAutoUpdate && stillPassed(entry))) {
        readLocalMatrix(node, entry.local);
        assertTransformStable(node, entry.local, entry.transform);
        rememberPassed(entry);
      }
      entry.guarded = placement;
      if (i >= start) this.#extend(entry, out, from, placement);
    }
    return out;
  }

  /** Carry `out` through `entry`'s local matrix, or take the product already formed there. */
  #extend(entry: PathNode, out: THREE.Matrix4, from: PathNode | null, placement: number): void {
    if (entry.formed === placement && entry.from === from) {
      out.copy(entry.world);
      return;
    }
    out.multiply(entry.local);
    entry.world.copy(out);
    entry.formed = placement;
    entry.from = from;
  }

  #refreshSubtree(node: THREE.Object3D): void {
    for (const child of node.children) {
      const expected = this.#subtreeTransforms.get(child);
      if (!expected) fail(`anchor subtree changed at ${child.name}`);
      if (!child.matrixWorldAutoUpdate) {
        fail(`anchor:${child.name} has a manual matrixWorld override`);
      }
      if (child.matrixAutoUpdate) child.updateMatrix();
      assertTransformStable(child, child.matrix, expected);
      if (child.parent !== node) fail(`anchor subtree was reparented at ${child.name}`);
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
    this.#placement++;
    if (this.root.parent !== this.#parentPath.nodes.at(-1)?.node) {
      fail(`anchor root was reparented at ${this.root.name}`);
    }
    if (!this.root.matrixWorldAutoUpdate) {
      fail(`anchor:${this.root.name} has a manual matrixWorld override`);
    }
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
