//! `rig/arm-twists.ts`: the optional arm twist helpers, posed as a leaf-only skin deformation.
//!
//! The TS binding keeps the profile's binding object beside the bones it read from it and checks
//! the two still agree before every write; that object is a value here, so the check is the
//! hierarchy's alone. A helper's "no children" counts the plain leaves the scene graph flags as
//! well as the table's own children, as three's `children` does.

use crate::math::f::{atan2, js_round};
use crate::math::{Mat4, Quat, Vec3};
use crate::profile::{ArmTwistSlot, BoneSlot, Profile, Side};
use crate::rig::arm_driver::positive_conformal_scale;
use crate::scene::graph::{Graph, flag};
use core::f64::consts::PI;

// 80° straight-roll body-mesh helper-blend samples: minimum radial ratio .941094→.962435
// and .936620→.978843 at half the parent-to-child axial residual.
// Provisional split; needs a render check.
const RESIDUAL_SHARE: f64 = 0.5;

const SLOTS: [(ArmTwistSlot, BoneSlot, Side); 4] = [
    (ArmTwistSlot::UpperArmL, BoneSlot::UpperArmL, Side::L),
    (ArmTwistSlot::UpperArmR, BoneSlot::UpperArmR, Side::R),
    (ArmTwistSlot::LowerArmL, BoneSlot::LowerArmL, Side::L),
    (ArmTwistSlot::LowerArmR, BoneSlot::LowerArmR, Side::R),
];

#[derive(Clone, Copy, Debug, PartialEq)]
struct CalibratedTwist {
    primary: u32,
    next: u32,
    helper: u32,
    side: Side,
    rest: Quat,
    inverse_relative_rest: Quat,
    axis: Vec3,
    committed: f64,
}

/// The rotations `readRelative` and `apply` work in.
#[derive(Clone, Copy, Debug, Default)]
struct Scratch {
    rotation: Mat4,
    primary_q: Quat,
    next_q: Quat,
    relative: Quat,
    turn: Quat,
}

/// Leaf-only skin deformation; trial poses never advance the accepted angular branch.
#[derive(Clone, Debug)]
pub struct ArmTwists {
    bindings: Vec<CalibratedTwist>,
    scratch: Scratch,
}

// arm-twists.ts ArmTwists.safeTopology
fn safe_topology(graph: &Graph, binding: &CalibratedTwist) -> bool {
    let (primary, next, helper) = (binding.primary, binding.next, binding.helper);
    let h = helper as usize;
    helper != primary
        && helper != next
        && graph.parent_of(helper) == Some(primary)
        && graph.parent_of(next) == Some(primary)
        && graph.child_offsets[h + 1] == graph.child_offsets[h]
        && graph.flags[h] & flag::PLAIN_CHILDREN == 0
}

// arm-twists.ts ArmTwists.readRelative
fn read_relative(graph: &mut Graph, s: &mut Scratch, binding: &CalibratedTwist) -> bool {
    let (primary, next, helper) = (binding.primary, binding.next, binding.helper);
    graph.update_world_matrix(primary, true, false, false);
    graph.update_world_matrix(next, false, false, false);
    graph.update_world_matrix(helper, false, false, false);
    if positive_conformal_scale(&graph.current_matrix_world(primary)).is_none()
        || positive_conformal_scale(&graph.current_matrix_world(next)).is_none()
        || positive_conformal_scale(&graph.current_matrix_world(helper)).is_none()
    {
        return false;
    }
    s.primary_q.set_from_rotation_matrix(
        s.rotation
            .extract_rotation(&graph.current_matrix_world(primary)),
    );
    s.next_q.set_from_rotation_matrix(
        s.rotation
            .extract_rotation(&graph.current_matrix_world(next)),
    );
    s.relative
        .copy(&s.primary_q)
        .invert()
        .multiply(&s.next_q)
        .normalize();
    true
}

// arm-twists.ts ArmTwists.restore
fn restore(graph: &mut Graph, binding: &CalibratedTwist) {
    graph.set_local_quaternion(binding.helper, &binding.rest);
    graph.update_world_matrix(binding.helper, false, false, false);
}

