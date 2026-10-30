//! `rig/point.ts`: a fingertip request, back-solved into an arm.
//!
//! Its own module because it is the one place a *bearing* becomes a pose. The
//! rest of the rig is told world directions and aims bones onto them; here the
//! caller says "up and to the right, most of the way out", and turning that into
//! a wrist position — hand length taken out, palm derived rather than assumed —
//! is a self-contained piece of arithmetic that the arm chain never has to know
//! about.
//!
//! The TS `_pt` scratch is written before it is read in every solve, so it is per call here.

use super::reach::{ArmSolution, length, near_reach, refresh_frame};
use crate::anatomy::arm::ArmAnatomy;
use crate::anatomy::joints::JointTable;
use crate::math::f::{cos, js_max, sin};
use crate::math::{Vec3, clamp};
use crate::profile::{ArmSlot, BoneSlot, Finger, Profile, Side};
use crate::scene::graph::Graph;

// point.ts worldDirection
//
// A world direction from either form a caller holds one in. A tuple and a vector carry the
// same three numbers, so both arrive here as a `Vec3`.
pub fn world_direction(a: &Vec3) -> Vec3 {
    let mut t = *a;
    t.normalize();
    t
}

/// A fingertip request as the solver receives it.
///
/// `PointSpec` states its directions as character-space tuples, which is how a
/// gesture authors them; the motion layer projects them into world-space
/// scratch vectors first, so both forms arrive here in the solver's frame.
/// Only the fields the solve reads; `mirror` and `twist` are the motion layer's.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PointRequest {
    /// Radians. 0 straight ahead, positive toward the character's right.
    pub azimuth: Option<f64>,
    /// Radians. 0 at shoulder height, positive up.
    pub elevation: Option<f64>,
    /// 0..1 of the arm's full reach, fingertip included.
    pub extent: Option<f64>,
    pub finger: Option<Finger>,
    pub point: Option<Vec3>,
    pub palm: Option<Vec3>,
}

/// Where the elbow is chosen, as this solver reaches it: `(graph, anat, side, wristTarget,
/// handDir, palmN, out)` to the strain of the pose, or none.
pub type ElbowSearchFn<'a> = dyn FnMut(
        &mut Graph,
        &mut ArmAnatomy,
        Side,
        &Vec3,
        Option<&Vec3>,
        Option<&Vec3>,
        &mut ArmSolution,
    ) -> Option<f64>
    + 'a;

#[derive(Clone, Copy, Debug, Default)]
pub struct PointSolver;

impl PointSolver {
    // point.ts PointSolver.constructor
    pub fn new() -> PointSolver {
        PointSolver
    }

