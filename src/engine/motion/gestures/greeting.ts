import type { GestureDef } from '../../types';
import { V } from './base';
import type { ArmPose } from './builders';
import { both, one } from './builders';
import { FIST, mixHand, OPEN_HAND, SOFT_HAND } from './hands';

/**
 * Greeting — arriving, beckoning, and thanking.
 *
 * The entries a stream opens and closes with, so they are the ones most often
 * seen twice in a row: each is authored to read on either hand. `comeHere` and
 * `bow` use both hands; `wave` follows the caller's chosen hand.
 */

/** Seconds per beckoning curl: about two cycles in the nominal 2.6 s hold after the opening. */
const BECKON_PERIOD = 0.9;

export const GREETING = {
  wave: {
    label: { en: 'Wave', ja: '手を振る' },
    group: 'greeting',
    lead: 0.3,
    hold: 2.6,
    build(t, v, _phase?, out?) {
      const s = Math.sin(t * 7.4 * v.rate);
      // The swing decays a little: a wave held at constant amplitude for three
      // seconds is a metronome, not a greeting.
      const a = 1 - 0.3 * (1 - Math.exp(-t / 1.8));
      const arm: ArmPose = {
        // Elbow out and a little below the shoulder, forearm up. Kept
        // deliberately narrow — anything wider leaves a bust framing.
        upperArm: V(0.48, -0.46, 0.3),
        lowerArm: V(0.18 + s * 0.12 * a, 0.94, 0.28),
        hand: V(0.14 + s * 0.18 * a, 0.96, 0.2),
        twist: s * 0.18 * a,
      };
      return one(out, v, arm, OPEN_HAND, {
        head: [0, 0, 0.03 * s * v.side],
        chest: [0, 0.02 * s * v.side, 0],
      });
    },
  },

  comeHere: {
    label: { en: 'Beckon', ja: 'おいで' },
    group: 'greeting',
    lead: 0.4,
    hold: 2.6,
    build(t, v, _phase?, out?) {
      // Both arms opened forward, palms up. The opening is the gesture — held
      // spread from the first frame it reads as a shrug — so the arms travel
      // outward over the first second and settle.
      const openingDuration = 0.9;
      const o = Math.min(1, t / openingDuration);
      const b = Math.sin(t * 1.6 * v.rate) * 0.03;
      // The fingers curl between the open invitation and the existing FIST.
      const beckonTime = Math.max(0, t - openingDuration) * v.rate;
      const curl = (1 - Math.cos((2 * Math.PI * beckonTime) / BECKON_PERIOD)) / 2;
      const fingers = {
        ...mixHand({ thumb: 0.18, index: 0.14, middle: 0.16, ring: 0.2, little: 0.26 }, FIST, curl),
        thumb: 0.18,
      };
      // The palm has to be stated. Aiming the hand forward leaves the roll
      // free, and an invitation with the palms rolled over is a shove. The
      // fully skyward target pinned one shoulder at its stop; this diagonal
      // upward normal keeps the invitation readable while leaving range in
      // both models.
      return both(
        out,
        {
          upperArm: V(0.3 + 0.08 * o, -0.76 + 0.12 * o + b, 0.54 + 0.18 * o),
          lowerArm: V(0.14 + 0.08 * o, 0.24 + b, 0.95),
          hand: V(0.14, 0.2, 0.97),
          palm: V(-0.68, 0.48, -0.16),
        },
        fingers,
        { head: [-0.03, 0, 0], chest: [0.02, 0, 0] },
      );
    },
  },

  bow: {
    label: { en: 'Bow', ja: 'ぺこり' },
    group: 'greeting',
    // Short, because the speed is the gesture, but not snapped: down in 0.2 s
    // read as the head being yanked. The release ramp is `lead × 1.25`, so this
    // is down in 0.3 s, a beat at the bottom, and up in 0.38 s.
    lead: 0.3,
    hold: 0.2,
    build(_t, v, _phase?, out?) {
      // A bob, not a bow.
      //
      // This bent the trunk twelve degrees over half a second, and at that speed
      // and that depth it read as neither: too shallow to be a formal bow, too
      // slow to be a greeting, and the head never left the range the idle moves
      // it through anyway. What makes a ぺこり is where the angle sits and how
      // fast it arrives — most of it in the neck, quickly. The head drops about
      // thirty degrees all told; forty-four, nearly all in the neck, read as the
      // head snapping down rather than a greeting.
      //
      // The trunk carries about a third of it. A head that pitches on a still
      // body is a nod; the chest is what makes it the whole character bobbing
      // rather than just the face.
      //
      // The head also turns very slightly as it goes. Perfectly square is the
      // difference between a character and a mechanism, and this is the one
      // gesture short enough that a viewer sees the whole of it at once.
      return both(
        out,
        {
          upperArm: V(0.2, -0.96, 0.2),
          lowerArm: V(0.12, -0.86, 0.5),
          hand: V(0.08, -0.88, 0.47),
        },
        SOFT_HAND,
        {
          head: [0.22, 0.05 * v.side, 0.06 * v.side],
          neck: [0.12, 0.03 * v.side, 0.03 * v.side],
          chest: [0.11, 0, 0],
          spine: [0.06, 0, 0],
        },
      );
    },
  },
} satisfies Record<string, GestureDef>;
