import {
  type BufferAttribute,
  type Camera,
  InterleavedBufferAttribute,
  type Mesh,
  SkinnedMesh,
  type TypedArray,
  Vector3,
  Vector4,
} from 'three';
import { core, views } from '../../core';
import {
  BONE,
  FLAG_MORPH_RELATIVE,
  FLAG_MORPHED,
  FLAG_SKINNED,
  FRAME_BIND,
  FRAME_BIND_INVERSE,
  FRAME_MESH_WORLD,
  FRAME_VIEW,
  LAYOUT,
  LAYOUT_BASE,
  LAYOUT_BONES,
  LAYOUT_CENTROIDS,
  LAYOUT_DEPTHS,
  LAYOUT_FACES,
  LAYOUT_FRAME,
  LAYOUT_INFLUENCES,
  LAYOUT_MORPHS,
  LAYOUT_ORDER,
  LAYOUT_POSITIONS,
  LAYOUT_SKIN_INDEX,
  LAYOUT_SKIN_WEIGHT,
  OUTCOME_NON_FINITE_DEPTH,
} from '../../core/abi/triangles';

/** Why an update produced no new order. */
export type TriangleKernelReason =
  | 'index-out-of-range'
  | 'pose-evaluation-failed'
  | 'non-finite-depth';

type AttributeLike = BufferAttribute | InterleavedBufferAttribute;

const f64At = (ptr: number): number => ptr >>> 3;
const u32At = (ptr: number): number => ptr >>> 2;

const _vertex = new Vector3();
const _skinIndex = new Vector4();
const _skinWeight = new Vector4();

/** `Vector4.fromBufferAttribute`, whose typing omits the interleaved attributes it reads. */
function read4(target: Vector4, attribute: AttributeLike, index: number): void {
  target.fromBufferAttribute(attribute as BufferAttribute, index);
}

/** Identity and version tokens of one attribute, everything its reads depend on. */
function stampAttribute(attribute: AttributeLike | undefined, out: unknown[]): void {
  if (attribute === undefined) {
    out.push(undefined);
    return;
  }
  out.push(attribute, attribute.count, attribute.itemSize, attribute.normalized);
  if (attribute instanceof InterleavedBufferAttribute) {
    const data = attribute.data;
    out.push(data, data.array, data.version, data.stride, attribute.offset);
  } else {
    out.push(attribute.array, attribute.version);
  }
}

/** Tokens of everything an upload reads; equal tokens mean the uploaded buffers still hold. */
function stamp(mesh: Mesh, out: unknown[]): void {
  out.length = 0;
  const geometry = mesh.geometry;
  const index = geometry.index;
  out.push(geometry, index, index?.array, index?.version, index?.count);
  stampAttribute(geometry.attributes.position, out);
  const morphs = geometry.morphAttributes.position as AttributeLike[] | undefined;
  out.push(morphs, morphs?.length, geometry.morphTargetsRelative);
  for (const morph of morphs ?? []) stampAttribute(morph, out);
  out.push(mesh.morphTargetInfluences !== undefined);
  if (mesh instanceof SkinnedMesh) {
    stampAttribute(geometry.attributes.skinIndex, out);
    stampAttribute(geometry.attributes.skinWeight, out);
    out.push(mesh.skeleton, mesh.skeleton.bones.length, mesh.skeleton.boneInverses.length);
  }
}