    // point.ts PointSolver.solve
    //
    // Back-solve an arm from a fingertip.
    //
    // The request is angular: a bearing from the shoulder in the body's own
    // frame, plus how far out along it. That is the coordinate a pointing gesture
    // is actually specified in — "up and to the right, most of the way out" — and
    // unlike a world position it survives the character turning, leaning or being
    // a different size.
    //
    //   azimuth    radians, 0 straight ahead, positive toward the character's right
    //   elevation  radians, 0 at shoulder height, positive up
    //   extent     0..1 of the arm's full reach, fingertip included
    //   finger     which fingertip the coordinate refers to
    //   point      optional world direction the finger should point along
    //   palm       optional world direction the palm should face
    //
    // Two things are solved here that a plain reach does not have to. The target
    // is a fingertip and the solver's chain ends at the wrist, so the hand's own
    // length has to be taken out of the target first — a third of a forearm, and
    // ignoring it puts the hand through whatever is being pointed at. And the
    // elbow is not given: it is searched for, against the anatomy model's strain
    // and against where a person would have put it. Without that search a
    // fingertip target has a whole circle of correct answers and no reason to
    // prefer the one an arm would use.
    //
    // Returns whether `out` was solved (the TS returns `out` or null).
    #[allow(clippy::too_many_arguments)]
    pub fn solve(
        &self,
        p: &Profile,
        joints: &JointTable,
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        search: &mut ElbowSearchFn,
        side: Side,
        spec: &PointRequest,
        out: &mut ArmSolution,
    ) -> bool {
        let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side));
        let limb = &p.limb[side as usize];
        let (Some(upper), Some(la), Some(lf)) = (upper, length(limb.upper), length(limb.lower))
        else {
            return false;
        };
        if !refresh_frame(graph, anat) {
            return false;
        }

        let finger = spec.finger.unwrap_or(Finger::Index);
        let lt = limb.tip[finger as usize]
            .or(limb.tip[Finger::Index as usize])
            .unwrap_or(0.0);

        graph.update_world_matrix(upper, true, false, false);
        let s = graph.world_position(upper);

        // Bearing, in the body frame. Built rather than projected, so it cannot be
        // degenerate at any azimuth or elevation.
        let az = spec.azimuth.unwrap_or(0.0);
        let el = spec.elevation.unwrap_or(0.0);
        let ce = cos(el);
        let mut dir = *anat.fwd();
        dir.multiply_scalar(ce * cos(az))
            .add_scaled_vector(anat.right(), ce * sin(az))
            .add_scaled_vector(anat.up(), sin(el))
            .normalize();

        let reach = la + lf + lt;
        let extent = clamp(spec.extent.unwrap_or(0.8), 0.1, 1.0);
        let mut tip = s;
        tip.add_scaled_vector(&dir, reach * extent);

        // A finger points along the bearing unless told otherwise. That is what
        // pointing *is* — the line from the shoulder through the fingertip is the
        // line being indicated — and it also keeps the hand from having to bend to
        // an angle the wrist does not have.
        let mut finger_dir = match &spec.point {
            Some(point) => world_direction(point),
            None => dir,
        };
        finger_dir.normalize();
        let mut wrist;
        if spec.point.is_some() {
            wrist = tip;
            wrist.add_scaled_vector(&finger_dir, -lt);
        } else {
            // An extent shorter than the hand would put the wrist behind the
            // shoulder and flip the bearing; it stops at the elbow's fold instead.
            wrist = s;
            wrist.add_scaled_vector(
                &dir,
                js_max(near_reach(la, lf, joints), reach * extent - lt),
            );
        }

        // Palm. An explicit one constrains the wrist; without one the palm is a
        // free roll about the pointing axis, and it is *derived* from the solve
        // below rather than assumed. Assuming it — "a hand points palm-down" — was
        // the first version, and it charged the wrist for deviation it would never
        // have had to make: a cross-body point came back with 47 degrees of wrist
        // flexion and 11 of deviation, both flagged, when the real answer is that
        // the forearm rolls over and the wrist barely bends.
        let fixed_palm = spec.palm.is_some();
        let mut palm = Vec3::default();
        if let Some(wanted) = &spec.palm {
            palm = world_direction(wanted);
            palm.add_scaled_vector(&finger_dir, -palm.dot(&finger_dir));
            if palm.length_sq() < 1e-8 {
                palm.copy(anat.up()).negate();
            }
            palm.normalize();
        }

        let strain = search(
            graph,
            anat,
            side,
            &wrist,
            Some(&finger_dir),
            if fixed_palm { Some(&palm) } else { None },
            out,
        );
        let Some(strain) = strain else {
            return false;
        };

        // Derive the palm from the pose that won: point it along the direction the
        // hand had to bend, which makes that bend flexion rather than deviation.
        // The roll needed to get there is pronation, and `aimArm` hands it to the
        // forearm — which is the joint that actually performs it.
        if !fixed_palm {
            let lower = out.links.lower_arm;
            palm = finger_dir;
            palm.add_scaled_vector(&lower, -finger_dir.dot(&lower));
            if palm.length_sq() < 1e-6 {
                // A straight wrist bends in no direction, so nothing is determined and
                // a hand pointing at something rests palm-down.
                palm.copy(anat.up()).negate();
                palm.add_scaled_vector(&finger_dir, -palm.dot(&finger_dir));
                if palm.length_sq() < 1e-8 {
                    palm.copy(anat.fwd()).negate();
                }
            }
            palm.normalize();
        }

        out.hand = finger_dir;
        out.twist = 0.0;
        // Copied, never aliased: `_pt` is one scratch object shared by both arms
        // and by both gesture slots, so handing out a reference to it means the
        // next solve silently rewrites an answer the caller is still holding.
        out.palm = palm;
        // Where the fingertip actually ended up, so a caller can tell a request
        // that was honoured from one the arm was too short for.
        let links = out.links;
        out.tip = s;
        out.tip
            .add_scaled_vector(&links.upper_arm, la)
            .add_scaled_vector(&links.lower_arm, lf)
            .add_scaled_vector(&finger_dir, lt);
        out.strain = Some(strain);
        true
    }
}

