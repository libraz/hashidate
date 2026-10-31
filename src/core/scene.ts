/**
 * Core-backed three nodes: an avatar root's subtree whose transforms live in the core's scene graph.
 *
 * `SceneGraph.of(root)` registers every node under `root` with `hd_scene_*` and then rewires each
 * one in place: `position`, `quaternion` and `scale` become objects whose fields are accessors over
 * the core's f64 buffers, the matrices' `elements` become subviews of them, and the three update
 * methods call the core instead of recursing in JS. Everything else on the node stays three's, so
 * the renderer and the TS engine read the same objects as before.
 *
 * No accessor goes on a node itself: it would put the node in V8's dictionary mode and slow every
 * property read three's renderer makes on it. So `matrixAutoUpdate`, `matrixWorldAutoUpdate`,
 * `pivot` and `bindMode` become read-only data holding their value at `SceneGraph.of` (a write
 * throws; a pivot's x, y, z stay writable), and `matrixWorldNeedsUpdate` stays a plain field that
 * each call assigns on the nodes the core reports changed. A JS write to it does not reach the core.
 *
 * The hierarchy is fixed from that call on. The root may change parents, and a childless non-bone
 * `Mesh` (an outline) may be added and removed as a plain leaf that three keeps updating; any other
 * `add`, `attach` or `remove` throws. The root's ancestors stay plain three objects, mirrored into
 * the core before each call and written back after it.
 *
 * Writes the core makes do not reach `rotation`; JS writes keep it in step as three does.
 * Exports that may grow the memory go through `allocating`, which rebinds every view.
 */

import * as THREE from 'three';
import {
  ANCESTOR,
  FLAG_BONE,
  FLAG_DETACHED,
  FLAG_MATRIX_AUTO_UPDATE,
  FLAG_MATRIX_WORLD_AUTO_UPDATE,
  FLAG_MATRIX_WORLD_NEEDS_UPDATE,
  FLAG_PIVOT,
  FLAG_SKINNED,
  FORCE_TRUE,
  FORCE_UNVISITED,
  LAYOUT,
  LAYOUT_ANCESTOR_FLAGS,
  LAYOUT_ANCESTORS,
  LAYOUT_BIND_MATRIX,
  LAYOUT_BIND_MATRIX_INVERSE,
  LAYOUT_BONE_INVERSES,
  LAYOUT_BONE_MATRICES,
  LAYOUT_FLAGS,
  LAYOUT_FORCE,
  LAYOUT_MATRIX,
  LAYOUT_MATRIX_WORLD,
  LAYOUT_NEEDS_CHANGED,
  LAYOUT_PIVOT,
  LAYOUT_POSITION,
  LAYOUT_QUATERNION,
  LAYOUT_SCALE,
  LAYOUT_SCRATCH,
  MAX_ANCESTORS,
  MESH_BIND,
  MESH_BIND_INVERSE,
  NO_NODE,
  RECORD_MATRIX,
  RECORD_MATRIX_WORLD,
  RECORD_PIVOT,
  RECORD_POSITION,
  RECORD_QUATERNION,
  RECORD_SCALE,
} from './abi/scene';
import { allocating, core, handleFinalizer, onMemoryGrow } from './index';

export { NO_NODE };

/** Which three call the plain leaves repeat after a pass. */
export type PlainReplay = 'none' | 'matrixWorld' | 'worldMatrix';

let heapBuffer: ArrayBufferLike | null = null;
let f64 = new Float64Array(0);
let f32 = new Float32Array(0);
let u32 = new Uint32Array(0);
let u8 = new Uint8Array(0);

function rebindHeap(): void {
  const { buffer } = core().memory;
  if (buffer === heapBuffer) return;
  heapBuffer = buffer;
  f64 = new Float64Array(buffer);
  f32 = new Float32Array(buffer);
  u32 = new Uint32Array(buffer);
  u8 = new Uint8Array(buffer);
}

/** An f64 index into the heap. */
interface Slot {
  readonly coreAt: number;
}

