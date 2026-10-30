//! `anatomy/joints.ts`: what a joint can do, independent of any avatar.
//!
//! The rig layer resolves *directions*, which makes a pose portable but leaves
//! it unbounded: geometry will happily fold an elbow the wrong way or snap a
//! wrist sideways if that is what the numbers say. The cone limit that used to
//! live in the rig layer bounded the damage but could not tell flexion from
//! extension, so it allowed 75 degrees of radial deviation at a wrist whose real
//! range is 20.
//!
//! This module states the joint properly. Every degree of freedom carries two
//! bands rather than one bound:
//!
//! ```text
//!   自然 (free)         the range daily movement actually uses. Free of charge.
//!   無理 (strained)     anatomically available, but effortful and held briefly.
//!                       Reachable, at a rising cost.
//!   不可能 (impossible)  beyond the hard stop. Never produced, at any cost.
//! ```
//!
//! Two bands and not one because a solver needs somewhere to prefer. A single
//! limit gives a pass/fail test and no way to choose between two poses that both
//! pass — which is exactly the choice an arm has to make, since a hand placed in
//! space leaves the elbow a whole circle to sit on. The cost is what picks.
//!
//! **This is engine data, not avatar data.** The numbers describe the body being
//! depicted, so they are the same for every humanoid avatar; contrast the gaze
//! limits in the profile layer, which describe how one particular eye is drawn
//! and belong to that avatar. An avatar that is deliberately not human overrides
//! through `profile.anatomy`, which is where a four-jointed arm or a doll with
//! no elbow would be described.
//!
//! The free band is functional range of motion — what reaching, eating and
//! gesturing use — and the hard stop is clinical range of motion, what a
//! goniometer reads at end-feel. The gap between the two is wide on purpose:
//! shoulder flexion is functionally about 120 degrees and clinically 180, and a
//! character who lifts an arm to 180 whenever the arithmetic allows it looks
//! like it is being posed rather than moving.
//!
//! Only the numbers move here. The labels (`JOINTS`' labels, `ZONES`) stay in TS, which looks
//! them up by the position of each field.

use core::f64::consts::PI;

pub const D: f64 = PI / 180.0;

/// One degree of freedom, in radians: `free` is the range daily movement uses, `max` the hard
/// stop. See `types/anatomy.ts` `JointDof`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct JointDof {
    pub free: [f64; 2],
    pub max: [f64; 2],
}

/// Shoulder elevation ceiling samples: `[planeDegrees, freeDegrees, maxDegrees]`.
pub type ElevationRow = [f64; 3];

// joints.ts dof
//
// One degree of freedom. Angles in degrees on the way in, radians on the way
// out — the table is read by people and the runtime is not.
pub const fn dof(free_lo: f64, free_hi: f64, max_lo: f64, max_hi: f64) -> JointDof {
    JointDof {
        free: [free_lo * D, free_hi * D],
        max: [max_lo * D, max_hi * D],
    }
}

/// Shoulder elevation ceiling as a function of the plane it is raised in.
///
/// The shoulder is the one joint that cannot be written as independent axes.
/// How far the arm lifts depends entirely on which way it is lifted: 180 degrees
/// straight out to the side, 60 backwards, and barely 45 across the chest before
/// the arm is inside the ribcage. Treating elevation as one number with one
/// limit is what puts a hand through the torso.
///
/// Plane is measured about the body's vertical axis, from the arm hanging at the
/// side:
///
/// ```text
///     -90  straight back        0  out to the side       90  straight forward
///     180  across the midline
/// ```
///
/// Same table for both arms: the plane is measured toward the character's own
/// outside, so it mirrors by construction.
pub const ELEVATION: [ElevationRow; 9] = [
    // plane   free   max     what it is
    [-180.0, 25.0, 45.0], // across the midline, arm behind — nothing lives here
    [-135.0, 15.0, 35.0], // behind and across: the hand-behind-the-back range
    [-90.0, 35.0, 60.0],  // straight back: extension
    [-45.0, 70.0, 120.0], // back and out
    [0.0, 100.0, 175.0],  // out to the side: abduction
    [45.0, 105.0, 178.0], // forward and out — the widest direction there is
    [90.0, 110.0, 175.0], // straight forward: flexion
    [135.0, 75.0, 130.0], // forward and across the chest
    [180.0, 25.0, 45.0],  // across the midline: horizontal adduction
];

