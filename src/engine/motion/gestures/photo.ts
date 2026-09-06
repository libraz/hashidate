import type { GestureDef } from '../../types';
import { V } from './base';
import type { ArmPose } from './builders';
import { reach, reachBoth } from './builders';
import { OPEN_HAND, PEACE_HAND, PEACE_SPREAD, POINT_HAND, SOFT_HAND } from './hands';

/** Photo pose — compact silhouettes for a still frame. */

export const PHOTO = {
  flowerPose: {
    label: { en: 'Flower pose', ja: 'おはなポーズ' },
    group: 'photo',
    lead: 0.48,
    hold: 2.3,
    build(t, v) {
      const b = Math.sin(t * 2.1 * v.rate) * 0.025 * v.scale;
      return reachBoth(
        {
          at: 'chin',
          // Leave a gap between the palms and keep them forward of the chin.
          // Closer targets crossed the wrists and overfolded the elbows.
          offset: [0.45, -0.15 + b, 1.35],
          hand: [-0.2, 0.92, -0.3],
          palm: [-0.6, 0.35, -0.72],
          pole: [0.32, -0.9, -0.3],
        },
        OPEN_HAND,
        { head: [0.025, 0, 0], chest: [0, 0.02 * b, 0] },
      );
    },
  },

  cheekPeace: {
    label: { en: 'Cheek peace', ja: 'ほっぺピース' },
    group: 'photo',
    lead: 0.46,
    hold: 2.3,
    build(t, v) {
      const b = Math.sin(t * 2.0 * v.rate) * 0.02 * v.scale;
      const pose = reach(
        v,
        {
          at: 'cheek',
          offset: [0.18, -0.36 + b, 0.92],
          hand: [-0.34, 0.92, -0.21],
          palm: [-0.71, 0.33, -0.62],
          pole: [0.32, -0.78, -0.42],
          twist: 0.4,
        },
        PEACE_HAND,
        { head: [0.045, 0.1 * v.side, 0.07 * v.side] },
      );
      const side = v.side > 0 ? 'R' : 'L';
      return { ...pose, fingerSpread: { [side]: PEACE_SPREAD } };
    },
  },

  cheekPoints: {
    label: { en: 'Cheek points', ja: 'ほっぺつんつん' },
    group: 'photo',
    lead: 0.48,
    hold: 2.2,
    build(t, v) {
      const b = Math.sin(t * 2.4 * v.rate) * 0.025 * v.scale;
      return reachBoth(
        {
          at: 'cheek',
          offset: [0.16, -0.36 + b, 0.86],
          hand: [-0.34, 0.92, -0.21],
          palm: [-0.71, 0.33, -0.62],
          pole: [0.3, -0.8, -0.4],
        },
        POINT_HAND,
        { head: [0.04, 0, 0.02] },
      );
    },
  },

  faceFrame: {
    label: { en: 'Face frame', ja: 'おかおフレーム' },
    group: 'photo',
    lead: 0.5,
    hold: 2.2,
    build(t, v) {
      const b = Math.sin(t * 1.8 * v.rate) * 0.025 * v.scale;
      return reachBoth(
        {
          at: 'cheek',
          // Outside the cheeks so the face stays visible; forward clearance
          // keeps the entrance out of the elbow's fold stop.
          offset: [0.7, -0.6 + b, 1.35],
          hand: [0.06, 0.93, 0.3],
          palm: [0, 0.12, 1],
          pole: [0.42, -0.86, -0.3],
        },
        OPEN_HAND,
        { head: [-0.025, 0, 0] },
      );
    },
  },

  modelTilt: {
    label: { en: 'Model pose', ja: 'モデルポーズ' },
    group: 'photo',
    lead: 0.42,
    hold: 2.3,
    build(t, v) {
      const s = Math.sin(t * 1.8 * v.rate) * 0.025 * v.scale;
      const low: ArmPose = {
        upperArm: V(0.4, -0.84, 0.25),
        lowerArm: V(0.28, -0.62 + s, 0.72),
        hand: V(0.22, -0.54 + s, 0.8),
        twist: -0.15,
      };
      const frame: ArmPose = {
        upperArm: V(0.44, -0.56, 0.32),
        lowerArm: V(0.28, 0.26 - s, 0.92),
        hand: V(0.2, 0.34 - s, 0.94),
        palm: V(-0.6, 0.34, -0.72),
        twist: -0.12,
      };
      return {
        arms: { L: low, R: frame },
        fingers: { L: SOFT_HAND, R: OPEN_HAND },
        spine: {
          chest: [0, 0.05 * v.side, 0.025 * v.side],
          head: [0.02, 0.11 * v.side, 0.08 * v.side],
        },
      };
    },
  },
} satisfies Record<string, GestureDef>;
