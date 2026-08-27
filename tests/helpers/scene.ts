import * as THREE from 'three';
import type { AvatarDescriptor } from '@/engine/types';

/**
 * A synthetic avatar, built in code.
 *
 * The runtime's hardest layers — the profile's name resolution, the rig's
 * solver, the wardrobe's mesh routing — all take a loaded GLB and there is no
 * GLB in a unit test. Nor should there be: the two real avatars are 12–16 MB
 * each, they are git-ignored purchased assets, and a suite that needs them can
 * only run on a machine that has bought them.
 *
 * So the tests build a rig instead. It is deliberately *plausible* rather than
 * minimal — a real bone hierarchy with real world positions, an armature scale,
 * skin weights and morph targets — because most of the bugs these layers have
 * had came from exactly those details: a local translation read as a world
 * length, a shape name found on the wrong mesh, a chain resolved under two
 * naming families at once.
 */

export interface RigOptions {
  /**
   * Which naming family to build. The profile resolves several, and getting a
   * test to pass under one proves nothing about the others.
   */
  naming?: 'vrchat' | 'unity' | 'vrm';
  /**
   * Metres per local unit at the armature. The first validation avatar is
   * authored in centimetres under a 0.01 scale, which broke every measurement
   * that read a local translation as a world distance.
   */
  armatureScale?: number;
  /** Include finger chains. Off produces a rig whose hands never curl. */
  fingers?: boolean;
  /** Include eye bones. Without them the profile cannot build a face frame. */
  eyes?: boolean;
  /** Shape groups to write, as `[groupLabel, shapeNames]`. */
  groups?: Array<[string, string[]]>;
  /** Extra shapes with no group above them — the body's fitting shapes. */
  ungrouped?: string[];
  /** How the group separator shapes are spelled. */
  separator?: 'underscore' | 'asterisk';
  /** Include the ARKit 52 set on the face mesh. */
  arkit?: boolean;
  /** Garment meshes to add, by name. */
  garments?: string[];
  /**
   * Delta length for named shapes, overriding the default per-index one.
   *
   * The measurements the face layer makes are projections of one shape's deltas
   * onto another's, so what a shape is worth relative to its neighbours is the
   * whole input. Stating it beats arranging shapes until the index arithmetic
   * happens to produce the ratio a test needs.
   */
  deltas?: Record<string, number>;
}

/**
 * Segment lengths in metres.
 *
 * A stylised figure of the kind this runtime is actually pointed at, and the
 * neck is the part that matters. These avatars have large heads on short necks,
 * so the mouth sits about three tenths of a full arm's reach from the shoulder;
 * an adult's is nearer six. Every hand-to-face pose lives or dies on that ratio
 * — at three tenths the elbow has to fold almost to its stop to arrive, and the
 * wrist has almost no angle left to spend, which is where the poses that read
 * as broken come from.
 *
 * Built with an adult's neck, the fixture could not reproduce any of it: poses
 * that put the wrist a hundred degrees past its stop on both validation avatars
 * measured comfortable here, because the face was twice as far away.
 */
const SEGMENTS = {
  hipsToSpine: 0.09,
  spineToChest: 0.13,
  chestToNeck: 0.09,
  neckToHead: 0.04,
  headToCrown: 0.13,
  shoulderOut: 0.05,
  clavicleOut: 0.11,
  upperArm: 0.17,
  lowerArm: 0.15,
  handToProximal: 0.05,
  phalanx: 0.025,
  eyeOut: 0.032,
  eyeUp: 0.03,
  eyeFwd: 0.055,
};

const NAMES = {
  vrchat: {
    hips: 'Hips',
    spine: 'Spine',
    chest: 'UpperChest',
    lowerChest: 'Chest',
    neck: 'Neck',
    head: 'Head',
    eye: (s: string) => `Eye_${s}`,
    shoulder: (s: string) => `Shoulder_${s}`,
    upperArm: (s: string) => `UpperArm_${s}`,
    lowerArm: (s: string) => `LowerArm_${s}`,
    hand: (s: string) => `Hand_${s}`,
    finger: (f: string, s: string, i: number) =>
      `${f}${['Proximal', 'Intermediate', 'Distal'][i]}_${s}`,
  },
  unity: {
    hips: 'Hips',
    spine: 'Spine',
    chest: 'Chest',
    lowerChest: null,
    neck: 'Neck',
    head: 'Head',
    eye: (s: string) => (s === 'L' ? 'LeftEye' : 'RightEye'),
    shoulder: (s: string) => (s === 'L' ? 'LeftShoulder' : 'RightShoulder'),
    upperArm: (s: string) => (s === 'L' ? 'LeftUpperArm' : 'RightUpperArm'),
    lowerArm: (s: string) => (s === 'L' ? 'LeftLowerArm' : 'RightLowerArm'),
    hand: (s: string) => (s === 'L' ? 'LeftHand' : 'RightHand'),
    finger: (f: string, s: string, i: number) => `${s === 'L' ? 'Left' : 'Right'}Hand${f}${i + 1}`,
  },
  vrm: {
    hips: 'J_Bip_C_Hips',
    spine: 'J_Bip_C_Spine',
    chest: 'J_Bip_C_UpperChest',
    lowerChest: 'J_Bip_C_Chest',
    neck: 'J_Bip_C_Neck',
    head: 'J_Bip_C_Head',
    eye: (s: string) => `J_Bip_${s}_Eye`,
    shoulder: (s: string) => `J_Bip_${s}_Shoulder`,
    upperArm: (s: string) => `J_Bip_${s}_UpperArm`,
    lowerArm: (s: string) => `J_Bip_${s}_LowerArm`,
    hand: (s: string) => `J_Bip_${s}_Hand`,
    finger: (f: string, s: string, i: number) => `J_Bip_${s}_${f}${i + 1}`,
  },
} as const;

