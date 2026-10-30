//! `anatomy/palm-frame.ts`: signed rest-pose palm normals.

use crate::math::Vec3;
use crate::profile::{ArmSlot, BoneSlot, Finger, Profile, Side};
use crate::scene::graph::Graph;

// palm-frame.ts restPalmNormals
//
// Signed rest-pose palm normals in world space, shared by fingers and wrist limits; per
// [`Side`], `None` where the hand or its fingers did not resolve.
pub fn rest_palm_normals(p: &Profile, graph: &mut Graph) -> [Option<Vec3>; 2] {
    let mut palm = [None; 2];

    // The profile frame is chest-local; the measured finger geometry is world-space.
    // Without a body frame, retain the coordinate-axis fallback used by partial rigs,
    // facing the way a person with that up and right would.
    let mut up = Vec3::new(0.0, 1.0, 0.0);
    let mut right = Vec3::new(1.0, 0.0, 0.0);
    let mut forward = Vec3::default();
    forward.cross_vectors(&up, &right);
    let chest = p.chest();
    if let (Some(body), Some(chest)) = (&p.body, chest) {
        graph.update_world_matrix(chest, true, false, false);
        let world = graph.current_matrix_world(chest);
        // The full matrix rather than its rotation, so a mirrored armature keeps
        // its handedness.
        up.copy(&body.up).transform_direction(&world);
        right.copy(&body.right).transform_direction(&world);
        forward.copy(&body.forward).transform_direction(&world);
    }

    // The sign comes from the hand's chirality. `along × (little − index)` leaves
    // the palm of a right hand and the back of a left one, whatever the bind
    // does with the arm; which hand is the right one is the body frame's
    // handedness, read the same way `lateralReference` reads it. Guessing from
    // the bind instead — palms face down — fails wherever a palm is level, which
    // is every palms-in bind.
    let mut lateral = Vec3::default();
    let mut facing = Vec3::default();
    for side in Side::BOTH {
        let hand = p.bone(BoneSlot::arm(ArmSlot::Hand, side));
        let index = p.finger_root(Finger::Index, side);
        let little = p.finger_root(Finger::Little, side);
        let middle = p.finger_root(Finger::Middle, side);
        let (Some(hand), Some(index), Some(little), Some(middle)) = (hand, index, little, middle)
        else {
            continue;
        };
        graph.update_world_matrix(hand, true, false, false);
        let mut across = graph.world_position(little);
        across.sub(&graph.world_position(index)).normalize();
        let mut along = graph.world_position(middle);
        along.sub(&graph.world_position(hand)).normalize();
        let mut normal = Vec3::default();
        normal.cross_vectors(&along, &across).normalize();
        lateral.copy(&right);
        if side == Side::L {
            lateral.negate();
        }
        if up.dot(facing.cross_vectors(&forward, &lateral)) > 0.0 {
            normal.negate();
        }
        palm[side as usize] = Some(normal);
    }
    palm
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::base::avatar;

    #[test]
    fn the_two_palms_face_mirrored_ways_on_the_base_avatar() {
        let (mut graph, p) = avatar();
        graph.update_world_matrix(0, true, true, false);
        let [l, r] = rest_palm_normals(&p, &mut graph);
        let (l, r) = (l.unwrap(), r.unwrap());
        assert!((l.length() - 1.0).abs() < 1e-12);
        assert!((r.length() - 1.0).abs() < 1e-12);
        // Mirrored across the body's sagittal plane: the lateral components cancel, the rest agree.
        let world = graph.current_matrix_world(p.chest().unwrap());
        let mut right = p.body.unwrap().right;
        right.transform_direction(&world);
        assert!((l.dot(&right) + r.dot(&right)).abs() < 1e-9);
        let mut l_mirror = l;
        l_mirror.add_scaled_vector(&right, -2.0 * l.dot(&right));
        assert!(l_mirror.distance_to(&r) < 1e-9);
    }

    #[test]
    fn a_hand_without_fingers_has_no_palm() {
        let (mut graph, mut p) = avatar();
        p.finger_bones[Side::R as usize * 5 + Finger::Little as usize].clear();
        let palms = rest_palm_normals(&p, &mut graph);
        assert!(palms[0].is_some());
        assert!(palms[1].is_none());
    }
}
