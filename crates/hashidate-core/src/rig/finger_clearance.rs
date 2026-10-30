//! `rig/finger-clearance.ts`: hand frames and finger clearance.
//!
//! `handFrame` builds the orthonormal frame a hand's pointing direction and palm
//! normal make. `FingerClearance` records the shape a hand's fingers take in that
//! frame, and keeps them off the face by turning the hand and curling fingers.
//!
//! The TS module scratch, shared by every instance and both hands, is written before it is read
//! in every call, so it is local here. The TS reads the rig's `fingerClearance(side)` through a
//! callback; it depends on the profile alone, so construction takes it once per side.

use super::hand_geometry::FINGER_TIP_EXTENSION;
use super::hands::{FingerSpec, Hands};
use crate::anatomy::arm::ArmAnatomy;
use crate::anatomy::joints::JointTable;
use crate::math::f::{js_max, js_min};
use crate::math::{Mat3, Quat, Vec3, clamp};
use crate::profile::{ArmSlot, BoneSlot, Finger, Profile, Side};
use crate::scene::graph::Graph;

// finger-clearance.ts handFrame
//
// The frame a hand's pointing direction and palm normal make, as columns:
// pointing, palm, and their cross. Null when the two are parallel. Normalises
// `point` in place.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn hand_frame<'m>(point: &mut Vec3, palm: &Vec3, out: &'m mut Mat3) -> Option<&'m mut Mat3> {
    if !(point.length_sq() > 1e-12) {
        return None;
    }
    let x = *point.normalize();
    let mut y = *palm;
    y.add_scaled_vector(&x, -palm.dot(&x));
    if y.length_sq() < 1e-8 {
        return None;
    }
    y.normalize();
    let mut z = Vec3::default();
    z.cross_vectors(&x, &y);
    Some(out.set(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z))
}

/// Turns per hand per frame: the later ones catch a finger an earlier one brought in.
const FINGER_PASSES: usize = 3;
/// Damping on the fingers' turn, in squared finger half-thicknesses.
const FINGER_DAMP: f64 = 0.01;

// finger-clearance.ts fingerTurnMax
//
// Most a hand turns in a frame to clear its fingers: the span of the wrist's
// narrowest comfortable range. A correction, not a pose — a hand set inside the
// face needs its arm moved, and turned further it only folded the wrist.
fn finger_turn_max(joints: &JointTable) -> f64 {
    joints.wrist.deviation.free[1] - joints.wrist.deviation.free[0]
}

/// Trial flexion that measures a curl's lever on a finger's points.
const FINGER_CURL_PROBE: f64 = 0.05;

/// One point of a finger left in the face: where it was, which way out, how far in, which point.
#[derive(Clone, Copy, Debug, Default)]
struct Pressed {
    p: Vec3,
    n: Vec3,
    d: f64,
    i: usize,
}

/// What a clearance call needs of the rig besides the clearance itself.
pub struct FingerRig<'a> {
    pub p: &'a Profile,
    pub joints: &'a JointTable,
    pub hands: &'a Hands,
    pub rest_of: &'a dyn Fn(u32) -> Quat,
}

/// Keeps a hand's fingers off the face and records the shape they take.
#[derive(Clone, Debug, PartialEq)]
pub struct FingerClearance {
    /// Each hand's fingers as last posed, in its own frame. See `fingerShape`.
    finger_shape: [Vec<Vec3>; 2],
    /// The frame each hand reached when its shape was recorded. See `fingerFrame`.
    finger_frame: [Mat3; 2],
    palm_local: [Option<Vec3>; 2],
    /// `fingerClearance(side)`, per [`Side`].
    clearance: [f64; 2],
    /// The per-frame turn cap, from the joint table the avatar's anatomy uses.
    pub turn_max: f64,
    /// The amounts `curlClearOfFace` ended at.
    spec: FingerSpec,
}

impl FingerClearance {
    // finger-clearance.ts FingerClearance.constructor
    pub fn new(
        hands: &Hands,
        anat: &ArmAnatomy,
        finger_clearance: impl Fn(Side) -> f64,
    ) -> FingerClearance {
        FingerClearance {
            finger_shape: [Vec::new(), Vec::new()],
            finger_frame: [Mat3::default(); 2],
            palm_local: *hands.palm_local(),
            clearance: [finger_clearance(Side::L), finger_clearance(Side::R)],
            turn_max: finger_turn_max(&anat.limits),
            spec: [None; 5],
        }
    }

    // finger-clearance.ts FingerClearance.fingerShape
    //
    // The fingers as last posed, in the frame the hand reached. See `Rig.fingerShape`.
    pub fn finger_shape(&self, side: Side) -> &[Vec3] {
        &self.finger_shape[side as usize]
    }

    // finger-clearance.ts FingerClearance.fingerFrame
    //
    // The frame the hand reached when `fingerShape` was recorded. See `Rig.fingerFrame`.
    pub fn finger_frame(&self, side: Side) -> &Mat3 {
        &self.finger_frame[side as usize]
    }

    // finger-clearance.ts FingerClearance.curlClearOfFace
    //
    // Pose the fingers of `spec` clear of the face, returning the amounts they
    // ended at.
    pub fn curl_clear_of_face(
        &mut self,
        rig: &FingerRig,
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        side: Side,
        spec: &FingerSpec,
        spread: &FingerSpec,
    ) -> FingerSpec {
        for finger in Finger::ALL {
            self.spec[finger as usize] = Some(spec[finger as usize].unwrap_or(0.0));
        }
        self.clear_fingers(rig, graph, anat, side, spec, spread);
        self.spec
    }

