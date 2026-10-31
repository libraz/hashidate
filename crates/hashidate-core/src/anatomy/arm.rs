//! `anatomy/arm.ts`: measurement and limiting for one arm.

use super::arm_frame::{humeral_reference, lateral_reference};
use super::cost::{self, ArmMeasurement, ArmStrain, Reading, Seen};
use super::face::FaceSurface;
use super::joints::JointTable;
use super::palm_frame::rest_palm_normals;
use super::strain::{clamp_dof, elevation_ceiling};
use super::volumes::{BodyClearance, BodyVolumeFrame, BodyVolumes};
use crate::math::f::{acos, atan2, cos, hypot, js_max, js_min, sin};
use crate::math::{Vec3, clamp};
use crate::profile::{ArmSlot, BodyFrame, BoneSlot, Finger, Profile, Side};
use crate::scene::graph::Graph;
use core::f64::consts::PI;

// arm.ts rotationTrust
//
// How far humeral rotation can be read off an elbow bent `flex` radians:
// nothing below fifteen degrees, fully by forty-five.
pub fn rotation_trust(flex: f64) -> f64 {
    clamp((flex - 0.26) / 0.52, 0.0, 1.0)
}

/// Measurement and limiting for one arm.
///
/// Holds its scratch vectors because it runs twice a frame for hours; the
/// measurement is a dozen dot products and allocating for it would be the
/// dominant cost.
///
/// Two halves, and they are kept apart: measuring a pose and bounding one both
/// work on *directions*, which is what makes them portable across rigs, while
/// whether the arm is inside its own chest is a question about positions and
/// lives in `volumes`. What a measured arm costs is `cost`, which needs
/// only the numbers and no geometry at all.
///
/// The world-space frame TS keeps as `up`, `fwd` and `right` is the trunk frame of
/// [`BodyVolumes`], read through [`ArmAnatomy::up`] and its siblings.
#[derive(Clone, Debug)]
pub struct ArmAnatomy {
    /// `profile.body`, chest-local.
    pub frame: Option<BodyFrame>,
    pub limits: JointTable,
    /// `bones.chest ?? bones.spine ?? bones.hips`, read again by every `update` in TS.
    chest: Option<u32>,
    /// Per side: the character's outside.
    pub lateral: Vec3,
    /// Which of ±(palm × forearm) points at the thumb, per [`Side`].
    pub radial_sign: [f64; 2],
    /// The trunk and the head, and everything that asks a question of them.
    body: BodyVolumes,
    /// Filled by `measure`, read by the UI and by the reach cost.
    pub m: ArmMeasurement,
    pub strain: ArmStrain,
}

impl ArmAnatomy {
    // arm.ts ArmAnatomy.constructor
    pub fn new(profile: &Profile, graph: &mut Graph) -> ArmAnatomy {
        let frame = profile.body; // chest-local
        let limits = profile.anatomy.clone().unwrap_or_else(JointTable::human);

        // Which of ±(palm × forearm) points at the thumb. Settled once, from the
        // rest pose, because at solve time the hand is not posed yet and the
        // direction cannot be read off the knuckles.
        let radial_sign = Self::solve_radial(profile, graph);

        let zero = Vec3::default();
        let body = BodyVolumes::new(profile, graph, frame.as_ref(), zero, zero, zero);
        ArmAnatomy {
            frame,
            limits,
            chest: profile.chest(),
            lateral: Vec3::default(),
            radial_sign,
            body,
            m: ArmMeasurement::default(),
            strain: ArmStrain::default(),
        }
    }

    /// World-space up, refreshed once per frame.
    pub fn up(&self) -> &Vec3 {
        &self.body.trunk().up
    }

    /// World-space forward, refreshed once per frame.
    pub fn fwd(&self) -> &Vec3 {
        &self.body.trunk().fwd
    }

    /// World-space right, refreshed once per frame.
    pub fn right(&self) -> &Vec3 {
        &self.body.trunk().right
    }

    // arm.ts ArmAnatomy.axisO
    //
    // Trunk axis origin, world, per frame.
    pub fn axis_o(&self) -> &Vec3 {
        &self.body.trunk().o
    }

    /// The volumes, for the queries `ArmAnatomy` does not forward.
    pub fn body(&self) -> &BodyVolumes {
        &self.body
    }

    // arm.ts ArmAnatomy.solveRadial
    fn solve_radial(p: &Profile, graph: &mut Graph) -> [f64; 2] {
        let mut radial_sign = [1.0, 1.0];
        let palms = rest_palm_normals(p, graph);
        for side in Side::BOTH {
            let hand = p.bone(BoneSlot::arm(ArmSlot::Hand, side));
            let index = p.finger_root(Finger::Index, side);
            let little = p.finger_root(Finger::Little, side);
            let middle = p.finger_root(Finger::Middle, side);
            let palm = palms[side as usize];
            let (Some(hand), Some(index), Some(little), Some(middle), Some(palm)) =
                (hand, index, little, middle, palm)
            else {
                continue;
            };
            graph.update_world_matrix(hand, true, false, false);
            let mut along = graph.world_position(middle);
            along.sub(&graph.world_position(hand)).normalize();
            let mut across = graph.world_position(index);
            across.sub(&graph.world_position(little)).normalize(); // toward the thumb
            let mut n = Vec3::default();
            n.cross_vectors(&palm, &along);
            radial_sign[side as usize] = if n.dot(&across) >= 0.0 { 1.0 } else { -1.0 };
        }
        radial_sign
    }

    // arm.ts ArmAnatomy.update
    //
    // Refresh the world-space body frame. Call once per frame, before measuring.
    pub fn update(&mut self, graph: &mut Graph) -> bool {
        let (Some(frame), Some(chest)) = (self.frame, self.chest) else {
            return false;
        };
        graph.update_world_matrix(chest, true, false, false);
        let q = graph.world_quaternion(chest);
        let mut up = frame.up;
        up.apply_quaternion(&q);
        let mut fwd = frame.forward;
        fwd.apply_quaternion(&q);
        let mut right = frame.right;
        right.apply_quaternion(&q);
        self.body.set_axes(up, right, fwd);
        self.body.update(graph, chest);
        true
    }

