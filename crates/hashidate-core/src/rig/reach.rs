//! `rig/reach.ts`: two-link reach geometry.
//!
//! Pure functions rather than methods: none of this needs the rig's per-frame
//! state, only the profile's bones and lengths and the anatomy layer's world
//! frame. Keeping it out of the class is also what lets `poleAngle` and
//! `solveReach` share `reachRef` without either of them owning it.
//!
//! The TS keeps the `_reach*` and `_pole*` scratch apart so a pole converted to an angle and
//! then solved with does not share scratch; here every scratch is a local, which keeps them
//! apart by construction. A `framed` the TS leaves `undefined` is `None`, and refreshes the
//! anatomy frame as the TS default parameter does.

use crate::anatomy::arm::ArmAnatomy;
use crate::anatomy::joints::JointTable;
use crate::math::Vec3;
use crate::math::f::{acos, atan2, cos, js_max, js_min, sin, sqrt};
use crate::profile::{ArmSlot, BoneSlot, Profile, Side};
use crate::scene::graph::Graph;
use core::f64::consts::PI;

// How far off the reach line a pole has to sit before it means anything —
// sin 14 degrees. Below this the elbow direction it implies is mostly noise.
const POLE_MIN_SINE: f64 = 0.25;
const FALLBACK_FWD: Vec3 = Vec3::new(0.0, 0.0, 1.0);
const FALLBACK_UP: Vec3 = Vec3::new(0.0, 1.0, 0.0);

/// The two links a plain reach determines. The elbow search scores candidates
/// that carry nothing else, so this is what `solveReach` is allowed to want.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ReachLinks {
    pub upper_arm: Vec3,
    pub lower_arm: Vec3,
}

/// A solved arm, as the motion layer holds it.
///
/// Allocated by the caller and filled in place — one set per gesture slot, so an
/// outgoing reach and an incoming one can both be live during a crossfade.
/// The TS interface extends `ReachLinks`; here the two links are its `links`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ArmSolution {
    pub links: ReachLinks,
    pub hand: Vec3,
    pub palm: Vec3,
    /// Where the fingertip actually ended up, for a caller checking it arrived.
    pub tip: Vec3,
    pub twist: f64,
    /// Anatomical strain of the solved pose, from a fingertip solve.
    pub strain: Option<f64>,
    /// Where the elbow search left this slot's elbow: the direction it stands off
    /// the reach line, in the body frame (right, up, forward). Zero until the
    /// slot's first solve.
    ///
    /// A direction rather than the swivel angle. The angle is measured from
    /// `reachRef`, which changes its reference as the reach nears forward, and an
    /// angle remembered across that change names a different elbow in the next
    /// frame — the arm then swung a quarter turn to reach it.
    pub swivel_dir: Vec3,
    /// Set when the follower hand of a clasp was solved here rather than a plain reach.
    pub clasp: Option<bool>,
}

/// A profile length as the TS truth-tests it: absent, zero and NaN are all "none".
pub(crate) fn length(value: Option<f64>) -> Option<f64> {
    value.filter(|&v| v != 0.0 && !v.is_nan())
}

/// `anat.update()`, counted under test so a caller can check how often the frame is refreshed.
pub(crate) fn refresh_frame(graph: &mut Graph, anat: &mut ArmAnatomy) -> bool {
    #[cfg(test)]
    FRAME_REFRESHES.with(|c| c.set(c.get() + 1));
    anat.update(graph)
}

#[cfg(test)]
thread_local! {
    pub(crate) static FRAME_REFRESHES: core::cell::Cell<usize> = const { core::cell::Cell::new(0) };
}

// reach.ts reachRef
//
// The zero-angle elbow reference for a reach along `n`, written into `perp`.
//
// Built perpendicular rather than projected, for the reason set out in
// `solveReach`, and shared with `poleAngle` so that converting a pole point
// to an angle and solving with it agree on where zero is.
//
// `framed` is the result of an `anat.update()` the caller already made this
// frame; omitted, the frame is refreshed here.
pub fn reach_ref<'p>(
    graph: &mut Graph,
    anat: &mut ArmAnatomy,
    n: &Vec3,
    perp: &'p mut Vec3,
    framed: Option<bool>,
) -> &'p mut Vec3 {
    let framed = match framed {
        Some(framed) => framed,
        None => refresh_frame(graph, anat),
    };
    perp.copy(if framed { anat.fwd() } else { &FALLBACK_FWD });
    // Reaching straight forward is the one case where forward says nothing.
    // Up is perpendicular to it and cannot be degenerate at the same time.
    if perp.dot(n).abs() > 0.87 {
        perp.copy(if framed { anat.up() } else { &FALLBACK_UP });
    }
    let along = -perp.dot(n);
    perp.add_scaled_vector(n, along).normalize()
}