/// The shoulder: the plane-dependent elevation ceiling and humeral rotation.
#[derive(Clone, Debug, PartialEq)]
pub struct Shoulder {
    pub elevation: Vec<ElevationRow>,
    pub rotation: JointDof,
}

/// The elbow's flexion and the forearm's pronation and supination.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Elbow {
    pub flexion: JointDof,
    pub rotation: JointDof,
}

/// The wrist's flexion and deviation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Wrist {
    pub flexion: JointDof,
    pub deviation: JointDof,
}

/// A finger's or the thumb's three segments. A table may leave any of them out.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Digit {
    pub proximal: Option<JointDof>,
    pub intermediate: Option<JointDof>,
    pub distal: Option<JointDof>,
}

/// Pitch, yaw and roll, for the neck and the trunk.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Turns {
    pub pitch: JointDof,
    pub yaw: JointDof,
    pub roll: JointDof,
}

/// The joint table's numbers. `types/anatomy.ts` `JointTable`, without the labels.
#[derive(Clone, Debug, PartialEq)]
pub struct JointTable {
    pub shoulder: Shoulder,
    pub elbow: Elbow,
    pub wrist: Wrist,
    pub finger: Digit,
    pub thumb: Digit,
    pub neck: Turns,
    pub spine: Turns,
}

impl JointTable {
    // joints.ts JOINTS
    //
    // The joint table.
    //
    // `dofs` are ordinary bounded axes. `elevation` is the plane-dependent ceiling
    // above, and only the shoulder has one.
    pub fn human() -> JointTable {
        JointTable {
            shoulder: Shoulder {
                elevation: ELEVATION.to_vec(),
                // Humeral rotation, measured by where the elbow points. Neutral is the
                // forearm swinging forward; positive is outward. Clinically 70-90 each
                // way, and the upper figure is the one to take: reaching your own face
                // needs most of it, and at 70 every hand-to-face gesture sat pinned.
                rotation: dof(-55.0, 60.0, -90.0, 90.0),
            },

            elbow: Elbow {
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
                flexion: dof(0.0, 130.0, 0.0, 150.0),
                // Pronation/supination happens along the forearm, not at a joint a rig
                // has a bone for; the rig layer splits it between the wrist and the
                // forearm.
                rotation: dof(-55.0, 55.0, -80.0, 80.0),
            },

            wrist: Wrist {
                // Positive toward the palm.
                flexion: dof(-40.0, 40.0, -70.0, 80.0),
                // Positive toward the thumb. Deeply asymmetric, and the asymmetry is
                // visible: a hand cocked 20 degrees toward the thumb already looks
                // strained, the same 20 toward the little finger looks like nothing.
                deviation: dof(-20.0, 10.0, -30.0, 20.0),
            },

            // Fingers. Three segments, and they are not the same joint repeated: the
            // knuckle hyperextends and the middle joint does not, the middle joint has
            // the most flexion of the three and the tip has the least.
            finger: Digit {
                proximal: Some(dof(0.0, 90.0, -30.0, 100.0)),
                intermediate: Some(dof(0.0, 100.0, 0.0, 115.0)),
                distal: Some(dof(0.0, 70.0, -10.0, 90.0)),
            },

            thumb: Digit {
                proximal: Some(dof(0.0, 45.0, -15.0, 55.0)),
                intermediate: Some(dof(0.0, 50.0, -10.0, 60.0)),
                distal: Some(dof(0.0, 70.0, -15.0, 85.0)),
            },

            // Stated for completeness rather than because the gaze code needs it: the
            // framing limits in `profile.gaze` are far tighter than anatomy, because a
            // bust shot runs out of room long before a neck does. Neither this entry nor
            // `spine` is applied: gaze is bounded by its framing limits alone, and the
            // summed spine offsets by the per-slot `SPINE_LIMITS` (`rig/spine.ts`).
            neck: Turns {
                pitch: dof(-60.0, 50.0, -70.0, 60.0),
                yaw: dof(-80.0, 80.0, -90.0, 90.0),
                roll: dof(-40.0, 40.0, -45.0, 45.0),
            },

            spine: Turns {
                pitch: dof(-20.0, 60.0, -25.0, 80.0),
                yaw: dof(-35.0, 35.0, -45.0, 45.0),
                roll: dof(-25.0, 25.0, -35.0, 35.0),
            },
        }
    }
}