function slotAccessor(k: number): PropertyDescriptor {
  return {
    get(this: Slot) {
      return f64[this.coreAt + k];
    },
    set(this: Slot, v: number) {
      f64[this.coreAt + k] = v;
    },
  };
}

// `clone` reaches three's own constructor through the prototype chain, so it returns a plain object.
const CORE_VECTOR3: object = Object.create(THREE.Vector3.prototype, {
  x: slotAccessor(0),
  y: slotAccessor(1),
  z: slotAccessor(2),
});

// three's own field names, which every Quaternion method reads and writes.
const QUATERNION_FIELDS: PropertyDescriptorMap = { isQuaternion: { value: true } };
for (const [k, name] of ['_x', '_y', '_z', '_w'].entries())
  QUATERNION_FIELDS[name] = slotAccessor(k);
const CORE_QUATERNION: object = Object.create(THREE.Quaternion.prototype, QUATERNION_FIELDS);

/** A `Vector3` whose x, y, z are accessors onto the core's f64 heap from index `o`. */
export function coreVector3(o: number): THREE.Vector3 {
  return Object.create(CORE_VECTOR3, { coreAt: { value: o } });
}

function coreQuaternion(o: number): THREE.Quaternion {
  return Object.create(CORE_QUATERNION, { coreAt: { value: o } });
}

const BOUND = Symbol('hashidate.core-backed');

interface NodeBinding {
  readonly graph: SceneGraph;
  readonly index: number;
}

interface SkeletonBinding {
  readonly graph: SceneGraph;
  readonly index: number;
  /** f32 index of the first bone matrix, and the count of floats. */
  readonly start: number;
  readonly length: number;
}

type BoundNode = THREE.Object3D & { [BOUND]: NodeBinding };
type BoundSkeleton = THREE.Skeleton & { [BOUND]: SkeletonBinding };

function bindingOf(node: THREE.Object3D): NodeBinding | undefined {
  return (node as Partial<BoundNode>)[BOUND];
}

const OVERRIDDEN = [
  'updateMatrix',
  'updateMatrixWorld',
  'updateWorldMatrix',
  'add',
  'remove',
  'attach',
];

/** What may be added under a core-backed node: an outline-shaped mesh outside every table. */
function isPlainLeaf(object: THREE.Object3D | undefined): object is THREE.Mesh {
  return (
    object !== undefined &&
    (object as THREE.Mesh).isMesh === true &&
    (object as Partial<THREE.Bone>).isBone !== true &&
    object.children.length === 0 &&
    bindingOf(object) === undefined
  );
}

function sameClassUpdates(node: THREE.Object3D): boolean {
  const proto = Object.getPrototypeOf(node) as THREE.Object3D;
  const base = THREE.Object3D.prototype;
  const matrixWorld = (node as Partial<THREE.SkinnedMesh>).isSkinnedMesh
    ? THREE.SkinnedMesh.prototype.updateMatrixWorld
    : base.updateMatrixWorld;
  return (
    proto.updateMatrixWorld === matrixWorld && proto.updateWorldMatrix === base.updateWorldMatrix
  );
}

function writeTrs(at: number, node: THREE.Object3D): void {
  const { position: p, quaternion: q, scale: s, pivot } = node;
  f64[at + RECORD_POSITION] = p.x;
  f64[at + RECORD_POSITION + 1] = p.y;
  f64[at + RECORD_POSITION + 2] = p.z;
  f64[at + RECORD_QUATERNION] = q.x;
  f64[at + RECORD_QUATERNION + 1] = q.y;
  f64[at + RECORD_QUATERNION + 2] = q.z;
  f64[at + RECORD_QUATERNION + 3] = q.w;
  f64[at + RECORD_SCALE] = s.x;
  f64[at + RECORD_SCALE + 1] = s.y;
  f64[at + RECORD_SCALE + 2] = s.z;
  if (pivot !== null) {
    f64[at + RECORD_PIVOT] = pivot.x;
    f64[at + RECORD_PIVOT + 1] = pivot.y;
    f64[at + RECORD_PIVOT + 2] = pivot.z;
  }
  f64.set(node.matrix.elements, at + RECORD_MATRIX);
  f64.set(node.matrixWorld.elements, at + RECORD_MATRIX_WORLD);
}

