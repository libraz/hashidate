import * as THREE from 'three';
import type {
  ArmDirections,
  ArmSlot,
  FingerName,
  FingerSpec,
  GestureDef,
  GestureGroup,
  GestureVariation,
  Pose,
  ReachSpec,
  Side,
  SpineOffsets,
} from '../types';

/**
 * Gesture table.
 *
 * Poses are authored in "character space" — x outward from the midline, y up,
 * z forward — and mirrored per side at apply time. Written this way a gesture
 * works on either arm and on any rig, because the rig resolves directions
 * rather than local angles.
 *
 * Two rules govern everything here:
 *
 * 1. **Everything fits a bust framing.** That is the shot an AITuber streams.
 *    A gesture that throws an elbow wide or raises a hand overhead puts the
 *    hand outside the frame, and a character gesturing at nothing is worse than
 *    a character standing still.
 *
 * 2. **Oscillations start at zero.** `build(t, v)` is called from t=0, so every
 *    periodic term is written `sin(t * w * v.rate)` and never `sin(t * w + phase)`.
 *    A phase offset means the term is already mid-swing on the first frame and
 *    the limb snaps into the gesture. Variation comes from `v.rate` (frequency)
 *    and `v.scale` (amplitude), neither of which breaks the zero start.
 *
 *    `explain` is the one deliberate exception, and states its own reason where
 *    it breaks the rule. It is exempt because the gesture's entrance eases the
 *    whole pose in over its lead, so the offset arrives scaled to nothing rather
 *    than as a step. Anything added here follows the rule unless it can make the
 *    same argument in the same place.
 */

/**
 * One arm as this table authors it: the four link directions, plus the palm
 * roll and the hand twist that some poses also state.
 */
interface ArmPose extends ArmDirections {
  palm?: THREE.Vector3;
  twist?: number;
}

const V = (x: number, y: number, z: number): THREE.Vector3 =>
  new THREE.Vector3(x, y, z).normalize();

export const BASE_POSE: Record<ArmSlot, THREE.Vector3> = {
  shoulder: V(0.95, -0.26, 0.06),
  upperArm: V(0.3, -0.94, 0.14),
  lowerArm: V(0.17, -0.95, 0.26),
  hand: V(0.13, -0.96, 0.24),
};

/**
 * Which way the palm faces, in character space.
 *
 * Aiming the hand only says where the fingers point; the roll about that axis
 * is a second degree of freedom and has to be given, or it falls out of the
 * rest pose as an accident. A hand at rest by the side turns its palm inward
 * toward the thigh and slightly back — hanging it palm-forward is the single
 * most common tell of an unposed rig.
 */
export const BASE_PALM: THREE.Vector3 = V(-0.88, 0.06, -0.47);

export const BASE_FINGERS: Record<FingerName, number> = {
  thumb: 0.22,
  index: 0.28,
  middle: 0.34,
  ring: 0.4,
  little: 0.46,
};

// 0 = straight, 1 = fully closed.
const OPEN_HAND: Record<FingerName, number> = {
  thumb: 0.1,
  index: 0.06,
  middle: 0.06,
  ring: 0.08,
  little: 0.12,
};
const SOFT_HAND: Record<FingerName, number> = {
  thumb: 0.2,
  index: 0.22,
  middle: 0.26,
  ring: 0.3,
  little: 0.34,
};
// Exported because the fingertip solver needs it too: a hand aimed at a target
// by its index finger has to actually be shaped like one, or the coordinate
// refers to a fingertip that is curled into the palm.
export const POINT_HAND: Record<FingerName, number> = {
  thumb: 0.35,
  index: 0.02,
  middle: 0.95,
  ring: 0.98,
  little: 0.98,
};
const PEACE_HAND: Record<FingerName, number> = {
  thumb: 0.8,
  index: 0.02,
  middle: 0.02,
  ring: 0.95,
  little: 0.95,
};
const FIST: Record<FingerName, number> = {
  thumb: 0.7,
  index: 0.92,
  middle: 0.94,
  ring: 0.95,
  little: 0.96,
};
const PAW: Record<FingerName, number> = {
  thumb: 0.68,
  index: 0.76,
  middle: 0.8,
  ring: 0.82,
  little: 0.84,
};
const THUMB_UP: Record<FingerName, number> = {
  thumb: 0.02,
  index: 0.95,
  middle: 0.96,
  ring: 0.97,
  little: 0.98,
};
const GUN_HAND: Record<FingerName, number> = {
  thumb: 0.05,
  index: 0.02,
  middle: 0.95,
  ring: 0.97,
  little: 0.98,
};
const HEART_HAND: Record<FingerName, number> = {
  thumb: 0.55,
  index: 0.62,
  middle: 0.95,
  ring: 0.97,
  little: 0.98,
};
const CLASP_HAND: Record<FingerName, number> = {
  thumb: 0.5,
  index: 0.6,
  middle: 0.62,
  ring: 0.64,
  little: 0.66,
};

