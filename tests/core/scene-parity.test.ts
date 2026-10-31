import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { allocating, core } from '@/core';
import { NO_NODE, SceneGraph } from '@/core/scene';
import { WASM_PATH } from '../../tools/rust-core/build';

const MASK = (1n << 64n) - 1n;
const TREES = 1_000;
const MAX_NODES = 300;
const OPS = 40;

/** Uniform in [0, 1). */
function splitmix64(seed: bigint): () => number {
  let state = seed & MASK;
  return () => {
    state = (state + 0x9e37_79b9_7f4a_7c15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK;
    z ^= z >> 31n;
    return Number(z >> 11n) / 2 ** 53;
  };
}

/** A coordinate, with signed and unsigned zero over-represented. */
function value(u: number): number {
  if (u < 0.03) return -0;
  if (u < 0.06) return 0;
  return ((u - 0.06) / 0.94) * 6 - 3;
}

const GEOMETRY = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
  return g;
})();

const ORDERS: THREE.EulerOrder[] = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];

interface World {
  /** The root's ancestors as built, nearest first; the root may since have moved among them. */
  ancestors: THREE.Object3D[];
  root: THREE.Object3D;
  /** Table nodes in creation order. */
  nodes: THREE.Object3D[];
  skeletons: THREE.Skeleton[];
  leaves: THREE.Mesh[];
}

function randomTransform(o: THREE.Object3D, r: () => number): void {
  o.position.set(value(r()), value(r()), value(r()));
  if (r() < 0.5) o.rotation.set(value(r()), value(r()), value(r()), ORDERS[Math.floor(r() * 6)]);
  else o.quaternion.set(value(r()), value(r()), value(r()), value(r())).normalize();
  const s = r();
  if (s < 0.1) o.scale.set(-1, 1, value(r()));
  else if (s < 0.4) o.scale.setScalar(0.5 + r());
  else if (s < 0.5) o.scale.set(0.5 + r(), 0.5 + r(), 0.5 + r());
  if (r() < 0.08) o.matrixAutoUpdate = false;
  if (r() < 0.08) o.matrixWorldAutoUpdate = false;
  if (r() < 0.08) o.pivot = new THREE.Vector3(value(r()), value(r()), value(r()));
}

function randomMatrix(r: () => number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(value(r()), value(r()), value(r())),
    new THREE.Quaternion(value(r()), value(r()), value(r()), value(r())).normalize(),
    new THREE.Vector3(0.5 + r(), 0.5 + r(), 0.5 + r()),
  );
}

function makeNode(r: () => number): THREE.Object3D {
  const k = r();
  if (k < 0.4) return new THREE.Bone();
  if (k < 0.6) return new THREE.Object3D();
  if (k < 0.65) return new THREE.Group();
  if (k < 0.75) return new THREE.Mesh(GEOMETRY);
  const mesh = new THREE.SkinnedMesh(GEOMETRY);
  if (r() < 0.4) mesh.bindMode = THREE.DetachedBindMode;
  return mesh;
}

/** An outline-shaped leaf: a childless skinned mesh sharing its parent's skeleton, or a mesh. */
function makeLeaf(parent: THREE.Object3D, r: () => number): THREE.Mesh {
  const owner = parent as THREE.SkinnedMesh;
  if (owner.isSkinnedMesh && owner.skeleton && r() < 0.8) {
    const leaf = new THREE.SkinnedMesh(GEOMETRY);
    leaf.bind(owner.skeleton, owner.bindMatrix);
    return leaf;
  }
  const leaf = new THREE.Mesh(GEOMETRY);
  if (r() < 0.5) randomTransform(leaf, r);
  return leaf;
}