/// How far down the hand the contact point sits, as a fraction of its length.
///
/// The length here is wrist to fingertip, so half of it is past the knuckles and
/// into the fingers; the centre of the palm is closer to a third. The difference
/// is two centimetres, which sounds like nothing and is not: the backoff runs
/// from the anchor back toward the wrist, almost directly along the line from
/// the shoulder, so every centimetre of it comes straight out of the arm's
/// reach. On a narrow-shouldered, short-necked avatar the face already sits
/// close enough to the shoulder that the elbow has to fold past its comfortable
/// range to touch it, and half a hand length spent here was enough to push most
/// of the face-touching poses past the joint's hard stop.
///
/// Two places need the same number and they have to agree: the motion layer
/// backs a reach's wrist off by it so the palm rather than the wrist lands on
/// the anchor, and the rig layer ends the hand's collision proxy there.
/// Disagree, and every touching pose reports itself buried.
pub const HAND_CONTACT: f64 = 0.35;

/// Finger thickness as a fraction of knuckle pitch. Only a clearance measure; bones carry no width.
pub const FINGER_WIDTH: f64 = 0.75;

/// Separation of the two knuckle rows in a clasp, in pitches: about a palm's thickness, so fingers cross at the web fold.
pub const INTERLACE_GAP: f64 = 1.5;

/// Total fan of a hand's four fingers when interlaced, about the MCP abduction a relaxed hand reaches.
pub const SPLAY_CAP: f64 = 25.0 * D;

/// Tilt of the thumb's flexion axis from the palm normal toward the finger fold. About the bare
/// normal the wrapped thumb sank into the curled fingers on both validation rigs; tilted 20 degrees
/// it rests on their middle phalanges.
pub const THUMB_FLEXION_TILT: f64 = 20.0 * D;

/// Opposition: how far the thumb's distal hinge turns about the phalanx as the thumb closes, so its
/// flexion folds the tip onto the fingers instead of sweeping on past them. Turned on the
/// metacarpal or proximal bone instead, the whole thumb sank a finger's radius into the fist.
pub const THUMB_OPPOSITION: f64 = -80.0 * D;
/// Thumb curl where the turn starts and where it is complete; a chop thumb stays below it.
pub const THUMB_OPPOSITION_CURL: [f64; 2] = [0.4, 0.65];

/// Points tested per arm segment against the trunk. See `torsoDepth`.
pub const TORSO_SAMPLES: usize = 6;

/// Where along the upper arm the trunk test starts, as a fraction of it.
///
/// The top of the upper arm is *supposed* to be against the trunk — that is
/// where the arm attaches, and the deltoid sits on the chest wall. On the
/// validation avatar the shoulder joint is 9% clear of the cylinder, so any
/// inward tilt at all puts the first sample inside, and no rotation about the
/// shoulder can lift a point that close to the pivot back out. Testing from the
/// root made the constraint unsatisfiable rather than strict.
pub const TORSO_ARM_START: f64 = 0.4;

/// What a fully tucked-in elbow costs the search. See `cost`.
pub const INBOARD_COST: f64 = 3.0;

/// Being inside the body: what any contact costs, and what depth adds on top.
///
/// The step outbids any single joint, so a pose that clears the body beats one
/// that does not however the joints compare. The slope has to be the larger of
/// the two, because the search's real problem is not choosing between touching
/// and not touching — it is choosing among candidates that all touch.
pub const BODY_HIT: f64 = 6.0;
pub const BODY_DEPTH: f64 = 30.0;

/// How many times the escape may re-aim per segment. See `clearBody`.
pub const TORSO_PASSES: usize = 8;

