import * as THREE from 'three';
import { TransparentTriangleController } from '../../src/engine/scene/transparent-triangles';
import { ByteWriter, hashBytes, writeTriangles } from '../../tools/parity/hash';

/**
 * Deterministic transparent meshes and motion for comparing `TransparentTriangleController`
 * against `TriangleKernel`.
 *
 * Each mesh is a ring band of quads plus duplicate faces that tie every frame. Every number a
 * frame applies is computed at module load, so a run is the same on every machine; neither side
 * of the comparison calls a transcendental.
 */

export interface TriangleRig {
  root: THREE.Group;
  mesh: THREE.Mesh;
  bones: THREE.Bone[];
}

/** A frame whose depths were built to hit one edge of the comparator. */
export type SpecialFrame = 'signed-zero' | 'infinite' | 'nan';

export interface TriangleFrame {
  /** Root position xyz and XYZ Euler rotation. */
  root: readonly [number, number, number, number, number, number];
  /** XYZ Euler rotation per bone. */
  bones: ReadonlyArray<readonly [number, number, number]>;
  influences: readonly number[];
  /** The camera's `matrixWorldInverse`. */
  view: readonly number[];
  /** Written over the mesh's `matrixWorld` after the world update. */
  meshWorld?: readonly number[];
  special?: SpecialFrame;
}

export interface TriangleFixture {
  id: string;
  build(): TriangleRig;
  script: readonly TriangleFrame[];
}

export const TRIANGLE_FRAMES = 360;
/** Frames whose depths include a NaN. */
export const NAN_FRAME = 200;

const ROWS = 4;
const SEGMENTS = 10;
const BAND_VERTICES = ROWS * SEGMENTS;
const BONE_Y = [0.6, 0.8, 1.0, 1.2];
/** Indices of the vertices at z = +0 and z = −0, after the band and three unreferenced ones. */
const PLANE_START = BAND_VERTICES + 3;

export function transparentMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
  });
}

/** Band positions, three unreferenced vertices, then two small triangles at z = +0 and −0. */
function positions(): number[] {
  const out: number[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const angle = (s / SEGMENTS) * Math.PI * 2 + row * 0.13;
      const radius = 0.4 + 0.05 * Math.sin(s * 1.7 + row);
      out.push(radius * Math.sin(angle), 0.6 + row * 0.2, radius * Math.cos(angle));
    }
  }
  out.push(5, 5, 5, -5, 5, 5, 5, -5, 5);
  for (const z of [0, -0]) {
    out.push(-0.2, -0.3, z, -0.25, -0.35, z, -0.3, -0.2, z);
  }
  return out;
}

/** Band quads, two duplicates and a permuted copy of band faces, then the two plane faces. */
function indices(): number[] {
  const out: number[] = [];
  for (let row = 0; row + 1 < ROWS; row++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a = row * SEGMENTS + s;
      const b = row * SEGMENTS + ((s + 1) % SEGMENTS);
      const c = a + SEGMENTS;
      const d = b + SEGMENTS;
      out.push(a, b, c, b, d, c);
    }
  }
  out.push(...out.slice(0, 3), ...out.slice(21, 24));
  const [x, y, z] = out.slice(9, 12);
  out.push(y, x, z);
  for (let k = 0; k < 6; k++) out.push(PLANE_START + k);
  return out;
}

const VERTEX_COUNT = PLANE_START + 6;

/** Four influences per vertex from the bone heights, rotated so index order varies. */
function skin(): { index: number[]; weight: number[] } {
  const pos = positions();
  const index: number[] = [];
  const weight: number[] = [];
  for (let v = 0; v < VERTEX_COUNT; v++) {
    const y = pos[3 * v + 1];
    const raw = BONE_Y.map((b) => Math.max(0, 1 - Math.abs(y - b) / 0.5));
    const sum = raw.reduce((a, b) => a + b, 0) || 1;
    for (let k = 0; k < 4; k++) {
      const bone = (k + v) % 4;
      index.push(bone);
      weight.push(raw[bone] / sum);
    }
  }
  return { index, weight };
}

/** Two morph targets: a radial push and a lift, either as deltas or as absolute positions. */
function morphTargets(relative: boolean): number[][] {
  const base = positions();
  const push: number[] = [];
  const lift: number[] = [];
  for (let v = 0; v < VERTEX_COUNT; v++) {
    const [x, , z] = base.slice(3 * v, 3 * v + 3);
    const delta = [x * 0.3, 0.02 * Math.sin(v), z * 0.3];
    const up = [0, 0.1 + 0.01 * v, -0.05];
    push.push(...delta.map((d, k) => (relative ? d : base[3 * v + k] + d)));
    lift.push(...up.map((d, k) => (relative ? d : base[3 * v + k] + d)));
  }
  return [push, lift];
}

function geometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions(), 3));
  g.setIndex(indices());
  return g;
}

function setMorphs(g: THREE.BufferGeometry, relative: boolean): void {
  g.morphAttributes.position = morphTargets(relative).map(
    (t) => new THREE.Float32BufferAttribute(t, 3),
  );
  g.morphTargetsRelative = relative;
}

/** A 4-bone chain under the root, the mesh beside it, both posed and bound. */
function skinnedRig(g: THREE.BufferGeometry, detached: boolean): TriangleRig {
  const root = new THREE.Group();
  const bones = BONE_Y.map(() => new THREE.Bone());
  for (const [i, bone] of bones.entries()) {
    bone.position.set(0, i === 0 ? BONE_Y[0] : BONE_Y[i] - BONE_Y[i - 1], 0);
    (i === 0 ? root : bones[i - 1]).add(bone);
  }
  const mesh = new THREE.SkinnedMesh(g, transparentMaterial());
  root.add(mesh);
  root.updateMatrixWorld(true);
  if (detached) {
    mesh.bindMode = THREE.DetachedBindMode;
    mesh.bind(
      new THREE.Skeleton(bones),
      new THREE.Matrix4()
        .makeTranslation(0.05, -0.1, 0.02)
        .multiply(new THREE.Matrix4().makeScale(1, 1.1, 1)),
    );
  } else {
    mesh.bind(new THREE.Skeleton(bones));
  }
  return { root, mesh, bones };
}

function rigid(): TriangleRig {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(geometry(), transparentMaterial());
  root.add(mesh);
  return { root, mesh, bones: [] };
}

function rigidMorphAbsolute(): TriangleRig {
  const g = new THREE.BufferGeometry();
  // Position interleaved with a fourth padding float.
  const flat = positions();
  const packed = new Float32Array(VERTEX_COUNT * 4);
  for (let v = 0; v < VERTEX_COUNT; v++) packed.set(flat.slice(3 * v, 3 * v + 3), 4 * v);
  g.setAttribute(
    'position',
    new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(packed, 4), 3, 0),
  );
  g.setIndex(indices());
  setMorphs(g, false);
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(g, transparentMaterial());
  mesh.morphTargetInfluences = [0, 0];
  root.add(mesh);
  return { root, mesh, bones: [] };
}

function skinnedRelative(): TriangleRig {
  const g = geometry();
  const { index, weight } = skin();
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
  setMorphs(g, true);
  const rig = skinnedRig(g, false);
  rig.mesh.morphTargetInfluences = [0, 0];
  return rig;
}

function skinnedNormalized(): TriangleRig {
  const g = geometry();
  const { index, weight } = skin();
  // skinIndex and a normalized Uint8 skinWeight share one interleaved buffer, stride 8.
  const packed = new Uint8Array(VERTEX_COUNT * 8);
  for (let v = 0; v < VERTEX_COUNT; v++) {
    for (let k = 0; k < 4; k++) {
      packed[8 * v + k] = index[4 * v + k];
      packed[8 * v + 4 + k] = Math.round(weight[4 * v + k] * 255);
    }
  }
  const data = new THREE.InterleavedBuffer(packed, 8);
  g.setAttribute('skinIndex', new THREE.InterleavedBufferAttribute(data, 4, 0, false));
  g.setAttribute('skinWeight', new THREE.InterleavedBufferAttribute(data, 4, 4, true));
  g.morphAttributes.position = [new THREE.Float32BufferAttribute(morphTargets(false)[0], 3)];
  g.morphTargetsRelative = false;
  const rig = skinnedRig(g, true);
  rig.mesh.morphTargetInfluences = [0];
  return rig;
}

const IDENTITY = new THREE.Matrix4().toArray();

/** `IDENTITY` with some elements replaced. */
function identityWith(entries: Record<number, number>): number[] {
  const out = IDENTITY.slice();
  for (const [k, v] of Object.entries(entries)) out[Number(k)] = v;
  return out;
}

const Camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);

function orbitView(t: number): number[] {
  const angle = t * 0.6;
  Camera.position.set(2.2 * Math.sin(angle), 1 + 0.3 * Math.sin(t * 0.4), 2.2 * Math.cos(angle));
  Camera.lookAt(0, 0.9, 0);
  Camera.updateMatrixWorld(true);
  return Camera.matrixWorldInverse.toArray();
}