// reach.ts nearReach
//
// The nearest the wrist can come to the shoulder, which is the elbow's
// flexion stop rather than a folded-flat arm. See `solveReach` for why.
pub fn near_reach(la: f64, lf: f64, joints: &JointTable) -> f64 {
    let flex_max = joints.elbow.flexion.max[1];
    let fold = cos(PI - flex_max);
    js_max(
        (la - lf).abs() + 1e-3,
        sqrt(la * la + lf * lf - 2.0 * la * lf * fold) * 1.001,
    )
}

// reach.ts solveReach
//
// Solve a two-link reach so the wrist lands on `targetWorld`.
//
// Returns world-space directions for the arm chain rather than posing the
// bones, so the result flows through exactly the same blending path as an
// authored gesture — a reach has to be able to crossfade with a wave.
//
// This exists because direction-authored gestures cannot touch anything. A
// direction fixes where the elbow points, not where the hand ends up, and the
// hand's position then depends on the avatar's arm length. Anything that has
// to make contact with the face is a position, and has to be solved as one.
//
// `elbowAngle` resolves the one degree of freedom left once the wrist is
// fixed: the elbow can sit anywhere on a circle around the shoulder-to-wrist
// line, and the angle says where on that circle. Zero puts it straight in
// front of the chest; positive swings it outward and up.
//
// `framed` is as for `reachRef`. Returns whether `out` was solved (the TS returns `out` or null).
#[allow(clippy::too_many_arguments)]
pub fn solve_reach(
    p: &Profile,
    joints: &JointTable,
    graph: &mut Graph,
    anat: &mut ArmAnatomy,
    side: Side,
    target_world: &Vec3,
    elbow_angle: f64,
    out: &mut ReachLinks,
    framed: Option<bool>,
) -> bool {
    let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side));
    let limb = &p.limb[side as usize];
    let (Some(upper), Some(la), Some(lf)) = (upper, length(limb.upper), length(limb.lower)) else {
        return false;
    };

    graph.update_world_matrix(upper, true, false, false);
    let s = graph.world_position(upper);
    let mut dv = *target_world;
    dv.sub(&s);
    let mut d = dv.length();
    if d < 1e-6 {
        return false;
    }

    // Clamp into the annulus the arm can actually reach. Held just inside the
    // bounds: a fully straight or fully folded arm makes the elbow direction
    // degenerate, and the joint flips as the target crosses the limit.
    //
    // The near bound is the elbow's own flexion limit, not `|La - Lf|`. The
    // geometric figure closes at 180 degrees of flexion, which is a forearm
    // folded flat against the upper arm and something no elbow does; the joint
    // stops at 150. The difference is not academic on a short-necked avatar,
    // where the face sits close to the shoulder: measured on the validation
    // model, eight of the eleven face-touching gestures asked for a wrist
    // nearer the shoulder than 150 degrees allows, the geometric clamp let
    // every one of them through, and the pose then came apart downstream when
    // the joint clamp had to take back what the solver had granted. Bounded
    // here, the hand instead stops short along the same bearing, which is what
    // an arm that cannot quite reach actually looks like.
    let d_min = near_reach(la, lf, joints);
    let d_max = (la + lf) * 0.999;
    d = js_min(d_max, js_max(d_min, d));
    let mut n = dv;
    n.normalize();

    // Elbow-out direction.
    //
    // This used to be authored as a vector and projected onto the plane normal
    // to the reach. That does not work, and it fails quietly. A hand travelling
    // to the face goes up and inward, so a pole written as "out and down" — the
    // obvious way to describe a hanging elbow — ends up nearly *anti*-parallel
    // to the reach. Subtracting the parallel part then removes more sideways
    // component than the pole had to begin with, and what is left points the
    // other way: on the validation avatar a pole of (-0.52, -0.86, 0.12) came
    // back as (+0.42, -0.68, 0.60), swinging the right elbow across the chest.
    // Nothing caught it, because the residue was still 0.43 long — a guard on
    // the residue's length only catches the exactly-parallel case, and this was
    // 156 degrees away.
    //
    // So the direction is built perpendicular instead of projected. Forward is
    // the reference because it is close to perpendicular to every path a hand
    // takes to the face, and because in front of the chest is where an elbow
    // belongs when the arm is folded up. The angle then swings it around the
    // reach line from there, and can never be degenerate.
    let mut perp = Vec3::default();
    reach_ref(graph, anat, &n, &mut perp, framed);
    if elbow_angle != 0.0 && !elbow_angle.is_nan() {
        perp.apply_axis_angle(&n, elbow_angle);
    }

    // Angle between the reach line and the upper arm.
    let cos_a = (la * la + d * d - lf * lf) / (2.0 * la * d);
    let a = acos(js_min(1.0, js_max(-1.0, cos_a)));

    out.upper_arm
        .copy(&n)
        .multiply_scalar(cos(a))
        .add_scaled_vector(&perp, sin(a))
        .normalize();

    // Elbow, then the forearm direction that closes onto the target.
    //
    // Onto the *clamped* target — the point at `d` along the bearing — and not
    // onto the one that was asked for. Where nothing was clamped the two are the
    // same point and this is exactly the old arithmetic; where the target sat
    // inside the elbow's flexion stop, aiming at the raw request folded the joint
    // straight back past the bound the clamp above had just established. The upper
    // arm stopped short and the forearm did not, which is not "an arm that cannot
    // quite reach" but an elbow bent the wrong way, and it left the joint clamp
    // downstream taking back what the solver had granted.
    let mut reached = s;
    reached.add_scaled_vector(&n, d);
    let mut e = s;
    e.add_scaled_vector(&out.upper_arm, la);
    out.lower_arm.copy(&reached).sub(&e);
    if out.lower_arm.length_sq() < 1e-10 {
        out.lower_arm = out.upper_arm;
    } else {
        out.lower_arm.normalize();
    }
    true
}

