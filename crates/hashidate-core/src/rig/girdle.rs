//! `rig/girdle.ts`: the clavicle's room-making turn and the travel that bounds it.
//!
//! The TS module scratch (`_gC`, `_gS`, …) is written before it is read in every call, so it is
//! per call here.

use super::reach::length;
use crate::anatomy::joints::JointTable;
use crate::math::f::{acos, cos, js_min, sqrt};
use crate::math::{Vec3, clamp};
use crate::profile::{ArmSlot, BoneSlot, Profile, Side};
use crate::scene::graph::Graph;
use core::f64::consts::PI;

// How far the clavicle may turn to get the arm room. The sternoclavicular joint
// gives roughly ten degrees of depression and twenty of retraction, and a swing
// away from a target in front of the face is a mix of the two.
const GIRDLE_ROM: f64 = 0.38;

/// The clavicle's room-making turn and the travel that bounds it.
///
/// The TS instance holds the profile and the joint table; the port borrows both per call.
#[derive(Clone, Copy, Debug, Default)]
pub struct ShoulderGirdle;

impl ShoulderGirdle {
    // girdle.ts ShoulderGirdle.constructor
    pub fn new() -> ShoulderGirdle {
        ShoulderGirdle
    }

    // girdle.ts ShoulderGirdle.girdleRoom
    //
    // Swing the shoulder girdle away from a reach, in place, before the arm is
    // solved from it.
    //
    // A hand cannot be brought to the face by the arm alone. The elbow's flexion
    // fixes a nearest reachable point — fold it as far as it goes and the wrist
    // is still a fixed distance from the shoulder — so on a narrow-shouldered,
    // short-necked figure the face can sit inside that radius and no choice of
    // elbow, pole or wrist reaches it. Measured on the validation avatar the
    // shoulder is 0.09 to 0.14 from the face anchors against an arm of 0.33; the
    // same ratio on a person is around a half to two thirds.
    //
    // What a person does about it is drop and draw back the shoulder, and that is
    // what this does: the clavicle turns away from the target until the wrist can
    // sit where the elbow's *comfortable* range wants it, bounded by the girdle's
    // own travel. It buys a couple of centimetres, which is the difference
    // between a forearm folded flat and one that reads as resting.
    //
    // `dir` is the clavicle's aim, and the turn it needs, scaled by `weight`, is
    // added to `turnOut` as a rotation vector rather than applied: every reach in
    // play adds its share, and `turnGirdle` applies the sum, bounded by the
    // girdle's travel. The current angle is taken from `dir` rather than from
    // where the bone actually points, so the result is a function of the request
    // alone — read back from the posed bone it would measure its own correction,
    // find nothing left to do, and let the shoulder spring back on the next frame.
    #[allow(clippy::too_many_arguments, clippy::neg_cmp_op_on_partial_ord)]
    pub fn girdle_room(
        &self,
        p: &Profile,
        joints: &JointTable,
        graph: &mut Graph,
        side: Side,
        target_world: &Vec3,
        dir: &[f64; 3],
        weight: f64,
        turn_out: &mut Vec3,
    ) {
        let clav = p.bone(BoneSlot::arm(ArmSlot::Shoulder, side));
        let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side));
        let limb = &p.limb[side as usize];
        let (Some(clav), Some(upper), Some(la), Some(lf)) =
            (clav, upper, length(limb.upper), length(limb.lower))
        else {
            return;
        };
        if weight <= 0.0 {
            return;
        }

        graph.update_world_matrix(clav, true, false, false);
        graph.update_world_matrix(upper, true, false, false);
        let c = graph.world_position(clav);
        // Turning the clavicle cannot change this, so the posed bones give the rest
        // length as readily as the rest pose would.
        let r = c.distance_to(&graph.world_position(upper));
        if r < 1e-4 {
            return;
        }

        let mut a = Vec3::new(dir[0], dir[1], dir[2]);
        if a.length_sq() < 1e-8 {
            return;
        }
        a.normalize();
        let mut b = *target_world;
        b.sub(&c);
        let l = b.length();
        if l < 1e-4 {
            return;
        }
        b.multiply_scalar(1.0 / l);

        // Where the wrist has to sit for the elbow to stay inside its free range.
        let flex_free = joints.elbow.flexion.free[1];
        let want = sqrt(la * la + lf * lf - 2.0 * la * lf * cos(PI - flex_free));
        // Law of cosines on the triangle root-shoulder-target: the shoulder sits on
        // a sphere of radius r about the clavicle root, and this is the cosine that
        // puts it `want` from the target.
        let k = (r * r + l * l - want * want) / (2.0 * r * l);
        let cos0 = clamp(a.dot(&b), -1.0, 1.0);
        if !(k < cos0) {
            return;
        }

        let need = acos(clamp(k, -1.0, 1.0)) - acos(cos0);
        let turn = js_min(need, GIRDLE_ROM) * weight;
        if turn < 1e-4 {
            return;
        }
        // b cross a, not a cross b: rotating about the latter carries the shoulder
        // *toward* the target, which is the wrong way round and reads as a hunch.
        let mut axis = Vec3::default();
        axis.cross_vectors(&b, &a);
        if axis.length_sq() < 1e-8 {
            return;
        }
        turn_out.add_scaled_vector(axis.normalize(), turn);
    }

    // girdle.ts ShoulderGirdle.turnGirdle
    //
    // Turn the clavicle's aim `dir` in place by the rotation `girdleRoom`
    // gathered, its angle clamped to the girdle's travel however many reaches
    // contributed.
    pub fn turn_girdle(&self, dir: &mut [f64; 3], turn: &Vec3) {
        let angle = js_min(turn.length(), GIRDLE_ROM);
        if angle < 1e-4 {
            return;
        }
        let mut axis = *turn;
        axis.normalize();
        let mut a = Vec3::new(dir[0], dir[1], dir[2]);
        a.normalize().apply_axis_angle(&axis, angle);
        dir[0] = a.x;
        dir[1] = a.y;
        dir[2] = a.z;
    }
}

