import * as THREE from 'three';
import type { BoneSlot, Profile } from '../types';
import { type FaceSkin, measureFaceSkin } from './face';
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
  const skin = partSkin(root, boneSet);
  if (!skin) return null;
  const eachSkin = (fn: (P: THREE.Vector3) => void) => skin((P) => fn(P.sub(O)));

  let top = fixed?.top ?? Number.NEGATIVE_INFINITY;
  let bottom = fixed?.bottom ?? Number.POSITIVE_INFINITY;
  if (!fixed) {
    eachSkin((P) => {
      const h = P.dot(up);
      if (h > top) top = h;
      if (h < bottom) bottom = h;
    });
  }
  const span = top - bottom;
  if (!(span > 1e-6)) return null;

  const r = new Float32Array(TORSO_BANDS * TORSO_SECTORS);
  const rad = new THREE.Vector3();
  let filled = 0;
  eachSkin((P) => {
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

/**
 * Walk the skin of one body part: every vertex whose dominant bone is in
 * `boneSet`, skinned to world space at the pose the bones are in now, on the
 * meshes that are skin rather than clothing. Null where nothing carries the part.
 */
export function partSkin(
  root: THREE.Object3D | null,
  boneSet: Set<THREE.Bone>,
): ((fn: (P: THREE.Vector3, mesh: THREE.SkinnedMesh, i: number) => void) => void) | null {
  if (!root) return null;
  const v = new THREE.Vector3();

  const eachVertex = (
    o: THREE.SkinnedMesh,
    fn: (P: THREE.Vector3, mesh: THREE.SkinnedMesh, i: number) => void,
  ) => {
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
      fn(v.applyMatrix4(o.matrixWorld), o, i);
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
  return (fn) => {
    for (const o of use) eachVertex(o, fn);
  };
}

/** The head's surface, with the skin the fingers are tested against. */
export interface HeadMeasurement extends MeasuredVolume {
  /** The skin itself, for what passes closer to it than the volume can tell. */
  face: FaceSkin | null;
}

/** What the core's body volumes are built from, measured off the mesh at the pose it is in now. */
export interface BodyMeasurement {
  torso: MeasuredVolume | null;
  head: HeadMeasurement | null;
}

/**
 * The trunk and the head as the core's body volumes are built from them, measured off the mesh
 * at the pose the avatar is in now.
 */
export function measureBodyVolumes(p: Profile): BodyMeasurement {
  // Every world matrix brought up to date, so the measurement reads the pose as it stands.
  p.root.updateWorldMatrix(true, true);
  return { torso: measureTorsoSurface(p), head: measureHead(p) };
}

/**
 * The torso, as a cylinder the elbow may not enter.
 *
 * Joint angles are not the whole of a range of motion. The reason you
 * cannot swing your elbow twenty centimetres to the left is not that a
 * shoulder runs out of rotation — it is that your ribcage is there. The
 * angular model approximates this at the top, through the elevation ceiling
 * that closes down across the midline, and misses it entirely at the
 * bottom: below about 25 degrees of elevation the ceiling permits any
 * plane, including pointing the upper arm straight into the chest.
 *
 * Radius is measured, not assumed: the shoulder joint sits at roughly the
 * outer edge of the trunk, so its horizontal offset from the spine is the
 * half-width. Taken at 0.9 to leave the arms their resting position, which
 * hangs slightly outboard of the shoulder on this avatar and slightly
 * inboard on others.
 *
 * In world units. Chest-local distances are not usable here — the armature
 * carries a 0.01 scale on this avatar — and the reach lengths this is
 * compared against are world-space.
 *
 * Trunk half-width and vertical span, in world units, from the rest pose.
 */
function measureTorso(p: Profile): MeasuredVolume | null {
  const { bones } = p;
  const frame = p.body;
  const chest = bones.chest ?? bones.spine ?? bones.hips;
  // The upper arm and not the clavicle. `shoulder.*` is the clavicle root,
  // which sits beside the neck: measured from there the trunk came out with a
  // radius of 0.034 against an upper arm of 0.171, a torso a fifth as wide as
  // one arm segment, and nothing ever touched it. The glenohumeral joint is
  // where the arm actually hangs from, and it is at the edge of the trunk.
  const sL = bones['upperArm.L'] ?? bones['shoulder.L'];
  const sR = bones['upperArm.R'] ?? bones['shoulder.R'];
  if (!(chest && sL && sR && frame)) return null;
  const w = (b: THREE.Bone) => b.getWorldPosition(new THREE.Vector3());
  const q = chest.getWorldQuaternion(new THREE.Quaternion());
  const up = frame.up.clone().applyQuaternion(q);
  const O = w(chest);
  // Horizontal distance from the trunk axis to each shoulder.
  const off = (b: THREE.Bone) => {
    const v = w(b).sub(O);
    v.addScaledVector(up, -v.dot(up));
    return v.length();
  };
  const radius = ((off(sL) + off(sR)) / 2) * 0.9;
  // Only between the hips and the shoulders is there a trunk to hit.
  const hips = bones.hips ? w(bones.hips).sub(O).dot(up) : -radius * 3;
  const top = w(sR).sub(O).dot(up);
  return radius > 1e-6
    ? {
        r: null,
        bands: TORSO_BANDS,
        sectors: TORSO_SECTORS,
        radius,
        top,
        bottom: Math.min(hips, top - 1e-4),
      }
    : null;
}

/**
 * The trunk's actual surface, measured off the mesh.
 *
 * A cylinder sized from the shoulders is the wrong shape, and being the wrong
 * shape it cannot be tuned into the right answer: a chest is markedly wider
 * than it is deep, so one radius is simultaneously too small at the sides and
 * too large in front. Too small at the sides means an arm crossing the body
 * passes through the ribs with nothing reported; too large in front means a
 * hand deliberately placed on the sternum reads as buried, so the poses that
 * *should* touch the chest cannot be told from the ones that go through it.
 *
 * Stored as a radius per (height band, angular sector) in the chest's own
 * frame, which is the same frame the cylinder used — so it still follows the
 * chest when the spine turns, and the query is still a couple of lookups.
 *
 * Read at load, before anything is posed, with each vertex put through
 * three's own skinning transform (see `measureVolume`), so what is measured is
 * the rest shape where the mesh actually draws it.
 *
 * Only vertices whose *dominant* bone is part of the trunk are counted. The
 * arms rest inside the trunk's height band in a bind pose, and a maximum over
 * everything there would inflate the sides by an entire arm.
 */
function measureTorsoSurface(p: Profile): MeasuredVolume | null {
  const base = measureTorso(p);
  const root = p.root;
  const frame = p.body;
  const { bones } = p;
  const chest = bones.chest ?? bones.spine ?? bones.hips;
  if (!(base && root && frame && chest)) return base;

  // The trunk is the spine's whole subtree, stopping where the limbs and the
  // head begin. Taken as a subtree and not as the four named slots because a
  // rig puts the parts that stick out on their own bones — the bust is
  // `Breast_L`/`Breast_R` here — and those are exactly the parts a collision
  // surface exists to describe. Named-slot-only left the chest a smooth tube.
  const stop = new Set<THREE.Bone>();
  const stopSlots: BoneSlot[] = [
    'shoulder.L',
    'shoulder.R',
    'upperArm.L',
    'upperArm.R',
    'head',
    'neck',
  ];
  for (const slot of stopSlots) {
    const b = bones[slot];
    if (b) stop.add(b);
  }
  const trunk = new Set<THREE.Bone>();
  const walk = (b: THREE.Bone | undefined) => {
    if (!b || stop.has(b) || trunk.has(b)) return;
    trunk.add(b);
    for (const c of b.children) if (c instanceof THREE.Bone) walk(c);
  };
  if (bones.hips) trunk.add(bones.hips); // itself, not the legs below it
  walk(bones.spine ?? chest);
  walk(chest);

  const q = chest.getWorldQuaternion(new THREE.Quaternion());
  const up = frame.up.clone().applyQuaternion(q);
  const right = frame.right.clone().applyQuaternion(q);
  const fwd = frame.forward.clone().applyQuaternion(q);
  const O = chest.getWorldPosition(new THREE.Vector3());
  // The height range is fixed rather than taken from the vertices: the trunk
  // has to stop at the shoulders, or the neck stub raises its top and an arm
  // resting beside the neck reads as inside the body.
  const vol = measureVolume(root, trunk, O, up, right, fwd, {
    top: base.top,
    bottom: base.bottom,
  });
  return vol ? { ...base, ...vol } : base;
}

/**
 * The head, measured the same way as the trunk.
 *
 * A separate volume rather than an extension of the trunk because it moves
 * separately: a head turns and tips under the chest, so a surface stored in
 * the chest's frame would swing away from the skull it is meant to describe.
 * Its own frame is the one the face anchors already use.
 *
 * Without it the whole face is empty space to the arm. Every gesture in the
 * table that touches the face aims at a point *on* the head, so the hand
 * arrives at the surface and the fingers carry on into it.
 *
 * The extent is taken from the vertices rather than from bones, because there
 * is no second bone to measure a head against the way the shoulders measure
 * the trunk.
 *
 * Hair is excluded for free: it hangs off its own bones, so the dominant-bone
 * filter never sees it. That is the behaviour to want — a hand should be able
 * to touch hair, and pushing it out to the far side of a twintail would put it
 * a head's width away from the head.
 */
function measureHead(p: Profile): HeadMeasurement | null {
  const head = p.bones.head;
  const face = p.face;
  if (!(head && face && p.root)) return null;

  const set = new Set<THREE.Bone>();
  const walk = (b: THREE.Bone) => {
    if (!b || set.has(b)) return;
    set.add(b);
    for (const c of b.children) if (c instanceof THREE.Bone) walk(c);
  };
  walk(head);

  const q = head.getWorldQuaternion(new THREE.Quaternion());
  const up = face.up.clone().applyQuaternion(q).normalize();
  const right = face.right.clone().applyQuaternion(q).normalize();
  const fwd = face.forward.clone().applyQuaternion(q).normalize();
  const O = head.getWorldPosition(new THREE.Vector3());
  const vol = measureVolume(p.root, set, O, up, right, fwd);
  if (!vol) return null;
  return { ...vol, face: measureFaceSkin(p.root, head, set) };
}
