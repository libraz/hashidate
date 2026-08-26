import * as THREE from 'three';
import { TORSO_BANDS, TORSO_SECTORS } from './joints';

/**
 * A body part as a collision surface: a radius per (height band, angular
 * sector) in some frame of its own, plus the height range that grid spans.
 *
 * `r` is null on a fallback volume that was never measured off the mesh — the
 * plain cylinder of `radius` the trunk falls back to when a rig has no usable
 * skin weights. `bands` and `sectors` are not read in that case.
 */
export interface MeasuredVolume {
  r: Float32Array | null;
  bands: number;
  sectors: number;
  top: number;
  bottom: number;
  radius: number;
}

/** A height range imposed from outside rather than taken from the vertices. */
export interface VolumeExtent {
  top: number;
  bottom: number;
}

/**
 * Bin one body part's skin into a radius per (height band, bearing sector).
 *
 * Shared by the trunk and the head: the only thing that differs between them
 * is which bones count and which frame the angles are taken in.
 */
export function measureVolume(
  root: THREE.Object3D,
  boneSet: Set<THREE.Bone>,
  O: THREE.Vector3,
  up: THREE.Vector3,
  right: THREE.Vector3,
  fwd: THREE.Vector3,
  fixed: VolumeExtent | null = null,
): MeasuredVolume | null {
  if (!root) return null;
  const v = new THREE.Vector3();

  const eachVertex = (o: THREE.SkinnedMesh, fn: (P: THREE.Vector3) => void) => {
    const pos = o.geometry.attributes.position;
    const si = o.geometry.attributes.skinIndex;
    const sw = o.geometry.attributes.skinWeight;
    o.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i++) {
      // Dominant bone only. Weights blend across seams, and a seam vertex
      // shared with an arm is not evidence about where a surface is.
      let bi = -1;
      let bw = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bw) {
          bw = w;
          bi = si.getComponent(i, k);
        }
      }
      if (!boneSet.has(o.skeleton.bones[bi])) continue;
      // Skinned through three's own transform rather than the mesh matrix.
      // A skinned mesh's geometry is not in its node's space in any way worth
      // assuming: this avatar carries a 0.01 armature scale that the vertex
      // data has already absorbed, so putting the raw positions through
      // `matrixWorld` shrank the whole body to a centimetre and every vertex
      // landed below the hips.
      v.fromBufferAttribute(pos, i);
      o.applyBoneTransform(i, v);
      fn(v.applyMatrix4(o.matrixWorld).sub(O));
    }
  };

  // Candidates: skinned, visible, and actually carrying this part's vertices.
  const cand: Array<{ mesh: THREE.SkinnedMesh; n: number }> = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.SkinnedMesh && o.visible && o.skeleton)) return;
    const g = o.geometry;
    if (!(g?.attributes?.position && g.attributes.skinIndex && g.attributes.skinWeight)) return;
    let n = 0;
    eachVertex(o, () => {
      n++;
    });
    if (n > 0) cand.push({ mesh: o, n });
  });
  if (!cand.length) return null;

  // The collision surface is skin, not clothing: a loose cardigan puts the
  // surface a centimetre outside the body, and it can be taken off at runtime,
  // which a measurement made once at load cannot follow.
  //
  // Skin is identified structurally rather than by name — among the meshes
  // that carry this part, it is the one with the shape keys. A body has the
  // hide shapes on it and a face has the expressions; garments have none.
  //
  // "Carries this part" has to come first. Ranking every mesh in the scene by
  // shape-key count picks the face, which on this avatar has 147 of them and
  // not one vertex below the neck.
  const morphs = (c: { mesh: THREE.SkinnedMesh }) =>
    Object.keys(c.mesh.morphTargetDictionary ?? {}).length;
  const best = cand.reduce((m, c) => Math.max(m, morphs(c)), 0);
  const use = (best > 1 ? cand.filter((c) => morphs(c) === best) : cand).map((c) => c.mesh);

  let top = fixed?.top ?? Number.NEGATIVE_INFINITY;
  let bottom = fixed?.bottom ?? Number.POSITIVE_INFINITY;
  if (!fixed) {
    for (const o of use) {
      eachVertex(o, (P) => {
        const h = P.dot(up);
        if (h > top) top = h;
        if (h < bottom) bottom = h;
      });
    }
  }
  const span = top - bottom;
  if (!(span > 1e-6)) return null;

  const r = new Float32Array(TORSO_BANDS * TORSO_SECTORS);
  const rad = new THREE.Vector3();
  let filled = 0;
  for (const o of use) {
    eachVertex(o, (P) => {
      const h = P.dot(up);
      if (h > top || h < bottom) return;
      rad.copy(P).addScaledVector(up, -h);
      const len = rad.length();
      if (!(len > 1e-9)) return;
      const band = Math.min(TORSO_BANDS - 1, Math.floor(((h - bottom) / span) * TORSO_BANDS));
      let a = Math.atan2(rad.dot(fwd), rad.dot(right)) / (Math.PI * 2);
      a -= Math.floor(a);
      const idx = band * TORSO_SECTORS + Math.min(TORSO_SECTORS - 1, Math.floor(a * TORSO_SECTORS));
      if (r[idx] <= 0) filled++;
      if (len > r[idx]) r[idx] = len;
    });
  }
  // Too sparse to be a surface — a rig with no usable skin weights.
  if (filled < TORSO_BANDS * TORSO_SECTORS * 0.4) return null;

  // Sectors that caught nothing borrow their own band's mean.
  let total = 0;
  for (let b = 0; b < TORSO_BANDS; b++) {
    let sum = 0;
    let n = 0;
    for (let s = 0; s < TORSO_SECTORS; s++) {
      const x = r[b * TORSO_SECTORS + s];
      if (x > 0) {
        sum += x;
        n++;
      }
    }
    const mean = n ? sum / n : 0;
    for (let s = 0; s < TORSO_SECTORS; s++) {
      if (r[b * TORSO_SECTORS + s] <= 0) r[b * TORSO_SECTORS + s] = mean;
      total += r[b * TORSO_SECTORS + s];
    }
  }
  return {
    r,
    bands: TORSO_BANDS,
    sectors: TORSO_SECTORS,
    top,
    bottom,
    radius: total / (TORSO_BANDS * TORSO_SECTORS),
  };
}

/** Radius of one volume at a height and bearing in its own frame. */
export function surfaceOf(t: MeasuredVolume, h: number, theta: number): number {
  const tr = t.r;
  if (!tr) return t.radius;
  const fb = Math.min(
    t.bands - 1,
    Math.max(0, ((h - t.bottom) / (t.top - t.bottom)) * t.bands - 0.5),
  );
  const b0 = Math.floor(fb);
  const b1 = Math.min(t.bands - 1, b0 + 1);
  const tb = fb - b0;
  let a = theta / (Math.PI * 2);
  a -= Math.floor(a);
  const fs = a * t.sectors - 0.5;
  const s0 = ((Math.floor(fs) % t.sectors) + t.sectors) % t.sectors;
  const s1 = (s0 + 1) % t.sectors;
  const ts = fs - Math.floor(fs);
  const g = (b: number, s: number) => tr[b * t.sectors + s];
  return (
    (g(b0, s0) * (1 - ts) + g(b0, s1) * ts) * (1 - tb) +
    (g(b1, s0) * (1 - ts) + g(b1, s1) * ts) * tb
  );
}
