//! `rig/legs.ts`: the grounded lower-body pass.
//!
//! `profile.root` is node 0 of the graph. Bones are graph nodes; a node read as
//! `bone.matrixWorld` in the TS reads the current value here too, without an update.

use super::skeleton::SkeletonRefresh;
use crate::math::f::{expm1, js_max, js_min, sqrt};
use crate::math::{Mat3, Mat4, Quat, Vec3};
use crate::profile::{BoneSlot, Profile, Side};
use crate::scene::graph::Graph;

const ROOT: u32 = 0;

/// The two sides are kept explicit so a one-sided rig can never look grounded.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct LegState {
    pub(crate) upper: u32,
    pub(crate) lower: u32,
    pub(crate) foot: u32,
    pub(crate) toe: Option<u32>,
    pub(crate) upper_length: f64,
    pub(crate) lower_length: f64,
    pub(crate) soft_zone: f64,
    pub(crate) upper_rest_q: Quat,
    pub(crate) lower_rest_q: Quat,
    /// Full root-relative rest matrix, retaining affine scale/shear context.
    pub(crate) foot_rest_root_matrix: Mat4,
    pub(crate) toe_rest_q: Option<Quat>,
    /// Solved foot rotation in the metric frame, settled before any bone is written.
    pub(crate) foot_target_q: Quat,
    pub(crate) upper_rest_dir: Vec3,
    pub(crate) lower_rest_dir: Vec3,
    /// Foot origin in profile-root coordinates; this is the ground anchor.
    pub(crate) anchor_root: Vec3,
    /// Rest knee direction projected off the hip-to-ankle line.
    pub(crate) knee_pole: Vec3,
    /// `kneePole` carried through this frame's turn.
    pub(crate) knee_pole_now: Vec3,
    /// Scratch for the solved frame.
    pub(crate) target_metric: Vec3,
    pub(crate) hip_metric: Vec3,
    pub(crate) hip_after: Vec3,
    pub(crate) knee_metric: Vec3,
    pub(crate) reach_axis: Vec3,
    pub(crate) upper_target: Vec3,
    pub(crate) lower_target: Vec3,
    pub(crate) pole: Vec3,
    pub(crate) interval: ReachInterval,
    pub(crate) solution: KneeSolution,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct ReachInterval {
    pub(crate) lower: f64,
    pub(crate) upper: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct KneeSolution {
    pub(crate) hip: Vec3,
    pub(crate) target: Vec3,
    pub(crate) knee: Vec3,
    pub(crate) upper_dir: Vec3,
    pub(crate) lower_dir: Vec3,
}

/// The upper leg, lower leg, foot and toe slots of one side.
const fn leg_slots(side: Side) -> [BoneSlot; 4] {
    match side {
        Side::L => [
            BoneSlot::UpperLegL,
            BoneSlot::LowerLegL,
            BoneSlot::FootL,
            BoneSlot::ToeL,
        ],
        Side::R => [
            BoneSlot::UpperLegR,
            BoneSlot::LowerLegR,
            BoneSlot::FootR,
            BoneSlot::ToeR,
        ],
    }
}

/// The grounded lower-body pass.
///
/// A leg is optional data. Profiles that do not resolve a complete pair keep
/// their authored lower-body pose, while a complete standing humanoid gets
/// a two-link solve that keeps both ankle anchors on the floor. The solver
/// works in the local frame of `hips.parent`: applying the inverse frame matrix
/// removes the armature's translation, rotation and authored scale before any
/// length or direction is compared.
///
/// The standing classifier is deliberately a geometry policy, not a medical
/// range-of-motion claim. It requires a nearly extended hip-to-ankle span, a
/// mostly vertical descent, and level ankles. A seated, quadruped, or partial
/// profile therefore opts out without changing the pose authored by the caller.
///
/// The TS instance holds the profile; the port borrows it per call.
#[derive(Clone, Debug, PartialEq)]
pub struct GroundedLegs {
    root: u32,
    metric: u32,
    hips: u32,
    pub(crate) legs: [LegState; 2],

    metric_inverse: Mat4,
    metric_inverse_linear: Mat3,
    root_metric_frame: Mat4,
    turn_matrix: Mat4,
    turn_linear: Mat3,
    metric_up: Vec3,
}

impl GroundedLegs {
    /// Geometry-only safeguards. These are not pose tuning values.
    pub const EPS: f64 = 1e-9;
    pub const STANDING_RATIO: f64 = 0.9;
    pub const STANDING_DESCENT: f64 = 0.8;
    pub const ANKLE_LEVEL: f64 = 0.05;
    /// 0.45 m bones: hard lock drops 5° in the first 1 mm; a full 1% zone gives
    /// about 0.9°/mm. Capped at captured rest slack; needs a render check.
    pub const SOFT_REACH: f64 = 0.01;
    /// A few Float32 ULPs from GLB export are still an authored uniform scale.
    pub const SCALE_ISOTROPY_EPS: f64 = 1e-6;

    const WORLD_UP: Vec3 = Vec3::new(0.0, 1.0, 0.0);

    // legs.ts GroundedLegs.create
    //
    // Build a grounded solver when the profile describes a human standing pair.
    //
    // `restOf` is supplied by `Rig`, which owns the complete rest-quaternion
    // table. Keeping that callback at this boundary means the leg pass does not
    // need to know how the rest pose was captured.
    //
    // The TS captures every side's knee into one `kneeMetric` vector declared outside the loop,
    // and a side whose rest pole is long enough keeps that vector itself as its `kneePole`; so
    // such a side ends up holding the value the last side left in it. The port keeps that.
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    pub fn create(
        profile: &Profile,
        graph: &mut Graph,
        rest_of: &dyn Fn(u32) -> Quat,
    ) -> Option<GroundedLegs> {
        // A stated anatomy table means the avatar is deliberately outside the
        // engine's human assumptions. `profile.anatomy` is also checked because a
        // caller may attach the override after profile construction in a test or
        // in a custom loader.
        //
        // The numeric profile carries the avatar's override and a later one in the same field.
        if profile.anatomy.is_some() {
            return None;
        }

        let hips = profile.bone(BoneSlot::Hips)?;
        let metric = graph.parent_of(hips)?;

        graph.update_matrix_world(ROOT, true);
        graph.update_world_matrix(metric, true, false, false);

        let root = ROOT;
        let mut metric_inverse = graph.current_matrix_world(metric);
        metric_inverse.invert();
        let mut root_inverse = graph.current_matrix_world(root);
        root_inverse.invert();

        let mut built: [Option<LegState>; 2] = [None, None];
        let mut world_foot_l = Vec3::default();
        let mut world_foot_r = Vec3::default();
        // The one `kneeMetric` of the TS, and which sides hold it as their pole.
        let mut knee_metric = Vec3::default();
        let mut holds_knee_metric = [false; 2];

        for side in Side::BOTH {
            let [upper, lower, foot, toe] = leg_slots(side).map(|slot| profile.bone(slot));
            // The toe is an orientation follower only. A missing toe is valid; any
            // missing core link disables the whole pair rather than grounding one
            // side and leaving the other to drift.
            let (Some(upper), Some(lower), Some(foot)) = (upper, lower, foot) else {
                return None;
            };
            // The metric direction is the translation to the direct child. A name
            // match through a twist/helper branch is not enough to aim safely, so a
            // core chain with an interposed or disjoint bone opts out.
            if graph.parent_of(upper) != Some(hips)
                || graph.parent_of(lower) != Some(upper)
                || graph.parent_of(foot) != Some(lower)
            {
                return None;
            }
            // Root scale is removed by the metric frame, but an anisotropic scale on
            // a controlled bone changes a child offset as that bone rotates. The
            // two-link geometry cannot represent that affine segment, so opt out
            // rather than silently slipping the foot.
            if ![hips, upper, lower, foot]
                .iter()
                .all(|&value| uniform_scale(&graph.local_scale(value)))
            {
                return None;
            }
            // A non-direct optional toe is ignored: it cannot be given the promised
            // rest-local orientation without also solving the intervening chain.
            let supported_toe = toe.filter(|&t| graph.parent_of(t) == Some(foot));

            graph.update_world_matrix(upper, true, false, false);
            graph.update_world_matrix(lower, true, false, false);
            graph.update_world_matrix(foot, true, false, false);
            if let Some(t) = supported_toe {
                graph.update_world_matrix(t, true, false, false);
            }

            let mut upper_rest_dir = graph.local_position(lower);
            let mut lower_rest_dir = graph.local_position(foot);
            let upper_dir_length = upper_rest_dir.length();
            let lower_dir_length = lower_rest_dir.length();
            if !(upper_dir_length > Self::EPS && lower_dir_length > Self::EPS) {
                return None;
            }
            upper_rest_dir.multiply_scalar(1.0 / upper_dir_length);
            lower_rest_dir.multiply_scalar(1.0 / lower_dir_length);

            let normalized = |b: u32| {
                let mut q = rest_of(b);
                q.normalize();
                q
            };
            let upper_rest_q = normalized(upper);
            let lower_rest_q = normalized(lower);
            let foot_rest_q = normalized(foot);
            let toe_rest_q = supported_toe.map(normalized);
            if !(valid_quaternion(&upper_rest_q)
                && valid_quaternion(&lower_rest_q)
                && valid_quaternion(&foot_rest_q))
                || toe_rest_q.is_some_and(|q| !valid_quaternion(&q))
            {
                return None;
            }

            let mut upper_metric = graph.world_position(upper);
            upper_metric.apply_matrix4(&metric_inverse);
            let mut lower_metric = graph.world_position(lower);
            lower_metric.apply_matrix4(&metric_inverse);
            let mut foot_metric_at_rest = graph.world_position(foot);
            foot_metric_at_rest.apply_matrix4(&metric_inverse);
            let upper_length = upper_metric.distance_to(&lower_metric);
            let lower_length = lower_metric.distance_to(&foot_metric_at_rest);
            if !(upper_length.is_finite()
                && lower_length.is_finite()
                && upper_length > Self::EPS
                && lower_length > Self::EPS)
            {
                return None;
            }

            graph.world_position(hips);
            let world_foot = graph.world_position(foot);
            if side == Side::L {
                world_foot_l = world_foot;
            } else {
                world_foot_r = world_foot;
            }

            let mut hip_metric = graph.world_position(upper);
            hip_metric.apply_matrix4(&metric_inverse);
            knee_metric = graph.world_position(lower);
            knee_metric.apply_matrix4(&metric_inverse);
            let mut foot_metric = graph.world_position(foot);
            foot_metric.apply_matrix4(&metric_inverse);
            let mut rest_reach = foot_metric;
            rest_reach.sub(&hip_metric);
            let rest_reach_sq = rest_reach.length_sq();
            if !(rest_reach_sq > Self::EPS) {
                return None;
            }
            // `restKnee` and `restPole` are `kneeMetric` itself in the TS.
            knee_metric.sub(&hip_metric);
            let along = -knee_metric.dot(&rest_reach) / rest_reach_sq;
            knee_metric.add_scaled_vector(&rest_reach, along);
            let rest_pole_scale =
                Self::EPS * js_max(js_max(1.0, rest_reach_sq), knee_metric.length_sq());
            if knee_metric.length_sq() > rest_pole_scale {
                knee_metric.normalize();
            } else {
                knee_metric.set(0.0, 0.0, 0.0);
            }

            // Root-relative orientation is captured through the root inverse. A
            // world quaternion would include an armature scale and can decompose to
            // a different rotation when that scale is non-uniform.
            let mut foot_root_matrix = root_inverse;
            foot_root_matrix.multiply(&graph.current_matrix_world(foot));
            let mut foot_root_q = Quat::default();
            foot_root_matrix.decompose(
                &mut Vec3::default(),
                &mut foot_root_q,
                &mut Vec3::default(),
            );
            foot_root_q.normalize();
            if !valid_quaternion(&foot_root_q) {
                return None;
            }

            let mut anchor_root = graph.world_position(foot);
            anchor_root.apply_matrix4(&root_inverse);
            holds_knee_metric[side as usize] = knee_metric.length_sq() > Self::EPS;
            let mut state = LegState {
                upper,
                lower,
                foot,
                toe: supported_toe,
                upper_length,
                lower_length,
                soft_zone: js_min(
                    Self::SOFT_REACH * (upper_length + lower_length),
                    js_max(0.0, upper_length + lower_length - sqrt(rest_reach_sq)),
                ),
                upper_rest_q,
                lower_rest_q,
                foot_rest_root_matrix: foot_root_matrix,
                toe_rest_q,
                foot_target_q: Quat::default(),
                upper_rest_dir,
                lower_rest_dir,
                anchor_root,
                knee_pole: if holds_knee_metric[side as usize] {
                    knee_metric
                } else {
                    Vec3::default()
                },
                knee_pole_now: Vec3::default(),
                target_metric: Vec3::default(),
                hip_metric: Vec3::default(),
                hip_after: Vec3::default(),
                knee_metric: Vec3::default(),
                reach_axis: Vec3::default(),
                upper_target: Vec3::default(),
                lower_target: Vec3::default(),
                pole: Vec3::default(),
                interval: ReachInterval::default(),
                solution: KneeSolution::default(),
            };

            // A straight rest leg has no authored bend direction. Capture a stable
            // anatomical-forward fallback once, so the sign cannot alternate as a
            // moving target crosses the forward plane.
            if state.knee_pole.length_sq() <= Self::EPS {
                let mut body_forward = Vec3::default();
                anatomical_forward(profile, graph, &metric_inverse, &mut body_forward);
                project_pole(&body_forward, &rest_reach, &mut state.knee_pole);
                if state.knee_pole.length_sq() <= Self::EPS {
                    return None;
                }
            }

            built[side as usize] = Some(state);
        }

        let (Some(mut left), Some(mut right)) = (built[0], built[1]) else {
            return None;
        };
        for (state, holds) in [
            (&mut left, holds_knee_metric[0]),
            (&mut right, holds_knee_metric[1]),
        ] {
            if holds {
                state.knee_pole = knee_metric;
            }
        }

        let world_hip = graph.world_position(hips);
        // Standing classification is intentionally expressed in world geometry.
        // The solver lengths above are metric-frame units (which may be centimetres
        // under a 0.01 armature scale), while this policy compares the visible
        // hip-to-ankle span with the visible thigh and shin spans.
        let world_upper_l = graph.world_position(left.upper);
        let world_knee_l = graph.world_position(left.lower);
        let world_upper_r = graph.world_position(right.upper);
        let world_knee_r = graph.world_position(right.lower);
        let total_l =
            world_upper_l.distance_to(&world_knee_l) + world_knee_l.distance_to(&world_foot_l);
        let total_r =
            world_upper_r.distance_to(&world_knee_r) + world_knee_r.distance_to(&world_foot_r);
        let ratio_l = world_hip.distance_to(&world_foot_l) / total_l;
        let ratio_r = world_hip.distance_to(&world_foot_r) / total_r;
        let descent_l = (world_hip.y - world_foot_l.y) / total_l;
        let descent_r = (world_hip.y - world_foot_r.y) / total_r;
        let standing_l = ratio_l >= Self::STANDING_RATIO && descent_l >= Self::STANDING_DESCENT;
        let standing_r = ratio_r >= Self::STANDING_RATIO && descent_r >= Self::STANDING_DESCENT;
        let mean_length = (total_l + total_r) * 0.5;
        let ankle_height = (world_foot_l.y - world_foot_r.y).abs();
        if !(standing_l && standing_r) || ankle_height > Self::ANKLE_LEVEL * mean_length {
            return None;
        }

        Some(GroundedLegs {
            root,
            metric,
            hips,
            legs: [left, right],
            metric_inverse: Mat4::default(),
            metric_inverse_linear: Mat3::default(),
            root_metric_frame: Mat4::default(),
            turn_matrix: Mat4::default(),
            turn_linear: Mat3::default(),
            metric_up: Vec3::default(),
        })
    }

    // legs.ts GroundedLegs.stancePivot
    //
    // The point on the floor a turning body pivots about: the midpoint of the two
    // rest ankle anchors, in world space.
    pub fn stance_pivot(&self, graph: &mut Graph) -> Vec3 {
        graph.update_world_matrix(self.root, true, false, false);
        let mut out = self.legs[0].anchor_root;
        out.add(&self.legs[1].anchor_root).multiply_scalar(0.5);
        out.apply_matrix4(&graph.current_matrix_world(self.root));
        out
    }

    // legs.ts GroundedLegs.apply
    //
    // Keep the rest ankle anchors fixed on the floor, or lift them by `rise`
    // while a hop is airborne. A failed common reach leaves every bone as the
    // caller posed it for this frame; slipping one foot to make the other reach
    // would be much more visible than retaining the authored pose.
    //
    // A non-zero `turn` (radians about world up) rotates the anchors, the knee
    // poles and the foot orientations about the stance centre first, so the solve
    // that follows is the rest configuration turned and nothing else.
    //
    // A `skeleton` refreshes in place of the whole scene, for a caller that knows
    // nothing but bones has moved since the scene's last full pass.
    pub fn apply(
        &mut self,
        profile: &Profile,
        graph: &mut Graph,
        rise: f64,
        turn: f64,
        skeleton: Option<&SkeletonRefresh>,
    ) -> bool {
        // Unconditional and first: `Rig.applyBodyContext` relies on this pass, plus
        // each write below refreshing its own subtree, to leave the scene fresh.
        match skeleton {
            Some(skeleton) => skeleton.run(graph),
            None => graph.update_matrix_world(self.root, true),
        }
        graph.update_world_matrix(self.metric, true, false, false);
        let metric_world = graph.current_matrix_world(self.metric);
        self.metric_inverse.copy(&metric_world).invert();
        self.metric_inverse_linear
            .set_from_matrix4(&self.metric_inverse);
        self.metric_up
            .copy(&Self::WORLD_UP)
            .apply_matrix3(&self.metric_inverse_linear);
        if self.metric_up.length_sq() <= Self::EPS {
            return false;
        }

        let lift = if rise.is_finite() {
            js_max(0.0, rise)
        } else {
            0.0
        };
        let root_world = graph.current_matrix_world(self.root);
        self.root_metric_frame
            .copy(&self.metric_inverse)
            .multiply(&root_world);
        let mut root_metric_q = Quat::default();
        self.root_metric_frame.decompose(
            &mut Vec3::default(),
            &mut root_metric_q,
            &mut Vec3::default(),
        );
        if !valid_quaternion(&root_metric_q) {
            return false;
        }

        let yaw = if turn.is_finite() { turn } else { 0.0 };
        if yaw != 0.0 {
            let turn_pivot = self.stance_pivot(graph);
            let mut turn_scratch = Mat4::default();
            self.turn_matrix
                .make_translation(turn_pivot.x, turn_pivot.y, turn_pivot.z)
                .multiply(turn_scratch.make_rotation_y(yaw));
            self.turn_matrix.multiply(turn_scratch.make_translation(
                -turn_pivot.x,
                -turn_pivot.y,
                -turn_pivot.z,
            ));
            // Metric -> world -> turned -> metric, for the rest knee directions.
            let mut turn_to_pole = self.metric_inverse;
            turn_to_pole
                .multiply(&self.turn_matrix)
                .multiply(&graph.current_matrix_world(self.metric));
            self.turn_linear.set_from_matrix4(&turn_to_pole);
        }
        for state in &mut self.legs {
            state.knee_pole_now = state.knee_pole;
            if yaw != 0.0 {
                state
                    .knee_pole_now
                    .apply_matrix3(&self.turn_linear)
                    .normalize();
            }
        }

        // Root-relative anchors follow the root's current placement. The lift is
        // stated in world metres, then converted to metric coordinates below.
        for s in 0..2 {
            let root_world = graph.current_matrix_world(self.root);
            let state = &mut self.legs[s];
            let mut root_anchor_world = state.anchor_root;
            root_anchor_world.apply_matrix4(&root_world);
            if yaw != 0.0 {
                root_anchor_world.apply_matrix4(&self.turn_matrix);
            }
            root_anchor_world.y += lift;
            state.target_metric = root_anchor_world;
            state.target_metric.apply_matrix4(&self.metric_inverse);
            let upper = state.upper;
            let mut hip_metric = graph.world_position(upper);
            hip_metric.apply_matrix4(&self.metric_inverse);
            self.legs[s].hip_metric = hip_metric;
        }
        // The same downward pelvis correction has to satisfy both legs. Solve the
        // outer-reach intervals first, intersect them, and only then touch hips.
        if !(self.reach_interval(0) && self.reach_interval(1)) {
            return false;
        }
        let lower = js_max(
            js_max(0.0, self.legs[0].interval.lower),
            self.legs[1].interval.lower,
        );
        let upper = js_min(self.legs[0].interval.upper, self.legs[1].interval.upper);
        if !(lower.is_finite() && upper.is_finite()) || lower > upper + Self::EPS {
            return false;
        }

        let delta = lower;
        if !(self.knee_solution(profile, graph, 0, delta)
            && self.knee_solution(profile, graph, 1, delta))
        {
            return false;
        }

        // Preserve the foot's orientation relative to the profile root. Decompose
        // only after composing the full affine chain: multiplying two separately
        // decomposed quaternions loses the interaction between a nested metric
        // frame's non-uniform scale and a tilted foot.
        for s in 0..2 {
            let mut foot_target_metric;
            if yaw != 0.0 {
                foot_target_metric = self.metric_inverse;
                foot_target_metric
                    .multiply(&self.turn_matrix)
                    .multiply(&graph.current_matrix_world(self.root));
            } else {
                foot_target_metric = self.root_metric_frame;
            }
            let state = &mut self.legs[s];
            foot_target_metric.multiply(&state.foot_rest_root_matrix);
            foot_target_metric.decompose(
                &mut Vec3::default(),
                &mut state.foot_target_q,
                &mut Vec3::default(),
            );
            if !valid_quaternion(&state.foot_target_q) {
                return false;
            }
        }

        // Everything above this point is validation and geometry. Apply the one
        // common translation, then aim parent-first so every child reads the new
        // parent matrix rather than a stale one.
        if delta > Self::EPS {
            let mut hips = graph.local_position(self.hips);
            hips.add_scaled_vector(&self.metric_up, -delta);
            graph.set_local_position(self.hips, &hips);
            graph.update_world_matrix(self.hips, false, true, false);
        }

        for s in 0..2 {
            let state = self.legs[s];
            let solution = state.solution;
            self.aim_bone(
                graph,
                state.upper,
                &state.upper_rest_q,
                &state.upper_rest_dir,
                &solution.upper_dir,
            );
            graph.update_world_matrix(state.upper, false, true, false);

            self.aim_bone(
                graph,
                state.lower,
                &state.lower_rest_q,
                &state.lower_rest_dir,
                &solution.lower_dir,
            );
            graph.update_world_matrix(state.lower, false, true, false);

            // The optional toe retains its local rest rotation and therefore follows
            // the foot without acquiring an extra aim.
            let mut parent_inverse_q = self.parent_metric_quaternion(graph, state.foot);
            parent_inverse_q.invert();
            let mut foot_q = parent_inverse_q;
            foot_q.multiply(&state.foot_target_q).normalize();
            graph.set_local_quaternion(state.foot, &foot_q);
            graph.update_world_matrix(state.foot, false, true, false);
            if let (Some(toe), Some(toe_rest_q)) = (state.toe, state.toe_rest_q) {
                graph.set_local_quaternion(toe, &toe_rest_q);
                graph.update_world_matrix(toe, false, true, false);
            }
        }
        true
    }

    // legs.ts GroundedLegs.reachInterval
    //
    // Solve the outer reach interval for one leg under a downward world shift.
    fn reach_interval(&mut self, s: usize) -> bool {
        let state = &mut self.legs[s];
        let mut interval_v = state.hip_metric;
        interval_v.sub(&state.target_metric);
        let a = self.metric_up.length_sq();
        let b = interval_v.dot(&self.metric_up);
        let reach = state.upper_length + state.lower_length;
        let c = interval_v.length_sq() - reach * reach;
        let discriminant = b * b - a * c;
        let scale = js_max(js_max(1.0, b * b), (a * c).abs());
        if discriminant < -Self::EPS * scale {
            return false;
        }
        let root = sqrt(js_max(0.0, discriminant));
        let one = (b - root) / a;
        let two = (b + root) / a;
        let mut lower = js_max(0.0, js_min(one, two));
        let upper = js_max(one, two);
        // Settle the pelvis onto soft reach without moving either ankle anchor.
        // Captured rest slack caps the zone so the authored pose stays a fixed point.
        let distance = sqrt(interval_v.length_sq());
        let soft = soft_reach(
            distance,
            state.upper_length + state.lower_length,
            state.soft_zone,
        );
        if soft < distance {
            let soft_c = interval_v.length_sq() - soft * soft;
            let soft_root = sqrt(js_max(0.0, b * b - a * soft_c));
            lower = js_max(lower, (b - soft_root) / a);
        }
        if !(lower.is_finite() && upper.is_finite()) || upper < -Self::EPS {
            return false;
        }
        state.interval.lower = lower;
        state.interval.upper = upper;
        true
    }

    // legs.ts GroundedLegs.kneeSolution
    //
    // Solve a knee after the common pelvis correction has been selected.
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    fn knee_solution(
        &mut self,
        profile: &Profile,
        graph: &mut Graph,
        s: usize,
        delta: f64,
    ) -> bool {
        let metric_up = self.metric_up;
        let mut state = self.legs[s];
        state.hip_after = state.hip_metric;
        state.hip_after.add_scaled_vector(&metric_up, -delta);
        state.reach_axis = state.target_metric;
        state.reach_axis.sub(&state.hip_after);
        let distance = state.reach_axis.length();
        let minimum = (state.upper_length - state.lower_length).abs();
        let maximum = state.upper_length + state.lower_length;
        let tolerance = Self::EPS * js_max(1.0, maximum);
        let ok = 'solve: {
            if !(distance > Self::EPS)
                || distance < minimum - tolerance
                || distance > maximum + tolerance
            {
                break 'solve false;
            }

            state.reach_axis.multiply_scalar(1.0 / distance);
            let along = (state.upper_length * state.upper_length
                - state.lower_length * state.lower_length
                + distance * distance)
                / (2.0 * distance);
            let height_squared = state.upper_length * state.upper_length - along * along;
            if height_squared < -tolerance {
                break 'solve false;
            }
            let height = sqrt(js_max(0.0, height_squared));

            state.pole = state.knee_pole_now;
            let off = -state.pole.dot(&state.reach_axis);
            state.pole.add_scaled_vector(&state.reach_axis, off);
            let mut fallback_pole = Vec3::default();
            if state.pole.length_sq() <= Self::EPS {
                let forward = self.anatomical_forward_direction(profile, graph);
                project_pole(&forward, &state.reach_axis, &mut fallback_pole);
                state.pole = fallback_pole;
            }
            if state.pole.length_sq() <= Self::EPS {
                project_pole(&metric_up, &state.reach_axis, &mut fallback_pole);
                state.pole = fallback_pole;
            }
            if state.pole.length_sq() <= Self::EPS {
                break 'solve false;
            }
            // Keep the selected branch stable even when the fallback projection moves
            // through a near-parallel configuration.
            if state.pole.dot(&state.knee_pole_now) < 0.0 {
                state.pole.negate();
            }
            state.pole.normalize();

            state.knee_metric = state.hip_after;
            state
                .knee_metric
                .add_scaled_vector(&state.reach_axis, along)
                .add_scaled_vector(&state.pole, height);
            state.upper_target = state.knee_metric;
            state.lower_target = state.target_metric;
            state.upper_target.sub(&state.hip_after);
            state.lower_target.sub(&state.knee_metric);
            if state.upper_target.length_sq() <= Self::EPS
                || state.lower_target.length_sq() <= Self::EPS
            {
                break 'solve false;
            }
            state.upper_target.normalize();
            state.lower_target.normalize();
            state.solution.hip = state.hip_after;
            state.solution.target = state.target_metric;
            state.solution.knee = state.knee_metric;
            state.solution.upper_dir = state.upper_target;
            state.solution.lower_dir = state.lower_target;
            true
        };
        self.legs[s] = state;
        ok
    }

    // legs.ts GroundedLegs.anatomicalForwardDirection
    //
    // Read the current anatomical-forward axis without allocating in apply().
    fn anatomical_forward_direction(&self, profile: &Profile, graph: &mut Graph) -> Vec3 {
        let mut out = Vec3::default();
        if let (Some(chest), Some(frame)) = (profile.chest(), profile.body) {
            let mut forward_metric = self.metric_inverse;
            forward_metric.multiply(&graph.current_matrix_world(chest));
            let mut forward_linear = Mat3::default();
            forward_linear.set_from_matrix4(&forward_metric);
            out.copy(&frame.forward).apply_matrix3(&forward_linear);
            if out.length_sq() > Self::EPS {
                out.normalize();
                return out;
            }
        }
        let mut forward_linear = Mat3::default();
        forward_linear.set_from_matrix4(&self.metric_inverse);
        hip_forward(profile, graph, &forward_linear, &mut out);
        out
    }

    // legs.ts GroundedLegs.aimBone
    //
    // Aim one link while retaining its captured local twist/rest frame.
    fn aim_bone(
        &self,
        graph: &mut Graph,
        bone: u32,
        rest_q: &Quat,
        rest_dir: &Vec3,
        target_metric_dir: &Vec3,
    ) {
        let mut parent_inverse_q = self.parent_metric_quaternion(graph, bone);
        parent_inverse_q.invert();
        let mut rest_parent_dir = *rest_dir;
        rest_parent_dir.apply_quaternion(rest_q);
        let mut target_parent_dir = *target_metric_dir;
        target_parent_dir
            .apply_quaternion(&parent_inverse_q)
            .normalize();
        if rest_parent_dir.length_sq() <= Self::EPS {
            return;
        }
        let mut aim_delta_q = Quat::default();
        aim_delta_q.set_from_unit_vectors(rest_parent_dir.normalize(), &target_parent_dir);
        let mut aim_q = aim_delta_q;
        aim_q.multiply(rest_q).normalize();
        graph.set_local_quaternion(bone, &aim_q);
    }

    // legs.ts GroundedLegs.parentMetricQuaternion
    //
    // Pure parent rotation in the metric frame; ancestor scale is discarded.
    fn parent_metric_quaternion(&self, graph: &Graph, bone: u32) -> Quat {
        let mut out = Quat::default();
        let Some(parent) = graph.parent_of(bone) else {
            out.identity();
            return out;
        };
        let mut root_metric = self.metric_inverse;
        root_metric.multiply(&graph.current_matrix_world(parent));
        root_metric.decompose(&mut Vec3::default(), &mut out, &mut Vec3::default());
        out.normalize();
        out
    }
}