/** The motion every fixture shares; every tenth frame repeats the one before. */
function script(boneCount: number, morphCount: number, specials: boolean): TriangleFrame[] {
  const frames: TriangleFrame[] = [];
  for (let frame = 0; frame < TRIANGLE_FRAMES; frame++) {
    if (frame % 10 === 9) {
      frames.push({ ...frames[frame - 1], special: undefined });
      continue;
    }
    const t = frame / 60;
    const step: TriangleFrame = {
      root: [
        0.1 * Math.sin(t),
        0.05 * Math.sin(t * 1.3),
        0,
        0.2 * Math.sin(t * 0.7),
        0.8 * Math.sin(t * 0.9),
        0,
      ],
      bones: Array.from({ length: boneCount }, (_, i) => [
        0.4 * Math.sin(t * 1.1 + i),
        0.2 * Math.sin(t * 0.5 + 2 * i),
        0.3 * Math.sin(t * 0.8 - i),
      ]),
      influences: [Math.max(0, Math.sin(t * 1.3)), 0.8 * Math.max(0, Math.cos(t * 0.7))].slice(
        0,
        morphCount,
      ),
      view: orbitView(t),
    };
    if (frame === NAN_FRAME) {
      step.view = identityWith({ 14: Number.NaN });
      step.special = 'nan';
    }
    if (specials && frame === 100) {
      // Plane faces: depth +0 for the earlier face, −0 for the later one.
      step.root = [0, 0, 0, 0, 0, 0];
      step.meshWorld = identityWith({ 14: -0 });
      step.view = identityWith({ 14: -0 });
      step.special = 'signed-zero';
    }
    if (specials && frame === 101) {
      // Finite centroids whose depths overflow to ±Inf; the smallest stay finite.
      step.root = [0, 0, 0, 0, 0, 0];
      step.meshWorld = identityWith({ 10: 10 });
      step.view = identityWith({ 10: 1e308 });
      step.special = 'infinite';
    }
    frames.push(step);
  }
  return frames;
}

export const TRIANGLE_FIXTURES: readonly TriangleFixture[] = [
  { id: 'rigid', build: rigid, script: script(0, 0, true) },
  { id: 'rigid-morph-absolute', build: rigidMorphAbsolute, script: script(0, 2, false) },
  { id: 'skinned-relative', build: skinnedRelative, script: script(4, 2, false) },
  { id: 'skinned-normalized', build: skinnedNormalized, script: script(4, 1, false) },
];

/** Pose the rig and set the camera for one frame. */
export function applyTriangleFrame(
  rig: TriangleRig,
  camera: THREE.Camera,
  frame: TriangleFrame,
): void {
  const [px, py, pz, rx, ry, rz] = frame.root;
  rig.root.position.set(px, py, pz);
  rig.root.rotation.set(rx, ry, rz);
  for (const [i, [x, y, z]] of frame.bones.entries()) rig.bones[i].rotation.set(x, y, z);
  const influences = rig.mesh.morphTargetInfluences;
  if (influences) for (const [i, w] of frame.influences.entries()) influences[i] = w;
  rig.root.updateMatrixWorld(true);
  if (frame.meshWorld) rig.mesh.matrixWorld.fromArray(frame.meshWorld);
  camera.matrixWorldInverse.fromArray(frame.view);
}

/**
 * Run `fixture` through a `TransparentTriangleController`, calling `visit` with each frame's
 * step and the shell index the controller drew it with.
 */
export function runTriangleFixture(
  fixture: TriangleFixture,
  visit: (step: TriangleFrame, index: Uint32Array) => void,
): void {
  const rig = fixture.build();
  const camera = new THREE.PerspectiveCamera();
  const controller = new TransparentTriangleController(rig.root);
  controller.reconcile([{ key: fixture.id, mesh: rig.mesh }]);
  try {
    for (const step of fixture.script) {
      applyTriangleFrame(rig, camera, step);
      controller.withDraw(camera, () => {
        const index = rig.mesh.geometry.index;
        if (index === null) throw new Error('shell has no index');
        visit(step, Uint32Array.from(index.array));
      });
    }
  } finally {
    controller.dispose();
  }
}

/** The hash of one frame's shell index. */
export function triangleFrameHash(key: string, index: Uint32Array): string {
  return hashBytes(writeTriangles(new ByteWriter(), [{ key, index }]).bytes());
}

/** The hash of each frame of `fixture` as the controller draws it. */
export function triangleFrameHashes(fixture: TriangleFixture): string[] {
  const hashes: string[] = [];
  runTriangleFixture(fixture, (_step, index) => {
    hashes.push(triangleFrameHash(fixture.id, index));
  });
  return hashes;
}
