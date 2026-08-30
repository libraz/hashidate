import type * as THREE from 'three';
import type {
  ArmDirections,
  FingerSpec,
  GestureVariation,
  Pose,
  ReachSpec,
  Side,
  SpineOffsets,
} from '../../types';

/**
 * The four shapes a gesture's `build` returns, and the side choice behind them.
 *
 * Every entry in the table goes through one of these rather than writing a
 * `Pose` out by hand, so that which hand acts is decided in one place and a
 * two-handed pose cannot accidentally state two different hands.
 */

/**
 * One arm as this table authors it: the four link directions, plus the palm
 * roll and the hand twist that some poses also state.
 */
export interface ArmPose extends ArmDirections {
  palm?: THREE.Vector3;
  twist?: number;
}

/** Pick the acting hand. Single-handed gestures that read fine either way. */
const H = (v: GestureVariation): Side => (v.side > 0 ? 'R' : 'L');

/** One-handed result helper: keeps the side choice in one place. */
export const one = (
  v: GestureVariation,
  arm: ArmPose,
  fingers: FingerSpec,
  spine?: SpineOffsets,
  fingerSpread?: FingerSpec,
): Pose => ({
  arms: { [H(v)]: arm },
  fingers: { [H(v)]: fingers },
  ...(spine ? { spine } : {}),
  ...(fingerSpread ? { fingerSpread: { [H(v)]: fingerSpread } } : {}),
});

/** Two-handed result helper. */
export const both = (
  arm: ArmPose,
  fingers: FingerSpec,
  spine?: SpineOffsets,
  fingerSpread?: FingerSpec,
): Pose => ({
  arms: { L: arm, R: arm },
  fingers: { L: fingers, R: fingers },
  ...(spine ? { spine } : {}),
  ...(fingerSpread ? { fingerSpread: { L: fingerSpread, R: fingerSpread } } : {}),
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
 */
export const reach = (
  v: GestureVariation,
  spec: ReachSpec,
  fingers: FingerSpec,
  spine?: SpineOffsets,
): Pose => ({
  reach: { [H(v)]: spec },
  fingers: { [H(v)]: fingers },
  ...(spine ? { spine } : {}),
});

export const reachBoth = (spec: ReachSpec, fingers: FingerSpec, spine?: SpineOffsets): Pose => ({
  reach: { L: spec, R: spec },
  fingers: { L: fingers, R: fingers },
  ...(spine ? { spine } : {}),
});