// reach.ts poleAngle
//
// Where on the elbow circle a pole *point* puts the elbow, in radians.
//
// This is the conversion that lets a gesture name a position instead of an
// angle, which is what every animation package asks for — Unity's hint
// transform, Unreal's joint target location. It matters because the angle is
// measured about the shoulder-to-wrist line, and that line swings through the
// best part of a right angle between a hand at the hip and a hand at the
// mouth. A constant angle is therefore only meaningful at the one pose it was
// measured on, and describes a wild arc on the way there; a point fixed
// beside the ribs holds still, so the elbow moves continuously with the hand.
//
// Returns null when the pole sits on the reach line, where it says nothing.
// A point out beside the body cannot reach that state while the hand is in
// front of the face — unlike a pole *direction* anchored at the shoulder,
// which goes anti-parallel exactly when the arm folds up, and which is why
// the first attempt at this was abandoned for an angle.
pub fn pole_angle(
    p: &Profile,
    graph: &mut Graph,
    anat: &mut ArmAnatomy,
    side: Side,
    target_world: &Vec3,
    pole_world: &Vec3,
) -> Option<f64> {
    let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side))?;
    graph.update_world_matrix(upper, true, false, false);
    let s = graph.world_position(upper);
    let mut n = *target_world;
    n.sub(&s);
    if n.length_sq() < 1e-10 {
        return None;
    }
    n.normalize();
    let mut w = *pole_world;
    w.sub(&s);
    swivel_of(graph, anat, &n, &w, None)
}