    // arm.ts ArmAnatomy.setArm
    //
    // Tell the model where this arm starts and how long its two segments are, so
    // the arm can be *placed* rather than only pointed.
    //
    // Everything else here works on directions, which is what keeps it portable.
    // The torso is the exception: whether the arm is inside the chest is a
    // question about positions, and no amount of angle says it.
    pub fn set_arm(&mut self, s: &Vec3, la: f64, lf: f64, lh: f64) {
        self.body.set_arm(s, la, lf, lh);
    }

    // arm.ts ArmAnatomy.clearArm
    pub fn clear_arm(&mut self) {
        self.body.clear_arm();
    }

    // arm.ts ArmAnatomy.side
    //
    // Point `lateral` at the character's outside for this side.
    fn side(&mut self, side: Side) {
        self.lateral = *self.right();
        if side == Side::L {
            self.lateral.negate();
        }
    }

    // --- measurement --------------------------------------------------------

    // arm.ts ArmAnatomy.shoulder
    //
    // Shoulder position of the upper arm direction, as (elevation, plane).
    //
    // Elevation is measured from the arm hanging straight down, which is where a
    // goniometer measures it from and — usefully — is also a pose no rig can
    // disagree about, unlike a T-pose or an A-pose.
    fn shoulder(&mut self, side: Side, u: &Vec3) -> (f64, f64) {
        self.side(side);
        let up = *self.up();
        let theta = acos(clamp(-u.dot(&up), -1.0, 1.0));
        let mut h = *u;
        h.add_scaled_vector(&up, -h.dot(&up));
        // Straight down: the plane is undefined and so is any limit that uses it.
        let plane = if h.length_sq() < 1e-8 {
            0.0
        } else {
            atan2(h.dot(self.fwd()), h.dot(&self.lateral))
        };
        (theta, plane)
    }

    // arm.ts ArmAnatomy.measure
    //
    // Measure one arm from its three world directions.
    //
    // `palmN` is the palm normal — needed to tell wrist flexion from deviation,
    // since both are a bend of the hand away from the forearm and only the palm
    // says which plane it happened in. Where the caller has a palm *target* it
    // should pass that: it is what the hand is about to be rolled to, and it is
    // known before the aim rather than after it.
    //
    // **Pass null when the palm is genuinely unconstrained**, and the bend is
    // scored as pure flexion — the best orientation available. That is not a
    // shortcut, it is what the arm does: the forearm rolls so the hand bends the
    // way a hand bends. Scoring an unconstrained wrist against an assumed palm
    // charges it for deviation it would never have to make, and a wrist has three
    // times more flexion than deviation, so the difference decides poses.
    //
    // TS defaults `forearmRoll` and `humeralRoll` to 0.
    #[allow(clippy::too_many_arguments)]
    pub fn measure(
        &mut self,
        side: Side,
        u: &Vec3,
        l: &Vec3,
        h: &Vec3,
        palm_n: Option<&Vec3>,
        forearm_roll: f64,
        humeral_roll: f64,
    ) -> &ArmMeasurement {
        self.side(side);

        let (theta, plane) = self.shoulder(side, u);
        self.m.elevation = theta;
        self.m.plane = plane;
        self.m.torso = self.body.torso_depth(u, Some(l), Some(h));

        // Elbow: the angle between the two segments, and nothing else. Straight is
        // zero however the arm is oriented in the world.
        self.m.elbow = acos(clamp(u.dot(l), -1.0, 1.0));

        // Humeral rotation, read off where the elbow points. Meaningless on a
        // straight arm — there is no bend to point anywhere — and reported as
        // neutral there rather than as noise.
        let (up, fwd) = (*self.up(), *self.fwd());
        let mut reference = Vec3::default();
        humeral_reference(u, &up, &fwd, &mut reference);
        let mut perp = Vec3::default();
        lateral_reference(u, &reference, &up, &fwd, &self.lateral, &mut perp);
        // How much the measurement can be trusted: nothing below 15 degrees of
        // elbow bend, fully by 45.
        self.m.rotation_read = rotation_trust(self.m.elbow);
        let mut bend = *l;
        bend.add_scaled_vector(u, -bend.dot(u));
        if self.m.rotation_read > 0.0 && bend.length_sq() > 1e-10 {
            bend.normalize();
            self.m.rotation = atan2(bend.dot(&perp), bend.dot(&reference));
        } else {
            self.m.rotation = 0.0;
        }

        // Twist applied to the humerus about its own axis, which the geometry above
        // cannot see: rolling a bone about the line it points along moves nothing
        // that this model measures. It is the same degree of freedom as the reading
        // from the elbow, so the two add.
        //
        // Applied rotation is known exactly, unlike the inferred kind, so it carries
        // its own confidence: a straight arm whose humerus was deliberately rolled
        // 40 degrees has a rotation worth reporting even though there is no elbow
        // bend to read it from.
        if humeral_roll != 0.0 && !humeral_roll.is_nan() {
            self.m.rotation += humeral_roll;
            self.m.rotation_read =
                js_max(self.m.rotation_read, js_min(1.0, humeral_roll.abs() / 0.09));
        }

        // How far the elbow has come inside the shoulder, 0 when it is directly
        // below or above it and 1 when it points straight across the midline.
        //
        // A direction, not a distance: the elbow sits at S + u * La, so its offset
        // from the shoulder along the body's lateral axis is exactly `u . lateral`
        // times a length that divides straight back out again.
        self.m.inboard = js_max(0.0, -u.dot(&self.lateral));

        self.m.forearm = forearm_roll;

        // Wrist: the swing of the hand away from the forearm, split into the plane
        // the palm faces (flexion) and the plane it lies in (deviation).
        let mut swing = *h;
        swing.add_scaled_vector(l, -swing.dot(l));
        let theta = acos(clamp(l.dot(h), -1.0, 1.0));
        if swing.length_sq() > 1e-10 && theta > 1e-4 {
            swing.normalize();
            match palm_n {
                None => {
                    // Free to roll: the forearm turns until the bend is flexion.
                    self.m.wrist_flex = theta;
                    self.m.wrist_dev = 0.0;
                }
                Some(palm_n) => {
                    let mut n = *palm_n;
                    n.add_scaled_vector(l, -n.dot(l));
                    if n.length_sq() > 1e-10 {
                        n.normalize();
                        let mut rad = Vec3::default();
                        rad.cross_vectors(&n, l)
                            .multiply_scalar(self.radial_sign[side as usize])
                            .normalize();
                        self.m.wrist_flex = theta * swing.dot(&n);
                        self.m.wrist_dev = theta * swing.dot(&rad);
                    } else {
                        self.m.wrist_flex = 0.0;
                        self.m.wrist_dev = theta;
                    }
                }
            }
        } else {
            self.m.wrist_flex = 0.0;
            self.m.wrist_dev = 0.0;
        }

        &self.m
    }