    // finger-clearance.ts FingerClearance.noteFingers
    pub fn note_fingers(&mut self, p: &Profile, graph: &mut Graph, side: Side) {
        let hand = p.bone(BoneSlot::arm(ArmSlot::Hand, side));
        let (Some(hand), Some(palm)) = (hand, self.palm_local[side as usize]) else {
            return;
        };
        // The fingers are where the reached bones put them, even if the requested
        // direction and palm could not pass the wrist limits. Using the request as
        // the inverse frame made this shape carry the clamp error into `clearFace`
        // and feed it back into the next hand placement.
        let parent = graph.world_quaternion(hand);
        let mut g = p.rest_dir[BoneSlot::arm(ArmSlot::Hand, side) as usize]
            .expect("a resolved hand has a rest direction");
        g.apply_quaternion(&parent);
        let mut n = palm;
        n.apply_quaternion(&parent);
        let mut frame = Mat3::default();
        let Some(f) = hand_frame(&mut g, &n, &mut frame) else {
            return;
        };
        self.finger_frame[side as usize].copy(f);
        f.transpose();
        let f = *f;
        let w = graph.world_position(hand);
        let out = &mut self.finger_shape[side as usize];
        let mut k = 0;
        for finger in Finger::ALL {
            let chain = p.finger(finger, side);
            if chain.is_empty() {
                continue;
            }
            for i in 0..=chain.len() {
                let Some(point) = finger_point(graph, chain, i) else {
                    continue;
                };
                if k == out.len() {
                    out.push(Vec3::default());
                }
                out[k].copy(&point).sub(&w).apply_matrix3(&f);
                k += 1;
            }
        }
        out.truncate(k);
    }