/** Builds the same tree for the same seed. */
function build(seed: bigint): World {
  const r = splitmix64(seed);
  const count = 1 + Math.floor(r() * MAX_NODES);
  const nodes: THREE.Object3D[] = [];
  for (let i = 0; i < count; i++) {
    const node = makeNode(r);
    node.name = `n${i}`;
    randomTransform(node, r);
    if (i > 0) {
      const back = Math.floor(r() * Math.min(i, 4));
      const parent = r() < 0.6 ? nodes[i - 1 - back] : nodes[Math.floor(r() * i)];
      parent.add(node);
    }
    nodes.push(node);
  }
  const root = nodes[0];
  const ancestors: THREE.Object3D[] = [];
  const levels = r() < 0.35 ? 0 : 1 + Math.floor(r() * 3);
  let below = root;
  for (let k = 0; k < levels; k++) {
    const a = new THREE.Group();
    a.name = `a${k}`;
    randomTransform(a, r);
    a.add(below);
    ancestors.push(a);
    below = a;
  }
  if (r() < 0.6) below.updateMatrixWorld(true);

  const bones = nodes.filter((n) => (n as THREE.Bone).isBone) as THREE.Bone[];
  const skeletons: THREE.Skeleton[] = [];
  const skeletonCount = Math.floor(r() * 4);
  for (let s = 0; s < skeletonCount; s++) {
    const slots: THREE.Bone[] = [];
    const size = Math.floor(r() * Math.min(24, bones.length + 1));
    for (let b = 0; b < size; b++) {
      slots.push(
        r() < 0.05 ? (undefined as unknown as THREE.Bone) : bones[Math.floor(r() * bones.length)],
      );
    }
    skeletons.push(new THREE.Skeleton(slots));
  }
  for (const node of nodes) {
    const mesh = node as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh && skeletons.length > 0 && r() < 0.9) {
      mesh.bind(skeletons[Math.floor(r() * skeletons.length)], randomMatrix(r));
    }
  }
  if (r() < 0.5) randomTransform(root, r);
  return { ancestors, root, nodes, skeletons, leaves: [] };
}

function addLeaves(w: World, r: () => number, n: number): void {
  for (let k = 0; k < n; k++) {
    const parent = w.nodes[Math.floor(r() * w.nodes.length)];
    const leaf = makeLeaf(parent, r);
    leaf.name = `leaf${w.leaves.length}`;
    parent.add(leaf);
    w.leaves.push(leaf);
  }
}

const MATRIX_FIELDS = ['matrix', 'matrixWorld'] as const;

