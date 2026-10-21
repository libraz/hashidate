import * as THREE from 'three';
import { partSkin } from './volume';

/**
 * The face as a finger meets it: the head's skin, kept vertex by vertex.
 *
 * The head volume is a radius per band and bearing about one axis. That is the
 * right shape for an arm swinging past a skull and the wrong one for a finger,
 * which travels a few millimetres off the skin: under the jaw and in the hollow
 * of a cheek lie inside the radius the chin or the cheekbone sets at that
 * bearing, and a finger laid along the face read as half a head deep. So the
 * fingers are tested against the skin itself, measured once at load in the
 * head bone's frame — whatever face the avatar has.
 *
 * Inside or out is read off the skin's normals round the point, which hold
 * near the surface, where the question is asked; nothing here claims a
 * distance deep in the skull. The normal is the surface's own, from its triangles: an anime face
 * carries normals edited toward the front for its shading, and by those a hand
 * cupped behind the ear read as three centimetres inside the cheek.
 */

/** Hash cell, metres. About a fingertip's breadth. */
const CELL = 0.02;
/** Cells out to look before calling a point nowhere near the face. */
const REACH = 3;
/** Least radius the skin is read over round a point, metres: a few vertex spacings. */
const SMOOTH = 0.01;

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _at = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

/** Signed local plane sample and its outward normal in world coordinates. */
export interface FaceSurfaceSample {
  distance: number;
  normal: THREE.Vector3;
  valid: boolean;
}

/** World to the head's own frame, in metres: its position and turn, not its scale. */
function headFrame(bone: THREE.Bone, out: THREE.Matrix4): THREE.Matrix4 {
  bone.updateWorldMatrix(true, false);
  return out.compose(bone.getWorldPosition(_at), bone.getWorldQuaternion(_q), ONE).invert();
}

const key = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);

/**
 * The skin of one primitive as a surface: which vertices are on it and the
 * normal its triangles give each. The skin is the primitive's largest connected
 * piece; the rest are eyelash and brow cards, open planes with no inside.
 */
function shell(geometry: THREE.BufferGeometry) {
  const pos = geometry.attributes.position;
  // Welded by position first: a UV seam splits a vertex, and is not a cut in the skin.
  const weld = new Map<string, number>();
  const id = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
    let w = weld.get(k);
    if (w === undefined) {
      w = weld.size;
      weld.set(k, w);
    }
    id[i] = w;
  }
  const n = weld.size;
  const up = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => {
    let r = a;
    while (up[r] !== r) {
      up[r] = up[up[r]];
      r = up[r];
    }
    return r;
  };
  const index = geometry.index;
  const corners = index ? index.count : pos.count;
  const at = (c: number) => (index ? index.getX(c) : c);
  const nrm = new Float32Array(n * 3);
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const C = new THREE.Vector3();
  for (let t = 0; t + 2 < corners; t += 3) {
    const v = [at(t), at(t + 1), at(t + 2)];
    A.fromBufferAttribute(pos, v[0]);
    B.fromBufferAttribute(pos, v[1]).sub(A);
    C.fromBufferAttribute(pos, v[2]).sub(A);
    // Area-weighted, by the winding glTF gives a front face.
    B.cross(C);
    for (let e = 0; e < 3; e++) {
      const a = id[v[e]];
      up[find(a)] = find(id[v[(e + 1) % 3]]);
      nrm[a * 3] += B.x;
      nrm[a * 3 + 1] += B.y;
      nrm[a * 3 + 2] += B.z;
    }
  }
  const size = new Map<number, number>();
  for (let w = 0; w < n; w++) size.set(find(w), (size.get(find(w)) ?? 0) + 1);
  let skin = -1;
  for (const [r, c] of size) if (skin < 0 || c > (size.get(skin) ?? 0)) skin = r;
  return {
    has: (i: number) => find(id[i]) === skin,
    normal: (i: number, out: THREE.Vector3) =>
      out.set(nrm[id[i] * 3], nrm[id[i] * 3 + 1], nrm[id[i] * 3 + 2]).normalize(),
  };
}