    // finger-clearance.ts FingerClearance.clearFingers
    //
    // Keep the fingers out of the face: turn the hand about the wrist, and curl a
    // finger the turn could not free.
    //
    // The arm's escape ends the hand at the palm's contact point, deliberately —
    // see `HAND_CONTACT` — so the fingers past it went wherever the hand pointed:
    // a hand turning from behind the ear to the mouth swept them through the
    // cheek, and curled knuckles beside a cheek sank into it. Each joint and the
    // tip is held half a finger's thickness off the skin, that thickness taken
    // from the avatar's own knuckle pitch. Only the hand and its fingers move, so
    // the arm above them, and everything it reported, stands.
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    fn clear_fingers(
        &mut self,
        rig: &FingerRig,
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        side: Side,
        spec: &FingerSpec,
        spread: &FingerSpec,
    ) {
        let p = rig.p;
        let hand = p.bone(BoneSlot::arm(ArmSlot::Hand, side));
        let clear = self.clearance[side as usize];
        let parent = hand.and_then(|hand| graph.parent_of(hand));
        let (Some(face), Some(hand), Some(parent)) = (anat.face_mut(), hand, parent) else {
            return;
        };
        if !(clear > 0.0) {
            return;
        }
        let damp = FINGER_DAMP * clear * clear;
        face.refresh(graph);
        graph.update_world_matrix(hand, true, true, false);
        let w = graph.world_position(hand);
        let mut turned = 0.0;
        let mut pass = 0;
        while pass < FINGER_PASSES && turned < self.turn_max {
            // One small turn for every finger that is in, solved together. Pushing
            // the worst one alone pressed the next one in: fingers kissed to the lips
            // touch skin that faces several ways, and the hand rocked between them.
            // Each point gains (w x r).n = w.(r x n) along its normal; least squares
            // over that, damped so a point straight down the lever does not throw it.
            let mut a = Mat3::default();
            a.set(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
            let mut b = Vec3::default();
            b.set(0.0, 0.0, 0.0);
            let mut any = false;
            let mut n = Vec3::default();
            for f in Finger::ALL {
                let chain = p.finger(f, side);
                if chain.is_empty() {
                    continue;
                }
                for i in 0..=chain.len() {
                    let Some(point) = finger_point(graph, chain, i) else {
                        continue;
                    };
                    let d = face.shortfall(&point, clear, &mut n);
                    if d <= 0.0 {
                        continue;
                    }
                    any = true;
                    let mut g = point;
                    g.sub(&w).cross(&n);
                    let e = &mut a.elements;
                    e[0] += g.x * g.x;
                    e[1] += g.y * g.x;
                    e[2] += g.z * g.x;
                    e[3] += g.x * g.y;
                    e[4] += g.y * g.y;
                    e[5] += g.z * g.y;
                    e[6] += g.x * g.z;
                    e[7] += g.y * g.z;
                    e[8] += g.z * g.z;
                    b.add_scaled_vector(&g, d);
                }
            }
            if !any {
                return;
            }
            let e = &mut a.elements;
            e[0] += damp;
            e[4] += damp;
            e[8] += damp;
            let axis = b.apply_matrix3(a.invert());
            let angle = axis.length();
            if !(angle > 1e-6) {
                break;
            }
            let turn = js_min(angle, self.turn_max - turned);
            turned += turn;
            let mut world_turn = Quat::default();
            world_turn.set_from_axis_angle(axis.divide_scalar(angle), turn);
            // A world turn about the wrist, put into the hand's own parent space.
            let parent_q = graph.world_quaternion(parent);
            let mut local = parent_q;
            local.invert().multiply(&world_turn).multiply(&parent_q);
            let mut q = graph.local_quaternion(hand);
            q.premultiply(&local);
            graph.set_local_quaternion(hand, &q);
            graph.update_world_matrix(hand, false, true, false);
            pass += 1;
        }

        // What the turn left in: fingers pressed on skin facing opposite ways, the
        // tip under the jaw and the knuckles at the cheek. A finger gives to what
        // it is pushed into, so each one left in curls or straightens on its own,
        // least squares over its points, between straight and its full flexion.
        for f in Finger::ALL {
            self.spec[f as usize] = Some(spec[f as usize].unwrap_or(0.0));
        }
        let mut pressed = [Pressed::default(); 5];
        for _ in 0..FINGER_PASSES {
            let mut moved = false;
            for f in Finger::ALL {
                let chain = p.finger(f, side);
                let from = self.spec[f as usize].unwrap_or(0.0);
                let lo = js_min(from, 0.0) - from;
                let hi = js_max(from, 1.0) - from;
                if chain.is_empty() {
                    continue;
                }
                let mut n = 0;
                let mut i = 0;
                while i <= chain.len() && n < pressed.len() {
                    if let Some(point) = finger_point(graph, chain, i) {
                        let q = &mut pressed[n];
                        q.p = point;
                        q.d = face.shortfall(&q.p, clear, &mut q.n);
                        if q.d > 0.0 {
                            q.i = i;
                            n += 1;
                        }
                    }
                    i += 1;
                }
                if n == 0 {
                    continue;
                }
                // The curl's lever on each point, by a small trial flexion.
                self.spec[f as usize] = Some(from + FINGER_CURL_PROBE);
                rig.hands
                    .curl_hand(p, rig.joints, graph, rig.rest_of, side, &self.spec, spread);
                graph.update_world_matrix(hand, false, true, false);
                let mut num = 0.0;
                let mut den = damp;
                for q in &pressed[..n] {
                    let mut point = finger_point(graph, chain, q.i).expect("a point found before");
                    let j = point.sub(&q.p).dot(&q.n) / FINGER_CURL_PROBE;
                    num += j * q.d;
                    den += j * j;
                }
                self.spec[f as usize] = Some(from + clamp(num / den, lo, hi));
                rig.hands
                    .curl_hand(p, rig.joints, graph, rig.rest_of, side, &self.spec, spread);
                graph.update_world_matrix(hand, false, true, false);
                if self.spec[f as usize] != Some(from) {
                    moved = true;
                }
            }
            if !moved {
                return;
            }
        }
    }
}

// finger-clearance.ts FingerClearance.fingerPoint
//
// Point `i` of a finger chain, the last one past its last bone: the tip has no
// bone, so the last segment is carried on, as `limb` estimates it.
fn finger_point(graph: &mut Graph, chain: &[u32], i: usize) -> Option<Vec3> {
    if i < chain.len() {
        return Some(graph.world_position(chain[i]));
    }
    if chain.len() < 2 {
        return None;
    }
    let mut out = graph.world_position(chain[i - 1]);
    let mut t = out;
    t.sub(&graph.world_position(chain[i - 2]));
    out.add_scaled_vector(&t, FINGER_TIP_EXTENSION);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anatomy::joints::FINGER_WIDTH;
    use crate::rig::hands::EMPTY_SPEC;
    use crate::rig::testkit::{avatar, bone, rest_of, rest_table};

    struct Built {
        graph: Graph,
        profile: Profile,
        hands: Hands,
        anat: ArmAnatomy,
        rest: Vec<f64>,
        joints: JointTable,
    }

    fn built() -> Built {
        let (mut graph, profile) = avatar();
        let rest = rest_table(&graph);
        let hands = Hands::new(&profile, &mut graph);
        let mut anat = ArmAnatomy::new(&profile, &mut graph);
        assert!(anat.update(&mut graph));
        let joints = profile.anatomy.clone().unwrap_or_else(JointTable::human);
        Built {
            graph,
            profile,
            hands,
            anat,
            rest,
            joints,
        }
    }

    fn clearance_of(p: &Profile) -> impl Fn(Side) -> f64 + '_ {
        |side| 0.5 * FINGER_WIDTH * p.limb[side as usize].pitch.unwrap_or(0.0)
    }

    #[test]
    fn caps_a_frames_turn_at_the_span_of_the_avatars_own_wrist_deviation_range() {
        let b = built();
        let [lo, hi] = JointTable::human().wrist.deviation.free;
        assert_eq!(
            FingerClearance::new(&b.hands, &b.anat, |_| 0.0).turn_max,
            hi - lo
        );

        let mut anatomy = JointTable::human();
        anatomy.wrist.deviation.free = [lo / 2.0, hi / 2.0];
        let mut p = b.profile.clone();
        p.anatomy = Some(anatomy);
        let mut g = b.graph;
        let anat = ArmAnatomy::new(&p, &mut g);
        assert_eq!(
            FingerClearance::new(&b.hands, &anat, |_| 0.0).turn_max,
            (hi - lo) / 2.0
        );
    }