function sameStamp(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The core's transparent-triangle kernel over one mesh: the pose `mesh.getVertexPosition` gives
 * every referenced vertex, each face's centroid and camera depth, and the faces sorted far to
 * near, ties by face index.
 *
 * Attributes are read through three (`fromBufferAttribute`) and uploaded only when the index, an
 * attribute, the morph set or the skeleton's size changes; each update writes the matrices and
 * morph influences and runs one core call. Call it outside `withDraw`, while the mesh holds its
 * own geometry.
 */
export class TriangleKernel {
  readonly mesh: Mesh;
  #handle = 0;
  #layout = new Uint32Array(LAYOUT);
  #stamp: unknown[] = [];
  #next: unknown[] = [];
  #failure: TriangleKernelReason | null = null;
  #skinned = false;
  #morphs = 0;
  #faces = 0;
  #sourceIndices = new Uint32Array(0);
  #vertices: number[] = [];

  constructor(mesh: Mesh) {
    this.mesh = mesh;
  }

  /** Source vertex indices, three per face in face order. */
  get sourceIndices(): Uint32Array {
    return this.#sourceIndices;
  }

  /** The source vertex behind each compact slot of `positions()`. */
  get vertices(): readonly number[] {
    return this.#vertices;
  }

  /** Pose, measure and sort for `camera`; null when the order is fresh. */
  update(camera: Camera): TriangleKernelReason | null {
    stamp(this.mesh, this.#next);
    if (!sameStamp(this.#stamp, this.#next)) {
      [this.#stamp, this.#next] = [this.#next, this.#stamp];
      this.#failure = this.#upload();
    }
    if (this.#failure !== null) return this.#failure;
    this.#push(camera);
    const outcome = core().hd_tri_update(this.#handle);
    return outcome === OUTCOME_NON_FINITE_DEPTH ? 'non-finite-depth' : null;
  }

  /** Face indices, ascending depth; a view valid until the core's memory grows. */
  order(): Uint32Array {
    return this.#u32(LAYOUT_ORDER, this.#faces);
  }

  /** Posed position per slot, xyz; a view as for `order()`. */
  positions(): Float64Array {
    return this.#f64(LAYOUT_POSITIONS, 3 * this.#vertices.length);
  }

  /** Centroid per face, xyz; a view as for `order()`. */
  centroids(): Float64Array {
    return this.#f64(LAYOUT_CENTROIDS, 3 * this.#faces);
  }

  /** View-space depth per face; a view as for `order()`. */
  depths(): Float64Array {
    return this.#f64(LAYOUT_DEPTHS, this.#faces);
  }

  /** Write the source index in sorted face order into `out`. */
  writeIndex(out: TypedArray | number[]): void {
    const order = this.order();
    const source = this.#sourceIndices;
    for (let k = 0; k < order.length; k++) {
      const at = 3 * order[k];
      out[3 * k] = source[at];
      out[3 * k + 1] = source[at + 1];
      out[3 * k + 2] = source[at + 2];
    }
  }

  /** Free the core's half. Updates afterwards re-upload. */
  dispose(): void {
    this.#release();
    this.#stamp.length = 0;
    this.#failure = null;
  }

  #release(): void {
    if (this.#handle) core().hd_tri_free(this.#handle);
    this.#handle = 0;
    this.#faces = 0;
    this.#vertices = [];
    this.#sourceIndices = new Uint32Array(0);
  }

  #f64(slot: number, length: number): Float64Array {
    const start = f64At(this.#layout[slot]);
    return views().f64.subarray(start, start + length);
  }

  #u32(slot: number, length: number): Uint32Array {
    const start = u32At(this.#layout[slot]);
    return views().u32.subarray(start, start + length);
  }

  /** Rebuild the core kernel from the mesh's current attributes, as three reads them. */
  #upload(): TriangleKernelReason | null {
    this.#release();
    const mesh = this.mesh;
    const geometry = mesh.geometry;
    const index = geometry.index;
    if (index === null) throw new Error('TriangleKernel needs an indexed geometry.');
    const position = geometry.attributes.position as AttributeLike;
    const vertexCount = position.count;
    const faces = Math.floor(index.count / 3);
    const sourceIndices = new Uint32Array(3 * faces);
    const slots = new Int32Array(vertexCount).fill(-1);
    const vertices: number[] = [];
    for (let offset = 0; offset < sourceIndices.length; offset++) {
      const vertex = index.getX(offset);
      if (!Number.isInteger(vertex) || vertex < 0 || vertex >= vertexCount) {
        return 'index-out-of-range';
      }
      sourceIndices[offset] = vertex;
      if (slots[vertex] === -1) {
        slots[vertex] = vertices.length;
        vertices.push(vertex);
      }
    }

    const skinned = mesh instanceof SkinnedMesh;
    const skinIndex = geometry.attributes.skinIndex as AttributeLike | undefined;
    const skinWeight = geometry.attributes.skinWeight as AttributeLike | undefined;
    const bones = skinned ? mesh.skeleton.bones.length : 0;
    if (skinned) {
      // three throws reading a missing attribute or an unknown bone; the controller reports that.
      if (skinIndex === undefined || skinWeight === undefined) return 'pose-evaluation-failed';
      for (const vertex of vertices) {
        read4(_skinIndex, skinIndex, vertex);
        read4(_skinWeight, skinWeight, vertex);
        for (let i = 0; i < 4; i++) {
          if (_skinWeight.getComponent(i) === 0) continue;
          const bone = _skinIndex.getComponent(i);
          if (
            !Number.isInteger(bone) ||
            bone < 0 ||
            mesh.skeleton.bones[bone] === undefined ||
            mesh.skeleton.boneInverses[bone] === undefined
          ) {
            return 'pose-evaluation-failed';
          }
        }
      }
    }

    const morphTargets = geometry.morphAttributes.position as AttributeLike[] | undefined;
    const morphed = Boolean(morphTargets && mesh.morphTargetInfluences);
    const morphs = morphed && morphTargets ? morphTargets.length : 0;
    let flags = 0;
    if (skinned) flags |= FLAG_SKINNED;
    if (morphed) flags |= FLAG_MORPHED;
    if (geometry.morphTargetsRelative) flags |= FLAG_MORPH_RELATIVE;

    const c = core();
    const h = c.hd_tri_new(vertices.length, faces, morphs, bones, flags);
    this.#handle = h;
    this.#layout.set(new Uint32Array(c.memory.buffer, c.hd_tri_layout(h), LAYOUT));
    this.#faces = faces;
    this.#vertices = vertices;
    this.#sourceIndices = sourceIndices;
    this.#skinned = skinned;
    this.#morphs = morphs;

    const { f64, u32 } = views();
    const L = this.#layout;
    const faceSlots = u32At(L[LAYOUT_FACES]);
    for (let k = 0; k < sourceIndices.length; k++) u32[faceSlots + k] = slots[sourceIndices[k]];
    const base = f64At(L[LAYOUT_BASE]);
    const morphBase = f64At(L[LAYOUT_MORPHS]);
    const indexBase = u32At(L[LAYOUT_SKIN_INDEX]);
    const weightBase = f64At(L[LAYOUT_SKIN_WEIGHT]);
    for (let s = 0; s < vertices.length; s++) {
      const vertex = vertices[s];
      _vertex.fromBufferAttribute(position, vertex);
      f64[base + 3 * s] = _vertex.x;
      f64[base + 3 * s + 1] = _vertex.y;
      f64[base + 3 * s + 2] = _vertex.z;
      for (let t = 0; t < morphs; t++) {
        _vertex.fromBufferAttribute((morphTargets as AttributeLike[])[t], vertex);
        const at = morphBase + 3 * (t * vertices.length + s);
        f64[at] = _vertex.x;
        f64[at + 1] = _vertex.y;
        f64[at + 2] = _vertex.z;
      }
      if (skinIndex === undefined || skinWeight === undefined || !skinned) continue;
      read4(_skinIndex, skinIndex, vertex);
      read4(_skinWeight, skinWeight, vertex);
      for (let i = 0; i < 4; i++) {
        const weight = _skinWeight.getComponent(i);
        f64[weightBase + 4 * s + i] = weight;
        u32[indexBase + 4 * s + i] = weight === 0 ? 0 : _skinIndex.getComponent(i);
      }
    }
    return null;
  }

  /** Write this frame's matrices and morph influences. */
  #push(camera: Camera): void {
    const { f64 } = views();
    const L = this.#layout;
    const mesh = this.mesh;
    const frame = f64At(L[LAYOUT_FRAME]);
    if (this.#skinned && mesh instanceof SkinnedMesh) {
      const { bones, boneInverses } = mesh.skeleton;
      const at = f64At(L[LAYOUT_BONES]);
      for (let b = 0; b < bones.length; b++) {
        f64.set(bones[b].matrixWorld.elements, at + BONE * b);
        f64.set(boneInverses[b].elements, at + BONE * b + 16);
      }
      f64.set(mesh.bindMatrix.elements, frame + FRAME_BIND);
      f64.set(mesh.bindMatrixInverse.elements, frame + FRAME_BIND_INVERSE);
    }
    f64.set(mesh.matrixWorld.elements, frame + FRAME_MESH_WORLD);
    f64.set(camera.matrixWorldInverse.elements, frame + FRAME_VIEW);
    const influences = mesh.morphTargetInfluences;
    const at = f64At(L[LAYOUT_INFLUENCES]);
    for (let t = 0; t < this.#morphs; t++) f64[at + t] = influences?.[t] ?? Number.NaN;
  }
}