impl ArmTwists {
    // arm-twists.ts ArmTwists.create
    pub fn create(profile: &Profile, graph: &mut Graph) -> Option<ArmTwists> {
        if profile.arm_twists.iter().all(Option::is_none) {
            return None;
        }
        let canonical = |node: u32| {
            profile.bones.contains(&node) || profile.finger_bones.iter().any(|c| c.contains(&node))
        };
        let mut controller = ArmTwists {
            bindings: Vec::new(),
            scratch: Scratch::default(),
        };
        for (slot, bone_slot, side) in SLOTS {
            let Some(source) = profile.arm_twists[slot as usize] else {
                continue;
            };
            if canonical(source.helper) {
                continue;
            }
            let Some(mut axis) = profile.rest_dir[bone_slot as usize] else {
                continue;
            };
            if !(axis.x.is_finite() && axis.y.is_finite() && axis.z.is_finite())
                || axis.length_sq() <= 0.0
            {
                continue;
            }
            axis.normalize();
            let binding = CalibratedTwist {
                primary: source.primary,
                next: source.next,
                helper: source.helper,
                side,
                rest: graph.local_quaternion(source.helper),
                inverse_relative_rest: Quat::default(),
                axis,
                committed: 0.0,
            };
            if !(safe_topology(graph, &binding)
                && read_relative(graph, &mut controller.scratch, &binding))
            {
                continue;
            }
            let mut binding = binding;
            binding
                .inverse_relative_rest
                .copy(&controller.scratch.relative)
                .invert();
            controller.bindings.push(binding);
        }
        (!controller.bindings.is_empty()).then_some(controller)
    }

    // arm-twists.ts ArmTwists.reset
    pub fn reset(&self, graph: &mut Graph) {
        for binding in &self.bindings {
            if safe_topology(graph, binding) {
                restore(graph, binding);
            }
        }
    }

    // arm-twists.ts ArmTwists.stage
    pub fn stage(&mut self, graph: &mut Graph, side: Side) {
        self.apply(graph, side, false);
    }

    // arm-twists.ts ArmTwists.accept
    pub fn accept(&mut self, graph: &mut Graph, side: Side) {
        self.apply(graph, side, true);
    }

