//! `anatomy/volumes.ts`: the body an arm is in the way of.
//!
//! Joint angles are not the whole of a range of motion: the reason you cannot
//! swing your elbow twenty centimetres to the left is not that a shoulder runs
//! out of rotation, it is that your ribcage is there. This is that ribcage —
//! the trunk and the head, each measured off the mesh as a radius per height
//! band and angular sector — plus everything that asks a question of it: how
//! deep a point is inside, which part of the arm is deepest, and how to turn the
//! arm back out.
//!
//! Kept apart from the joint measurement because it is a different kind of
//! problem. Everything else in `arm.ts` works on directions, which is what keeps
//! it portable across rigs; this works on *positions*, and no amount of angle
//! says whether an arm is inside a chest.
//!
//! The mesh measurements arrive in [`Profile::measured`]; construction reads the same bones the
//! TS does, in the same order, so the measured tables meet the frames they were taken in.
//!
//! TS holds the trunk's axes by reference to `ArmAnatomy`'s live vectors. Here they live in
//! [`BodyVolumes`] alone and `ArmAnatomy` reads and writes them through it, so the two still
//! share one copy.

use super::face::FaceSurface;
use super::joints::{TORSO_ARM_START, TORSO_BANDS, TORSO_PASSES, TORSO_SAMPLES, TORSO_SECTORS};
use super::surface::{MeasuredVolume, SurfaceGradient, surface_of};
use super::{world_position, world_quaternion};
use crate::math::f::{atan2, js_min};
use crate::math::{Quat, Vec3};
use crate::profile::{BodyFrame, BoneSlot, Profile};
use crate::scene::graph::Graph;

/// Where a volume sits and how it is oriented, in world space, this frame.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VolumeFrame {
    pub o: Vec3,
    pub up: Vec3,
    pub right: Vec3,
    pub fwd: Vec3,
}

/// A caller-owned copy of a body's position and axes for one solver pass.
pub type VolumePose = VolumeFrame;

/// The torso and head frames captured together before a clearance query batch.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BodyVolumeFrame {
    pub torso: Option<VolumePose>,
    pub head: Option<VolumePose>,
}

// volumes.ts makeBodyVolumeFrame
//
// Make a reusable output frame for `captureVolumeFrame`.
pub fn make_body_volume_frame() -> BodyVolumeFrame {
    BodyVolumeFrame {
        torso: Some(VolumePose::default()),
        head: Some(VolumePose::default()),
    }
}

/// Which surface a [`BodyClearance`] is measured from, in `BodyClearance['surface']`'s order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Torso,
    Head,
}

/// Signed clearance from a measured radial surface or a head cap, in world metres.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BodyClearance {
    pub surface: Surface,
    /// False when the volume is absent or the point is outside its measured height.
    pub valid: bool,
    /// Negative inside the existing one-percent contact tolerance.
    pub distance: f64,
    /// World-space clearance gradient; a finite outward fallback on the volume axis.
    pub normal: Vec3,
}

impl BodyClearance {
    // volumes.ts BodyVolumes.makeClearance
    pub fn new(surface: Surface) -> BodyClearance {
        BodyClearance {
            surface,
            valid: false,
            distance: f64::INFINITY,
            normal: Vec3::default(),
        }
    }
}

/// The torso row and the head row `sampleVolumeClearances` fills.
pub fn make_clearances() -> [BodyClearance; 2] {
    [
        BodyClearance::new(Surface::Torso),
        BodyClearance::new(Surface::Head),
    ]
}

/// The existing tolerance used by torsoDepth to ignore a barely buried pose.
const TORSO_DEPTH_TOLERANCE: f64 = 0.01;

/// The head's surface plus the bone and rest axes that carry it each frame.
#[derive(Clone, Debug)]
pub struct HeadVolume {
    pub vol: MeasuredVolume,
    pub bone: u32,
    /// The skin itself, for what passes closer to it than the volume can tell.
    pub face: Option<FaceSurface>,
    /// `local.up`, `local.right`, `local.forward`: the profile's face frame, unnormalised.
    pub local_up: Vec3,
    pub local_right: Vec3,
    pub local_forward: Vec3,
    /// Where the head is this frame.
    pub frame: VolumeFrame,
}

/// Which body part a deepest point or a clamp refers to: TS's `MeasuredVolume` and
/// `VolumeFrame` references, which only ever name the trunk or the head.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Torso,
    Head,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClearPart {
    Upper,
    Forearm,
    Hand,
}

/// Where this arm starts and how long its segments are, in world units.
#[derive(Clone, Copy, Debug, Default)]
struct ArmSegments {
    s: Vec3,
    la: f64,
    lf: f64,
    lh: f64,
    set: bool,
}

/// The deepest sample found on a run of the arm, and what it is inside.
///
/// `frame` is not reset when a search finds nothing, as in TS, where the shared result keeps
/// the last frame it was given; `vol` is, and every reader checks it first.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DeepResult {
    pub depth: f64,
    pub vol: Option<Part>,
    pub frame: Option<Part>,
}

#[derive(Clone, Debug)]
pub struct BodyVolumes {
    pub torso: Option<MeasuredVolume>,
    pub head: Option<HeadVolume>,
    /// The trunk's frame: `axisO`, per frame, and the axes `ArmAnatomy::update` writes.
    trunk: VolumeFrame,
    surface_gradient: SurfaceGradient,
    in_vol: Option<Part>,
    in_frame: Part,
    arm: ArmSegments,
    deep: DeepResult,
    hit: Vec3,
    /// The frames construction handed the trunk's and the head's measurement, O, up, right, fwd.
    #[cfg(test)]
    pub measured_frames: [Option<VolumeFrame>; 2],
}

/// Rotate a chest- or head-local axis into the world.
fn rotated(v: &Vec3, q: &Quat) -> Vec3 {
    let mut out = *v;
    out.apply_quaternion(q);
    out
}

impl BodyVolumes {
    // volumes.ts BodyVolumes.constructor
    //
    // `up`, `right` and `fwd` are the trunk axes as the owner holds them now; see the module
    // comment.
    pub fn new(
        p: &Profile,
        graph: &mut Graph,
        frame: Option<&BodyFrame>,
        up: Vec3,
        right: Vec3,
        fwd: Vec3,
    ) -> BodyVolumes {
        // The torso, as a cylinder the elbow may not enter.
        //
        // Joint angles are not the whole of a range of motion. The reason you
        // cannot swing your elbow twenty centimetres to the left is not that a
        // shoulder runs out of rotation — it is that your ribcage is there. The
        // angular model approximates this at the top, through the elevation ceiling
        // that closes down across the midline, and misses it entirely at the
        // bottom: below about 25 degrees of elevation the ceiling permits any
        // plane, including pointing the upper arm straight into the chest.
        //
        // Radius is measured, not assumed: the shoulder joint sits at roughly the
        // outer edge of the trunk, so its horizontal offset from the spine is the
        // half-width. Taken at 0.9 to leave the arms their resting position, which
        // hangs slightly outboard of the shoulder on this avatar and slightly
        // inboard on others.
        //
        // In world units. Chest-local distances are not usable here — the armature
        // carries a 0.01 scale on this avatar — and the reach lengths this is
        // compared against are world-space.
        let (torso, _torso_frame) = Self::build_torso(p, graph, frame);
        let (head, _head_frame) = Self::build_head(p, graph);
        let in_vol = torso.as_ref().map(|_| Part::Torso);
        BodyVolumes {
            torso,
            head,
            trunk: VolumeFrame {
                o: Vec3::default(),
                up,
                right,
                fwd,
            },
            surface_gradient: SurfaceGradient::default(),
            in_vol,
            in_frame: Part::Torso,
            arm: ArmSegments::default(),
            deep: DeepResult::default(),
            hit: Vec3::default(),
            #[cfg(test)]
            measured_frames: [_torso_frame, _head_frame],
        }
    }

