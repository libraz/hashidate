import type { Localized } from '../../i18n/locale';
import type { ElevationRow, JointDof, JointTable, StrainZone } from '../types';

/**
 * Anatomy — what a joint can do, independent of any avatar.
 *
 * The rig layer resolves *directions*, which makes a pose portable but leaves
 * it unbounded: geometry will happily fold an elbow the wrong way or snap a
 * wrist sideways if that is what the numbers say. The cone limit that used to
 * live in the rig layer bounded the damage but could not tell flexion from
 * extension, so it allowed 75 degrees of radial deviation at a wrist whose real
 * range is 20.
 *
 * This module states the joint properly. Every degree of freedom carries two
 * bands rather than one bound:
 *
 *   自然 (free)         the range daily movement actually uses. Free of charge.
 *   無理 (strained)     anatomically available, but effortful and held briefly.
 *                       Reachable, at a rising cost.
 *   不可能 (impossible)  beyond the hard stop. Never produced, at any cost.
 *
 * Two bands and not one because a solver needs somewhere to prefer. A single
 * limit gives a pass/fail test and no way to choose between two poses that both
 * pass — which is exactly the choice an arm has to make, since a hand placed in
 * space leaves the elbow a whole circle to sit on. The cost is what picks.
 *
 * **This is engine data, not avatar data.** The numbers describe the body being
 * depicted, so they are the same for every humanoid avatar; contrast the gaze
 * limits in the profile layer, which describe how one particular eye is drawn
 * and belong to that avatar. An avatar that is deliberately not human overrides
 * through `profile.anatomy`, which is where a four-jointed arm or a doll with
 * no elbow would be described.
 *
 * The free band is functional range of motion — what reaching, eating and
 * gesturing use — and the hard stop is clinical range of motion, what a
 * goniometer reads at end-feel. The gap between the two is wide on purpose:
 * shoulder flexion is functionally about 120 degrees and clinically 180, and a
 * character who lifts an arm to 180 whenever the arithmetic allows it looks
 * like it is being posed rather than moving.
 */

export const D = Math.PI / 180;

/**
 * One degree of freedom. Angles in degrees on the way in, radians on the way
 * out — the table is read by people and the runtime is not.
 */
const dof = (
  label: Localized,
  freeLo: number,
  freeHi: number,
  maxLo: number,
  maxHi: number,
): JointDof => ({
  label,
  free: [freeLo * D, freeHi * D],
  max: [maxLo * D, maxHi * D],
});

/**
 * Shoulder elevation ceiling as a function of the plane it is raised in.
 *
 * The shoulder is the one joint that cannot be written as independent axes.
 * How far the arm lifts depends entirely on which way it is lifted: 180 degrees
 * straight out to the side, 60 backwards, and barely 45 across the chest before
 * the arm is inside the ribcage. Treating elevation as one number with one
 * limit is what puts a hand through the torso.
 *
 * Plane is measured about the body's vertical axis, from the arm hanging at the
 * side:
 *
 *     -90  straight back        0  out to the side       90  straight forward
 *     180  across the midline
 *
 * Same table for both arms: the plane is measured toward the character's own
 * outside, so it mirrors by construction.
 */
export const ELEVATION: ElevationRow[] = [
  // plane   free   max     what it is
  [-180, 25, 45], // across the midline, arm behind — nothing lives here
  [-135, 15, 35], // behind and across: the hand-behind-the-back range
  [-90, 35, 60], // straight back: extension
  [-45, 70, 120], // back and out
  [0, 100, 175], // out to the side: abduction
  [45, 105, 178], // forward and out — the widest direction there is
  [90, 110, 175], // straight forward: flexion
  [135, 75, 130], // forward and across the chest
  [180, 25, 45], // across the midline: horizontal adduction
];

/**
 * The joint table.
 *
 * `dofs` are ordinary bounded axes. `elevation` is the plane-dependent ceiling
 * above, and only the shoulder has one.
 */