#[cfg(test)]
mod tests {
    //! `tests/rig/point.test.ts`, on the base avatar.
    //!
    //! The request is a bearing in the body's own frame and the answer is a chain
    //! that ends at the wrist, so the two things worth pinning are that the bearing
    //! is read in the frame it claims and that the hand's own length is taken out of
    //! the target before the two-link solve sees it.
    use super::*;
    use crate::rig::testkit::{Arms, bone, close};

    /// The chain is placed by a closed-form solve, so the wrist lands to rounding.
    const EXACT: f64 = 1e-9;
    /// How far the elbow may drift while a pose is merely held, as a fraction of the
    /// upper arm. The search damps toward its answer, so a settled pose should be
    /// still; the failure this guards against swung the elbow through tens of degrees.
    const HELD_DRIFT: f64 = 0.02;
    /// Frames to run before an elbow is asked to hold still.
    ///
    /// The search moves a fixed fraction of the way to its answer each frame, so a
    /// cold start takes a couple of dozen of them however near the answer already
    /// is; from the far side of the circle it is about 26. Comfortably past that,
    /// because a test that measures a settled pose from a not-quite-settled one
    /// fails intermittently and blames the solver.
    const SETTLE_FRAMES: usize = 60;
    const SIDE: Side = Side::R;

    struct Arm {
        arms: Arms,
        shoulder: Vec3,
        upper_len: f64,
        fore_len: f64,
    }

    fn build_arm() -> Arm {
        let mut arms = Arms::new();
        let shoulder = arms.shoulder(SIDE);
        let limb = arms.profile.limb[SIDE as usize];
        Arm {
            arms,
            shoulder,
            upper_len: limb.upper.unwrap(),
            fore_len: limb.lower.unwrap(),
        }
    }

    fn spec(azimuth: f64, elevation: f64, extent: f64) -> PointRequest {
        PointRequest {
            azimuth: Some(azimuth),
            elevation: Some(elevation),
            extent: Some(extent),
            ..PointRequest::default()
        }
    }

    fn wrist_of(arm: &Arm, out: &ArmSolution) -> Vec3 {
        let mut v = arm.shoulder;
        v.add_scaled_vector(&out.links.upper_arm, arm.upper_len)
            .add_scaled_vector(&out.links.lower_arm, arm.fore_len);
        v
    }

    fn elbow_of(arm: &Arm, out: &ArmSolution) -> Vec3 {
        let mut v = arm.shoulder;
        v.add_scaled_vector(&out.links.upper_arm, arm.upper_len);
        v
    }

    fn solve(arm: &mut Arm, spec: &PointRequest, out: &mut ArmSolution) -> bool {
        arm.arms.solve_point(SIDE, spec, out)
    }

    /// Hold one target until the elbow stops moving, and return the pose it reached.
    fn settle_at(arm: &mut Arm, spec: &PointRequest) -> ArmSolution {
        let mut out = ArmSolution::default();
        for _ in 0..SETTLE_FRAMES {
            solve(arm, spec, &mut out);
        }
        out
    }

    fn bearing(arm: &Arm, azimuth: f64, elevation: f64) -> Vec3 {
        let anat = &arm.arms.anat;
        let mut want = *anat.fwd();
        want.multiply_scalar(cos(elevation) * cos(azimuth))
            .add_scaled_vector(anat.right(), cos(elevation) * sin(azimuth))
            .add_scaled_vector(anat.up(), sin(elevation))
            .normalize();
        want
    }

    fn from_shoulder(arm: &Arm, p: &Vec3) -> Vec3 {
        let mut v = *p;
        v.sub(&arm.shoulder).normalize();
        v
    }

    fn tip_len(arm: &Arm, finger: Finger) -> f64 {
        arm.arms.profile.limb[SIDE as usize].tip[finger as usize].unwrap()
    }