    #[test]
    fn records_a_curled_hand_in_the_frame_it_reached() {
        // Two different hand orientations: the shape is measured in the frame each reached,
        // so it comes out the same and carries neither orientation.
        let mut shapes = Vec::new();
        for turn in [Vec3::new(0.3, -0.8, 0.2), Vec3::new(-0.9, 0.1, 0.6)] {
            let mut b = built();
            let hand = bone(&b.profile, BoneSlot::HandR);
            let mut q = b.graph.local_quaternion(hand);
            let mut axis = turn;
            axis.normalize();
            q.premultiply(Quat::default().set_from_axis_angle(&axis, turn.length()));
            b.graph.set_local_quaternion(hand, &q);
            let curls = [Some(0.4), Some(0.7), Some(0.55), Some(0.35), Some(0.2)];
            let spread = [None, Some(0.25), None, Some(-0.15), None];
            let rest = rest_of(&b.rest);
            b.hands.curl_hand(
                &b.profile,
                &b.joints,
                &mut b.graph,
                &rest,
                Side::R,
                &curls,
                &spread,
            );
            b.graph.update_matrix_world(0, true);
            let mut fingers = FingerClearance::new(&b.hands, &b.anat, clearance_of(&b.profile));
            fingers.note_fingers(&b.profile, &mut b.graph, Side::R);
            shapes.push(fingers.finger_shape(Side::R).to_vec());
        }
        assert!(shapes[0].len() > 10);
        assert_eq!(shapes[1].len(), shapes[0].len());
        let worst = shapes[0]
            .iter()
            .zip(&shapes[1])
            .map(|(a, b)| a.distance_to(b))
            .fold(0.0, js_max);
        assert!(
            worst < 1e-6,
            "largest finger-shape point differs by {worst} m"
        );
    }

    #[test]
    fn turns_a_hand_with_its_fingers_in_the_face_no_further_than_its_cap() {
        let mut b = built();
        let p = b.profile.clone();
        let (head, lower, hand) = (
            bone(&p, BoneSlot::Head),
            bone(&p, BoneSlot::LowerArmR),
            bone(&p, BoneSlot::HandR),
        );
        let face = p.face.unwrap();
        b.graph.update_world_matrix(head, true, false, false);
        let head_world = b.graph.current_matrix_world(head);
        let mut target = face.mouth.unwrap();
        target.apply_matrix4(&head_world);
        let mut fwd = face.forward;
        fwd.transform_direction(&head_world);
        target.add_scaled_vector(&fwd, 0.35 * p.limb[1].tip[Finger::Middle as usize].unwrap());
        // Fingers aimed straight into the face.
        let hand_world = b.graph.world_quaternion(hand);
        let mut axis = p.rest_dir[BoneSlot::HandR as usize].unwrap();
        axis.apply_quaternion(&hand_world).normalize();
        let mut aim = fwd;
        aim.negate();
        let mut world = Quat::default();
        world
            .set_from_unit_vectors(&axis, &aim)
            .multiply(&hand_world);
        let mut local = b.graph.world_quaternion(lower);
        local.invert().multiply(&world);
        let mut to_lower = b.graph.current_matrix_world(lower);
        to_lower.invert();
        target.apply_matrix4(&to_lower);
        b.graph.set_local_position(hand, &target);
        b.graph.set_local_quaternion(hand, &local);

        let mut fingers = FingerClearance::new(&b.hands, &b.anat, clearance_of(&p));
        let rest = rest_of(&b.rest);
        let rig = FingerRig {
            p: &p,
            joints: &b.joints,
            hands: &b.hands,
            rest_of: &rest,
        };
        fingers.curl_clear_of_face(
            &rig,
            &mut b.graph,
            &mut b.anat,
            Side::R,
            &EMPTY_SPEC,
            &EMPTY_SPEC,
        );
        let turned = b.graph.local_quaternion(hand).angle_to(&local);
        assert!(turned > 1e-6, "the hand turned");
        assert!(turned <= fingers.turn_max + 1e-9);
    }

    #[test]
    fn frames_a_hand_by_its_pointing_direction_and_palm() {
        let mut point = Vec3::new(0.3, -2.0, 0.1);
        let palm = Vec3::new(0.0, 0.2, 1.0);
        let mut m = Mat3::default();
        let frame = *hand_frame(&mut point, &palm, &mut m).expect("a frame");
        assert!((point.length() - 1.0).abs() < 1e-12);
        let e = frame.elements;
        let column = |c: usize| Vec3::new(e[3 * c], e[3 * c + 1], e[3 * c + 2]);
        let (x, y, z) = (column(0), column(1), column(2));
        assert!(x.distance_to(&point) < 1e-12);
        assert!(x.dot(&y).abs() < 1e-12 && y.dot(&z).abs() < 1e-12 && x.dot(&z).abs() < 1e-12);
        assert!(y.dot(&palm) > 0.0);

        let mut tiny = Vec3::new(1e-7, 0.0, 0.0);
        assert!(hand_frame(&mut tiny, &palm, &mut m).is_none());
        assert_eq!(tiny, Vec3::new(1e-7, 0.0, 0.0));
        let mut up = Vec3::new(0.0, 2.0, 0.0);
        assert!(hand_frame(&mut up, &Vec3::new(0.0, -1.0, 1e-5), &mut m).is_none());
    }
}

