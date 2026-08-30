import * as THREE from 'three';
import type { FingerName, FingerSpec } from '../../types';
import { V } from './base';

/**
 * Hand shapes, as curls per finger.
 *
 * Named rather than written out at each use because the same hand appears in a
 * dozen gestures and a shape that drifted between two of them would read as two
 * different hands doing the same thing.
 */

// 0 = straight, 1 = fully closed.
export const OPEN_HAND: Record<FingerName, number> = {
  thumb: 0.1,
  index: 0.06,
  middle: 0.06,
  ring: 0.08,
  little: 0.12,
};
export const SOFT_HAND: Record<FingerName, number> = {
  thumb: 0.2,
  index: 0.22,
  middle: 0.26,
  ring: 0.3,
  little: 0.34,
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
export const pointHand = (finger: FingerName = 'index'): Record<FingerName, number> => ({
  ...POINT_CLOSED,
  [finger]: 0.02,
});

/** The index-pointing hand, which is what most callers mean by pointing. */
export const POINT_HAND: Record<FingerName, number> = pointHand('index');
export const PEACE_HAND: Record<FingerName, number> = {
  thumb: 1.0,
  index: 0.02,
  middle: 0.02,
  ring: 0.95,
  little: 0.95,
};
/**
 * A peace sign needs motion in the palm plane as well as finger curl.
 *
 * Six degrees each way leaves a clear V on both validation avatars; their bind
 * poses separate index and middle by only 2.8 and 0.5 degrees. The thumb's 28
 * degrees carries its fully curled tip in over the palm — curl alone left a
 * round thumb sticking out beside the fist on the front-facing hand.
 */
export const PEACE_SPREAD: FingerSpec = {
  thumb: THREE.MathUtils.degToRad(28),
  index: THREE.MathUtils.degToRad(-6),
  middle: THREE.MathUtils.degToRad(6),
};
export const PEACE_PALM = V(0, 0.05, 1);
export const FIST: Record<FingerName, number> = {
  thumb: 0.7,
  index: 0.92,
  middle: 0.94,
  ring: 0.95,
  little: 0.96,
};
/**
 * A promise keeps the fist closed except for the little finger. Derive it from
 * the eye-tuned fist: `pointHand('little')` left its thumb at 0.35, which read
 * as a second extended finger on the raised hand rather than as a closed fist.
 */
export const PINKY_PROMISE_HAND: Record<FingerName, number> = {
  ...FIST,
  little: 0.02,
};
export const PAW: Record<FingerName, number> = {
  thumb: 0.68,
  index: 0.76,
  middle: 0.8,
  ring: 0.82,
  little: 0.84,
};
export const THUMB_UP: Record<FingerName, number> = {
  thumb: 0.02,
  index: 0.95,
  middle: 0.96,
  ring: 0.97,
  little: 0.98,
};
export const GUN_HAND: Record<FingerName, number> = {
  thumb: 0.05,
  index: 0.02,
  middle: 0.95,
  ring: 0.97,
  little: 0.98,
};
export const HEART_HAND: Record<FingerName, number> = {
  thumb: 0.55,
  index: 0.62,
  middle: 0.95,
  ring: 0.97,
  little: 0.98,
};
export const CLASP_HAND: Record<FingerName, number> = {
  thumb: 0.5,
  index: 0.6,
  middle: 0.62,
  ring: 0.64,
  little: 0.66,
};