    #[test]
    fn reads_the_bearing_in_the_body_frame_not_in_world_axes() {
        let mut arm = build_arm();
        let mut out = ArmSolution::default();
        for (azimuth, elevation) in [
            (0.0, 0.0),
            (0.7, 0.0),
            (-0.7, 0.0),
            (0.0, 0.6),
            (0.0, -0.6),
            (0.5, 0.4),
        ] {
            assert!(solve(&mut arm, &spec(azimuth, elevation, 0.8), &mut out));
            let want = bearing(&arm, azimuth, elevation);
            let got = from_shoulder(&arm, &out.tip);
            assert!(got.distance_to(&want) < EXACT);
        }
    }

    #[test]
    fn sends_azimuth_zero_forward_positive_azimuth_right_and_positive_elevation_up() {
        let mut arm = build_arm();
        let mut out = ArmSolution::default();
        // Ground the frame in the skeleton: the character's left hand is the side
        // `right` must point away from.
        let left = bone(&arm.arms.profile, BoneSlot::HandL);
        let right = bone(&arm.arms.profile, BoneSlot::HandR);
        let left_hand = arm.arms.graph.world_position(left);
        let mut across = arm.arms.graph.world_position(right);
        across.sub(&left_hand).normalize();
        let (fwd, up, rt) = (
            *arm.arms.anat.fwd(),
            *arm.arms.anat.up(),
            *arm.arms.anat.right(),
        );
        assert!(across.dot(&rt) > 0.99);

        let mut toward = |a: f64, e: f64| {
            solve(&mut arm, &spec(a, e, 0.8), &mut out);
            from_shoulder(&arm, &out.tip)
        };
        assert!(toward(0.0, 0.0).dot(&fwd) > 0.999);
        assert!(toward(0.9, 0.0).dot(&rt) > 0.5);
        assert!(toward(-0.9, 0.0).dot(&rt) < -0.5);
        assert!(toward(0.0, 0.9).dot(&up) > 0.5);
        assert!(toward(0.0, -0.9).dot(&up) < -0.5);
    }

    #[test]
    fn places_the_fingertip_at_the_requested_extent_of_the_full_reach() {
        let mut arm = build_arm();
        let mut out = ArmSolution::default();
        let reach = arm.upper_len + arm.fore_len + tip_len(&arm, Finger::Index);
        // Nearer than this the wrist would pass the elbow's fold; see the next test.
        for extent in [0.6, 0.8] {
            solve(&mut arm, &spec(0.2, 0.1, extent), &mut out);
            close(out.tip.distance_to(&arm.shoulder), reach * extent, 9);
        }
        // Full extent is held just inside a straight arm, and the tip reports that.
        solve(&mut arm, &spec(0.2, 0.1, 1.0), &mut out);
        assert!(out.tip.distance_to(&arm.shoulder) < reach);
        assert!(
            out.tip.distance_to(&arm.shoulder) > reach - 0.002 * (arm.upper_len + arm.fore_len)
        );
    }

    #[test]
    fn keeps_the_wrist_ahead_of_the_shoulder_when_the_extent_is_shorter_than_the_hand() {
        let mut arm = build_arm();
        let mut out = ArmSolution::default();
        let tip = tip_len(&arm, Finger::Index);
        let reach = arm.upper_len + arm.fore_len + tip;
        assert!(reach * 0.1 < tip);

        solve(&mut arm, &spec(0.2, 0.1, 0.1), &mut out);
        let want = bearing(&arm, 0.2, 0.1);
        let wrist = wrist_of(&arm, &out);
        assert!(from_shoulder(&arm, &wrist).dot(&want) > 1.0 - 1e-6);
        // The fingertip is reported where it went, not where it was asked for.
        let mut walked = wrist;
        walked.add_scaled_vector(&out.hand, tip);
        assert!(out.tip.distance_to(&walked) < EXACT);
        assert!(out.tip.distance_to(&arm.shoulder) > tip);
    }

    #[test]
    fn lands_the_fingertip_on_the_target_and_the_wrist_a_fingertip_back_from_it() {
        let mut arm = build_arm();
        let mut out = ArmSolution::default();
        let tip = tip_len(&arm, Finger::Index);
        solve(&mut arm, &spec(0.25, 0.15, 0.7), &mut out);
        let wrist = wrist_of(&arm, &out);
        // The hand is not ignored: the wrist sits a whole fingertip length short of
        // the point being indicated, along the direction the finger points.
        close(out.tip.distance_to(&wrist), tip, 9);
        let mut d = out.tip;
        d.sub(&wrist).normalize();
        assert!(d.dot(&out.hand) > 1.0 - EXACT);
        // And that length is a real fraction of the forearm, not a rounding detail.
        assert!(tip > arm.fore_len * 0.25);
    }