// legs.ts validQuaternion
fn valid_quaternion(q: &Quat) -> bool {
    q.x.is_finite() && q.y.is_finite() && q.z.is_finite() && q.w.is_finite()
}

// legs.ts softReach
//
// Identity below the rest-capped join, C1 above it; straight rest uses hard reach.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
fn soft_reach(distance: f64, maximum: f64, zone: f64) -> f64 {
    let start = maximum - zone;
    if !(distance > start && zone > GroundedLegs::EPS) {
        return distance;
    }
    start - zone * expm1(-(distance - start) / zone)
}

// legs.ts uniformScale
fn uniform_scale(scale: &Vec3) -> bool {
    let maximum = js_max(js_max(scale.x.abs(), scale.y.abs()), scale.z.abs());
    maximum.is_finite()
        && maximum > GroundedLegs::EPS
        && (scale.x - scale.y).abs() <= GroundedLegs::SCALE_ISOTROPY_EPS * maximum
        && (scale.x - scale.z).abs() <= GroundedLegs::SCALE_ISOTROPY_EPS * maximum
}

// legs.ts anatomicalForward
//
// Direction of the body's anatomical forward axis in metric coordinates.
fn anatomical_forward(profile: &Profile, graph: &mut Graph, metric_inverse: &Mat4, out: &mut Vec3) {
    if let (Some(chest), Some(frame)) = (profile.chest(), profile.body) {
        let mut chest_metric = *metric_inverse;
        chest_metric.multiply(&graph.current_matrix_world(chest));
        let mut linear = Mat3::default();
        linear.set_from_matrix4(&chest_metric);
        out.copy(&frame.forward).apply_matrix3(&linear);
        if out.length_sq() > GroundedLegs::EPS {
            out.normalize();
            return;
        }
    }
    let mut linear = Mat3::default();
    linear.set_from_matrix4(metric_inverse);
    hip_forward(profile, graph, &linear, out);
}

