import * as THREE from 'three';
import type { FingerName, FingerSpec, HandContact, HandShape } from '../../types';
import { V } from './base';

/**
 * Hand shapes: curl per finger, and the splay the shape needs.
 *
 * A thumb curl sweeps the thumb across the palm toward the fingers, 1 being
 * wrapped as in a fist; a thumb spread is its abduction away from the palm.
 *
 * Named rather than written out at each use because the same hand appears in a
 * dozen gestures and a shape that drifted between two of them would read as two
 * different hands doing the same thing.
 */

/** No splay: the fingers stay where the bind pose holds them. */
export const NO_SPREAD: FingerSpec = {};
/** A hand shape from its curls (0 = straight, 1 = fully closed) and optional splay in radians. */
export const shape = (
  curl: Readonly<Record<FingerName, number>>,
  spread: Readonly<FingerSpec> = NO_SPREAD,
): HandShape => ({ curl, spread });

export const OPEN_HAND = shape({
  thumb: 0.1,
  index: 0.06,
  middle: 0.06,
  ring: 0.08,
  little: 0.12,
});
export const SOFT_HAND = shape({
  thumb: 0.2,
  index: 0.22,
  middle: 0.26,
  ring: 0.3,
  little: 0.34,
});
/**
 * The blade of the hand: four fingers straight and together, the thumb swung
 * in along the index, out from under the palm.
 *
 * Thirty degrees of abduction is what takes the thumb out: at fifteen its tip
 * still stood a finger's thickness proud of the index on both validation
 * avatars, and a hand laid across the mouth hung off the lips by that much.
 */
export const CHOP_HAND = shape(
  { thumb: 0.3, index: 0, middle: 0, ring: 0, little: 0 },
  { thumb: THREE.MathUtils.degToRad(-30) },
);
/**
 * The open hand with the chop thumb, for a hand held flat across the mouth.
 *
 * Any finger curl turns the fingertips in toward the face, and the face
 * clearance then holds the whole hand off the lips by however far they reach
 * in. A thumb left where the bind pose holds it stood proud of the palm on the
 * face side and did the same, so it lies along the index instead.
 */
export const MOUTH_HAND = shape(
  { ...OPEN_HAND.curl, thumb: CHOP_HAND.curl.thumb },
  CHOP_HAND.spread,
);
/**
 * Where a hand held across the mouth touches it: the index's first phalanx,
 * so the fingers run on across the lips and the palm stays beside them.
 */
export const MOUTH_CONTACT: HandContact = {
  kind: 'finger',
  finger: 'index',
  segment: 0,
  fraction: 0.5,
  surface: 'pad',
};
/** A hand `t` of the way from one shape to another, for a hand that changes shape as it moves. */
export const mixHand = (from: HandShape, to: HandShape, t: number): HandShape => {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const spread: FingerSpec = {};
  for (const finger of new Set([...Object.keys(from.spread), ...Object.keys(to.spread)])) {
    const f = finger as FingerName;
    spread[f] = lerp(from.spread[f] ?? 0, to.spread[f] ?? 0);
  }
  return {
    curl: {
      thumb: lerp(from.curl.thumb, to.curl.thumb),
      index: lerp(from.curl.index, to.curl.index),
      middle: lerp(from.curl.middle, to.curl.middle),
      ring: lerp(from.curl.ring, to.curl.ring),
      little: lerp(from.curl.little, to.curl.little),
    },
    spread,
  };
};

/**
 * The other four, for a hand that is pointing with one finger.
 *
 * The thumb rides slack rather than closed. Pinned down against the fingers it
 * makes a fist with something sticking out of it, which is a different gesture.
 */
const POINT_CLOSED: Record<FingerName, number> = {
  thumb: 0.35,
  index: 0.95,
  middle: 0.95,
  ring: 0.98,
  little: 0.98,
};

/**
 * A hand shaped to point with one particular finger.
 *
 * The aimed finger has to be the one actually extended, and this is not a
 * cosmetic matter. The solver works from where the fingertip *is*, and where it
 * is falls out of the curl this shape produced — so aiming the little finger at
 * something while the hand is shaped to point with the index aims a fingertip
 * folded into the palm, and the arm quietly travels somewhere else to put it
 * there. The finger the viewer sees extended is meanwhile not the one that was
 * asked for.
 */
export const pointHand = (finger: FingerName = 'index'): HandShape =>
  shape({ ...POINT_CLOSED, [finger]: 0.02 });