    #[test]
    fn leaves_the_finger_pointing_along_the_bearing_unless_told_otherwise() {
        let mut arm = build_arm();
        let mut out = ArmSolution::default();
        solve(&mut arm, &spec(0.3, 0.2, 0.75), &mut out);
        assert!(out.hand.distance_to(&bearing(&arm, 0.3, 0.2)) < EXACT);

        // An explicit point direction overrides it, and the wrist backs off along
        // that direction instead. Held at half extent so the displaced wrist is
        // still inside the annulus and the solve is not clamped.
        let stated = Vec3::new(0.0, -1.0, 0.0);
        let request = PointRequest {
            point: Some(stated),
            ..spec(0.3, 0.2, 0.5)
        };
        solve(&mut arm, &request, &mut out);
        assert!(out.hand.distance_to(&stated) < EXACT);
        let mut backed_off = out.tip;
        backed_off.add_scaled_vector(&stated, -tip_len(&arm, Finger::Index));
        assert!(wrist_of(&arm, &out).distance_to(&backed_off) < EXACT);
    }

    #[test]
    fn uses_the_named_finger_tip_length_so_a_thumb_and_a_middle_finger_differ() {
        let mut thumb_arm = build_arm();
        let mut middle_arm = build_arm();
        let mut thumb = ArmSolution::default();
        let mut middle = ArmSolution::default();
        let with = |finger| PointRequest {
            finger: Some(finger),
            ..spec(0.3, 0.2, 0.7)
        };
        solve(&mut thumb_arm, &with(Finger::Thumb), &mut thumb);
        solve(&mut middle_arm, &with(Finger::Middle), &mut middle);

        let thumb_len = tip_len(&thumb_arm, Finger::Thumb);
        let middle_len = tip_len(&middle_arm, Finger::Middle);
        assert!((thumb_len - middle_len).abs() >= 0.5e-4);
        close(
            thumb.tip.distance_to(&wrist_of(&thumb_arm, &thumb)),
            thumb_len,
            9,
        );
        close(
            middle.tip.distance_to(&wrist_of(&middle_arm, &middle)),
            middle_len,
            9,
        );
        // Same bearing, same extent, different wrist.
        assert!(wrist_of(&thumb_arm, &thumb).distance_to(&wrist_of(&middle_arm, &middle)) > 1e-4);
    }

    #[test]
    fn falls_back_to_the_index_finger_for_a_finger_the_rig_does_not_have() {
        let mut named = build_arm();
        let mut fallback = build_arm();
        let mut a = ArmSolution::default();
        let mut b = ArmSolution::default();
        fallback.arms.profile.limb[SIDE as usize].tip[Finger::Little as usize] = None;
        let with = |finger| PointRequest {
            finger: Some(finger),
            ..spec(0.1, 0.1, 0.7)
        };
        solve(&mut named, &with(Finger::Index), &mut a);
        solve(&mut fallback, &with(Finger::Little), &mut b);
        assert!(b.tip.distance_to(&a.tip) < EXACT);
    }

    #[test]
    fn reports_a_cost_that_rises_for_a_bearing_the_arm_has_to_strain_into() {
        let mut ahead = build_arm();
        let mut across = build_arm();
        let mut overhead = build_arm();
        let (mut easy, mut hard, mut high) = Default::default();
        solve(&mut ahead, &spec(0.0, 0.0, 0.7), &mut easy);
        solve(&mut across, &spec(-1.5, 0.0, 0.7), &mut hard);
        solve(&mut overhead, &spec(0.0, 1.4, 0.95), &mut high);
        let strain = |s: &ArmSolution| s.strain.expect("a strain");
        for value in [strain(&easy), strain(&hard), strain(&high)] {
            assert!(value.is_finite());
        }
        // Straight ahead at a moderate extent is the cheap pose.
        assert!(strain(&easy) < strain(&high));
        // Reaching across the body drives the arm into the trunk, which outbids
        // every joint term.
        assert!(strain(&hard) > strain(&easy) * 10.0);
    }

