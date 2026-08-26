/**
 * Name tables for auto-detection.
 *
 * Nothing here touches the scene: these are the candidate names, patterns and
 * vocabularies the resolution passes in `bones.ts`, `morphs.ts` and `index.ts`
 * try against one particular avatar. Order inside a list is load-bearing —
 * candidates run most specific first.
 */

import type { BlinkShapes, BoneSlot, GazeLimits, Side, VisemeName, VrmEmotionName } from '../types';

// Candidate names per canonical bone slot, most specific first.
export const BONE_CANDIDATES: Record<BoneSlot, string[]> = {
  hips: ['Hips', 'hips', 'J_Bip_C_Hips'],
  spine: ['Spine', 'spine', 'J_Bip_C_Spine'],
  // UpperChest first: when a rig has both, it is the one the arms hang off, and
  // aiming an arm from the lower Chest silently drops a link out of the chain.
  chest: ['UpperChest', 'Chest', 'chest', 'J_Bip_C_UpperChest', 'J_Bip_C_Chest'],
  neck: ['Neck', 'neck', 'J_Bip_C_Neck'],
  head: ['Head', 'head', 'J_Bip_C_Head'],
  'eye.L': ['Eye_L', 'LeftEye', 'J_Bip_L_Eye'],
  'eye.R': ['Eye_R', 'RightEye', 'J_Bip_R_Eye'],
  'shoulder.L': ['Shoulder_L', 'LeftShoulder', 'J_Bip_L_Shoulder'],
  'shoulder.R': ['Shoulder_R', 'RightShoulder', 'J_Bip_R_Shoulder'],
  'upperArm.L': ['UpperArm_L', 'LeftUpperArm', 'J_Bip_L_UpperArm'],
  'upperArm.R': ['UpperArm_R', 'RightUpperArm', 'J_Bip_R_UpperArm'],
  'lowerArm.L': ['LowerArm_L', 'LeftLowerArm', 'J_Bip_L_LowerArm'],
  'lowerArm.R': ['LowerArm_R', 'RightLowerArm', 'J_Bip_R_LowerArm'],
  'hand.L': ['Hand_L', 'LeftHand', 'J_Bip_L_Hand'],
  'hand.R': ['Hand_R', 'RightHand', 'J_Bip_R_Hand'],
};

/** Fingers as the naming patterns spell them; the profile keys them lowercase. */
export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;

export type FingerCandidate = (typeof FINGERS)[number];

export const SEGMENTS = ['Proximal', 'Intermediate', 'Distal'];

/**
 * Finger naming has no standard whatsoever, and unlike the body bones a wrong
 * guess is silent: the hand simply never curls. Each entry below is a whole
 * family of rigs. A chain is accepted only if it resolves under a single
 * pattern, so a stray name from another family cannot build half a hand.
 */
export const FINGER_ALIASES: Record<FingerCandidate, string[]> = {
  Thumb: ['Thumb'],
  Index: ['Index'],
  Middle: ['Middle'],
  Ring: ['Ring'],
  Little: ['Little', 'Pinky'],
};

/** One rig family's spelling of a finger segment. */
export type FingerPattern = (finger: string, side: Side, index: number) => string;

export const FINGER_PATTERNS: FingerPattern[] = [
  (f, side, i) => `${f}${SEGMENTS[i]}_${side}`, // VRChat / Unity export
  (f, side, i) => `${f}_${SEGMENTS[i]}_${side}`,
  (f, side, i) => `J_Bip_${side}_${f}${i + 1}`, // VRM 0.x
  (f, side, i) => `${side === 'L' ? 'Left' : 'Right'}Hand${f}${i + 1}`, // Mixamo
  (f, side, i) => `${side === 'L' ? 'Left' : 'Right'} ${f} ${SEGMENTS[i]}`,
  (f, side, i) => `${f}${i + 1}_${side}`,
];

// Explicit viseme shapes, preferred over composing mouth shapes from ARKit.
// Artist-authored visemes read better than anything we can synthesise.
export const VISEME_CANDIDATES: Record<VisemeName, string[]> = {
  a: ['aa', 'vrc.v_aa', 'A', 'あ'],
  i: ['ih', 'vrc.v_ih', 'I', 'い'],
  u: ['ou', 'vrc.v_ou', 'U', 'う'],
  e: ['ee', 'vrc.v_e', 'vrc.v_ee', 'E', 'え'],
  o: ['oh', 'vrc.v_oh', 'O', 'お'],
  n: ['vrc.v_nn', 'N', 'ん'],
  sil: ['vrc.v_sil', 'sil'],
};