export const ARKIT_SHAPES = `eyeBlinkLeft eyeLookDownLeft eyeLookInLeft eyeLookOutLeft eyeLookUpLeft
eyeSquintLeft eyeWideLeft eyeBlinkRight eyeLookDownRight eyeLookInRight eyeLookOutRight eyeLookUpRight
eyeSquintRight eyeWideRight jawForward jawLeft jawRight jawOpen mouthClose mouthFunnel mouthPucker
mouthLeft mouthRight mouthSmileLeft mouthSmileRight mouthFrownLeft mouthFrownRight mouthDimpleLeft
mouthDimpleRight mouthStretchLeft mouthStretchRight mouthRollLower mouthRollUpper mouthShrugLower
mouthShrugUpper mouthPressLeft mouthPressRight mouthLowerDownLeft mouthLowerDownRight mouthUpperUpLeft
mouthUpperUpRight browDownLeft browDownRight browInnerUp browOuterUpLeft browOuterUpRight cheekPuff
cheekSquintLeft cheekSquintRight noseSneerLeft noseSneerRight`.split(/\s+/);

export const VISEME_SHAPES = [
  'vrc.v_aa',
  'vrc.v_ih',
  'vrc.v_ou',
  'vrc.v_e',
  'vrc.v_oh',
  'vrc.v_nn',
];

export interface SyntheticRig {
  /** The armature root, which carries the scale. Pass this as the profile root. */
  root: THREE.Group;
  bones: Map<string, THREE.Bone>;
  /** Every mesh built, by name. */
  meshes: Map<string, THREE.SkinnedMesh>;
  /** A descriptor that matches what was built. */
  descriptor: AvatarDescriptor;
}

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];

/**
 * Build a synthetic avatar.
 *
 * World positions are what the profile and the rig actually measure, so the
 * hierarchy is laid out in metres and then divided by `armatureScale` on the way
 * into the local translations — the same arrangement the real avatars have, and
 * the one that catches a length read from the wrong space.
 */