    /// The trunk's frame: `axisO` and the live axes.
    pub fn trunk(&self) -> &VolumeFrame {
        &self.trunk
    }

    /// Write the trunk's axes, as `ArmAnatomy.update` writes the vectors TS shares.
    pub fn set_axes(&mut self, up: Vec3, right: Vec3, fwd: Vec3) {
        self.trunk.up = up;
        self.trunk.right = right;
        self.trunk.fwd = fwd;
    }

    // volumes.ts BodyVolumes.armSet
    //
    // Whether an arm has been placed. See `setArm`.
    pub fn arm_set(&self) -> bool {
        self.arm.set
    }

    fn vol(&self, part: Part) -> &MeasuredVolume {
        match part {
            Part::Torso => self.torso.as_ref().expect("a torso volume"),
            Part::Head => &self.head.as_ref().expect("a head volume").vol,
        }
    }

    fn frame(&self, part: Part) -> VolumeFrame {
        match part {
            Part::Torso => self.trunk,
            Part::Head => self.head.as_ref().expect("a head volume").frame,
        }
    }

    // volumes.ts BodyVolumes.update
    //
    // Refresh what moves with the body: the trunk origin, and the head's own
    // frame — it turns and tips under the chest, so its surface has to be queried
    // in axes that turn with it.
    pub fn update(&mut self, graph: &mut Graph, chest: u32) {
        self.trunk.o = world_position(graph, chest);
        let Some(h) = &mut self.head else {
            return;
        };
        graph.update_world_matrix(h.bone, true, false, false);
        let hq = world_quaternion(graph, h.bone);
        h.frame.up = rotated(&h.local_up, &hq);
        h.frame.fwd = rotated(&h.local_forward, &hq);
        h.frame.right = rotated(&h.local_right, &hq);
        h.frame.o = world_position(graph, h.bone);
    }

    // volumes.ts BodyVolumes.captureVolumeFrame
    //
    // Copy this frame's measured body poses into reusable caller-owned storage.
    pub fn capture_volume_frame(&self, out: &mut BodyVolumeFrame) {
        out.torso = self.torso.as_ref().map(|_| self.trunk);
        out.head = self.head.as_ref().map(|h| h.frame);
    }

    // volumes.ts BodyVolumes.sampleVolumeClearances
    //
    // Sample signed clearances against the captured torso and head surfaces.
    // The measured radial tables stay on this instance; `frame` supplies only
    // the immutable position and axes for this batch.
    pub fn sample_volume_clearances(
        &mut self,
        frame: &BodyVolumeFrame,
        p: &Vec3,
        out: &mut [BodyClearance; 2],
    ) {
        let gradient = &mut self.surface_gradient;
        sample_clearance(
            Surface::Torso,
            self.torso.as_ref(),
            frame.torso.as_ref(),
            p,
            &mut out[0],
            gradient,
        );
        sample_clearance(
            Surface::Head,
            self.head.as_ref().map(|h| &h.vol),
            frame.head.as_ref(),
            p,
            &mut out[1],
            gradient,
        );
    }

    // volumes.ts BodyVolumes.setArm
    //
    // Tell the model where this arm starts and how long its two segments are, so
    // the arm can be *placed* rather than only pointed.
    //
    // Everything else here works on directions, which is what keeps it portable.
    // The torso is the exception: whether the arm is inside the chest is a
    // question about positions, and no amount of angle says it.
    pub fn set_arm(&mut self, s: &Vec3, la: f64, lf: f64, lh: f64) {
        self.arm.s.copy(s);
        self.arm.la = la;
        self.arm.lf = lf;
        self.arm.lh = lh;
        self.arm.set = true;
    }

    // volumes.ts BodyVolumes.clearArm
    pub fn clear_arm(&mut self) {
        self.arm.set = false;
    }

    // volumes.ts BodyVolumes.depthAt
    //
    // How deep a world point is inside the body — the worst of the parts it could
    // be inside. `in_vol` records which one, so a clamp knows what to push
    // out of.
    fn depth_at(&mut self, p: &Vec3) -> f64 {
        let t = &self.torso;
        let mut worst = match t {
            Some(t) => depth_in(t, &self.trunk, p),
            None => 0.0,
        };
        let mut which = t.as_ref().map(|_| Part::Torso);
        let mut frame = Part::Torso;
        if let Some(hd) = &self.head {
            let d = depth_in(&hd.vol, &hd.frame, p);
            if d > worst {
                worst = d;
                which = Some(Part::Head);
                frame = Part::Head;
            }
        }
        self.in_vol = which;
        self.in_frame = frame;
        worst
    }

    // volumes.ts BodyVolumes.surface
    //
    // Move a world point out to the surface of whichever body part it is inside,
    // along that part's own radius, in place. Returns how deep it was, 0 if clear.
    pub fn surface(&mut self, p: &mut Vec3) -> f64 {
        let depth = self.depth_at(p);
        if depth <= 0.0 {
            return 0.0;
        }
        let f = self.frame(self.in_frame);
        let mut rel = *p;
        rel.sub(&f.o);
        let mut radial = rel;
        radial.add_scaled_vector(&f.up, -rel.dot(&f.up));
        let r = radial.length();
        // On the axis itself there is no radius to follow, and no way out to prefer.
        if r < 1e-9 {
            return depth;
        }
        p.add_scaled_vector(radial.divide_scalar(r), r / (1.0 - depth) - r);
        depth
    }

    // volumes.ts BodyVolumes.torsoDepth
    //
    // How far the arm has pushed into the trunk, as a fraction of the radius.
    //
    // Sampled along both segments, not read off the elbow.
    //
    // Testing the elbow alone is what the first version did, and it misses the
    // case the constraint exists for. Bringing a hand to the chin puts the wrist
    // on the midline and the shoulder out at the side, so the arm crosses the
    // chest between them — with *both ends outside the trunk*. On the validation
    // avatar the elbow sat at 1.23 radii, comfortably clear, while the middle of
    // the upper arm was at 0.48 and the forearm went through the breast. The
    // measurement said no contact, so the elbow search had no reason to prefer
    // bringing the arm forward, and picked the pose that went straight through.
    //
    // Six samples per segment. The trunk is a cylinder approximating a ribcage;
    // resolving the deepest point to better than a sixth of a segment is precision
    // the shape does not have.
    pub fn torso_depth(&mut self, u: &Vec3, l: Option<&Vec3>, h: Option<&Vec3>) -> f64 {
        let w = self.deepest(u, l, None, h);
        // A pose the clamp has pushed out sits exactly on the surface, and floating
        // point leaves it a hair inside. Without a tolerance every such pose is
        // reported as a contact, at a depth of zero.
        if w.depth > TORSO_DEPTH_TOLERANCE {
            w.depth
        } else {
            0.0
        }
    }