// legs.ts hipForward
//
// Without a body frame, forward by the same handedness — up cross the
// character's right — with the right taken from the hips. Zero if they coincide.
fn hip_forward(profile: &Profile, graph: &mut Graph, metric_inverse_linear: &Mat3, out: &mut Vec3) {
    let (Some(left), Some(right)) = (
        profile.bone(BoneSlot::UpperLegL),
        profile.bone(BoneSlot::UpperLegR),
    ) else {
        out.set(0.0, 0.0, 0.0);
        return;
    };
    let mut scratch = graph.world_position(right);
    *out = graph.world_position(left);
    scratch.sub(out);
    out.set(0.0, 1.0, 0.0)
        .cross(&scratch)
        .apply_matrix3(metric_inverse_linear);
    if out.length_sq() > GroundedLegs::EPS {
        out.normalize();
    }
}

// legs.ts projectPole
//
// Project a direction onto the plane normal to `reach`, if it has one.
fn project_pole(direction: &Vec3, reach: &Vec3, out: &mut Vec3) {
    out.copy(direction);
    if reach.length_sq() <= GroundedLegs::EPS {
        out.set(0.0, 0.0, 0.0);
        return;
    }
    let reach_length = sqrt(reach.length_sq());
    let along = -out.dot(reach) / (reach_length * reach_length);
    out.add_scaled_vector(reach, along);
    if out.length_sq() <= GroundedLegs::EPS {
        out.set(0.0, 0.0, 0.0);
        return;
    }
    out.normalize();
}

