import type { GestureDef, ReachSpec } from '../../types';
import { V } from './base';
import { both, one, reachBoth } from './builders';
import { OPEN_HAND, PAW, PEACE_HAND, PEACE_PALM, PEACE_SPREAD, POINT_HAND } from './hands';

/** Playful — teasing, hiding, and waving tiny paws. */

const ease = (t: number, duration: number): number => {
  const x = Math.min(1, Math.max(0, t / duration));
  return x * x * (3 - 2 * x);
};

export const PLAYFUL = {
  peekaboo: {
    label: { en: 'Peekaboo', ja: 'いないいないばあ' },
    group: 'playful',
    lead: 0.5,
    hold: 2.5,
    build(t, _v) {
      // The hands begin closer to the eyes, then open sideways to reveal the
      // face. The poles keep both elbows stable while the hands travel.
      // Let the covering hands arrive before revealing the face. Starting the
      // opening during the entrance skipped the visible hide-and-reveal beat.
      const k = ease(t - 1, 0.8);
      return reachBoth(
        {
          // Start near the inner edge of each cheek to cover the eyes, then
          // travel to the near cheek itself so the face is revealed. The
          // resulting target stays on the same side throughout the opening.
          at: 'cheek',
          // Stay in front of the face through the whole sweep. A closer
          // target made the elbow fold flat before the hands separated.
          offset: [-0.58 + 1.35 * k, 0.1 - 0.65 * k, 1.4],
          hand: [0, 0.94, 0.34],
          palm: [0, 0.08, 1],
          pole: [0.42, -0.87, -0.28],
        },
        OPEN_HAND,
        { head: [-0.025, 0, 0] },
      );
    },
  },

  bunnyEars: {
    label: { en: 'Bunny ears', ja: 'うさみみ' },
    group: 'playful',
    lead: 0.38,
    hold: 2.0,
    build(t, v) {
      const b = Math.sin(t * 3.2 * v.rate) * 0.035 * v.scale;
      // Peace fingers beside the head, below the ears. This deliberately does
      // not reach for the crown or put a hand above the bust framing.
      return both(
        {
          upperArm: V(0.5, -0.38 + b, 0.28),
          lowerArm: V(0.28, 0.76 + b, 0.48),
          hand: V(0.18, 0.9 + b, 0.35),
          palm: PEACE_PALM,
          twist: 0.12,
        },
        PEACE_HAND,
        { head: [-0.03, 0, 0] },
        PEACE_SPREAD,
      );
    },
  },

  fingerWag: {
    label: { en: 'No, no', ja: 'めっ' },
    group: 'playful',
    lead: 0.3,
    hold: 1.7,
    build(t, v) {
      const s = Math.sin(t * 6.4 * v.rate) * 0.11 * v.scale;
      return one(
        v,
        {
          upperArm: V(0.42, -0.58, 0.34),
          lowerArm: V(0.17 + s, 0.75, 0.63),
          hand: V(0.1 + s * 1.25, 0.82, 0.55),
          twist: s * 0.8,
        },
        POINT_HAND,
        { head: [0, -0.04 * s, 0] },
      );
    },
  },

  pawBounce: {
    label: { en: 'Bouncy paws', ja: 'ぱたぱたおてて' },
    group: 'playful',
    lead: 0.42,
    hold: 2.1,
    build(t, v) {
      // Each paw has its own body reach so the two rise and fall opposite one
      // another. Begin the bounce after arrival so its downward half-cycle
      // cannot overfold an elbow during the entrance. Lower wrists leave the
      // eyes visible even with the validation avatar's long sleeves.
      const s = Math.sin(t * 4.5 * v.rate) * 0.05 * v.scale * ease(t - 1, 0.4);
      const paw = (vertical: number): ReachSpec => ({
        space: 'body',
        at: 'sternum',
        offset: [0.16, 0.2 + vertical, 0.35],
        hand: [0.1, 0.94, 0.32],
        palm: [0, 0.05, 1],
        pole: [0.3, -0.9, 0.3],
      });
      return {
        reach: { L: paw(-s), R: paw(s) },
        fingers: { L: PAW, R: PAW },
        spine: { head: [0.025 + s * 0.12, 0, 0] },
      };
    },
  },

  shoulderShimmy: {
    label: { en: 'Little wiggle', ja: 'くねくね' },
    group: 'playful',
    lead: 0.34,
    hold: 1.8,
    build(t, v) {
      const s = Math.sin(t * 4.4 * v.rate) * 0.07 * v.scale;
      return {
        spine: {
          chest: [0, s, s * 0.6],
          neck: [0, -s * 0.45, -s * 0.25],
          head: [0, -s * 0.7, -s * 0.45],
        },
      };
    },
  },
} satisfies Record<string, GestureDef>;
