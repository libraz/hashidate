import type { GestureDef } from '../../types';
import { V } from './base';
import { both, one, reach, reachBoth } from './builders';
import {
  CLASP_HAND,
  GUN_HAND,
  HEART_HAND,
  PEACE_HAND,
  PEACE_PALM,
  PEACE_SPREAD,
  PINKY_PROMISE_HAND,
  SOFT_HAND,
  THUMB_UP,
} from './hands';

/**
 * Pose — a standing attitude rather than a beat.
 *
 * Every entry here is `sustain`, which is what makes it usable for a whole
 * segment of a stream instead of running out on its own.
 */

export const POSE = {
  // Held until released rather than for a fixed beat. `sustain` is what makes
  // these usable as a standing attitude for a whole segment of a stream.
  armCross: {
    label: { en: 'Fold the arms', ja: '腕組み' },
    group: 'pose',
    sustain: true,
    lead: 0.5,
    hold: 1.0,
    build() {
      // Authored as directions, unlike the other poses whose hands have to meet.
      // A body-anchored wrist target does not describe this pose: what makes
      // folded arms read is where the upper arms sit, and a target for the wrist
      // leaves the elbow to the solver's own cost search, which puts it
      // somewhere different on each side. Composing the two — stated upper arm,
      // solved hand — is not something the arm path can express today.
      return both(
        {
          upperArm: V(0.34, -0.8, 0.4),
          lowerArm: V(-0.72, 0.1, 0.68),
          hand: V(-0.9, 0.06, 0.42),
          twist: -0.5,
        },
        SOFT_HAND,
        { chest: [0.02, 0, 0] },
      );
    },
  },

  handsClasp: {
    label: { en: 'Clasp the hands', ja: '手を組む' },
    group: 'pose',
    sustain: true,
    lead: 0.45,
    hold: 1.0,
    build() {
      // Clasped, so the two wrists sit side by side rather than palm to palm —
      // one hand's fingers wrap the other's back, which is half a hand's width
      // more than the contact gap.
      return reachBoth(
        {
          space: 'body',
          at: 'navel',
          offset: [0.06, 0.08, 0.22],
          // The hand follows the forearms as they converge. The old
          // upward-forward bearing pinned both wrist-deviation stops before
          // the hands could meet.
          hand: [-0.5, 0, 0.87],
          palm: [-0.6, 0.5, -0.6],
        },
        CLASP_HAND,
      );
    },
  },

  chin: {
    label: { en: 'Chin on hand', ja: '頬杖' },
    group: 'pose',
    sustain: true,
    lead: 0.55,
    hold: 1.0,
    build(_t, v) {
      // Jaw resting into the heel of the hand, head tipped toward it.
      return reach(
        v,
        {
          at: 'cheek',
          // The wrist stays in front while the fingers return toward the jaw.
          // The old positive-z bearing buried the wrist and put the fingers
          // over the eye, driving both elbow and shoulder stops. Leaving the
          // palm free preserved the silhouette but pinned the forearm at its
          // stop, so this diagonal normal distributes roll through the
          // shoulder and forearm instead.
          offset: [0.4, -0.45, 0.8],
          hand: [-0.4, 0.8, -0.45],
          palm: [-0.69, 0.41, -0.73],
          pole: [0.26, -0.92, 0.3],
        },
        { thumb: 0.3, index: 0.5, middle: 0.7, ring: 0.8, little: 0.85 },
        {
          head: [0.06, 0.08 * v.side, 0.1 * v.side],
          chest: [0.03, 0.04 * v.side, 0.03 * v.side],
        },
      );
    },
  },

  thumbsUp: {
    label: { en: 'Thumbs up', ja: 'サムズアップ' },
    group: 'pose',
    sustain: true,
    lead: 0.3,
    hold: 1.0,
    build(_t, v) {
      // Arm carried out with a slack elbow, forearm angled up, thumb vertical.
      //
      // The forearm angle is not a stylistic choice. Rolling the arm sweeps the
      // thumb around the forearm on a cone, and this rig's thumb sits only 30
      // degrees off that axis with the joint straight — so with the forearm
      // horizontal the thumb cannot get nearer than 57 degrees to vertical no
      // matter how far the arm twists, which is why the earlier pose came out
      // pointing away rather than up. Two things move it: raising the forearm,
      // and closing the thumb, whose flexion in this rig swings it out of the
      // forearm line rather than in toward the palm. Together they put the cone
      // where vertical is on it, and the roll does the rest.
      //
      // The palm has to be stated so that roll is solved rather than inherited.
      // It is spent on forearm pronation first and the shoulder second, and a
      // `twist` here would be ignored — that path only rolls the hand, and a
      // wrist has no axial travel to give.
      return one(
        v,
        {
          upperArm: V(0.32, 0.06, 0.95),
          lowerArm: V(0.3, 0.1, 0.95),
          hand: V(0.28, 0.7, 0.66),
          palm: V(-0.96, 0.1, -0.26),
        },
        THUMB_UP,
        { head: [-0.02, 0, 0] },
      );
    },
  },

  fingerHeart: {
    label: { en: 'Finger heart', ja: '指ハート' },
    group: 'pose',
    sustain: true,
    lead: 0.34,
    hold: 1.0,
    build(_t, v) {
      return one(
        v,
        {
          upperArm: V(0.38, -0.6, 0.4),
          lowerArm: V(0.16, 0.86, 0.42),
          hand: V(0.12, 0.92, 0.34),
          twist: 0.35,
        },
        HEART_HAND,
        { head: [0.01, 0.03 * v.side, 0.03 * v.side] },
      );
    },
  },

  bothPeace: {
    label: { en: 'Double peace sign', ja: '両手ピース' },
    group: 'pose',
    sustain: true,
    lead: 0.32,
    hold: 1.0,
    build() {
      return both(
        {
          upperArm: V(0.44, -0.52, 0.34),
          lowerArm: V(0.18, 0.9, 0.36),
          hand: V(0.14, 0.95, 0.24),
          palm: PEACE_PALM,
          twist: 0.15,
        },
        PEACE_HAND,
        { head: [-0.02, 0, 0] },
        PEACE_SPREAD,
      );
    },
  },

  gun: {
    label: { en: 'Finger gun', ja: '指鉄砲' },
    group: 'pose',
    sustain: true,
    lead: 0.28,
    hold: 1.0,
    build(_t, v) {
      return one(
        v,
        {
          upperArm: V(0.4, -0.62, 0.44),
          lowerArm: V(0.22, 0.28, 0.92),
          hand: V(0.16, 0.32, 0.92),
          twist: -0.4,
        },
        GUN_HAND,
        { head: [0, 0.04 * v.side, 0.03 * v.side] },
      );
    },
  },

  promise: {
    label: { en: 'Pinky promise', ja: 'ゆびきり' },
    group: 'pose',
    sustain: true,
    lead: 0.4,
    hold: 1.0,
    build(t, v) {
      // Held out and waiting, which is what makes it a promise rather than a
      // hand shape: the drift is small and slow, because an offered hand that
      // is perfectly still reads as a prop.
      const b = Math.sin(t * 1.5 * v.rate) * 0.03;
      return one(
        v,
        {
          // The arm goes out in front and the wrist bends up, which is where
          // `thumbsUp` puts it and for the same reason. Both of these poses ask
          // a viewer to read one extended finger, and one extended finger is
          // exactly what a long sleeve is good at hiding: the validation
          // avatar's cardigan cuff runs most of a hand's length past the wrist,
          // and with the forearm raised the whole hand sits down inside it —
          // the shot is a pink tube with a fist somewhere in the dark. Carried
          // forward with the hand angled off the forearm, the finger comes out
          // through the side of the opening instead of down the length of it.
          //
          // A raised forearm is the prettier pose on a bare arm and it is not
          // the one that survives the clothes.
          upperArm: V(0.32, 0.06, 0.95),
          lowerArm: V(0.3, 0.1 + b, 0.95),
          hand: V(0.28, 0.7 + b, 0.66),
          // Roll the ulnar/little-finger edge toward the viewer. The previous
          // palm target put that edge away from the shot; reversing it makes
          // hand × palm point forward, so the raised little finger reads at
          // the edge of the fist instead of disappearing behind it.
          palm: V(-0.96, 0.1, -0.26),
        },
        PINKY_PROMISE_HAND,
        { head: [0.02, 0.06 * v.side, 0.06 * v.side], chest: [0, 0.03 * v.side, 0] },
      );
    },
  },

  doze: {
    label: { en: 'Nod off', ja: 'こっくり' },
    group: 'pose',
    sustain: true,
    // Slow in, because falling asleep is the one entrance in this table that
    // should be visible as an entrance rather than as an arrival.
    lead: 1.5,
    hold: 1.0,
    build(t, v) {
      // Nodding off, which is not a deeper `bow` — the two poses differ in what
      // they do after they arrive. A bow is held square and comes back up; this
      // sinks, drifts, and every so often almost catches itself, and that
      // near-catch is the whole read. Both terms are small: what sells it is
      // that the head is *down* and not quite still.
      const drift = Math.sin(t * 0.55 * v.rate) * 0.05;
      const nearly = Math.sin(t * 1.7 * v.rate) * 0.02;
      return both(
        {
          // Slack rather than posed. The arms hanging almost where they rest is
          // the point — a sleeping character who is still holding their arms
          // somewhere is a character pretending to sleep.
          upperArm: V(0.22, -0.96, 0.14),
          lowerArm: V(0.14, -0.97, 0.18),
          hand: V(0.1, -0.97, 0.2),
        },
        { thumb: 0.3, index: 0.34, middle: 0.38, ring: 0.42, little: 0.46 },
        {
          // Tipped as well as dropped. A head that falls straight forward reads
          // as a faint rather than as sleep; the roll toward one shoulder is
          // what makes it read as comfortable.
          head: [0.34 + drift + nearly, 0.08 * v.side, 0.16 * v.side],
          neck: [0.24 + drift * 0.6, 0.04 * v.side, 0.08 * v.side],
          chest: [0.07, 0, 0.02 * v.side],
          spine: [0.05, 0, 0],
        },
      );
    },
  },

  listen: {
    label: { en: 'Hand to the ear', ja: '手を耳に' },
    group: 'pose',
    sustain: true,
    lead: 0.4,
    hold: 1.0,
    build(_t, v) {
      // Cupped behind the ear, so the palm faces forward past it.
      return reach(
        v,
        {
          at: 'ear',
          // Cupped behind the ear: the hand comes from below and slightly in
          // front, fingers tipped back, so the palm ends up facing forward past
          // the ear rather than the hand being planted flat on it.
          offset: [1.1, 0.38, 0.15],
          hand: [0.08, 0.63, -0.77],
          palm: [-0.24, 0.29, 0.93],
          pole: [0.85, -0.95, -0.2],
          twist: 0.4,
        },
        SOFT_HAND,
        { head: [0.02, -0.1 * v.side, -0.05 * v.side], chest: [0, -0.04 * v.side, 0] },
      );
    },
  },
} satisfies Record<string, GestureDef>;
