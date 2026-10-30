//! `rig/hands.ts`: the fingers.
//!
//! Kept apart from the arm chain because nothing about them is aimed: a finger
//! is a curl about an axis this rig worked out once at load, and the arm's whole
//! apparatus of world directions, palm rolls and anatomical clamping has no
//! bearing on it. The thumb's distal hinge also turns about the phalanx with the
//! curl (opposition); the stored axes do not change.
//!
//! The TS `Hands` holds the profile, the joint table and `restOf`; here they are passed to each
//! call, as the other rig modules take them.

use super::finger_axes::{FingerAxes, solve_finger_axes};
use crate::anatomy::joints::{Digit, JointTable};
use crate::anatomy::strain::{finger_curl, thumb_opposition};
use crate::math::{Quat, Vec3};
use crate::profile::{Finger, Profile, Side};
use crate::scene::graph::Graph;

/// `FingerSpec`: a curl (or splay) per finger in [`Finger`] order, `None` where the spec omits it.
pub type FingerSpec = [Option<f64>; 5];

/// `{}`: a spec naming no finger.
pub const EMPTY_SPEC: FingerSpec = [None; 5];

// hands.ts composeFingerRotation
//
// Compose the bind rotation with the same optional splay-turn-curl order everywhere.
#[allow(clippy::too_many_arguments)]
pub fn compose_finger_rotation<'q>(
    out: &'q mut Quat,
    rest: &Quat,
    curl_axis: &Vec3,
    curl: f64,
    splay_axis: Option<&Vec3>,
    spread: f64,
    turn_axis: Option<&Vec3>,
    turn: f64,
    scratch: &mut Quat,
) -> &'q mut Quat {
    out.copy(rest);
    if let Some(splay_axis) = splay_axis
        && spread != 0.0
    {
        out.multiply(scratch.set_from_axis_angle(splay_axis, spread));
    }
    if let Some(turn_axis) = turn_axis
        && turn != 0.0
    {
        out.multiply(scratch.set_from_axis_angle(turn_axis, turn));
    }
    out.multiply(scratch.set_from_axis_angle(curl_axis, curl))
}

