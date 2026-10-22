import type { GestureDef, HandContact } from '../../types';
import { V } from './base';
import { both, reach, torso } from './builders';
import { OPEN_HAND, POINT_HAND } from './hands';

/** The index fingertip's pad, which is what rests on the forehead. */
const FOREHEAD_CONTACT: HandContact = {
  kind: 'finger',
  finger: 'index',
  segment: 1,
  fraction: 1,
  surface: 'pad',
};

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
    build(t, v, _phase?, out?) {
      // A damped oscillation, not a single dip: one beat reads as a twitch, and
      // the second, smaller beat is what makes it read as agreement.
      const a = Math.exp(-t * 1.5) * Math.sin(t * 7.6 * v.rate);
      return torso(out, {
        head: [0.15 * a, 0, 0],
        neck: [0.06 * a, 0, 0],
        chest: [0.025 * a, 0, 0],
      });
    },
  },

  tilt: {
    label: { en: 'Tilt the head', ja: '首をかしげる' },
    group: 'reaction',
    lead: 0.42,
    hold: 1.7,
    build(t, v, _phase?, out?) {
      const s = (0.15 + 0.02 * Math.sin(t * 1.2 * v.rate)) * v.side;
      return torso(out, { head: [0.02, 0.07 * v.side, s], neck: [0, 0.03 * v.side, s * 0.4] });
    },
  },

  lean: {
    label: { en: 'Lean in', ja: '身を乗り出す' },
    group: 'reaction',
    lead: 0.55,
    hold: 2.6,
    build(t, v, _phase?, out?) {
      const k = Math.min(1, t / 0.6);
      const b = Math.sin(t * 1.5 * v.rate) * 0.012;
      // Torso forward, head back up. Leaning with the head still down reads as
      // slumping rather than as interest.
      return torso(out, {
        spine: [(0.09 + b) * k, 0, 0],
        chest: [0.05 * k, 0, 0],
        head: [-0.085 * k, 0, 0],
      });
    },
  },

  think: {
    label: { en: 'Think', ja: '考える' },
    group: 'reaction',
    lead: 0.5,
    hold: 3.0,
    // 0.8 reads as a squint rather than closed eyes.
    lids: 0.95,
    build(t, v, _phase?, out?) {
      const b = Math.sin(t * 1.4 * v.rate) * 0.04;
      // The index fingertip rested on the forehead above the near brow, the rest
      // folded and the head tipped down into it; the chin is `chin`'s.
      return reach(
        out,
        v,
        {
          at: 'forehead',
          offset: [0, b, 0],
          contact: FOREHEAD_CONTACT,
          // Coming up from beside the face rather than across it keeps the
          // folded fingers off the eye; the palm faces in and back so what
          // roll is left lands in the forearm, not the wrist.
          hand: [-0.55, 0.8, -0.2],
          palm: [-0.7, 0, -0.7],
          pole: [0.34, -0.86, -0.22],
        },
        POINT_HAND,
        { head: [0.12, 0.1 * v.side, 0.06 * v.side], chest: [0.03, 0.05 * v.side, 0] },
      );
    },
  },

  shrug: {
    label: { en: 'Shrug', ja: '肩をすくめる' },
    group: 'reaction',
    lead: 0.34,
    hold: 1.8,
    build(_t, _v, _phase?, out?) {
      return both(
        out,
        {
          shoulder: V(0.92, 0.06, 0.06),
          upperArm: V(0.4, -0.84, 0.36),
          lowerArm: V(0.62, 0.35, 0.7),
          hand: V(0.6, 0.45, 0.66),
          twist: -0.8,
        },
        OPEN_HAND,
        { head: [0.05, 0, 0], chest: [-0.03, 0, 0] },
      );
    },
  },
} satisfies Record<string, GestureDef>;
