import type { GestureDef } from '../../types';
import { V } from './base';
import { both, reach, reachBoth } from './builders';
import { MOUTH_CONTACT, MOUTH_HAND, OPEN_HAND, PAW, POINT_HAND, SHUSH_HAND, shape } from './hands';

/**
 * Mannerism — the small unprompted things a character does.
 *
 * Half of these touch the face, which is why they are authored as reaches
 * rather than as directions: a direction fixes the elbow and leaves where the
 * hand lands to the avatar's arm length.
 */

/** Distance of the last index joint from the midline when the tips touch, in body spans. */
const FINGER_TOUCH_REACH = 0.026;

export const CUTE = {
  cheekPoke: {
    label: { en: 'Finger to the cheek', ja: '頬に指' },
    group: 'cute',
    lead: 0.45,
    hold: 2.6,
    build(t, v, _phase?, out?) {
      const b = Math.sin(t * 1.6 * v.rate) * 0.04;
      // Index fingertip on the cheek; the rest of the hand is folded away.
      return reach(
        out,
        v,
        {
          at: 'cheek',
          // Fingertip on the cheek from below, not from in front: the finger
          // comes up under the cheekbone with the hand still low, which keeps
          // the face unobscured and is the pose the gesture is drawn from.
          offset: [0.05, -0.05 + b, 1.15],
          hand: [-0.34, 0.92, -0.21],
          palm: [-0.71, 0.33, -0.62],
          pole: [0.3, -0.75, -0.45],
          twist: 0.45,
        },
        shape({ thumb: 0.45, index: 0.04, middle: 0.85, ring: 0.9, little: 0.92 }),
        { head: [0.04, 0.1 * v.side, 0.08 * v.side] },
      );
    },
  },

  faceCover: {
    label: { en: 'Hide the face', ja: '顔を隠す' },
    group: 'cute',
    lead: 0.45,
    hold: 2.6,
    build(t, v, _phase?, out?) {
      const s = Math.sin(t * 1.8 * v.rate) * v.scale;
      // Both palms over the face, where `peekaboo` hides before it opens. The
      // anchor is on the face, so the hands ride the head as it sways.
      return reachBoth(
        out,
        {
          at: 'cheek',
          offset: [-0.25, 0.1, 1.4],
          hand: [0, 0.94, 0.34],
          palm: [0, 0.08, 1],
          pole: [0.42, -0.87, -0.28],
        },
        OPEN_HAND,
        { head: [0.1, 0.07 * s, 0.04 * s], chest: [0.04, 0, 0] },
      );
    },
  },

  catPaw: {
    label: { en: 'Cat paws', ja: '猫の手' },
    group: 'cute',
    lead: 0.34,
    hold: 2.4,
    build(t, v, _phase?, out?) {
      // Both paws held up in front, palms to the viewer, fingers hooked. The
      // little bounce is what sells it.
      //
      // Anchored on the body rather than the face. Written against the chin it
      // put both wrists about eight centimetres from the shoulder, and the
      // elbow cannot fold that far — the arm has a nearest reachable point, and
      // this was inside it, so the pose collapsed and the hands came out behind
      // the shoulders. Paws belong out in front of the chest anyway.
      const b = Math.sin(t * 3.6 * v.rate) * 0.1;
      return reachBoth(
        out,
        {
          space: 'body',
          at: 'sternum',
          offset: [0.15, 0.32 + b * 0.1, 0.29],
          hand: [0.1, 0.94, 0.32],
          palm: [0, 0.05, 1],
          pole: [0.3, -0.9, 0.3],
        },
        PAW,
        { head: [0.03 + b * 0.1, 0, 0] },
      );
    },
  },

  sparkle: {
    label: { en: 'Sparkle', ja: 'キラキラ' },
    group: 'cute',
    lead: 0.3,
    hold: 2.2,
    build(t, v, _phase?, out?) {
      // Hands open beside the face, fingers fluttering.
      const f = 0.06 + 0.1 * (0.5 - 0.5 * Math.cos(t * 8.4 * v.rate));
      const b = Math.sin(t * 4.2 * v.rate) * 0.03;
      return both(
        out,
        {
          upperArm: V(0.54, -0.42 + b, 0.26),
          lowerArm: V(0.3, 0.86, 0.32),
          hand: V(0.24, 0.94, 0.22),
          twist: -0.3,
        },
        shape({ thumb: f, index: f, middle: f * 1.1, ring: f * 1.2, little: f * 1.3 }),
        { head: [-0.03, 0, 0] },
      );
    },
  },

  beg: {
    label: { en: 'Beg', ja: 'お願い' },
    group: 'cute',
    lead: 0.38,
    hold: 2.6,
    build(t, v, _phase?, out?) {
      // Palms together at the chest, head tipped up — the upward look is what
      // makes it read as pleading rather than as praying.
      const b = Math.sin(t * 2.8 * v.rate) * 0.02;
      return reachBoth(
        out,
        {
          space: 'body',
          at: 'sternum',
          offset: [0.055, 0.1 + b, 0.26],
          hand: [0.02, 0.86, 0.51],
          palm: [-1, 0, 0.05],
        },
        shape({ thumb: 0.15, index: 0.06, middle: 0.06, ring: 0.08, little: 0.1 }),
        { head: [-0.07, 0, 0.02], chest: [0.03, 0, 0] },
      );
    },
  },

  whisper: {
    label: { en: 'Whisper', ja: '内緒話' },
    group: 'cute',
    lead: 0.4,
    hold: 2.6,
    build(t, v, _phase?, out?) {
      const b = Math.sin(t * 1.5 * v.rate) * 0.03;
      // A finger to the lips: the index pad on the mouth, the rest folded away.
      return reach(
        out,
        v,
        {
          at: 'mouth',
          // The finger stands up with the palm turned in, which keeps the
          // folded fingers off the chin.
          offset: [0, b, 0],
          contact: { kind: 'finger', finger: 'index', segment: 1, fraction: 0.5, surface: 'pad' },
          hand: [-0.25, 0.95, -0.1],
          palm: [-0.5, 0, -0.87],
          pole: [0.34, -0.86, -0.22],
          twist: 0.7,
        },
        SHUSH_HAND,
        { head: [0.02, 0.14 * v.side, 0.04 * v.side], chest: [0.02, 0.06 * v.side, 0] },
      );
    },
  },

  yawn: {
    label: { en: 'Yawn', ja: 'あくび' },
    group: 'cute',
    lead: 0.5,
    hold: 1.8,
    lids: 0.3,
    build(t, v, _phase?, out?) {
      const k = Math.min(1, t / 0.7);
      const b = Math.sin(t * 1.3 * v.rate) * 0.03;
      return reach(
        out,
        v,
        {
          at: 'mouth',
          // The hand `cover` holds, a little lower: with the head tipped back
          // the fingers otherwise rose over the nose.
          offset: [0, -0.1 + b, 0.1],
          contact: MOUTH_CONTACT,
          hand: [-1, 0, 0],
          palm: [0, 0.1, -1],
          pole: [0.36, -0.88, -0.3],
          twist: 0.4,
        },
        MOUTH_HAND,
        { head: [-0.1 * k, 0, 0], chest: [-0.04 * k, 0, 0] },
      );
    },
  },

  fingerTouch: {
    label: { en: 'Fingertips together', ja: 'ゆびつんつん' },
    group: 'cute',
    lead: 0.45,
    hold: 2.8,
    build(t, v, _phase?, out?) {
      // The two index fingertips meet at the midline in front of the chin and
      // tap: they part a little and come back, so the offset never goes below
      // contact. Squared so the gap opens and closes smoothly from zero.
      const s = Math.sin(t * 2.4 * v.rate);
      const tap = s * s * 0.015 * v.scale;
      return reachBoth(
        out,
        {
          space: 'body',
          at: 'sternum',
          // The last index joint lands here, short of the tip by the tip
          // extension, so each joint sits that far from the midline.
          offset: [FINGER_TOUCH_REACH + tap, 0.28, 0.36],
          contact: { kind: 'finger', finger: 'index', segment: 1, fraction: 1 },
          hand: [-0.86, 0.3, 0.41],
          palm: [0.1, -0.85, -0.5],
          pole: [0.32, -0.88, -0.1],
        },
        POINT_HAND,
        { head: [0.07, 0.06 * v.side, 0.05 * v.side], chest: [0.02, 0, 0] },
      );
    },
  },

  stretch: {
    label: { en: 'Stretch', ja: '伸び' },
    group: 'cute',
    lead: 0.6,
    hold: 2.0,
    build(t, v, _phase?, out?) {
      // Arms up and the spine arching back. Elbows stay forward of the ears so
      // the hands do not leave the top of the frame.
      const k = Math.min(1, t / 0.8);
      const b = Math.sin(t * 1.1 * v.rate) * 0.02;
      return both(
        out,
        {
          shoulder: V(0.92, 0.1, 0.04),
          upperArm: V(0.56, -0.2 + b, 0.2),
          lowerArm: V(0.38, 0.9, 0.18),
          hand: V(0.3, 0.94, 0.1),
          twist: 0.2,
        },
        OPEN_HAND,
        { spine: [-0.05 * k, 0, 0], chest: [-0.08 * k, 0, 0], head: [-0.1 * k, 0, 0] },
      );
    },
  },
} satisfies Record<string, GestureDef>;