function diffNode(a: THREE.Object3D, b: THREE.Object3D, where: string): string | null {
  const vectors: Array<[string, number[], number[]]> = [
    [
      'position',
      [a.position.x, a.position.y, a.position.z],
      [b.position.x, b.position.y, b.position.z],
    ],
    [
      'quaternion',
      [a.quaternion.x, a.quaternion.y, a.quaternion.z, a.quaternion.w],
      [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
    ],
    ['scale', [a.scale.x, a.scale.y, a.scale.z], [b.scale.x, b.scale.y, b.scale.z]],
  ];
  for (const [field, x, y] of vectors) {
    for (let k = 0; k < x.length; k++) {
      if (!Object.is(x[k], y[k])) return `${where}.${field}[${k}]: ${x[k]} vs ${y[k]}`;
    }
  }
  const matrices: Array<[string, ArrayLike<number>, ArrayLike<number>]> = MATRIX_FIELDS.map((f) => [
    f,
    a[f].elements,
    b[f].elements,
  ]);
  if ((a as THREE.SkinnedMesh).isSkinnedMesh) {
    const [sa, sb] = [a as THREE.SkinnedMesh, b as THREE.SkinnedMesh];
    matrices.push([
      'bindMatrixInverse',
      sa.bindMatrixInverse.elements,
      sb.bindMatrixInverse.elements,
    ]);
  }
  for (const [field, x, y] of matrices) {
    for (let k = 0; k < 16; k++) {
      if (!Object.is(x[k], y[k])) return `${where}.${field}[${k}]: ${x[k]} vs ${y[k]}`;
    }
  }
  if (a.matrixWorldNeedsUpdate !== b.matrixWorldNeedsUpdate) {
    return `${where}.matrixWorldNeedsUpdate: ${a.matrixWorldNeedsUpdate} vs ${b.matrixWorldNeedsUpdate}`;
  }
  return null;
}

function flatten(root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((n) => {
    out.push(n);
  });
  return out;
}

/** The first difference between the plain world `a` and the core-backed world `b`, or null. */
function diffWorld(a: World, b: World): string | null {
  for (const [k, anc] of a.ancestors.entries()) {
    const d = diffNode(anc, b.ancestors[k], anc.name);
    if (d) return d;
  }
  const na = flatten(a.root);
  const nb = flatten(b.root);
  if (na.length !== nb.length) return `node count: ${na.length} vs ${nb.length}`;
  for (let i = 0; i < na.length; i++) {
    if (na[i].name !== nb[i].name) return `traverse ${i}: ${na[i].name} vs ${nb[i].name}`;
    const d = diffNode(na[i], nb[i], na[i].name);
    if (d) return d;
  }
  for (const [s, skeleton] of a.skeletons.entries()) {
    const x = skeleton.boneMatrices as Float32Array;
    const y = b.skeletons[s].boneMatrices as Float32Array;
    if (x.length !== y.length) return `skeleton ${s} boneMatrices length`;
    for (let k = 0; k < x.length; k++) {
      if (!Object.is(x[k], y[k])) return `skeleton ${s}.boneMatrices[${k}]: ${x[k]} vs ${y[k]}`;
    }
  }
  return null;
}

function diffValues(a: unknown[], b: unknown[]): string | null {
  if (a.length !== b.length) return `result length ${a.length} vs ${b.length}`;
  for (let k = 0; k < a.length; k++) {
    if (!Object.is(a[k], b[k])) return `result[${k}]: ${String(a[k])} vs ${String(b[k])}`;
  }
  return null;
}

const pick = <T>(list: readonly T[], u: number): T => list[Math.floor(u * list.length)];

/** Every node in `node`'s subtree, plain leaves included. */
function subtree(node: THREE.Object3D): THREE.Object3D[] {
  return flatten(node);
}

type Op = (w: World, p: number[]) => unknown[];

/** The S3 operations. Each reads its parameters from `p` and returns what it read. */
const OPERATIONS: Array<[string, Op]> = [
  [
    'position.set',
    (w, p) => {
      pick(w.nodes, p[0]).position.set(value(p[1]), value(p[2]), value(p[3]));
      return [];
    },
  ],
  [
    'copy',
    (w, p) => {
      const node = pick(w.nodes, p[0]);
      node.scale.copy(new THREE.Vector3(0.5 + p[1], 0.5 + p[2], value(p[3])));
      node.quaternion.copy(
        new THREE.Quaternion(value(p[4]), value(p[5]), value(p[6]), p[7]).normalize(),
      );
      const { x, y, z, order } = node.rotation;
      return [x, y, z, order];
    },
  ],
  [
    'three methods',
    (w, p) => {
      const node = pick(w.nodes, p[0]);
      node.translateOnAxis(new THREE.Vector3(p[1], p[2], p[3]).normalize(), value(p[4]));
      node.applyQuaternion(new THREE.Quaternion(p[5], p[6], p[7], p[8]).normalize());
      node.position.addScaledVector(new THREE.Vector3(1, 2, 3), value(p[9]));
      node.scale.multiplyScalar(0.5 + p[10]);
      return [node.rotation.x, node.rotation.y, node.rotation.z];
    },
  ],
  [
    'rotation.set then quaternion',
    (w, p) => {
      const node = pick(w.nodes, p[0]);
      node.rotation.set(value(p[1]), value(p[2]), value(p[3]), pick(ORDERS, p[4]));
      const q = node.quaternion;
      return [q.x, q.y, q.z, q.w];
    },
  ],
  [
    'quaternion.set then rotation',
    (w, p) => {
      const node = pick(w.nodes, p[0]);
      const q = new THREE.Quaternion(value(p[1]), value(p[2]), value(p[3]), p[4]).normalize();
      node.quaternion.set(q.x, q.y, q.z, q.w);
      const { x, y, z, order } = node.rotation;
      return [x, y, z, order];
    },
  ],
  [
    'updateWorldMatrix(true, false) under a leaf holder',
    (w, p) => {
      const holder = w.leaves.length > 0 ? (pick(w.leaves, p[0]).parent as THREE.Object3D) : w.root;
      const node = pick(subtree(holder), p[1]);
      node.updateWorldMatrix(true, false);
      return [node.name];
    },
  ],
  [
    'ancestor TRS',
    (w, p) => {
      if (w.ancestors.length === 0) return [];
      const a = pick(w.ancestors, p[0]);
      a.position.set(value(p[1]), value(p[2]), value(p[3]));
      a.rotation.set(value(p[4]), value(p[5]), value(p[6]));
      return [];
    },
  ],
  [
    'updateMatrix',
    (w, p) => {
      pick(w.nodes, p[0]).updateMatrix();
      return [];
    },
  ],
  [
    'updateMatrixWorld',
    (w, p) => {
      const top = w.ancestors.at(-1);
      const node = top && p[1] < 0.2 ? top : pick(w.nodes, p[0]);
      node.updateMatrixWorld(p[2] < 0.5);
      return [];
    },
  ],
  [
    'updateWorldMatrix',
    (w, p) => {
      const pool = p[1] < 0.15 && w.leaves.length > 0 ? w.leaves : w.nodes;
      const node =
        pool === w.nodes && p[1] < 0.3 && w.ancestors.length > 0
          ? pick(w.ancestors, p[0])
          : pick(pool, p[0]);
      node.updateWorldMatrix(p[2] < 0.5, p[3] < 0.5, p[4] < 0.5);
      return [];
    },
  ],
  [
    'getWorld*',
    (w, p) => {
      const node = pick(p[1] < 0.15 && w.leaves.length > 0 ? w.leaves : w.nodes, p[0]);
      const at = node.getWorldPosition(new THREE.Vector3());
      const q = pick(w.nodes, p[2]).getWorldQuaternion(new THREE.Quaternion());
      const s = pick(w.nodes, p[3]).getWorldScale(new THREE.Vector3());
      return [at.x, at.y, at.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z];
    },
  ],
  [
    'clone equals toArray fromArray',
    (w, p) => {
      const node = pick(w.nodes, p[0]);
      const v = node.position.clone();
      const q = node.quaternion.clone();
      const out: unknown[] = [v.constructor === THREE.Vector3, q.constructor === THREE.Quaternion];
      out.push(v.x, v.y, v.z, q.x, q.y, q.z, q.w, v.isVector3, q.isQuaternion);
      out.push(node.position.equals(v), node.quaternion.equals(q), q.equals(node.quaternion));
      out.push(
        ...node.quaternion.toArray(),
        ...node.scale.toArray(),
        ...node.matrixWorld.toArray(),
      );
      node.scale.fromArray([0.5 + p[1], 0.5 + p[2], 0.5 + p[3]]);
      node.quaternion.fromArray(new THREE.Quaternion(p[4], p[5], p[6], p[7]).normalize().toArray());
      out.push(node.rotation.x, node.rotation.y, node.rotation.z);
      return out;
    },
  ],
  [
    'applyMatrix4',
    (w, p) => {
      const node = pick(w.nodes, p[0]);
      node.applyMatrix4(randomMatrix(splitmix64(BigInt(Math.floor(p[1] * 2 ** 32)))));
      return [node.rotation.x];
    },
  ],
  [
    'rotateOnAxis',
    (w, p) => {
      const node = pick(w.nodes, p[0]);
      node.rotateOnAxis(new THREE.Vector3(p[1], p[2], p[3]).normalize(), value(p[4]));
      return [node.rotation.x, node.rotation.y, node.rotation.z];
    },
  ],
  [
    'rotation read and write',
    (w, p) => {
      const node = pick(w.nodes, p[0]);
      node.rotation.y = value(p[1]);
      node.rotation.x += value(p[2]);
      return [node.rotation.x, node.rotation.y, node.rotation.z, node.quaternion.w];
    },
  ],
  [
    'Skeleton.update',
    (w, p) => {
      for (const [s, skeleton] of w.skeletons.entries()) {
        if (p[s] < 0.1 && skeleton.boneTexture === null) skeleton.computeBoneTexture();
        skeleton.update();
      }
      return [];
    },
  ],
  [
    'add a plain leaf',
    (w, p) => {
      addLeaves(w, splitmix64(BigInt(Math.floor(p[0] * 2 ** 32))), 1);
      return [];
    },
  ],
  [
    'remove a plain leaf',
    (w, p) => {
      if (w.leaves.length === 0) return [];
      const k = Math.floor(p[0] * w.leaves.length);
      w.leaves[k].removeFromParent();
      w.leaves.splice(k, 1);
      return [];
    },
  ],
  [
    'reparent the root',
    (w, p) => {
      if (w.ancestors.length === 0) return [];
      if (p[0] < 0.25) w.root.removeFromParent();
      else pick(w.ancestors, p[1]).add(w.root);
      return [];
    },
  ],
];

const SKELETON_UPDATE = OPERATIONS.findIndex(([name]) => name === 'Skeleton.update');

interface Pair {
  plain: World;
  backed: World;
  graph: SceneGraph;
}

function pair(seed: bigint): Pair {
  const plain = build(seed);
  const backed = build(seed);
  const graph = SceneGraph.of(backed.root);
  const r = splitmix64(seed ^ 0x5eedn);
  const leaves = r() < 0.5 ? 0 : 1 + Math.floor(r() * 3);
  addLeaves(plain, splitmix64(seed ^ 0x1eafn), leaves);
  addLeaves(backed, splitmix64(seed ^ 0x1eafn), leaves);
  return { plain, backed, graph };
}

function apply(t: Pair, name: string, op: Op, p: number[]): string | null {
  const before = core().memory.buffer;
  const a = op(t.plain, p);
  const b = op(t.backed, p);
  if (core().memory.buffer !== before) return `${name}: memory.buffer changed`;
  return diffValues(a, b) ?? diffWorld(t.plain, t.backed);
}

/** Starts the core-backed copy over from its current values, as a dispose and rebuild does. */
function roundTrip(t: Pair): string | null {
  t.graph.dispose();
  const d = diffWorld(t.plain, t.backed);
  if (d) return `after dispose: ${d}`;
  t.graph = SceneGraph.of(t.backed.root);
  // The leaves are table nodes now, on both sides as far as the operations go.
  t.plain.leaves.length = 0;
  t.backed.leaves.length = 0;
  return null;
}

function seedOf(tree: number): bigint {
  return 0x7363_656e_6500_0000n + BigInt(tree);
}

describe('core-backed scene graph', () => {
  it('matches plain three on random trees under every operation', () => {
    const held: number[] = [];
    let grew = 0;
    let previous: Pair | null = null;
    try {
      for (let tree = 0; tree < TREES; tree++) {
        // Unrelated growth while the previous tree is still backed: its views must follow.
        if (tree % 50 === 25 && previous) {
          const buffer = core().memory.buffer;
          held.push(allocating(() => core().hd_alloc(1 << 21)));
          if (core().memory.buffer !== buffer) grew++;
          const d = apply(previous, 'after growth', OPERATIONS[SKELETON_UPDATE][1], [0, 0, 0, 0]);
          expect(d, `tree ${tree - 1} after memory growth`).toBeNull();
        }
        previous?.graph.dispose();
        const t = pair(seedOf(tree));
        let d = diffWorld(t.plain, t.backed);
        expect(d, `tree ${tree} as built`).toBeNull();
        const r = splitmix64(seedOf(tree) ^ 0x0bad_cafen);
        for (let k = 0; k < OPS; k++) {
          const u = r();
          if (u < 0.03) {
            d = roundTrip(t);
            expect(d, `tree ${tree} op ${k} dispose round trip`).toBeNull();
            continue;
          }
          const [name, op] = pick(OPERATIONS, (u - 0.03) / 0.97);
          const p = Array.from({ length: 12 }, r);
          d = apply(t, name, op, p);
          expect(d, `tree ${tree} op ${k} ${name}`).toBeNull();
        }
        previous = t;
      }
      previous?.graph.dispose();
      expect(grew).toBeGreaterThan(0);
    } finally {
      for (const ptr of held) core().hd_free(ptr, 1 << 21);
    }
  });

  it('reports a single flipped bit in the core', () => {
    const t = pair(seedOf(3));
    t.plain.root.updateMatrixWorld(true);
    t.backed.root.updateMatrixWorld(true);
    expect(diffWorld(t.plain, t.backed)).toBeNull();
    const e = t.backed.nodes.at(-1)?.matrixWorld.elements as unknown as Float64Array;
    const bits = new BigUint64Array(e.buffer, e.byteOffset + 8 * 13, 1);
    bits[0] ^= 1n;
    expect(diffWorld(t.plain, t.backed)).toMatch(/matrixWorld\[13\]/);
    t.graph.dispose();
  });

  it('fixes the hierarchy except for plain leaves and the root parent', () => {
    const t = pair(seedOf(11));
    const node = t.backed.nodes[0];
    const graph = SceneGraph.of(t.backed.root);
    expect(graph).toBe(t.graph);
    expect(() => node.add(new THREE.Bone())).toThrow();
    expect(() => node.add(new THREE.Object3D())).toThrow();
    const parentMesh = new THREE.Mesh(GEOMETRY);
    parentMesh.add(new THREE.Object3D());
    expect(() => node.add(parentMesh)).toThrow();
    expect(() => node.attach(new THREE.Group())).toThrow();
    const child = t.backed.nodes.find((n) => n.parent === node);
    if (child) {
      expect(() => node.remove(child)).toThrow();
      expect(() => new THREE.Group().attach(child)).toThrow();
    }
    const leaf = new THREE.Mesh(GEOMETRY);
    node.attach(leaf);
    expect(leaf.parent).toBe(node);
    leaf.removeFromParent();
    expect(node.children).not.toContain(leaf);
    const outer = new THREE.Group();
    outer.add(t.backed.root);
    expect(t.backed.root.parent).toBe(outer);
    expect(graph.indexOf(t.backed.root)).toBe(0);
    expect(graph.indexOf(outer)).toBe(NO_NODE);
    expect(graph.indexOf(leaf)).toBe(NO_NODE);
    graph.dispose();
  });

  it('refuses a node with its own matrix update, but takes a skinned mesh', () => {
    const root = new THREE.Group();
    root.add(new THREE.PerspectiveCamera());
    expect(() => SceneGraph.of(root)).toThrow(/own matrix update/);
    const skinned = new THREE.Group();
    skinned.add(new THREE.SkinnedMesh(GEOMETRY));
    SceneGraph.of(skinned).dispose();
  });

  it('throws on views left stale by growth outside allocating', () => {
    const t = pair(seedOf(5));
    const buffer = core().memory.buffer;
    const ptr = core().hd_alloc(64 << 20);
    try {
      expect(core().memory.buffer).not.toBe(buffer);
      expect(() => t.backed.root.updateMatrixWorld(true)).toThrow(/stale/);
      allocating(() => 0);
      t.plain.root.updateMatrixWorld(true);
      t.backed.root.updateMatrixWorld(true);
      expect(diffWorld(t.plain, t.backed)).toBeNull();
    } finally {
      core().hd_free(ptr, 64 << 20);
      t.graph.dispose();
    }
  });
  it('fixes the update flags, the pivot and bindMode at SceneGraph.of', () => {
    const t = pair(seedOf(17));
    for (const node of t.backed.nodes) {
      expect(() => {
        node.matrixAutoUpdate = !node.matrixAutoUpdate;
      }).toThrow(TypeError);
      expect(() => {
        node.matrixWorldAutoUpdate = !node.matrixWorldAutoUpdate;
      }).toThrow(TypeError);
      expect(() => {
        node.pivot = node.pivot === null ? new THREE.Vector3() : null;
      }).toThrow(TypeError);
      const mesh = node as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) {
        expect(() => {
          mesh.bindMode = THREE.DetachedBindMode;
        }).toThrow(TypeError);
      }
    }
    // A pivot's coordinates are the core's, and stay writable.
    const k = t.backed.nodes.findIndex((n) => n.pivot !== null);
    expect(k).toBeGreaterThanOrEqual(0);
    for (const w of [t.plain, t.backed]) {
      w.nodes[k].pivot?.set(0.25, -0.5, 1);
      w.root.updateMatrixWorld(true);
    }
    expect(diffWorld(t.plain, t.backed)).toBeNull();
    t.graph.dispose();
    for (const node of t.backed.nodes) {
      node.matrixAutoUpdate = !node.matrixAutoUpdate;
      node.matrixWorldAutoUpdate = !node.matrixWorldAutoUpdate;
      node.pivot = null;
    }
  });

  it('leaves core-backed nodes in V8 fast mode', () => {
    const url = (path: string) => new URL(path, import.meta.url).href;
    // `%HasFastProperties` needs a process started with --allow-natives-syntax.
    const script = `
      import { readFile } from 'node:fs/promises';
      import * as THREE from 'three';
      import { initCore } from ${JSON.stringify(url('../../src/core/index.ts'))};
      import { SceneGraph } from ${JSON.stringify(url('../../src/core/scene.ts'))};
      await initCore(() => readFile(${JSON.stringify(WASM_PATH)}));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
      const root = new THREE.Group();
      const bones = [new THREE.Bone(), new THREE.Bone(), new THREE.Bone()];
      root.add(bones[0]);
      bones[0].add(bones[1], bones[2]);
      bones[1].pivot = new THREE.Vector3(0, 1, 0);
      bones[2].matrixAutoUpdate = false;
      const attached = new THREE.SkinnedMesh(geometry);
      const detached = new THREE.SkinnedMesh(geometry);
      detached.bindMode = THREE.DetachedBindMode;
      root.add(attached, detached, new THREE.Mesh(geometry), new THREE.Object3D());
      for (const mesh of [attached, detached]) mesh.bind(new THREE.Skeleton(bones));
      new THREE.Group().add(root);
      const fast = new Function('o', 'return %HasFastProperties(o)');
      const nodes = [];
      root.traverse((n) => nodes.push(n));
      const graph = SceneGraph.of(root);
      root.updateMatrixWorld(true);
      bones[1].updateMatrix();
      bones[2].getWorldPosition(new THREE.Vector3());
      attached.skeleton.update();
      const slow = nodes.filter((n) => !fast(n)).map((n) => n.type);
      graph.dispose();
      // The check can fail: an accessor on the instance is what turns a node slow.
      const control = new THREE.Bone();
      Object.defineProperty(control, 'matrixAutoUpdate', { get: () => true });
      process.stdout.write(JSON.stringify({ nodes: nodes.length, slow, control: fast(control) }));
    `;
    const out = execFileSync(
      process.execPath,
      ['--allow-natives-syntax', '--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' },
    );
    expect(JSON.parse(out)).toEqual({ nodes: 8, slow: [], control: false });
  });
});