#[cfg(test)]
mod tests {
    //! `tests/rig/{legs,legs-soft,legs-turn}.test.ts`, on the base avatar. Its legs are the
    //! synthetic rig's; the variants the TS builds with options are made here by editing the
    //! graph before the solver is created.
    use super::*;
    use crate::anatomy::joints::JointTable;
    use crate::math::f::acos;
    use crate::math::{Mat4, clamp};
    use crate::rig::Rig;
    use crate::rig::testkit::{
        avatar, bone, centimetre, close, euler, rest_of, rest_table, with_frame_above_hips,
    };
    use crate::scene::graph::NO_NODE;
    use core::f64::consts::PI;

    const CLOSE: f64 = 1e-8;
    const CORE: [BoneSlot; 6] = [
        BoneSlot::UpperLegL,
        BoneSlot::LowerLegL,
        BoneSlot::FootL,
        BoneSlot::UpperLegR,
        BoneSlot::LowerLegR,
        BoneSlot::FootR,
    ];
    const SLOTS: [BoneSlot; 7] = [
        BoneSlot::Hips,
        BoneSlot::UpperLegL,
        BoneSlot::LowerLegL,
        BoneSlot::FootL,
        BoneSlot::UpperLegR,
        BoneSlot::LowerLegR,
        BoneSlot::FootR,
    ];
    const FEET: [BoneSlot; 2] = [BoneSlot::FootL, BoneSlot::FootR];

    fn create(g: &mut Graph, p: &Profile) -> Option<GroundedLegs> {
        let rest = rest_table(g);
        GroundedLegs::create(p, g, &rest_of(&rest))
    }

    struct Setup {
        g: Graph,
        p: Profile,
        solver: GroundedLegs,
    }

    fn setup() -> Setup {
        let (mut g, p) = avatar();
        let solver = create(&mut g, &p).expect("synthetic standing legs were not accepted");
        Setup { g, p, solver }
    }

    fn at(g: &mut Graph, p: &Profile, slot: BoneSlot) -> Vec3 {
        g.world_position(bone(p, slot))
    }