function flagsOf(node: THREE.Object3D): number {
  return (
    (node.matrixAutoUpdate ? FLAG_MATRIX_AUTO_UPDATE : 0) |
    (node.matrixWorldAutoUpdate === true ? FLAG_MATRIX_WORLD_AUTO_UPDATE : 0) |
    (node.matrixWorldNeedsUpdate ? FLAG_MATRIX_WORLD_NEEDS_UPDATE : 0) |
    (node.pivot !== null ? FLAG_PIVOT : 0)
  );
}

function syncRotation(node: THREE.Object3D, q: THREE.Quaternion): void {
  const { rotation } = node;
  rotation._onChange(() => q.setFromEuler(rotation, false));
  q._onChange(() => rotation.setFromQuaternion(q, undefined, false));
}

function elements(at: number): THREE.Matrix4Tuple {
  return f64.subarray(at, at + 16) as unknown as THREE.Matrix4Tuple;
}

function plainElements(m: THREE.Matrix4): void {
  m.elements = Array.from(m.elements) as THREE.Matrix4Tuple;
}

const graphs = new WeakMap<THREE.Object3D, SceneGraph>();
const live = new Set<WeakRef<SceneGraph>>();
const finalizer = handleFinalizer((c, h) => c.hd_scene_free_orphan(h));

// Filled by the class's static block, which alone reaches its private members.
let METHODS: PropertyDescriptorMap = {};
let skeletonUpdate: (this: THREE.Skeleton) => void;

/** The core's scene graph for one avatar root, and the three nodes it backs. */
export class SceneGraph {
  readonly root: THREE.Object3D;
  readonly #nodes: THREE.Object3D[];
  readonly #meshes: THREE.SkinnedMesh[];
  readonly #skeletons: THREE.Skeleton[];
  /** f64 indices of each buffer, byte indices for the u8 ones, f32 for the bone matrices. */
  readonly #at: Uint32Array;
  readonly #ref: WeakRef<SceneGraph>;
  #handle: number;
  #ancestors = 0;
  readonly #chain: THREE.Object3D[] = [];
  /** Nodes that have plain leaves among their children. */
  readonly #plainParents = new Set<number>();

  /**
   * The graph for `root`, created on the first call. That call fixes the hierarchy: from then on
   * only plain leaves and the root's own parent may change.
   */
  static of(root: THREE.Object3D): SceneGraph {
    let graph = graphs.get(root);
    if (!graph) {
      graph = new SceneGraph(root);
      graphs.set(root, graph);
    }
    return graph;
  }

  /** The graph for `root` if one was created and not yet disposed; never creates one. */
  static existing(root: THREE.Object3D): SceneGraph | undefined {
    return graphs.get(root);
  }

  private constructor(root: THREE.Object3D) {
    const nodes: THREE.Object3D[] = [];
    root.traverse((node) => {
      nodes.push(node);
    });
    const indices = new Map<THREE.Object3D, number>();
    const meshes: THREE.SkinnedMesh[] = [];
    const skeletons: THREE.Skeleton[] = [];
    let bones = 0;
    for (const [i, node] of nodes.entries()) {
      if (bindingOf(node))
        throw new Error(`SceneGraph: ${node.name || node.type} is already core-backed`);
      if (!sameClassUpdates(node)) {
        throw new Error(
          `SceneGraph: ${node.type} has its own matrix update and cannot be core-backed`,
        );
      }
      indices.set(node, i);
      const mesh = node as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) continue;
      meshes.push(mesh);
      if (mesh.skeleton && !skeletons.includes(mesh.skeleton)) {
        skeletons.push(mesh.skeleton);
        bones += mesh.skeleton.bones.length;
      }
    }