    // arm.ts ArmAnatomy.score
    //
    // Strain per degree of freedom for the last measurement.
    //
    // Returned as a shared object, deliberately: this runs inside a search loop
    // that evaluates a couple of dozen candidates per arm per frame.
    pub fn score(&mut self) -> &ArmStrain {
        cost::score(&self.m, &self.limits, &mut self.strain)
    }

    // arm.ts ArmAnatomy.cost
    //
    // One number for how unlikely a pose is — what the elbow search minimises.
    // See `cost` for what each term is there to prevent.
    pub fn cost(&mut self) -> f64 {
        cost::cost(&self.m, &self.limits, &mut self.strain)
    }

    // arm.ts ArmAnatomy.report
    //
    // A readable snapshot, for the panel. Not for the frame loop.
    pub fn report(&mut self) -> [Reading; 9] {
        let seen = Seen {
            torso: self.body.torso.is_some(),
            arm: self.body.arm_set(),
        };
        cost::report(&self.m, &self.limits, &mut self.strain, seen)
    }

    // --- limiting -----------------------------------------------------------

    // arm.ts ArmAnatomy.clamp
    //
    // Pull a set of arm directions inside the hard stops, in place.
    //
    // Applied to everything, not only to solved reaches: an authored direction is
    // as capable of naming an impossible pose as a solver is, and a gesture that
    // has to be checked by hand against a table of angles is a gesture that will
    // not be.
    pub fn clamp(
        &mut self,
        side: Side,
        u: &mut Vec3,
        l: &mut Vec3,
        h: &mut Vec3,
        palm_n: Option<&Vec3>,
    ) {
        self.side(side);

        // --- shoulder: how far it may lift, in the plane it lifted in -----------
        let (theta, plane) = self.shoulder(side, u);
        let ceil = elevation_ceiling(plane, &self.limits.shoulder.elevation);
        if theta > ceil.max {
            let p = plane;
            let st = sin(ceil.max);
            let ct = cos(ceil.max);
            u.copy(self.up())
                .multiply_scalar(-ct)
                .add_scaled_vector(&self.lateral, st * cos(p))
                .add_scaled_vector(self.fwd(), st * sin(p))
                .normalize();
        }

        self.clamp_elbow(u, l);
        self.clamp_wrist(side, l, h, palm_n);

        // --- and last, out of its own chest -------------------------------------
        //
        // Last because it outranks the rest. The elevation ceiling and the trunk
        // disagree constantly — the ceiling drops toward the midline precisely
        // because the ribcage is there, so cutting elevation at a plane that points
        // across the body is a rotation *into* the chest. Whichever of the two runs
        // second wins, and the trunk has to be the one that does: an arm at an odd
        // elevation is a pose, an arm inside the ribcage is a hole in the character.
        //
        // Run here because it outranks the angular limits: the escape may leave a
        // joint over its stop, and that is the trade being made. The panel reports
        // it, so a pose bought at that price is visible rather than silent.
        let lateral = self.lateral;
        self.body.clear(u, Some(l), Some(h), &lateral, false);
    }

    // arm.ts ArmAnatomy.face
    //
    // The face's skin, for the fingers. See `FaceSurface`.
    pub fn face(&self) -> Option<&FaceSurface> {
        self.body.head.as_ref()?.face.as_ref()
    }

    /// The face's skin, for queries that use its scratch.
    pub fn face_mut(&mut self) -> Option<&mut FaceSurface> {
        self.body.head.as_mut()?.face.as_mut()
    }

    // arm.ts ArmAnatomy.surface
    //
    // Move a world point out to the body's surface, in place. See `BodyVolumes::surface`.
    pub fn surface(&mut self, p: &mut Vec3) -> f64 {
        self.body.surface(p)
    }

    // arm.ts ArmAnatomy.captureVolumeFrame
    //
    // Capture the current trunk and head frames for one clearance query batch.
    pub fn capture_volume_frame(&self, out: &mut BodyVolumeFrame) {
        self.body.capture_volume_frame(out);
    }

    // arm.ts ArmAnatomy.sampleVolumeClearances
    //
    // Sample signed torso and head clearances against a previously captured frame.
    pub fn sample_volume_clearances(
        &mut self,
        frame: &BodyVolumeFrame,
        p: &Vec3,
        out: &mut [BodyClearance; 2],
    ) {
        self.body.sample_volume_clearances(frame, p, out);
    }

    // arm.ts ArmAnatomy.clearHand
    //
    // Re-run the hand's escape alone, after something downstream has moved it.
    //
    // The rig layer re-bounds the wrist once the roll is settled, against the palm
    // the arm actually reached rather than the one the pose asked for — and that
    // runs after the clamp, so it can put a hand straight back into the face it
    // was just lifted off. It did: the three poses still reporting contact were
    // all hand-only, all of them past the wrist, and all of them cleared before
    // this second bound undid it.
    //
    // Only the hand moves, about the wrist, so nothing above it is disturbed and
    // the caller's already-posed arm stays valid.
    pub fn clear_hand(
        &mut self,
        side: Side,
        u: &mut Vec3,
        l: Option<&mut Vec3>,
        h: Option<&mut Vec3>,
    ) -> bool {
        self.side(side);
        let lateral = self.lateral;
        self.body.clear(u, l, h, &lateral, true)
    }