export function buildRig(opts: RigOptions = {}): SyntheticRig {
  const naming = NAMES[opts.naming ?? 'vrchat'];
  const scale = opts.armatureScale ?? 1;
  const fingers = opts.fingers ?? true;
  const eyes = opts.eyes ?? true;

  const bones = new Map<string, THREE.Bone>();
  const root = new THREE.Group();
  root.name = 'Armature';
  root.scale.setScalar(scale);

  /** Add a bone under `parent` at a world-space offset given in metres. */
  const add = (name: string, parent: THREE.Object3D, dx: number, dy: number, dz: number) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(dx / scale, dy / scale, dz / scale);
    parent.add(bone);
    bones.set(name, bone);
    return bone;
  };

  const S = SEGMENTS;
  const hips = add(naming.hips, root, 0, 0.9, 0);
  const spine = add(naming.spine, hips, 0, S.hipsToSpine, 0);
  // Where the family has both, the lower chest sits between spine and chest so
  // the "UpperChest before Chest" preference has something to get wrong.
  const chestParent = naming.lowerChest
    ? add(naming.lowerChest, spine, 0, S.spineToChest * 0.5, 0)
    : spine;
  const chest = add(
    naming.chest,
    chestParent,
    0,
    naming.lowerChest ? S.spineToChest * 0.5 : S.spineToChest,
    0,
  );
  const neck = add(naming.neck, chest, 0, S.chestToNeck, 0);
  const head = add(naming.head, neck, 0, S.neckToHead, 0);
  add('Crown', head, 0, S.headToCrown, 0);

  if (eyes) {
    for (const side of ['L', 'R'] as const) {
      const sign = side === 'L' ? -1 : 1;
      add(naming.eye(side), head, sign * S.eyeOut, S.eyeUp, S.eyeFwd);
    }
  }

  for (const side of ['L', 'R'] as const) {
    // Character-left is world -x, which is what the profile derives `sideSign`
    // from rather than assuming.
    const sign = side === 'L' ? -1 : 1;
    const clav = add(naming.shoulder(side), chest, sign * S.shoulderOut, S.chestToNeck * 0.55, 0);
    const upper = add(naming.upperArm(side), clav, sign * S.clavicleOut, 0, 0);
    const lower = add(naming.lowerArm(side), upper, sign * S.upperArm, 0, 0);
    const hand = add(naming.hand(side), lower, sign * S.lowerArm, 0, 0);

    if (!fingers) continue;
    for (const [fi, f] of FINGERS.entries()) {
      // Fanned across the palm so the curl axes are not degenerate.
      const spread = (fi - 2) * 0.012;
      let parent: THREE.Object3D = hand;
      for (let i = 0; i < 3; i++) {
        parent = add(
          naming.finger(f, side, i),
          parent,
          sign * (i === 0 ? S.handToProximal : S.phalanx),
          0,
          i === 0 ? spread : 0,
        );
      }
    }
  }

  root.updateMatrixWorld(true);

  // --- meshes ---------------------------------------------------------------

  const boneList = [...bones.values()];
  const skeleton = new THREE.Skeleton(boneList);
  const meshes = new Map<string, THREE.SkinnedMesh>();

  const separator =
    (opts.separator ?? 'underscore') === 'asterisk'
      ? (g: string) => `**********${g}**********`
      : (g: string) => `___${g}___`;

  const faceShapes: string[] = [];
  if (opts.arkit ?? true) faceShapes.push(...ARKIT_SHAPES);
  faceShapes.push(...VISEME_SHAPES, 'blink', 'blinkLeft', 'blinkRight');
  for (const [group, names] of opts.groups ?? []) {
    faceShapes.push(separator(group), ...names);
  }

  const deltas = opts.deltas ?? {};
  meshes.set('Face', makeMesh('Face', skeleton, head, faceShapes, root, scale, deltas));
  meshes.set(
    'Body',
    makeMesh(
      'Body',
      skeleton,
      chest,
      opts.ungrouped ?? ['NeckHide', 'BustHide'],
      root,
      scale,
      deltas,
    ),
  );
  for (const g of opts.garments ?? []) {
    meshes.set(g, makeMesh(g, skeleton, chest, [], root, scale, deltas));
  }

  const descriptor: AvatarDescriptor = {
    id: 'synthetic',
    label: { en: 'Synthetic rig', ja: '合成リグ' },
    url: '/models/synthetic.glb',
    ...(opts.separator === 'asterisk' ? { separator: /^\*{3,}(.+?)\*{3,}$/ } : {}),
  };

  return { root, bones, meshes, descriptor };
}

/**
 * A skinned mesh whose vertices sit in a ring around one bone.
 *
 * Enough geometry for the anatomy layer's volume measurement to find a surface
 * and for the morph routing to have somewhere to land. Weighted entirely to one
 * bone, because the measurement filters on the *dominant* bone and a blended
 * seam vertex is not evidence about where a surface is.
 */
function makeMesh(
  name: string,
  skeleton: THREE.Skeleton,
  bone: THREE.Bone,
  shapeNames: string[],
  root: THREE.Object3D,
  scale: number,
  deltas: Record<string, number> = {},
): THREE.SkinnedMesh {
  const bands = 8;
  const sectors = 12;
  const radius = 0.11 / scale;
  const height = 0.3 / scale;
  const count = bands * sectors;

  const position = new Float32Array(count * 3);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const boneIndex = skeleton.bones.indexOf(bone);

  const origin = bone.getWorldPosition(new THREE.Vector3());
  for (let b = 0; b < bands; b++) {
    for (let s = 0; s < sectors; s++) {
      const i = b * sectors + s;
      const a = (s / sectors) * Math.PI * 2;
      // A chest is wider than it is deep, which is the whole reason the volume
      // is measured per sector rather than taken as one radius.
      position[i * 3] = origin.x / scale + Math.cos(a) * radius;
      position[i * 3 + 1] = origin.y / scale + (b / (bands - 1) - 0.5) * height;
      position[i * 3 + 2] = origin.z / scale + Math.sin(a) * radius * 0.62;
      skinIndex[i * 4] = boneIndex;
      skinWeight[i * 4] = 1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));

  if (shapeNames.length) {
    const dictionary: Record<string, number> = {};
    const influences: number[] = [];
    const targets: THREE.BufferAttribute[] = [];
    shapeNames.forEach((shape, index) => {
      dictionary[shape] = index;
      influences.push(0);
      // A distinct delta per shape, so a projection of one onto another — which
      // is how a preset's lid closure is measured — has something to find.
      const delta = new Float32Array(count * 3);
      const dy = deltas[shape] ?? ((index % 7) + 1) * 1e-3;
      for (let i = 0; i < count; i++) delta[i * 3 + 1] = dy;
      targets.push(new THREE.BufferAttribute(delta, 3));
    });
    geometry.morphAttributes.position = targets;
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({ name }));
    mesh.name = name;
    mesh.morphTargetDictionary = dictionary;
    mesh.morphTargetInfluences = influences;
    mesh.bind(skeleton);
    root.add(mesh);
    root.updateMatrixWorld(true);
    return mesh;
  }

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({ name }));
  mesh.name = name;
  mesh.bind(skeleton);
  root.add(mesh);
  root.updateMatrixWorld(true);
  return mesh;
}
