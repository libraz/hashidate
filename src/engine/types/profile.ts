import type * as THREE from 'three';
import type { JointTable } from './anatomy';
import type { AvatarDescriptor } from './avatar';
import type { BoneSlot, FingerKey, VisemeName, VrmEmotionName } from './primitives';

/**
 * The resolved avatar: canonical slots on one side, this model's own names on
 * the other. Built by `profile/`, read by everything below the director.
 */

/** One place a shape name lands. A name may live on several meshes. */
export interface MorphTarget {
  mesh: THREE.Mesh;
  index: number;
}

/**
 * How far the gaze chain may turn, in radians.
 *
 * Avatar data: the usable range is a property of how the eye is drawn, and a
 * toon eye whose iris nearly fills its opening has almost no travel before
 * sclera appears.
 */
export interface GazeLimits {
  eyeYaw: number;
  eyePitch: number;
  headYaw: number;
  headPitch: number;
  neckYaw: number;
  neckPitch: number;
}

/**
 * A right/up/forward frame for the head, in head-local space, plus the
 * interpupillary distance the face anchors are measured in.
 */
export interface FaceFrame {
  origin: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
  ipd: number;
}

/** The torso frame, in chest-local space. `span` is trunk half-width plus arm. */
export interface BodyFrame {
  right: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
  span?: number | null;
}

export interface BlinkShapes {
  both: string | null;
  L: string | null;
  R: string | null;
}

export interface ArkitSupport {
  /** 52 minus tongueOut is normal for Japanese avatars, so the bar is 45. */
  supported: boolean;
  count: number;
  names: Set<string>;
}

/**
 * The resolved avatar.
 *
 * The runtime never names a bone or a blendshape directly; it asks the profile
 * for a canonical slot and the profile answers in this avatar's terms. Swapping
 * avatars means swapping this object.
 */
export interface Profile {
  /** The loaded GLB scene, kept so anatomy can measure the body's actual shape. */
  root: THREE.Object3D;
  avatar: AvatarDescriptor;
  bones: Partial<Record<BoneSlot, THREE.Bone>>;
  fingerBones: Partial<Record<FingerKey, THREE.Bone[]>>;
  morphTargets: Map<string, MorphTarget[]>;
  faceMeshes: THREE.Mesh[];
  /** Flat name → index view, for the HUD. Routing goes through `morphTargets`. */
  dict: Record<string, number>;
  viseme: Partial<Record<VisemeName, string>>;
  vrmEmotion: Partial<Record<VrmEmotionName, string>>;
  blink: BlinkShapes;
  arkit: ArkitSupport;
  /** Which world X is the character's left. Derived, never assumed. */
  sideSign: number;
  /** Bone-local direction toward the next link, per slot and per finger segment. */
  restDir: Record<string, THREE.Vector3>;
  /** Shape groups discovered from the author's separator shapes. */
  groups: Map<string, string[]>;
  face: FaceFrame | null;
  body: BodyFrame | null;
  /** World-unit segment lengths: `upper.L`, `lower.R`, `tip.L.index`, … */
  limb: Record<string, number>;
  /** Everything auto-detection could not resolve, for reporting rather than throwing. */
  missing: string[];
  gaze: GazeLimits;
  /** Present only where the avatar overrides the human joint table. */
  anatomy?: JointTable;
}