// reach.ts swivelOf
//
// The swivel angle of a direction `w` about the unit reach line `n`, in the
// shared reference, or null where `w` lies too close to the line to say.
//
// Shared by the pole conversion and by the elbow search reading back where it
// left the elbow, so a point and a remembered direction agree on where zero is.
pub fn swivel_of(
    graph: &mut Graph,
    anat: &mut ArmAnatomy,
    n: &Vec3,
    w: &Vec3,
    framed: Option<bool>,
) -> Option<f64> {
    let len = w.length();
    if len < 1e-6 {
        return None;
    }
    let mut r = *w;
    r.add_scaled_vector(n, -w.dot(n));
    // The residue as a fraction of the offset is the sine of the angle between
    // the pole and the reach, so this rejects near-parallel as well as parallel.
    // A bare length test does not: the residue of a long, almost-collinear
    // offset is still long, and the direction it points is noise. That is the
    // hole the earlier pole-as-vector attempt fell through.
    if r.length() / len < POLE_MIN_SINE {
        return None;
    }
    r.normalize();
    let mut reference = Vec3::default();
    reach_ref(graph, anat, n, &mut reference, framed);
    let mut bi = *n;
    bi.cross(&reference);
    Some(atan2(r.dot(&bi), r.dot(&reference)))
}

#[cfg(test)]
mod tests {
    //! `tests/rig/reach.test.ts`, on the base avatar.
    //!
    //! The one thing this solver exists to do is put the wrist on a point, so most of
    //! what is pinned here is walked out of the returned directions —
    //! `shoulder + upperArm*La + lowerArm*Lf` — rather than read off an intermediate.
    use super::*;
    use crate::rig::testkit::{Arms, close};

    /// The solve is closed form, so a wrist that is asked for and granted lands on
    /// its target to floating-point precision. Anything looser would fail to notice
    /// an arm that solved to the wrong branch.
    const EXACT: f64 = 1e-9;
    /// Directions leave `normalize`, so nothing wider than accumulated rounding.
    const UNIT: f64 = 1e-12;
    /// Two solves of the same request differ only by rounding; a real change is orders larger.
    const STABLE: f64 = 1e-9;
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

    fn offset(arm: &Arm, x: f64, y: f64, z: f64) -> Vec3 {
        let mut v = arm.shoulder;
        v.add(&Vec3::new(x, y, z));
        v
    }

    fn along(arm: &Arm, bearing: &Vec3, distance: f64) -> Vec3 {
        let mut v = arm.shoulder;
        v.add_scaled_vector(bearing, distance);
        v
    }

    /// Where the chain actually puts the wrist, walked from the shoulder.
    fn wrist_of(arm: &Arm, out: &ReachLinks) -> Vec3 {
        let mut v = arm.shoulder;
        v.add_scaled_vector(&out.upper_arm, arm.upper_len)
            .add_scaled_vector(&out.lower_arm, arm.fore_len);
        v
    }

    /// Where the chain puts the elbow.
    fn elbow_of(arm: &Arm, out: &ReachLinks) -> Vec3 {
        let mut v = arm.shoulder;
        v.add_scaled_vector(&out.upper_arm, arm.upper_len);
        v
    }

    /// The angle the anatomy layer would read as elbow flexion: 0 straight, pi folded.
    fn elbow_flexion(out: &ReachLinks) -> f64 {
        acos(crate::math::clamp(
            out.upper_arm.dot(&out.lower_arm),
            -1.0,
            1.0,
        ))
    }

    fn solve(arm: &mut Arm, target: &Vec3, angle: f64, out: &mut ReachLinks) -> bool {
        arm.arms.solve_reach(SIDE, target, angle, out)
    }

    fn unit(x: f64, y: f64, z: f64) -> Vec3 {
        let mut v = Vec3::new(x, y, z);
        v.normalize();
        v
    }

    fn sub(a: &Vec3, b: &Vec3) -> Vec3 {
        let mut v = *a;
        v.sub(b);
        v
    }

    #[test]
    fn puts_the_wrist_on_a_target_inside_the_annulus() {
        let mut arm = build_arm();
        let mut out = ReachLinks::default();
        // Forward, down and slightly inboard of the shoulder: comfortably between
        // the near and far bounds on either arm.
        let target = offset(&arm, -0.05, -0.05, -0.2);
        assert!(solve(&mut arm, &target, 0.0, &mut out));
        assert!(wrist_of(&arm, &out).distance_to(&target) < EXACT);
    }