export const VRM_EMOTION_CANDIDATES: Record<VrmEmotionName, string[]> = {
  neutral: ['neutral'],
  joy: ['happy', 'joy', 'fun'],
  anger: ['angry', 'anger'],
  sadness: ['sad', 'sorrow'],
  relaxed: ['relaxed'],
  surprise: ['surprised', 'surprise'],
};

/** Blink shapes, per canonical slot. */
export const BLINK_CANDIDATES: Record<keyof BlinkShapes, string[]> = {
  both: ['blink', 'Blink', 'vrc.Blink'],
  L: ['eyeBlinkLeft', 'blinkLeft', 'Blink_L'],
  R: ['eyeBlinkRight', 'blinkRight', 'Blink_R'],
};

/**
 * How far the gaze chain may turn, in radians.
 *
 * Avatar data, not engine data: the usable range is a property of how the eye
 * is drawn, and a toon eye whose iris nearly fills its opening has almost no
 * travel before sclera appears. An avatar states its own measured figures in
 * its descriptor; these are the conservative fallback for one that has not been
 * measured yet, and they are deliberately tight — an eye that under-travels
 * reads as reserved, one that over-travels reads as broken.
 */
export const DEFAULT_GAZE_LIMITS: GazeLimits = {
  eyeYaw: 0.07,
  eyePitch: 0.05,
  headYaw: 0.5,
  headPitch: 0.32,
  neckYaw: 0.3,
  neckPitch: 0.22,
};

/**
 * Which bone each link aims at. The direction a limb "points" is the direction
 * toward the next bone in the chain, and the profile already knows that chain.
 */
export const NEXT_IN_CHAIN: Partial<Record<BoneSlot, BoneSlot>> = {
  hips: 'spine',
  spine: 'chest',
  chest: 'neck',
  neck: 'head',
  'shoulder.L': 'upperArm.L',
  'upperArm.L': 'lowerArm.L',
  'lowerArm.L': 'hand.L',
  'shoulder.R': 'upperArm.R',
  'upperArm.R': 'lowerArm.R',
  'lowerArm.R': 'hand.R',
};

export const ARKIT_52 = new Set(
  `eyeBlinkLeft eyeLookDownLeft eyeLookInLeft eyeLookOutLeft eyeLookUpLeft
eyeSquintLeft eyeWideLeft eyeBlinkRight eyeLookDownRight eyeLookInRight eyeLookOutRight eyeLookUpRight
eyeSquintRight eyeWideRight jawForward jawLeft jawRight jawOpen mouthClose mouthFunnel mouthPucker
mouthLeft mouthRight mouthSmileLeft mouthSmileRight mouthFrownLeft mouthFrownRight mouthDimpleLeft
mouthDimpleRight mouthStretchLeft mouthStretchRight mouthRollLower mouthRollUpper mouthShrugLower
mouthShrugUpper mouthPressLeft mouthPressRight mouthLowerDownLeft mouthLowerDownRight mouthUpperUpLeft
mouthUpperUpRight browDownLeft browDownRight browInnerUp browOuterUpLeft browOuterUpRight cheekPuff
cheekSquintLeft cheekSquintRight noseSneerLeft noseSneerRight tongueOut`.split(/\s+/),
);

/** VRM 1.0 preset shapes, used to recognise an expression mesh. */
export const VRM_SHAPES = new Set(
  `happy angry sad relaxed surprised neutral joy fun sorrow
aa ih ou ee oh lookUp lookDown lookLeft lookRight blinkLeft blinkRight`.split(/\s+/),
);

/** Does this shape name belong to an expression vocabulary we drive? */
export function isExpressionShape(name: string): boolean {
  return (
    ARKIT_52.has(name) ||
    name.startsWith('vrc.v_') ||
    VRM_SHAPES.has(name) ||
    /^(blink|Blink)/.test(name)
  );
}

/**
 * Shape-key groups.
 *
 * Commercial avatars commonly label their shape list with dummy separator
 * shapes. The exporter keeps them, so the grouping survives into the GLB —
 * which matters because an avatar's *own* expressions have no naming convention
 * at all. `F_NIKONIKO` is unrecognisable from the outside; "the group under
 * `___YOKA___`" is not.
 *
 * The delimiter itself is per-author and was never going to be one pattern:
 * two avatars from two authors both use the convention and neither agrees on
 * how to write it — `___BSL52___` against `**********EYE MORPH**********`. That
 * both do it at all is the general fact worth relying on, so the mechanism is
 * here and the pattern comes from the avatar.
 *
 * This is discovery only. Which group means what is avatar data, and lives with
 * the rest of it.
 */
export const DEFAULT_SEPARATOR = /^_{2,}(.+?)_{2,}$/;

export const isSeparator = (name: string, separator: RegExp = DEFAULT_SEPARATOR): boolean =>
  separator.test(name);