/// The joint table's rows for a finger: the thumb has its own.
fn digit(joints: &JointTable, finger: Finger) -> &Digit {
    if finger == Finger::Thumb {
        &joints.thumb
    } else {
        &joints.finger
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hands {
    /// Curl axis, splay axis, palm normal in hand-bone space, and the opposition sign.
    pub fingers: FingerAxes,
}

impl Hands {
    // hands.ts Hands.constructor
    pub fn new(p: &Profile, graph: &mut Graph) -> Hands {
        Hands {
            fingers: solve_finger_axes(p, graph),
        }
    }

    /// `palmLocal`: the palm normal in hand-bone space.
    pub fn palm_local(&self) -> &[Option<Vec3>; 2] {
        &self.fingers.palm_local
    }

    // hands.ts Hands.curlFinger
    //
    // Curl a finger. 0 = straight, 1 = the joint's natural full flexion.
    //
    // One number per finger is the right control — nobody flexes a single
    // interphalangeal joint on purpose — but the three segments do not share a
    // range, and the taper that used to spread one number across them was
    // guessed. It had the middle joint travelling 102 degrees and the knuckle 89,
    // which is roughly right, and the fingertip 93, which is 20 degrees more than
    // a fingertip has. Each joint now takes its own range from the joint table.
    //
    // Above 1 is the strained band: available, and nothing reaches it by
    // accident. Below 0 is hyperextension, which the knuckles have and the middle
    // joints do not — also from the table, rather than a blanket floor of zero.
    //
    // `spread` is the knuckle's splay, kept as `curlHand` would apply it.
    #[allow(clippy::too_many_arguments)]
    pub fn curl_finger(
        &self,
        p: &Profile,
        joints: &JointTable,
        graph: &mut Graph,
        rest_of: &dyn Fn(u32) -> Quat,
        name: Finger,
        side: Side,
        amount: f64,
        spread: f64,
    ) {
        let chain = p.finger(name, side);
        let joints = digit(joints, name);
        let mut scratch = Quat::default();
        for (i, &bone) in chain.iter().enumerate() {
            let Some(axis) = self.fingers.axis(bone) else {
                continue;
            };
            let (turn_axis, turn) = self.opposition(p, name, side, bone, i, amount);
            let mut q = graph.local_quaternion(bone);
            compose_finger_rotation(
                &mut q,
                &rest_of(bone),
                axis,
                finger_curl(joints, i, amount),
                if i == 0 {
                    self.fingers.splay_axis(bone)
                } else {
                    None
                },
                if i == 0 { spread } else { 0.0 },
                turn_axis.as_ref(),
                turn,
                &mut scratch,
            );
            graph.set_local_quaternion(bone, &q);
        }
    }

    // hands.ts Hands.opposition
    //
    // The turn axis and angle of a bone: only the thumb's distal hinge turns.
    fn opposition(
        &self,
        p: &Profile,
        name: Finger,
        side: Side,
        bone: u32,
        i: usize,
        amount: f64,
    ) -> (Option<Vec3>, f64) {
        if name != Finger::Thumb || i != 2 {
            return (None, 0.0);
        }
        let sign = self
            .fingers
            .opposition_sign
            .get(bone as usize)
            .copied()
            .flatten()
            .unwrap_or(1.0);
        let dir = p.finger_rest_dir[side as usize * 5 + Finger::Thumb as usize]
            .get(2)
            .copied();
        (dir, sign * thumb_opposition(amount))
    }

    // hands.ts Hands.curlHand
    #[allow(clippy::too_many_arguments)]
    pub fn curl_hand(
        &self,
        p: &Profile,
        joints: &JointTable,
        graph: &mut Graph,
        rest_of: &dyn Fn(u32) -> Quat,
        side: Side,
        spec: &FingerSpec,
        spread: &FingerSpec,
    ) {
        let mut scratch = Quat::default();
        for f in Finger::ALL {
            let chain = p.finger(f, side);
            let digit = digit(joints, f);
            let amount = spec[f as usize].unwrap_or(0.0);
            for (i, &bone) in chain.iter().enumerate() {
                let Some(curl_axis) = self.fingers.axis(bone) else {
                    continue;
                };
                let (turn_axis, turn) = self.opposition(p, f, side, bone, i, amount);
                let mut q = graph.local_quaternion(bone);
                compose_finger_rotation(
                    &mut q,
                    &rest_of(bone),
                    curl_axis,
                    finger_curl(digit, i, amount),
                    if i == 0 {
                        self.fingers.splay_axis(bone)
                    } else {
                        None
                    },
                    if i == 0 {
                        spread[f as usize].unwrap_or(0.0)
                    } else {
                        0.0
                    },
                    turn_axis.as_ref(),
                    turn,
                    &mut scratch,
                );
                graph.set_local_quaternion(bone, &q);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anatomy::joints::{THUMB_OPPOSITION, THUMB_OPPOSITION_CURL};
    use crate::math::f::{cos, sin};
    use crate::profile::{ArmSlot, BoneSlot};
    use crate::rig::testkit::{avatar, bone, close, rest_of, rest_table};

    const EXACT: f64 = 1e-9;
    const THUMB_TILT: f64 = (20.0 * core::f64::consts::PI) / 180.0;
    const FOUR_FINGERS: [Finger; 4] = [Finger::Index, Finger::Middle, Finger::Ring, Finger::Little];

    struct Built {
        graph: Graph,
        profile: Profile,
        hands: Hands,
        rest: Vec<f64>,
        joints: JointTable,
    }

    fn built() -> Built {
        let (mut graph, profile) = avatar();
        let rest = rest_table(&graph);
        let hands = Hands::new(&profile, &mut graph);
        let joints = profile.anatomy.clone().unwrap_or_else(JointTable::human);
        Built {
            graph,
            profile,
            hands,
            rest,
            joints,
        }
    }

    impl Built {
        /// `rig.reset()` for the fingers: every bone back to its rest orientation.
        fn reset(&mut self) {
            self.graph.quaternion.copy_from_slice(&self.rest);
            self.graph.update_matrix_world(0, true);
        }

        fn curl_finger(&mut self, name: Finger, side: Side, amount: f64, spread: f64) {
            let rest = rest_of(&self.rest);
            self.hands.curl_finger(
                &self.profile,
                &self.joints,
                &mut self.graph,
                &rest,
                name,
                side,
                amount,
                spread,
            );
        }

        fn curl_hand(&mut self, side: Side, spec: &FingerSpec, spread: &FingerSpec) {
            let rest = rest_of(&self.rest);
            self.hands.curl_hand(
                &self.profile,
                &self.joints,
                &mut self.graph,
                &rest,
                side,
                spec,
                spread,
            );
        }

        /// The finger tip's world position after a full update.
        fn tip(&mut self, f: Finger, side: Side) -> Vec3 {
            self.graph.update_matrix_world(0, true);
            let chain = self.profile.finger(f, side);
            let tip = chain[chain.len() - 1];
            self.graph.world_position(tip)
        }

        /// The palm normal in world space, for a hand that has not been posed.
        fn palm_world(&mut self, side: Side) -> Vec3 {
            let hand = bone(&self.profile, BoneSlot::arm(ArmSlot::Hand, side));
            let mut v = self.hands.palm_local()[side as usize].unwrap();
            v.apply_quaternion(&self.graph.world_quaternion(hand))
                .normalize();
            v
        }

        /// How far a bone has been turned away from its rest orientation.
        fn turned_by(&self, b: u32) -> f64 {
            let mut q = rest_of(&self.rest)(b);
            q.invert().multiply(&self.graph.local_quaternion(b));
            q.angle_to(&Quat::default())
        }

        fn turned(&self, f: Finger, side: Side) -> Vec<f64> {
            self.profile
                .finger(f, side)
                .iter()
                .map(|&b| self.turned_by(b))
                .collect()
        }

        /// Palm-plane direction from the index base to the little base.
        fn toward_little(&mut self, palm: &Vec3, side: Side) -> Vec3 {
            let index = self.profile.finger_root(Finger::Index, side).unwrap();
            let little = self.profile.finger_root(Finger::Little, side).unwrap();
            let mut v = self.graph.world_position(little);
            v.sub(&self.graph.world_position(index));
            let d = -v.dot(palm);
            v.add_scaled_vector(palm, d).normalize();
            v
        }
    }

    fn spec(values: &[(Finger, f64)]) -> FingerSpec {
        let mut out = EMPTY_SPEC;
        for &(f, v) in values {
            out[f as usize] = Some(v);
        }
        out
    }

    #[test]
    fn moves_the_fingertip_toward_the_palm_side_not_away_from_it() {
        let mut b = built();
        for side in Side::BOTH {
            let palm = b.palm_world(side);
            for f in FOUR_FINGERS {
                b.reset();
                let before = b.tip(f, side);
                b.curl_finger(f, side, 0.8, 0.0);
                let mut moved = b.tip(f, side);
                moved.sub(&before);
                assert!(moved.length() > 1e-3, "{f:?}.{side:?} moved");
                assert!(moved.dot(&palm) > 0.0, "{f:?}.{side:?} toward palm");
            }
        }
    }

    #[test]
    fn curls_the_thumb_toward_the_little_finger_rather_than_lifting_off_the_palm() {
        let mut b = built();
        let mut across = [0.0; 2];
        let mut lift = [0.0; 2];
        for side in Side::BOTH {
            let palm = b.palm_world(side);
            let little_ward = b.toward_little(&palm, side);
            b.reset();
            let before = b.tip(Finger::Thumb, side);
            b.curl_finger(Finger::Thumb, side, 1.0, 0.0);
            let mut moved = b.tip(Finger::Thumb, side);
            moved.sub(&before);
            across[side as usize] = moved.dot(&little_ward);
            lift[side as usize] = moved.dot(&palm);
            assert!(
                across[side as usize] > lift[side as usize].abs(),
                "{side:?} thumb across"
            );
        }
        close(across[0], across[1], 9);
        close(lift[0], lift[1], 9);
    }

    #[test]
    fn hinges_every_thumb_bone_about_the_palm_normal_tilted_toward_the_finger_fold() {
        let mut b = built();
        for side in Side::BOTH {
            let palm = b.palm_world(side);
            let little_ward = b.toward_little(&palm, side);
            let chain = b.profile.finger(Finger::Thumb, side).to_vec();
            let dirs = b.profile.finger_rest_dir[side as usize * 5].clone();
            // The synthetic tip bone has no child, so its direction is the +y fallback,
            // parallel to the palm normal and carrying no fold.
            for (i, &bone) in chain[..chain.len() - 1].iter().enumerate() {
                let bone_q = b.graph.world_quaternion(bone);
                let mut inverse = bone_q;
                inverse.invert();
                let mut n = palm;
                n.apply_quaternion(&inverse);
                let dir = dirs[i];
                // The finger hinge: turning about it lifts the tip toward the palm.
                let mut fold = Vec3::default();
                fold.cross_vectors(&dir, &n).normalize();
                let axis = *b.hands.fingers.axis(bone).unwrap();
                close(axis.dot(&fold), sin(THUMB_TILT), 9);
                // Which way the normal component points is settled by the sweep toward
                // the little finger; the tilt toward the fold is fixed.
                let mut sweep = Vec3::default();
                sweep.cross_vectors(&axis, &dir).apply_quaternion(&bone_q);
                assert!(sweep.dot(&little_ward) > 0.0, "{side:?} bone {i} sweep");
                close(axis.dot(&n).abs(), cos(THUMB_TILT), 9);
            }
        }
    }

    #[test]
    fn turns_only_the_distal_hinge_about_the_phalanx_once_the_thumb_has_closed() {
        let mut b = built();
        let q = |a: &Vec3, r: f64| *Quat::default().set_from_axis_angle(a, r);
        for side in Side::BOTH {
            let chain = b.profile.finger(Finger::Thumb, side).to_vec();
            let dir = b.profile.finger_rest_dir[side as usize * 5][2];
            // The turn is signed per hand: whichever sign folds the tip further toward the palm side.
            let palm = b.palm_world(side);
            let axis2 = *b.hands.fingers.axis(chain[2]).unwrap();
            let mut tip_dot = |sign: f64| {
                let mut local = dir;
                local
                    .apply_axis_angle(&axis2, 1.0)
                    .apply_axis_angle(&dir, sign * THUMB_OPPOSITION);
                b.reset();
                local
                    .apply_quaternion(&b.graph.world_quaternion(chain[2]))
                    .dot(&palm)
            };
            let turn_sign = if tip_dot(1.0) <= tip_dot(-1.0) {
                1.0
            } else {
                -1.0
            };
            for curl in [THUMB_OPPOSITION_CURL[0], 1.0] {
                b.reset();
                b.curl_hand(side, &spec(&[(Finger::Thumb, curl)]), &EMPTY_SPEC);
                for (i, &bone) in chain.iter().enumerate() {
                    let axis = b.hands.fingers.axis(bone).unwrap();
                    let hinge = q(axis, finger_curl(&b.joints.thumb, i, curl));
                    let mut expected = rest_of(&b.rest)(bone);
                    if i == 2 && curl == 1.0 {
                        expected.multiply(&q(&dir, turn_sign * THUMB_OPPOSITION));
                    }
                    expected.multiply(&hinge);
                    let got = b.graph.local_quaternion(bone);
                    let sign = if got.dot(&expected) < 0.0 { -1.0 } else { 1.0 };
                    for (v, e) in [got.x, got.y, got.z, got.w]
                        .iter()
                        .zip([expected.x, expected.y, expected.z, expected.w])
                    {
                        close(*v, sign * e, 9);
                    }
                }
            }
            // curlFinger agrees with curlHand.
            let via_hand = b.graph.local_quaternion(chain[2]);
            b.reset();
            b.curl_finger(Finger::Thumb, side, 1.0, 0.0);
            assert!(b.graph.local_quaternion(chain[2]).angle_to(&via_hand) < 1e-6);
        }
    }

    #[test]
    fn splays_a_positive_thumb_spread_toward_the_palm_at_the_carpometacarpal_bone_only() {
        let mut b = built();
        for side in Side::BOTH {
            let palm = b.palm_world(side);
            let chain = b.profile.finger(Finger::Thumb, side).to_vec();
            b.reset();
            let before = b.tip(Finger::Thumb, side);
            b.curl_hand(side, &EMPTY_SPEC, &spec(&[(Finger::Thumb, 0.3)]));
            let mut moved = b.tip(Finger::Thumb, side);
            moved.sub(&before);
            assert!(moved.dot(&palm) > 1e-3, "{side:?} thumb splay toward palm");
            close(b.turned_by(chain[0]), 0.3, 9);
            for &bone in &chain[1..] {
                assert!(b.turned_by(bone) < EXACT);
            }
        }
    }

    #[test]
    fn leaves_every_bone_at_its_rest_orientation_at_curl_0() {
        let mut b = built();
        for side in Side::BOTH {
            for f in Finger::ALL {
                b.curl_finger(f, side, 0.0, 0.0);
                for angle in b.turned(f, side) {
                    assert!(angle < EXACT);
                }
            }
        }
    }

    #[test]
    fn reaches_the_top_of_each_joint_free_band_at_curl_1_and_the_segments_differ() {
        let mut b = built();
        let d = JointTable::human().finger;
        let want = [
            d.proximal.unwrap().free[1],
            d.intermediate.unwrap().free[1],
            d.distal.unwrap().free[1],
        ];
        b.curl_finger(Finger::Index, Side::L, 1.0, 0.0);
        let got = b.turned(Finger::Index, Side::L);
        assert_eq!(got.len(), 3);
        for i in 0..3 {
            assert!((got[i] - want[i]).abs() < EXACT, "segment {i}");
        }
        // Not one number spread across three segments by a taper: the knuckle, the
        // middle joint and the tip each travel their own range.
        assert!((got[0] - got[1]).abs() > 0.1);
        assert!((got[1] - got[2]).abs() > 0.1);
        assert!((got[0] - got[2]).abs() > 0.1);
    }

    #[test]
    fn gives_a_thumb_its_own_table_rather_than_the_finger_one() {
        let mut b = built();
        let table = JointTable::human();
        // At the start of the opposition ramp, where the distal hinge has not turned yet.
        let curl = THUMB_OPPOSITION_CURL[0];
        let t = table.thumb;
        let want: Vec<f64> = [t.proximal, t.intermediate, t.distal]
            .iter()
            .map(|d| d.unwrap().free[1] * curl)
            .collect();
        b.curl_finger(Finger::Thumb, Side::L, curl, 0.0);
        let got = b.turned(Finger::Thumb, Side::L);
        for i in 0..got.len() {
            assert!((got[i] - want[i]).abs() < EXACT, "thumb segment {i}");
        }
        let finger = table.finger.proximal.unwrap().free[1] * curl;
        assert!((want[0] - finger).abs() >= 0.0005);
    }

    #[test]
    fn bounds_the_strained_band_above_1_at_each_joint_hard_stop() {
        let mut b = built();
        let d = JointTable::human().finger;
        let stops = [
            d.proximal.unwrap().max[1],
            d.intermediate.unwrap().max[1],
            d.distal.unwrap().max[1],
        ];
        b.curl_finger(Finger::Index, Side::L, 1.0, 0.0);
        let at_one = b.turned(Finger::Index, Side::L);
        b.curl_finger(Finger::Index, Side::L, 5.0, 0.0);
        let beyond = b.turned(Finger::Index, Side::L);
        for i in 0..3 {
            assert!((beyond[i] - stops[i]).abs() < EXACT, "segment {i} stop");
            // The strained band is above the free one and is reachable, not free.
            assert!(beyond[i] > at_one[i]);
        }
    }

    #[test]
    fn hyperextends_only_the_joints_the_table_gives_hyperextension_to() {
        let mut b = built();
        let d = JointTable::human().finger;
        b.curl_finger(Finger::Index, Side::L, -5.0, 0.0);
        let got = b.turned(Finger::Index, Side::L);
        // The knuckle and the tip go back; the middle joint has no floor below zero.
        assert!((got[0] - d.proximal.unwrap().max[0].abs()).abs() < EXACT);
        assert!(got[1] < EXACT);
        assert!((got[2] - d.distal.unwrap().max[0].abs()).abs() < EXACT);
        assert_eq!(d.intermediate.unwrap().max[0], 0.0);
    }

    #[test]
    fn does_nothing_for_a_finger_the_rig_does_not_have() {
        let mut b = built();
        b.profile.finger_bones[Side::R as usize * 5 + Finger::Ring as usize].clear();
        let before = b.graph.quaternion.clone();
        b.curl_finger(Finger::Ring, Side::R, 1.0, 0.0);
        assert_eq!(b.graph.quaternion, before);
    }

    #[test]
    fn drives_each_named_finger_and_leaves_the_unnamed_ones_at_rest() {
        let mut b = built();
        b.reset();
        b.curl_hand(
            Side::R,
            &spec(&[(Finger::Index, 1.0), (Finger::Middle, 0.5)]),
            &EMPTY_SPEC,
        );
        let index = b.turned(Finger::Index, Side::R);
        let middle = b.turned(Finger::Middle, Side::R);
        for i in 0..index.len() {
            assert!(index[i] > 0.1);
            // Half the curl is half the angle, so the two hands' fingers are not
            // sharing one number.
            assert!((middle[i] - index[i] * 0.5).abs() < EXACT);
        }
        for f in [Finger::Thumb, Finger::Ring, Finger::Little] {
            for angle in b.turned(f, Side::R) {
                assert!(angle < EXACT);
            }
        }
    }

    #[test]
    fn leaves_the_other_hand_alone() {
        let mut b = built();
        b.reset();
        b.curl_hand(Side::L, &[Some(1.0); 5], &EMPTY_SPEC);
        for f in Finger::ALL {
            assert!(b.turned(f, Side::L).iter().any(|&a| a > 0.1));
            for angle in b.turned(f, Side::R) {
                assert!(angle < EXACT);
            }
        }
    }

    #[test]
    fn fans_a_positive_spread_toward_the_little_finger_on_both_hands() {
        let mut b = built();
        let mut displacement = [0.0; 2];
        let segment = |b: &mut Built, side: Side| {
            let chain = b.profile.finger(Finger::Index, side).to_vec();
            b.graph.update_world_matrix(chain[0], true, false, false);
            b.graph.update_world_matrix(chain[1], true, false, false);
            let mut v = b.graph.world_position(chain[1]);
            v.sub(&b.graph.world_position(chain[0])).normalize();
            v
        };
        for side in Side::BOTH {
            b.reset();
            let index = b.profile.finger_root(Finger::Index, side).unwrap();
            let little = b.profile.finger_root(Finger::Little, side).unwrap();
            let mut toward_little = b.graph.world_position(little);
            toward_little
                .sub(&b.graph.world_position(index))
                .normalize();
            let before = segment(&mut b, side);
            b.curl_hand(
                side,
                &EMPTY_SPEC,
                &spec(&[(Finger::Index, 0.4), (Finger::Little, 0.4)]),
            );
            b.graph.update_matrix_world(0, true);
            let mut after = segment(&mut b, side);
            displacement[side as usize] = after.sub(&before).dot(&toward_little);
            assert!(
                displacement[side as usize] > 0.0,
                "{side:?} positive spread"
            );
        }
        close(displacement[0], displacement[1], 9);
    }

    #[test]
    fn composes_proximal_splay_before_curl_and_leaves_distal_splay_off() {
        let mut b = built();
        let chain = b.profile.finger(Finger::Index, Side::R).to_vec();
        let (spread, curl) = (0.24, 0.55);
        b.reset();
        b.curl_hand(
            Side::R,
            &spec(&[(Finger::Index, curl)]),
            &spec(&[(Finger::Index, spread)]),
        );
        let rest = rest_of(&b.rest);
        let splay_axis = *b.hands.fingers.splay_axis(chain[0]).unwrap();
        let curl_axis = *b.hands.fingers.axis(chain[0]).unwrap();
        let mut want = rest(chain[0]);
        want.multiply(Quat::default().set_from_axis_angle(&splay_axis, spread))
            .multiply(
                Quat::default()
                    .set_from_axis_angle(&curl_axis, finger_curl(&b.joints.finger, 0, curl)),
            );
        assert!(b.graph.local_quaternion(chain[0]).angle_to(&want) < 1e-7);
        for (i, &bone) in chain.iter().enumerate().skip(1) {
            let axis = *b.hands.fingers.axis(bone).unwrap();
            let mut expected = rest(bone);
            expected.multiply(
                Quat::default().set_from_axis_angle(&axis, finger_curl(&b.joints.finger, i, curl)),
            );
            assert!(
                b.graph.local_quaternion(bone).angle_to(&expected) < 1e-7,
                "segment {i}"
            );
        }
    }

    #[test]
    fn keeps_omitted_and_zero_spread_identical_to_curl_only() {
        let mut omitted = built();
        let mut zero = built();
        omitted.curl_hand(Side::R, &spec(&[(Finger::Index, 0.55)]), &EMPTY_SPEC);
        zero.curl_hand(
            Side::R,
            &spec(&[(Finger::Index, 0.55)]),
            &spec(&[(Finger::Index, 0.0)]),
        );
        for &b in omitted.profile.finger(Finger::Index, Side::R) {
            assert!(
                omitted
                    .graph
                    .local_quaternion(b)
                    .angle_to(&zero.graph.local_quaternion(b))
                    < 1e-7
            );
        }
    }
}