export class FaceSurface {
  private readonly cells = new Map<number, number[]>();
  private minCellX = Number.POSITIVE_INFINITY;
  private minCellY = Number.POSITIVE_INFINITY;
  private minCellZ = Number.POSITIVE_INFINITY;
  private maxCellX = Number.NEGATIVE_INFINITY;
  private maxCellY = Number.NEGATIVE_INFINITY;
  private maxCellZ = Number.NEGATIVE_INFINITY;
  private readonly toHead = new THREE.Matrix4();
  private readonly turn = new THREE.Quaternion();
  private readonly cachedSample: FaceSurfaceSample = {
    distance: 0,
    normal: new THREE.Vector3(),
    valid: false,
  };

  private constructor(
    private readonly bone: THREE.Bone,
    private readonly pos: Float32Array,
    private readonly nrm: Float32Array,
  ) {
    for (let i = 0; i < pos.length / 3; i++) {
      const x = Math.floor(pos[i * 3] / CELL);
      const y = Math.floor(pos[i * 3 + 1] / CELL);
      const z = Math.floor(pos[i * 3 + 2] / CELL);
      const k = key(x, y, z);
      this.minCellX = Math.min(this.minCellX, x);
      this.minCellY = Math.min(this.minCellY, y);
      this.minCellZ = Math.min(this.minCellZ, z);
      this.maxCellX = Math.max(this.maxCellX, x);
      this.maxCellY = Math.max(this.maxCellY, y);
      this.maxCellZ = Math.max(this.maxCellZ, z);
      const c = this.cells.get(k);
      if (c) c.push(i);
      else this.cells.set(k, [i]);
    }
  }

  /** Measure the skin carried by `head` and its subtree, at the pose it is in now. */
  static measure(root: THREE.Object3D | null, head: THREE.Bone, set: Set<THREE.Bone>) {
    const skin = partSkin(root, set);
    if (!skin) return null;
    // The skin proper is the primitive carrying most of the head. The others the
    // part's mesh brings are eyes and the inside of the mouth, whose normals face
    // anywhere: nearest to a finger in the cheek, they called it outside.
    const count = new Map<THREE.SkinnedMesh, number>();
    skin((_P, mesh) => count.set(mesh, (count.get(mesh) ?? 0) + 1));
    let face: THREE.SkinnedMesh | null = null;
    for (const [mesh, n] of count) if (!face || n > (count.get(face) ?? 0)) face = mesh;
    if (!face) return null;
    const toHead = headFrame(head, new THREE.Matrix4());
    const surface = shell(face.geometry);
    const pos: number[] = [];
    const nrm: number[] = [];
    const off = new THREE.Vector3();
    skin((P, mesh, i) => {
      if (mesh !== face || !surface.has(i)) return;
      const at = P.clone().applyMatrix4(toHead);
      // Skinned the way the position was, so the normal goes through the same
      // transform: the vertex nudged along its rest normal, and the difference.
      off.fromBufferAttribute(mesh.geometry.attributes.position, i);
      off.addScaledVector(surface.normal(i, _n), 1e-3);
      mesh.applyBoneTransform(i, off);
      off.applyMatrix4(mesh.matrixWorld).applyMatrix4(toHead).sub(at);
      if (off.lengthSq() < 1e-16) return;
      off.normalize();
      pos.push(at.x, at.y, at.z);
      nrm.push(off.x, off.y, off.z);
    });
    if (!pos.length) return null;
    return new FaceSurface(head, new Float32Array(pos), new Float32Array(nrm));
  }

  /** Follow the head to where it is posed now. Call before a run of face queries. */
  refresh(): void {
    this.bone.updateWorldMatrix(true, false);
    this.bone.getWorldQuaternion(this.turn);
    this.toHead.compose(this.bone.getWorldPosition(_at), this.turn, ONE).invert();
  }

  /**
   * How far short of `clear` outside the skin a world point is, in metres.
   * Writes the outward normal only for a positive shortfall; clear and invalid
   * points retain the old no-write behavior.
   */
  shortfall(P: THREE.Vector3, clear: number, outward: THREE.Vector3): number {
    this.sample(P, this.cachedSample);
    if (!this.cachedSample.valid || this.cachedSample.distance >= clear) return 0;
    outward.copy(this.cachedSample.normal);
    return clear - this.cachedSample.distance;
  }