export const GESTURE_GROUPS: Record<GestureGroup, string> = {
  reaction: '相槌',
  greeting: '挨拶',
  explain: '説明',
  emote: '感情',
  cute: '仕草',
  pose: 'ポーズ',
};

/** Pick the acting hand. Single-handed gestures that read fine either way. */
const H = (v: GestureVariation): Side => (v.side > 0 ? 'R' : 'L');

/** One-handed result helper: keeps the side choice in one place. */
const one = (
  v: GestureVariation,
  arm: ArmPose,
  fingers: FingerSpec,
  spine?: SpineOffsets,
): Pose => ({
  arms: { [H(v)]: arm },
  fingers: { [H(v)]: fingers },
  ...(spine ? { spine } : {}),
});

/** Two-handed result helper. */
const both = (arm: ArmPose, fingers: FingerSpec, spine?: SpineOffsets): Pose => ({
  arms: { L: arm, R: arm },
  fingers: { L: fingers, R: fingers },
  ...(spine ? { spine } : {}),
});

/**
 * Reach helpers, for gestures that have to make contact with the face.
 *
 * These specify *where the hand goes*, not which way the limbs point, and the
 * runtime solves the arm for it. Directions cannot do this job: a direction
 * fixes the elbow's bearing, and where the hand then ends up depends on how
 * long the avatar's arm is. Authored as directions, every one of these gestures
 * left the hand hanging in the air in front of the face.
 *
 *   at      face anchor (see FACE_ANCHORS)
 *   offset  nudge from that anchor, in IPD units, right/up/forward
 *   hand    wrist-to-fingertip direction, in character space
 *   pole    where the elbow is drawn toward, from the shoulder, character space
 *
 * **`pole` is stated per pose, and has to be.** Fixing the wrist leaves the
 * elbow a whole circle to sit on, and something has to choose. This is the same
 * job the pole vector does on a two-bone constraint in any animation package —
 * Unity's hint transform, Unreal's joint target location — and it is given the
 * same way they give it, as a place rather than as an amount of rotation.
 *
 * That distinction is the whole point. The alternative is an angle about the
 * shoulder-to-wrist line, and that line swings through most of a right angle
 * between a hand at the hip and a hand at the mouth. An angle is therefore only
 * meaningful at the single pose it was measured on: these poses carried
 * measured angles for a while, and while each one was right where it stopped,
 * every one of them drew a wild arc getting there, because the elbow was being
 * held at a fixed bearing off a line that was itself rotating. Stated as a
 * place beside the ribs, the elbow simply stays beside the ribs the whole way.
 *
 * Only the direction from the shoulder matters — the component along the reach
 * is removed, so how far out the point sits changes nothing. Numbers are in
 * body spans anyway, so they stay readable next to the offsets.
 *
 * Leaving it out is allowed and means "search the circle for the least strained
 * elbow". That is a poor default for anything near the face: the cost surface
 * has two near-level minima for most face-height targets, so the arm picks a
 * different one as the pose breathes and snaps between them.
 */