    /// One sample of `deepest`'s `test`: keep it if it is the deepest yet.
    fn test(&mut self, base: &Vec3, dir: &Vec3, d: f64, into: &mut Option<&mut Vec3>) {
        let mut p = *base;
        p.add_scaled_vector(dir, d);
        let depth = self.depth_at(&p);
        if depth > self.deep.depth {
            self.deep.depth = depth;
            self.deep.vol = self.in_vol;
            self.deep.frame = Some(self.in_frame);
            if let Some(into) = into {
                into.copy(&p);
            }
        }
    }

    // volumes.ts BodyVolumes.deepest
    //
    // The most buried point on the arm, in world space. `into`, if given, receives
    // that point, and `res.vol`/`res.frame` say which body part it is inside so
    // the clamp knows what to push out of.
    pub fn deepest(
        &mut self,
        u: &Vec3,
        l: Option<&Vec3>,
        mut into: Option<&mut Vec3>,
        h: Option<&Vec3>,
    ) -> DeepResult {
        self.deep.depth = 0.0;
        self.deep.vol = None;
        if !(self.torso.is_some() && self.arm.set) {
            return self.deep;
        }
        let ArmSegments { s, la, lf, lh, .. } = self.arm;
        let span = la * (1.0 - TORSO_ARM_START);
        for i in 0..=TORSO_SAMPLES {
            let d = la * TORSO_ARM_START + (span * i as f64) / TORSO_SAMPLES as f64;
            self.test(&s, u, d, &mut into);
        }
        let Some(l) = l else {
            return self.deep;
        };
        if lf <= 0.0 {
            return self.deep;
        }
        let mut e = s;
        e.add_scaled_vector(u, la);
        for i in 1..=TORSO_SAMPLES {
            self.test(&e, l, (lf * i as f64) / TORSO_SAMPLES as f64, &mut into);
        }
        // The hand, along the palm only. Testable at all because the surface is
        // measured: against a cylinder the front of the chest reads far too wide,
        // and a hand deliberately laid on the sternum could not be told from one
        // pushed through it.
        if let Some(h) = h
            && lh > 0.0
        {
            let mut w = e;
            w.add_scaled_vector(l, lf);
            for i in 1..=TORSO_SAMPLES {
                self.test(&w, h, (lh * i as f64) / TORSO_SAMPLES as f64, &mut into);
            }
        }
        self.deep
    }

    // volumes.ts BodyVolumes.clear
    //
    // Lift the arm out of the body, in place. Returns whether it moved.
    //
    // Each segment is relieved by the joint that actually controls it — the upper
    // arm by turning the whole arm about the shoulder, the forearm about the
    // elbow, the hand about the wrist — working proximal to distal so that fixing
    // one never re-buries the one above it.
    //
    // The previous version rotated the whole arm rigidly for every case. With one
    // volume that is fine. With two it deadlocks: lifting the hand out of the head
    // swings the upper arm into the chest, the next pass swings it back, and the
    // loop ping-pongs without converging. On the frames where it happened to
    // converge and the frames where it did not, the arm differed by the whole
    // escape rotation, so a held pose juddered by forty degrees.
    //
    // Turning the hand about the wrist moves nothing else, which is why the
    // deadlock goes away: the three constraints stop competing for one rotation.
    //
    // Two further things about how this is done, each of them a bug that was here.
    //
    // **The point pushed is the deepest one on the segment, not its end.** An arm
    // reaching across the body has both ends clear and its middle inside. On the
    // validation avatar the elbow sat at 1.23 radii while the middle of the upper
    // arm was at 0.48 — no contact reported, nothing corrected, and the forearm
    // through the breast.
    //
    // **The escape is a rotation, not a radial shove.** Moving one sample out
    // along the radius and re-deriving a direction from it works when the sample
    // is the far end of the segment and barely at all when it is near the pivot.
    //
    // `only_hand` is TS's `only === 'hand'`.
    pub fn clear(
        &mut self,
        u: &mut Vec3,
        mut l: Option<&mut Vec3>,
        mut h: Option<&mut Vec3>,
        lateral: &Vec3,
        only_hand: bool,
    ) -> bool {
        if !(self.torso.is_some() && self.arm.set) {
            return false;
        }
        let ArmSegments { s, la, lf, lh, .. } = self.arm;
        let mut moved = false;

        // The upper arm has only the shoulder above it, so the whole arm turns.
        if !only_hand
            && self.relieve(
                &s,
                la * TORSO_ARM_START,
                la,
                lateral,
                ClearPart::Upper,
                u,
                l.as_deref_mut(),
                h.as_deref_mut(),
            )
        {
            moved = true;
        }

        // The forearm turns about the elbow, leaving the upper arm where it is.
        if l.is_some() && !only_hand && lf > 0.0 {
            let mut elbow = s;
            elbow.add_scaled_vector(u, la);
            if self.relieve(
                &elbow,
                lf / TORSO_SAMPLES as f64,
                lf,
                lateral,
                ClearPart::Forearm,
                u,
                l.as_deref_mut(),
                h.as_deref_mut(),
            ) {
                moved = true;
            }
        }

        // The hand turns about the wrist and moves nothing else at all.
        if h.is_some()
            && let Some(fore) = l.as_deref()
            && lh > 0.0
        {
            let mut elbow = s;
            elbow.add_scaled_vector(u, la);
            let mut wrist = elbow;
            wrist.add_scaled_vector(fore, lf);
            if self.relieve(
                &wrist,
                lh / TORSO_SAMPLES as f64,
                lh,
                lateral,
                ClearPart::Hand,
                u,
                l,
                h,
            ) {
                moved = true;
            }
        }

        moved
    }

    // volumes.ts BodyVolumes.push
    //
    // Turn the arm by whatever takes the buried point out to the surface,
    // about `pivot`. Returns false when there is no rotation to make.
    #[allow(clippy::too_many_arguments)]
    fn push(
        &self,
        pivot: &Vec3,
        res: &DeepResult,
        lateral: &Vec3,
        part: ClearPart,
        u: &mut Vec3,
        l: Option<&mut Vec3>,
        h: Option<&mut Vec3>,
    ) -> bool {
        let (Some(frame), Some(vol)) = (res.frame, res.vol) else {
            return false;
        };
        let f = self.frame(frame);
        let mut rel = self.hit;
        rel.sub(&f.o);
        let y = rel.dot(&f.up);
        let mut rad = rel;
        rad.add_scaled_vector(&f.up, -y);
        // Straight down the axis there is no radial direction to push along, so
        // use the arm's own side — outward is unambiguous there.
        if rad.length() < 1e-6 {
            rad.copy(lateral);
        }
        rad.normalize();
        let r = surface_of(
            self.vol(vol),
            y,
            atan2(rad.dot(&f.fwd), rad.dot(&f.right)),
            None,
        );
        let mut want = rad;
        want.multiply_scalar(r)
            .add_scaled_vector(&f.up, y)
            .add(&f.o);
        let mut from = self.hit;
        from.sub(pivot);
        want.sub(pivot);
        if from.length_sq() < 1e-12 || want.length_sq() < 1e-12 {
            return false;
        }
        from.normalize();
        want.normalize();
        if from.dot(&want) > 1.0 - 1e-9 {
            return false;
        }
        let mut swing = Quat::default();
        swing.set_from_unit_vectors(&from, &want);
        apply_clear(part, &swing, u, l, h);
        true
    }

