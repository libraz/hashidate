import type { GestureDef } from '../../types';
import { V } from './base';
import type { ArmPose } from './builders';
import { both, one, pair } from './builders';
import { mixHand, OPEN_HAND, POINT_HAND, SOFT_HAND } from './hands';

/**
 * Explaining — presenting, offering, and pointing something out.
 *
 * The working gestures of a segment with a document up, so every one of them is
 * authored to leave the frame the slide occupies alone.
 */

export const EXPLAIN = {
  explain: {
    label: { en: 'Explain', ja: '説明する' },
    group: 'explain',
    lead: 0.35,
    hold: 3.4,
    build(t, v, _phase?, out?) {
      // The two arms are deliberately out of phase with each other. That offset
      // is structural, not per-playback variation, so it stays a constant.
      const w = t * 2.6 * v.rate;
      const a = Math.sin(w),
        b = Math.sin(w + Math.PI * 0.7);
      // The hand rides the beat with the arm: the palm turned up toward the
      // listener and the fingers opening as it lifts. Left to the aim, the palm
      // faces the floor and a curl that never changes reads as arms swung from
      // the shoulder with dead hands on the end.
      const mk = (p: number): ArmPose => ({
        upperArm: V(0.4, -0.78 + p * 0.1, 0.44),
        lowerArm: V(0.3 + p * 0.1, -0.24 + p * 0.2, 0.9),
        hand: V(0.26, -0.1 + p * 0.16, 0.94),
        palm: V(-0.5, 0.82 + p * 0.1, 0.1),
        twist: -0.35,
      });
      return pair(
        out,
        mk(a),
        mk(b),
        mixHand(SOFT_HAND, OPEN_HAND, 0.7 + 0.3 * a),
        mixHand(SOFT_HAND, OPEN_HAND, 0.7 + 0.3 * b),
        { chest: [0, a * 0.045, 0], head: [0, a * 0.05, b * 0.02] },
      );
    },
  },

  present: {
    label: { en: 'Present with both hands', ja: '両手で示す' },
    group: 'explain',
    lead: 0.42,
    hold: 2.8,
    build(t, v, _phase?, out?) {
      const b = Math.sin(t * 1.9 * v.rate) * 0.05;
      return both(
        out,
        {
          upperArm: V(0.44, -0.74, 0.42),
          lowerArm: V(0.3, -0.12 + b, 0.92),
          hand: V(0.24, -0.02 + b, 0.95),
          twist: -0.5,
        },
        OPEN_HAND,
      );
    },
  },

  pointUp: {
    label: { en: 'Raise a finger', ja: '指を立てる' },
    group: 'explain',
    lead: 0.28,
    hold: 2.2,
    build(t, v, _phase?, out?) {
      const b = Math.sin(t * 5.2 * v.rate) * 0.03;
      return one(
        out,
        v,
        {
          upperArm: V(0.34, -0.5, 0.34),
          lowerArm: V(0.14, 0.94 + b, 0.28),
          hand: V(0.1, 0.97, 0.18),
          twist: 0.2,
        },
        POINT_HAND,
        { head: [-0.05, 0, 0] },
      );
    },
  },
} satisfies Record<string, GestureDef>;
