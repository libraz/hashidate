import type * as THREE from 'three';
import type {
  ArmDirections,
  FingerSpec,
  GestureVariation,
  HandShape,
  Pose,
  ReachSpec,
  Side,
  SpineOffsets,
} from '../../types';

/**
 * The shapes a gesture's `build` returns, and the side choice behind them.
 *
 * Every entry in the table goes through one of these rather than writing a
 * `Pose` out by hand, so that which hand acts is decided in one place and a
 * two-handed pose cannot accidentally state two different hands.
 *
 * Each takes the caller's `out` first and fills it in place, so a playback
 * rebuilt every frame allocates no pose; `undefined` builds a new one. A reused
 * pose ends up with exactly the fields and sides a new one would have.
 */

/**
 * One arm as this table authors it: the four link directions, plus the palm
 * roll and the hand twist that some poses also state.
 */
export interface ArmPose extends ArmDirections {
  palm?: THREE.Vector3;
  twist?: number;
}

type Sided<T> = Partial<Record<Side, T>>;

/** Pick the acting hand. Single-handed gestures that read fine either way. */
const H = (v: GestureVariation): Side => (v.side > 0 ? 'R' : 'L');

/** A record holding exactly the sides given, reusing `prev` when it already has those keys. */
function sided<T>(
  prev: Sided<T> | undefined,
  left: T | undefined,
  right: T | undefined,
): Sided<T> | undefined {
  if (left === undefined && right === undefined) return undefined;
  const reuse =
    prev && 'L' in prev === (left !== undefined) && 'R' in prev === (right !== undefined);
  const record: Sided<T> = reuse ? prev : {};
  if (left !== undefined) record.L = left;
  if (right !== undefined) record.R = right;
  return record;
}

/** `value` on the acting hand only. */
const acting = <T>(prev: Sided<T> | undefined, v: GestureVariation, value: T | undefined) =>
  H(v) === 'L' ? sided(prev, value, undefined) : sided(prev, undefined, value);

/** Set a field, or remove it, so a reused pose carries nothing from an earlier shape. */
function put<K extends keyof Pose>(pose: Pose, key: K, value: Pose[K]): void {
  if (value !== undefined) pose[key] = value;
  else if (key in pose) delete pose[key];
}

/** A shape's splay, or `undefined` for a shape that has none. */
const splay = (hand: HandShape): FingerSpec | undefined =>
  Object.keys(hand.spread).length > 0 ? hand.spread : undefined;

/** Write every field of a pose into `out`, or into a new one. */
function fill(
  out: Pose | undefined,
  arms: Pose['arms'],
  reachSpec: Pose['reach'],
  fingers: Pose['fingers'],
  spine: Pose['spine'],
  fingerSpread: Pose['fingerSpread'],
  claspSpec: Pose['clasp'],
): Pose {
  const pose = out ?? {};
  put(pose, 'arms', arms);
  put(pose, 'reach', reachSpec);
  put(pose, 'point', undefined);
  put(pose, 'fingers', fingers);
  put(pose, 'spine', spine);
  put(pose, 'fingerSpread', fingerSpread);
  put(pose, 'clasp', claspSpec);
  return pose;
}

/** One-handed result helper: keeps the side choice in one place. */
export const one = (
  out: Pose | undefined,
  v: GestureVariation,
  arm: ArmPose,
  hand: HandShape,
  spine?: SpineOffsets,
): Pose =>
  fill(
    out,
    acting(out?.arms, v, arm),
    undefined,
    acting(out?.fingers, v, hand.curl),
    spine,
    acting(out?.fingerSpread, v, splay(hand)),
    undefined,
  );

/** Two-handed result helper. */
export const both = (
  out: Pose | undefined,
  arm: ArmPose,
  hand: HandShape,
  spine?: SpineOffsets,
): Pose =>
  fill(
    out,
    sided(out?.arms, arm, arm),
    undefined,
    sided(out?.fingers, hand.curl, hand.curl),
    spine,
    sided(out?.fingerSpread, splay(hand), splay(hand)),
    undefined,
  );

/** Two-handed result helper for a pose whose hands do different things. */
export const pair = (
  out: Pose | undefined,
  left: ArmPose,
  right: ArmPose,
  leftHand: HandShape,
  rightHand: HandShape,
  spine?: SpineOffsets,
): Pose =>
  fill(
    out,
    sided(out?.arms, left, right),
    undefined,
    sided(out?.fingers, leftHand.curl, rightHand.curl),
    spine,
    sided(out?.fingerSpread, splay(leftHand), splay(rightHand)),
    undefined,
  );