    // arm.ts ArmAnatomy.clampElbow
    //
    // Bound the elbow's flexion, and the direction it bent in, in place.
    fn clamp_elbow(&mut self, u: &Vec3, l: &mut Vec3) {
        let (up, fwd) = (*self.up(), *self.fwd());
        let mut reference = Vec3::default();
        humeral_reference(u, &up, &fwd, &mut reference);
        let mut perp = Vec3::default();
        lateral_reference(u, &reference, &up, &fwd, &self.lateral, &mut perp);
        let ll = &self.limits;
        let mut flex = acos(clamp(u.dot(l), -1.0, 1.0));
        let mut bend = *l;
        bend.add_scaled_vector(u, -bend.dot(u));
        // Below a usable bend the rotation is not measured, so it must not be
        // corrected either — rebuilding the forearm from a noisy angle would swing
        // a nearly straight arm sideways to satisfy a number that means nothing.
        if flex > 0.26 && bend.length_sq() > 1e-10 {
            bend.normalize();
            let rot = atan2(bend.dot(&perp), bend.dot(&reference));
            let cf = clamp_dof(flex, &ll.elbow.flexion);
            // The stops close in over the band the reading is trusted over. Applied
            // whole the moment the bend crossed it, they swung the forearm a quarter
            // turn in one frame on every reach that lifted out of a hanging arm.
            let [lo, hi] = ll.shoulder.rotation.max;
            let open = 1.0 - rotation_trust(cf);
            let cr = clamp(rot, lo - (PI + lo) * open, hi + (PI - hi) * open);
            if cf != flex || cr != rot {
                flex = cf;
                bend.copy(&reference)
                    .multiply_scalar(cos(cr))
                    .add_scaled_vector(&perp, sin(cr));
                l.copy(u)
                    .multiply_scalar(cos(flex))
                    .add_scaled_vector(&bend, sin(flex))
                    .normalize();
            }
        } else if flex > ll.elbow.flexion.max[1] {
            // Folded straight back onto the upper arm with no bend direction at all.
            l.copy(u);
        }
    }

    // arm.ts ArmAnatomy.clampWrist
    //
    // Pull the hand inside the wrist's stops, in place.
    //
    // Separate from `clamp` because it has to be able to run twice. The split of a
    // wrist bend into flexion and deviation is taken in the palm's frame, and the
    // palm is not known when the rest of the arm is bounded: which way it faces is
    // decided by the roll, and the roll is solved during the aim. So the first run
    // bounds the wrist against the palm the pose asked for, and the caller runs it
    // again against the palm the arm actually ended up with.
    //
    // Without the second run the two disagree by however much of the roll the arm
    // could not deliver, and a bend bounded as 40 degrees of flexion comes out as
    // 80 degrees of deviation against a limit of 20 — clamped, reported as
    // over-range, and both statements true of different poses.
    pub fn clamp_wrist(&mut self, side: Side, l: &Vec3, h: &mut Vec3, palm_n: Option<&Vec3>) {
        self.side(side);
        let ll = &self.limits;
        let mut swing = *h;
        swing.add_scaled_vector(l, -swing.dot(l));
        let theta = acos(clamp(l.dot(h), -1.0, 1.0));
        if swing.length_sq() < 1e-10 || theta < 1e-4 {
            return;
        }
        swing.normalize();
        let Some(palm_n) = palm_n else {
            // Palm unconstrained, so the forearm rolls until the bend is flexion and
            // only the flexion limit applies. Bounding it against deviation as well
            // would clamp a wrist for a rotation it was never going to have to make.
            let cap = ll.wrist.flexion.max[1];
            if theta <= cap {
                return;
            }
            h.copy(l)
                .multiply_scalar(cos(cap))
                .add_scaled_vector(&swing, sin(cap))
                .normalize();
            return;
        };
        let mut n = *palm_n;
        n.add_scaled_vector(l, -n.dot(l));
        if n.length_sq() < 1e-10 {
            return;
        }
        n.normalize();
        let mut rad = Vec3::default();
        rad.cross_vectors(&n, l)
            .multiply_scalar(self.radial_sign[side as usize])
            .normalize();
        let f = theta * swing.dot(&n);
        let dv = theta * swing.dot(&rad);
        let cf = clamp_dof(f, &ll.wrist.flexion);
        let cd = clamp_dof(dv, &ll.wrist.deviation);
        if cf == f && cd == dv {
            return;
        }
        let mag = hypot(&[cf, cd]);
        if mag < 1e-6 {
            h.copy(l);
            return;
        }
        let mut axis = n;
        axis.multiply_scalar(cf / mag)
            .add_scaled_vector(&rad, cd / mag);
        h.copy(l)
            .multiply_scalar(cos(mag))
            .add_scaled_vector(&axis, sin(mag))
            .normalize();
    }
}

#[cfg(test)]
mod tests {
    // One arm, measured and bounded.
    //
    // Everything here goes in as world directions and comes back as a reading, so
    // the properties worth pinning are about the *frame* the reading is taken in and
    // about which quantity a given defect shows up as — not about any one number.
    use super::super::cost::ReadingId;
    use super::super::strain::{StrainZone, zone_of};
    use super::super::testkit::{Body, body, close, swung};
    use super::*;

    /// Angles are built from exact trigonometry, so a reading is exact to rounding.
    const EXACT: f64 = 1e-9;
    /// A clamp that has already run has nothing left to do, to within rounding.
    const IDEMPOTENT: f64 = 1e-9;
    /// Half a degree: below this an angle is "near zero" for a pose stated as exact.
    const NEAR_ZERO: f64 = 0.0087;

    fn row(b: &mut Body, id: ReadingId) -> Reading {
        b.anat.report()[id as usize]
    }

    fn measure(b: &mut Body, side: Side, u: &Vec3, l: &Vec3, h: &Vec3) -> ArmMeasurement {
        *b.anat.measure(side, u, l, h, None, 0.0, 0.0)
    }

    fn neg(v: &Vec3) -> Vec3 {
        let mut out = *v;
        out.negate();
        out
    }

    #[test]
    fn measure_reads_a_hanging_arm_as_no_elevation_and_a_raised_one_as_ninety() {
        let mut b = body();
        let down = b.down;
        for side in Side::BOTH {
            let hanging = measure(&mut b, side, &down, &down, &down);
            assert!(hanging.elevation < NEAR_ZERO);
            let out = b.outward(side);
            let raised = measure(&mut b, side, &out, &out, &out);
            assert!((raised.elevation - PI / 2.0).abs() < EXACT);
            // Straight out to the side is plane 0, which is the abduction row.
            assert!(raised.plane.abs() < EXACT);
        }
    }

    #[test]
    fn measure_takes_elevation_from_hanging_not_from_the_bind_pose() {
        let mut b = body();
        let (down, up, out) = (b.down, b.up, b.outward(Side::L));
        close(
            measure(&mut b, Side::L, &out, &out, &out).elevation,
            PI / 2.0,
            9,
        );
        close(
            measure(&mut b, Side::L, &down, &down, &down).elevation,
            0.0,
            9,
        );
        close(measure(&mut b, Side::L, &up, &up, &up).elevation, PI, 9);
    }