    fn update(g: &mut Graph) {
        g.update_matrix_world(ROOT, true);
    }

    fn nudge(g: &mut Graph, b: u32, x: f64, y: f64, z: f64) {
        let mut v = g.local_position(b);
        v.add(&Vec3::new(x, y, z));
        g.set_local_position(b, &v);
    }

    fn root_relative_q(g: &Graph, value: u32) -> Quat {
        let mut m = g.current_matrix_world(ROOT);
        m.invert().multiply(&g.current_matrix_world(value));
        let mut q = Quat::default();
        m.decompose(&mut Vec3::default(), &mut q, &mut Vec3::default());
        *q.normalize()
    }

    fn knee_angle(g: &mut Graph, p: &Profile, side: Side) -> f64 {
        let [upper, lower, foot, _] = leg_slots(side);
        let hip = at(g, p, upper);
        let knee = at(g, p, lower);
        let ankle = at(g, p, foot);
        let mut a = knee;
        a.sub(&hip).normalize();
        let mut b = ankle;
        b.sub(&knee).normalize();
        acos(clamp(a.dot(&b), -1.0, 1.0))
    }

    fn apply(s: &mut Setup, rise: f64) -> bool {
        s.solver.apply(&s.p, &mut s.g, rise, 0.0, None)
    }

    #[test]
    fn opts_out_when_legs_are_absent_partial_seated_degenerate_or_custom_anatomy() {
        let (mut g, mut p) = avatar();
        for side in Side::BOTH {
            for slot in leg_slots(side) {
                p.bones[slot as usize] = NO_NODE;
            }
        }
        assert!(create(&mut g, &p).is_none(), "no legs");

        let (mut g, mut p) = avatar();
        p.bones[BoneSlot::FootR as usize] = NO_NODE;
        assert!(create(&mut g, &p).is_none(), "partial");

        let (mut g, p) = avatar();
        for side in Side::BOTH {
            let [_, lower, foot, _] = leg_slots(side);
            // Knee forward, shin down: a seated leg keeps a downward ankle but its
            // hip-to-ankle span is too short for the standing classifier.
            g.set_local_position(bone(&p, lower), &Vec3::new(0.0, 0.0, 0.25));
            g.set_local_position(bone(&p, foot), &Vec3::new(0.0, -0.24, 0.0));
        }
        update(&mut g);
        assert!(create(&mut g, &p).is_none(), "seated");

        let (mut g, p) = avatar();
        g.set_local_position(bone(&p, BoneSlot::LowerLegL), &Vec3::default());
        update(&mut g);
        assert!(create(&mut g, &p).is_none(), "degenerate");

        let (mut g, mut p) = avatar();
        p.anatomy = Some(JointTable::human());
        assert!(create(&mut g, &p).is_none(), "custom anatomy");

        let (mut g, p) = avatar();
        assert!(g.local_quaternion(ROOT).equals(&Quat::default()));
        g.set_local_quaternion(ROOT, &euler(0.0, 0.0, PI / 2.0));
        update(&mut g);
        assert!(create(&mut g, &p).is_none(), "lying");

        let (mut g, p) = avatar();
        g.set_local_scale(bone(&p, BoneSlot::LowerLegL), &Vec3::new(1.0, 1.1, 1.0));
        update(&mut g);
        assert!(create(&mut g, &p).is_none(), "anisotropic");

        let (mut g, p) = avatar();
        let ulp = 1.0 - 0.5f64.powi(24);
        g.set_local_scale(bone(&p, BoneSlot::LowerLegL), &Vec3::new(1.0, ulp, ulp));
        update(&mut g);
        let mut solver = create(&mut g, &p).expect("float round-off is still uniform");
        let anchor = at(&mut g, &p, BoneSlot::FootL);
        solver.apply(&p, &mut g, 0.0, 0.0, None);
        assert!(at(&mut g, &p, BoneSlot::FootL).distance_to(&anchor) < 1e-7);

        let (mut g, mut p) = avatar();
        p.bones[BoneSlot::ToeL as usize] = NO_NODE;
        p.bones[BoneSlot::ToeR as usize] = NO_NODE;
        assert!(create(&mut g, &p).is_some(), "no toe");
    }

    #[test]
    fn opts_out_when_a_resolved_core_chain_is_not_a_direct_supported_topology() {
        // The TS interposes a twist bone between the thigh and the shin; a graph cannot gain a
        // node, so the shin slot names a bone whose parent is not the thigh instead.
        let (mut g, mut p) = avatar();
        p.bones[BoneSlot::LowerLegL as usize] = bone(&p, BoneSlot::FootL);
        assert!(create(&mut g, &p).is_none());
    }

    #[test]
    fn keeps_a_quiet_standing_pose_planted_without_accumulating_drift() {
        let mut s = setup();
        let anchors = FEET.map(|f| at(&mut s.g, &s.p, f));
        let knees = [BoneSlot::LowerLegL, BoneSlot::LowerLegR].map(|k| at(&mut s.g, &s.p, k));
        let transforms = CORE.map(|slot| {
            let b = bone(&s.p, slot);
            (s.g.local_position(b), s.g.local_scale(b))
        });
        let toes = [BoneSlot::ToeL, BoneSlot::ToeR].map(|t| s.g.local_quaternion(bone(&s.p, t)));

        apply(&mut s, 0.0);
        apply(&mut s, 0.0);
        update(&mut s.g);

        for i in 0..2 {
            assert!(at(&mut s.g, &s.p, FEET[i]).distance_to(&anchors[i]) < CLOSE);
            let knee = [BoneSlot::LowerLegL, BoneSlot::LowerLegR][i];
            assert!(at(&mut s.g, &s.p, knee).distance_to(&knees[i]) < CLOSE);
        }
        for (slot, (p0, s0)) in CORE.iter().zip(transforms) {
            let b = bone(&s.p, *slot);
            assert_eq!(s.g.local_position(b).distance_to(&p0), 0.0);
            assert_eq!(s.g.local_scale(b).distance_to(&s0), 0.0);
        }
        for (t, q) in [BoneSlot::ToeL, BoneSlot::ToeR].iter().zip(toes) {
            assert_eq!(s.g.local_quaternion(bone(&s.p, *t)).angle_to(&q), 0.0);
        }
    }

    fn straighten(g: &mut Graph, p: &Profile) {
        for side in Side::BOTH {
            let [_, lower, foot, _] = leg_slots(side);
            g.set_local_position(bone(p, lower), &Vec3::new(0.0, -0.25, 0.0));
            g.set_local_position(bone(p, foot), &Vec3::new(0.0, -0.24, 0.0));
        }
        update(g);
    }

    /// `profile.body.forward` through the chest's world rotation.
    fn body_forward(g: &mut Graph, p: &Profile, forward: Vec3) -> Vec3 {
        let chest = bone(p, BoneSlot::Chest);
        let mut f = forward;
        f.apply_quaternion(&g.world_quaternion(chest)).normalize();
        f
    }

    #[test]
    fn uses_a_stable_anatomical_pole_for_an_exactly_straight_rest_leg() {
        let (mut g, p) = avatar();
        straighten(&mut g, &p);
        let mut solver = create(&mut g, &p).expect("straight standing legs were not accepted");

        g.position[0..3].copy_from_slice(&[0.17, -0.11, 0.29]);
        g.set_local_quaternion(ROOT, &euler(0.0, 0.37, 0.0));
        update(&mut g);
        let anchors = FEET.map(|f| at(&mut g, &p, f));
        nudge(&mut g, bone(&p, BoneSlot::Hips), 0.025, -0.04, 0.012);
        update(&mut g);
        solver.apply(&p, &mut g, 0.0, 0.0, None);

        let forward = body_forward(&mut g, &p, p.body.unwrap().forward);
        for side in Side::BOTH {
            let [upper, lower, foot, _] = leg_slots(side);
            let hip = at(&mut g, &p, upper);
            let mut knee = at(&mut g, &p, lower);
            let ankle = at(&mut g, &p, foot);
            assert!(knee.sub(&hip).dot(&forward) > 1e-4);
            assert!(ankle.distance_to(&anchors[side as usize]) < CLOSE);
        }

        let knees = [BoneSlot::LowerLegL, BoneSlot::LowerLegR].map(|k| at(&mut g, &p, k));
        solver.apply(&p, &mut g, 0.0, 0.0, None);
        for (k, knee) in [BoneSlot::LowerLegL, BoneSlot::LowerLegR].iter().zip(knees) {
            assert!(at(&mut g, &p, *k).distance_to(&knee) < CLOSE);
        }
    }

