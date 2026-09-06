import type { GestureDef } from '../../types';
import { V } from './base';
import type { ArmPose } from './builders';
import { reach, reachBoth } from './builders';
import { FULL_HEART_HAND, HEART_HAND, OPEN_HAND, SOFT_HAND } from './hands';

/** Affection — small ways to say that the character cares. */

const ease = (t: number, duration: number): number => {
  const x = Math.min(1, Math.max(0, t / duration));
  return x * x * (3 - 2 * x);
};

export const AFFECTION = {
  blowKiss: {
    label: { en: 'Blow a kiss', ja: '投げキッス' },
    group: 'affection',
    lead: 0.48,
    hold: 1.8,
    build(t, v) {
      // The hand starts soft beside the mouth and opens as the kiss leaves.
      // It stays below eye level, with a pole because this is a face reach.
      const depart = ease(t - 0.68, 0.68);
      const open = ease(t - 0.8, 0.34);
      const fingers = {
        thumb: SOFT_HAND.thumb + (OPEN_HAND.thumb - SOFT_HAND.thumb) * open,
        index: SOFT_HAND.index + (OPEN_HAND.index - SOFT_HAND.index) * open,
        middle: SOFT_HAND.middle + (OPEN_HAND.middle - SOFT_HAND.middle) * open,
        ring: SOFT_HAND.ring + (OPEN_HAND.ring - SOFT_HAND.ring) * open,
        little: SOFT_HAND.little + (OPEN_HAND.little - SOFT_HAND.little) * open,
      };
      return reach(
        v,
        {
          at: 'mouth',
          offset: [0.68 + 0.3 * depart, -0.06 - 0.65 * depart, 0.9 + 2.2 * depart],
          hand: [-0.3 + 0.3 * depart, 0.91 - 0.56 * depart, -0.26 + 1.2 * depart],
          palm: [-0.82 * (1 - depart), 0.3 + 0.64 * depart, -0.48 + 0.14 * depart],
          pole: [0.35, -0.86, -0.28],
          twist: 0.38 * (1 - depart),
        },
        fingers,
        { head: [0.02, 0.1 * v.side, 0.04 * v.side] },
      );
    },
  },

  heartHands: {
    label: { en: 'Hand heart', ja: '両手ハート' },
    group: 'affection',
    lead: 0.4,
    hold: 2.1,
    build(t, v) {
      const pulse = Math.sin(t * 2.6 * v.rate) * 0.025 * v.scale * ease(t, 0.45);
      return reachBoth(
        {
          space: 'body',
          at: 'sternum',
          offset: [0.13, -0.04 + pulse, 0.36],
          hand: [-1, -0.3, 0],
          palm: [0, 0, 1],
        },
        FULL_HEART_HAND,
        { chest: [0.01, 0.02 * pulse, 0], head: [-0.02, 0, 0] },
      );
    },
  },

  heartOffer: {
    label: { en: 'A heart for you', ja: 'ハートをどうぞ' },
    group: 'affection',
    lead: 0.52,
    hold: 2.0,
    build(t, v) {
      // The same heart hand shape travels from the sternum toward the viewer.
      // Smooth distance easing keeps the hands from jumping away together.
      const offer = ease(t - 0.72, 0.7);
      const pulse = Math.sin(t * 2.2 * v.rate) * 0.018 * v.scale * ease(t, 0.45);
      return reachBoth(
        {
          space: 'body',
          at: 'sternum',
          offset: [0.13, -0.04 + 0.03 * offer + pulse, 0.36 + 0.33 * offer],
          hand: [-1, -0.3, 0],
          palm: [0, 0, 1],
        },
        FULL_HEART_HAND,
        { chest: [0.015, 0.025 * offer, 0], head: [-0.025, 0, 0] },
      );
    },
  },

  selfHug: {
    label: { en: 'Cozy hug', ja: 'ぎゅっとする' },
    group: 'affection',
    lead: 0.5,
    hold: 2.2,
    build(t, v) {
      const squeeze = Math.sin(t * 2.8 * v.rate) * 0.025 * v.scale;
      return reachBoth(
        {
          space: 'body',
          at: 'shoulder',
          // Positive lateral offset leaves each hand on its own side of the
          // chest; a self-hug never asks an arm to cross the midline.
          offset: [0.13, -0.08 + squeeze, 0.18],
          hand: [-0.46, 0.44, 0.77],
          palm: [-0.72, 0.45, -0.52],
          pole: [0.34, -0.86, -0.28],
        },
        SOFT_HAND,
        { chest: [0, 0.03 * squeeze, 0.04], head: [0.02, 0, 0] },
      );
    },
  },

  heartFlutter: {
    label: { en: 'Heart flutter', ja: 'きゅんきゅん' },
    group: 'affection',
    lead: 0.4,
    hold: 2.2,
    build(t, v) {
      const s = Math.sin(t * 4.1 * v.rate) * 0.055 * v.scale;
      const mk = (pulse: number): ArmPose => ({
        upperArm: V(0.4, -0.58 + pulse * 0.3, 0.36),
        lowerArm: V(0.16, 0.84 + pulse, 0.42),
        hand: V(0.12, 0.92 + pulse * 0.8, 0.32),
        twist: 0.28,
      });
      return {
        arms: { L: mk(-s), R: mk(s) },
        fingers: { L: HEART_HAND, R: HEART_HAND },
        spine: { chest: [0, s * 0.35, 0], head: [-0.02, -s * 0.4, 0] },
      };
    },
  },
} satisfies Record<string, GestureDef>;