    #[test]
    fn holds_the_wrist_on_target_across_the_whole_reachable_range_of_distances() {
        let mut arm = build_arm();
        let mut out = ReachLinks::default();
        let bearing = unit(-0.3, -0.7, -0.6);
        for distance in [0.1, 0.15, 0.2, 0.25, 0.3, 0.315] {
            let target = along(&arm, &bearing, distance);
            assert!(solve(&mut arm, &target, 0.4, &mut out));
            assert!(
                wrist_of(&arm, &out).distance_to(&target) < EXACT,
                "{distance}"
            );
        }
    }

    #[test]
    fn returns_unit_directions_for_both_links() {
        let mut arm = build_arm();
        let mut out = ReachLinks::default();
        let target = offset(&arm, -0.05, -0.1, -0.18);
        for angle in [-2.2, -0.7, 0.0, 0.9, 2.8] {
            solve(&mut arm, &target, angle, &mut out);
            close(out.upper_arm.length(), 1.0, 12);
            close(out.lower_arm.length(), 1.0, 12);
            assert!((out.upper_arm.length() - 1.0).abs() < UNIT);
            assert!((out.lower_arm.length() - 1.0).abs() < UNIT);
        }
    }

    #[test]
    fn points_at_a_target_beyond_its_reach_and_falls_short_rather_than_failing() {
        let mut arm = build_arm();
        let mut out = ReachLinks::default();
        let bearing = unit(0.0, -0.2, -1.0);
        let target = along(&arm, &bearing, 1.0);
        assert!(solve(&mut arm, &target, 0.0, &mut out));
        let wrist = wrist_of(&arm, &out);
        let span = arm.upper_len + arm.fore_len;
        // Inside the annulus it was clamped into...
        assert!(wrist.distance_to(&arm.shoulder) <= span);
        // ...but as far out along it as the arm goes.
        assert!(wrist.distance_to(&arm.shoulder) > span * 0.99);
        // Still aimed at what it could not touch.
        assert!(sub(&wrist, &arm.shoulder).angle_to(&bearing) < 0.05);
        assert!(wrist.distance_to(&target) > 0.5);
    }

    #[test]
    fn bounds_the_near_side_by_the_elbow_flexion_limit_and_not_by_the_length_difference() {
        let mut arm = build_arm();
        let mut out = ReachLinks::default();
        let bearing = Vec3::new(0.0, 0.0, -1.0);
        // 0.03 is outside the geometric near bound |La - Lf| = 0.02, so a solver
        // clamping on the figure alone would grant this target exactly. The elbow's
        // 150 degree stop puts the real near bound at roughly 0.085, so it must not
        // be granted.
        let geometric = (arm.upper_len - arm.fore_len).abs();
        let target = along(&arm, &bearing, 0.03);
        assert!(0.03 > geometric);
        assert!(solve(&mut arm, &target, 0.0, &mut out));
        assert!(wrist_of(&arm, &out).distance_to(&target) > 1e-3);
    }

    // The contract the source states: a target nearer than 150 degrees of flexion
    // allows stops short along the same bearing, so the joint clamp downstream
    // never has to take back what the solver granted.
    //
    // This holds only because the forearm closes onto the *clamped* point. Aiming
    // it at the raw request instead leaves the upper arm stopping short while the
    // forearm does not, which folds the elbow back past the bound the clamp above
    // has just established.
    #[test]
    fn keeps_a_very_near_target_inside_the_elbow_flexion_stop() {
        let mut arm = build_arm();
        let mut out = ReachLinks::default();
        let target = offset(&arm, 0.0, 0.0, -0.03);
        solve(&mut arm, &target, 0.0, &mut out);
        assert!(elbow_flexion(&out) <= JointTable::human().elbow.flexion.max[1]);
    }

    // The other half of the same contract: stopping short happens *along the same
    // bearing*, so the hand reads as an arm that cannot quite reach rather than as
    // one that has swung off to the side.
    #[test]
    fn stops_a_very_near_target_short_along_the_same_bearing() {
        let mut arm = build_arm();
        let mut out = ReachLinks::default();
        let bearing = Vec3::new(0.0, 0.0, -1.0);
        let target = along(&arm, &bearing, 0.03);
        solve(&mut arm, &target, 0.0, &mut out);
        let wrist = wrist_of(&arm, &out);
        assert!(sub(&wrist, &arm.shoulder).angle_to(&bearing) < 0.02);
        assert!(wrist.distance_to(&arm.shoulder) > 0.03);
    }