    const c = core();
    const [n, m, s] = [nodes.length, meshes.length, skeletons.length];
    const h = allocating(() => c.hd_scene_new(n, m, s, bones));
    rebindHeap();
    const addresses = new Uint32Array(f64.buffer, c.hd_scene_layout(h), LAYOUT);
    const at = new Uint32Array(LAYOUT);
    for (let k = 0; k < LAYOUT; k++) at[k] = addresses[k] / 8;
    at[LAYOUT_FLAGS] = addresses[LAYOUT_FLAGS];
    at[LAYOUT_FORCE] = addresses[LAYOUT_FORCE];
    at[LAYOUT_ANCESTOR_FLAGS] = addresses[LAYOUT_ANCESTOR_FLAGS];
    at[LAYOUT_NEEDS_CHANGED] = addresses[LAYOUT_NEEDS_CHANGED] / 4;
    at[LAYOUT_BONE_MATRICES] = addresses[LAYOUT_BONE_MATRICES] / 4;
    const scratch = at[LAYOUT_SCRATCH];

    for (const [i, node] of nodes.entries()) {
      const mesh = node as THREE.SkinnedMesh;
      const flags =
        flagsOf(node) |
        ((node as Partial<THREE.Bone>).isBone ? FLAG_BONE : 0) |
        (mesh.isSkinnedMesh ? FLAG_SKINNED : 0) |
        (mesh.isSkinnedMesh && mesh.bindMode === THREE.DetachedBindMode ? FLAG_DETACHED : 0);
      writeTrs(scratch, node);
      const parent = i === 0 ? NO_NODE : (indices.get(node.parent as THREE.Object3D) as number);
      allocating(() => c.hd_scene_node(h, parent, flags));
    }
    for (const mesh of meshes) {
      f64.set(mesh.bindMatrix.elements, scratch + MESH_BIND);
      f64.set(mesh.bindMatrixInverse.elements, scratch + MESH_BIND_INVERSE);
      c.hd_scene_mesh(h, indices.get(mesh) as number);
    }
    for (const skeleton of skeletons) {
      c.hd_scene_skeleton(h);
      for (const [i, bone] of skeleton.bones.entries()) {
        f64.set(skeleton.boneInverses[i].elements, scratch);
        c.hd_scene_bone(h, (bone && indices.get(bone)) ?? NO_NODE);
      }
    }
    allocating(() => c.hd_scene_build(h));

    this.root = root;
    this.#nodes = nodes;
    this.#meshes = meshes;
    this.#skeletons = skeletons;
    this.#at = at;
    this.#handle = h;
    this.#ref = new WeakRef(this);
    for (const [i, node] of nodes.entries()) this.#back(node, i);
    let slot = 0;
    for (const [s, skeleton] of skeletons.entries()) {
      const length = 16 * skeleton.bones.length;
      const binding: SkeletonBinding = {
        graph: this,
        index: s,
        start: at[LAYOUT_BONE_MATRICES] + 16 * slot,
        length,
      };
      Object.defineProperty(skeleton, BOUND, { configurable: true, value: binding });
      Object.defineProperty(skeleton, 'update', {
        configurable: true,
        writable: true,
        value: skeletonUpdate,
      });
      slot += skeleton.bones.length;
    }
    this.#rebind();
    live.add(this.#ref);
    finalizer.register(root, h, this);
  }

  /** The `hd_scene_*` handle, for the core handles that read this graph. */
  get handle(): number {
    return this.#handle;
  }

  /** The node's index in the core's table, or `NO_NODE` for a node outside it. */
  indexOf(node: THREE.Object3D): number {
    const binding = bindingOf(node);
    return binding?.graph === this ? binding.index : NO_NODE;
  }

  /** The skeleton's index in the core's table, or `NO_NODE` for a skeleton outside it. */
  skeletonIndexOf(skeleton: THREE.Skeleton): number {
    const binding = (skeleton as Partial<BoundSkeleton>)[BOUND];
    return binding?.graph === this ? binding.index : NO_NODE;
  }