/// What holding the arm fully overhead costs, against zero for hanging.
///
/// This is the term that decides between the two solutions most face-height
/// targets have — elbow hanging below the hand, or elbow cocked above it — and
/// it has to decide firmly. At 0.5 the two came out within a few hundredths of
/// each other, near enough that the small vertical bob written into a gesture
/// flipped the arm from one to the other mid-animation: not a pose that looks
/// wrong so much as an arm that snaps.
///
/// Raising it does not distort gestures that genuinely reach upward. Where the
/// target is overhead there is no low-elbow solution to prefer, so the term is
/// the same for every candidate and cancels.
pub const LIFT_COST: f64 = 2.0;

/// Resolution of the trunk's measured surface: height bands × angular sectors.
///
/// Coarse on purpose. This is a collision proxy for a limb, not a mesh — what it
/// has to get right is that a chest is wider than it is deep and that the front
/// of it is not where a cylinder says. 12 × 16 puts a sample every 22 degrees
/// around and every few centimetres up, which resolves the ribcage, the bust and
/// the waist; finer would resolve folds in the mesh that an elbow cannot feel.
pub const TORSO_BANDS: usize = 12;
pub const TORSO_SECTORS: usize = 16;

#[cfg(test)]
mod tests {
    use super::*;

    const fn deg(radians: f64) -> f64 {
        radians / D
    }

    fn close(a: f64, b: f64, digits: i32) {
        // vitest's toBeCloseTo: |a - b| < 10^-digits / 2
        let tolerance = 10f64.powi(-digits) / 2.0;
        assert!((a - b).abs() < tolerance, "{a} is not close to {b}");
    }

    /// Every degree of freedom in the table, flattened for row-by-row checks.
    fn all_dofs(t: &JointTable) -> Vec<(&'static str, JointDof)> {
        let digit = |name, d: &Digit| {
            [d.proximal, d.intermediate, d.distal]
                .into_iter()
                .flatten()
                .map(move |dof| (name, dof))
                .collect::<Vec<_>>()
        };
        let mut out = vec![
            ("shoulder.rotation", t.shoulder.rotation),
            ("elbow.flexion", t.elbow.flexion),
            ("elbow.rotation", t.elbow.rotation),
            ("wrist.flexion", t.wrist.flexion),
            ("wrist.deviation", t.wrist.deviation),
        ];
        out.extend(digit("finger", &t.finger));
        out.extend(digit("thumb", &t.thumb));
        for (name, turns) in [("neck", &t.neck), ("spine", &t.spine)] {
            out.extend([(name, turns.pitch), (name, turns.yaw), (name, turns.roll)]);
        }
        out
    }

    #[test]
    fn every_dof_keeps_its_free_band_inside_its_hard_stop() {
        let t = JointTable::human();
        let dofs = all_dofs(&t);
        assert_eq!(dofs.len(), 17);
        for (name, d) in dofs {
            assert!(d.free[0] <= d.free[1], "{name}");
            assert!(d.max[0] <= d.max[1], "{name}");
            assert!(d.max[0] <= d.free[0], "{name}");
            assert!(d.free[1] <= d.max[1], "{name}");
            // Somewhere to move.
            assert!(d.max[1] > d.max[0], "{name}");
            // Radians on the way out, not degrees. A row that forgot the conversion
            // would show up here as a joint with hundreds of radians of travel.
            assert!(deg(d.max[0]).abs() <= 180.0, "{name}");
            assert!(deg(d.max[1]).abs() <= 180.0, "{name}");
            // The gap between functional and clinical range is what a solver spends.
            assert!(d.max[1] > d.free[1] || d.max[0] < d.free[0], "{name}");
        }
    }

    #[test]
    fn the_shoulder_carries_the_elevation_ceiling() {
        assert_eq!(JointTable::human().shoulder.elevation, ELEVATION.to_vec());
    }

    #[test]
    fn takes_the_upper_clinical_figure_for_humeral_rotation() {
        let r = JointTable::human().shoulder.rotation;
        close(deg(r.max[0]), -90.0, 9);
        close(deg(r.max[1]), 90.0, 9);
    }

    #[test]
    fn makes_elbow_flexion_free_from_zero_and_unsigned() {
        let f = JointTable::human().elbow.flexion;
        assert_eq!(f.free[0], 0.0);
        assert_eq!(f.max[0], 0.0);
        close(deg(f.max[1]), 150.0, 9);
        // A margin past the 145 a chin touch needs.
        assert!(deg(f.max[1]) > 145.0);
    }