    #[test]
    fn bends_a_straight_rest_leg_forward_from_the_hips_when_the_profile_has_no_body_frame() {
        let (mut g, mut p) = avatar();
        straighten(&mut g, &p);
        // Turned to face root +Z, so no fixed root axis can stand in for forward.
        let hips = bone(&p, BoneSlot::Hips);
        assert!(g.local_quaternion(hips).equals(&Quat::default()));
        g.set_local_quaternion(hips, &euler(0.0, PI, 0.0));
        update(&mut g);
        let forward = body_forward(&mut g, &p, p.body.unwrap().forward);
        assert!(forward.z > 0.99);
        p.body = None;
        let mut solver = create(&mut g, &p).expect("straight standing legs were not accepted");

        nudge(&mut g, hips, 0.0, -0.04, 0.0);
        update(&mut g);
        solver.apply(&p, &mut g, 0.0, 0.0, None);
        for side in Side::BOTH {
            let [upper, lower, _, _] = leg_slots(side);
            let hip = at(&mut g, &p, upper);
            let mut knee = at(&mut g, &p, lower);
            assert!(knee.sub(&hip).dot(&forward) > 1e-4);
        }
    }

    #[test]
    fn keeps_both_ankles_planted_while_a_breath_and_weight_shift_bend_the_knees() {
        let mut s = setup();
        let anchors = FEET.map(|f| at(&mut s.g, &s.p, f));
        let rest_angles = Side::BOTH.map(|side| knee_angle(&mut s.g, &s.p, side));
        let hips = bone(&s.p, BoneSlot::Hips);
        nudge(&mut s.g, hips, 0.025, -0.045, 0.015);
        assert!(s.g.local_quaternion(hips).equals(&Quat::default()));
        s.g.set_local_quaternion(hips, &euler(0.0, 0.0, 0.08));
        update(&mut s.g);

        apply(&mut s, 0.0);
        for side in Side::BOTH {
            let i = side as usize;
            assert!(at(&mut s.g, &s.p, FEET[i]).distance_to(&anchors[i]) < CLOSE);
            assert!(knee_angle(&mut s.g, &s.p, side) > rest_angles[i] + 0.1);
        }
    }

    #[test]
    fn lifts_both_ankle_targets_by_the_current_positive_rise() {
        let mut s = setup();
        let anchors = FEET.map(|f| at(&mut s.g, &s.p, f));
        let lift = 0.05;
        nudge(&mut s.g, bone(&s.p, BoneSlot::Hips), 0.0, lift, 0.0);
        update(&mut s.g);

        apply(&mut s, lift);
        for i in 0..2 {
            let mut expected = anchors[i];
            expected.add(&Vec3::new(0.0, lift, 0.0));
            assert!(at(&mut s.g, &s.p, FEET[i]).distance_to(&expected) < CLOSE);
        }
    }

    #[test]
    fn follows_root_translation_rotation_and_non_uniform_scale_in_metric_space() {
        let (mut g, p) = avatar();
        centimetre(&mut g);
        let mut solver = create(&mut g, &p).expect("centimetre legs were not accepted");
        let mut root_inverse = g.current_matrix_world(ROOT);
        root_inverse.invert();
        let anchors = FEET.map(|f| {
            let mut v = at(&mut g, &p, f);
            v.apply_matrix4(&root_inverse);
            v
        });
        let orientation = FEET.map(|f| root_relative_q(&g, bone(&p, f)));
        let transforms = CORE.map(|slot| {
            let b = bone(&p, slot);
            (g.local_position(b), g.local_scale(b))
        });

        g.position[0..3].copy_from_slice(&[0.4, -0.2, 0.7]);
        g.set_local_quaternion(ROOT, &euler(0.2, -0.3, 0.15));
        g.scale[0..3].copy_from_slice(&[0.013, 0.008, 0.011]);
        update(&mut g);
        solver.apply(&p, &mut g, 0.0, 0.0, None);

        let root_world = g.current_matrix_world(ROOT);
        for i in 0..2 {
            let mut expected = anchors[i];
            expected.apply_matrix4(&root_world);
            assert!(at(&mut g, &p, FEET[i]).distance_to(&expected) < CLOSE);
            let q = root_relative_q(&g, bone(&p, FEET[i]));
            assert!(q.angle_to(&orientation[i]) < CLOSE);
        }
        for (slot, (p0, s0)) in CORE.iter().zip(transforms) {
            let b = bone(&p, *slot);
            assert_eq!(g.local_position(b).distance_to(&p0), 0.0);
            assert_eq!(g.local_scale(b).distance_to(&s0), 0.0);
        }
    }

    #[test]
    fn preserves_foot_orientation_through_a_nested_non_uniform_metric_frame() {
        let (mut g, p, metric) = with_frame_above_hips();
        g.set_local_scale(metric, &Vec3::new(1.2, 0.8, 1.1));
        g.set_local_quaternion(metric, &euler(0.08, -0.14, 0.05));
        for f in FEET {
            let b = bone(&p, f);
            assert!(g.local_quaternion(b).equals(&Quat::default()));
            g.set_local_quaternion(b, &euler(0.13, -0.19, 0.11));
        }
        update(&mut g);
        let mut solver = create(&mut g, &p).expect("nested standing legs were not accepted");
        assert_eq!(solver.metric, metric);

        let mut metric_inverse = g.current_matrix_world(metric);
        metric_inverse.invert();
        let mut root_inverse = g.current_matrix_world(ROOT);
        root_inverse.invert();
        let root_anchors = FEET.map(|f| {
            let mut v = at(&mut g, &p, f);
            v.apply_matrix4(&root_inverse);
            v
        });
        let rest_matrices = FEET.map(|f| {
            let mut m = root_inverse;
            m.multiply(&g.current_matrix_world(bone(&p, f)));
            m
        });

        nudge(&mut g, bone(&p, BoneSlot::Hips), 0.0, -0.02, 0.0);
        update(&mut g);
        solver.apply(&p, &mut g, 0.0, 0.0, None);

        let root_world = g.current_matrix_world(ROOT);
        for i in 0..2 {
            let foot = bone(&p, FEET[i]);
            let mut expected_anchor = root_anchors[i];
            expected_anchor.apply_matrix4(&root_world);
            assert!(at(&mut g, &p, FEET[i]).distance_to(&expected_anchor) < CLOSE);

            let mut expected = metric_inverse;
            expected.multiply(&root_world).multiply(&rest_matrices[i]);
            let mut expected_q = Quat::default();
            expected.decompose(&mut Vec3::default(), &mut expected_q, &mut Vec3::default());
            let mut actual = metric_inverse;
            actual.multiply(&g.current_matrix_world(foot));
            let mut actual_q = Quat::default();
            actual.decompose(&mut Vec3::default(), &mut actual_q, &mut Vec3::default());
            assert!(actual_q.angle_to(&expected_q) < CLOSE);
        }
    }

    #[test]
    fn leaves_the_author_pose_intact_when_the_two_legs_have_no_common_downward_reach() {
        let mut s = setup();
        let hips = bone(&s.p, BoneSlot::Hips);
        let n = 3 * hips as usize;
        s.g.position[n] = 0.5;
        update(&mut s.g);
        let hip_position = s.g.local_position(hips);
        let rotations = CORE.map(|slot| s.g.local_quaternion(bone(&s.p, slot)));

        apply(&mut s, 0.0);
        assert_eq!(s.g.local_position(hips).distance_to(&hip_position), 0.0);
        for (slot, q) in CORE.iter().zip(rotations) {
            assert_eq!(s.g.local_quaternion(bone(&s.p, *slot)).angle_to(&q), 0.0);
        }
    }

    #[test]
    fn leaves_every_bone_as_posed_when_a_foot_target_fails_after_both_reaches_solve() {
        let mut s = setup();
        // Lower the root so the hips must drop and the left leg must re-aim.
        s.g.position[1] -= 0.03;
        update(&mut s.g);
        let posed = SLOTS.map(|slot| s.g.local_quaternion(bone(&s.p, slot)));
        let hips_at = s.g.local_position(bone(&s.p, BoneSlot::Hips));
        s.solver.legs[1].foot_rest_root_matrix = Mat4::from_elements([f64::NAN; 16]);

        assert!(!apply(&mut s, 0.0));

        assert!(
            s.g.local_position(bone(&s.p, BoneSlot::Hips))
                .equals(&hips_at)
        );
        for (slot, q) in SLOTS.iter().zip(posed) {
            assert!(
                s.g.local_quaternion(bone(&s.p, *slot)).equals(&q),
                "{slot:?}"
            );
        }
    }

    #[test]
    fn a_bent_rest_pole_is_the_one_both_sides_share() {
        // The TS keeps one `kneeMetric` for both sides and a bent side's pole is that vector,
        // so both sides end up with the last side's rest pole. Splay the left knee so the two
        // sides' own poles differ.
        let (mut g, p) = avatar();
        nudge(&mut g, bone(&p, BoneSlot::LowerLegL), 0.03, 0.0, 0.0);
        update(&mut g);
        let legs = create(&mut g, &p).expect("splayed standing legs were not accepted");
        let (left, right) = (legs.legs[0].knee_pole, legs.legs[1].knee_pole);
        assert_eq!(left, right);
        let (_, p0) = avatar();
        let (mut g0, _) = avatar();
        let symmetric = create(&mut g0, &p0).unwrap();
        assert_eq!(right, symmetric.legs[1].knee_pole);
        assert!((right.length() - 1.0).abs() < 1e-12);
    }

    // --- legs-soft.test.ts -------------------------------------------------------------

    const ROUND_OFF: f64 = 1e-10;