/** The index-pointing hand, which is what most callers mean by pointing. */
export const POINT_HAND = pointHand('index');
/** The index-pointing hand with the chop thumb, for a finger held to the lips. See `MOUTH_HAND`. */
export const SHUSH_HAND = shape(
  { ...POINT_HAND.curl, thumb: CHOP_HAND.curl.thumb },
  CHOP_HAND.spread,
);
/**
 * A peace sign needs motion in the palm plane as well as finger curl.
 *
 * Six degrees each way leaves a clear V on both validation avatars; their bind
 * poses separate index and middle by only 2.8 and 0.5 degrees.
 */
export const PEACE_HAND = shape(
  { thumb: 1.0, index: 0.02, middle: 0.02, ring: 0.95, little: 0.95 },
  { index: THREE.MathUtils.degToRad(-6), middle: THREE.MathUtils.degToRad(6) },
);
export const PEACE_PALM = V(0, 0.05, 1);
/**
 * The thumb folds down onto the fingers: its tip turns toward the palm and rests on the middle
 * finger's middle phalanx, the pad proud of the index and middle ones, on both validation avatars.
 */
export const FIST = shape(
  { thumb: 0.65, index: 0.92, middle: 0.94, ring: 0.95, little: 0.96 },
  { thumb: THREE.MathUtils.degToRad(25) },
);
const COUNT_ORDER: readonly FingerName[] = ['index', 'middle', 'ring', 'little'];
const COUNT_THREE_SPREAD: FingerSpec = {
  index: THREE.MathUtils.degToRad(-6),
  ring: THREE.MathUtils.degToRad(6),
};
/**
 * Four and five fanned wider toward the little finger, 22 degrees across,
 * inside the fan a relaxed hand reaches. Held together they read as a chop.
 */
const COUNT_FAN: FingerSpec = {
  index: THREE.MathUtils.degToRad(-8),
  middle: THREE.MathUtils.degToRad(-2),
  ring: THREE.MathUtils.degToRad(5),
  little: THREE.MathUtils.degToRad(14),
};
/**
 * Counting on one hand, the Japanese way: index first, then middle, ring and
 * little, the thumb folded across the palm until the fifth.
 *
 * The folded fingers take `FIST`'s curls so a count reads as a fist with fingers
 * raised out of it, thumb included. Two keeps the V's fan; three
 * fans its outer fingers by the same angle about the middle, because the V's fan
 * left the index apart and the middle and ring pressed together.
 */
export const countHand = (n: 1 | 2 | 3 | 4 | 5): HandShape => {
  if (n === 5) return shape(OPEN_HAND.curl, COUNT_FAN);
  const curl: Record<FingerName, number> = { ...FIST.curl };
  for (const finger of COUNT_ORDER.slice(0, n)) curl[finger] = PEACE_HAND.curl.index;
  const fist = { thumb: FIST.spread.thumb };
  if (n === 2) return shape(curl, { ...PEACE_HAND.spread, ...fist });
  if (n === 3) return shape(curl, { ...COUNT_THREE_SPREAD, ...fist });
  if (n === 4) return shape(curl, { ...COUNT_FAN, ...fist });
  return shape(curl, fist);
};

/**
 * A promise keeps the fist closed except for the little finger. Derive it from
 * the eye-tuned fist: `pointHand('little')` left its thumb at 0.35, which read
 * as a second extended finger on the raised hand rather than as a closed fist.
 */
export const PINKY_PROMISE_HAND = shape({ ...FIST.curl, little: 0.02 }, FIST.spread);
export const PAW = shape({
  thumb: 0.68,
  index: 0.76,
  middle: 0.8,
  ring: 0.82,
  little: 0.84,
});
export const THUMB_UP = shape({
  thumb: 0.02,
  index: 0.95,
  middle: 0.96,
  ring: 0.97,
  little: 0.98,
});
export const GUN_HAND = shape({
  thumb: 0.05,
  index: 0.02,
  middle: 0.95,
  ring: 0.97,
  little: 0.98,
});
export const HEART_HAND = shape(
  {
    thumb: 0.4,
    index: 0.62,
    middle: 0.95,
    ring: 0.97,
    little: 0.98,
  },
  { thumb: THREE.MathUtils.degToRad(20) },
);
/**
 * An open hand for the two-handed heart silhouette.
 *
 * `HEART_HAND` is intentionally the compact finger-heart shape used by the
 * one-handed pose. A pair of those closes into a clasp when the palms meet.
 * Curved index fingers form the upper arcs and extended thumbs the lower
 * point; the other fingers fold out of the opening. The hands aim inward
 * across the chest: an upright hand puts the thumbs above the heart.
 */
export const FULL_HEART_HAND = shape({
  thumb: 0.08,
  index: 0.22,
  middle: 0.92,
  ring: 0.95,
  little: 0.98,
});
export const CLASP_HAND = shape({
  thumb: 0.5,
  index: 0.6,
  middle: 0.62,
  ring: 0.64,
  little: 0.66,
});