    // volumes.ts BodyVolumes.relieve
    //
    // The surface is curved and a segment is straight, so clearing the deepest
    // point can leave a neighbour as the new worst. The loop stops the moment
    // nothing is buried, so the passes cost nothing on a pose already clear.
    //
    // The segment runs from `pivot` along the direction `part` names, read afresh each pass
    // because the escape turns it. `!(len > 0)` is TS's: a NaN length relieves nothing.
    #[allow(clippy::too_many_arguments, clippy::neg_cmp_op_on_partial_ord)]
    fn relieve(
        &mut self,
        pivot: &Vec3,
        from: f64,
        len: f64,
        lateral: &Vec3,
        part: ClearPart,
        u: &mut Vec3,
        mut l: Option<&mut Vec3>,
        mut h: Option<&mut Vec3>,
    ) -> bool {
        if !(len > 0.0) {
            return false;
        }
        let mut moved = false;
        for _ in 0..TORSO_PASSES {
            let dir = match part {
                ClearPart::Upper => *u,
                ClearPart::Forearm => *l.as_deref().expect("a forearm to relieve"),
                ClearPart::Hand => *h.as_deref().expect("a hand to relieve"),
            };
            let mut hit = self.hit;
            let res = self.deepest_seg(pivot, &dir, from, len, Some(&mut hit));
            self.hit = hit;
            if res.depth <= 0.0 {
                return moved;
            }
            if !self.push(
                pivot,
                &res,
                lateral,
                part,
                u,
                l.as_deref_mut(),
                h.as_deref_mut(),
            ) {
                return moved;
            }
            moved = true;
        }
        moved
    }

    // volumes.ts BodyVolumes.deepestSeg
    //
    // The deepest sample on one straight run of the arm, in world space.
    pub fn deepest_seg(
        &mut self,
        base: &Vec3,
        dir: &Vec3,
        from: f64,
        len: f64,
        mut into: Option<&mut Vec3>,
    ) -> DeepResult {
        self.deep.depth = 0.0;
        self.deep.vol = None;
        if !(self.torso.is_some() && len > from) {
            return self.deep;
        }
        for i in 0..=TORSO_SAMPLES {
            let d = from + ((len - from) * i as f64) / TORSO_SAMPLES as f64;
            self.test(base, dir, d, &mut into);
        }
        self.deep
    }

    // volumes.ts BodyVolumes.measureTorso
    //
    // Trunk half-width and vertical span, in world units, from the rest pose.
    fn measure_torso(
        p: &Profile,
        graph: &mut Graph,
        frame: Option<&BodyFrame>,
    ) -> Option<MeasuredVolume> {
        let chest = p.chest();
        // The upper arm and not the clavicle. `shoulder.*` is the clavicle root,
        // which sits beside the neck: measured from there the trunk came out with a
        // radius of 0.034 against an upper arm of 0.171, a torso a fifth as wide as
        // one arm segment, and nothing ever touched it. The glenohumeral joint is
        // where the arm actually hangs from, and it is at the edge of the trunk.
        let sl = p
            .bone(BoneSlot::UpperArmL)
            .or_else(|| p.bone(BoneSlot::ShoulderL));
        let sr = p
            .bone(BoneSlot::UpperArmR)
            .or_else(|| p.bone(BoneSlot::ShoulderR));
        let (Some(chest), Some(sl), Some(sr), Some(frame)) = (chest, sl, sr, frame) else {
            return None;
        };
        let q = world_quaternion(graph, chest);
        let up = rotated(&frame.up, &q);
        let o = world_position(graph, chest);
        // Horizontal distance from the trunk axis to each shoulder.
        let mut off = |b: u32| {
            let mut v = world_position(graph, b);
            v.sub(&o);
            let along = -v.dot(&up);
            v.add_scaled_vector(&up, along);
            v.length()
        };
        let radius = ((off(sl) + off(sr)) / 2.0) * 0.9;
        // Only between the hips and the shoulders is there a trunk to hit.
        let hips = match p.bone(BoneSlot::Hips) {
            Some(hips) => {
                let mut v = world_position(graph, hips);
                v.sub(&o).dot(&up)
            }
            None => -radius * 3.0,
        };
        let mut top = world_position(graph, sr);
        let top = top.sub(&o).dot(&up);
        (radius > 1e-6).then(|| MeasuredVolume {
            r: None,
            bands: TORSO_BANDS as f64,
            sectors: TORSO_SECTORS as f64,
            radius,
            top,
            bottom: js_min(hips, top - 1e-4),
        })
    }

    // volumes.ts BodyVolumes.buildTorso
    //
    // The trunk's actual surface, measured off the mesh.
    //
    // A cylinder sized from the shoulders is the wrong shape, and being the wrong
    // shape it cannot be tuned into the right answer: a chest is markedly wider
    // than it is deep, so one radius is simultaneously too small at the sides and
    // too large in front. Too small at the sides means an arm crossing the body
    // passes through the ribs with nothing reported; too large in front means a
    // hand deliberately placed on the sternum reads as buried, so the poses that
    // *should* touch the chest cannot be told from the ones that go through it.
    //
    // Stored as a radius per (height band, angular sector) in the chest's own
    // frame, which is the same frame the cylinder used — so it still follows the
    // chest when the spine turns, and the query is still a couple of lookups.
    //
    // Read at load, before anything is posed, with each vertex put through
    // three's own skinning transform (see `measureVolume`), so what is measured is
    // the rest shape where the mesh actually draws it.
    //
    // Only vertices whose *dominant* bone is part of the trunk are counted. The
    // arms rest inside the trunk's height band in a bind pose, and a maximum over
    // everything there would inflate the sides by an entire arm.
    //
    // The bone walk and the vertex binning are TS's: the table arrives as
    // `measured.torso`, measured at the fixed height range `measureTorso` returns. The frame it
    // was measured in is read here as TS reads it, and returned beside the volume.
    fn build_torso(
        p: &Profile,
        graph: &mut Graph,
        frame: Option<&BodyFrame>,
    ) -> (Option<MeasuredVolume>, Option<VolumeFrame>) {
        let base = Self::measure_torso(p, graph, frame);
        let chest = p.chest();
        let (Some(base), Some(frame), Some(chest)) = (base, frame, chest) else {
            return (None, None);
        };
        let q = world_quaternion(graph, chest);
        let measured_in = VolumeFrame {
            up: rotated(&frame.up, &q),
            right: rotated(&frame.right, &q),
            fwd: rotated(&frame.forward, &q),
            o: world_position(graph, chest),
        };
        // The height range is fixed rather than taken from the vertices: the trunk
        // has to stop at the shoulders, or the neck stub raises its top and an arm
        // resting beside the neck reads as inside the body.
        let volume = match &p.measured.torso {
            Some(vol) => vol.clone(),
            None => base,
        };
        (Some(volume), Some(measured_in))
    }

