import * as THREE from 'three';
import type { AvatarDescriptor, FingerName, Vec3Tuple } from '@/engine/types';

interface FingerGeometryOverride {
  /** Additional hand-local offset for the proximal bone. */
  rootOffset?: Vec3Tuple;
  /** Additional parent-local offsets for the proximal, intermediate, and distal bones. */
  segmentOffsets?: readonly Vec3Tuple[];
}

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
  /**
   * Degrees the skin at the lips leans to face downward, as a real lower lip
   * does: the measured mouth's normal then no longer matches the face's forward.
   */
  lipTilt?: number;
  /** Include finger chains. Off produces a rig whose hands never curl. */
  fingers?: boolean;
  /** Off-axis leaf siblings exercise resolved finger-chain ordering. */
  fingerHelpers?: 'before' | 'after';
  /** Optional asymmetric finger geometry for calibrating hand-local solvers. */
  fingerGeometry?: Partial<Record<FingerName, FingerGeometryOverride>>;
  /** Include the optional bilateral hip-to-toe leg chains. */
  legs?: boolean;
  /** Include the optional bilateral arm twist helpers for profile resolution tests. */
  armTwistHelpers?: 'twist' | 'rotate';
  /** Include eye bones. Without them the profile cannot build a face frame. */
  eyes?: boolean;
  /**
   * How far behind the front of the face the eyes sit, in IPD. Left out, they
   * sit behind the head bone, over two IPD back from the skin, and a fixed face
   * anchor lands deep inside the head; a real avatar's lie under half an IPD to
   * one and a half back from its forehead.
   */
  eyeDepth?: number;
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
  /**
   * Split a built mesh into material slots, as `{ meshName: materialNames }`.
   * The triangles are shared out in order, one geometry group per name, as an
   * exporter leaves a mesh that carries several materials.
   */
  materialGroups?: Record<string, string[]>;
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
  hipOut: 0.08,
  hipDrop: 0.08,
  upperLeg: 0.25,
  lowerLeg: 0.24,
  kneeForward: 0.025,
  footToToe: 0.12,
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
    upperLeg: (s: string) => `UpperLeg_${s}`,
    lowerLeg: (s: string) => `LowerLeg_${s}`,
    foot: (s: string) => `Foot_${s}`,
    toe: (s: string) => `Toe_${s}`,
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
    upperLeg: (s: string) => (s === 'L' ? 'LeftUpperLeg' : 'RightUpperLeg'),
    lowerLeg: (s: string) => (s === 'L' ? 'LeftLowerLeg' : 'RightLowerLeg'),
    foot: (s: string) => (s === 'L' ? 'LeftFoot' : 'RightFoot'),
    toe: (s: string) => (s === 'L' ? 'LeftToes' : 'RightToes'),
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
    upperLeg: (s: string) => `J_Bip_${s}_UpperLeg`,
    lowerLeg: (s: string) => `J_Bip_${s}_LowerLeg`,
    foot: (s: string) => `J_Bip_${s}_Foot`,
    toe: (s: string) => `J_Bip_${s}_ToeBase`,
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
  /** World rest position of the face vertex the lip-sync shapes move most. */
  mouth: THREE.Vector3;
}

/**
 * Add a secondary-motion chain to an already-built synthetic rig.
 *
 * The humanoid fixture has no hair or tail by default because those are avatar
 * data rather than part of the profile's canonical skeleton. Tests that need
 * the secondary solver can graft a plausible chain onto an existing anchor,
 * keeping the same armature-scale and world-space guarantees as buildRig().
 */
export interface SyntheticChainOptions {
  /** Existing bone under which the chain root is attached. */
  parent: string;
  /** Name of the chain's first (simulated) bone. */
  root: string;
  /** Number of simulated links; one extra leaf bone is created for its tail. */
  joints?: number;
  /** Root offset from the parent, in metres. */
  rootOffset?: [number, number, number];
  /** Offset between successive bones, in metres. */
  segmentOffset?: [number, number, number];
}

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];