  /**
   * Signed local averaged-plane distance in metres and its outward world
   * normal. Invalid samples reset the output to neutral values.
   *
   * Read off the vertices round the point rather than the nearest one alone,
   * each weighted down to nothing at a radius: the nearest vertex changes
   * under a moving point, the distance to its plane jumped by millimetres when
   * it did, and a hand placed by that distance jerked with it. The radius
   * grows with the distance to the skin, so the reading stays smooth deep in.
   */
  sample(P: THREE.Vector3, out: FaceSurfaceSample): void {
    out.distance = 0;
    out.normal.set(0, 0, 0);
    out.valid = false;
    const p = _p.copy(P).applyMatrix4(this.toHead);
    const cx = Math.floor(p.x / CELL);
    const cy = Math.floor(p.y / CELL);
    const cz = Math.floor(p.z / CELL);
    // The nearest-vertex search cannot find a cell beyond this exact reach cube.
    if (
      cx + REACH < this.minCellX ||
      cx - REACH > this.maxCellX ||
      cy + REACH < this.minCellY ||
      cy - REACH > this.maxCellY ||
      cz + REACH < this.minCellZ ||
      cz - REACH > this.maxCellZ
    ) {
      return;
    }
    let best = Number.POSITIVE_INFINITY;
    let bi = -1;
    // Widened only when the near cells are empty: a finger sunk deep in a cheek
    // is further from the skin than a cell, and that is the finger to move most.
    for (let r = 1; r <= REACH && bi < 0; r++) {
      this.each(cx, cy, cz, r, (i) => {
        const d2 = this.dist2(p, i);
        if (d2 < best) {
          best = d2;
          bi = i;
        }
      });
    }
    if (bi < 0) return;
    const R = Math.max(SMOOTH, 2 * Math.sqrt(best));
    // Too far off the skin to gather round: its nearest vertex's plane says it.
    if (R > REACH * CELL) {
      this.planeSample(p, bi, out);
      return;
    }
    const R2 = R * R;
    let sum = 0;
    let weight = 0;
    _n.set(0, 0, 0);
    this.each(cx, cy, cz, Math.ceil(R / CELL), (i) => {
      const d2 = this.dist2(p, i);
      if (d2 >= R2) return;
      const k = 1 - d2 / R2;
      const w = k * k;
      const nx = this.nrm[i * 3];
      const ny = this.nrm[i * 3 + 1];
      const nz = this.nrm[i * 3 + 2];
      sum +=
        w *
        ((p.x - this.pos[i * 3]) * nx +
          (p.y - this.pos[i * 3 + 1]) * ny +
          (p.z - this.pos[i * 3 + 2]) * nz);
      weight += w;
      _n.x += w * nx;
      _n.y += w * ny;
      _n.z += w * nz;
    });
    if (!(weight > 0) || _n.lengthSq() < 1e-12) return;
    const s = sum / weight;
    out.distance = s;
    out.normal.copy(_n).normalize().applyQuaternion(this.turn);
    out.valid = true;
  }

  private planeSample(p: THREE.Vector3, i: number, out: FaceSurfaceSample): void {
    const nx = this.nrm[i * 3];
    const ny = this.nrm[i * 3 + 1];
    const nz = this.nrm[i * 3 + 2];
    const s =
      (p.x - this.pos[i * 3]) * nx +
      (p.y - this.pos[i * 3 + 1]) * ny +
      (p.z - this.pos[i * 3 + 2]) * nz;
    const lengthSq = nx * nx + ny * ny + nz * nz;
    if (lengthSq < 1e-12) return;
    out.distance = s;
    // Keep the captured Float32 normal: the former fallback wrote it unscaled.
    out.normal.set(nx, ny, nz).applyQuaternion(this.turn);
    out.valid = true;
  }

  private dist2(p: THREE.Vector3, i: number): number {
    const dx = p.x - this.pos[i * 3];
    const dy = p.y - this.pos[i * 3 + 1];
    const dz = p.z - this.pos[i * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  }

  /** Every vertex in the cells within `r` of cell (cx, cy, cz). */
  private each(cx: number, cy: number, cz: number, r: number, fn: (i: number) => void): void {
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        for (let z = cz - r; z <= cz + r; z++) {
          const c = this.cells.get(key(x, y, z));
          if (c) for (const i of c) fn(i);
        }
      }
    }
  }
}