export const JOINTS: JointTable = {
  shoulder: {
    label: { en: 'Shoulder', ja: '肩' },
    elevation: ELEVATION,
    dofs: {
      // Humeral rotation, measured by where the elbow points. Neutral is the
      // forearm swinging forward; positive is outward. Clinically 70-90 each
      // way, and the upper figure is the one to take: reaching your own face
      // needs most of it, and at 70 every hand-to-face gesture sat pinned.
      rotation: dof({ en: 'Humeral rotation', ja: '上腕の回旋' }, -55, 60, -90, 90),
    },
  },

  elbow: {
    label: { en: 'Elbow', ja: '肘' },
    dofs: {
      // Unsigned: which *way* the elbow bends is the shoulder's rotation, not
      // the elbow's. That split is what catches a backwards-folding elbow —
      // it shows up as a rotation near 180 degrees, which no shoulder has.
      //
      // Free from zero, not from the 30 degrees that functional-range studies
      // report. Those measure what daily tasks *use*, and a straight arm is not
      // in the list because there is nothing to do with one — which is not the
      // same as it being uncomfortable. It is the anatomical neutral, and a
      // pointing arm is often at it. Scored as strained, every extended point
      // came back flagged.
      // 150 rather than 145 at the stop: touching your own chin needs about
      // 145, so a limit set there leaves every hand-to-face gesture resting
      // exactly on it, which is both a pose that cannot quite arrive and a
      // reading that says "at the limit" when the truth is "near it".
      flexion: dof({ en: 'Flexion', ja: '屈曲' }, 0, 130, 0, 150),
      // Pronation/supination happens along the forearm, not at a joint a rig
      // has a bone for; the rig layer splits it between the wrist and the
      // forearm.
      rotation: dof({ en: 'Pronation and supination', ja: '回内・回外' }, -55, 55, -80, 80),
    },
  },

  wrist: {
    label: { en: 'Wrist', ja: '手首' },
    dofs: {
      // Positive toward the palm.
      flexion: dof({ en: 'Flexion and extension', ja: '掌屈・背屈' }, -40, 40, -70, 80),
      // Positive toward the thumb. Deeply asymmetric, and the asymmetry is
      // visible: a hand cocked 20 degrees toward the thumb already looks
      // strained, the same 20 toward the little finger looks like nothing.
      deviation: dof({ en: 'Radial and ulnar deviation', ja: '橈屈・尺屈' }, -20, 10, -30, 20),
    },
  },

  // Fingers. Three segments, and they are not the same joint repeated: the
  // knuckle hyperextends and the middle joint does not, the middle joint has
  // the most flexion of the three and the tip has the least.
  finger: {
    label: { en: 'Finger', ja: '指' },
    dofs: {
      proximal: dof({ en: 'MCP joint', ja: 'MP 関節' }, 0, 90, -30, 100),
      intermediate: dof({ en: 'PIP joint', ja: 'PIP 関節' }, 0, 100, 0, 115),
      distal: dof({ en: 'DIP joint', ja: 'DIP 関節' }, 0, 70, -10, 90),
    },
  },

  thumb: {
    label: { en: 'Thumb', ja: '親指' },
    dofs: {
      proximal: dof({ en: 'CMC joint', ja: 'CM 関節' }, 0, 45, -15, 55),
      intermediate: dof({ en: 'MCP joint', ja: 'MP 関節' }, 0, 50, -10, 60),
      distal: dof({ en: 'IP joint', ja: 'IP 関節' }, 0, 70, -15, 85),
    },
  },

  // Stated for completeness rather than because the gaze code needs it: the
  // framing limits in `profile.gaze` are far tighter than anatomy, because a
  // bust shot runs out of room long before a neck does. Applied as a second
  // ceiling so the anatomical stop exists even if a framing limit is widened.
  neck: {
    label: { en: 'Neck', ja: '首' },
    dofs: {
      pitch: dof({ en: 'Flexion and extension', ja: '前後屈' }, -60, 50, -70, 60),
      yaw: dof({ en: 'Rotation', ja: '回旋' }, -80, 80, -90, 90),
      roll: dof({ en: 'Lateral flexion', ja: '側屈' }, -40, 40, -45, 45),
    },
  },

  spine: {
    label: { en: 'Trunk', ja: '体幹' },
    dofs: {
      pitch: dof({ en: 'Flexion and extension', ja: '前後屈' }, -20, 60, -25, 80),
      yaw: dof({ en: 'Rotation', ja: '回旋' }, -35, 35, -45, 45),
      roll: dof({ en: 'Lateral flexion', ja: '側屈' }, -25, 25, -35, 35),
    },
  },
};