    struct Soft {
        g: Graph,
        p: Profile,
        solver: GroundedLegs,
        hips: u32,
        rest: Vec3,
        anchors: [Vec3; 2],
        upper: f64,
        lower: f64,
        span: f64,
        scale: f64,
    }

    fn soft(scale: f64, straight: bool) -> Soft {
        let (mut g, p) = avatar();
        if straight {
            for side in Side::BOTH {
                let [_, lower, foot, _] = leg_slots(side);
                for b in [bone(&p, lower), bone(&p, foot)] {
                    g.position[3 * b as usize + 2] = 0.0;
                }
            }
            update(&mut g);
        }
        if scale != 1.0 {
            centimetre(&mut g);
        }
        let solver = create(&mut g, &p).expect("synthetic standing legs were not accepted");
        let hips = bone(&p, BoneSlot::Hips);
        let rest = g.local_position(hips);
        let anchors = FEET.map(|f| at(&mut g, &p, f));
        let hip = at(&mut g, &p, BoneSlot::UpperLegL);
        let knee = at(&mut g, &p, BoneSlot::LowerLegL);
        Soft {
            upper: hip.distance_to(&knee),
            lower: knee.distance_to(&anchors[0]),
            span: hip.distance_to(&anchors[0]),
            g,
            p,
            solver,
            hips,
            rest,
            anchors,
            scale,
        }
    }

    impl Soft {
        fn apply(&mut self) -> bool {
            self.solver.apply(&self.p, &mut self.g, 0.0, 0.0, None)
        }

        fn angle(&mut self, side: Side) -> f64 {
            let [upper, lower, foot, _] = leg_slots(side);
            let hip = at(&mut self.g, &self.p, upper);
            let knee = at(&mut self.g, &self.p, lower);
            let mut ankle = at(&mut self.g, &self.p, foot);
            let mut a = knee;
            a.sub(&hip);
            a.angle_to(ankle.sub(&knee))
        }

        fn snapshot(&mut self) -> Vec<f64> {
            let mut out = Vec::new();
            for slot in SLOTS {
                let b = bone(&self.p, slot);
                let w = self.g.world_position(b);
                let q = self.g.local_quaternion(b);
                out.extend([w.x, w.y, w.z, q.x, q.y, q.z, q.w]);
            }
            out
        }

        fn expect_anchors(&mut self) {
            for (f, anchor) in FEET.iter().zip(self.anchors) {
                let foot = at(&mut self.g, &self.p, *f);
                assert!(foot.distance_to(&anchor) < ROUND_OFF);
            }
        }
    }

    fn hard_bend(upper: f64, lower: f64, distance: f64) -> f64 {
        let reach = js_min(distance, upper + lower);
        PI - acos(clamp(
            (upper * upper + lower * lower - reach * reach) / (2.0 * upper * lower),
            -1.0,
            1.0,
        ))
    }

    fn expect_same(actual: &[f64], expected: &[f64]) {
        assert_eq!(actual.len(), expected.len());
        for (a, e) in actual.iter().zip(expected) {
            assert!((a - e).abs() < ROUND_OFF, "{a} against {e}");
        }
    }

    #[test]
    fn soft_keeps_the_captured_quiet_rest_fixed_on_first_and_repeated_solves() {
        for scale in [1.0, 0.01] {
            let mut h = soft(scale, false);
            let before = h.snapshot();
            for _ in 0..6 {
                assert!(h.apply());
                expect_same(&h.snapshot(), &before);
                assert!(h.g.local_position(h.hips).equals(&h.rest));
            }
        }
    }

    #[test]
    fn soft_bounds_knee_rate_by_the_rest_derivative_while_retaining_both_anchors() {
        for scale in [1.0, 0.01] {
            let mut h = soft(scale, false);
            let maximum = h.upper + h.lower;
            let zone = js_min(0.01 * maximum, maximum - h.span);
            let start = maximum - zone;
            // At the join the soft derivative equals the ordinary two-link derivative.
            // Its soft-branch value decreases as reach approaches full extension.
            let gap = h.upper - h.lower;
            let bound = (2.0 * start)
                / sqrt((maximum * maximum - start * start) * (start * start - gap * gap));
            let step = zone / 20.0;
            let (mut previous, mut previous_hard): (Option<f64>, Option<f64>) = (None, None);
            let (mut peak, mut hard_peak, mut correction) = (0.0, 0.0, 0.0);
            for sample in -20..=80 {
                let offset = f64::from(sample) * step;
                let mut hp = h.rest;
                hp.y += offset / h.scale;
                h.g.set_local_position(h.hips, &hp);
                update(&mut h.g);
                let raw_span = at(&mut h.g, &h.p, BoneSlot::UpperLegL).distance_to(&h.anchors[0]);
                let raw_y = h.g.local_position(h.hips).y;
                assert!(h.apply());
                correction = js_max(correction, (raw_y - h.g.local_position(h.hips).y) * h.scale);
                h.expect_anchors();
                let current = h.angle(Side::L);
                let hard = hard_bend(h.upper, h.lower, raw_span);
                if let (Some(p), Some(ph)) = (previous, previous_hard) {
                    peak = js_max(peak, (current - p).abs() / step);
                    hard_peak = js_max(hard_peak, (hard - ph).abs() / step);
                }
                previous = Some(current);
                previous_hard = Some(hard);
            }
            assert!(correction > zone, "{scale}");
            assert!(peak <= bound + 1e-6, "{scale}");
            assert!(hard_peak > bound * 3.0, "{scale}");
        }
    }

    #[test]
    fn soft_applies_a_nonzero_correction_before_hard_reach_and_follows_root_placement() {
        let mut h = soft(0.01, false);
        let mut root_inverse = h.g.current_matrix_world(ROOT);
        root_inverse.invert();
        let local = h.anchors.map(|a| {
            let mut v = a;
            v.apply_matrix4(&root_inverse);
            v
        });
        h.g.position[0..3].copy_from_slice(&[0.4, -0.2, 0.7]);
        h.g.set_local_quaternion(ROOT, &euler(0.0, 0.37, 0.0));
        update(&mut h.g);
        let root_world = h.g.current_matrix_world(ROOT);
        h.anchors = local.map(|a| {
            let mut v = a;
            v.apply_matrix4(&root_world);
            v
        });
        let gap = h.upper + h.lower - h.span;
        let hips = h.hips;
        nudge(&mut h.g, hips, 0.0, (gap * 0.5) / h.scale, 0.0);
        let raw = h.g.local_position(hips);
        update(&mut h.g);
        let span = at(&mut h.g, &h.p, BoneSlot::UpperLegL).distance_to(&h.anchors[0]);
        assert!(span < h.upper + h.lower);
        assert!(h.apply());
        assert!((raw.y - h.g.local_position(hips).y) * h.scale > gap * 0.05);
        h.expect_anchors();
    }