const reach = (
  v: GestureVariation,
  spec: ReachSpec,
  fingers: FingerSpec,
  spine?: SpineOffsets,
): Pose => ({
  reach: { [H(v)]: spec },
  fingers: { [H(v)]: fingers },
  ...(spine ? { spine } : {}),
});

const reachBoth = (spec: ReachSpec, fingers: FingerSpec, spine?: SpineOffsets): Pose => ({
  reach: { L: spec, R: spec },
  fingers: { L: fingers, R: fingers },
  ...(spine ? { spine } : {}),
});

export const GESTURES = {
  // --- reaction -----------------------------------------------------------
  nod: {
    label: 'うなずく',
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
    label: '首をかしげる',
    group: 'reaction',
    lead: 0.42,
    hold: 1.7,
    build(t, v) {
      const s = (0.15 + 0.02 * Math.sin(t * 1.2 * v.rate)) * v.side;
      return { spine: { head: [0.02, 0.07 * v.side, s], neck: [0, 0.03 * v.side, s * 0.4] } };
    },
  },

  lean: {
    label: '身を乗り出す',
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
    label: '考える',
    group: 'reaction',
    lead: 0.5,
    hold: 3.0,
    build(t, v) {
      const b = Math.sin(t * 1.4 * v.rate) * 0.05;
      // Knuckle to the chin, the way a hand rests there while thinking.
      return reach(
        v,
        {
          at: 'chin',
          offset: [0.12, 0.78 + b, 0.22],
          hand: [-0.22, 0.86, 0.46],
          palm: [0.55, -0.35, -0.76],
          pole: [0.35, -0.88, 0.32],
          twist: 0.6,
        },
        { thumb: 0.4, index: 0.15, middle: 0.7, ring: 0.85, little: 0.9 },
        { head: [0.05, 0.13 * v.side, 0.07 * v.side], chest: [0, 0.05 * v.side, 0] },
      );
    },
  },

  shrug: {
    label: '肩をすくめる',
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

  // --- greeting -----------------------------------------------------------
  wave: {
    label: '手を振る',
    group: 'greeting',
    lead: 0.3,
    hold: 2.6,
    build(t, v) {
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
      return {
        arms: { R: arm },
        fingers: { R: OPEN_HAND },
        spine: { head: [0, 0, 0.03 * s], chest: [0, 0.02 * s, 0] },
      };
    },
  },

  comeHere: {
    label: 'おいで',
    group: 'greeting',
    lead: 0.4,
    hold: 2.6,
    build(t, v) {
      // Both arms opened forward, palms up. The opening is the gesture — held
      // spread from the first frame it reads as a shrug — so the arms travel
      // outward over the first second and settle.
      const o = Math.min(1, t / 0.9);
      const b = Math.sin(t * 1.6 * v.rate) * 0.03;
      // The palm has to be stated. Aiming the hand forward leaves the roll
      // free, and an invitation with the palms rolled over is a shove.
      return both(
        {
          upperArm: V(0.3 + 0.08 * o, -0.76 + 0.12 * o + b, 0.54 + 0.18 * o),
          lowerArm: V(0.14 + 0.08 * o, 0.24 + b, 0.95),
          hand: V(0.14, 0.2, 0.97),
          palm: V(-0.16, 0.94, -0.3),
        },
        { thumb: 0.18, index: 0.14, middle: 0.16, ring: 0.2, little: 0.26 },
        { head: [-0.03, 0, 0], chest: [0.02, 0, 0] },
      );
    },
  },

  bow: {
    label: 'お辞儀',
    group: 'greeting',
    lead: 0.45,
    hold: 1.2,
    build(t) {
      const k = Math.min(1, t / 0.5);
      return both(
        {
          upperArm: V(0.24, -0.95, 0.18),
          lowerArm: V(0.14, -0.9, 0.4),
          hand: V(0.1, -0.92, 0.38),
        },
        SOFT_HAND,
        { spine: [0.2 * k, 0, 0], chest: [0.16 * k, 0, 0], head: [0.1 * k, 0, 0] },
      );
    },
  },

  // --- explain ------------------------------------------------------------
  explain: {
    label: '説明する',
    group: 'explain',
    lead: 0.35,
    hold: 3.4,
    build(t, v) {
      // The two arms are deliberately out of phase with each other. That offset
      // is structural, not per-playback variation, so it stays a constant.
      const w = t * 2.6 * v.rate;
      const a = Math.sin(w),
        b = Math.sin(w + Math.PI * 0.7);
      const mk = (p: number): ArmPose => ({
        upperArm: V(0.4, -0.78 + p * 0.1, 0.44),
        lowerArm: V(0.3 + p * 0.1, -0.24 + p * 0.2, 0.9),
        hand: V(0.26, -0.1 + p * 0.16, 0.94),
        twist: -0.35,
      });
      return {
        arms: { L: mk(a), R: mk(b) },
        fingers: { L: SOFT_HAND, R: SOFT_HAND },
        spine: { chest: [0, a * 0.045, 0], head: [0, a * 0.05, b * 0.02] },
      };
    },
  },

  present: {
    label: '両手で示す',
    group: 'explain',
    lead: 0.42,
    hold: 2.8,
    build(t, v) {
      const b = Math.sin(t * 1.9 * v.rate) * 0.05;
      return both(
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
    label: '指を立てる',
    group: 'explain',
    lead: 0.28,
    hold: 2.2,
    build(t, v) {
      const b = Math.sin(t * 5.2 * v.rate) * 0.03;
      return one(
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

  // --- emote --------------------------------------------------------------
  peace: {
    label: 'ピース',
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
          twist: 0.15,
        },
        PEACE_HAND,
        { head: [0.01, 0.03, 0.035] },
      );
    },
  },

  clap: {
    label: '拍手',
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
          hand: [0.06, 0.34, 0.94],
          palm: [-1, 0, 0],
        },
        OPEN_HAND,
        { chest: [-0.02, 0, 0], head: [-0.03, 0, 0] },
      );
    },
  },

  cheer: {
    label: '喜ぶ',
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
    label: '口元を隠す',
    group: 'emote',
    lead: 0.42,
    hold: 2.4,
    build(t, v) {
      const b = Math.sin(t * 1.7 * v.rate) * 0.04;
      return reach(
        v,
        {
          at: 'mouth',
          offset: [0.1, 0.18 + b, 0.3],
          hand: [-0.28, 0.82, 0.5],
          palm: [-0.8, 0.1, -0.59],
          pole: [0.3, -0.86, 0.42],
          twist: 0.5,
        },
        SOFT_HAND,
        { head: [0.06, 0.1 * v.side, 0.05 * v.side], chest: [0.02, 0.04 * v.side, 0] },
      );
    },
  },

  deny: {
    label: '手を横に振る',
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
    label: 'ぷんすか',
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

  // --- cute ---------------------------------------------------------------
  headPat: {
    label: '頭に手をやる',
    group: 'cute',
    lead: 0.4,
    hold: 2.4,
    build(t, v) {
      // Stroking back and forth across the crown, not tapping.
      const s = Math.sin(t * 3.2 * v.rate) * 0.22;
      return reach(
        v,
        {
          at: 'crown',
          offset: [0.3 + s, 0.05, 0.1],
          hand: [-0.55, 0.72, 0.42],
          palm: [-0.25, -0.9, -0.35],
          pole: [0.92, -0.28, 0.28],
          twist: 0.5,
        },
        SOFT_HAND,
        { head: [0.06, 0.03 * v.side, 0.03 * v.side] },
      );
    },
  },

  cheekPoke: {
    label: '頬に指',
    group: 'cute',
    lead: 0.45,
    hold: 2.6,
    build(t, v) {
      const b = Math.sin(t * 1.6 * v.rate) * 0.04;
      // Index fingertip on the cheek; the rest of the hand is folded away.
      return reach(
        v,
        {
          at: 'cheek',
          offset: [0.05, 0.1 + b, 0.2],
          hand: [-0.3, 0.8, 0.52],
          palm: [-0.75, 0.05, -0.66],
          pole: [0.38, -0.86, 0.34],
          twist: 0.45,
        },
        { thumb: 0.45, index: 0.04, middle: 0.85, ring: 0.9, little: 0.92 },
        { head: [0.04, 0.1 * v.side, 0.08 * v.side] },
      );
    },
  },

  hairTouch: {
    label: '髪を触る',
    group: 'cute',
    lead: 0.45,
    hold: 2.8,
    build(t, v) {
      // The hand travels down past the ear rather than sitting still: this is
      // the fidget, and the fidget is the whole gesture.
      const d = 0.5 - 0.5 * Math.cos(t * 1.9 * v.rate);
      // Starts at the temple and travels down past the ear.
      return reach(
        v,
        {
          at: 'temple',
          offset: [0.15, 0.9 - d * 0.85, -0.05 - d * 0.15],
          hand: [0.1, 0.9 - d * 0.25, -0.28],
          palm: [-0.92, 0.05, -0.39],
          pole: [0.55, -0.78, 0.3],
          twist: 0.3,
        },
        SOFT_HAND,
        { head: [0.02, -0.04 * v.side, 0.05 * v.side] },
      );
    },
  },

  catPaw: {
    label: '猫の手',
    group: 'cute',
    lead: 0.34,
    hold: 2.4,
    build(t, v) {
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
    label: 'キラキラ',
    group: 'cute',
    lead: 0.3,
    hold: 2.2,
    build(t, v) {
      // Hands open beside the face, fingers fluttering.
      const f = 0.06 + 0.1 * (0.5 - 0.5 * Math.cos(t * 8.4 * v.rate));
      const b = Math.sin(t * 4.2 * v.rate) * 0.03;
      return both(
        {
          upperArm: V(0.54, -0.42 + b, 0.26),
          lowerArm: V(0.3, 0.86, 0.32),
          hand: V(0.24, 0.94, 0.22),
          twist: -0.3,
        },
        { thumb: f, index: f, middle: f * 1.1, ring: f * 1.2, little: f * 1.3 },
        { head: [-0.03, 0, 0] },
      );
    },
  },

  beg: {
    label: 'お願い',
    group: 'cute',
    lead: 0.38,
    hold: 2.6,
    build(t, v) {
      // Palms together at the chest, head tipped up — the upward look is what
      // makes it read as pleading rather than as praying.
      const b = Math.sin(t * 2.8 * v.rate) * 0.02;
      return reachBoth(
        {
          space: 'body',
          at: 'sternum',
          offset: [0.055, 0.1 + b, 0.26],
          hand: [0.02, 0.86, 0.51],
          palm: [-1, 0, 0.05],
        },
        { thumb: 0.15, index: 0.06, middle: 0.06, ring: 0.08, little: 0.1 },
        { head: [-0.07, 0, 0.02], chest: [0.03, 0, 0] },
      );
    },
  },

  whisper: {
    label: '内緒話',
    group: 'cute',
    lead: 0.4,
    hold: 2.6,
    build(t, v) {
      const b = Math.sin(t * 1.5 * v.rate) * 0.03;
      // Beside the mouth, not over it — the hand shields, it does not cover.
      return reach(
        v,
        {
          at: 'mouth',
          offset: [0.62, 0.55 + b, 0.5],
          hand: [0.18, 0.86, 0.48],
          palm: [-0.86, 0.08, -0.5],
          pole: [0.34, -0.86, 0.38],
          twist: 0.7,
        },
        SOFT_HAND,
        { head: [0.02, 0.14 * v.side, 0.04 * v.side], chest: [0.02, 0.06 * v.side, 0] },
      );
    },
  },

  yawn: {
    label: 'あくび',
    group: 'cute',
    lead: 0.5,
    hold: 1.8,
    build(t, v) {
      const k = Math.min(1, t / 0.7);
      const b = Math.sin(t * 1.3 * v.rate) * 0.03;
      return reach(
        v,
        {
          at: 'mouth',
          offset: [0.05, 0.0 + b, 0.35],
          hand: [-0.24, 0.84, 0.48],
          palm: [-0.8, 0.1, -0.59],
          pole: [0.36, -0.88, 0.3],
          twist: 0.4,
        },
        SOFT_HAND,
        { head: [-0.1 * k, 0, 0], chest: [-0.04 * k, 0, 0] },
      );
    },
  },

  stretch: {
    label: '伸び',
    group: 'cute',
    lead: 0.6,
    hold: 2.0,
    build(t, v) {
      // Arms up and the spine arching back. Elbows stay forward of the ears so
      // the hands do not leave the top of the frame.
      const k = Math.min(1, t / 0.8);
      const b = Math.sin(t * 1.1 * v.rate) * 0.02;
      return both(
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

  // --- pose ---------------------------------------------------------------
  // Held until released rather than for a fixed beat. `sustain` is what makes
  // these usable as a standing attitude for a whole segment of a stream.
  armCross: {
    label: '腕組み',
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
    label: '手を組む',
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
          hand: [-0.16, 0.3, 0.92],
          palm: [-0.6, 0.5, -0.6],
        },
        CLASP_HAND,
      );
    },
  },

  chin: {
    label: '頬杖',
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
          offset: [0.2, -0.05, 0.4],
          hand: [-0.34, 0.78, 0.52],
          palm: [-0.62, 0.55, -0.56],
          pole: [0.26, -0.92, 0.3],
          twist: 0.55,
        },
        { thumb: 0.3, index: 0.5, middle: 0.7, ring: 0.8, little: 0.85 },
        {
          head: [0.06, 0.08 * v.side, 0.1 * v.side],
          chest: [0.03, 0.04 * v.side, 0.03 * v.side],
        },
      );
    },
  },

  bothCheeks: {
    label: '両手を頬に',
    group: 'pose',
    sustain: true,
    lead: 0.42,
    hold: 1.0,
    build() {
      return reachBoth(
        {
          at: 'cheek',
          offset: [0.28, 0.62, 0.35],
          hand: [-0.2, 0.84, 0.5],
          palm: [-0.88, 0.1, -0.46],
          pole: [0.48, -0.84, 0.26],
          twist: 0.6,
        },
        OPEN_HAND,
        { head: [0.02, 0, 0] },
      );
    },
  },

  thumbsUp: {
    label: 'サムズアップ',
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
    label: '指ハート',
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
    label: '両手ピース',
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
          twist: 0.15,
        },
        PEACE_HAND,
        { head: [-0.02, 0, 0] },
      );
    },
  },

  gun: {
    label: '指鉄砲',
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

  listen: {
    label: '手を耳に',
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
          offset: [1.1, 0.38, -0.2],
          hand: [0.12, 0.9, -0.3],
          palm: [-0.25, 0.0, 0.97],
          pole: [0.78, -0.58, 0.18],
          twist: 0.4,
        },
        SOFT_HAND,
        { head: [0.02, -0.1 * v.side, -0.05 * v.side], chest: [0, -0.04 * v.side, 0] },
      );
    },
  },
} satisfies Record<string, GestureDef>;

export type GestureId = keyof typeof GESTURES;

/** One group, with the ids that belong to it. */
export interface GestureGroupEntry {
  key: GestureGroup;
  label: string;
  ids: GestureId[];
}

/** Gesture ids grouped, for the UI and for the auto-gesture pool. */
export const GESTURES_BY_GROUP: GestureGroupEntry[] = (
  Object.entries(GESTURE_GROUPS) as Array<[GestureGroup, string]>
).map(([key, label]) => ({
  key,
  label,
  ids: (Object.keys(GESTURES) as GestureId[]).filter((id) => GESTURES[id].group === key),
}));
