import type * as THREE from 'three';
import type { Localized } from '../../i18n/locale';
import type { FingerName, Side, SpineSlot, Vec3Tuple } from './primitives';

/**
 * What one frame of movement asks for, and how the gesture table states it.
 *
 * Everything here is authored in character space so that one entry serves both
 * arms on any rig — see `Vec3Tuple`.
 */

/** Per-finger curl, 0 straight to 1 the joint's natural full flexion. */
export type FingerSpec = Partial<Record<FingerName, number>>;

/**
 * Directions for one arm, in character space. Omitted links keep their rest pose.
 *
 * `palm` and `twist` ride along with the links rather than sitting beside them
 * because a solved reach produces all six together and the blend path must not
 * be able to tell an authored arm from a solved one — that is what lets a point
 * crossfade with a wave. `thumbsUp` in particular depends on it: its palm has
 * to travel this path, because a `twist` stated anywhere else is ignored.
 */
export interface ArmDirections {
  shoulder?: THREE.Vector3;
  upperArm?: THREE.Vector3;
  lowerArm?: THREE.Vector3;
  hand?: THREE.Vector3;
  /** Which way the palm faces. Aiming the hand leaves this roll undetermined. */
  palm?: THREE.Vector3;
  /** Axial roll about the hand's own axis, radians. */
  twist?: number;
}

/** Which anchor a reach lands on. Face anchors are in IPD, body anchors in spans. */
export type AnchorSpace = 'face' | 'body';

/**
 * A pose that has to make *contact*, given as a place rather than as directions.
 *
 * A direction fixes where the elbow points and leaves where the hand ends up to
 * the avatar's arm length, which is why anything touching the face is authored
 * this way instead.
 */
export interface ReachSpec {
  /** Anchor name — see `FACE_ANCHORS` / `BODY_ANCHORS` in `profile/frames.ts`. */
  at: string;
  space?: AnchorSpace;
  /** Nudge from the anchor, in the anchor's own units. */
  offset?: Vec3Tuple;
  /** Wrist-to-fingertip direction, character space. */
  hand?: Vec3Tuple;
  /** Which way the palm faces, character space. */
  palm?: Vec3Tuple;
  /** Where the elbow is drawn toward, from the shoulder, in body spans. */
  pole?: Vec3Tuple;
  /** Raw elbow angle about the reach line. `pole` is preferred; see `rig/reach.ts`. */
  elbow?: number;
  twist?: number;
}

/**
 * A fingertip target, given as a bearing from the shoulder in the body's own
 * frame. Survives the character turning, leaning or being a different size in a
 * way a world position does not.
 */
export interface PointSpec {
  /** Radians. 0 straight ahead, positive toward the character's right. */
  azimuth?: number;
  /** Radians. 0 at shoulder height, positive up. */
  elevation?: number;
  /** 0..1 of the arm's full reach, fingertip included. */
  extent?: number;
  finger?: FingerName;
  /** False for absolute bearing/point/palm directions; otherwise they mirror per side. */
  mirror?: boolean;
  /**
   * Authored form: a tuple in character space.
   *
   * The motion layer rewrites these into shared scratch vectors on the way to
   * the solver rather than allocating per frame, so what the *rig* accepts is
   * wider — see `PointRequest` in `rig/`. Keeping the two apart means a gesture
   * table cannot accidentally be written against runtime scratch, which is
   * shared and would alias.
   */
  point?: Vec3Tuple | null;
  palm?: Vec3Tuple | null;
  twist?: number;
}

/** Additive spine offsets for a frame, in radians, per slot. */
export type SpineOffsets = Partial<Record<SpineSlot, Vec3Tuple>>;

/** What one frame of a gesture asks for. Every field is optional. */
export interface Pose {
  arms?: Partial<Record<Side, ArmDirections>>;
  fingers?: Partial<Record<Side, FingerSpec>>;
  /** Internal procedural layer only: per-finger splay in radians. */
  fingerSpread?: Partial<Record<Side, FingerSpec>>;
  reach?: Partial<Record<Side, ReachSpec>>;
  point?: Partial<Record<Side, PointSpec>>;
  spine?: SpineOffsets;
}

/**
 * Per-playback variation. Frequency and amplitude only, never phase: `build` is
 * called from t=0 and a phase offset would put every oscillation mid-swing on
 * the first frame, snapping the limb into the gesture.
 */
export interface GestureVariation {
  rate: number;
  scale: number;
  /**
   * ±1. Which hand a one-handed gesture uses, and which way the head turns on
   * a two-handed one. Drawn at random per playback unless the caller pinned it.
   */
  side: number;
}

export type GestureGroup = 'reaction' | 'greeting' | 'explain' | 'emote' | 'cute' | 'pose';

/**
 * How the performance table is filed. It mirrors the gesture groups, plus
 * `mood` for the entries that are a face and nothing else — which the gesture
 * table has no way to express and which are most of what an idle character does.
 */
export type PerformanceGroup =
  | 'mood'
  | 'reaction'
  | 'greeting'
  | 'explain'
  | 'emote'
  | 'cute'
  | 'pose';

export interface GestureDef {
  label: Localized;
  group: GestureGroup;
  /** Seconds of entrance. A floor — the real lead scales with how far the arms travel. */
  lead: number;
  /** Seconds held at full weight before the exit begins. */
  hold: number;
  /** A pose that holds until released rather than running out on its own. */
  sustain?: boolean;
  build(t: number, v: GestureVariation): Pose;
}
