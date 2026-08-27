/**
 * Expression layer.
 *
 * Emotion names are composed into ARKit 52 weights. This table is
 * avatar-independent: it is written once and reused for every avatar whose
 * profile reports ARKit support. Only the profile changes between avatars.
 *
 * Weights are muscle-level, so emotions blend additively without fighting over
 * the same vertices the way named presets do.
 */

import type { Localized } from '../../i18n/locale';
import type { EmotionName, EmotionVector, ShapeWeights } from '../types';

export const EMOTIONS: Record<EmotionName, ShapeWeights> = {
  neutral: {},

  joy: {
    mouthSmileLeft: 0.85,
    mouthSmileRight: 0.85,
    mouthDimpleLeft: 0.35,
    mouthDimpleRight: 0.35,
    cheekSquintLeft: 0.55,
    cheekSquintRight: 0.55,
    eyeSquintLeft: 0.38,
    eyeSquintRight: 0.38,
    browInnerUp: 0.15,
    browOuterUpLeft: 0.12,
    browOuterUpRight: 0.12,
    mouthUpperUpLeft: 0.12,
    mouthUpperUpRight: 0.12,
  },

  anger: {
    browDownLeft: 0.85,
    browDownRight: 0.85,
    eyeSquintLeft: 0.45,
    eyeSquintRight: 0.45,
    mouthFrownLeft: 0.35,
    mouthFrownRight: 0.35,
    mouthPressLeft: 0.5,
    mouthPressRight: 0.5,
    noseSneerLeft: 0.45,
    noseSneerRight: 0.45,
    jawForward: 0.18,
  },

  sadness: {
    browInnerUp: 0.9,
    browDownLeft: 0.2,
    browDownRight: 0.2,
    mouthFrownLeft: 0.6,
    mouthFrownRight: 0.6,
    mouthShrugLower: 0.35,
    eyeSquintLeft: 0.22,
    eyeSquintRight: 0.22,
    eyeLookDownLeft: 0.3,
    eyeLookDownRight: 0.3,
  },

  surprise: {
    eyeWideLeft: 0.85,
    eyeWideRight: 0.85,
    browInnerUp: 0.7,
    browOuterUpLeft: 0.8,
    browOuterUpRight: 0.8,
    jawOpen: 0.42,
    mouthFunnel: 0.22,
  },

  relaxed: {
    mouthSmileLeft: 0.32,
    mouthSmileRight: 0.32,
    cheekSquintLeft: 0.2,
    cheekSquintRight: 0.2,
    eyeSquintLeft: 0.28,
    eyeSquintRight: 0.28,
    browOuterUpLeft: 0.1,
    browOuterUpRight: 0.1,
  },

  thinking: {
    browDownLeft: 0.42,
    browInnerUp: 0.3,
    eyeLookUpLeft: 0.4,
    eyeLookUpRight: 0.4,
    eyeLookInLeft: 0.28,
    mouthPucker: 0.3,
    mouthLeft: 0.28,
    eyeSquintLeft: 0.2,
    eyeSquintRight: 0.2,
  },

  shy: {
    browInnerUp: 0.55,
    eyeSquintLeft: 0.42,
    eyeSquintRight: 0.42,
    eyeLookDownLeft: 0.35,
    eyeLookDownRight: 0.35,
    mouthSmileLeft: 0.3,
    mouthSmileRight: 0.3,
    mouthShrugUpper: 0.3,
    cheekSquintLeft: 0.25,
    cheekSquintRight: 0.25,
  },
};

export const EMOTION_LABELS: Record<EmotionName, Localized> = {
  neutral: { en: 'Neutral', ja: '平常' },
  joy: { en: 'Joy', ja: '喜' },
  anger: { en: 'Anger', ja: '怒' },
  sadness: { en: 'Sadness', ja: '哀' },
  surprise: { en: 'Surprise', ja: '驚' },
  relaxed: { en: 'Calm', ja: '安' },
  thinking: { en: 'Thinking', ja: '思案' },
  shy: { en: 'Shy', ja: '照' },
};

