import type { GestureDef } from '../../types';
import { V } from './base';
import type { ArmPose } from './builders';
import { both, one } from './builders';
import { FIST, OPEN_HAND } from './hands';

/** Encouragement — compact cheers that keep the hands in the shot. */

const ease = (t: number, duration: number): number => {
  const x = Math.min(1, Math.max(0, t / duration));
  return x * x * (3 - 2 * x);
};

export const CHEER = {
  fistPump: {
    label: { en: 'Yes!', ja: 'よしっ' },
    group: 'cheer',
    lead: 0.3,
    hold: 1.7,
    build(t, v) {
      const s = Math.sin(t * 5.8 * v.rate) * 0.09 * v.scale;
      return one(
        v,
        {
          upperArm: V(0.44, -0.48 + s * 0.25, 0.3),
          lowerArm: V(0.25, 0.68 + s, 0.62),
          hand: V(0.18, 0.78 + s * 1.2, 0.58),
          twist: -0.12,
        },
        FIST,
        { chest: [-0.025 * s, 0, 0], head: [-0.03 * s, 0, 0] },
      );
    },
  },

  doublePump: {
    label: { en: 'We did it!', ja: 'やったー' },
    group: 'cheer',
    lead: 0.34,
    hold: 1.8,
    build(t, v) {
      const s = Math.sin(t * 5.6 * v.rate) * 0.075 * v.scale;
      return both(
        {
          upperArm: V(0.45, -0.48 + s * 0.25, 0.3),
          lowerArm: V(0.28, 0.68 + s, 0.62),
          hand: V(0.2, 0.79 + s * 1.15, 0.56),
          twist: -0.12,
        },
        FIST,
        { chest: [-0.035 * s, 0, 0], head: [-0.04 * s, 0, 0] },
      );
    },
  },

  rahRah: {
    label: { en: 'Go, go!', ja: 'フレーフレー' },
    group: 'cheer',
    lead: 0.38,
    hold: 1.9,
    build(t, v) {
      const s = Math.sin(t * 5.2 * v.rate) * 0.08 * v.scale;
      const mk = (pulse: number): ArmPose => ({
        upperArm: V(0.46, -0.46 + pulse * 0.2, 0.3),
        lowerArm: V(0.26, 0.67 + pulse, 0.63),
        hand: V(0.18, 0.78 + pulse * 1.2, 0.58),
        twist: -0.08,
      });
      return {
        arms: { L: mk(-s), R: mk(s) },
        fingers: { L: FIST, R: FIST },
        spine: { chest: [0, s * 0.25, 0], head: [-0.035 * s, 0, 0] },
      };
    },
  },

  encourage: {
    label: { en: 'You can do it', ja: 'がんばって' },
    group: 'cheer',
    lead: 0.38,
    hold: 2.0,
    build(t, v) {
      const b = Math.sin(t * 2.5 * v.rate) * 0.025 * v.scale;
      return both(
        {
          upperArm: V(0.42, -0.7 + b, 0.36),
          lowerArm: V(0.28, 0.14 + b, 0.95),
          hand: V(0.2, 0.2 + b, 0.96),
          palm: V(0, 0.1, 1),
        },
        OPEN_HAND,
        { head: [-0.02, 0, 0], chest: [0, 0.02 * b, 0] },
      );
    },
  },

  bravo: {
    label: { en: 'Bravo!', ja: 'ブラボー' },
    group: 'cheer',
    lead: 0.46,
    hold: 1.9,
    build(t, v) {
      // Open from a compact chest position into a broad, frame-safe sweep.
      const k = ease(t, 0.7);
      const b = Math.sin(t * 2.3 * v.rate) * 0.02 * v.scale;
      return both(
        {
          upperArm: V(0.34 + 0.13 * k, -0.8 + 0.26 * k + b, 0.3 + 0.08 * k),
          lowerArm: V(0.2 + 0.13 * k, -0.28 + 0.54 * k + b, 0.9),
          hand: V(0.16 + 0.1 * k, -0.2 + 0.63 * k + b, 0.94),
          palm: V(-0.58, 0.35, -0.73),
        },
        OPEN_HAND,
        { chest: [-0.025 * k, 0, 0], head: [-0.04 * k, 0, 0] },
      );
    },
  },
} satisfies Record<string, GestureDef>;