    #[test]
    fn grants_a_target_sitting_exactly_on_the_flexion_derived_near_bound() {
        let mut arm = build_arm();
        let mut out = ReachLinks::default();
        let flex_max = JointTable::human().elbow.flexion.max[1];
        let fold = cos(PI - flex_max);
        let (la, lf) = (arm.upper_len, arm.fore_len);
        let near = sqrt(la * la + lf * lf - 2.0 * la * lf * fold) * 1.001;
        let target = offset(&arm, 0.0, 0.0, -near);
        solve(&mut arm, &target, 0.0, &mut out);
        assert!(wrist_of(&arm, &out).distance_to(&target) < 1e-4);
        assert!(elbow_flexion(&out) <= flex_max);
    }

    #[test]
    fn moves_the_elbow_around_the_reach_line_while_the_wrist_stays_put() {
        let mut arm = build_arm();
        let mut out = ReachLinks::default();
        let target = offset(&arm, -0.06, -0.08, -0.19);
        let mut elbows = Vec::new();
        for angle in [-2.5, -1.2, 0.0, 1.2, 2.5] {
            assert!(solve(&mut arm, &target, angle, &mut out));
            assert!(wrist_of(&arm, &out).distance_to(&target) < EXACT);
            elbows.push(elbow_of(&arm, &out));
        }
        // Every elbow sits on one circle about the shoulder, at a distinct place on it.
        for elbow in &elbows {
            close(elbow.distance_to(&arm.shoulder), arm.upper_len, 9);
        }
        for i in 0..elbows.len() {
            for j in i + 1..elbows.len() {
                assert!(elbows[i].distance_to(&elbows[j]) > 0.01);
            }
        }
    }

    #[test]
    fn refuses_a_target_sitting_on_the_shoulder_itself() {
        let mut arm = build_arm();
        let target = arm.shoulder;
        assert!(!solve(&mut arm, &target, 0.0, &mut ReachLinks::default()));
    }

    #[test]
    fn refuses_an_arm_the_profile_has_no_segment_lengths_for() {
        let mut arm = build_arm();
        arm.arms.profile.limb[SIDE as usize].upper = Some(0.0);
        let target = offset(&arm, 0.0, -0.1, -0.2);
        assert!(!solve(&mut arm, &target, 0.0, &mut ReachLinks::default()));
    }

    fn reference(arm: &mut Arm, n: &Vec3) -> Vec3 {
        let mut perp = Vec3::default();
        reach_ref(&mut arm.arms.graph, &mut arm.arms.anat, n, &mut perp, None);
        perp
    }