    #[test]
    fn makes_wrist_deviation_deeply_asymmetric_toward_the_little_finger() {
        let d = JointTable::human().wrist.deviation;
        close(deg(d.free[1]), 10.0, 9);
        close(deg(d.free[0]), -20.0, 9);
        assert!(d.free[0].abs() > d.free[1].abs());
        assert!(d.max[0].abs() > d.max[1].abs());
    }

    #[test]
    fn does_not_repeat_one_joint_three_times_down_the_finger() {
        let t = JointTable::human();
        let (p, i, d) = (
            t.finger.proximal.unwrap(),
            t.finger.intermediate.unwrap(),
            t.finger.distal.unwrap(),
        );
        // The knuckle hyperextends and the middle joint does not.
        assert!(p.max[0] < 0.0);
        assert_eq!(i.max[0], 0.0);
        // The middle joint has the most flexion of the three; the tip the least.
        assert!(i.free[1] > p.free[1]);
        assert!(p.free[1] > d.free[1]);
        assert!(i.max[1] > p.max[1]);
        assert!(p.max[1] > d.max[1]);
    }

    #[test]
    fn names_all_three_segments_and_gives_the_thumb_less_flexion() {
        let t = JointTable::human();
        for spec in [t.finger, t.thumb] {
            assert!(spec.proximal.is_some() && spec.intermediate.is_some());
            assert!(spec.distal.is_some());
        }
        assert!(t.thumb.proximal.unwrap().free[1] < t.finger.proximal.unwrap().free[1]);
        assert!(t.thumb.intermediate.unwrap().free[1] < t.finger.intermediate.unwrap().free[1]);
    }

    #[test]
    fn holds_the_neck_inside_anatomy_and_bends_the_trunk_forward() {
        let t = JointTable::human();
        close(deg(t.neck.pitch.max[0]), -70.0, 9);
        close(deg(t.neck.yaw.max[1]), 90.0, 9);
        close(deg(t.neck.roll.max[1]), 45.0, 9);
        // The neck turns further than the trunk on every axis.
        assert!(t.neck.yaw.max[1] > t.spine.yaw.max[1]);
        assert!(t.neck.roll.max[1] > t.spine.roll.max[1]);
        let p = t.spine.pitch;
        assert!(p.free[1] > p.free[0].abs());
        assert!(p.max[1] > p.max[0].abs());
    }

    #[test]
    fn elevation_samples_the_whole_circle_in_order() {
        assert_eq!(ELEVATION[0][0], -180.0);
        assert_eq!(ELEVATION[ELEVATION.len() - 1][0], 180.0);
        for w in ELEVATION.windows(2) {
            assert!(w[1][0] > w[0][0]);
        }
        for [_, free, max] in ELEVATION {
            assert!(free > 0.0);
            assert!(max > free);
            assert!(max <= 180.0);
        }
        // It meets itself at the wrap, so the two ends describe the same plane.
        let (first, last) = (ELEVATION[0], ELEVATION[ELEVATION.len() - 1]);
        assert_eq!((last[1], last[2]), (first[1], first[2]));
    }

    #[test]
    fn elevation_states_the_figures_the_comment_names() {
        let at = |plane: f64| ELEVATION.iter().find(|r| r[0] == plane).unwrap();
        // Nearly straight up out to the side, 60 backwards, barely 45 across.
        assert!(at(0.0)[2] >= 175.0);
        assert_eq!(at(-90.0)[2], 60.0);
        assert_eq!(at(180.0)[2], 45.0);
        let widest = ELEVATION
            .iter()
            .max_by(|a, b| a[2].total_cmp(&b[2]))
            .unwrap();
        let narrowest = ELEVATION
            .iter()
            .min_by(|a, b| a[2].total_cmp(&b[2]))
            .unwrap();
        assert_eq!(widest[0], 45.0);
        assert_eq!(narrowest[0], -135.0);
    }

    #[test]
    fn hand_contact_sits_between_the_wrist_and_the_knuckles() {
        const { assert!(HAND_CONTACT > 0.0 && HAND_CONTACT < 0.5) };
    }
}
