//! `rig/finger-axes.ts`: finger hinge axes, derived from the rest pose.
//!
//! The thumb is the exception to the finger rule: it hinges about the palm normal tilted toward
//! the finger fold and splays perpendicular to that, the reverse of a finger. The distal hinge
//! additionally turns about the phalanx with the curl (opposition, in `hands.ts`); the axes stored
//! here do not change, only the direction of that turn is settled here per hand.
//!
//! Split out of the rig because it runs once, at construction, and reads only
//! the profile: which way a finger bends is a property of how the hand was
//! modelled, not of anything a frame does.
//!
//! The TS maps keyed by bone are tables indexed by node here, `None` where the map has no entry.

use crate::anatomy::joints::{THUMB_FLEXION_TILT, THUMB_OPPOSITION};
use crate::anatomy::palm_frame::rest_palm_normals;
use crate::math::f::{cos, sin};
use crate::math::{Quat, Vec3};
use crate::profile::{ArmSlot, BoneSlot, Finger, Profile, Side};
use crate::scene::graph::Graph;

/// What the rig keeps from the rest-pose hand.
#[derive(Clone, Debug, PartialEq)]
pub struct FingerAxes {
    /// Curl axis per finger bone, in that bone's own space.
    pub axes: Vec<Option<Vec3>>,
    /// Splay axis for each proximal finger bone, in that bone's own space.
    pub splay_axes: Vec<Option<Vec3>>,
    /// Palm normal per hand, in the hand bone's own space.
    pub palm_local: [Option<Vec3>; 2],
    /// Sign of the opposition turn for each thumb's distal bone: the one that folds the tip toward the palm.
    pub opposition_sign: Vec<Option<f64>>,
}

impl FingerAxes {
    /// `axes.get(bone)`.
    pub fn axis(&self, bone: u32) -> Option<&Vec3> {
        self.axes.get(bone as usize).and_then(Option::as_ref)
    }

    /// `splayAxes.get(bone)`.
    pub fn splay_axis(&self, bone: u32) -> Option<&Vec3> {
        self.splay_axes.get(bone as usize).and_then(Option::as_ref)
    }
}