/** A pose that moves only the trunk and head, leaving both arms at rest. */
export const torso = (out: Pose | undefined, spine: SpineOffsets): Pose =>
  fill(out, undefined, undefined, undefined, spine, undefined, undefined);

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
 * The pole is where the elbow goes unless the body is in the way. A hand
 * brought inside the shoulder line pulls the nearest point on its elbow circle
 * into the chest, and a pole honoured exactly put it there; the elbow search
 * holds the elbow at the pole and moves it only out of the trunk.
 *
 * Leaving it out is allowed and means "search the circle for the least strained
 * elbow". That is a poor default for anything near the face: the cost surface
 * has two near-level minima for most face-height targets, so the arm picks a
 * different one as the pose breathes and snaps between them.
 *
 * **The pole belongs behind the wrist, not in front of it.** Every hand-to-face
 * pose here once put the elbow forward of the shoulder, and on a figure whose
 * face sits close to its own shoulder that forces the forearm to run up and
 * *backward* to arrive. The hand is then asked to point up and forward, and the
 * whole of that break has to be taken by the wrist — as sideways deviation,
 * which is the axis a wrist has least of. Measured on the validation avatar,
 * eleven of the thirteen reaching poses settled with the wrist 30 to 130
 * degrees past a stop of 20, and the one that did not was the one pose whose
 * palm was rolled far enough for the break to land as flexion instead.
 *
 * So: keep the elbow at or behind the shoulder in z, let the forearm rise in
 * front of the body, and give the palm enough of an upward component that what
 * bend is left is flexion. A wrist has three times more flexion than deviation
 * and it is the axis that reads as relaxed rather than as broken.
 *
 * **Nothing here reaches above the ear, and nothing here reaches across the
 * midline to the far cheek.** Both are ordinary gestures on a person and
 * neither is authorable on this figure: the head is large and set on a short
 * neck, so a hand on the crown or the temple sits further from the shoulder
 * than the arm is long and arrives with the elbow closed past its own stop,
 * while a hand crossing to the opposite cheek runs the forearm out of pronation
 * and the wrist takes the remainder sideways. There is no pole that fixes
 * either — what binds is the reach and the roll, not the elbow's bearing — so a
 * gesture wanting one of those shapes has to be re-aimed at somewhere the hand
 * can actually get to, the way `cheekPoke` comes up under the near cheekbone.
 * A fingertip is the one exception: `think` puts only the index pad on the
 * forehead, and the wrist under it stays at cheek height.
 */
export const reach = (
  out: Pose | undefined,
  v: GestureVariation,
  spec: ReachSpec,
  hand: HandShape,
  spine?: SpineOffsets,
): Pose =>
  fill(
    out,
    undefined,
    acting(out?.reach, v, spec),
    acting(out?.fingers, v, hand.curl),
    spine,
    acting(out?.fingerSpread, v, splay(hand)),
    undefined,
  );

export const reachBoth = (
  out: Pose | undefined,
  spec: ReachSpec,
  hand: HandShape,
  spine?: SpineOffsets,
): Pose =>
  fill(
    out,
    undefined,
    sided(out?.reach, spec, spec),
    sided(out?.fingers, hand.curl, hand.curl),
    spine,
    sided(out?.fingerSpread, splay(hand), splay(hand)),
    undefined,
  );

/** Two-handed reach for a pose whose hands go to different places. */
export const reachPair = (
  out: Pose | undefined,
  left: ReachSpec,
  right: ReachSpec,
  leftHand: HandShape,
  rightHand: HandShape,
  spine?: SpineOffsets,
): Pose =>
  fill(
    out,
    undefined,
    sided(out?.reach, left, right),
    sided(out?.fingers, leftHand.curl, rightHand.curl),
    spine,
    sided(out?.fingerSpread, splay(leftHand), splay(rightHand)),
    undefined,
  );

/** A mirrored two-hand reach whose other hand interlaces with the `H(v)` hand's. */
export const clasp = (
  out: Pose | undefined,
  v: GestureVariation,
  spec: ReachSpec,
  hand: HandShape,
  dihedral: number,
  spine?: SpineOffsets,
): Pose => {
  const held = out?.clasp ?? { lead: H(v), dihedral };
  held.lead = H(v);
  held.dihedral = dihedral;
  return fill(
    out,
    undefined,
    sided(out?.reach, spec, spec),
    sided(out?.fingers, hand.curl, hand.curl),
    spine,
    sided(out?.fingerSpread, splay(hand), splay(hand)),
    held,
  );
};
