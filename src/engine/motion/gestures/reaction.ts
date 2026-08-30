import type { GestureDef } from '../../types';
import { V } from './base';
import { both, reach } from './builders';
import { OPEN_HAND } from './hands';

/**
 * Reaction — what the character does while listening.
 *
 * Mostly spine and head. These run under a line rather than instead of one, so
 * an entry that took the arms somewhere would fight whatever the turn is
 * already playing.
 */

export const REACTION = {
  nod: {
    label: { en: 'Nod', ja: 'うなずく' },
    group: 'reaction',
    lead: 0.12,
    hold: 0.55,
    build(t, v) {
      // A damped oscillation, not a single dip: one beat reads as a twitch, and
      // the second, smaller beat is what makes it read as agreement.
      const a = Math.exp(-t * 1.5) * Math.sin(t * 7.6 * v.rate);
      return {
        spine: { head: [0.15 * a, 0, 0], neck: [0.06 * a, 0, 0], chest: [0.025 * a, 0, 0] },
      };
    },
  },

  tilt: {
    label: { en: 'Tilt the head', ja: '首をかしげる' },
    group: 'reaction',
    lead: 0.42,
    hold: 1.7,
    build(t, v) {
      const s = (0.15 + 0.02 * Math.sin(t * 1.2 * v.rate)) * v.side;
      return { spine: { head: [0.02, 0.07 * v.side, s], neck: [0, 0.03 * v.side, s * 0.4] } };
    },
  },

  lean: {
    label: { en: 'Lean in', ja: '身を乗り出す' },
    group: 'reaction',
    lead: 0.55,
    hold: 2.6,
    build(t, v) {
      const k = Math.min(1, t / 0.6);
      const b = Math.sin(t * 1.5 * v.rate) * 0.012;
      // Torso forward, head back up. Leaning with the head still down reads as
      // slumping rather than as interest.
      return {
        spine: {
          spine: [(0.09 + b) * k, 0, 0],
          chest: [0.05 * k, 0, 0],
          head: [-0.085 * k, 0, 0],
        },
      };
    },
  },

  think: {
    label: { en: 'Think', ja: '考える' },
    group: 'reaction',
    lead: 0.5,
    hold: 3.0,
    build(t, v) {
      const b = Math.sin(t * 1.4 * v.rate) * 0.05;
      // Knuckle to the chin, the way a hand rests there while thinking. The
      // wrist stays in front while the fingertips and index return toward the
      // chin and cheek; the rounded entrance keeps that relationship visible.
      return reach(
        v,
        {
          at: 'chin',
          // The old positive-forward hand bearing buried the wrist behind the
          // face, making torso clearance consume the elbow, forearm and
          // shoulder ranges. This rounded bearing keeps the hand in front.
          offset: [0.1, 0.66 + b, 0.62],
          hand: [-0.48, 0.65, -0.6],
          // The palm target distributes the roll through the arm; a separate
          // twist only spent more of the wrist and shoulder ranges.
          palm: [0.51, -0.79, 0.21],
          pole: [0.57, -0.93, 0.32],
        },
        { thumb: 0.4, index: 0.15, middle: 0.7, ring: 0.85, little: 0.9 },
        { head: [0.05, 0.13 * v.side, 0.07 * v.side], chest: [0, 0.05 * v.side, 0] },
      );
    },
  },

  shrug: {
    label: { en: 'Shrug', ja: '肩をすくめる' },
    group: 'reaction',
    lead: 0.34,
    hold: 1.8,
    build() {
      return both(
        {
          shoulder: V(0.92, 0.06, 0.06),
          upperArm: V(0.52, -0.72, 0.38),
          lowerArm: V(0.52, -0.28, 0.78),
          hand: V(0.5, -0.16, 0.84),
          twist: -0.8,
        },
        OPEN_HAND,
        { head: [0.05, 0, 0], chest: [-0.03, 0, 0] },
      );
    },
  },
} satisfies Record<string, GestureDef>;