// finger-axes.ts solveFingerAxes
//
// Curl axis for every finger bone, in that bone's own space.
//
// Derived from the rest geometry: the axis is perpendicular to both the bone
// direction and the palm normal, which is what a finger actually hinges about.
pub fn solve_finger_axes(p: &Profile, graph: &mut Graph) -> FingerAxes {
    let n = graph.len();
    let mut axes = vec![None; n];
    let mut splay_axes = vec![None; n];
    let mut opposition_sign = vec![None; n];
    let mut palm_local = [None; 2];

    // --- palm normal per hand, in world space -------------------------------
    let palm = rest_palm_normals(p, graph);

    // --- curl axes, plus the palm kept for roll targeting --------------------
    for side in Side::BOTH {
        let (Some(palm_normal), Some(hand)) = (
            palm[side as usize],
            p.bone(BoneSlot::arm(ArmSlot::Hand, side)),
        ) else {
            continue;
        };

        // Stored in the hand bone's own space so the hand can be rolled to face a
        // given direction later: aiming the hand fixes only where the fingers
        // point and leaves the roll about that axis free.
        let mut local = palm_normal;
        local
            .apply_quaternion(graph.world_quaternion(hand).invert())
            .normalize();
        palm_local[side as usize] = Some(local);

        // Splay is a turn in the palm plane, so its axis is the palm normal. The
        // sign is settled from the rest-pose finger bases rather than world X:
        // positive always fans toward the little finger, even when a hand or the
        // whole character is rotated. A single little-minus-index vector gives
        // the semantic lateral direction for every proximal phalanx.
        let index = p.finger_root(Finger::Index, side);
        let little = p.finger_root(Finger::Little, side);
        let mut toward_little = match (index, little) {
            (Some(index), Some(little)) => {
                let mut v = graph.world_position(little);
                v.sub(&graph.world_position(index));
                Some(v)
            }
            _ => None,
        };
        if let Some(v) = toward_little.as_mut() {
            v.add_scaled_vector(&palm_normal, -v.dot(&palm_normal));
            if v.length_sq() > 1e-10 {
                v.normalize();
            } else {
                toward_little = None;
            }
        }

        for f in Finger::ALL {
            let chain = p.finger(f, side);
            let dirs = &p.finger_rest_dir[side as usize * 5 + f as usize];
            for (i, &bone) in chain.iter().enumerate() {
                let bone_q = graph.world_quaternion(bone);
                let mut inverse = bone_q;
                inverse.invert();
                let mut n_local = palm_normal;
                n_local.apply_quaternion(&inverse).normalize();
                let dir = dirs.get(i).copied().unwrap_or(Vec3::new(0.0, 1.0, 0.0));

                if f == Finger::Thumb {
                    let mut dir_world = dir;
                    dir_world.apply_quaternion(&bone_q).normalize();
                    let mut fold = Vec3::default();
                    fold.cross_vectors(&dir, &n_local);
                    if fold.length_sq() > 1e-10 {
                        fold.normalize();
                    } else {
                        fold.set(1.0, 0.0, 0.0);
                    }
                    // Turning about the fold lifts the tip toward the palm, which is what
                    // palmar abduction is.
                    if i == 0 {
                        splay_axes[bone as usize] = Some(fold);
                    }
                    // Flexion sweeps the tip toward the little finger; the tilt toward
                    // the fold stays on the palm side, so only the normal term flips.
                    let mut sweep = Vec3::default();
                    sweep.cross_vectors(&palm_normal, &dir_world);
                    let lean = if toward_little.is_some_and(|t| sweep.dot(&t) < 0.0) {
                        -1.0
                    } else {
                        1.0
                    };
                    let mut hinge = n_local;
                    hinge
                        .multiply_scalar(lean * cos(THUMB_FLEXION_TILT))
                        .add_scaled_vector(&fold, sin(THUMB_FLEXION_TILT))
                        .normalize();
                    axes[bone as usize] = Some(hinge);
                    if i == 2 {
                        // A turn about the phalanx mirrors with the hand, so ask which way folds the tip
                        // further toward the palm side rather than assuming a sign.
                        let folded = |sign: f64| {
                            let mut v = dir;
                            v.apply_axis_angle(&hinge, 1.0)
                                .apply_axis_angle(&dir, sign * THUMB_OPPOSITION)
                                .dot(&n_local)
                        };
                        opposition_sign[bone as usize] = Some(if folded(1.0) <= folded(-1.0) {
                            1.0
                        } else {
                            -1.0
                        });
                    }
                    continue;
                }

                if i == 0
                    && let Some(toward_little) = toward_little
                {
                    let mut splay = n_local;
                    let mut dir_world = dir;
                    dir_world.apply_quaternion(&bone_q).normalize();
                    let mut positive_turn = Vec3::default();
                    positive_turn.cross_vectors(&palm_normal, &dir_world);
                    if positive_turn.dot(&toward_little) < 0.0 {
                        splay.negate();
                    }
                    splay_axes[bone as usize] = Some(splay);
                }

                let mut axis = Vec3::default();
                axis.cross_vectors(&dir, &n_local);
                if axis.length_sq() > 1e-10 {
                    axis.normalize();
                } else {
                    axis.set(1.0, 0.0, 0.0);
                }

                // The cross product gives the hinge line but not which way it turns.
                // Here the test is not marginal — the palm side is already known, so
                // ask directly whether the tip moves toward it.
                let seg_len = chain
                    .get(i + 1)
                    .map_or(1.0, |&next| graph.local_position(next).length());
                let at = graph.world_position(bone);
                let mut along = dir;
                along.apply_quaternion(&bone_q);
                let mut before = at;
                before.add_scaled_vector(&along, seg_len);
                let mut spun = dir;
                spun.apply_quaternion(Quat::default().set_from_axis_angle(&axis, 0.4))
                    .apply_quaternion(&bone_q);
                let mut after = at;
                after.add_scaled_vector(&spun, seg_len);
                if after.sub(&before).dot(&palm_normal) < 0.0 {
                    axis.negate();
                }

                axes[bone as usize] = Some(axis);
            }
        }
    }
    FingerAxes {
        axes,
        splay_axes,
        palm_local,
        opposition_sign,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anatomy::arm::ArmAnatomy;
    use crate::anatomy::joints::JointTable;
    use crate::rig::hands::Hands;
    use crate::rig::testkit::{avatar, bone, close, euler};
    use core::f64::consts::PI;

    // Axes leave `normalize`, and the curl angles come straight from the table.
    const EXACT: f64 = 1e-9;

    struct Built {
        graph: Graph,
        profile: Profile,
        axes: FingerAxes,
        anat: ArmAnatomy,
    }

    /// The base avatar with `edit` applied to its bind before anything is derived from it.
    fn built(edit: impl FnOnce(&mut Graph, &mut Profile)) -> Built {
        let (mut graph, mut profile) = avatar();
        edit(&mut graph, &mut profile);
        graph.update_matrix_world(0, true);
        let axes = solve_finger_axes(&profile, &mut graph);
        let mut anat = ArmAnatomy::new(&profile, &mut graph);
        assert!(anat.update(&mut graph));
        Built {
            graph,
            profile,
            axes,
            anat,
        }
    }

    fn hand(p: &Profile, side: Side) -> u32 {
        bone(p, BoneSlot::arm(ArmSlot::Hand, side))
    }

    /// The palm normal in world space, for a hand that has not been posed.
    fn palm_world(b: &mut Built, side: Side) -> Vec3 {
        let mut v = b.axes.palm_local[side as usize].unwrap();
        v.apply_quaternion(&b.graph.world_quaternion(hand(&b.profile, side)))
            .normalize();
        v
    }

    fn in_plane(v: &Vec3, across: &Vec3) -> Vec3 {
        let mut out = *v;
        out.add_scaled_vector(across, -v.dot(across));
        out
    }

    /// A bind pose with the wrists rolled in mirror image, so the palm normals carry
    /// a lateral component and the mirror test is not satisfied by a vector that
    /// happens to be straight down the midline plane.
    fn rolled(g: &mut Graph, p: &mut Profile) {
        for side in Side::BOTH {
            let angle = if side == Side::L { 0.5 } else { -0.5 };
            let q = *Quat::default().set_from_axis_angle(&Vec3::new(0.0, 0.0, 1.0), angle);
            g.set_local_quaternion(hand(p, side), &q);
        }
    }

    /// Nearly horizontal palm normals expose world-up sign guesses after a root turn.
    fn near_horizontal(rotation: Quat, missing_middle: Option<Side>) -> Built {
        built(|g, p| {
            for side in Side::BOTH {
                let z = if side == Side::L { 0.7 } else { -0.7 };
                g.set_local_quaternion(hand(p, side), &euler(PI / 2.0 - 0.01, 0.0, z));
            }
            g.set_local_quaternion(0, &rotation);
            if let Some(side) = missing_middle {
                p.finger_bones[side as usize * 5 + Finger::Middle as usize].clear();
            }
        })
    }

    #[test]
    fn gives_every_finger_bone_a_unit_axis() {
        let b = built(|_, _| {});
        let mut bones = 0;
        for side in Side::BOTH {
            for f in Finger::ALL {
                let chain = b.profile.finger(f, side);
                assert!(!chain.is_empty());
                for &bone in chain {
                    let axis = b.axes.axis(bone).expect("an axis");
                    assert!((axis.length() - 1.0).abs() < EXACT);
                    bones += 1;
                }
            }
        }
        assert_eq!(b.axes.axes.iter().flatten().count(), bones);
    }

    #[test]
    fn derives_the_same_axes_standalone_as_the_hands_hold() {
        let mut b = built(|_, _| {});
        let hands = Hands::new(&b.profile, &mut b.graph);
        assert_eq!(hands.fingers.axes.len(), b.axes.axes.len());
        for (held, axis) in hands.fingers.axes.iter().zip(&b.axes.axes) {
            match (held, axis) {
                (Some(h), Some(a)) => assert!(h.distance_to(a) < EXACT),
                (None, None) => {}
                _ => panic!("the axes differ in which bones they cover"),
            }
        }
        for (held, axis) in hands.fingers.splay_axes.iter().zip(&b.axes.splay_axes) {
            match (held, axis) {
                (Some(h), Some(a)) => assert!(h.distance_to(a) < EXACT),
                (None, None) => {}
                _ => panic!("the splay axes differ in which bones they cover"),
            }
        }
    }

    #[test]
    fn mirrors_the_two_palms_about_the_midline_instead_of_deciding_each_alone() {
        let mut b = built(|_, _| {});
        let left = palm_world(&mut b, Side::L);
        let right = palm_world(&mut b, Side::R);
        // The character's own right, so "mirrored" is stated against the body and
        // not against a world axis.
        assert!(b.anat.update(&mut b.graph));
        let across = *b.anat.right();
        // Mirroring negates the component across the midline and leaves the rest.
        close(right.dot(&across), -left.dot(&across), 9);
        assert!(in_plane(&right, &across).distance_to(&in_plane(&left, &across)) < EXACT);
        // Not 180 degrees apart, which is what deciding the sign per hand produced.
        assert!(right.dot(&left) > 0.0);
    }

    #[test]
    fn mirrors_them_on_a_bind_whose_wrists_are_rolled_where_the_sign_matters() {
        let mut b = built(rolled);
        let left = palm_world(&mut b, Side::L);
        let right = palm_world(&mut b, Side::R);
        assert!(b.anat.update(&mut b.graph));
        let across = *b.anat.right();
        // The lateral component is real here, so a hand whose sign was guessed the
        // other way could not pass by symmetry.
        assert!(left.dot(&across).abs() > 0.3);
        close(right.dot(&across), -left.dot(&across), 9);
        assert!(in_plane(&right, &across).distance_to(&in_plane(&left, &across)) < EXACT);
        // Bind poses hang the palms down, and both of them do.
        assert!(left.dot(b.anat.up()) < 0.0);
        assert!(right.dot(b.anat.up()) < 0.0);
    }

    #[test]
    fn keeps_near_horizontal_bind_palms_in_the_body_frame_after_a_root_turn() {
        for rotation in [euler(0.0, 0.0, 0.6), euler(0.9, 0.7, -0.5)] {
            let mut baseline = near_horizontal(Quat::default(), None);
            let mut rotated = near_horizontal(rotation, None);
            assert!(rotated.anat.update(&mut rotated.graph));
            let palms = [
                palm_world(&mut rotated, Side::L),
                palm_world(&mut rotated, Side::R),
            ];
            let (up, right) = (*rotated.anat.up(), *rotated.anat.right());
            for side in Side::BOTH {
                let mut expected = palm_world(&mut baseline, side);
                expected.apply_quaternion(&rotation);
                let palm = palms[side as usize];
                assert!(
                    palm.distance_to(&expected) < EXACT,
                    "{side:?} rotation covariance"
                );
                assert!(palm.dot(&up) < 0.0, "{side:?} downward sign");
                assert!(expected.dot(&up).abs() < 0.01);
                assert!(expected.dot(&right).abs() > 0.6);
            }
            let mut mirrored = palms[0];
            mirrored.add_scaled_vector(&right, -2.0 * palms[0].dot(&right));
            assert!(palms[1].distance_to(&mirrored) < EXACT);
        }
    }

    #[test]
    fn uses_the_actual_near_horizontal_palm_for_radial_and_ulnar_limits() {
        for side in Side::BOTH {
            let mut b = near_horizontal(euler(0.0, 0.0, 0.6), None);
            let p = b.profile.clone();
            let mut wp = |n: u32| b.graph.world_position(n);
            let (h, middle, index, little) = (
                wp(hand(&p, side)),
                wp(p.finger_root(Finger::Middle, side).unwrap()),
                wp(p.finger_root(Finger::Index, side).unwrap()),
                wp(p.finger_root(Finger::Little, side).unwrap()),
            );
            let mut along = middle;
            along.sub(&h).normalize();
            let mut toward_thumb = index;
            toward_thumb.sub(&little);
            let d = -toward_thumb.dot(&along);
            toward_thumb.add_scaled_vector(&along, d).normalize();
            let palm = palm_world(&mut b, side);
            let mut radial = Vec3::default();
            radial
                .cross_vectors(&palm, &along)
                .multiply_scalar(b.anat.radial_sign[side as usize])
                .normalize();
            close(radial.dot(&toward_thumb), 1.0, 9);

            let [ulnar_limit, radial_limit] = JointTable::human().wrist.deviation.max;
            let asked = radial_limit - ulnar_limit;
            for (sign, limit) in [(1.0, radial_limit), (-1.0, -ulnar_limit)] {
                let mut direction = along;
                direction
                    .multiply_scalar(cos(asked))
                    .add_scaled_vector(&toward_thumb, sign * sin(asked));
                b.anat
                    .clamp_wrist(side, &along, &mut direction, Some(&palm));
                assert!(
                    (direction.angle_to(&along) - limit).abs() < EXACT,
                    "sign {sign}"
                );
                assert!(direction.dot(&toward_thumb) * sign > 0.0);
            }
        }
    }

    #[test]
    fn uses_body_up_for_the_remaining_palm_when_one_middle_is_missing() {
        for missing in Side::BOTH {
            let remaining = if missing == Side::L { Side::R } else { Side::L };
            let mut b = near_horizontal(euler(0.0, 0.0, 0.6), Some(missing));
            assert!(b.anat.update(&mut b.graph));
            assert_eq!(b.axes.palm_local[missing as usize], None);
            assert_eq!(b.anat.radial_sign[missing as usize], 1.0);
            let up = *b.anat.up();
            assert!(palm_world(&mut b, remaining).dot(&up) < 0.0);
        }
    }

    #[test]
    fn reads_each_palm_from_the_hand_not_from_which_way_is_up() {
        // Arms hanging just past vertical with the palms facing the thighs, so each
        // palm tips slightly upward and nothing about world up says which side it is.
        let mut b = built(|g, p| {
            for side in Side::BOTH {
                let angle = if side == Side::L {
                    PI / 2.0 + 0.1
                } else {
                    -PI / 2.0 - 0.1
                };
                let q = *Quat::default().set_from_axis_angle(&Vec3::new(0.0, 0.0, 1.0), angle);
                g.set_local_quaternion(bone(p, BoneSlot::arm(ArmSlot::UpperArm, side)), &q);
            }
        });
        assert!(b.anat.update(&mut b.graph));
        let palms = rest_palm_normals(&b.profile, &mut b.graph);
        for side in Side::BOTH {
            let upper = bone(&b.profile, BoneSlot::arm(ArmSlot::UpperArm, side));
            // Down in the unrotated bind, carried round with the arm.
            let mut expected = Vec3::new(0.0, -1.0, 0.0);
            expected.apply_quaternion(&b.graph.world_quaternion(upper));
            let mut inward = *b.anat.right();
            inward.multiply_scalar(if side == Side::L { 1.0 } else { -1.0 });
            let palm = palms[side as usize].unwrap();
            assert!(expected.dot(b.anat.up()) > 0.05, "{side:?} palm tips up");
            assert!(palm.distance_to(&expected) < EXACT, "{side:?} palm");
            assert!(palm.dot(&inward) > 0.99, "{side:?} faces the body");
        }
    }

    #[test]
    fn derives_splay_axes_for_proximal_bones_only() {
        let b = built(|_, _| {});
        let mut proximal = 0;
        for side in Side::BOTH {
            for f in Finger::ALL {
                let chain = b.profile.finger(f, side);
                let axis = b.axes.splay_axis(chain[0]).expect("a splay axis");
                assert!((axis.length() - 1.0).abs() < EXACT);
                proximal += 1;
                for &bone in &chain[1..] {
                    assert!(
                        b.axes.splay_axis(bone).is_none(),
                        "{f:?}.{side:?} distal splay"
                    );
                }
            }
        }
        assert_eq!(b.axes.splay_axes.iter().flatten().count(), proximal);
    }
}
