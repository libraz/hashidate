import type { GestureDef } from '../../types';
import { V } from './base';
import { both, one, reach, reachBoth } from './builders';
import { FIST, OPEN_HAND, PEACE_HAND, PEACE_PALM, PEACE_SPREAD, SOFT_HAND } from './hands';

/**
 * Feeling — the reactions that are a whole movement rather than a face.
 *
 * These are the loudest entries in the table and the ones most likely to be
 * asked for by name, so each is written to read at a bust framing without
 * throwing an elbow out of shot.
 */

export const EMOTE = {
  peace: {
    label: { en: 'Peace sign', ja: 'ピース' },
    group: 'emote',
    lead: 0.3,
    hold: 2.4,
    build(t, v) {
      const b = Math.sin(t * 2.2 * v.rate) * 0.03;
      return one(
        v,
        {
          upperArm: V(0.38, -0.58, 0.36),
          lowerArm: V(0.14, 0.92 + b, 0.34),
          hand: V(0.1, 0.96, 0.22),
          palm: PEACE_PALM,
          twist: 0.15,
        },
        PEACE_HAND,
        { head: [0.01, 0.03, 0.035] },
        PEACE_SPREAD,
      );
    },
  },

  clap: {
    label: { en: 'Applaud', ja: '拍手' },
    group: 'emote',
    lead: 0.2,
    hold: 2.2,
    build(t, v) {
      // Rectified sine so the hands *meet* on the beat and rebound. A plain
      // sine carries them through each other and out the far side.
      //
      // The floor is half the gap between two palms that are touching, which is
      // a measured figure and not a guess — at zero the two wrists would occupy
      // the same point and the hands interpenetrate. Written as a lateral offset
      // from the midline, mirrored per side, so the beat is the only thing that
      // moves and the hands cannot miss each other.
      const gap = 0.028 + Math.abs(Math.sin(t * 6.2 * v.rate)) * 0.08;
      return reachBoth(
        {
          space: 'body',
          at: 'sternum',
          offset: [gap, 0.02, 0.2],
          // Fingers angle upward along the converging forearm. The old
          // near-forward bearing hit both wrist-deviation stops instead of
          // letting the forearm carry the beat.
          hand: [-0.2, 0.6, 0.77],
          palm: [-1, 0, 0],
        },
        OPEN_HAND,
        { chest: [-0.02, 0, 0], head: [-0.03, 0, 0] },
      );
    },
  },

  cheer: {
    label: { en: 'Cheer', ja: '喜ぶ' },
    group: 'emote',
    lead: 0.26,
    hold: 1.9,
    build(t, v) {
      // Hands up but not overhead. An overhead cheer leaves the bust framing
      // entirely and reads as a character with no hands.
      const b = Math.sin(t * 5.6 * v.rate) * 0.05;
      return both(
        {
          upperArm: V(0.52, -0.32 + b, 0.28),
          lowerArm: V(0.34, 0.88, 0.3),
          hand: V(0.26, 0.94, 0.2),
          twist: 0.1,
        },
        OPEN_HAND,
        { chest: [-0.045, 0, 0], head: [-0.06, 0, 0] },
      );
    },
  },

  cover: {
    label: { en: 'Cover the mouth', ja: '口元を隠す' },
    group: 'emote',
    lead: 0.42,
    hold: 2.4,
    build(t, v) {
      const b = Math.sin(t * 1.7 * v.rate) * 0.04;
      return reach(
        v,
        {
          at: 'mouth',
          // Held a little below the mouth and well clear of it, fingers angled
          // back toward the cheek rather than out at the viewer. That is the
          // shape the gesture is named for — a hand raised to screen a smile,
          // not a palm clamped over a mouth — and it is also the version the
          // wrist can hold: at the mouth itself the arm is folded to its stop
          // and every degree of hand angle has to come out of the wrist.
          offset: [0.1, -0.05 + b, 0.75],
          hand: [-0.3, 0.92, -0.27],
          palm: [-0.83, 0.25, -0.5],
          pole: [0.4, -0.86, -0.3],
          twist: 0.5,
        },
        SOFT_HAND,
        { head: [0.06, 0.1 * v.side, 0.05 * v.side], chest: [0.02, 0.04 * v.side, 0] },
      );
    },
  },

  deny: {
    label: { en: 'Wave it off', ja: '手を横に振る' },
    group: 'emote',
    lead: 0.22,
    hold: 1.5,
    build(t, v) {
      const s = Math.sin(t * 8.6 * v.rate);
      return one(
        v,
        {
          upperArm: V(0.44, -0.54, 0.34),
          lowerArm: V(0.16 + s * 0.14, 0.9, 0.34),
          hand: V(0.08 + s * 0.34, 0.92, 0.2),
          twist: s * 0.34,
        },
        OPEN_HAND,
        { head: [0, -0.05 * s, 0.02 * s] },
      );
    },
  },

  pout: {
    label: { en: 'Fume', ja: 'ぷんすか' },
    group: 'emote',
    lead: 0.24,
    hold: 1.6,
    build(t, v) {
      // Small fists shaken at chest height. Fast and short-travelled: a wide
      // swing reads as a tantrum rather than as sulking.
      const s = Math.sin(t * 7.8 * v.rate) * 0.05;
      return both(
        {
          upperArm: V(0.38, -0.86, 0.22),
          lowerArm: V(0.3, -0.42 + s, 0.84),
          hand: V(0.26, -0.3 + s, 0.9),
          twist: -0.3,
        },
        FIST,
        { chest: [-0.03, 0, 0], head: [-0.04, 0, 0.02 * Math.sin(t * 3.9 * v.rate)] },
      );
    },
  },
} satisfies Record<string, GestureDef>;