    #[test]
    fn measure_mirrors_the_plane_so_one_table_serves_both_arms() {
        let mut b = body();
        let down = b.down;
        let angle = 0.8;
        let lu = swung(&down, &b.outward(Side::L), angle);
        let left = measure(&mut b, Side::L, &lu, &down, &down);
        let ru = swung(&down, &b.outward(Side::R), angle);
        let right = measure(&mut b, Side::R, &ru, &down, &down);
        close(right.elevation, left.elevation, 9);
        close(right.plane, left.plane, 9);
    }

    #[test]
    fn measure_leaves_the_plane_of_a_hanging_arm_unmeasured() {
        let mut b = body();
        let down = b.down;
        measure(&mut b, Side::L, &down, &down, &down);
        // Nothing is derived from the horizontal residue, because there is none.
        assert_eq!(b.anat.m.plane, 0.0);
        let plane = row(&mut b, ReadingId::Plane);
        assert!(!plane.measured);
        assert_eq!(plane.strain, 0.0);
        // Elevation, by contrast, is determined by this pose and is reported as such.
        assert!(row(&mut b, ReadingId::Elevation).measured);
    }

    #[test]
    fn measure_fades_humeral_rotation_out_on_a_straight_arm() {
        let mut b = body();
        let (down, fwd) = (b.down, b.fwd);
        // An arm resting at the side carries about eleven degrees of elbow bend.
        // Whichever way that little bend happens to point, it says nothing about
        // how the humerus is rotated.
        for toward in [fwd, neg(&fwd), b.outward(Side::L)] {
            let fore = swung(&down, &toward, 0.192);
            let m = measure(&mut b, Side::L, &down, &fore, &fore);
            close(m.elbow, 0.192, 9);
            assert_eq!(m.rotation_read, 0.0);
            assert_eq!(m.rotation, 0.0);
            assert_eq!(b.anat.score().rotation, 0.0);
            let rotation = row(&mut b, ReadingId::Rotation);
            assert_eq!(rotation.zone, StrainZone::Natural);
            assert!(!rotation.measured);
        }
    }

    #[test]
    fn measure_trusts_the_rotation_once_the_elbow_carries_it() {
        let mut b = body();
        let (down, out) = (b.down, b.outward(Side::L));
        let mut read = |bend: f64| {
            let fore = swung(&down, &out, bend);
            measure(&mut b, Side::L, &down, &fore, &fore).rotation_read
        };
        // Nothing below fifteen degrees, rising to full trust by forty-five.
        assert_eq!(read(0.26 - 1e-6), 0.0);
        close(read(0.26 + 0.26), 0.5, 6);
        assert_eq!(read(0.78 + 1e-6), 1.0);
        assert_eq!(read(1.5), 1.0);
    }

    #[test]
    fn measure_reports_a_deliberate_humeral_roll_on_a_straight_arm() {
        let mut b = body();
        let down = b.down;
        // Applied twist is known exactly, unlike the kind inferred from the elbow,
        // so it carries its own confidence.
        let m = *b.anat.measure(Side::L, &down, &down, &down, None, 0.0, 0.7);
        close(m.rotation, 0.7, 9);
        assert_eq!(m.rotation_read, 1.0);
        assert!(row(&mut b, ReadingId::Rotation).measured);
    }

    #[test]
    fn measure_catches_a_backwards_elbow_as_a_shoulder_rotation() {
        let mut b = body();
        let (down, fwd) = (b.down, b.fwd);
        let fore = swung(&down, &neg(&fwd), 1.047);
        let m = measure(&mut b, Side::L, &down, &fore, &fore);
        let strain = *b.anat.score();
        let t = JointTable::human();
        // The elbow itself is at a perfectly ordinary sixty degrees of flexion, so
        // the flexion limit has nothing to say about it.
        close(m.elbow, 1.047, 9);
        assert!(m.elbow < t.elbow.flexion.free[1]);
        assert_eq!(strain.elbow, 0.0);
        assert_eq!(row(&mut b, ReadingId::Elbow).zone, StrainZone::Natural);
        // The defect lands on the shoulder instead: a rotation no shoulder has.
        assert!(m.rotation.abs() > PI - 0.01);
        assert!(m.rotation.abs() > t.shoulder.rotation.max[1]);
        assert_eq!(m.rotation_read, 1.0);
        assert_eq!(strain.rotation, 1.0);
        assert_eq!(row(&mut b, ReadingId::Rotation).zone, StrainZone::Limit);
        // A forwards bend of the same size is the normal elbow, and is free.
        let forwards = swung(&down, &fwd, 1.047);
        measure(&mut b, Side::L, &down, &forwards, &forwards);
        assert!(b.anat.m.rotation.abs() < EXACT);
        assert_eq!(b.anat.score().rotation, 0.0);
    }

    #[test]
    fn measure_reads_a_raised_elbow_the_shoulder_carried_up_as_unrotated() {
        for side in Side::BOTH {
            let mut b = body();
            let (down, up, fwd) = (b.down, b.up, b.fwd);
            // Flexing a bent arm forward with no humeral rotation carries the forearm
            // with it: forward when hanging, up at horizontal, back over the shoulder.
            for deg in (0..=120).step_by(2) {
                let phi = (deg as f64 * PI) / 180.0;
                let u = swung(&down, &fwd, phi);
                let bend = swung(&fwd, &up, phi);
                let l = swung(&u, &bend, 1.0);
                let m = measure(&mut b, side, &u, &l, &l);
                assert!(m.rotation.abs() < NEAR_ZERO, "{deg} degrees of flexion");
            }
        }
    }

    #[test]
    fn measure_keeps_an_outward_rotation_outward_past_the_horizontal() {
        for side in Side::BOTH {
            let mut b = body();
            let (down, up, fwd, out) = (b.down, b.up, b.fwd, b.outward(side));
            for deg in (0..=150).step_by(2) {
                let theta = (deg as f64 * PI) / 180.0;
                let u = swung(&down, &out, theta);
                // The outside of the arm, carried up with it.
                let outside = swung(&out, &up, theta);
                let l = swung(&u, &swung(&fwd, &outside, 0.5), 1.0);
                let m = measure(&mut b, side, &u, &l, &l);
                assert!(
                    (m.rotation - 0.5).abs() < 5e-7,
                    "{deg} degrees of abduction"
                );
            }
        }
    }