    #[test]
    fn soft_keeps_ordinary_bent_poses_bit_identical_to_the_unsoftened_solve() {
        let solve = |unsoftened: bool| {
            let mut h = soft(1.0, false);
            if unsoftened {
                for state in &mut h.solver.legs {
                    state.soft_zone = 0.0;
                }
            }
            let hips = h.hips;
            nudge(&mut h.g, hips, 0.012, -0.035, 0.006);
            update(&mut h.g);
            let raw = h.g.local_position(hips);
            assert!(h.apply());
            assert!(h.g.local_position(hips).equals(&raw));
            h.expect_anchors();
            for side in Side::BOTH {
                let [upper, _, foot, _] = leg_slots(side);
                let distance = at(&mut h.g, &h.p, upper).distance_to(&at(&mut h.g, &h.p, foot));
                let want = hard_bend(h.upper, h.lower, distance);
                assert!((h.angle(side) - want).abs() < ROUND_OFF);
            }
            h.snapshot()
        };
        let softened = solve(false);
        let bits = |v: Vec<f64>| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(solve(true)), bits(softened));
    }

    #[test]
    fn soft_keeps_exactly_straight_rest_finite_and_fixed_with_a_hard_fallback() {
        let mut h = soft(1.0, true);
        let before = h.snapshot();
        assert!(h.apply());
        expect_same(&h.snapshot(), &before);
        let hips = h.hips;
        h.g.position[3 * hips as usize + 1] += 0.01;
        assert!(h.apply());
        assert!(h.snapshot().iter().all(|v| v.is_finite()));
        h.expect_anchors();
        assert!(h.g.local_position(hips).distance_to(&h.rest) < ROUND_OFF);
    }

    // --- legs-turn.test.ts -------------------------------------------------------------

    const TURNS: [f64; 3] = [PI / 2.0, PI, -PI / 2.0];
    const UP: Vec3 = Vec3::new(0.0, 1.0, 0.0);

    fn turn_world(g: &mut Graph, p: &Profile, slot: BoneSlot) -> Vec3 {
        update(g);
        at(g, p, slot)
    }

    fn turn_world_q(g: &mut Graph, p: &Profile, slot: BoneSlot) -> Quat {
        update(g);
        g.world_quaternion(bone(p, slot))
    }

    fn turned(point: &Vec3, pivot: &Vec3, turn: f64) -> Vec3 {
        let mut offset = *point;
        offset.sub(pivot).apply_axis_angle(&UP, turn);
        offset.add(pivot);
        offset
    }

    fn knee_bend(g: &mut Graph, p: &Profile, side: Side) -> f64 {
        let [upper, lower, foot, _] = leg_slots(side);
        let hip = turn_world(g, p, upper);
        let knee = turn_world(g, p, lower);
        let mut ankle = turn_world(g, p, foot);
        let mut a = knee;
        a.sub(&hip);
        a.angle_to(ankle.sub(&knee))
    }

    /// A plain armature, a centimetre armature, and a rebased, turned parent, under a `Rig`.
    fn turn_setup(parent: usize) -> (Graph, Profile, Rig) {
        let (mut g, p) = avatar();
        if parent == 1 {
            centimetre(&mut g);
        }
        if parent == 2 {
            let rest: Vec<Mat4> = (0..g.len() as u32)
                .map(|i| g.current_matrix_world(i))
                .collect();
            g.set_local_quaternion(ROOT, &euler(0.0, 0.0, PI / 2.0));
            update(&mut g);
            for i in 0..g.len() as u32 {
                let Some(parent) = g.parent_of(i) else {
                    continue;
                };
                if g.flags[i as usize] & crate::scene::graph::flag::BONE == 0 {
                    continue;
                }
                let mut m = g.current_matrix_world(parent);
                m.invert().multiply(&rest[i as usize]);
                let (mut position, mut q, mut s) =
                    (Vec3::default(), Quat::default(), Vec3::default());
                m.decompose(&mut position, &mut q, &mut s);
                g.set_local_position(i, &position);
                g.set_local_quaternion(i, &q);
                g.set_local_scale(i, &s);
                g.update_matrix_world(i, true);
            }
            update(&mut g);
        }
        assert!(
            create(&mut g, &p).is_some(),
            "turned standing legs were not accepted"
        );
        let rig = Rig::new(p.clone(), &mut g);
        (g, p, rig)
    }

    #[test]
    fn turn_lands_the_rest_pose_rotated_about_the_stance_centre() {
        for parent in 0..3 {
            for turn in TURNS {
                let (mut g, p, mut rig) = turn_setup(parent);
                let rest = SLOTS.map(|slot| turn_world(&mut g, &p, slot));
                let rest_q = SLOTS.map(|slot| turn_world_q(&mut g, &p, slot));
                let bend = Side::BOTH.map(|side| knee_bend(&mut g, &p, side));
                let mut pivot = turn_world(&mut g, &p, BoneSlot::FootL);
                pivot
                    .add(&turn_world(&mut g, &p, BoneSlot::FootR))
                    .multiply_scalar(0.5);

                rig.plant_legs(&mut g, 0.0, turn, false);

                let mut yaw = Quat::default();
                yaw.set_from_axis_angle(&UP, turn);
                for (i, slot) in SLOTS.iter().enumerate() {
                    let expected = turned(&rest[i], &pivot, turn);
                    let got = turn_world(&mut g, &p, *slot);
                    assert!(
                        got.distance_to(&expected) < 1e-9,
                        "{parent} {turn} {slot:?}"
                    );
                    let mut expected_q = yaw;
                    expected_q.multiply(&rest_q[i]);
                    assert!(turn_world_q(&mut g, &p, *slot).angle_to(&expected_q) < 1e-7);
                }
                for side in Side::BOTH {
                    close(knee_bend(&mut g, &p, side), bend[side as usize], 9);
                }
            }
        }
    }

    #[test]
    fn turn_keeps_the_feet_where_a_plain_plant_puts_them_when_the_turn_is_zero() {
        for parent in 0..3 {
            let (mut a, p, mut ra) = turn_setup(parent);
            let (mut b, _, mut rb) = turn_setup(parent);
            // The TS calls `plantLegs(0.03)` against `plantLegs(0.03, 0)`: one default, one stated.
            ra.plant_legs(&mut a, 0.03, 0.0, false);
            rb.plant_legs(&mut b, 0.03, 0.0, false);
            let dump = |g: &mut Graph| {
                let mut out = Vec::new();
                for slot in SLOTS {
                    let w = turn_world(g, &p, slot);
                    let (q, x) = (
                        g.local_quaternion(bone(&p, slot)),
                        g.local_position(bone(&p, slot)),
                    );
                    out.extend(
                        [w.x, w.y, w.z, q.x, q.y, q.z, q.w, x.x, x.y, x.z].map(f64::to_bits),
                    );
                }
                out
            };
            assert_eq!(dump(&mut b), dump(&mut a));
        }
    }

    #[test]
    fn turn_plants_the_same_feet_at_a_height_whatever_the_turn() {
        for parent in 0..3 {
            let (mut g, p, mut rig) = turn_setup(parent);
            let mut pivot = turn_world(&mut g, &p, BoneSlot::FootL);
            pivot
                .add(&turn_world(&mut g, &p, BoneSlot::FootR))
                .multiply_scalar(0.5);
            let rest = FEET.map(|f| turn_world(&mut g, &p, f));
            rig.plant_legs(&mut g, 0.04, PI / 2.0, false);
            for i in 0..2 {
                let mut expected = turned(&rest[i], &pivot, PI / 2.0);
                expected.add_scaled_vector(&UP, 0.04);
                assert!(turn_world(&mut g, &p, FEET[i]).distance_to(&expected) < 1e-9);
            }
        }
    }

    #[test]
    fn stance_pivot_is_the_midpoint_of_the_rest_anchors_in_world_space() {
        let mut s = setup();
        let mut mid = at(&mut s.g, &s.p, BoneSlot::FootL);
        mid.add(&at(&mut s.g, &s.p, BoneSlot::FootR))
            .multiply_scalar(0.5);
        assert!(s.solver.stance_pivot(&mut s.g).distance_to(&mid) < 1e-12);
    }
    // --- legs-turn.test.ts, the cases that use the rig's body context ------------------------

    #[test]
    fn turn_is_rebuilt_from_the_snapshot_never_stacked_on_itself() {
        let (mut g, p) = avatar();
        let mut rig = Rig::new(p.clone(), &mut g);
        let turn = PI / 2.0;
        rig.capture_proposed_body_context(&mut g, 0.0, turn);
        rig.apply_body_context(&mut g, 1.0, 1.0, false);
        let once = turn_world_q(&mut g, &p, BoneSlot::Hips);
        // The commit captures again once the pelvis is already turned.
        rig.capture_proposed_body_context(&mut g, 0.0, turn);
        rig.apply_body_context(&mut g, 1.0, 1.0, false);
        assert!(turn_world_q(&mut g, &p, BoneSlot::Hips).angle_to(&once) < 1e-9);
    }

    #[test]
    fn turn_without_standing_legs_yaws_the_hips_about_their_own_vertical() {
        for rebase in [false, true] {
            let (mut g, mut p) = avatar();
            for side in Side::BOTH {
                for slot in leg_slots(side) {
                    p.bones[slot as usize] = NO_NODE;
                }
            }
            if rebase {
                g.set_local_quaternion(ROOT, &euler(0.0, 0.0, PI / 2.0));
            }
            update(&mut g);
            let mut rig = Rig::new(p.clone(), &mut g);
            let before = turn_world(&mut g, &p, BoneSlot::Hips);
            let before_q = turn_world_q(&mut g, &p, BoneSlot::Hips);
            rig.plant_legs(&mut g, 0.0, PI / 2.0, false);
            assert!(turn_world(&mut g, &p, BoneSlot::Hips).distance_to(&before) < 1e-9);
            let mut expected = *Quat::default().set_from_axis_angle(&UP, PI / 2.0);
            expected.multiply(&before_q);
            assert!(turn_world_q(&mut g, &p, BoneSlot::Hips).angle_to(&expected) < 1e-7);
        }
    }

    // --- legs-soft.test.ts, the case that uses the rig's body context ------------------------

    #[test]
    fn soft_reconstructs_uncorrected_rig_contexts_through_alpha_zero_and_retries_without_drift() {
        let mut h = soft(1.0, false);
        let mut rig = Rig::new(h.p.clone(), &mut h.g);
        let rest = h.snapshot();
        let gap = h.upper + h.lower - h.span;
        let hips = h.hips;
        nudge(&mut h.g, hips, 0.0, gap * 0.5, 0.0);
        let raw = h.g.local_position(hips);
        rig.plant_legs(&mut h.g, 0.0, 0.0, false);
        assert!(raw.y - h.g.local_position(hips).y > gap * 0.05);
        rig.capture_proposed_body_context(&mut h.g, 0.0, 0.0);
        rig.apply_body_context(&mut h.g, 1.0, 1.0, false);
        let expected = h.snapshot();
        for _ in 0..6 {
            rig.capture_proposed_body_context(&mut h.g, 0.0, 0.0);
            rig.apply_body_context(&mut h.g, 0.0, 0.0, false);
            expect_same(&h.snapshot(), &rest);
            rig.apply_body_context(&mut h.g, 0.5, 0.5, false);
            rig.apply_body_context(&mut h.g, 1.0, 1.0, false);
            expect_same(&h.snapshot(), &expected);
            h.expect_anchors();
        }
    }
}
