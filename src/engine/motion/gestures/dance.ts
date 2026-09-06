import type { GestureDef } from '../../types';
import { V } from './base';
import type { ArmPose } from './builders';
import { both } from './builders';
import { OPEN_HAND, POINT_HAND } from './hands';

/** Dance — little rhythmic movements for a live stage. */

export const DANCE = {
  sideSway: {
    label: { en: 'Sway', ja: 'ゆらゆら' },
    group: 'dance',
    lead: 0.42,
    hold: 2.1,
    build(t, v) {
      const s = Math.sin(t * 2.5 * v.rate) * 0.07 * v.scale;
      return both(
        {
          upperArm: V(0.38, -0.76 + s * 0.2, 0.34),
          lowerArm: V(0.22, -0.48 + s, 0.82),
          hand: V(0.16, -0.38 + s * 1.2, 0.9),
          twist: -0.18,
        },
        OPEN_HAND,
        {
          chest: [0, s * 0.55, s * 0.2],
          head: [0, -s * 0.4, -s * 0.2],
        },
      );
    },
  },

  shoulderBounce: {
    label: { en: 'Bop', ja: 'るんるん' },
    group: 'dance',
    lead: 0.3,
    hold: 1.8,
    build(t, v) {
      const s = Math.sin(t * 5.4 * v.rate) * 0.055 * v.scale;
      return {
        spine: {
          chest: [s * 0.35, 0, s],
          neck: [-s * 0.2, 0, -s * 0.35],
          head: [-s * 0.3, 0, -s * 0.5],
        },
      };
    },
  },

  handRoll: {
    label: { en: 'Rolling hands', ja: 'くるくる' },
    group: 'dance',
    lead: 0.38,
    hold: 2.0,
    build(t, v) {
      const w = t * 3.8 * v.rate;
      const x = Math.sin(w) * 0.06 * v.scale;
      const y = Math.sin(w * 2) * 0.045 * v.scale;
      return both(
        {
          upperArm: V(0.42, -0.68, 0.35),
          lowerArm: V(0.24 + x, -0.08 + y, 0.95),
          hand: V(0.18 + x * 1.25, 0.02 + y, 0.96),
          palm: V(-0.64, 0.35, -0.68),
          twist: 0.06,
        },
        OPEN_HAND,
        { chest: [0, y * 0.2, 0] },
      );
    },
  },

  discoPoint: {
    label: { en: 'Disco point', ja: 'ディスコポーズ' },
    group: 'dance',
    lead: 0.35,
    hold: 1.9,
    build(t, v) {
      const s = Math.sin(t * 3.3 * v.rate) * 0.035 * v.scale;
      const raised: ArmPose = {
        upperArm: V(0.46, -0.5 + s, 0.32),
        lowerArm: V(0.38, 0.5 + s, 0.76),
        hand: V(0.32, 0.6 + s, 0.74),
        twist: -0.2,
      };
      const low: ArmPose = {
        upperArm: V(0.38, -0.8, 0.28),
        lowerArm: V(0.26, -0.42 - s, 0.86),
        hand: V(0.2, -0.34 - s, 0.91),
        twist: -0.08,
      };
      return {
        arms: { L: low, R: raised },
        fingers: { L: OPEN_HAND, R: POINT_HAND },
        spine: { chest: [0, s * 0.3, 0], head: [-0.02, 0, 0] },
      };
    },
  },

  tinyDance: {
    label: { en: 'Little dance', ja: 'ちょこっとダンス' },
    group: 'dance',
    lead: 0.34,
    hold: 1.8,
    build(t, v) {
      const s = Math.sin(t * 5.1 * v.rate) * 0.07 * v.scale;
      const mk = (pulse: number): ArmPose => ({
        upperArm: V(0.4, -0.76 + pulse * 0.25, 0.3),
        lowerArm: V(0.22, -0.52 + pulse, 0.82),
        hand: V(0.16, -0.44 + pulse * 1.2, 0.88),
        twist: -0.12,
      });
      return {
        arms: { L: mk(-s), R: mk(s) },
        fingers: { L: OPEN_HAND, R: OPEN_HAND },
        spine: { chest: [0, s * 0.35, 0], head: [-s * 0.25, 0, 0] },
      };
    },
  },
} satisfies Record<string, GestureDef>;