    #[test]
    fn reports_the_strain_of_the_pose_it_returned_without_the_elbow_prior() {
        for s in [spec(0.3, 0.2, 0.75), spec(-0.9, 0.6, 0.7)] {
            let mut arm = build_arm();
            let mut out = ArmSolution::default();
            // The first frame tracks only part of the way toward the winner, so the
            // returned pose is not the one the search scored best.
            solve(&mut arm, &s, &mut out);
            let moved = PointRequest {
                azimuth: Some(s.azimuth.unwrap() + 0.4),
                ..s
            };
            solve(&mut arm, &moved, &mut out);
            let anat = &mut arm.arms.anat;
            anat.measure(
                SIDE,
                &out.links.upper_arm,
                &out.links.lower_arm,
                &out.hand,
                None,
                0.0,
                0.0,
            );
            close(out.strain.unwrap(), anat.cost(), 12);
        }
    }

    #[test]
    fn copies_palm_and_tip_rather_than_aliasing_the_shared_scratch() {
        let mut arm = build_arm();
        let mut first = ArmSolution::default();
        let mut second = ArmSolution::default();
        solve(&mut arm, &spec(0.4, 0.3, 0.7), &mut first);
        let held = first;
        // A second solve, for a different bearing, through a different `out`.
        solve(&mut arm, &spec(-0.8, -0.4, 0.95), &mut second);
        assert_eq!(first.palm.distance_to(&held.palm), 0.0);
        assert_eq!(first.tip.distance_to(&held.tip), 0.0);
        assert_eq!(first.hand.distance_to(&held.hand), 0.0);
        // The second answer really is a different pose, so the check above is not
        // passing because nothing moved.
        assert!(second.tip.distance_to(&held.tip) > 0.05);
    }

    #[test]
    fn keeps_one_arm_answer_intact_while_the_other_arm_solves() {
        let mut arms = Arms::new();
        let mut left = ArmSolution::default();
        let mut right = ArmSolution::default();
        arms.solve_point(Side::L, &spec(-0.5, 0.3, 0.8), &mut left);
        let held = left;
        arms.solve_point(Side::R, &spec(0.5, -0.3, 0.6), &mut right);
        assert_eq!(left.tip.distance_to(&held.tip), 0.0);
        assert_eq!(left.palm.distance_to(&held.palm), 0.0);
        assert!(right.tip.distance_to(&held.tip) > 0.05);
    }

    const HELD: (f64, f64, f64) = (0.2, 0.35, 0.75);

    #[test]
    fn brings_the_elbow_to_rest_on_a_target_that_is_merely_held() {
        let mut arm = build_arm();
        let mut out = ArmSolution::default();
        let s = spec(HELD.0, HELD.1, HELD.2);
        // The search tracks a fraction of the remaining distance each frame, so a
        // cold start converges rather than arriving. What matters is that it does
        // converge — and *stops*, rather than closing the last of the gap forever.
        let mut previous = Vec3::new(f64::NAN, 0.0, 0.0);
        let mut still_from = None;
        for i in 0..SETTLE_FRAMES {
            solve(&mut arm, &s, &mut out);
            let elbow = elbow_of(&arm, &out);
            if still_from.is_none() && elbow.distance_to(&previous) < EXACT {
                still_from = Some(i);
            }
            previous = elbow;
        }
        assert!(still_from.is_some());

        // And once still, exactly still. A pose left alone must not drift.
        let settled = elbow_of(&arm, &out);
        for _ in 0..12 {
            solve(&mut arm, &s, &mut out);
            assert!(elbow_of(&arm, &out).distance_to(&settled) < EXACT);
        }
    }

    #[test]
    fn puts_the_elbow_where_the_target_says_not_where_it_came_from() {
        // The property the anatomical prior exists for. Reaching one target by way
        // of another used to leave the elbow wherever the route had put it, because
        // the search preferred to stay put and the two candidate elbows for most
        // targets score nearly the same. An arm posture is a function of where the
        // hand is; arriving from the far side must not change it.
        let s = spec(HELD.0, HELD.1, HELD.2);
        let mut straight = build_arm();
        let reached = settle_at(&mut straight, &s);
        let direct = elbow_of(&straight, &reached);

        let mut via_other = build_arm();
        settle_at(&mut via_other, &spec(-1.1, -0.5, 0.9));
        let reached = settle_at(&mut via_other, &s);
        let round = elbow_of(&via_other, &reached);
        assert!(round.distance_to(&direct) < via_other.upper_len * HELD_DRIFT);
    }

