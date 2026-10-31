import * as THREE from 'three';
import type { RigHandle } from '../rig/handle';
import { readVec, writeVec } from '../rig/records';
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

const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _at = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

/** The skin measured at load, in the head bone's frame: positions and outward normals. */
export interface FaceSkin {
  readonly pos: Float32Array;
  readonly nrm: Float32Array;
}

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

/** Measure the skin carried by `head` and its subtree, at the pose it is in now. */
export function measureFaceSkin(
  root: THREE.Object3D | null,
  head: THREE.Bone,
  set: Set<THREE.Bone>,
): FaceSkin | null {
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
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm) };
}

/** `rig.anat.face`: the face's skin, held by the core. */
export class FaceSurface {
  readonly #rig: RigHandle;

  constructor(rig: RigHandle) {
    this.#rig = rig;
  }

  /** Follow the head to where it is posed now. Call before a run of face queries. */
  refresh(): void {
    this.#rig.run((c, h) => c.hd_rig_face_refresh(h));
  }

  /**
   * How far short of `clear` outside the skin a world point is, in metres. Writes the outward
   * normal only for a positive shortfall.
   */
  shortfall(P: THREE.Vector3, clear: number, outward: THREE.Vector3): number {
    const r = this.#rig;
    const f = r.s();
    writeVec(f, r.scratch, outward);
    const short = r.direct((c, h) => c.hd_rig_face_shortfall(h, P.x, P.y, P.z, clear));
    readVec(f, r.scratch, outward);
    return short;
  }

  /** Signed local plane distance in metres and its outward world normal round `P`. */
  sample(P: THREE.Vector3, out: FaceSurfaceSample): void {
    const r = this.#rig;
    r.direct((c, h) => c.hd_rig_face_sample(h, P.x, P.y, P.z));
    const f = r.s();
    const s = r.scratch;
    out.distance = f[s];
    out.normal.set(f[s + 1], f[s + 2], f[s + 3]);
    out.valid = f[s + 4] !== 0;
  }
}
