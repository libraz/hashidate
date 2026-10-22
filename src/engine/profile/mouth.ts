import * as THREE from 'three';
import type { FaceFrame, MorphTarget } from '../types';

/**
 * Where the mouth is, measured from the shapes that move it.
 *
 * The eye-relative anchor table puts a mouth "1.25 IPD below the eyes", and on
 * the two validation avatars that landed a hand's breadth from the lips: below
 * the chin on one, and an IPD inside the head on the other, whose eye bones sit
 * deep. The lip-sync shapes say where the mouth is outright — the vertices they
 * move are the lips — so the anchor is taken from them: the centroid of those
 * vertices weighted by how far each moves, carried along the face's forward
 * line to where it leaves the skin.
 *
 * A shape that moves every vertex alike deforms nothing, so each vertex is
 * weighted by how far it moves from the median vertex's displacement: most of
 * a face stays still under a viseme, and a mesh translated whole carries no
 * mouth, so the caller falls back to the table.
 *
 * Head-local, in the same space as the face frame's origin, and measured at
 * the pose the scene is in when the profile is built.
 */
export function measureMouth(
  head: THREE.Object3D,
  face: FaceFrame,
  shapes: readonly string[],
  morphTargets: Map<string, MorphTarget[]>,
): THREE.Vector3 | null {
  const weights = new Map<THREE.Mesh, Float64Array>();
  const d = new THREE.Vector3();
  const baseAt = new THREE.Vector3();
  const still = new THREE.Vector3();
  for (const shape of shapes) {
    for (const { mesh, index } of morphTargets.get(shape) ?? []) {
      const geometry = mesh.geometry;
      const target = geometry.morphAttributes.position?.[index];
      const base = geometry.attributes.position;
      if (!(target && base) || target.count !== base.count) continue;
      const delta = (i: number) => {
        d.fromBufferAttribute(target, i);
        return geometry.morphTargetsRelative ? d : d.sub(baseAt.fromBufferAttribute(base, i));
      };
      const xs = new Float32Array(base.count);
      const ys = new Float32Array(base.count);
      const zs = new Float32Array(base.count);
      for (let i = 0; i < base.count; i++) {
        delta(i);
        xs[i] = d.x;
        ys[i] = d.y;
        zs[i] = d.z;
      }
      const mid = base.count >> 1;
      still.set(xs.sort()[mid], ys.sort()[mid], zs.sort()[mid]);
      let w = weights.get(mesh);
      if (!w) {
        w = new Float64Array(base.count);
        weights.set(mesh, w);
      }
      for (let i = 0; i < base.count; i++) w[i] += delta(i).sub(still).length();
    }
  }
  if (!weights.size) return null;

  head.updateWorldMatrix(true, false);
  const toHead = new THREE.Matrix4().copy(head.matrixWorld).invert();
  const rest = new Map<THREE.Mesh, Float32Array>();
  for (const mesh of weights.keys()) {
    mesh.updateWorldMatrix(true, false);
    const base = mesh.geometry.attributes.position;
    const out = new Float32Array(base.count * 3);
    const p = new THREE.Vector3();
    for (let i = 0; i < base.count; i++) {
      p.fromBufferAttribute(base, i);
      if (mesh instanceof THREE.SkinnedMesh) mesh.applyBoneTransform(i, p);
      p.applyMatrix4(mesh.matrixWorld).applyMatrix4(toHead);
      out[i * 3] = p.x;
      out[i * 3 + 1] = p.y;
      out[i * 3 + 2] = p.z;
    }
    rest.set(mesh, out);
  }

  const centre = new THREE.Vector3();
  let total = 0;
  for (const [mesh, w] of weights) {
    const at = rest.get(mesh) as Float32Array;
    for (let i = 0; i < w.length; i++) {
      centre.x += w[i] * at[i * 3];
      centre.y += w[i] * at[i * 3 + 1];
      centre.z += w[i] * at[i * 3 + 2];
      total += w[i];
    }
  }
  if (!(total > 0)) return null;
  centre.divideScalar(total);

  // The skin there: the front-most crossing of the forward line through the
  // centroid with the moved meshes' own triangles.
  const ray = new THREE.Ray(centre.clone(), new THREE.Vector3());
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const hit = new THREE.Vector3();
  let front = Number.NEGATIVE_INFINITY;
  for (const [mesh, at] of rest) {
    const index = mesh.geometry.index;
    const corners = index ? index.count : at.length / 3;
    const corner = (k: number) => (index ? index.getX(k) : k);
    for (let t = 0; t + 2 < corners; t += 3) {
      const i0 = corner(t) * 3;
      const i1 = corner(t + 1) * 3;
      const i2 = corner(t + 2) * 3;
      a.set(at[i0], at[i0 + 1], at[i0 + 2]);
      b.set(at[i1], at[i1 + 1], at[i1 + 2]);
      c.set(at[i2], at[i2 + 1], at[i2 + 2]);
      // Both directions along the line, either winding.
      for (const dir of [1, -1]) {
        ray.direction.copy(face.forward).multiplyScalar(dir);
        if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
        const along = hit.sub(centre).dot(face.forward);
        if (along > front) front = along;
      }
    }
  }
  return Number.isFinite(front) ? centre.addScaledVector(face.forward, front) : null;
}