  /**
   * Runs a core call that may update nodes: checks the views, mirrors the root's ancestors in,
   * writes them back after, and repeats the pass on the plain leaves as `replay` says.
   */
  run<T>(fn: (h: number) => T, replay: PlainReplay = 'none'): T {
    this.#check();
    this.#mirror();
    const result = fn(this.#handle);
    this.#takeNeedsChanged();
    this.#writeBack();
    if (replay !== 'none') this.#replay(replay === 'matrixWorld');
    return result;
  }

  /**
   * Hands every node back to three with its current values, keeping plain leaves as plain
   * children, and frees the core's graph. The core traps if a handle made on it is still alive.
   */
  dispose(): void {
    if (this.#handle === 0) return;
    this.#check();
    for (const node of this.#nodes) this.#release(node);
    for (const skeleton of this.#skeletons) {
      for (const inverse of skeleton.boneInverses) plainElements(inverse);
      delete (skeleton as Partial<BoundSkeleton>)[BOUND];
      delete (skeleton as Partial<THREE.Skeleton>).update;
    }
    const h = this.#handle;
    this.#handle = 0;
    finalizer.unregister(this);
    live.delete(this.#ref);
    graphs.delete(this.root);
    allocating(() => core().hd_scene_free(h));
  }

  /** Points every matrix view at the current heap. */
  #rebind(): void {
    const at = this.#at;
    for (const [i, node] of this.#nodes.entries()) {
      node.matrix.elements = elements(at[LAYOUT_MATRIX] + 16 * i);
      node.matrixWorld.elements = elements(at[LAYOUT_MATRIX_WORLD] + 16 * i);
    }
    for (const [m, mesh] of this.#meshes.entries()) {
      mesh.bindMatrix.elements = elements(at[LAYOUT_BIND_MATRIX] + 16 * m);
      mesh.bindMatrixInverse.elements = elements(at[LAYOUT_BIND_MATRIX_INVERSE] + 16 * m);
    }
    let slot = 0;
    for (const skeleton of this.#skeletons) {
      for (const inverse of skeleton.boneInverses) {
        inverse.elements = elements(at[LAYOUT_BONE_INVERSES] + 16 * slot++);
      }
    }
  }

  #check(): void {
    if (this.#handle === 0) throw new Error('SceneGraph: used after dispose()');
    if (heapBuffer !== core().memory.buffer) {
      throw new Error('SceneGraph: core memory grew outside allocating(); its views are stale');
    }
  }

  #back(node: THREE.Object3D, i: number): void {
    const at = this.#at;
    const binding: NodeBinding = { graph: this, index: i };
    Object.defineProperty(node, BOUND, { configurable: true, value: binding });
    const q = coreQuaternion(at[LAYOUT_QUATERNION] + 4 * i);
    // Data in place of three's data, so the node keeps its fast shape.
    const fixed: PropertyDescriptorMap = {
      matrixAutoUpdate: { writable: false, value: node.matrixAutoUpdate },
      matrixWorldAutoUpdate: { writable: false, value: node.matrixWorldAutoUpdate },
      pivot: {
        writable: false,
        value: node.pivot === null ? null : coreVector3(at[LAYOUT_PIVOT] + 3 * i),
      },
    };
    if ((node as Partial<THREE.SkinnedMesh>).isSkinnedMesh) {
      fixed.bindMode = { writable: false, value: (node as THREE.SkinnedMesh).bindMode };
    }
    Object.defineProperties(node, {
      position: {
        configurable: true,
        enumerable: true,
        value: coreVector3(at[LAYOUT_POSITION] + 3 * i),
      },
      quaternion: { configurable: true, enumerable: true, value: q },
      scale: { configurable: true, enumerable: true, value: coreVector3(at[LAYOUT_SCALE] + 3 * i) },
      ...fixed,
      ...METHODS,
    });
    syncRotation(node, q);
  }

  #release(node: THREE.Object3D): void {
    const { x, y, z, w } = node.quaternion;
    const q = new THREE.Quaternion(x, y, z, w);
    const pivot = node.pivot;
    const mesh = node as THREE.SkinnedMesh;
    const data: Record<string, unknown> = {
      matrixAutoUpdate: node.matrixAutoUpdate,
      matrixWorldAutoUpdate: node.matrixWorldAutoUpdate,
      matrixWorldNeedsUpdate: node.matrixWorldNeedsUpdate,
      pivot: pivot && new THREE.Vector3(pivot.x, pivot.y, pivot.z),
    };
    if (mesh.isSkinnedMesh) {
      data.bindMode = mesh.bindMode;
      plainElements(mesh.bindMatrix);
      plainElements(mesh.bindMatrixInverse);
    }
    const descriptors: PropertyDescriptorMap = {
      position: { configurable: true, enumerable: true, value: node.position.clone() },
      quaternion: { configurable: true, enumerable: true, value: q },
      scale: { configurable: true, enumerable: true, value: node.scale.clone() },
    };
    for (const [key, value] of Object.entries(data)) {
      descriptors[key] = { configurable: true, enumerable: true, writable: true, value };
    }
    plainElements(node.matrix);
    plainElements(node.matrixWorld);
    Object.defineProperties(node, descriptors);
    for (const key of OVERRIDDEN) delete (node as unknown as Record<string, unknown>)[key];
    delete (node as Partial<BoundNode>)[BOUND];
    syncRotation(node, q);
  }

  #mirror(): void {
    const at = this.#at[LAYOUT_ANCESTORS];
    const flagsAt = this.#at[LAYOUT_ANCESTOR_FLAGS];
    let count = 0;
    for (let a = this.root.parent; a !== null; a = a.parent) {
      if (count === MAX_ANCESTORS)
        throw new Error(`SceneGraph: more than ${MAX_ANCESTORS} ancestors`);
      writeTrs(at + ANCESTOR * count, a);
      u8[flagsAt + count] = flagsOf(a);
      this.#chain[count++] = a;
    }
    this.#chain.length = count;
    if (count !== this.#ancestors) {
      core().hd_scene_ancestors(this.#handle, count);
      this.#ancestors = count;
    }
  }

  /** Assigns `matrixWorldNeedsUpdate` on the nodes whose value the last call changed. */
  #takeNeedsChanged(): void {
    const at = this.#at[LAYOUT_NEEDS_CHANGED];
    if (u32[at] === 0) return;
    const count = core().hd_scene_take_needs_changed(this.#handle);
    const flagsAt = this.#at[LAYOUT_FLAGS];
    for (let k = 1; k <= count; k++) {
      const i = u32[at + k];
      this.#nodes[i].matrixWorldNeedsUpdate =
        (u8[flagsAt + i] & FLAG_MATRIX_WORLD_NEEDS_UPDATE) !== 0;
    }
  }

  #writeBack(): void {
    const at = this.#at[LAYOUT_ANCESTORS];
    const flagsAt = this.#at[LAYOUT_ANCESTOR_FLAGS];
    for (const [k, a] of this.#chain.entries()) {
      const record = at + ANCESTOR * k;
      const matrix = a.matrix.elements;
      const world = a.matrixWorld.elements;
      for (let e = 0; e < 16; e++) {
        matrix[e] = f64[record + RECORD_MATRIX + e];
        world[e] = f64[record + RECORD_MATRIX_WORLD + e];
      }
      a.matrixWorldNeedsUpdate = (u8[flagsAt + k] & FLAG_MATRIX_WORLD_NEEDS_UPDATE) !== 0;
    }
  }