/** Shapes the mouth layer owns outright; the expression layer yields them. */
const MOUTH_LOCKED = new Set([
  'jawOpen',
  'jawForward',
  'mouthFunnel',
  'mouthPucker',
  'mouthClose',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthRollLower',
  'mouthRollUpper',
]);

/**
 * Shapes that shape the mouth without owning it. A smile has to survive while
 * speaking or the emotion stops reading, but at full strength it closes the
 * lips and buries the visemes. Held back to roughly 40% during speech.
 */
const MOUTH_SOFT = new Set([
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthLeft',
  'mouthRight',
]);
const SOFT_FLOOR = 0.4;

/** Emotion entries, typed for iteration. The vector is a partial record. */
type EmotionEntries = Array<[EmotionName, number | undefined]>;

/**
 * Compose an emotion vector into an ARKit weight map.
 * `weights` is e.g. { joy: 0.8, surprise: 0.2 }.
 * When the mouth layer is speaking, mouth-owned shapes are attenuated so lip
 * sync stays readable instead of being buried under the expression.
 */
export function composeArkit(
  weights: EmotionVector,
  { mouthBusy = 0 }: { mouthBusy?: number } = {},
): ShapeWeights {
  const out: ShapeWeights = {};
  for (const [name, w] of Object.entries(weights) as EmotionEntries) {
    if (!w) continue;
    const table = EMOTIONS[name];
    if (!table) continue;
    for (const [shape, v] of Object.entries(table)) {
      let scale = 1;
      if (MOUTH_LOCKED.has(shape)) scale = 1 - mouthBusy;
      else if (MOUTH_SOFT.has(shape)) scale = 1 - mouthBusy * (1 - SOFT_FLOOR);
      out[shape] = (out[shape] ?? 0) + v * w * scale;
    }
  }
  for (const k of Object.keys(out)) out[k] = Math.min(1, out[k]);
  return out;
}

/**
 * Compose an emotion vector using the avatar's own shape names.
 *
 * The table above is portable and an avatar with 0/52 ARKit cannot use a line of
 * it. This is the same operation against a table written in that avatar's
 * vocabulary, supplied by its descriptor: `{ joy: { eye_joy: 0.85, brow_joy:
 * 0.7, … }, … }`.
 *
 * It is deliberately the same shape as `composeArkit` and not a special case.
 * Part-level shapes blend additively whatever they are called, so mixing joy
 * and relaxed lands between the two here exactly as it does there — which is
 * the property that made ARKit the primary channel in the first place, and it
 * turns out not to depend on ARKit at all. What ARKit buys is that the table is
 * written once for every avatar; without it, the table is avatar data.
 *
 * Mouth attenuation works off a name pattern rather than the two curated sets,
 * because those sets are ARKit vocabulary. An avatar states which of its shapes
 * the mouth layer owns; shapes that match are held back while speaking so lip
 * sync stays readable, without dropping the expression entirely.
 */
export function composeNative(
  weights: EmotionVector,
  table: Partial<Record<EmotionName, ShapeWeights>>,
  { mouthBusy = 0, mouthShapes = null }: { mouthBusy?: number; mouthShapes?: RegExp | null } = {},
): ShapeWeights {
  const out: ShapeWeights = {};
  for (const [name, w] of Object.entries(weights) as EmotionEntries) {
    if (!w) continue;
    const shapes = table[name];
    if (!shapes) continue;
    for (const [shape, v] of Object.entries(shapes)) {
      const scale = mouthShapes?.test(shape) ? 1 - mouthBusy * (1 - SOFT_FLOOR) : 1;
      out[shape] = (out[shape] ?? 0) + v * w * scale;
    }
  }
  for (const k of Object.keys(out)) out[k] = Math.min(1, out[k]);
  return out;
}

/** Fallback for avatars without ARKit: pick the dominant emotion's VRM preset. */
export function dominantEmotion(weights: EmotionVector): EmotionName {
  let best: EmotionName | null = null;
  let bestV = 0;
  for (const [k, v] of Object.entries(weights) as EmotionEntries) {
    if (v && v > bestV) {
      best = k;
      bestV = v;
    }
  }
  return bestV > 0.05 && best ? best : 'neutral';
}