    // volumes.ts BodyVolumes.buildHead
    //
    // The head, measured the same way as the trunk.
    //
    // A separate volume rather than an extension of the trunk because it moves
    // separately: a head turns and tips under the chest, so a surface stored in
    // the chest's frame would swing away from the skull it is meant to describe.
    // Its own frame is the one the face anchors already use.
    //
    // Without it the whole face is empty space to the arm. Every gesture in the
    // table that touches the face aims at a point *on* the head, so the hand
    // arrives at the surface and the fingers carry on into it.
    //
    // The extent is taken from the vertices rather than from bones, because there
    // is no second bone to measure a head against the way the shoulders measure
    // the trunk.
    //
    // Hair is excluded for free: it hangs off its own bones, so the dominant-bone
    // filter never sees it. That is the behaviour to want — a hand should be able
    // to touch hair, and pushing it out to the far side of a twintail would put it
    // a head's width away from the head.
    //
    // The volume and the skin arrive as `measured.head` and `measured.face`.
    fn build_head(p: &Profile, graph: &mut Graph) -> (Option<HeadVolume>, Option<VolumeFrame>) {
        let (Some(head), Some(face)) = (p.bone(BoneSlot::Head), p.face.as_ref()) else {
            return (None, None);
        };
        let q = world_quaternion(graph, head);
        let normalized = |v: &Vec3| {
            let mut out = rotated(v, &q);
            out.normalize();
            out
        };
        let measured_in = VolumeFrame {
            up: normalized(&face.up),
            right: normalized(&face.right),
            fwd: normalized(&face.forward),
            o: world_position(graph, head),
        };
        let Some(vol) = &p.measured.head else {
            return (None, Some(measured_in));
        };
        let skin = p.measured.face.as_ref().map(|skin| {
            // face.ts headFrame, which `FaceSurface.measure` reads the skin in.
            graph.update_world_matrix(head, true, false, false);
            world_position(graph, head);
            world_quaternion(graph, head);
            FaceSurface::new(head, skin)
        });
        let volume = HeadVolume {
            vol: vol.clone(),
            bone: head,
            face: skin,
            local_up: face.up,
            local_right: face.right,
            local_forward: face.forward,
            frame: VolumeFrame::default(),
        };
        (Some(volume), Some(measured_in))
    }
}

// volumes.ts BodyVolumes.sampleClearance
fn sample_clearance(
    surface: Surface,
    vol: Option<&MeasuredVolume>,
    pose: Option<&VolumePose>,
    p: &Vec3,
    result: &mut BodyClearance,
    gradient: &mut SurfaceGradient,
) {
    result.surface = surface;
    result.valid = false;
    result.distance = f64::INFINITY;
    result.normal.set(0.0, 0.0, 0.0);
    let (Some(vol), Some(pose)) = (vol, pose) else {
        return;
    };

    let mut rel = *p;
    rel.sub(&pose.o);
    let h = rel.dot(&pose.up);
    if h > vol.top || h < vol.bottom {
        return;
    }

    let mut radial = rel;
    radial.add_scaled_vector(&pose.up, -h);
    let r = radial.length();
    let radius = surface_of(
        vol,
        h,
        atan2(radial.dot(&pose.fwd), radial.dot(&pose.right)),
        Some(gradient),
    );
    result.valid = true;
    result.distance = r - radius * (1.0 - TORSO_DEPTH_TOLERANCE);
    let top = h - vol.top;
    let bottom = vol.bottom - h;
    // The radial table is flat in its end half-bands. Both volumes still have
    // caps there, or clearance jumps from buried to absent across one; choose
    // the outward cap gradient on a tied boundary.
    if top >= result.distance && top >= bottom {
        result.distance = top;
        result.normal.copy(&pose.up);
        return;
    }
    if bottom >= result.distance {
        result.distance = bottom;
        result.normal.copy(&pose.up).negate();
        return;
    }
    if r > 1e-9 {
        let tolerance_scale = 1.0 - TORSO_DEPTH_TOLERANCE;
        let bearing_scale = (tolerance_scale * gradient.bearing) / (r * r);
        // Keep the gradient magnitude: the QP linearizes this same clearance,
        // so normalizing only its derivative would change the constraint.
        result
            .normal
            .copy(&radial)
            .divide_scalar(r)
            .add_scaled_vector(&pose.up, -tolerance_scale * gradient.height)
            .add_scaled_vector(&pose.right, bearing_scale * radial.dot(&pose.fwd))
            .add_scaled_vector(&pose.fwd, -bearing_scale * radial.dot(&pose.right));
    } else {
        // Bearing and the radial derivative are undefined on the axis.
        result.normal.copy(&pose.fwd);
        if result.normal.length_sq() > 1e-18 {
            result.normal.normalize();
        } else {
            result.normal.set(0.0, 0.0, 1.0);
        }
    }
}

// volumes.ts BodyVolumes.depthIn
//
// How deep a world point is inside one volume, as a fraction of its radius.
// Zero when clear, or outside the volume's height.
fn depth_in(vol: &MeasuredVolume, f: &VolumeFrame, p: &Vec3) -> f64 {
    let mut rel = *p;
    rel.sub(&f.o);
    let h = rel.dot(&f.up);
    if h > vol.top || h < vol.bottom {
        return 0.0;
    }
    let mut radial = rel;
    radial.add_scaled_vector(&f.up, -h);
    let r = radial.length();
    let radius = surface_of(
        vol,
        h,
        atan2(radial.dot(&f.fwd), radial.dot(&f.right)),
        None,
    );
    if radius > 1e-9 {
        (radius - r) / radius
    } else {
        0.0
    }
}