    #[test]
    fn measure_scores_a_free_wrist_as_flexion_and_a_stated_palm_as_a_split() {
        let mut b = body();
        let (down, fwd) = (b.down, b.fwd);
        let hand = swung(&down, &fwd, 0.5);
        let free = measure(&mut b, Side::L, &down, &down, &hand);
        close(free.wrist_flex, 0.5, 9);
        assert_eq!(free.wrist_dev, 0.0);
        // With the palm named, the same bend splits into the two planes.
        let palm = b.outward(Side::L);
        let stated = *b
            .anat
            .measure(Side::L, &down, &down, &hand, Some(&palm), 0.0, 0.0);
        close(hypot(&[stated.wrist_flex, stated.wrist_dev]), 0.5, 9);
        assert!(stated.wrist_dev.abs() > 0.1);
    }

    /// The out-of-range pose both `clamp` tests start from.
    fn out_of_range(b: &Body) -> (Vec3, Vec3, Vec3, Vec3) {
        let upper = b.up;
        let fore = swung(&upper, &b.fwd, 2.97);
        let hand = swung(&fore, &b.outward(Side::L), 1.4);
        (upper, fore, hand, b.fwd)
    }

    #[test]
    fn clamp_pulls_an_out_of_range_pose_back_inside_the_stops() {
        let mut b = body();
        // No arm context, so this is the angular clamp alone; the trunk escape has
        // nothing to push out of.
        b.anat.clear_arm();
        let (mut upper, mut fore, mut hand, palm) = out_of_range(&b);
        let t = JointTable::human();
        let before = *b
            .anat
            .measure(Side::L, &upper, &fore, &hand, Some(&palm), 0.0, 0.0);
        assert!(before.elevation > elevation_ceiling(before.plane, &t.shoulder.elevation).max);
        assert!(before.elbow > t.elbow.flexion.max[1]);
        b.anat
            .clamp(Side::L, &mut upper, &mut fore, &mut hand, Some(&palm));
        let after = *b
            .anat
            .measure(Side::L, &upper, &fore, &hand, Some(&palm), 0.0, 0.0);
        assert!(
            after.elevation <= elevation_ceiling(after.plane, &t.shoulder.elevation).max + EXACT
        );
        assert!(after.elbow <= t.elbow.flexion.max[1] + EXACT);
        assert!(after.wrist_flex <= t.wrist.flexion.max[1] + EXACT);
        assert!(after.wrist_flex >= t.wrist.flexion.max[0] - EXACT);
        assert!(after.wrist_dev <= t.wrist.deviation.max[1] + EXACT);
        assert!(after.wrist_dev >= t.wrist.deviation.max[0] - EXACT);
        for v in [upper, fore, hand] {
            assert!((v.length() - 1.0).abs() < EXACT);
        }
    }

    #[test]
    fn clamp_has_nothing_left_to_do_on_a_second_pass() {
        let mut b = body();
        b.anat.clear_arm();
        let (mut upper, mut fore, mut hand, palm) = out_of_range(&b);
        b.anat
            .clamp(Side::L, &mut upper, &mut fore, &mut hand, Some(&palm));
        let once = [upper, fore, hand];
        b.anat
            .clamp(Side::L, &mut upper, &mut fore, &mut hand, Some(&palm));
        assert!(upper.distance_to(&once[0]) < IDEMPOTENT);
        assert!(fore.distance_to(&once[1]) < IDEMPOTENT);
        assert!(hand.distance_to(&once[2]) < IDEMPOTENT);
    }

    #[test]
    fn clamp_brings_the_rotation_stop_in_as_the_elbow_bends() {
        let mut b = body();
        b.anat.clear_arm();
        // Bent back and inward from a hanging arm: well past the inward stop, and
        // only readable once the elbow carries enough bend to read it from.
        let inward = neg(&b.outward(Side::L));
        let bend = swung(&neg(&b.fwd), &inward, 0.6);
        let stop = JointTable::human().shoulder.rotation.max[0];
        let mut prev: Option<Vec3> = None;
        let mut worst: f64 = 0.0;
        let mut flex = 0.1;
        while flex <= 1.2 {
            let mut upper = b.down;
            let mut fore = swung(&upper, &bend, flex);
            let mut hand = fore;
            b.anat
                .clamp(Side::L, &mut upper, &mut fore, &mut hand, None);
            if let Some(prev) = prev {
                worst = js_max(worst, fore.angle_to(&prev));
            }
            prev = Some(fore);
            if flex > 0.8 {
                let m = measure(&mut b, Side::L, &upper, &fore, &hand);
                close(m.rotation, stop, 6);
            }
            flex += 0.01;
        }
        // The input moves a hundredth of a radian a step.
        assert!(worst < 0.03);
    }

    #[test]
    fn clamp_leaves_a_pose_already_inside_the_stops_untouched() {
        let mut b = body();
        b.anat.clear_arm();
        let mut upper = swung(&b.down, &b.fwd, 0.6);
        let mut fore = swung(&upper, &b.fwd, 0.8);
        let mut hand = swung(&fore, &b.fwd, 0.2);
        let before = [upper, fore, hand];
        b.anat
            .clamp(Side::L, &mut upper, &mut fore, &mut hand, None);
        assert!(upper.distance_to(&before[0]) < IDEMPOTENT);
        assert!(fore.distance_to(&before[1]) < IDEMPOTENT);
        assert!(hand.distance_to(&before[2]) < IDEMPOTENT);
    }

    #[test]
    fn clamp_keeps_shoulder_forearm_and_hand_relief_on_their_own_paths() {
        let mut b = body();
        let chest = b.chest();
        let (s, la, lf, lh) = super::super::testkit::arm_of(&mut b.graph, &b.profile, Side::L);
        let (up, right, fwd) = (*b.anat.up(), *b.anat.right(), *b.anat.fwd());
        let lateral = b.outward(Side::L);
        let down = b.down;
        let mut make = || {
            let mut volumes = BodyVolumes::new(
                &b.profile,
                &mut b.graph,
                b.profile.body.as_ref(),
                up,
                right,
                fwd,
            );
            volumes.update(&mut b.graph, chest);
            volumes.set_arm(&s, la, lf, lh);
            volumes
        };

        let mut shoulder = swung(&right, &down, 0.3);
        assert!(make().clear(&mut shoulder, None, None, &lateral, false));
        close(shoulder.x, 0.38325925651165155, 12);
        close(shoulder.y, -0.9236408080515586, 12);

        let mut forearm = swung(&right, &down, 0.8);
        let mut forearm_upper = down;
        assert!(make().clear(
            &mut forearm_upper,
            Some(&mut forearm),
            None,
            &lateral,
            false
        ));
        assert!(forearm_upper.distance_to(&down) < EXACT);
        close(forearm.x, 0.4849895736464871, 12);
        close(forearm.y, -0.8745199331371462, 12);

        let mut hand_upper = down;
        let mut hand_forearm = swung(&right, &down, 0.3);
        let mut hand = hand_forearm;
        assert!(make().clear(
            &mut hand_upper,
            Some(&mut hand_forearm),
            Some(&mut hand),
            &lateral,
            true
        ));
        assert!(hand_upper.distance_to(&down) < EXACT);
        close(hand_forearm.x, 0.955336489125606, 12);
        close(hand_forearm.y, -0.29552020666133955, 12);
        close(hand.x, 0.9999999997684746, 12);
        close(hand.y, -0.00002151861722310047, 12);
    }