/// `tests/corpora/rig-b-battery`: the TS finger, hand-geometry, clearance and arm-configuration
/// modules on the base avatar through a fixed run of their calls, replayed step by step on the
/// port. See `record-corpora.test.ts`.
#[cfg(test)]
mod battery {
    use super::super::arm_configuration::{
        ArmCalibration, ArmCalibrationInput, ArmConfiguration, ArmDirections, ArmForwardContext,
        ArmForwardResult, BoneCalibrationInput, HandCalibrationInput, UpperCalibrationInput,
        bound_arm_configuration, capture_arm_calibration, configuration_of_directions, forward_arm,
    };
    use super::super::finger_axes::{FingerAxes, solve_finger_axes};
    use super::super::hand_geometry::{
        ContactSurface, HandContact, HandContactCalibration, HandGeometryCalibration,
        HandGeometrySample, PalmRegion, capture_hand_contact_geometry, capture_hand_geometry,
        make_hand_geometry_sample, sample_hand_contact, sample_hand_geometry,
    };
    use super::super::hands::{FingerSpec, Hands};
    use super::super::testkit::{avatar, fnv_f64s, graph_hash, rest_of, rest_table};
    use super::{FingerClearance, FingerRig, hand_frame};
    use crate::anatomy::arm::ArmAnatomy;
    use crate::anatomy::joints::{FINGER_WIDTH, JointTable};
    use crate::corpus_replay::{Case, Corpus};
    use crate::math::{Mat3, Quat, Vec3};
    use crate::profile::{Finger, Profile, Side};
    use crate::scene::graph::Graph;
    use core::f64::consts::PI;

    const KINDS: [&str; 17] = [
        "axes.solve",
        "hands.build",
        "hands.curlHand",
        "hands.curlFinger",
        "update",
        "geometry.capture",
        "geometry.sample",
        "contact.capture",
        "contact.sample",
        "clearance.build",
        "clearance.note",
        "clearance.curl",
        "arm.calibrate",
        "arm.forward",
        "arm.bound",
        "arm.inverse",
        "hand.frame",
    ];
    const FINGER_NAMES: [&str; 5] = ["thumb", "index", "middle", "ring", "little"];
    const CONFIGURATION: [&str; 7] = [
        "shoulderPlane",
        "shoulderLift",
        "humeralRotation",
        "elbowFlex",
        "forearmRoll",
        "wristFlex",
        "wristDev",
    ];