  #replay(matrixWorld: boolean): void {
    const forceAt = this.#at[LAYOUT_FORCE];
    for (const i of this.#plainParents) {
      const byte = u8[forceAt + i];
      if (byte === FORCE_UNVISITED) continue;
      const force = byte === FORCE_TRUE;
      for (const child of this.#nodes[i].children) {
        if (bindingOf(child)) continue;
        if (matrixWorld) child.updateMatrixWorld(force);
        else child.updateWorldMatrix(false, true, force);
      }
    }
  }

  #notePlain(node: THREE.Object3D, i: number): void {
    const has = node.children.some((child) => !bindingOf(child));
    if (has === this.#plainParents.has(i)) return;
    if (has) this.#plainParents.add(i);
    else this.#plainParents.delete(i);
    core().hd_scene_plain_children(this.#handle, i, has ? 1 : 0);
  }

  static {
    onMemoryGrow(() => {
      rebindHeap();
      for (const ref of live) {
        const graph = ref.deref();
        if (graph) graph.#rebind();
        else live.delete(ref);
      }
    });

    const base = THREE.Object3D.prototype;
    const binding = (node: THREE.Object3D) => (node as BoundNode)[BOUND];

    function add(this: THREE.Object3D, ...objects: THREE.Object3D[]): THREE.Object3D {
      if (objects.length > 1) {
        for (const object of objects) this.add(object);
        return this;
      }
      const object = objects[0];
      if (!isPlainLeaf(object)) {
        throw new Error('SceneGraph: only a childless mesh may be added under a core-backed node');
      }
      // three's `add`, step for step.
      object.removeFromParent();
      object.parent = this;
      this.children.push(object);
      object.dispatchEvent({ type: 'added' });
      this.dispatchEvent({ type: 'childadded', child: object });
      const b = binding(this);
      b.graph.#notePlain(this, b.index);
      return this;
    }

    function remove(this: THREE.Object3D, ...objects: THREE.Object3D[]): THREE.Object3D {
      if (objects.length > 1) {
        for (const object of objects) this.remove(object);
        return this;
      }
      const object = objects[0];
      const index = this.children.indexOf(object);
      if (index === -1) return this;
      if (bindingOf(object)) {
        throw new Error('SceneGraph: a core-backed node cannot leave its hierarchy');
      }
      object.parent = null;
      this.children.splice(index, 1);
      object.dispatchEvent({ type: 'removed' });
      this.dispatchEvent({ type: 'childremoved', child: object });
      const b = binding(this);
      b.graph.#notePlain(this, b.index);
      return this;
    }

    function attach(this: THREE.Object3D, object: THREE.Object3D): THREE.Object3D {
      if (!isPlainLeaf(object)) {
        throw new Error('SceneGraph: only a childless mesh may be attached to a core-backed node');
      }
      base.attach.call(this, object);
      const b = binding(this);
      b.graph.#notePlain(this, b.index);
      return this;
    }

    function updateMatrix(this: THREE.Object3D): void {
      const b = binding(this);
      // It reads only the node's own transform, so the ancestors need no mirror.
      b.graph.#check();
      core().hd_scene_update_matrix(b.graph.#handle, b.index);
      b.graph.#takeNeedsChanged();
    }

    function updateMatrixWorld(this: THREE.Object3D, force?: boolean): void {
      const { graph, index } = binding(this);
      const c = core();
      graph.run((h) => c.hd_scene_update_matrix_world(h, index, force ? 1 : 0), 'matrixWorld');
    }

    function updateWorldMatrix(
      this: THREE.Object3D,
      updateParents: boolean,
      updateChildren: boolean,
      force = false,
    ): void {
      const { graph, index } = binding(this);
      const c = core();
      const parents = updateParents === true ? 1 : 0;
      const children = updateChildren === true ? 1 : 0;
      graph.run(
        (h) => c.hd_scene_update_world_matrix(h, index, parents, children, force ? 1 : 0),
        children ? 'worldMatrix' : 'none',
      );
    }

    skeletonUpdate = function update(this: THREE.Skeleton): void {
      const b = (this as BoundSkeleton)[BOUND];
      b.graph.#check();
      core().hd_scene_skeleton_update(b.graph.#handle, b.index);
      // `computeBoneTexture` replaces `boneMatrices`, so it is read on every call.
      this.boneMatrices?.set(f32.subarray(b.start, b.start + b.length));
      if (this.boneTexture !== null) this.boneTexture.needsUpdate = true;
    };

    const method = (value: unknown): PropertyDescriptor => ({
      configurable: true,
      writable: true,
      value,
    });
    METHODS = {
      updateMatrix: method(updateMatrix),
      updateMatrixWorld: method(updateMatrixWorld),
      updateWorldMatrix: method(updateWorldMatrix),
      add: method(add),
      remove: method(remove),
      attach: method(attach),
    };
  }
}