    // arm-twists.ts ArmTwists.apply
    fn apply(&mut self, graph: &mut Graph, side: Side, accept: bool) {
        let s = &mut self.scratch;
        for binding in &mut self.bindings {
            if binding.side != side || !safe_topology(graph, binding) {
                continue;
            }
            if !read_relative(graph, s, binding) {
                restore(graph, binding);
                continue;
            }
            s.relative
                .multiply(&binding.inverse_relative_rest)
                .normalize();
            let Quat { x, y, z, w } = s.relative;
            let axial = x * binding.axis.x + y * binding.axis.y + z * binding.axis.z;
            let mut angle = binding.committed;
            if axial * axial + w * w > f64::EPSILON {
                let raw = 2.0 * atan2(axial, w);
                angle = raw + 2.0 * PI * js_round((binding.committed - raw) / (2.0 * PI));
                if accept {
                    binding.committed = angle;
                }
            }
            let mut q = *s
                .turn
                .set_from_axis_angle(&binding.axis, RESIDUAL_SHARE * angle);
            q.multiply(&binding.rest);
            graph.set_local_quaternion(binding.helper, &q);
            graph.update_world_matrix(binding.helper, false, false, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::f::cos;
    use crate::profile::ArmTwistBinding;
    use crate::rig::testkit::{avatar, centimetre, close, euler, graph_hash};

    /// The helper families `buildRig` names: `rotate` sits halfway down its primary.
    #[derive(Clone, Copy, PartialEq)]
    enum Family {
        Twist,
        Rotate,
    }

    fn deg(d: f64) -> f64 {
        d * (PI / 180.0)
    }

    fn turn(axis: &Vec3, angle: f64) -> Quat {
        *Quat::default().set_from_axis_angle(axis, angle)
    }

    fn times(a: &Quat, b: &Quat) -> Quat {
        let mut q = *a;
        *q.multiply(b)
    }

    /// The base avatar with its helpers as `family` builds them, at `scale`.
    fn avatar_with(family: Family, scale: f64) -> (Graph, Profile) {
        let (mut g, p) = avatar();
        if scale != 1.0 {
            assert_eq!(scale, 0.01);
            centimetre(&mut g);
        }
        if family == Family::Rotate {
            for t in p.arm_twists.iter().flatten() {
                let mut v = g.local_position(t.helper);
                v.multiply_scalar(0.5);
                g.set_local_position(t.helper, &v);
            }
        }
        g.update_matrix_world(0, true);
        (g, p)
    }

    struct Fixture {
        g: Graph,
        controller: ArmTwists,
        binding: ArmTwistBinding,
        rest: Quat,
        next_rest: Quat,
        axis: Vec3,
    }

    impl Fixture {
        fn new(family: Family, scale: f64) -> Fixture {
            let (mut g, p) = avatar_with(family, scale);
            let controller = ArmTwists::create(&p, &mut g).expect("missing helper controller");
            let binding = p.arm_twists[ArmTwistSlot::LowerArmR as usize].expect("missing binding");
            let rest = g.local_quaternion(binding.helper);
            let next_rest = g.local_quaternion(binding.next);
            let mut axis = p.rest_dir[BoneSlot::LowerArmR as usize].unwrap();
            axis.normalize();
            Fixture {
                g,
                controller,
                binding,
                rest,
                next_rest,
                axis,
            }
        }

        fn pose(&mut self, degrees: f64) {
            let mut q = self.next_rest;
            q.premultiply(&turn(&self.axis, deg(degrees)));
            self.g.set_local_quaternion(self.binding.next, &q);
        }

        fn expected(&self, degrees: f64) -> Quat {
            times(&turn(&self.axis, deg(degrees / 2.0)), &self.rest)
        }

        fn helper(&self) -> Quat {
            self.g.local_quaternion(self.binding.helper)
        }

        fn stage(&mut self) {
            self.controller.stage(&mut self.g, Side::R);
        }

        fn accept(&mut self) {
            self.controller.accept(&mut self.g, Side::R);
        }

        fn reset(&mut self) {
            self.controller.reset(&mut self.g);
        }
    }

    fn q4(q: &Quat) -> [f64; 4] {
        [q.x, q.y, q.z, q.w]
    }

    fn close_quaternion(actual: &Quat, expected: &Quat) {
        for (a, e) in q4(actual).iter().zip(q4(expected)) {
            close(*a, e, 12);
        }
    }

    #[test]
    fn preserves_nonidentity_helper_bind_and_primary_transforms() {
        for (family, scale) in [(Family::Twist, 1.0), (Family::Rotate, 0.01)] {
            let mut h = Fixture::new(family, scale);
            h.pose(80.0);
            let before = [h.binding.primary, h.binding.next].map(|b| q4(&h.g.local_quaternion(b)));
            h.stage();
            close_quaternion(&h.helper(), &h.expected(80.0));
            assert_eq!(
                [h.binding.primary, h.binding.next].map(|b| q4(&h.g.local_quaternion(b))),
                before
            );
            for _ in 0..5 {
                h.reset();
                assert_eq!(q4(&h.helper()), q4(&h.rest));
                h.stage();
                close_quaternion(&h.helper(), &h.expected(80.0));
            }
        }
    }

    #[test]
    fn never_drives_a_helper_selected_as_a_canonical_eye_while_retaining_other_bindings() {
        let (mut g, mut p) = avatar_with(Family::Twist, 1.0);
        let alias = p.arm_twists[ArmTwistSlot::UpperArmL as usize].unwrap();
        let lower = p.arm_twists[ArmTwistSlot::LowerArmL as usize].unwrap();
        p.bones[BoneSlot::EyeL as usize] = alias.helper;
        let eye_rest = g.local_quaternion(alias.helper);
        let lower_rest = g.local_quaternion(lower.helper);
        let mut controller =
            ArmTwists::create(&p, &mut g).expect("other helper bindings must remain available");
        let upper_axis = p.rest_dir[BoneSlot::UpperArmL as usize].unwrap();
        let lower_axis = p.rest_dir[BoneSlot::LowerArmL as usize].unwrap();
        g.set_local_quaternion(alias.next, &turn(&upper_axis, 0.8));
        g.set_local_quaternion(lower.next, &turn(&lower_axis, 0.6));
        controller.stage(&mut g, Side::L);
        controller.accept(&mut g, Side::L);
        assert_eq!(q4(&g.local_quaternion(alias.helper)), q4(&eye_rest));
        close_quaternion(
            &g.local_quaternion(lower.helper),
            &times(&turn(&lower_axis, 0.3), &lower_rest),
        );
        let externally_posed = times(&euler(0.0, 0.2, 0.0), &eye_rest);
        g.set_local_quaternion(alias.helper, &externally_posed);
        controller.reset(&mut g);
        assert_eq!(q4(&g.local_quaternion(alias.helper)), q4(&externally_posed));
        assert_eq!(q4(&g.local_quaternion(lower.helper)), q4(&lower_rest));
    }

    #[test]
    fn does_no_matrix_work_when_the_bindings_are_absent() {
        // The TS tells an absent table from an empty one; here both are no bindings at all.
        let (mut g, mut p) = avatar();
        p.arm_twists = [None; 4];
        let before = graph_hash(&g);
        assert!(ArmTwists::create(&p, &mut g).is_none());
        assert_eq!(graph_hash(&g), before);
    }

    #[test]
    fn unwraps_only_from_committed_frames_and_retains_history_across_reset_and_rejected_trials() {
        let mut h = Fixture::new(Family::Twist, 1.0);
        h.pose(170.0);
        h.accept();
        h.pose(-170.0);
        h.stage();
        close_quaternion(&h.helper(), &h.expected(190.0));
        h.pose(-10.0);
        h.stage();
        h.reset();
        h.pose(-170.0);
        h.accept();
        close_quaternion(&h.helper(), &h.expected(190.0));
        h.pose(-150.0);
        h.accept();
        close_quaternion(&h.helper(), &h.expected(210.0));
    }

    #[test]
    fn does_not_let_a_rejected_trial_select_the_next_angular_branch() {
        let mut trial = Fixture::new(Family::Twist, 1.0);
        let mut control = Fixture::new(Family::Twist, 1.0);
        trial.pose(179.0);
        trial.stage();
        trial.pose(-179.0);
        trial.stage();
        control.pose(-179.0);
        control.stage();
        close_quaternion(&trial.helper(), &control.helper());
        close_quaternion(&trial.helper(), &trial.expected(-179.0));
    }

    #[test]
    fn holds_the_last_accepted_axial_angle_at_the_swing_twist_pole() {
        let mut h = Fixture::new(Family::Twist, 1.0);
        h.pose(80.0);
        h.accept();
        let mut perpendicular = Vec3::new(0.0, 1.0, 0.0);
        perpendicular.cross(&h.axis).normalize();
        let q = times(&turn(&perpendicular, PI), &h.next_rest);
        h.g.set_local_quaternion(h.binding.next, &q);
        h.accept();
        close_quaternion(&h.helper(), &h.expected(80.0));
        h.pose(100.0);
        h.stage();
        close_quaternion(&h.helper(), &h.expected(100.0));
    }

    #[test]
    fn never_writes_a_helper_that_is_no_longer_a_leaf() {
        // A plain leaf is the one child the scene graph lets a node gain after it is built; the
        // TS cases that reparent a bone or alias the binding cannot arise here.
        let mut h = Fixture::new(Family::Twist, 1.0);
        h.pose(80.0);
        h.accept();
        h.g.set_plain_children(h.binding.helper, true);
        let before = q4(&h.helper());
        h.reset();
        h.stage();
        h.accept();
        assert_eq!(q4(&h.helper()), before);
    }

    #[test]
    fn restores_rest_without_advancing_history_for_an_invalid_live_frame() {
        for change in ["nonfinite", "reflection", "nonconformal", "shear"] {
            let mut h = Fixture::new(Family::Twist, 1.0);
            h.pose(170.0);
            h.accept();
            let primary = h.binding.primary;
            let position = h.g.local_position(primary);
            let n = primary as usize;
            match change {
                "nonfinite" => h.g.position[3 * n] = f64::NAN,
                "reflection" => h.g.scale[3 * n] = -1.0,
                "nonconformal" => h.g.scale[3 * n] = 2.0,
                _ => {
                    h.g.update_matrix(primary);
                    h.g.flags[n] &= !flag::MATRIX_AUTO_UPDATE;
                    h.g.matrix[16 * n + 4] += 0.2;
                }
            }
            h.pose(-10.0);
            h.accept();
            assert_eq!(q4(&h.helper()), q4(&h.rest), "{change}");
            h.g.set_local_position(primary, &position);
            h.g.set_local_scale(primary, &Vec3::new(1.0, 1.0, 1.0));
            h.g.flags[n] |= flag::MATRIX_AUTO_UPDATE;
            h.pose(-170.0);
            h.stage();
            close_quaternion(&h.helper(), &h.expected(190.0));
        }
    }

    #[test]
    fn extracts_the_actual_mixed_wrist_residual_relative_to_nonidentity_adjacent_bind() {
        let (mut g, p) = avatar_with(Family::Rotate, 1.0);
        let binding = p.arm_twists[ArmTwistSlot::LowerArmL as usize].unwrap();
        g.set_local_quaternion(binding.primary, &euler(0.2, -0.3, 0.15));
        g.set_local_quaternion(binding.next, &euler(-0.13, 0.24, 0.19));
        let next_rest = g.local_quaternion(binding.next);
        let rest = g.local_quaternion(binding.helper);
        let mut axis = p.rest_dir[BoneSlot::LowerArmL as usize].unwrap();
        axis.normalize();
        let mut controller = ArmTwists::create(&p, &mut g).expect("missing controller");
        let mut swing_axis = Vec3::new(0.0, 1.0, 0.0);
        swing_axis.cross(&axis).normalize();
        let residual = times(&turn(&swing_axis, 0.7), &turn(&axis, 1.1));
        g.set_local_quaternion(binding.next, &times(&residual, &next_rest));
        controller.stage(&mut g, Side::L);
        let want = times(&turn(&axis, 0.55), &rest);
        close_quaternion(&g.local_quaternion(binding.helper), &want);
        let q = g.local_quaternion(binding.next);
        g.set_local_quaternion(binding.next, &Quat::new(-q.x, -q.y, -q.z, -q.w));
        controller.stage(&mut g, Side::L);
        close_quaternion(&g.local_quaternion(binding.helper), &want);
    }

    #[test]
    fn does_not_calibrate_an_initially_invalid_frame() {
        let (mut g, p) = avatar_with(Family::Twist, 1.0);
        g.scale[0] = -1.0;
        assert!(ArmTwists::create(&p, &mut g).is_none());
    }

    #[test]
    fn improves_a_real_weighted_skinned_point_while_preserving_the_canonical_joint() {
        let mut h = Fixture::new(Family::Twist, 1.0);
        let (next, helper) = (h.binding.next, h.binding.helper);
        let mut point = Vec3::default();
        point.set_from_matrix_position(&h.g.current_matrix_world(helper));
        point.y += 0.05;
        // A skinned mesh at the root bound to the forearm and its helper half and half, skinned
        // as three's `applyBoneTransform` does from the bones' world matrices.
        let bind = h.g.current_matrix_world(0);
        let mut bind_inverse = bind;
        bind_inverse.invert();
        let inverse = |g: &Graph, b: u32| {
            let mut m = g.current_matrix_world(b);
            *m.invert()
        };
        let bone_inverses = [inverse(&h.g, next), inverse(&h.g, helper)];
        let radial = |h: &mut Fixture| {
            h.g.update_matrix_world(0, true);
            let mut base = point;
            base.apply_matrix4(&bind);
            let mut p = Vec3::default();
            for (k, b) in [next, helper].into_iter().enumerate() {
                let mut m = Mat4::default();
                m.multiply_matrices(&h.g.current_matrix_world(b), &bone_inverses[k]);
                let mut v = base;
                v.apply_matrix4(&m);
                p.add_scaled_vector(&v, 0.5);
            }
            p.apply_matrix4(&bind_inverse);
            let origin = h.g.world_position(helper);
            let mut axis = h.axis;
            axis.apply_quaternion(&h.g.world_quaternion(h.binding.primary));
            p.sub(&origin);
            let d = -p.dot(&axis);
            p.add_scaled_vector(&axis, d).length()
        };
        let rest_radius = radial(&mut h);
        h.pose(80.0);
        let before = radial(&mut h);
        let joint = q4(&h.g.local_quaternion(next));
        h.stage();
        let after = radial(&mut h);
        close(before / rest_radius, cos(deg(40.0)), 10);
        close(after / rest_radius, cos(deg(20.0)), 10);
        assert!(after > before);
        assert!(after <= rest_radius);
        assert_eq!(q4(&h.g.local_quaternion(next)), joint);
    }
}