// volumes.ts BodyVolumes.applyClear
fn apply_clear(
    part: ClearPart,
    q: &Quat,
    u: &mut Vec3,
    l: Option<&mut Vec3>,
    h: Option<&mut Vec3>,
) {
    match part {
        ClearPart::Upper => {
            u.apply_quaternion(q).normalize();
            if let Some(l) = l {
                l.apply_quaternion(q).normalize();
            }
            if let Some(h) = h {
                h.apply_quaternion(q).normalize();
            }
        }
        ClearPart::Forearm => {
            let Some(l) = l else {
                return;
            };
            l.apply_quaternion(q).normalize();
            if let Some(h) = h {
                h.apply_quaternion(q).normalize();
            }
        }
        ClearPart::Hand => {
            if let Some(h) = h {
                h.apply_quaternion(q).normalize();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::arm::ArmAnatomy;
    use super::super::joints::{HAND_CONTACT, TORSO_SAMPLES};
    use super::super::testkit::{Body, arm_of, body, body_of, close, graph_and_profile};
    use super::*;
    use crate::corpus_replay::AvatarBase;
    use crate::math::f::{CBRT_EPSILON, js_max};
    use crate::profile::{Side, base};
    use core::f64::consts::PI;

    struct Subject {
        b: Body,
        volumes: BodyVolumes,
    }

    /// `buildSubject`: the base avatar turned and scaled, its anatomy, and a second
    /// `BodyVolumes` over the anatomy's axes.
    fn subject(yaw: f64, scale: f64) -> Subject {
        let (graph, profile) = graph_and_profile(yaw, scale);
        let mut b = body_of(graph, profile);
        let chest = b.chest();
        let (up, right, fwd) = (*b.anat.up(), *b.anat.right(), *b.anat.fwd());
        let mut volumes = BodyVolumes::new(
            &b.profile,
            &mut b.graph,
            b.profile.body.as_ref(),
            up,
            right,
            fwd,
        );
        volumes.update(&mut b.graph, chest);
        Subject { b, volumes }
    }

    fn captured(volumes: &BodyVolumes) -> BodyVolumeFrame {
        let mut frame = make_body_volume_frame();
        volumes.capture_volume_frame(&mut frame);
        frame
    }

    fn at(o: &Vec3, steps: &[(&Vec3, f64)]) -> Vec3 {
        let mut p = *o;
        for (v, s) in steps {
            p.add_scaled_vector(v, *s);
        }
        p
    }

    fn component(v: &mut Vec3, axis: usize) -> &mut f64 {
        match axis {
            0 => &mut v.x,
            1 => &mut v.y,
            _ => &mut v.z,
        }
    }

    #[test]
    fn construction_reads_the_frames_the_measurements_were_taken_in() {
        // The recorded tables are only right in the frame TS measured them in, so the frame
        // construction reads has to be that one, bit for bit.
        let avatar = AvatarBase::load();
        let mut graph = base::graph(&avatar);
        let profile = base::profile(&avatar);
        graph.update_world_matrix(0, true, true, false);
        let anat = ArmAnatomy::new(&profile, &mut graph);
        let [torso, head] = anat.body().measured_frames;
        for (name, got) in [("torso", torso.unwrap()), ("head", head.unwrap())] {
            let want = base::measured_frame(&avatar, name);
            for (g, w) in [got.o, got.up, got.right, got.fwd].iter().zip(&want) {
                assert_eq!(
                    [g.x.to_bits(), g.y.to_bits(), g.z.to_bits()],
                    [w.x.to_bits(), w.y.to_bits(), w.z.to_bits()],
                    "{name}"
                );
            }
        }
        // `measureTorso` fixes the trunk's height range the measurement was binned over.
        let torso = anat.body().torso.as_ref().unwrap();
        let recorded = profile.measured.torso.as_ref().unwrap();
        assert_eq!(torso, recorded);
        let base = BodyVolumes::measure_torso(&profile, &mut graph, profile.body.as_ref()).unwrap();
        assert_eq!(base.top.to_bits(), recorded.top.to_bits());
        assert_eq!(base.bottom.to_bits(), recorded.bottom.to_bits());
        assert!(anat.face().is_some());
    }

    // volume-caps.test.ts
    //
    // The trunk has ends. Measured as a radius per height band, its signed
    // clearance used to stop at the top and bottom: a point well inside the ribs a
    // hair below the shoulders read as deeply buried, and the same point a hair
    // above as absent.
    #[test]
    fn the_torso_caps_close_the_clearance_to_contact() {
        for top in [true, false] {
            let mut s = subject(0.0, 1.0);
            let frame = captured(&s.volumes);
            let pose = frame.torso.unwrap();
            let torso = s.volumes.torso.clone().unwrap();
            let sign = if top { 1.0 } else { -1.0 };
            let cap = if top { torso.top } else { torso.bottom };
            let span = torso.top - torso.bottom;
            let mut previous = f64::NEG_INFINITY;
            for inset in [span * 0.02, span * 0.01, span * 0.001, 0.0] {
                // A point at half the radius in front of the axis, `inset` inside the cap.
                let h = cap - sign * inset;
                let r = surface_of(&torso, h, PI / 2.0, None);
                let p = at(&pose.o, &[(&pose.up, h), (&pose.fwd, r * 0.5)]);
                let mut rows = make_clearances();
                s.volumes.sample_volume_clearances(&frame, &p, &mut rows);
                let row = rows[0];
                assert!(row.valid);
                close(row.distance, -inset, 12);
                close(row.normal.dot(&pose.up), sign, 12);
                assert!(row.distance > previous);
                previous = row.distance;
            }
        }
    }

    #[test]
    fn returns_the_full_height_and_bearing_clearance_gradient() {
        for (yaw, scale) in [(0.0, 1.0), (0.7, 1.3)] {
            let mut s = subject(yaw, scale);
            let snapshot = captured(&s.volumes);
            let pose = snapshot.torso.unwrap();
            let volume = s.volumes.torso.as_mut().unwrap();
            volume.bands = 3.0;
            volume.sectors = 4.0;
            let radius = volume.radius;
            volume.r = Some(
                (0..12)
                    .map(|i| {
                        (radius * (1.0 + 0.1 * f64::from(i / 4) + 0.05 * f64::from(i % 4))) as f32
                    })
                    .collect(),
            );
            let volume = volume.clone();
            let height =
                volume.bottom + (volume.top - volume.bottom) * ((0.35 + 0.5) / volume.bands);
            let theta = ((1.25 + 0.5) / volume.sectors) * PI * 2.0;
            let mut radial = pose.right;
            radial
                .multiply_scalar(theta.cos())
                .add_scaled_vector(&pose.fwd, theta.sin());
            let point = at(
                &pose.o,
                &[
                    (&pose.up, height),
                    (&radial, surface_of(&volume, height, theta, None) * 0.8),
                ],
            );
            let mut read = |p: &Vec3| {
                let mut rows = make_clearances();
                s.volumes.sample_volume_clearances(&snapshot, p, &mut rows);
                rows[0]
            };
            let result = read(&point);
            let step = CBRT_EPSILON * (volume.top - volume.bottom);
            let mut numerical = Vec3::default();
            for axis in 0..3 {
                let (mut plus, mut minus) = (point, point);
                *component(&mut plus, axis) += step;
                *component(&mut minus, axis) -= step;
                *component(&mut numerical, axis) =
                    (read(&plus).distance - read(&minus).distance) / (2.0 * step);
            }
            assert!(result.valid);
            assert!(result.distance < 0.0);
            assert!(result.normal.distance_to(&numerical) < 1e-8);
            assert!(result.normal.dot(&pose.up) < 0.0);
            close(result.normal.dot(&radial), 1.0, 10);
            assert!(result.normal.length() > 1.0);
        }
    }

    #[test]
    fn uses_the_measured_head_caps_to_leave_the_volume_vertically() {
        for top in [true, false] {
            let mut s = subject(0.7, 1.3);
            let snapshot = captured(&s.volumes);
            let pose = snapshot.head.unwrap();
            let volume = s.volumes.head.as_ref().unwrap().vol.clone();
            let mut outward = pose.up;
            outward.multiply_scalar(if top { 1.0 } else { -1.0 });
            let height = if top { volume.top } else { volume.bottom };
            let boundary = at(
                &pose.o,
                &[
                    (&pose.up, height),
                    (&pose.fwd, surface_of(&volume, height, PI / 2.0, None) * 0.2),
                ],
            );
            let step = CBRT_EPSILON * (volume.top - volume.bottom);
            let inside = at(&boundary, &[(&outward, -step)]);
            let mut read = |p: &Vec3| {
                let mut rows = make_clearances();
                s.volumes.sample_volume_clearances(&snapshot, p, &mut rows);
                rows[1]
            };
            let contact = read(&boundary);
            let buried = read(&inside);
            assert!(contact.valid);
            close(contact.distance, 0.0, 12);
            assert!(contact.normal.distance_to(&outward) < 1e-12);
            assert!(buried.valid);
            close(buried.distance, -step, 12);
            assert!(buried.normal.distance_to(&outward) < 1e-12);
            let restored = at(&inside, &[(&buried.normal, -buried.distance)]);
            close(read(&restored).distance, 0.0, 12);
        }
    }

    #[test]
    fn agrees_with_the_arm_proxy_loops() {
        // The scaled variant is left out: the recorded tables and lengths were measured at
        // scale 1, so scaling the bones alone would not be the avatar TS scales.
        for (yaw, scale) in [(0.0, 1.0), (0.7, 1.0)] {
            let mut s = subject(yaw, scale);
            let mut snapshot = make_body_volume_frame();
            s.b.anat.capture_volume_frame(&mut snapshot);
            let (sh, la, lf, _) = arm_of(&mut s.b.graph, &s.b.profile, Side::L);
            let lh = s.b.profile.limb[0].tip[2].unwrap() * HAND_CONTACT;
            let (right, up) = (*s.b.anat.right(), *s.b.anat.up());
            let mut across = right;
            across.add_scaled_vector(&up, -0.3).normalize();
            let mut down = up;
            down.negate();
            let (mut saw_contact, mut saw_clear) = (false, false);
            for d in [across, down] {
                // proxyPoints: the upper arm from TORSO_ARM_START, then the forearm and hand.
                let mut points = Vec::new();
                let span = la * (1.0 - TORSO_ARM_START);
                for i in 0..=TORSO_SAMPLES {
                    let along = la * TORSO_ARM_START + (span * i as f64) / TORSO_SAMPLES as f64;
                    points.push(at(&sh, &[(&d, along)]));
                }
                let e = at(&sh, &[(&d, la)]);
                for i in 1..=TORSO_SAMPLES {
                    points.push(at(&e, &[(&d, (lf * i as f64) / TORSO_SAMPLES as f64)]));
                }
                let w = at(&e, &[(&d, lf)]);
                for i in 1..=TORSO_SAMPLES {
                    points.push(at(&w, &[(&d, (lh * i as f64) / TORSO_SAMPLES as f64)]));
                }
                assert_eq!(points.len(), 3 * TORSO_SAMPLES + 1);
                s.b.anat.set_arm(&sh, la, lf, lh);
                s.b.anat.measure(Side::L, &d, &d, &d, None, 0.0, 0.0);
                let legacy_contact = s.b.anat.m.torso > 0.0;
                let mut signed_contact = false;
                for p in &points {
                    let mut rows = make_clearances();
                    s.b.anat.sample_volume_clearances(&snapshot, p, &mut rows);
                    for (k, entry) in rows.iter().enumerate() {
                        if !entry.valid {
                            continue;
                        }
                        signed_contact |= entry.distance < 0.0;
                        let pose = if k == 0 {
                            snapshot.torso
                        } else {
                            snapshot.head
                        }
                        .unwrap();
                        let vol = if k == 0 {
                            s.volumes.torso.clone().unwrap()
                        } else {
                            s.volumes.head.as_ref().unwrap().vol.clone()
                        };
                        let mut rel = *p;
                        rel.sub(&pose.o);
                        let height = rel.dot(&pose.up);
                        let mut radial = rel;
                        radial.add_scaled_vector(&pose.up, -height);
                        let n = entry.normal;
                        assert!(n.x.is_finite() && n.y.is_finite() && n.z.is_finite());
                        let (top, bottom) = (height - vol.top, vol.bottom - height);
                        if entry.distance == js_max(top, bottom) {
                            close(n.dot(&pose.up), if top >= bottom { 1.0 } else { -1.0 }, 10);
                        } else {
                            // A radial surface's gradient has unit radial component, but its
                            // height and bearing components must retain their magnitude.
                            close(n.dot(radial.normalize()), 1.0, 10);
                        }
                    }
                }
                assert_eq!(signed_contact, legacy_contact);
                saw_contact |= legacy_contact;
                saw_clear |= !legacy_contact;
            }
            assert!(saw_contact && saw_clear);
        }
    }

    #[test]
    fn keeps_the_one_percent_torso_contact_boundary_on_both_sides() {
        let mut b = body();
        let mut snapshot = make_body_volume_frame();
        b.anat.capture_volume_frame(&mut snapshot);
        let pose = snapshot.torso.unwrap();
        let torso = b.anat.body().torso.clone().unwrap();
        let h = (torso.top + torso.bottom) * 0.5;
        let r = surface_of(&torso, h, 0.0, None);
        let radial = pose.right;
        let mut at_depth = |depth: f64| {
            let p = at(&pose.o, &[(&pose.up, h), (&radial, r * (1.0 - depth))]);
            let mut rows = make_clearances();
            b.anat.sample_volume_clearances(&snapshot, &p, &mut rows);
            assert!(rows[0].valid);
            b.anat.set_arm(&at(&p, &[(&radial, -1e-8)]), 1e-8, 0.0, 0.0);
            b.anat
                .measure(Side::L, &radial, &radial, &radial, None, 0.0, 0.0);
            (rows[0].distance, b.anat.m.torso)
        };
        let inside = at_depth(0.0101);
        let outside = at_depth(0.0099);
        assert!(inside.0 < 0.0);
        assert!(inside.1 > 0.0);
        assert!(outside.0 > 0.0);
        assert_eq!(outside.1, 0.0);
        close(at_depth(0.01).0, 0.0, 7);
    }

    #[test]
    fn uses_the_captured_frames_after_live_bones_move() {
        let mut s = subject(0.4, 1.1);
        let mut snapshot = make_body_volume_frame();
        s.b.anat.capture_volume_frame(&mut snapshot);
        let old = snapshot;
        let head_pose = snapshot.head.unwrap();
        let head_point = at(
            &head_pose.o,
            &[(&head_pose.up, 0.015), (&head_pose.fwd, 0.12)],
        );
        let input_before = head_point;
        let read = |anat: &mut ArmAnatomy, frame: &BodyVolumeFrame, p: &Vec3| {
            let mut rows = make_clearances();
            anat.sample_volume_clearances(frame, p, &mut rows);
            rows
        };
        let before = read(&mut s.b.anat, &snapshot, &head_point);
        assert!(before[1].valid);
        let torso_pose = snapshot.torso.unwrap();
        let torso = s.volumes.torso.clone().unwrap();
        let torso_point = at(
            &torso_pose.o,
            &[
                (&torso_pose.up, (torso.top + torso.bottom) * 0.5),
                (&torso_pose.right, 0.02),
            ],
        );
        let torso_before = read(&mut s.b.anat, &snapshot, &torso_point);
        assert!(torso_before[0].valid);

        let chest = s.b.chest() as usize;
        let head = s.b.profile.bone(BoneSlot::Head).unwrap() as usize;
        s.b.graph.position[3 * chest] += 0.08;
        s.b.graph.position[3 * head + 2] += 0.1;
        s.b.graph.update_matrix_world(0, true);
        assert!(s.b.anat.update(&mut s.b.graph));

        assert_eq!(read(&mut s.b.anat, &snapshot, &head_point), before);
        assert_eq!(read(&mut s.b.anat, &snapshot, &torso_point), torso_before);
        assert_eq!(head_point, input_before);
        assert_eq!(snapshot, old);

        let mut next = make_body_volume_frame();
        s.b.anat.capture_volume_frame(&mut next);
        assert!(next.head.unwrap().o.distance_to(&head_pose.o) > 0.05);
        assert_ne!(
            read(&mut s.b.anat, &next, &head_point)[1].distance,
            before[1].distance
        );
        assert!(next.torso.unwrap().o.distance_to(&torso_pose.o) > 0.05);
        assert_ne!(
            read(&mut s.b.anat, &next, &torso_point)[0].distance,
            torso_before[0].distance
        );
    }

    #[test]
    fn uses_finite_normals_on_the_axis_and_neutral_rows_outside() {
        let mut b = body();
        let mut snapshot = make_body_volume_frame();
        b.anat.capture_volume_frame(&mut snapshot);
        let head_pose = snapshot.head.unwrap();
        let head_volume = b.anat.body().head.as_ref().unwrap().vol.clone();
        let axial = at(&head_pose.o, &[(&head_pose.up, 0.01)]);
        let mut rows = make_clearances();
        b.anat
            .sample_volume_clearances(&snapshot, &axial, &mut rows);
        let head = rows[1];
        assert!(head.valid);
        assert!(head.distance.is_finite());
        assert!(
            head.normal.x.is_finite() && head.normal.y.is_finite() && head.normal.z.is_finite()
        );
        assert!(head.normal.dot(&head_pose.fwd) > 0.999999);
        assert_eq!(rows.map(|r| r.surface), [Surface::Torso, Surface::Head]);

        let outside = at(
            &head_pose.o,
            &[
                (&head_pose.up, head_volume.top + 0.1),
                (&head_pose.fwd, 0.1),
            ],
        );
        let mut out = make_clearances();
        out[1].valid = true;
        out[1].distance = 23.0;
        out[1].normal.set(1.0, 2.0, 3.0);
        b.anat
            .sample_volume_clearances(&snapshot, &outside, &mut out);
        assert!(!out[1].valid);
        assert_eq!(out[1].distance, f64::INFINITY);
        assert_eq!(out[1].normal, Vec3::default());

        let torso_pose = snapshot.torso.unwrap();
        let torso = b.anat.body().torso.clone().unwrap();
        let outside_torso = at(
            &torso_pose.o,
            &[(&torso_pose.up, torso.top + 0.1), (&torso_pose.fwd, 0.1)],
        );
        b.anat
            .sample_volume_clearances(&snapshot, &outside_torso, &mut out);
        assert!(!out[0].valid);
        assert_eq!(out[0].distance, f64::INFINITY);
        assert_eq!(out[0].normal, Vec3::default());
    }

    #[test]
    fn marks_a_missing_torso_or_head_invalid_without_stale_output() {
        // A root with no skin: neither the head volume nor the face was measured.
        let (graph, mut profile) = graph_and_profile(0.0, 1.0);
        profile.measured.head = None;
        profile.measured.face = None;
        let mut b = body_of(graph, profile);
        let mut frame = make_body_volume_frame();
        b.anat.capture_volume_frame(&mut frame);
        assert!(frame.head.is_none());
        assert!(b.anat.face().is_none());
        let mut out = make_clearances();
        out[1].valid = true;
        out[1].distance = 12.0;
        out[1].normal.set(2.0, 3.0, 4.0);
        b.anat
            .sample_volume_clearances(&frame, &Vec3::default(), &mut out);
        assert!(!out[1].valid);
        assert_eq!(out[1].distance, f64::INFINITY);
        assert_eq!(out[1].normal, Vec3::default());

        // No shoulders, so no trunk to measure.
        let (graph, mut profile) = graph_and_profile(0.0, 1.0);
        for slot in [
            BoneSlot::UpperArmL,
            BoneSlot::UpperArmR,
            BoneSlot::ShoulderL,
            BoneSlot::ShoulderR,
        ] {
            profile.bones[slot as usize] = crate::profile::NO_NODE;
        }
        let mut b = body_of(graph, profile);
        let mut frame = make_body_volume_frame();
        b.anat.capture_volume_frame(&mut frame);
        assert!(frame.torso.is_none());
        let mut out = make_clearances();
        out[0].valid = true;
        out[0].distance = 45.0;
        out[0].normal.set(4.0, 5.0, 6.0);
        b.anat
            .sample_volume_clearances(&frame, &Vec3::default(), &mut out);
        assert!(!out[0].valid);
        assert_eq!(out[0].distance, f64::INFINITY);
        assert_eq!(out[0].normal, Vec3::default());
        // And the arm queries that need a trunk decline.
        let mut u = Vec3::new(0.0, -1.0, 0.0);
        b.anat.set_arm(&Vec3::default(), 0.2, 0.2, 0.05);
        assert!(!b.anat.clear_hand(Side::L, &mut u, None, None));
        assert_eq!(
            b.anat.measure(Side::L, &u, &u, &u, None, 0.0, 0.0).torso,
            0.0
        );
    }

    #[test]
    fn surface_moves_a_buried_point_out_along_its_radius() {
        let mut b = body();
        let o = *b.anat.axis_o();
        let (up, right) = (*b.anat.up(), *b.anat.right());
        let torso = b.anat.body().torso.clone().unwrap();
        let h = (torso.top + torso.bottom) * 0.5;
        let mut p = at(
            &o,
            &[(&up, h), (&right, 0.5 * surface_of(&torso, h, 0.0, None))],
        );
        let before = p;
        let depth = b.anat.surface(&mut p);
        assert!(depth > 0.4 && depth < 0.6);
        // Out to the surface, along the radius: the height is kept.
        let mut moved = p;
        moved.sub(&before);
        assert!(moved.dot(&up).abs() < 1e-12);
        let mut again = p;
        assert!(b.anat.surface(&mut again) <= 1e-9);
        // A clear point stays where it is.
        let mut clear = at(&o, &[(&right, 1.0)]);
        let copy = clear;
        assert_eq!(b.anat.surface(&mut clear), 0.0);
        assert_eq!(clear, copy);
    }
}