    struct Step<'c> {
        case: Case<'c>,
        n: usize,
        kind: &'static str,
    }

    impl Step<'_> {
        fn input(&self, name: &str) -> &[f64] {
            self.case.input(name)
        }

        fn scalar(&self, name: &str) -> f64 {
            self.case.scalar(name, false)
        }

        fn index(&self, name: &str) -> usize {
            let v = self.scalar(name);
            assert_eq!(v, v.trunc(), "{name}");
            v as usize
        }

        fn flag(&self, name: &str) -> bool {
            self.scalar(name) == 1.0
        }

        fn vec3(&self, name: &str) -> Vec3 {
            let v = self.input(name);
            Vec3::new(v[0], v[1], v[2])
        }

        fn quat(&self, name: &str) -> Quat {
            let v = self.input(name);
            Quat::new(v[0], v[1], v[2], v[3])
        }

        fn opt_vec3(&self, name: &str) -> Option<Vec3> {
            self.flag(&format!("{name}.present"))
                .then(|| self.vec3(name))
        }

        fn side(&self) -> Side {
            Side::BOTH[self.index("side")]
        }

        fn spec(&self, name: &str) -> FingerSpec {
            let mut out = [None; 5];
            for (f, finger) in FINGER_NAMES.iter().enumerate() {
                let at = format!("{name}.{finger}");
                if self.flag(&format!("{at}.present")) {
                    out[f] = Some(self.scalar(&at));
                }
            }
            out
        }

        fn configuration(&self, name: &str) -> ArmConfiguration {
            let v = |field: &str| self.scalar(&format!("{name}.{field}"));
            ArmConfiguration {
                shoulder_plane: v(CONFIGURATION[0]),
                shoulder_lift: v(CONFIGURATION[1]),
                humeral_rotation: v(CONFIGURATION[2]),
                elbow_flex: v(CONFIGURATION[3]),
                forearm_roll: v(CONFIGURATION[4]),
                wrist_flex: v(CONFIGURATION[5]),
                wrist_dev: v(CONFIGURATION[6]),
            }
        }

        fn context(&self) -> ArmForwardContext {
            ArmForwardContext {
                side: Side::BOTH[self.index("context.side")],
                shoulder: self.vec3("context.shoulder"),
                upper_length: self.scalar("context.upperLength"),
                lower_length: self.scalar("context.lowerLength"),
                up: self.vec3("context.up"),
                right: self.vec3("context.right"),
                forward: self.vec3("context.forward"),
                upper_parent_world: self.quat("context.upperParentWorld"),
            }
        }

        fn same(&self, got: &[f64], name: &str) {
            let want = self.case.output(name);
            let g: Vec<u64> = got.iter().map(|v| v.to_bits()).collect();
            let w: Vec<u64> = want.iter().map(|v| v.to_bits()).collect();
            assert_eq!(
                g, w,
                "step {} ({}): {name}: {got:?} against {want:?}",
                self.n, self.kind
            );
        }

        fn same_bool(&self, b: bool, name: &str) {
            self.same(&[if b { 1.0 } else { 0.0 }], name);
        }

        fn same_hash(&self, h: u64, name: &str) {
            self.same(&[(h >> 32) as f64, (h & 0xffff_ffff) as f64], name);
        }

        fn same_list(&self, values: &[&[f64]], name: &str) {
            self.same(&[values.len() as f64], &format!("{name}.len"));
            for (k, v) in values.iter().enumerate() {
                self.same(v, &format!("{name}[{k}]"));
            }
        }

        fn same_vecs(&self, values: &[Vec3]) {
            let flat: Vec<[f64; 3]> = values.iter().map(|v| [v.x, v.y, v.z]).collect();
            let refs: Vec<&[f64]> = flat.iter().map(|v| &v[..]).collect();
            self.same_list(&refs, "vecs");
        }

        fn same_quats(&self, values: &[Quat]) {
            let flat: Vec<[f64; 4]> = values.iter().map(|q| [q.x, q.y, q.z, q.w]).collect();
            let refs: Vec<&[f64]> = flat.iter().map(|v| &v[..]).collect();
            self.same_list(&refs, "quats");
        }

        fn same_nums(&self, values: &[f64]) {
            let refs: Vec<&[f64]> = values.iter().map(core::slice::from_ref).collect();
            self.same_list(&refs, "nums");
        }

        /// Each listed node's quaternion; the hash holds the rest of every node's state.
        fn same_touched(&self, g: &Graph, nodes: &[u32]) {
            self.same(&[nodes.len() as f64], "touched.len");
            for (k, &node) in nodes.iter().enumerate() {
                self.same(&[f64::from(node)], &format!("touched[{k}].node"));
                let i = 4 * node as usize;
                self.same(&g.quaternion[i..i + 4], &format!("touched[{k}].quaternion"));
            }
        }
    }

    /// The finger chains of one side, thumb first.
    fn finger_bones(p: &Profile, side: Side) -> Vec<u32> {
        Finger::ALL
            .iter()
            .flat_map(|&f| p.finger(f, side).iter().copied())
            .collect()
    }

    fn present(into: &mut Vec<f64>, v: Option<&Vec3>) {
        match v {
            Some(v) => into.extend([1.0, v.x, v.y, v.z]),
            None => into.push(0.0),
        }
    }

    fn present_number(into: &mut Vec<f64>, v: Option<f64>) {
        match v {
            Some(v) => into.extend([1.0, v]),
            None => into.push(0.0),
        }
    }

    fn quat_values(q: &Quat) -> [f64; 4] {
        [q.x, q.y, q.z, q.w]
    }

    fn axes_digest(p: &Profile, axes: &FingerAxes) -> u64 {
        let mut v = Vec::new();
        for side in Side::BOTH {
            for f in Finger::ALL {
                for &b in p.finger(f, side) {
                    present(&mut v, axes.axis(b));
                    present(&mut v, axes.splay_axis(b));
                    present_number(&mut v, axes.opposition_sign[b as usize]);
                }
            }
        }
        for side in Side::BOTH {
            present(&mut v, axes.palm_local[side as usize].as_ref());
        }
        fnv_f64s(&v)
    }

    fn geometry_digest(g: &HandGeometryCalibration) -> u64 {
        let mut v = Vec::new();
        present_number(&mut v, g.hand_present.map(|b| if b { 1.0 } else { 0.0 }));
        v.extend([g.metric_scale, g.points.len() as f64]);
        for point in &g.points {
            v.extend([
                point.finger as usize as f64,
                point.joint_index as f64,
                if point.tip { 1.0 } else { 0.0 },
            ]);
            match &point.nodes {
                Some(nodes) => {
                    v.extend([1.0, nodes.len() as f64]);
                    for node in nodes {
                        v.extend([node.position.x, node.position.y, node.position.z]);
                        v.extend(quat_values(&node.rest));
                        v.extend([node.scale.x, node.scale.y, node.scale.z]);
                        present(&mut v, node.curl_axis.as_ref());
                        present(&mut v, node.splay_axis.as_ref());
                        present_number(&mut v, node.joint_index.map(|i| i as f64));
                    }
                }
                None => v.push(0.0),
            }
            present_number(&mut v, point.previous_point.map(|i| i as f64));
            present_number(&mut v, point.last_point.map(|i| i as f64));
        }
        fnv_f64s(&v)
    }

    fn contact_digest(c: &HandContactCalibration) -> u64 {
        let mut v = Vec::new();
        present(&mut v, c.palm_normal.as_ref());
        present(&mut v, c.palm_center.as_ref());
        v.push(c.segments.len() as f64);
        for segment in &c.segments {
            v.extend([
                segment.finger as usize as f64,
                f64::from(segment.segment),
                segment.start as f64,
                segment.end as f64,
            ]);
            present(&mut v, segment.normal.as_ref());
        }
        fnv_f64s(&v)
    }

    fn calibration_digest(c: &ArmCalibration) -> u64 {
        let mut v = Vec::new();
        v.extend([c.upper.axis.x, c.upper.axis.y, c.upper.axis.z]);
        v.extend(quat_values(&c.upper.rest));
        v.extend([c.upper.front.x, c.upper.front.y, c.upper.front.z]);
        v.extend([c.lower.axis.x, c.lower.axis.y, c.lower.axis.z]);
        v.extend(quat_values(&c.lower.rest));
        v.extend([c.hand.axis.x, c.hand.axis.y, c.hand.axis.z]);
        v.extend(quat_values(&c.hand.rest));
        v.extend([c.hand.palm.x, c.hand.palm.y, c.hand.palm.z]);
        v.push(c.radial_sign);
        fnv_f64s(&v)
    }

    /// `ARM_JOINTS` in the recorder: the human table, a wrist past the exact inverse's domain,
    /// and a forearm that rolls more than a turn.
    fn arm_joints(index: usize) -> JointTable {
        let mut joints = JointTable::human();
        match index {
            0 => {}
            1 => {
                joints.wrist.flexion.max = [-PI / 2.0, PI / 2.0];
                joints.wrist.deviation.max = [0.0, 0.0];
            }
            2 => joints.elbow.rotation.max = [-7.0, 7.0],
            _ => panic!("no joint table {index}"),
        }
        joints
    }

    fn configuration_values(c: &ArmConfiguration) -> [f64; 7] {
        [
            c.shoulder_plane,
            c.shoulder_lift,
            c.humeral_rotation,
            c.elbow_flex,
            c.forearm_roll,
            c.wrist_flex,
            c.wrist_dev,
        ]
    }

    #[test]
    fn replays_the_ts_fingers_and_arm_configuration_bit_for_bit() {
        let corpus = Corpus::load("rig-b-battery");
        let (mut g, p) = avatar();
        let rest = rest_table(&g);
        let rest_q = rest_of(&rest);
        let rest_opt = |i: u32| Some(rest_q(i));
        let joints = p.anatomy.clone().unwrap_or_else(JointTable::human);
        let clearance_of =
            |side: Side| 0.5 * FINGER_WIDTH * p.limb[side as usize].pitch.unwrap_or(0.0);
        let mut axes: Option<FingerAxes> = None;
        let mut hands: Option<Hands> = None;
        let mut geometry: [Option<HandGeometryCalibration>; 2] = [None, None];
        let mut samples: [Option<HandGeometrySample>; 2] = [None, None];
        let mut contacts: [Option<HandContactCalibration>; 3] = [None, None, None];
        let mut anat: Option<ArmAnatomy> = None;
        let mut fingers: Option<FingerClearance> = None;
        let mut calibrations: [Option<ArmCalibration>; 4] = [None, None, None, None];
        let mut seen = [0; 17];

        for (n, case) in corpus.iter().enumerate() {
            let k = case.scalar("kind", false) as usize;
            seen[k] += 1;
            let s = Step {
                case,
                n,
                kind: KINDS[k],
            };
            if s.flag("set.present") {
                let node = s.index("set.node");
                g.position[3 * node..3 * node + 3].copy_from_slice(s.input("set.position"));
                g.quaternion[4 * node..4 * node + 4].copy_from_slice(s.input("set.quaternion"));
            }
            if s.flag("update") {
                g.update_matrix_world(0, true);
            }
            match s.kind {
                "axes.solve" => {
                    let solved = solve_finger_axes(&p, &mut g);
                    s.same_hash(axes_digest(&p, &solved), "digest");
                    axes = Some(solved);
                }
                "hands.build" => hands = Some(Hands::new(&p, &mut g)),
                "hands.curlHand" => {
                    let side = s.side();
                    hands.as_ref().unwrap().curl_hand(
                        &p,
                        &joints,
                        &mut g,
                        &rest_q,
                        side,
                        &s.spec("spec"),
                        &s.spec("spread"),
                    );
                    s.same_touched(&g, &finger_bones(&p, side));
                }
                "hands.curlFinger" => {
                    let side = s.side();
                    hands.as_ref().unwrap().curl_finger(
                        &p,
                        &joints,
                        &mut g,
                        &rest_q,
                        Finger::ALL[s.index("finger")],
                        side,
                        s.scalar("amount"),
                        s.scalar("spreadAmount"),
                    );
                    s.same_touched(&g, &finger_bones(&p, side));
                }
                "update" => g.update_matrix_world(0, true),
                "geometry.capture" => {
                    let side = s.side();
                    let captured = capture_hand_geometry(
                        &p,
                        &g,
                        side,
                        &rest_opt,
                        axes.as_ref().unwrap(),
                        &joints,
                        s.scalar("metricScale"),
                    );
                    s.same_hash(geometry_digest(&captured), "digest");
                    samples[side as usize] = Some(make_hand_geometry_sample(&captured));
                    geometry[side as usize] = Some(captured);
                }
                "geometry.sample" => {
                    let side = side_of(&s);
                    let sample = samples[side].as_mut().unwrap();
                    sample_hand_geometry(
                        geometry[side].as_ref().unwrap(),
                        &s.spec("spec"),
                        &s.spec("spread"),
                        sample,
                    );
                    let points: Vec<Vec3> = sample.points.iter().map(|q| q.position).collect();
                    s.same_vecs(&points);
                }
                "contact.capture" => {
                    let palm = s.opt_vec3("palm").unwrap();
                    let captured = capture_hand_contact_geometry(
                        geometry[side_of(&s)].as_ref().unwrap(),
                        &palm,
                    );
                    s.same_hash(contact_digest(&captured), "digest");
                    contacts[s.index("slot")] = Some(captured);
                }
                "contact.sample" => {
                    let surface = s.flag("selector.surface.present").then(|| {
                        [
                            ContactSurface::Center,
                            ContactSurface::Pad,
                            ContactSurface::Back,
                        ][s.index("selector.surface")]
                    });
                    let selector = if s.index("selector.kind") == 0 {
                        HandContact::Palm {
                            region: [PalmRegion::Heel, PalmRegion::Center]
                                [s.index("selector.region")],
                            surface,
                        }
                    } else {
                        HandContact::Finger {
                            finger: Finger::ALL[s.index("selector.finger")],
                            segment: s.index("selector.segment") as u8,
                            fraction: s.scalar("selector.fraction"),
                            surface,
                        }
                    };
                    let mut out = s.vec3("outVec");
                    let ok = sample_hand_contact(
                        contacts[s.index("slot")].as_ref().unwrap(),
                        &s.spec("spec"),
                        &s.spec("spread"),
                        &selector,
                        s.scalar("clearance"),
                        &mut out,
                    );
                    s.same_bool(ok, "ok");
                    s.same(&[out.x, out.y, out.z], "outVec");
                }
                "clearance.build" => {
                    let mut built = ArmAnatomy::new(&p, &mut g);
                    s.same_bool(built.update(&mut g), "ok");
                    let clearance =
                        FingerClearance::new(hands.as_ref().unwrap(), &built, clearance_of);
                    s.same(&[clearance.turn_max], "value");
                    anat = Some(built);
                    fingers = Some(clearance);
                }
                "clearance.note" => {
                    let side = s.side();
                    let clearance = fingers.as_mut().unwrap();
                    clearance.note_fingers(&p, &mut g, side);
                    s.same_vecs(clearance.finger_shape(side));
                    s.same_nums(&clearance.finger_frame(side).elements);
                }
                "clearance.curl" => {
                    let side = s.side();
                    let rig = FingerRig {
                        p: &p,
                        joints: &joints,
                        hands: hands.as_ref().unwrap(),
                        rest_of: &rest_q,
                    };
                    let posed = fingers.as_mut().unwrap().curl_clear_of_face(
                        &rig,
                        &mut g,
                        anat.as_mut().unwrap(),
                        side,
                        &s.spec("spec"),
                        &s.spec("spread"),
                    );
                    let posed: Vec<f64> = posed.iter().map(|v| v.unwrap()).collect();
                    s.same_nums(&posed);
                    let mut touched = vec![
                        p.bones[crate::profile::BoneSlot::arm(crate::profile::ArmSlot::Hand, side)
                            as usize],
                    ];
                    touched.extend(finger_bones(&p, side));
                    s.same_touched(&g, &touched);
                }
                "arm.calibrate" => {
                    let joints = arm_joints(s.index("joints"));
                    let input = ArmCalibrationInput {
                        upper: UpperCalibrationInput {
                            axis: s.vec3("calibration.upper.axis"),
                            rest: s.quat("calibration.upper.rest"),
                            front: s.vec3("calibration.upper.front"),
                        },
                        lower: BoneCalibrationInput {
                            axis: s.vec3("calibration.lower.axis"),
                            rest: s.quat("calibration.lower.rest"),
                        },
                        hand: HandCalibrationInput {
                            axis: s.vec3("calibration.hand.axis"),
                            rest: s.quat("calibration.hand.rest"),
                            palm: s.vec3("calibration.hand.palm"),
                        },
                        radial_sign: s.scalar("calibration.radialSign"),
                        joints: &joints,
                    };
                    let refusal = match capture_arm_calibration(&input) {
                        Ok(c) => {
                            s.same_hash(calibration_digest(&c), "digest");
                            calibrations[s.index("slot")] = Some(c);
                            -1.0
                        }
                        Err(e) => e as usize as f64,
                    };
                    s.same_bool(refusal < 0.0, "ok");
                    s.same(&[refusal], "refusal");
                }
                "arm.forward" => {
                    let mut r = ArmForwardResult::default();
                    forward_arm(
                        &s.configuration("configuration"),
                        calibrations[s.index("slot")].as_ref().unwrap(),
                        &s.context(),
                        &mut r,
                    );
                    s.same_vecs(&[r.u, r.l, r.h, r.palm, r.elbow, r.wrist]);
                    s.same_quats(&[
                        r.upper_world,
                        r.lower_world,
                        r.hand_world,
                        r.upper_local,
                        r.lower_local,
                        r.hand_local,
                    ]);
                }
                "arm.bound" => {
                    let mut out = ArmConfiguration::default();
                    bound_arm_configuration(
                        &s.configuration("configuration"),
                        calibrations[s.index("slot")].as_ref().unwrap(),
                        &mut out,
                    );
                    s.same_nums(&configuration_values(&out));
                }
                "arm.inverse" => {
                    let mut out = s.configuration("outConf");
                    let previous = s
                        .flag("previous.present")
                        .then(|| s.configuration("previous"));
                    let palm = s.opt_vec3("palm");
                    let ok = configuration_of_directions(
                        &ArmDirections {
                            upper_arm: s.vec3("directions.upperArm"),
                            lower_arm: s.vec3("directions.lowerArm"),
                            hand: s.vec3("directions.hand"),
                        },
                        palm.as_ref(),
                        calibrations[s.index("slot")].as_ref().unwrap(),
                        &s.context(),
                        previous.as_ref(),
                        &mut out,
                    );
                    s.same_bool(ok, "ok");
                    s.same_nums(&configuration_values(&out));
                }
                "hand.frame" => {
                    let mut point = s.vec3("point");
                    let mut m = Mat3::default();
                    let ok = hand_frame(&mut point, &s.opt_vec3("palm").unwrap(), &mut m).is_some();
                    s.same_bool(ok, "ok");
                    s.same_vecs(&[point]);
                    s.same_nums(&m.elements);
                }
                other => panic!("unknown step {other}"),
            }
            s.same_hash(graph_hash(&g), "hash");
        }
        assert_eq!(seen, [1, 1, 4, 5, 2, 2, 5, 3, 11, 1, 6, 4, 7, 7, 2, 11, 3]);
    }

    fn side_of(s: &Step) -> usize {
        s.index("side")
    }
}