    #[test]
    fn barely_moves_the_elbow_for_a_target_nudged_by_a_hair() {
        let mut arm = build_arm();
        let reached = settle_at(&mut arm, &spec(HELD.0, HELD.1, HELD.2));
        let settled = elbow_of(&arm, &reached);
        let mut out = ArmSolution::default();
        solve(&mut arm, &spec(HELD.0, HELD.1 + 0.002, HELD.2), &mut out);
        assert!(elbow_of(&arm, &out).distance_to(&settled) < arm.upper_len * HELD_DRIFT);
    }

    #[test]
    fn still_moves_the_elbow_for_a_genuine_change_of_intent() {
        let mut arm = build_arm();
        let reached = settle_at(&mut arm, &spec(HELD.0, HELD.1, HELD.2));
        let settled = elbow_of(&arm, &reached);
        let mut out = ArmSolution::default();
        solve(&mut arm, &spec(-1.2, -0.6, 0.9), &mut out);
        assert!(elbow_of(&arm, &out).distance_to(&settled) > arm.upper_len * 0.5);
    }

    #[test]
    fn hangs_the_elbow_below_the_shoulder_for_a_hand_held_out_in_front() {
        // The prior's first claim, and the one a strain score gets wrong on its own:
        // both elbows are comfortable for a hand at chest height, and only one of
        // them is a pose a person adopts.
        let mut arm = build_arm();
        let reached = settle_at(&mut arm, &spec(0.1, 0.0, 0.7));
        assert!(elbow_of(&arm, &reached).y < arm.shoulder.y);
    }

    #[test]
    fn raises_the_elbow_less_than_the_hand_it_is_carrying() {
        // The elevation regression: the elbow follows the hand up at less than its
        // rate, so it neither stays pinned to the ribs nor cocks above the wrist.
        let mut arm = build_arm();
        let low = settle_at(&mut arm, &spec(0.2, -0.2, 0.7));
        let (low_elbow, low_wrist) = (elbow_of(&arm, &low), wrist_of(&arm, &low));
        let high = settle_at(&mut arm, &spec(0.2, 0.8, 0.7));
        let elbow_rise = elbow_of(&arm, &high).y - low_elbow.y;
        let wrist_rise = wrist_of(&arm, &high).y - low_wrist.y;
        assert!(wrist_rise > 0.0);
        assert!(elbow_rise > 0.0);
        assert!(elbow_rise < wrist_rise);
    }

    #[test]
    fn clamps_extent_into_the_band_the_arm_can_be_asked_for() {
        let mut arm = build_arm();
        let reach = arm.upper_len + arm.fore_len + tip_len(&arm, Finger::Index);
        let (mut low, mut high, mut lowest, mut highest) = Default::default();
        solve(&mut arm, &spec(0.0, 0.0, -3.0), &mut low);
        solve(&mut arm, &spec(0.0, 0.0, 4.0), &mut high);
        solve(&mut arm, &spec(0.0, 0.0, 0.1), &mut lowest);
        solve(&mut arm, &spec(0.0, 0.0, 1.0), &mut highest);
        let (low, high): (ArmSolution, ArmSolution) = (low, high);
        let (lowest, highest): (ArmSolution, ArmSolution) = (lowest, highest);
        assert!(low.tip.distance_to(&lowest.tip) < EXACT);
        assert!(high.tip.distance_to(&highest.tip) < EXACT);
        assert!(high.tip.distance_to(&arm.shoulder) < reach);
        assert!(low.tip.distance_to(&arm.shoulder) > reach * 0.1);
    }

    #[test]
    fn refuses_an_arm_the_profile_has_no_segment_lengths_for() {
        let mut arm = build_arm();
        arm.arms.profile.limb[SIDE as usize].lower = Some(0.0);
        assert!(!solve(
            &mut arm,
            &spec(0.0, 0.0, 0.7),
            &mut ArmSolution::default()
        ));
    }
}