    #[test]
    fn cost_is_free_hanging_and_dearer_overhead() {
        let mut b = body();
        b.place_arm(Side::L);
        let (down, up) = (b.down, b.up);
        measure(&mut b, Side::L, &down, &down, &down);
        let hanging = b.anat.cost();
        measure(&mut b, Side::L, &up, &up, &up);
        let overhead = b.anat.cost();
        assert!(hanging.is_finite() && overhead.is_finite());
        assert!(hanging >= 0.0);
        assert!(overhead > hanging);
    }

    #[test]
    fn cost_charges_gravity_from_hanging_so_a_horizontal_arm_is_not_free() {
        let mut b = body();
        b.place_arm(Side::L);
        let (down, outward) = (b.down, b.outward(Side::L));
        let mut cost = |angle: f64| {
            let upper = swung(&down, &outward, angle);
            measure(&mut b, Side::L, &upper, &upper, &upper);
            assert_eq!(b.anat.m.torso, 0.0);
            b.anat.cost()
        };
        // Straight out to the side is well inside every joint's range, so anything
        // it costs is the lift term alone.
        let (side, low, hanging) = (cost(PI / 2.0), cost(0.2), cost(0.0));
        assert!(side > low);
        assert!(low >= hanging);
    }

    #[test]
    fn cost_is_much_higher_inside_the_body_than_for_any_joint_strain() {
        let mut b = body();
        b.place_arm(Side::L);
        let up = b.up;
        measure(&mut b, Side::L, &up, &up, &up);
        let overhead = b.anat.cost();
        // Across the midline and slightly down, which runs the upper arm through
        // the trunk while both of its ends stay outside it.
        let mut through = b.right;
        through.add_scaled_vector(&up, -0.3).normalize();
        measure(&mut b, Side::L, &through, &through, &through);
        let buried = b.anat.cost();
        assert!(b.anat.m.torso > 0.5);
        assert!(buried.is_finite());
        assert!(buried > overhead * 3.0);
        assert_eq!(row(&mut b, ReadingId::Torso).zone, StrainZone::Limit);
    }

    #[test]
    fn cost_tells_a_shallow_penetration_from_a_deep_one() {
        let mut b = body();
        b.place_arm(Side::L);
        let (right, up) = (b.right, b.up);
        let mut cost = |inward: f64| {
            let mut dir = right;
            dir.multiply_scalar(inward)
                .add_scaled_vector(&up, -1.0)
                .normalize();
            measure(&mut b, Side::L, &dir, &dir, &dir);
            (b.anat.cost(), b.anat.m.torso)
        };
        let shallow = cost(0.25);
        let deep = cost(1.0);
        // Genuinely shallow against genuinely buried, rather than two saturated readings.
        assert!(shallow.1 > 0.0);
        assert!(shallow.1 < 0.2);
        assert!(deep.1 > shallow.1 + 0.3);
        // A slope, not a flat charge: the search has to be able to walk out the
        // shallow side.
        assert!(deep.0 > shallow.0);
    }

    #[test]
    fn report_gives_one_row_per_dof_zoned_by_its_strain() {
        let mut b = body();
        b.place_arm(Side::L);
        let (down, up, fwd, outward) = (b.down, b.up, b.fwd, b.outward(Side::L));
        let poses = [
            ("hanging", down, down, down),
            ("abducted", outward, outward, outward),
            ("overhead", up, up, up),
            (
                "folded",
                down,
                swung(&down, &fwd, 2.9),
                swung(&down, &fwd, 2.9),
            ),
            (
                "behind",
                swung(&down, &neg(&fwd), 2.0),
                down,
                swung(&down, &outward, 1.2),
            ),
        ];
        for (label, upper, fore, hand) in poses {
            b.anat
                .measure(Side::L, &upper, &fore, &hand, Some(&outward), 0.0, 0.0);
            let rows = b.anat.report();
            let ids = rows.map(|r| r.id);
            assert_eq!(
                ids,
                [
                    ReadingId::Elevation,
                    ReadingId::Plane,
                    ReadingId::Rotation,
                    ReadingId::Elbow,
                    ReadingId::Forearm,
                    ReadingId::WristFlex,
                    ReadingId::WristDev,
                    ReadingId::Torso,
                    ReadingId::Inboard,
                ]
            );
            for r in rows {
                assert_eq!(r.zone, zone_of(r.strain), "{label}/{:?} zone", r.id);
                assert!((0.0..=1.0).contains(&r.strain), "{label}/{:?}", r.id);
                assert!(r.deg.is_finite(), "{label}/{:?} deg", r.id);
                assert!(r.range[1] > r.range[0], "{label}/{:?} range", r.id);
            }
        }
    }

    #[test]
    fn report_gives_angles_in_degrees_and_contact_as_percentages() {
        let mut b = body();
        b.place_arm(Side::L);
        let outward = b.outward(Side::L);
        measure(&mut b, Side::L, &outward, &outward, &outward);
        close(row(&mut b, ReadingId::Elevation).deg, 90.0, 6);
        assert!(!row(&mut b, ReadingId::Elevation).percent);
        assert!(row(&mut b, ReadingId::Torso).percent);
        assert!(row(&mut b, ReadingId::Inboard).percent);
    }

    #[test]
    fn report_marks_the_torso_unmeasured_until_the_arm_is_placed() {
        let mut b = body();
        let down = b.down;
        b.anat.clear_arm();
        measure(&mut b, Side::L, &down, &down, &down);
        assert!(!row(&mut b, ReadingId::Torso).measured);
        b.place_arm(Side::L);
        measure(&mut b, Side::L, &down, &down, &down);
        assert!(row(&mut b, ReadingId::Torso).measured);
    }

