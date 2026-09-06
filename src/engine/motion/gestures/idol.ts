import type { GestureDef } from '../../types';
import { V } from './base';
import type { ArmPose } from './builders';
import { both, reach } from './builders';
import { OPEN_HAND, POINT_HAND, SOFT_HAND } from './hands';

/** Idol — bright stage gestures that stay inside the bust shot. */

const ease = (t: number, duration: number): number => {
  const x = Math.min(1, Math.max(0, t / duration));
  return x * x * (3 - 2 * x);
};

export const IDOL = {
  doubleWave: {
    label: { en: 'Wave with both hands', ja: '両手でばいばい' },
    group: 'idol',
    lead: 0.34,
    hold: 2.0,
    build(t, v) {
      const s = Math.sin(t * 7.1 * v.rate) * 0.16 * v.scale;
      const arm: ArmPose = {
        upperArm: V(0.48, -0.46, 0.3),
        lowerArm: V(0.18 + s, 0.92, 0.3),
        hand: V(0.14 + s * 1.4, 0.95, 0.22),
        twist: s * 0.9,
      };
      return {
        arms: { L: arm, R: arm },
        fingers: { L: OPEN_HAND, R: OPEN_HAND },
        spine: { head: [0, 0, 0.03 * s], chest: [0, 0.015 * s, 0] },
      };
    },
  },

  idolPoint: {
    label: { en: 'Idol point', ja: 'アイドルポーズ' },
    group: 'idol',
    lead: 0.36,
    hold: 2.1,
    build(t, v) {
      const s = Math.sin(t * 3.2 * v.rate) * 0.03 * v.scale;
      const point: ArmPose = {
        upperArm: V(0.4, -0.52, 0.4),
        lowerArm: V(0.35 + s, 0.42, 0.82),
        hand: V(0.28 + s, 0.5, 0.82),
        twist: -0.25,
      };
      const frame: ArmPose = {
        upperArm: V(0.42, -0.78, 0.28),
        lowerArm: V(0.28, -0.34 + s, 0.88),
        hand: V(0.22, -0.25 + s, 0.92),
        twist: -0.15,
      };
      const arms = v.side > 0 ? { L: frame, R: point } : { L: point, R: frame };
      const fingers =
        v.side > 0 ? { L: OPEN_HAND, R: POINT_HAND } : { L: POINT_HAND, R: OPEN_HAND };
      return { arms, fingers, spine: { head: [-0.03, 0.04 * v.side, 0.02 * v.side] } };
    },
  },

  spotlight: {
    label: { en: 'Ta-da', ja: 'じゃーん' },
    group: 'idol',
    lead: 0.4,
    hold: 2.0,
    build(t, v) {
      const s = Math.sin(t * 2.8 * v.rate) * 0.025 * v.scale;
      const presentation: ArmPose = {
        upperArm: V(0.5, -0.5 + s, 0.3),
        lowerArm: V(0.34, -0.03 + s, 0.92),
        hand: V(0.28, 0.06 + s, 0.95),
        palm: V(-0.65, 0.38, -0.35),
        twist: -0.2,
      };
      const close: ArmPose = {
        upperArm: V(0.38, -0.8, 0.3),
        lowerArm: V(0.3, -0.3 - s, 0.88),
        hand: V(0.22, -0.22 - s, 0.93),
        palm: V(-0.5, 0.35, -0.79),
        twist: 0.15,
      };
      return {
        arms: { L: presentation, R: close },
        fingers: { L: OPEN_HAND, R: OPEN_HAND },
        spine: { chest: [0, 0.025 * s, 0], head: [-0.03, 0, 0] },
      };
    },
  },

  cuteSalute: {
    label: { en: 'Cute salute', ja: 'かわいく敬礼' },
    group: 'idol',
    lead: 0.48,
    hold: 1.8,
    build(t, v) {
      const b = Math.sin(t * 2.1 * v.rate) * 0.025 * v.scale;
      return reach(
        v,
        {
          // Kept beside the lower cheek so the salute stays below the temple
          // and leaves the eyes readable on both validation avatars.
          at: 'cheek',
          offset: [0.24, -0.42 + b, 0.78],
          hand: [0.1, 0.86, -0.5],
          palm: [-0.35, 0.2, 0.91],
          pole: [0.62, -0.88, -0.3],
          twist: 0.35,
        },
        SOFT_HAND,
        { head: [0.015, 0.08 * v.side, 0.05 * v.side] },
      );
    },
  },

  stageBow: {
    label: { en: 'Stage bow', ja: 'ステージのお辞儀' },
    group: 'idol',
    lead: 0.52,
    hold: 0.55,
    build(t, v) {
      const k = ease(t, 0.7);
      return both(
        {
          upperArm: V(0.24, -0.94, 0.18),
          lowerArm: V(0.16, -0.86, 0.48),
          hand: V(0.1, -0.9, 0.43),
        },
        SOFT_HAND,
        {
          head: [0.46 * k, 0.045 * v.side * k, 0.055 * v.side * k],
          neck: [0.25 * k, 0.025 * v.side * k, 0.025 * v.side * k],
          chest: [0.14 * k, 0, 0],
          spine: [0.07 * k, 0, 0],
        },
      );
    },
  },
} satisfies Record<string, GestureDef>;