#[cfg(test)]
mod tests {
    //! `tests/rig/girdle.test.ts`, on the base avatar.
    use super::*;
    use crate::rig::testkit::{Arms, bone};

    #[test]
    fn bounds_the_summed_turn_by_the_girdle_travel_however_many_reaches_ask() {
        let mut arms = Arms::new();
        let girdle = ShoulderGirdle::new();
        let clav = bone(&arms.profile, BoneSlot::ShoulderR);
        let upper = bone(&arms.profile, BoneSlot::UpperArmR);
        arms.graph.update_world_matrix(upper, true, false, false);
        arms.graph.update_world_matrix(clav, true, false, false);
        let s = arms.graph.world_position(upper);
        let c = arms.graph.world_position(clav);
        let mut aim = s;
        aim.sub(&c).normalize();
        // A hand folded in against the face: more than the girdle can give.
        let mut target = s;
        target.add_scaled_vector(arms.anat.fwd(), 0.04);

        let mut dir = [aim.x, aim.y, aim.z];
        let mut turn = Vec3::default();
        let Arms {
            profile,
            joints,
            graph,
            ..
        } = &mut arms;
        girdle.girdle_room(
            profile,
            joints,
            graph,
            Side::R,
            &target,
            &dir,
            1.0,
            &mut turn,
        );
        assert!(turn.length() > 0.0);
        girdle.girdle_room(
            profile,
            joints,
            graph,
            Side::R,
            &target,
            &dir,
            1.0,
            &mut turn,
        );
        assert!(turn.length() > GIRDLE_ROM);

        girdle.turn_girdle(&mut dir, &turn);
        let turned = Vec3::new(dir[0], dir[1], dir[2]);
        assert!(turned.angle_to(&aim) <= GIRDLE_ROM + 1e-9);
        assert!(turned.angle_to(&aim) > 0.0);
    }
}
