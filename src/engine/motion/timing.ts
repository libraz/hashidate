import type { ArmSlot } from '../types';

/**
 * The time course of a deliberate movement.
 *
 * Separate from `idle.ts`, which holds the curves an *involuntary* motion is
 * built from — breath, sway, drift. Those are shapes with no start and no end.
 * What is here has both: a gesture is a movement from one pose to another, and
 * how the weight travels between them is most of what says whether a person or
 * a machine made it happen.
 *
 * Pure functions of a normalised phase. No state, no rig, nothing from three.
 */

/**
 * Minimum-jerk profile — the standard model of a human reach.
 *
 * A movement that starts at rest, ends at rest and minimises the integral of
 * squared jerk over the interval is this quintic, and nothing else. The
 * consequence that matters here is the *velocity* it implies: zero at both ends
 * and a single symmetric peak in the middle. That is what people's hands
 * actually do, and it is what tells a viewer that something was moved rather
 * than driven.
 *
 * The curve this replaced was `smoothstep` — also zero-velocity at both ends,
 * but with a step in *acceleration* at each. The eye does not see acceleration
 * directly and does see the corner it produces, which is why a smoothstepped
 * limb still reads as mechanical while being visibly eased.
 *
 * Clamped rather than extrapolated: every caller feeds it a phase that has been
 * offset or rescaled and would otherwise run outside the interval, where a
 * quintic goes to large numbers very quickly.
 */
export const minJerk = (x: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * x * (10 + x * (-15 + 6 * x));
};

/**
 * Where the primary submovement ends and the correction begins, and how far
 * past the target the primary one goes.
 *
 * A reach is not one movement. People launch a fast ballistic phase that lands
 * near the target, then make a smaller corrective one that lands on it, and the
 * velocity trace of a real reach has two humps because of it. Landing exactly
 * on the mark in one smooth arrival is the thing an animation system does and a
 * body does not.
 *
 * The overshoot is deliberately small. At 0.05 the hand passes about a
 * centimetre beyond a pose on these avatars and settles back over the last
 * quarter of the entrance, which reads as a limb having mass. Past roughly 0.12
 * it stops reading as mass and starts reading as a bounce, which is a cartoon
 * convention and a different thing entirely.
 */
const SUBMOVEMENT_SPLIT = 0.72;
const OVERSHOOT = 0.05;

/**
 * The entrance profile for a limb: minimum-jerk to just past the pose, then
 * minimum-jerk back onto it.
 *
 * Both halves are minimum-jerk, so both meet the join with zero velocity *and*
 * zero acceleration and the seam cannot be seen. Joining anything else there —
 * a cosine, a smoothstep — puts a corner exactly where the eye is already
 * watching for the arrival.
 */
export const reachEnvelope = (x: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const peak = 1 + OVERSHOOT;
  return x < SUBMOVEMENT_SPLIT
    ? peak * minJerk(x / SUBMOVEMENT_SPLIT)
    : peak + (1 - peak) * minJerk((x - SUBMOVEMENT_SPLIT) / (1 - SUBMOVEMENT_SPLIT));
};

/**
 * Fraction of the entrance each link waits before it starts.
 *
 * Movement propagates outward along a limb: the shoulder goes first, the hand
 * arrives last, and the lag between them is what makes an arm read as a chain
 * of segments rather than as one rigid piece swung from the top. Starting every
 * link on the same frame is the single clearest tell of a mannequin, and it is
 * what the layer did before this existed.
 *
 * Stated as a fraction rather than in seconds so it scales with the entrance:
 * a quick adjustment and a long reach both keep the same proportion of overlap,
 * which is what the underlying sequencing actually holds constant. In seconds a
 * fixed offset is imperceptible on a slow reach and is the whole movement on a
 * fast one.
 *
 * Every link still *finishes* together — see `onset`. The distal ones therefore
 * travel over a shorter window and move faster, which is also what happens.
 */
export const LINK_ONSET: Record<ArmSlot, number> = {
  shoulder: 0,
  upperArm: 0.05,
  lowerArm: 0.12,
  hand: 0.2,
};

/**
 * Fingers trail the hand that carries them. Slightly further out than the hand
 * itself, because a hand changing shape while it travels reads as one motion
 * and a hand that arrives already shaped reads as two.
 */
export const FINGER_ONSET = 0.26;

/**
 * Re-base a normalised phase onto a link that starts late and finishes with the
 * rest of the limb.
 *
 * Returns a value below zero before the link starts, which every envelope here
 * clamps away. Callers do not need to guard it.
 */
export const onset = (x: number, delay: number): number =>
  delay <= 0 ? x : (x - delay) / (1 - delay);