    #[test]
    fn the_axes_are_orthonormal_and_follow_the_chest() {
        let mut b = body();
        let (up, fwd, right) = (b.up, b.fwd, b.right);
        for v in [up, fwd, right] {
            close(v.length(), 1.0, 12);
        }
        assert!(up.dot(&fwd).abs() < 1e-12 && up.dot(&right).abs() < 1e-12);
        // The trunk origin is the chest's world position.
        let chest = b.chest();
        let at = b.graph.world_position(chest);
        assert_eq!(*b.anat.axis_o(), at);
        assert_eq!(rotation_trust(0.26), 0.0);
        assert_eq!(rotation_trust(0.78), 1.0);
    }
}

#[cfg(test)]
mod battery {
    //! `tests/corpora/arm-battery`: the TS `ArmAnatomy` on the base avatar through a fixed run
    //! of its queries, replayed step by step on the port. The recording is a fixed golden.
    use super::super::face::FaceSurfaceSample;
    use super::super::testkit::body;
    use super::super::volumes::{BodyClearance, make_body_volume_frame, make_clearances};
    use super::*;
    use crate::corpus_replay::{Case, Corpus};

    fn vec3(s: &[f64]) -> Vec3 {
        Vec3::new(s[0], s[1], s[2])
    }

    fn same(got: &[f64], want: &[f64], what: &str, step: usize) {
        let g: Vec<u64> = got.iter().map(|v| v.to_bits()).collect();
        let w: Vec<u64> = want.iter().map(|v| v.to_bits()).collect();
        assert_eq!(g, w, "step {step}: {what}: {got:?} against {want:?}");
    }

    fn same_vec(got: &Vec3, case: &Case, name: &str, step: usize) {
        same(&[got.x, got.y, got.z], case.output(name), name, step);
    }

    fn flag(b: bool) -> f64 {
        if b { 1.0 } else { 0.0 }
    }

    fn row(got: (bool, f64, Vec3), case: &Case, name: &str, step: usize) {
        let (valid, distance, n) = got;
        same(
            &[flag(valid), distance, n.x, n.y, n.z],
            &[
                case.output(&format!("{name}.valid")),
                case.output(&format!("{name}.distance")),
                case.output(&format!("{name}.normal")),
            ]
            .concat(),
            name,
            step,
        );
    }

    fn clearance(r: &BodyClearance) -> (bool, f64, Vec3) {
        (r.valid, r.distance, r.normal)
    }

    #[test]
    fn replays_the_ts_anatomy_bit_for_bit() {
        let corpus = Corpus::load("arm-battery");
        let mut b = body();
        let mut kinds = [0; 4];
        for (step, case) in corpus.iter().enumerate() {
            let kind = case.scalar("kind", false) as usize;
            kinds[kind] += 1;
            match kind {
                // frame
                0 => {
                    same(
                        &b.anat.radial_sign,
                        case.output("radialSign"),
                        "radialSign",
                        step,
                    );
                    same_vec(b.anat.up(), &case, "up", step);
                    same_vec(b.anat.fwd(), &case, "fwd", step);
                    same_vec(b.anat.right(), &case, "right", step);
                    same_vec(b.anat.axis_o(), &case, "axisO", step);
                }
                // pose
                1 => {
                    let side = Side::BOTH[case.scalar("side", false) as usize];
                    let (mut u, mut l, mut h) = (
                        vec3(case.input("u")),
                        vec3(case.input("l")),
                        vec3(case.input("h")),
                    );
                    let palm = vec3(case.input("palm"));
                    let palm = (case.scalar("palm.present", false) == 1.0).then_some(&palm);
                    b.place_arm(side);
                    let m = *b.anat.measure(
                        side,
                        &u,
                        &l,
                        &h,
                        palm,
                        case.scalar("forearmRoll", false),
                        case.scalar("humeralRoll", false),
                    );
                    let measured = [
                        ("elevation", m.elevation),
                        ("plane", m.plane),
                        ("rotation", m.rotation),
                        ("elbow", m.elbow),
                        ("forearm", m.forearm),
                        ("wristFlex", m.wrist_flex),
                        ("wristDev", m.wrist_dev),
                        ("torso", m.torso),
                        ("inboard", m.inboard),
                        ("rotationRead", m.rotation_read),
                    ];
                    for (name, value) in measured {
                        let name = format!("measure.{name}");
                        same(&[value], case.output(&name), &name, step);
                    }
                    same(&[b.anat.cost()], case.output("cost"), "cost", step);
                    b.anat.clamp(side, &mut u, &mut l, &mut h, palm);
                    same_vec(&u, &case, "clamp.u", step);
                    same_vec(&l, &case, "clamp.l", step);
                    same_vec(&h, &case, "clamp.h", step);
                    let (mut u, mut l, mut h) = (
                        vec3(case.input("clear.u")),
                        vec3(case.input("clear.l")),
                        vec3(case.input("clear.h")),
                    );
                    let moved = b.anat.clear_hand(side, &mut u, Some(&mut l), Some(&mut h));
                    same(&[flag(moved)], case.output("clearHand"), "clearHand", step);
                    same_vec(&u, &case, "clearHand.u", step);
                    same_vec(&l, &case, "clearHand.l", step);
                    same_vec(&h, &case, "clearHand.h", step);
                }
                // volume
                2 => {
                    let mut frame = make_body_volume_frame();
                    b.anat.capture_volume_frame(&mut frame);
                    let mut p = vec3(case.input("point"));
                    let mut rows = make_clearances();
                    b.anat.sample_volume_clearances(&frame, &p, &mut rows);
                    row(clearance(&rows[0]), &case, "torso", step);
                    row(clearance(&rows[1]), &case, "head", step);
                    let depth = b.anat.surface(&mut p);
                    same(
                        &[depth],
                        case.output("surface.depth"),
                        "surface.depth",
                        step,
                    );
                    same_vec(&p, &case, "surface.point", step);
                }
                // face
                _ => {
                    let face = b.anat.face_mut().unwrap();
                    face.refresh(&mut b.graph);
                    let mut s = FaceSurfaceSample::default();
                    face.sample(&vec3(case.input("point")), &mut s);
                    row((s.valid, s.distance, s.normal), &case, "face", step);
                }
            }
        }
        assert_eq!(kinds, [1, 24, 16, 16]);
    }
}
