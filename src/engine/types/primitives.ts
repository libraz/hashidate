import type { Localized } from '../../i18n/locale';

/**
 * The canonical slots and scalars every other type here is built from.
 *
 * Nothing in this file describes an avatar, a pose or a turn — it is the
 * alphabet those are spelled in, and it imports nothing but `Localized`.
 */

// --- primitives -------------------------------------------------------------

/** Which arm, in the character's own terms. Never a world direction. */
export type Side = 'L' | 'R';

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'little';

/** A finger chain, keyed as it is stored on the profile. */
export type FingerKey = `${FingerName}.${Side}`;

/** The links an arm pose names, shoulder to hand. */
export type ArmSlot = 'shoulder' | 'upperArm' | 'lowerArm' | 'hand';

/** Slots along the spine, which take additive offsets rather than aims. */
export type SpineSlot = 'hips' | 'spine' | 'chest' | 'neck' | 'head';

export type EyeSlot = `eye.${Side}`;

export type ArmBoneSlot = `${ArmSlot}.${Side}`;

/** Every bone slot the profile tries to resolve. */
export type BoneSlot = SpineSlot | EyeSlot | ArmBoneSlot;

/**
 * A direction in *character space*: x outward from the midline, y up, z
 * forward. Mirrored per side when applied, which is what lets one authored
 * gesture serve both arms on any rig.
 */
export type Vec3Tuple = [number, number, number];

// --- expression vocabulary --------------------------------------------------

export type EmotionName =
  | 'neutral'
  | 'joy'
  | 'anger'
  | 'sadness'
  | 'surprise'
  | 'relaxed'
  | 'thinking'
  | 'shy';

/**
 * A blend, not a choice. Weights need not sum to one — the layers that consume
 * it normalise where normalising is meaningful.
 */
export type EmotionVector = Partial<Record<EmotionName, number>>;

/** Mouth shapes, as the profile routes them. `n` and `sil` are optional on a rig. */
export type VisemeName = 'a' | 'i' | 'u' | 'e' | 'o' | 'n' | 'sil';

/** The VRM 1.0 preset emotions, used only as the degraded fallback channel. */
export type VrmEmotionName = 'neutral' | 'joy' | 'anger' | 'sadness' | 'relaxed' | 'surprise';

/** A weight map in some shape vocabulary — ARKit's, or one avatar's own. */
export type ShapeWeights = Record<string, number>;

/** Camera framings the session can be asked for. */
export type CameraFrame = 'face' | 'bust' | 'upper' | 'full';

// --- labels -----------------------------------------------------------------

/**
 * An id, and what to call it on screen.
 *
 * The label is both languages at once rather than one of them. Whoever renders
 * it picks — see `src/i18n/locale.ts` — because the surfaces that draw these
 * lists learn the vocabulary from the control server rather than from the avatar
 * tables, and the server has no way to know which language is being read.
 */
export interface LabelledId {
  id: string;
  label: Localized;
}