    #[test]
    fn reach_ref_returns_a_unit_reference_perpendicular_to_the_reach_line() {
        let mut arm = build_arm();
        for n in [
            Vec3::new(0.0, -1.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            unit(-0.4, -0.6, -0.7),
        ] {
            let perp = reference(&mut arm, &n);
            assert!((perp.length() - 1.0).abs() < UNIT);
            assert!(perp.dot(&n).abs() < UNIT);
        }
    }

    #[test]
    fn reach_ref_falls_back_off_forward_when_the_reach_itself_runs_forward() {
        let mut arm = build_arm();
        let (fwd, up) = (*arm.arms.anat.fwd(), *arm.arms.anat.up());
        // Away from forward, forward is the reference.
        let mut down = up;
        down.negate();
        assert!(reference(&mut arm, &down).dot(&fwd) > 0.99);
        // Along it, forward says nothing, so up takes over — and is still perpendicular.
        let perp = reference(&mut arm, &fwd);
        assert!(perp.dot(&fwd).abs() < UNIT);
        assert!(perp.dot(&up).abs() > 0.99);
    }

    fn pole(arm: &mut Arm, target: &Vec3, pole: &Vec3) -> Option<f64> {
        let Arms {
            profile,
            graph,
            anat,
            ..
        } = &mut arm.arms;
        pole_angle(profile, graph, anat, SIDE, target, pole)
    }

    #[test]
    fn pole_angle_round_trips_so_solving_with_the_angle_puts_the_elbow_on_the_pole_side() {
        let mut arm = build_arm();
        let mut out = ReachLinks::default();
        let target = offset(&arm, -0.05, -0.05, -0.2);
        let mut reach = sub(&target, &arm.shoulder);
        reach.normalize();
        // Poles all round the reach line, each well off it.
        for (x, y, z) in [
            (0.3, -0.3, 0.0),
            (-0.25, -0.2, 0.1),
            (0.1, 0.3, 0.05),
            (0.0, -0.35, -0.05),
        ] {
            let p = offset(&arm, x, y, z);
            let angle = pole(&mut arm, &target, &p).expect("a pole off the line");
            assert!(solve(&mut arm, &target, angle, &mut out));
            let from_line = |q: &Vec3| {
                let mut v = sub(q, &arm.shoulder);
                let d = -v.dot(&reach);
                v.add_scaled_vector(&reach, d).normalize();
                v
            };
            // Same side of the reach line, and in fact the same bearing about it.
            assert!(from_line(&elbow_of(&arm, &out)).dot(&from_line(&p)) > 1.0 - EXACT);
            // The wrist is unaffected by where the pole put the elbow.
            assert!(wrist_of(&arm, &out).distance_to(&target) < EXACT);
        }
    }

    #[test]
    fn pole_angle_returns_none_for_a_pole_sitting_on_the_reach_line() {
        let mut arm = build_arm();
        let target = offset(&arm, -0.05, -0.05, -0.2);
        let mut reach = sub(&target, &arm.shoulder);
        reach.normalize();
        let p = along(&arm, &reach, 0.2);
        assert_eq!(pole(&mut arm, &target, &p), None);
    }

    fn sideways(reach: &Vec3) -> Vec3 {
        let mut side = Vec3::new(0.0, 1.0, 0.0);
        let d = -side.dot(reach);
        side.add_scaled_vector(reach, d).normalize();
        side
    }

    #[test]
    fn pole_angle_returns_none_for_a_near_parallel_pole_whose_residue_is_still_long() {
        let mut arm = build_arm();
        let target = offset(&arm, -0.05, -0.05, -0.2);
        let mut reach = sub(&target, &arm.shoulder);
        reach.normalize();
        let side = sideways(&reach);
        // A metre down the reach line and 0.1 off it: the residue is 0.1 long, which
        // is three times the whole arm and would pass any bare length test, but the
        // sine of the angle is 0.0995 and the direction it implies is noise.
        let mut p = along(&arm, &reach, 1.0);
        p.add_scaled_vector(&side, 0.1);
        let mut residue = sub(&p, &arm.shoulder);
        let d = -residue.dot(&reach);
        residue.add_scaled_vector(&reach, d);
        assert!(residue.length() > arm.upper_len / 2.0);
        assert_eq!(pole(&mut arm, &target, &p), None);
    }

    #[test]
    fn pole_angle_accepts_the_same_offset_once_it_is_far_enough_off_the_line() {
        let mut arm = build_arm();
        let target = offset(&arm, -0.05, -0.05, -0.2);
        let mut reach = sub(&target, &arm.shoulder);
        reach.normalize();
        let side = sideways(&reach);
        // sin 0.25 is the gate; 0.5 off a 1.0 run is a sine of 0.447.
        let mut p = along(&arm, &reach, 1.0);
        p.add_scaled_vector(&side, 0.5);
        assert!(pole(&mut arm, &target, &p).is_some());
    }

    #[test]
    fn pole_angle_returns_none_for_a_pole_sitting_on_the_shoulder() {
        let mut arm = build_arm();
        let target = offset(&arm, -0.05, -0.05, -0.2);
        let p = arm.shoulder;
        assert_eq!(pole(&mut arm, &target, &p), None);
    }

    #[test]
    fn pole_angle_does_not_share_scratch_with_the_solve_it_feeds() {
        let mut arm = build_arm();
        let target = offset(&arm, -0.05, -0.05, -0.2);
        let p = offset(&arm, 0.3, -0.3, 0.0);
        let mut out = ReachLinks::default();
        let first = pole(&mut arm, &target, &p).unwrap();
        solve(&mut arm, &target, first, &mut out);
        let again = pole(&mut arm, &target, &p).unwrap();
        assert!((again - first).abs() < STABLE);
    }
}