/**
 * What each band is called where a joint reading is shown.
 *
 * The three bands are the ones described at the top of this file: inside the
 * free range, above it and paying for it, and stopped at the hard limit.
 */
export const ZONES: Record<StrainZone, Localized> = {
  natural: { en: 'Natural', ja: '自然' },
  strained: { en: 'Strained', ja: '無理' },
  limit: { en: 'At the limit', ja: '限界' },
};

/**
 * How far down the hand the contact point sits, as a fraction of its length.
 *
 * The length here is wrist to fingertip, so half of it is past the knuckles and
 * into the fingers; the centre of the palm is closer to a third. The difference
 * is two centimetres, which sounds like nothing and is not: the backoff runs
 * from the anchor back toward the wrist, almost directly along the line from
 * the shoulder, so every centimetre of it comes straight out of the arm's
 * reach. On a narrow-shouldered, short-necked avatar the face already sits
 * close enough to the shoulder that the elbow has to fold past its comfortable
 * range to touch it, and half a hand length spent here was enough to push most
 * of the face-touching poses past the joint's hard stop.
 *
 * Two places need the same number and they have to agree: the motion layer
 * backs a reach's wrist off by it so the palm rather than the wrist lands on
 * the anchor, and the rig layer ends the hand's collision proxy there.
 * Disagree, and every touching pose reports itself buried.
 */
export const HAND_CONTACT = 0.35;

/** Points tested per arm segment against the trunk. See `torsoDepth`. */
export const TORSO_SAMPLES = 6;

/**
 * Where along the upper arm the trunk test starts, as a fraction of it.
 *
 * The top of the upper arm is *supposed* to be against the trunk — that is
 * where the arm attaches, and the deltoid sits on the chest wall. On the
 * validation avatar the shoulder joint is 9% clear of the cylinder, so any
 * inward tilt at all puts the first sample inside, and no rotation about the
 * shoulder can lift a point that close to the pivot back out. Testing from the
 * root made the constraint unsatisfiable rather than strict.
 */
export const TORSO_ARM_START = 0.4;

/** What a fully tucked-in elbow costs the search. See `cost`. */
export const INBOARD_COST = 3;

/**
 * Being inside the body: what any contact costs, and what depth adds on top.
 *
 * The step outbids any single joint, so a pose that clears the body beats one
 * that does not however the joints compare. The slope has to be the larger of
 * the two, because the search's real problem is not choosing between touching
 * and not touching — it is choosing among candidates that all touch.
 */
export const BODY_HIT = 6;
export const BODY_DEPTH = 30;

/** How many times the escape may re-aim per segment. See `clearBody`. */
export const TORSO_PASSES = 8;

/**
 * What holding the arm fully overhead costs, against zero for hanging.
 *
 * This is the term that decides between the two solutions most face-height
 * targets have — elbow hanging below the hand, or elbow cocked above it — and
 * it has to decide firmly. At 0.5 the two came out within a few hundredths of
 * each other, near enough that the small vertical bob written into a gesture
 * flipped the arm from one to the other mid-animation: not a pose that looks
 * wrong so much as an arm that snaps.
 *
 * Raising it does not distort gestures that genuinely reach upward. Where the
 * target is overhead there is no low-elbow solution to prefer, so the term is
 * the same for every candidate and cancels.
 */
export const LIFT_COST = 2;

/**
 * Resolution of the trunk's measured surface: height bands × angular sectors.
 *
 * Coarse on purpose. This is a collision proxy for a limb, not a mesh — what it
 * has to get right is that a chest is wider than it is deep and that the front
 * of it is not where a cylinder says. 12 × 16 puts a sample every 22 degrees
 * around and every few centimetres up, which resolves the ribcage, the bust and
 * the waist; finer would resolve folds in the mesh that an elbow cannot feel.
 */
export const TORSO_BANDS = 12;
export const TORSO_SECTORS = 16;