/**
 * The default thumb's joints in hand lengths: along the hand, toward the
 * index side, out of the palm. The mean of the two validation avatars' rest
 * thumbs, so the thumb reaches where a real one does: a thumb lying in the
 * palm plane never meets the face, and one drawn to the fingers' length is
 * the only point every face reach has to clear. The knuckle stands 0.04 further
 * out than the mean so the wrapped thumb lies across the fingers rather than
 * pointing out of the palm, as it does on both avatars.
 */
const THUMB_JOINTS: readonly Vec3Tuple[] = [
  [0.28, 0.21, 0.16],
  [0.58, 0.41, 0.31],
  [0.83, 0.52, 0.36],
];

/**
 * `THUMB_JOINTS` as the override the finger loop adds to its own placement,
 * less the along-hand step and fan `spread` that loop already puts in.
 */
function thumbRest(spread: number): Required<FingerGeometryOverride> & { rootOffset: Vec3Tuple } {
  const L = SEGMENTS.handToProximal;
  // Palm side is -y and the index side is -z on both hands of this rig.
  const joints = THUMB_JOINTS.map(
    ([along, radial, out]): Vec3Tuple => [L * along, -L * out, -L * radial],
  );
  const minus = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  return {
    rootOffset: minus(joints[0], [SEGMENTS.handToProximal, 0, spread]),
    segmentOffsets: [
      [0, 0, 0],
      minus(minus(joints[1], joints[0]), [SEGMENTS.phalanx, 0, 0]),
      minus(minus(joints[2], joints[1]), [SEGMENTS.phalanx, 0, 0]),
    ],
  };
}

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
  const legs = opts.legs ?? false;
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

  if (legs) {
    for (const side of ['L', 'R'] as const) {
      const sign = side === 'L' ? -1 : 1;
      const thigh = add(naming.upperLeg(side), hips, sign * S.hipOut, -S.hipDrop, 0);
      // The knee sits a little forward of the hip/ankle line so a bend pole
      // remains well-defined even in this otherwise straight synthetic pose.
      const shin = add(naming.lowerLeg(side), thigh, 0, -S.upperLeg, S.kneeForward);
      const foot = add(naming.foot(side), shin, 0, -S.lowerLeg, -S.kneeForward);
      add(naming.toe(side), foot, 0, 0, S.footToToe);
    }
  }

  if (eyes) {
    for (const side of ['L', 'R'] as const) {
      const sign = side === 'L' ? -1 : 1;
      const z =
        opts.eyeDepth === undefined
          ? S.eyeFwd
          : -(S.eyeFwd + (0.55 - opts.eyeDepth) * 2 * S.eyeOut);
      add(naming.eye(side), head, sign * S.eyeOut, S.eyeUp, z);
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

    if (opts.armTwistHelpers) {
      const family = opts.armTwistHelpers === 'twist' ? 'twist' : 'Rotate';
      const addHelper = (primary: THREE.Bone, next: THREE.Bone, name: string) => {
        const helper = new THREE.Bone();
        helper.name = name;
        helper.position.copy(next.position);
        if (opts.armTwistHelpers === 'rotate') helper.position.multiplyScalar(0.5);
        helper.rotation.set(0.13, -0.19, 0.07);
        primary.add(helper);
        bones.set(name, helper);
      };
      addHelper(upper, lower, `UpperArm_${family}_${side}`);
      addHelper(lower, hand, `LowerArm_${family}_${side}`);
    }

    if (!fingers) continue;
    for (const [fi, f] of FINGERS.entries()) {
      // Fanned across the palm so the curl axes are not degenerate.
      const spread = (fi - 2) * 0.012;
      const given = opts.fingerGeometry?.[f.toLowerCase() as FingerName];
      const base = f === 'Thumb' ? thumbRest(spread) : undefined;
      const sum = (a?: Vec3Tuple, b?: Vec3Tuple): Vec3Tuple | undefined =>
        a && b ? [a[0] + b[0], a[1] + b[1], a[2] + b[2]] : (a ?? b);
      const geometry: FingerGeometryOverride | undefined = base
        ? {
            rootOffset: sum(base.rootOffset, given?.rootOffset),
            segmentOffsets: base.segmentOffsets.map(
              (o, i) => sum(o, given?.segmentOffsets?.[i]) ?? o,
            ),
          }
        : given;
      let parent: THREE.Object3D = hand;
      for (let i = 0; i < 3; i++) {
        const segmentOffset = geometry?.segmentOffsets?.[i];
        const rootOffset = i === 0 ? geometry?.rootOffset : undefined;
        parent = add(
          naming.finger(f, side, i),
          parent,
          sign * (i === 0 ? S.handToProximal : S.phalanx) +
            sign * ((rootOffset?.[0] ?? 0) + (segmentOffset?.[0] ?? 0)),
          (rootOffset?.[1] ?? 0) + (segmentOffset?.[1] ?? 0),
          (i === 0 ? spread : 0) + (rootOffset?.[2] ?? 0) + (segmentOffset?.[2] ?? 0),
        );
      }
    }
  }

  if (opts.fingerHelpers) {
    for (const side of ['L', 'R'] as const) {
      for (const finger of ['Thumb', 'Index'] as const) {
        for (const i of [0, 1]) {
          const parent = bones.get(naming.finger(finger, side, i));
          if (!parent) throw new Error('missing synthetic finger');
          const helper = new THREE.Bone();
          helper.name = `FingerHelper_${finger}_${side}_${i}`;
          helper.position.set(0, 0.02 / scale, 0.01 / scale);
          parent.add(helper);
          if (opts.fingerHelpers === 'before') {
            parent.children.splice(parent.children.indexOf(helper), 1);
            parent.children.unshift(helper);
          }
        }
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
  // A head the size of the face frame drawn through it: ears at 1.25 IPD, the
  // chin 1.85 IPD below the eyes, the crown bone on top. Wider than that and a
  // hand placed on a face anchor measures as inside the head.
  const headAt = head.getWorldPosition(new THREE.Vector3());
  const headY = headAt.y;
  const ipd = 2 * S.eyeOut;
  const ring: RingShape = {
    rx: 1.25 * ipd,
    rz: S.eyeFwd + 0.55 * ipd,
    top: headY + S.headToCrown,
    bottom: headY + S.eyeUp - 1.85 * ipd,
  };
  // The lips: on the face's front, where the profile's frame points, in the
  // band nearest the height the anchor table gives a mouth. The visemes move
  // this patch and nothing else, as a real face's do.
  const band = Math.round(
    ((headY + S.eyeUp - 1.25 * ipd - ring.bottom) / (ring.top - ring.bottom)) * (RING_BANDS - 1),
  );
  ring.mouth = { band, sector: (3 * RING_SECTORS) / 4 };
  ring.lipTilt = opts.lipTilt ?? 0;
  const mouth = new THREE.Vector3(
    headAt.x,
    ring.bottom + (band / (RING_BANDS - 1)) * (ring.top - ring.bottom),
    headAt.z - ring.rz,
  );
  meshes.set('Face', makeMesh('Face', skeleton, head, faceShapes, root, scale, deltas, ring));
  // The trunk is measured between the hips and the shoulders, so that is the
  // height the body's ring has to cover.
  const shoulder = bones.get(naming.upperArm('R')) ?? chest;
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
      {
        rx: 0.11,
        rz: 0.11 * 0.62,
        top: shoulder.getWorldPosition(new THREE.Vector3()).y,
        bottom: hips.getWorldPosition(new THREE.Vector3()).y,
      },
    ),
  );
  for (const g of opts.garments ?? []) {
    meshes.set(g, makeMesh(g, skeleton, chest, [], root, scale, deltas));
  }
  for (const [name, materials] of Object.entries(opts.materialGroups ?? {})) {
    const mesh = meshes.get(name);
    if (!mesh) throw new Error(`the rig has no mesh ${name}`);
    splitMaterials(mesh, materials);
  }

  const descriptor: AvatarDescriptor = {
    id: 'synthetic',
    label: { en: 'Synthetic rig', ja: '合成リグ' },
    url: '/models/synthetic.glb',
    ...(opts.separator === 'asterisk' ? { separator: /^\*{3,}(.+?)\*{3,}$/ } : {}),
  };

  return { root, bones, meshes, descriptor, mouth };
}

/**
 * Graft a straight chain onto a synthetic humanoid.
 *
 * `Spring` simulates every bone that has a child, so creating one extra leaf
 * makes the requested number of links observable without inventing a terminal
 * point outside the real bone hierarchy.
 */
export function addBoneChain(rig: SyntheticRig, opts: SyntheticChainOptions): string[] {
  const parent = rig.bones.get(opts.parent);
  if (!parent) throw new Error(`the rig has no ${opts.parent}`);

  const scale = rig.root.scale.x || 1;
  const joints = opts.joints ?? 3;
  if (!Number.isInteger(joints) || joints < 1) {
    throw new Error('a synthetic chain needs at least one joint');
  }

  const rootOffset = opts.rootOffset ?? [0, -0.025, 0.03];
  const segmentOffset = opts.segmentOffset ?? [0, -0.08, 0.02];
  const names: string[] = [];
  let attach: THREE.Object3D = parent;

  for (let i = 0; i <= joints; i++) {
    const name = i === 0 ? opts.root : `${opts.root}_${i}`;
    const offset = i === 0 ? rootOffset : segmentOffset;
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(offset[0] / scale, offset[1] / scale, offset[2] / scale);
    attach.add(bone);
    rig.bones.set(name, bone);
    names.push(name);
    attach = bone;
  }

  rig.root.updateMatrixWorld(true);
  return names;
}

/** An elliptic ring's half-widths across and fore-aft, and the world heights it runs between. */
interface RingShape {
  rx: number;
  rz: number;
  top: number;
  bottom: number;
  /** The ring vertex the visemes move, with half as much on its four neighbours. */
  mouth?: { band: number; sector: number };
  /** Degrees the lip band's skin leans downward; the lip vertices themselves stay put. */
  lipTilt?: number;
}

const RING_BANDS = 16;
const RING_SECTORS = 16;

/**
 * A skinned mesh whose vertices sit in a ring around one bone.
 *
 * Enough geometry for the anatomy layer's volume measurement to find a surface
 * and for the morph routing to have somewhere to land. Weighted entirely to one
 * bone, because the measurement filters on the *dominant* bone and a blended
 * seam vertex is not evidence about where a surface is.
 *
 * As many sectors as the measurement bins, and rows close enough to fill most
 * of its height bands over the trunk's fixed hips-to-shoulders range. Sparser
 * than that the measurement rejects the ring and falls back to a round
 * cylinder sized off the shoulders — twice as deep as this ellipse, with every
 * forearm brought to the face reading as inside it.
 */
function makeMesh(
  name: string,
  skeleton: THREE.Skeleton,
  bone: THREE.Bone,
  shapeNames: string[],
  root: THREE.Object3D,
  scale: number,
  deltas: Record<string, number> = {},
  shape: RingShape | null = null,
): THREE.SkinnedMesh {
  const bands = RING_BANDS;
  const sectors = RING_SECTORS;
  const count = bands * sectors;

  const position = new Float32Array(count * 3);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const boneIndex = skeleton.bones.indexOf(bone);

  const origin = bone.getWorldPosition(new THREE.Vector3());
  // A chest is wider than it is deep, which is the whole reason the volume is
  // measured per sector rather than taken as one radius; unshaped, a garment
  // ring takes that chest's proportions 0.3 m about its bone.
  const rx = (shape?.rx ?? 0.11) / scale;
  const rz = (shape?.rz ?? 0.11 * 0.62) / scale;
  const top = (shape?.top ?? origin.y + 0.15) / scale;
  const bottom = (shape?.bottom ?? origin.y - 0.15) / scale;
  for (let b = 0; b < bands; b++) {
    for (let s = 0; s < sectors; s++) {
      const i = b * sectors + s;
      const a = (s / sectors) * Math.PI * 2;
      position[i * 3] = origin.x / scale + Math.cos(a) * rx;
      position[i * 3 + 1] = bottom + (b / (bands - 1)) * (top - bottom);
      position[i * 3 + 2] = origin.z / scale + Math.sin(a) * rz;
      skinIndex[i * 4] = boneIndex;
      skinWeight[i * 4] = 1;
    }
  }

  // The bands either side of the lips swing fore and aft, leaving the lips where
  // the front ray hits them while tilting the triangles around them.
  if (shape?.mouth && shape.lipTilt) {
    const { band: b, sector: s } = shape.mouth;
    const dz = ((top - bottom) / (bands - 1)) * Math.tan((shape.lipTilt * Math.PI) / 180);
    for (let k = s - 2; k <= s + 2; k++) {
      position[((b + 1) * sectors + k) * 3 + 2] -= dz;
      position[((b - 1) * sectors + k) * 3 + 2] += dz;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  // Rings joined into a closed band, wound to face outward, so the skin has a
  // surface to be inside of.
  const faces: number[] = [];
  for (let b = 0; b + 1 < bands; b++) {
    for (let s = 0; s < sectors; s++) {
      const i = b * sectors + s;
      const j = b * sectors + ((s + 1) % sectors);
      faces.push(i, i + sectors, j, i + sectors, j + sectors, j);
    }
  }
  geometry.setIndex(faces);

  const lipPatch = shape?.mouth ?? null;
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
      const lips = lipPatch && VISEME_SHAPES.includes(shape) ? lipPatch : null;
      if (lips) {
        const { band: b, sector: s } = lips;
        delta[(b * sectors + s) * 3 + 1] = dy;
        for (const [nb, ns] of [
          [b - 1, s],
          [b + 1, s],
          [b, s - 1],
          [b, s + 1],
        ]) {
          delta[(nb * sectors + ns) * 3 + 1] = dy / 2;
        }
      } else {
        for (let i = 0; i < count; i++) delta[i * 3 + 1] = dy;
      }
      targets.push(new THREE.BufferAttribute(delta, 3));
    });
    geometry.morphAttributes.position = targets;
    // Deltas, as glTF stores them; three reads them as absolute positions otherwise.
    geometry.morphTargetsRelative = true;
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

/** Give `mesh` one named material per entry, each over an even share of its triangles. */
function splitMaterials(mesh: THREE.SkinnedMesh, names: string[]): void {
  const index = mesh.geometry.getIndex();
  if (!index || names.length === 0) throw new Error(`cannot split ${mesh.name} into materials`);
  const triangles = index.count / 3;
  mesh.geometry.clearGroups();
  for (let k = 0; k < names.length; k++) {
    const start = Math.floor((k * triangles) / names.length) * 3;
    const end = Math.floor(((k + 1) * triangles) / names.length) * 3;
    mesh.geometry.addGroup(start, end - start, k);
  }
  (mesh.material as THREE.Material).dispose();
  mesh.material = names.map((name) => new THREE.MeshBasicMaterial({ name }));
}

/**
 * Interpose a bone between `child` and its parent without moving anything.
 *
 * Some rigs carry a carrier bone inside an arm link — a twist segment between
 * the upper arm and the forearm — so the next canonical bone's parent is not
 * the previous canonical bone. The new bone sits `fraction` of the way along the
 * link with its own non-identity rotation, and `child` keeps its world rest
 * transform.
 */
export function interposeBone(
  rig: SyntheticRig,
  child: string,
  name: string,
  rotation: [number, number, number],
  fraction = 0.5,
): THREE.Bone {
  const bone = rig.bones.get(child);
  const parent = bone?.parent;
  if (!(bone && parent)) throw new Error(`the rig has no parented ${child}`);
  rig.root.updateMatrixWorld(true);
  const carrier = new THREE.Bone();
  carrier.name = name;
  carrier.position.copy(bone.position).multiplyScalar(fraction);
  carrier.rotation.set(...rotation);
  parent.add(carrier);
  carrier.updateMatrixWorld(true);
  carrier.attach(bone);
  rig.bones.set(name, carrier);
  rig.root.updateMatrixWorld(true);
  return carrier;
}
