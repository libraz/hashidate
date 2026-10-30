//! `rig/arm-driver.ts`: the per-side adapter joining the stateless arm FK and the constrained
//! step solver to a rig.
//!
//! The TS driver holds the rig's `ArmAnatomy`; here the anatomy is the caller's and arrives with
//! each call that reads the body frame or samples clearances. The clearance environment is the
//! driver's [`DriverEnvironment`], which the solver samples through a borrow of it and the
//! anatomy for the length of one call.
//!
//! A proxy point's identity is its kind and index, and a clearance row's key is
//! `3 * place + surface`, `place` being the point's position in the solver's template order and
//! `surface` torso, head, face; the template's own rows are therefore keyed by their cursor, as
//! the TS strings `${id}:torso` … are distinct per cursor. The keys are cached per point exactly
//! as the TS caches its strings.
//!
//! The TS request starts out holding the accepted finger shape by reference and keeps it until
//! the first request is composed; here the flag `request_holds_accepted` says so, and the writers
//! of the accepted shape refresh the request while it is set. Snapshots are written into
//! caller-owned storage, with the values the TS copies allocate.

// `!(x > y)` is TS's: a NaN fails it.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

use crate::anatomy::arm::ArmAnatomy;
use crate::anatomy::face::FaceSurfaceSample;
use crate::anatomy::joints::{JointTable, TORSO_SAMPLES};
use crate::anatomy::volumes::{BodyClearance, BodyVolumeFrame, make_clearances};
use crate::math::f::{atan2, cos, js_max, js_min, sin, sqrt};
use crate::math::{Mat4, Quat, Vec3};
use crate::profile::{ArmSlot, BoneSlot, Finger, Profile, Side};
use crate::rig::arm_configuration::{
    ArmCalibration, ArmCalibrationInput, ArmConfiguration, ArmDirections, ArmForwardContext,
    ArmForwardResult, BoneCalibrationInput, CalibrationRefusal, HandCalibrationInput,
    UpperCalibrationInput, bound_arm_configuration, capture_arm_calibration,
    configuration_of_directions, forward_arm,
};
use crate::rig::arm_path::plan::{
    ArmPathBounds, ArmPathClearance, ArmPathEnvironment, ArmPathPlanOutput, ArmPathPoint,
    ArmPathPointKind, ArmPathRequest, ClearanceKey, configuration_from_q, configuration_to_q,
    copy_forward, make_arm_path_plan_output,
};
use crate::rig::arm_path::solver::ArmStepSolver;
use crate::rig::finger_axes::FingerAxes;
use crate::rig::hand_geometry::{HandGeometryCalibration, capture_hand_geometry};
use crate::rig::hands::FingerSpec;
use crate::scene::graph::Graph;
use core::f64::consts::PI;

const DOFS: usize = 7;

pub const FRAME_TOLERANCE: f64 = 1e-4;
/// How fast the limiter's own correction may travel, in radians a second.
///
/// The lowest value that leaves the movement alone, which is the only property
/// that matters: a cap has to be invisible to everything except a seam. Measured
/// over every gesture in the table, a link asks for more than ten radians a
/// second on one frame in a hundred and more than fifteen on one in five hundred,
/// while a seam asks for seventy and upward — the two do not overlap, and
/// fourteen sits in the gap. Played from rest at this cap, every entrance in the
/// table is unchanged to the last digit of its peak speed and its path length
/// except the two that were teleporting. At ten, half a dozen of them lose about
/// a tenth of their peak, which is the movement being damped rather than a jump
/// being caught.
pub const LIMIT_SLEW: f64 = 14.0;

// arm-driver.ts copySpec
fn copy_spec(source: &FingerSpec, target: &mut [f64; 5]) {
    for (t, s) in target.iter_mut().zip(source) {
        *t = s.unwrap_or(0.0);
    }
}

/// A full finger record as the `FingerSpec` the TS passes it as.
fn spec_of(values: &[f64; 5]) -> FingerSpec {
    values.map(Some)
}

// arm-driver.ts positiveConformalScale
//
// Return the common scale only when this affine world frame is a proper similarity.
pub fn positive_conformal_scale(matrix: &Mat4) -> Option<f64> {
    let e = &matrix.elements;
    if e.iter().any(|v| !v.is_finite()) {
        return None;
    }
    if e[3].abs() > FRAME_TOLERANCE
        || e[7].abs() > FRAME_TOLERANCE
        || e[11].abs() > FRAME_TOLERANCE
        || (e[15] - 1.0).abs() > FRAME_TOLERANCE
    {
        return None;
    }

    let x2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
    let y2 = e[4] * e[4] + e[5] * e[5] + e[6] * e[6];
    let z2 = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
    let mean = (x2 + y2 + z2) / 3.0;
    if !(mean.is_finite() && mean > 1e-16) {
        return None;
    }
    let tolerance = mean * FRAME_TOLERANCE;
    if (x2 - mean).abs() > tolerance
        || (y2 - mean).abs() > tolerance
        || (z2 - mean).abs() > tolerance
        || (e[0] * e[4] + e[1] * e[5] + e[2] * e[6]).abs() > tolerance
        || (e[0] * e[8] + e[1] * e[9] + e[2] * e[10]).abs() > tolerance
        || (e[4] * e[8] + e[5] * e[9] + e[6] * e[10]).abs() > tolerance
    {
        return None;
    }
    let determinant = e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2])
        + e[8] * (e[1] * e[6] - e[5] * e[2]);
    (determinant > 0.0).then(|| sqrt(mean))
}

/// What `ArmDriver::create` is built from: the TS `DriverInput` without the anatomy, which each
/// call brings. The palm and the humeral front are the rig's resolved ones.
pub struct DriverInput<'a> {
    pub profile: &'a Profile,
    pub side: Side,
    pub joints: &'a JointTable,
    /// The TS `rest.get(bone)`: `None` where the rig's rest map has no entry.
    pub rest: &'a dyn Fn(u32) -> Option<Quat>,
    /// The finger curl and splay axes, the TS `fingerAxes` and `fingerSplayAxes`.
    pub finger_axes: &'a FingerAxes,
    pub palm_local: Vec3,
    pub radial_sign: f64,
    pub humeral_front: Vec3,
    pub finger_clearance: f64,
}

/// Why `ArmDriver::create` refused, one per message the TS returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriverRefusal {
    /// "arm bones, limb lengths, palm or finger clearance unresolved"
    Unresolved,
    /// "arm bones not conformally scaled"
    NotConformal,
    /// "upper arm has no parent"
    NoParent,
    /// The calibration's own message.
    Calibration(CalibrationRefusal),
    /// "measured hand length must be finite and positive"
    HandLength,
    /// "sweep resolution must be finite and positive"
    SweepResolution,
}

/// Which of the driver's two reusable outputs a locked check writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriverOutput {
    Output,
    Bridge,
}

/// The accepted state `captureAcceptedState` copies out and `restoreAcceptedState` puts back.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ArmDriverAcceptedSnapshot {
    pub q: [f64; DOFS],
    pub configuration: ArmConfiguration,
    pub curls: [f64; 5],
    pub spread: [f64; 5],
    pub forward: ArmForwardResult,
    pub roll_history: f64,
}

/// A proxy point's identity: its kind and index, which together are unique.
type PointId = (ArmPathPointKind, usize);

fn point_id(point: &ArmPathPoint) -> PointId {
    (point.kind, point.index)
}

/// The row key of one surface of one point: see the module comment.
fn clearance_key((kind, index): PointId, surface: usize) -> ClearanceKey {
    let place = match kind {
        ArmPathPointKind::Upper | ArmPathPointKind::Finger => index,
        ArmPathPointKind::Forearm => TORSO_SAMPLES + index,
        ArmPathPointKind::Hand => 2 * TORSO_SAMPLES + index,
    };
    (3 * place + surface) as ClearanceKey
}

/// The state the TS `sampleEnvironment` reads and writes: the fixed row count, the captured body
/// frame, the cached point identities and keys, and the row scratch.
#[derive(Clone, Debug)]
pub struct DriverEnvironment {
    pub row_count: usize,
    pub volume_frame: BodyVolumeFrame,
    finger_clearance: f64,
    clearance_point_ids: Vec<PointId>,
    clearance_keys: Vec<ClearanceKey>,
    body_rows: [BodyClearance; 2],
    face_sample: FaceSurfaceSample,
    /// Every sample this environment answered, as `(points, rows)` hashes.
    #[cfg(test)]
    pub trace: Vec<[u64; 2]>,
    /// The rows of the last sample.
    #[cfg(test)]
    pub last_rows: Vec<ArmPathClearance>,
}

impl DriverEnvironment {
    // arm-driver.ts ArmDriver.sampleEnvironment
    //
    // Query every fixed row against the immutable torso/head frame and face.
    fn sample(
        &mut self,
        anat: &mut ArmAnatomy,
        points: &[ArmPathPoint],
        out: &mut [ArmPathClearance],
    ) {
        assert!(
            out.len() == self.row_count,
            "arm clearance row count changed"
        );
        let surfaces = self.body_rows.len();
        let mut cursor = 0;
        for (i, point) in points.iter().enumerate() {
            let id = point_id(point);
            // Solver proxy identities stay fixed; direct callers may reorder them.
            if self.clearance_point_ids[i] != id {
                self.clearance_point_ids[i] = id;
                for surface in 0..surfaces {
                    self.clearance_keys[cursor + surface] = clearance_key(id, surface);
                }
                self.clearance_keys[cursor + surfaces] = clearance_key(id, surfaces);
            }
            anat.sample_volume_clearances(&self.volume_frame, &point.position, &mut self.body_rows);
            for row in &self.body_rows {
                let target = &mut out[cursor];
                target.key = Some(self.clearance_keys[cursor]);
                cursor += 1;
                target.point_index = Some(i);
                target.valid = row.valid;
                target.distance = row.distance;
                target.normal.copy(&row.normal);
            }
            let face = &mut out[cursor];
            face.key = Some(self.clearance_keys[cursor]);
            cursor += 1;
            face.point_index = Some(i);
            face.valid = false;
            face.distance = f64::INFINITY;
            face.normal.set(0.0, 0.0, 0.0);
            if point.kind == ArmPathPointKind::Finger
                && let Some(surface) = anat.face_mut()
            {
                surface.sample(&point.position, &mut self.face_sample);
                face.valid = self.face_sample.valid;
                face.distance = self.face_sample.distance - self.finger_clearance;
                face.normal.copy(&self.face_sample.normal);
                if self.face_sample.valid {
                    let head = &mut out[cursor - 2];
                    head.valid = false;
                    head.distance = f64::INFINITY;
                    head.normal.set(0.0, 0.0, 0.0);
                }
            }
        }
        assert!(
            cursor == out.len(),
            "arm clearance row count did not match proxy points"
        );
        #[cfg(test)]
        {
            use crate::rig::testkit::fnv_f64s;
            let positions: Vec<f64> = points
                .iter()
                .flat_map(|p| [p.position.x, p.position.y, p.position.z])
                .collect();
            let rows: Vec<f64> = out
                .iter()
                .flat_map(|r| {
                    [
                        r.key.map_or(-1.0, f64::from),
                        r.point_index.map_or(-1.0, |p| p as f64),
                        f64::from(u8::from(r.valid)),
                        r.distance,
                        r.normal.x,
                        r.normal.y,
                        r.normal.z,
                    ]
                })
                .collect();
            self.trace.push([fnv_f64s(&positions), fnv_f64s(&rows)]);
            self.last_rows.clear();
            self.last_rows.extend_from_slice(out);
        }
    }
}

/// The driver's environment and the caller's anatomy, joined for one solver call.
struct Sampling<'a> {
    state: &'a mut DriverEnvironment,
    anat: &'a mut ArmAnatomy,
}

impl ArmPathEnvironment for Sampling<'_> {
    fn row_count(&self) -> usize {
        self.state.row_count
    }

    fn sample(&mut self, points: &[ArmPathPoint], out: &mut [ArmPathClearance]) {
        self.state.sample(self.anat, points, out);
    }
}

/// What a test makes of one `planFrom`, as the TS tests do by replacing the method: the call's
/// index among the driver's plans, its start, and the output to rewrite.
#[cfg(test)]
pub type PlanHook = Box<dyn FnMut(usize, &[f64; DOFS], &mut ArmPathPlanOutput)>;

/// How often a test's driver was asked for each kind of solve.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DriverCalls {
    pub plan_from: usize,
    pub restore_endpoint_from: usize,
    pub validate_locked_pose: usize,
}

/// Per-side adapter joining the stateless FK and collision solver to a rig.
pub struct ArmDriver {
    pub calibration: ArmCalibration,
    pub hand_geometry: HandGeometryCalibration,
    pub solver: ArmStepSolver,
    pub output: ArmPathPlanOutput,
    pub bridge_output: ArmPathPlanOutput,
    pub environment: DriverEnvironment,
    pub accepted_q: [f64; DOFS],
    pub start_q: [f64; DOFS],
    pub target_q: [f64; DOFS],
    /// The TS `lowerBounds` and `upperBounds`, which its `bounds` holds.
    pub bounds: ArmPathBounds,
    /// The TS `bridgeLowerBounds` and `bridgeUpperBounds`, which its `bridgeBounds` holds.
    pub bridge_bounds: ArmPathBounds,
    pub sweep_resolution: f64,
    pub accepted_configuration: ArmConfiguration,
    pub target_configuration: ArmConfiguration,
    pub accepted_curls: [f64; 5],
    pub accepted_spread: [f64; 5],
    pub proposed_curls: [f64; 5],
    pub proposed_spread: [f64; 5],
    pub accepted_forward: ArmForwardResult,
    pub target_forward: ArmForwardResult,
    pub neutral_forward: ArmForwardResult,
    pub request: ArmPathRequest,
    side: Side,
    /// The request's finger shape is still the accepted one: see the module comment.
    request_holds_accepted: bool,
    roll_held: f64,
    bridge_start_q: [f64; DOFS],
    #[cfg(test)]
    pub plan_hook: Option<PlanHook>,
    #[cfg(test)]
    pub calls: DriverCalls,
}

impl ArmDriver {
    // arm-driver.ts ArmDriver.constructor
    fn new(
        input: &DriverInput,
        calibration: ArmCalibration,
        hand_geometry: HandGeometryCalibration,
        hand_length: f64,
    ) -> ArmDriver {
        let sweep_resolution = input.finger_clearance / 4.0;
        let points_per_sample = hand_geometry.points.len() + 3 * TORSO_SAMPLES + 1;
        let row_count = points_per_sample * 3;
        let solver =
            ArmStepSolver::new(&calibration, &hand_geometry, hand_length, sweep_resolution);
        let output = make_arm_path_plan_output(&hand_geometry, row_count);
        let bridge_output = make_arm_path_plan_output(&hand_geometry, row_count);
        let clearance_point_ids: Vec<PointId> = output.points.iter().map(point_id).collect();
        let clearance_keys = clearance_point_ids
            .iter()
            .flat_map(|&id| [0, 1, 2].map(|surface| clearance_key(id, surface)))
            .collect();
        let accepted_curls = [0.0; 5];
        let accepted_spread = [0.0; 5];
        ArmDriver {
            calibration,
            hand_geometry,
            solver,
            output,
            bridge_output,
            environment: DriverEnvironment {
                row_count,
                volume_frame: BodyVolumeFrame::default(),
                finger_clearance: input.finger_clearance,
                clearance_point_ids,
                clearance_keys,
                body_rows: make_clearances(),
                face_sample: FaceSurfaceSample::default(),
                #[cfg(test)]
                trace: Vec::new(),
                #[cfg(test)]
                last_rows: Vec::new(),
            },
            accepted_q: [0.0; DOFS],
            start_q: [0.0; DOFS],
            target_q: [0.0; DOFS],
            bounds: ArmPathBounds {
                lower: [0.0; DOFS],
                upper: [0.0; DOFS],
            },
            bridge_bounds: ArmPathBounds {
                lower: [0.0; DOFS],
                upper: [0.0; DOFS],
            },
            sweep_resolution,
            accepted_configuration: ArmConfiguration::default(),
            target_configuration: ArmConfiguration::default(),
            accepted_curls,
            accepted_spread,
            proposed_curls: [0.0; 5],
            proposed_spread: [0.0; 5],
            accepted_forward: ArmForwardResult::default(),
            target_forward: ArmForwardResult::default(),
            neutral_forward: ArmForwardResult::default(),
            request: ArmPathRequest {
                wrist: Vec3::default(),
                hand: Vec3::default(),
                palm: None,
                curls: spec_of(&accepted_curls),
                spread: spec_of(&accepted_spread),
                elbow: Some(Vec3::default()),
            },
            side: input.side,
            request_holds_accepted: true,
            roll_held: 0.0,
            bridge_start_q: [0.0; DOFS],
            #[cfg(test)]
            plan_hook: None,
            #[cfg(test)]
            calls: DriverCalls::default(),
        }
    }

    /// The side this driver poses.
    pub fn side(&self) -> Side {
        self.side
    }

    // arm-driver.ts ArmDriver.requestRollHistory (get)
    pub fn request_roll_history(&self) -> f64 {
        self.roll_held
    }

    // arm-driver.ts ArmDriver.requestRollHistory (set)
    pub fn set_request_roll_history(&mut self, value: f64) {
        self.roll_held = value;
    }

    /// While the request still holds the accepted finger shape, show it the shape as it is now.
    fn refresh_aliased_request(&mut self) {
        if self.request_holds_accepted {
            self.request.curls = spec_of(&self.accepted_curls);
            self.request.spread = spec_of(&self.accepted_spread);
        }
    }

    // arm-driver.ts ArmDriver.captureAcceptedState
    pub fn capture_accepted_state(&self, out: &mut ArmDriverAcceptedSnapshot) {
        copy_forward(&self.accepted_forward, &mut out.forward);
        out.q = self.accepted_q;
        out.configuration = self.accepted_configuration;
        out.curls = self.accepted_curls;
        out.spread = self.accepted_spread;
        out.roll_history = self.roll_held;
    }

    // arm-driver.ts ArmDriver.restoreAcceptedState
    pub fn restore_accepted_state(&mut self, snapshot: &ArmDriverAcceptedSnapshot) {
        self.accepted_q = snapshot.q;
        self.accepted_configuration = snapshot.configuration;
        copy_forward(&snapshot.forward, &mut self.accepted_forward);
        copy_spec(&spec_of(&snapshot.curls), &mut self.accepted_curls);
        copy_spec(&spec_of(&snapshot.spread), &mut self.accepted_spread);
        self.refresh_aliased_request();
        self.roll_held = snapshot.roll_history;
    }

    // arm-driver.ts ArmDriver.create
    //
    // A driver, or why the calibrated rotational model cannot represent this rig. The TS also
    // requires the palm and the humeral front to be present, which the input's types guarantee.
    pub fn create(input: &DriverInput, graph: &mut Graph) -> Result<ArmDriver, DriverRefusal> {
        let (profile, side) = (input.profile, input.side);
        let upper = profile.bone(BoneSlot::arm(ArmSlot::UpperArm, side));
        let lower = profile.bone(BoneSlot::arm(ArmSlot::LowerArm, side));
        let hand = profile.bone(BoneSlot::arm(ArmSlot::Hand, side));
        let limb = &profile.limb[side as usize];
        let truthy = |v: Option<f64>| v.is_some_and(|v| v != 0.0 && !v.is_nan());
        let (Some(upper), Some(lower), Some(hand)) = (upper, lower, hand) else {
            return Err(DriverRefusal::Unresolved);
        };
        if !(truthy(limb.upper)
            && truthy(limb.lower)
            && truthy(limb.tip[Finger::Middle as usize])
            && input.finger_clearance > 0.0)
        {
            return Err(DriverRefusal::Unresolved);
        }

        graph.update_world_matrix(0, true, true, false);
        graph.update_world_matrix(upper, true, false, false);
        graph.update_world_matrix(lower, true, false, false);
        graph.update_world_matrix(hand, true, false, false);
        if ![upper, lower, hand]
            .iter()
            .all(|&bone| positive_conformal_scale(&graph.current_matrix_world(bone)).is_some())
        {
            return Err(DriverRefusal::NotConformal);
        }
        let Some(parent) = graph.parent_of(upper) else {
            return Err(DriverRefusal::NoParent);
        };
        graph.update_world_matrix(parent, true, false, false);
        let parent_world = graph.world_quaternion(parent);
        let upper_world = graph.world_quaternion(upper);
        let lower_world = graph.world_quaternion(lower);
        let hand_world = graph.world_quaternion(hand);
        let relative = |from: &Quat, to: &Quat| {
            let mut r = *from;
            *r.invert().multiply(to)
        };
        let rest_dir = |slot: ArmSlot| {
            profile.rest_dir[BoneSlot::arm(slot, side) as usize]
                .expect("a resolved arm bone has a rest direction")
        };
        let calibration_input = ArmCalibrationInput {
            upper: UpperCalibrationInput {
                axis: rest_dir(ArmSlot::UpperArm),
                front: input.humeral_front,
                rest: relative(&parent_world, &upper_world),
            },
            lower: BoneCalibrationInput {
                axis: rest_dir(ArmSlot::LowerArm),
                rest: relative(&upper_world, &lower_world),
            },
            hand: HandCalibrationInput {
                axis: rest_dir(ArmSlot::Hand),
                palm: input.palm_local,
                rest: relative(&lower_world, &hand_world),
            },
            radial_sign: input.radial_sign,
            joints: input.joints,
        };

        let calibration =
            capture_arm_calibration(&calibration_input).map_err(DriverRefusal::Calibration)?;
        let metric_scale = graph.world_scale(hand).x;
        let geometry = capture_hand_geometry(
            profile,
            graph,
            side,
            input.rest,
            input.finger_axes,
            input.joints,
            metric_scale,
        );
        let hand_length = limb.tip[Finger::Middle as usize].unwrap_or(0.0);
        if !(hand_length > 0.0 && hand_length.is_finite()) {
            return Err(DriverRefusal::HandLength);
        }
        let sweep_resolution = input.finger_clearance / 4.0;
        if !(sweep_resolution > 0.0 && sweep_resolution.is_finite()) {
            return Err(DriverRefusal::SweepResolution);
        }
        Ok(ArmDriver::new(input, calibration, geometry, hand_length))
    }

    // arm-driver.ts ArmDriver.seedFromPose
    pub fn seed_from_pose(
        &mut self,
        context: &ArmForwardContext,
        upper_arm: &Vec3,
        lower_arm: &Vec3,
        hand: &Vec3,
        palm: &Vec3,
    ) -> bool {
        let directions = ArmDirections {
            upper_arm: *upper_arm,
            lower_arm: *lower_arm,
            hand: *hand,
        };
        if !configuration_of_directions(
            &directions,
            Some(palm),
            &self.calibration,
            context,
            None,
            &mut self.accepted_configuration,
        ) {
            return false;
        }
        configuration_to_q(&self.accepted_configuration, &mut self.accepted_q);
        self.roll_held = self.accepted_configuration.forearm_roll;
        forward_arm(
            &self.accepted_configuration,
            &self.calibration,
            context,
            &mut self.accepted_forward,
        );
        true
    }

    // arm-driver.ts ArmDriver.boundConfiguration
    //
    // Bound an inverse pose explicitly before using it as a constrained seed.
    pub fn bound_configuration<'o>(
        &self,
        configuration: &ArmConfiguration,
        out: &'o mut ArmConfiguration,
    ) -> &'o mut ArmConfiguration {
        bound_arm_configuration(configuration, &self.calibration, out)
    }

    // arm-driver.ts ArmDriver.configurationToQ
    //
    // Encode one configuration in the solver's stable seven-value order.
    pub fn configuration_to_q<'o>(
        &self,
        configuration: &ArmConfiguration,
        out: &'o mut [f64; DOFS],
    ) -> &'o mut [f64; DOFS] {
        configuration_to_q(configuration, out);
        out
    }

    // arm-driver.ts ArmDriver.configurationFromPose
    pub fn configuration_from_pose(
        &mut self,
        context: &ArmForwardContext,
        upper_arm: &Vec3,
        lower_arm: &Vec3,
        hand: &Vec3,
        palm: Option<&Vec3>,
    ) -> bool {
        let directions = ArmDirections {
            upper_arm: *upper_arm,
            lower_arm: *lower_arm,
            hand: *hand,
        };
        if !configuration_of_directions(
            &directions,
            palm,
            &self.calibration,
            context,
            Some(&self.accepted_configuration),
            &mut self.target_configuration,
        ) {
            return false;
        }
        configuration_to_q(&self.target_configuration, &mut self.target_q);
        true
    }

    // arm-driver.ts ArmDriver.captureVolumeFrame
    //
    // Capture one fixed candidate body frame before the solver samples it.
    pub fn capture_volume_frame(&mut self, graph: &mut Graph, anat: &mut ArmAnatomy) {
        anat.capture_volume_frame(&mut self.environment.volume_frame);
        if let Some(face) = anat.face_mut() {
            face.refresh(graph);
        }
    }

    // arm-driver.ts ArmDriver.composeRequest
    //
    // Compose one canonical arm request from the followed arm channels.
    #[allow(clippy::too_many_arguments)]
    pub fn compose_request(
        &mut self,
        context: &ArmForwardContext,
        upper: &Vec3,
        lower: &Vec3,
        hand: &Vec3,
        palm_target: Option<&Vec3>,
        palm_weight: f64,
        twist: f64,
        curls: &FingerSpec,
        spread: &FingerSpec,
        advance_roll: bool,
    ) -> &ArmPathRequest {
        // Normalised once, and only these copies are used below: the link
        // lengths, the palm projections and the roll axis all assume unit vectors.
        let mut upper = *upper;
        upper.normalize();
        let mut lower = *lower;
        lower.normalize();
        let mut hand = *hand;
        hand.normalize();
        self.request.hand = hand;
        let mut elbow = context.shoulder;
        elbow.add_scaled_vector(&upper, context.upper_length);
        let mut wrist = elbow;
        wrist.add_scaled_vector(&lower, context.lower_length);
        self.request.elbow = Some(elbow);
        self.request.wrist = wrist;
        copy_spec(curls, &mut self.proposed_curls);
        copy_spec(spread, &mut self.proposed_spread);

        // Build a neutral palm by solving the requested links with the hand aligned
        // to the forearm, then use the same palm-normal projection as anatomical FK.
        let neutral_directions = ArmDirections {
            upper_arm: upper,
            lower_arm: lower,
            hand: lower,
        };
        let mut neutral_palm = Vec3::default();
        let mut neutral_configuration = ArmConfiguration::default();
        if configuration_of_directions(
            &neutral_directions,
            None,
            &self.calibration,
            context,
            None,
            &mut neutral_configuration,
        ) {
            forward_arm(
                &neutral_configuration,
                &self.calibration,
                context,
                &mut self.neutral_forward,
            );
            // cos(theta) * N - sin(theta) * (wristFlex / theta) * L, with N perpendicular to L.
            let palm = self.neutral_forward.palm;
            neutral_palm
                .copy(&palm)
                .multiply_scalar(lower.dot(&hand))
                .add_scaled_vector(&lower, -palm.dot(&hand))
                .normalize();
            let along = -neutral_palm.dot(&hand);
            neutral_palm.add_scaled_vector(&hand, along);
            if neutral_palm.length_sq() > 1e-12 {
                neutral_palm.normalize();
            }
        }

        let mut requested_palm = None;
        if neutral_palm.length_sq() > 1e-12 {
            match palm_target {
                Some(target) if palm_weight > 1e-3 => {
                    let mut projected = *target;
                    projected.add_scaled_vector(&hand, -target.dot(&hand));
                    if projected.length_sq() > 1e-12 {
                        projected.normalize();
                        let mut roll_axis = Vec3::default();
                        let raw = atan2(
                            roll_axis
                                .cross_vectors(&neutral_palm, &projected)
                                .dot(&hand),
                            neutral_palm.dot(&projected),
                        );
                        let roll = self.roll_held
                            + atan2(sin(raw - self.roll_held), cos(raw - self.roll_held));
                        if advance_roll {
                            self.roll_held = roll;
                        }
                        let mut palm = neutral_palm;
                        palm.apply_axis_angle(&hand, roll * palm_weight).normalize();
                        requested_palm = Some(palm);
                    }
                }
                _ if twist != 0.0 => {
                    if advance_roll {
                        self.roll_held = twist;
                    }
                    let mut palm = neutral_palm;
                    palm.apply_axis_angle(&hand, twist).normalize();
                    requested_palm = Some(palm);
                }
                _ => {}
            }
        }
        self.request.palm = requested_palm;
        self.request.curls = spec_of(&self.proposed_curls);
        self.request.spread = spec_of(&self.proposed_spread);
        self.request_holds_accepted = false;
        &self.request
    }

    // arm-driver.ts ArmDriver.requestForConfiguration
    pub fn request_for_configuration(
        &mut self,
        configuration: &ArmConfiguration,
        context: &ArmForwardContext,
        curls: &FingerSpec,
        spread: &FingerSpec,
    ) -> &ArmPathRequest {
        forward_arm(
            configuration,
            &self.calibration,
            context,
            &mut self.target_forward,
        );
        self.request.wrist = self.target_forward.wrist;
        self.request.hand = self.target_forward.h;
        self.request.elbow = Some(self.target_forward.elbow);
        self.request.palm = Some(self.target_forward.palm);
        copy_spec(curls, &mut self.proposed_curls);
        copy_spec(spread, &mut self.proposed_spread);
        self.request.curls = spec_of(&self.proposed_curls);
        self.request.spread = spec_of(&self.proposed_spread);
        self.request_holds_accepted = false;
        &self.request
    }

    // arm-driver.ts ArmDriver.validateLockedPose
    //
    // Check one fixed q and finger sample without allowing the solver to move it. The TS
    // defaults `out` to `bridgeOutput`; a seven-value q is the type's.
    #[allow(clippy::too_many_arguments)]
    pub fn validate_locked_pose(
        &mut self,
        anat: &mut ArmAnatomy,
        q: &[f64; DOFS],
        context: &ArmForwardContext,
        curls: &FingerSpec,
        spread: &FingerSpec,
        out: DriverOutput,
    ) -> bool {
        #[cfg(test)]
        {
            self.calls.validate_locked_pose += 1;
        }
        self.bridge_start_q = *q;
        self.bridge_bounds.lower = *q;
        self.bridge_bounds.upper = *q;
        let mut validation_curls = [0.0; 5];
        let mut validation_spread = [0.0; 5];
        copy_spec(curls, &mut validation_curls);
        copy_spec(spread, &mut validation_spread);
        let validation_request = ArmPathRequest {
            wrist: self.request.wrist,
            hand: self.request.hand,
            palm: self.request.palm,
            curls: spec_of(&validation_curls),
            spread: spec_of(&validation_spread),
            elbow: self.request.elbow,
        };
        let mut environment = Sampling {
            state: &mut self.environment,
            anat,
        };
        let out = match out {
            DriverOutput::Output => &mut self.output,
            DriverOutput::Bridge => &mut self.bridge_output,
        };
        self.solver.restore_endpoint(
            &validation_request,
            &self.bridge_start_q,
            context,
            &self.bridge_bounds,
            &mut environment,
            out,
        )
    }

    // arm-driver.ts ArmDriver.fillBounds
    pub fn fill_bounds(&mut self, start: &[f64; DOFS], dt: f64, temporal: bool) -> &ArmPathBounds {
        let step = if temporal {
            LIMIT_SLEW * js_max(0.0, dt)
        } else {
            f64::INFINITY
        };
        let b = &mut self.bounds;
        b.lower[0] = if temporal {
            start[0] - step
        } else {
            start[0] - PI * 2.0
        };
        b.upper[0] = if temporal {
            start[0] + step
        } else {
            start[0] + PI * 2.0
        };
        b.lower[1] = if temporal {
            js_max(0.0, start[1] - step)
        } else {
            0.0
        };
        b.upper[1] = if temporal {
            js_min(PI, start[1] + step)
        } else {
            PI
        };
        let joints = &self.calibration.joints;
        let ranges = [
            joints.shoulder.rotation.max,
            joints.elbow.flexion.max,
            joints.elbow.rotation.max,
            joints.wrist.flexion.max,
            joints.wrist.deviation.max,
        ];
        for (i, range) in ranges.iter().enumerate() {
            let q = i + 2;
            b.lower[q] = if temporal {
                js_max(range[0], start[q] - step)
            } else {
                range[0]
            };
            b.upper[q] = if temporal {
                js_min(range[1], start[q] + step)
            } else {
                range[1]
            };
        }
        &self.bounds
    }

    // arm-driver.ts ArmDriver.planFrom
    pub fn plan_from(
        &mut self,
        anat: &mut ArmAnatomy,
        start: &[f64; DOFS],
        context: &ArmForwardContext,
        dt: f64,
        temporal: bool,
    ) -> &ArmPathPlanOutput {
        self.start_q = *start;
        let start_q = self.start_q;
        self.fill_bounds(&start_q, dt, temporal);
        let mut environment = Sampling {
            state: &mut self.environment,
            anat,
        };
        self.solver.plan(
            &self.request,
            &self.start_q,
            context,
            &self.bounds,
            &mut environment,
            &mut self.output,
        );
        #[cfg(test)]
        {
            let call = self.calls.plan_from;
            self.calls.plan_from += 1;
            if let Some(hook) = self.plan_hook.as_mut() {
                hook(call, start, &mut self.output);
            }
        }
        &self.output
    }

    // arm-driver.ts ArmDriver.restoreEndpointFrom
    pub fn restore_endpoint_from(
        &mut self,
        anat: &mut ArmAnatomy,
        start: &[f64; DOFS],
        context: &ArmForwardContext,
        dt: f64,
        temporal: bool,
    ) -> bool {
        #[cfg(test)]
        {
            self.calls.restore_endpoint_from += 1;
        }
        self.start_q = *start;
        let start_q = self.start_q;
        self.fill_bounds(&start_q, dt, temporal);
        let mut environment = Sampling {
            state: &mut self.environment,
            anat,
        };
        self.solver.restore_endpoint(
            &self.request,
            &self.start_q,
            context,
            &self.bounds,
            &mut environment,
            &mut self.output,
        )
    }

    // arm-driver.ts ArmDriver.sampleEnvironment
    //
    // Query every fixed row against the immutable torso/head frame and face.
    pub fn sample_environment(
        &mut self,
        anat: &mut ArmAnatomy,
        points: &[ArmPathPoint],
        out: &mut [ArmPathClearance],
    ) {
        self.environment.sample(anat, points, out);
    }

    // arm-driver.ts ArmDriver.accept
    pub fn accept(
        &mut self,
        q: &[f64; DOFS],
        context: &ArmForwardContext,
        curls: &FingerSpec,
        spread: &FingerSpec,
    ) {
        // q must not alias the reusable solver output. Copy before any future solve.
        self.accepted_q = *q;
        configuration_from_q(&self.accepted_q, &mut self.accepted_configuration);
        forward_arm(
            &self.accepted_configuration,
            &self.calibration,
            context,
            &mut self.accepted_forward,
        );
        copy_spec(curls, &mut self.accepted_curls);
        copy_spec(spread, &mut self.accepted_spread);
        self.refresh_aliased_request();
    }

    // arm-driver.ts ArmDriver.refreshAcceptedForward
    //
    // Rebuild the cached accepted FK in a refreshed external body context.
    pub fn refresh_accepted_forward(&mut self, context: &ArmForwardContext) -> &ArmForwardResult {
        forward_arm(
            &self.accepted_configuration,
            &self.calibration,
            context,
            &mut self.accepted_forward,
        );
        &self.accepted_forward
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anatomy::volumes::VolumePose;
    use crate::corpus_replay::Corpus;
    use crate::math::f::{EPSILON_2_3, hypot};
    use crate::rig::arm_path::plan::ArmPathStatus;
    use crate::rig::hands::EMPTY_SPEC;
    use crate::rig::testkit::{
        Driven, Stream, avatar, centimetre, context_of, definition_values, euler, hash_halves,
    };

    const EXACT: f64 = 1e-8;
    const SIDES: [Side; 2] = [Side::L, Side::R];

    fn forward(
        c: &ArmConfiguration,
        d: &ArmDriver,
        context: &ArmForwardContext,
    ) -> ArmForwardResult {
        let mut out = ArmForwardResult::default();
        forward_arm(c, &d.calibration, context, &mut out);
        out
    }

    fn scaled(v: &Vec3, s: f64) -> Vec3 {
        let mut out = *v;
        out.multiply_scalar(s);
        out
    }

    // --- tests/rig/arm-driver.test.ts ----------------------------------------------------------

    #[test]
    fn reads_the_arm_channels_as_directions_whatever_their_length() {
        let mut h = Driven::new();
        assert!(h.anat.update(&mut h.graph));
        let context = h.context(Side::R);
        let (arm, _) = h.driver(Side::R);
        let pose = forward(
            &ArmConfiguration {
                elbow_flex: 0.9,
                wrist_flex: 0.3,
                ..arm.accepted_configuration
            },
            arm,
            &context,
        );
        let unit = *arm.compose_request(
            &context,
            &pose.u,
            &pose.l,
            &pose.h,
            Some(&pose.palm),
            1.0,
            0.0,
            &EMPTY_SPEC,
            &EMPTY_SPEC,
            false,
        );
        let scaled = *arm.compose_request(
            &context,
            &scaled(&pose.u, 1.7),
            &scaled(&pose.l, 0.6),
            &scaled(&pose.h, 2.3),
            Some(&pose.palm),
            1.0,
            0.0,
            &EMPTY_SPEC,
            &EMPTY_SPEC,
            false,
        );
        assert!(scaled.wrist.distance_to(&unit.wrist) < 1e-12);
        assert!(scaled.elbow.unwrap().distance_to(&unit.elbow.unwrap()) < 1e-12);
        assert!(scaled.hand.distance_to(&unit.hand) < 1e-12);
        let palm = unit.palm.expect("a palm");
        assert!(scaled.palm.unwrap().distance_to(&palm) < 1e-9);
    }

    // --- tests/rig/arm-palm-transport.test.ts, the `composeRequest` parts --------------------

    /// The TS scenario: the left arm at unit scale, the right in centimetres, the root turned
    /// for a negative deviation, and one FK pose with the given wrist.
    fn transport(
        side: Side,
        flex: f64,
        deviation: f64,
    ) -> (
        Driven,
        ArmForwardContext,
        ArmConfiguration,
        ArmForwardResult,
    ) {
        let (mut g, p) = avatar();
        if side == Side::R {
            centimetre(&mut g);
        }
        let yaw = if deviation < 0.0 { 0.7 } else { 0.0 };
        g.set_local_quaternion(0, &euler(0.0, yaw, 0.0));
        g.update_matrix_world(0, true);
        let mut h = Driven::of(g, p);
        let context = h.context(side);
        let configuration = ArmConfiguration {
            shoulder_plane: 0.41,
            shoulder_lift: 0.72,
            humeral_rotation: 0.38,
            elbow_flex: 1.1,
            forearm_roll: 0.0,
            wrist_flex: flex,
            wrist_dev: deviation,
        };
        let f = forward(&configuration, h.driver(side).0, &context);
        (h, context, configuration, f)
    }

    #[test]
    fn shares_the_mixed_wrist_fk_reference() {
        for (side, deviation) in [
            (Side::L, PI / 6.0),
            (Side::R, PI / 6.0),
            (Side::L, -PI / 6.0),
            (Side::R, -PI / 6.0),
        ] {
            let (mut h, context, _, f) = transport(side, PI / 3.0, deviation);
            let (driver, _) = h.driver(side);
            driver.set_request_roll_history(0.0);
            let mut compose = |target: Option<&Vec3>, weight: f64, twist: f64| {
                driver
                    .compose_request(
                        &context,
                        &f.u,
                        &f.l,
                        &f.h,
                        target,
                        weight,
                        twist,
                        &EMPTY_SPEC,
                        &EMPTY_SPEC,
                        false,
                    )
                    .palm
                    .expect("mixed wrist request lost its palm")
            };
            // A partial weight must not pull an already canonical palm toward a second convention.
            assert!(compose(Some(&f.palm), 0.5, 0.0).distance_to(&f.palm) < EXACT);
            let (twist, weight) = (0.4, 0.25);
            let mut target = f.palm;
            target.apply_axis_angle(&f.h, twist);
            let mut expected = f.palm;
            expected.apply_axis_angle(&f.h, twist * weight);
            assert!(compose(Some(&target), weight, 0.0).distance_to(&expected) < EXACT);
            // Pose twist is defined about the hand axis; it is not anatomical forearmRoll.
            assert!(compose(None, 0.0, twist).distance_to(&target) < EXACT);
            assert_eq!(driver.request_roll_history(), 0.0);
        }
    }

    #[test]
    fn keeps_the_canonical_endpoint_and_validates_it() {
        for side in SIDES {
            let (mut h, context, configuration, f) = transport(side, PI / 3.0, -PI / 6.0);
            let curls = [Some(0.2), Some(0.4), Some(0.6), Some(0.3), Some(0.5)];
            let spread = [None, Some(0.2), None, Some(-0.1), None];
            let (driver, _) = h.driver(side);
            let request = driver.compose_request(
                &context,
                &f.u,
                &f.l,
                &f.h,
                Some(&f.palm),
                0.5,
                0.0,
                &curls,
                &spread,
                false,
            );
            let palm = request.palm.expect("canonical endpoint lost its palm");
            assert!(palm.distance_to(&f.palm) < EXACT);
            h.capture_volume_frame(side);
            let (driver, anat) = h.driver(side);
            let mut q = [0.0; DOFS];
            driver.configuration_to_q(&configuration, &mut q);
            assert!(driver.validate_locked_pose(
                anat,
                &q,
                &context,
                &curls,
                &spread,
                DriverOutput::Bridge
            ));
        }
    }

    #[test]
    fn retains_the_fk_palm_for_a_regular_wrist() {
        for (flex, deviation) in [(0.0, 0.0), (PI / 3.0, 0.0), (0.0, PI / 9.0), (4e-5, -2e-5)] {
            let (mut h, context, _, f) = transport(Side::R, flex, deviation);
            let (driver, _) = h.driver(Side::R);
            let request = driver.compose_request(
                &context,
                &f.u,
                &f.l,
                &f.h,
                Some(&f.palm),
                0.5,
                0.0,
                &EMPTY_SPEC,
                &EMPTY_SPEC,
                false,
            );
            let palm = request.palm.expect("regular wrist request lost its palm");
            assert!(palm.distance_to(&f.palm) < EXACT);
            assert!(request.hand.distance_to(&f.h) < EXACT);
        }
    }

    #[test]
    fn keeps_a_finite_request_at_an_unsupported_wrist() {
        for kind in ["opposite", "right angle flexion", "right angle deviation"] {
            let (mut h, context, _, f) = transport(Side::R, 0.0, 0.0);
            let hand = match kind {
                "opposite" => *f.l.clone().negate(),
                "right angle flexion" => f.palm,
                _ => *Vec3::default().cross_vectors(&f.palm, &f.l).normalize(),
            };
            let (driver, _) = h.driver(Side::R);
            let request = driver.compose_request(
                &context,
                &f.u,
                &f.l,
                &hand,
                None,
                0.0,
                0.4,
                &EMPTY_SPEC,
                &EMPTY_SPEC,
                false,
            );
            let finite = |v: &Vec3| v.x.is_finite() && v.y.is_finite() && v.z.is_finite();
            assert!(finite(&request.hand), "{kind}");
            if let Some(palm) = request.palm {
                assert!(finite(&palm), "{kind}");
                assert!(
                    (hypot(&[palm.x, palm.y, palm.z]) - 1.0).abs() < EXACT,
                    "{kind}"
                );
                assert!(palm.dot(&request.hand).abs() < EXACT, "{kind}");
            }
        }
    }

    // --- tests/rig/arm-clearance-keys.test.ts ---------------------------------------------------
    //
    // "reads each point identity once per repeated sample" counts reads of the TS string id,
    // and the renamed half of the reorder case renames TS ids, which a point here does not have.

    fn scenario(side: Side) -> (Driven, Vec<ArmPathPoint>, Vec<ArmPathClearance>) {
        let mut h = Driven::new();
        let context = h.context(side);
        h.capture_volume_frame(side);
        let (driver, anat) = h.driver(side);
        let accepted = driver.accepted_configuration;
        driver.request_for_configuration(&accepted, &context, &EMPTY_SPEC, &EMPTY_SPEC);
        let q = driver.accepted_q;
        assert!(driver.validate_locked_pose(
            anat,
            &q,
            &context,
            &EMPTY_SPEC,
            &EMPTY_SPEC,
            DriverOutput::Bridge
        ));
        let points = driver.bridge_output.points.clone();
        let rows = vec![ArmPathClearance::default(); driver.environment.row_count];
        (h, points, rows)
    }

    fn keys_of(points: &[ArmPathPoint]) -> Vec<Option<ClearanceKey>> {
        points
            .iter()
            .flat_map(|p| [0, 1, 2].map(|s| Some(clearance_key(point_id(p), s))))
            .collect()
    }

    #[test]
    fn preserves_row_values_and_order_across_reordered_points() {
        for side in SIDES {
            let (mut h, points, mut rows) = scenario(side);
            let (driver, anat) = h.driver(side);
            driver.sample_environment(anat, &points, &mut rows);
            let baseline = rows.clone();
            assert_eq!(
                baseline.iter().map(|r| r.key).collect::<Vec<_>>(),
                keys_of(&points)
            );
            let reordered: Vec<ArmPathPoint> = points.iter().rev().copied().collect();
            driver.sample_environment(anat, &reordered, &mut rows);
            for row in &rows {
                let prior = baseline
                    .iter()
                    .find(|r| r.key == row.key)
                    .expect("a known key");
                assert_eq!(
                    *row,
                    ArmPathClearance {
                        point_index: row.point_index,
                        ..*prior
                    }
                );
            }
            assert_eq!(
                rows.iter().map(|r| r.key).collect::<Vec<_>>(),
                keys_of(&reordered)
            );
            assert_eq!(
                rows.iter().map(|r| r.point_index).collect::<Vec<_>>(),
                (0..reordered.len())
                    .flat_map(|i| [Some(i); 3])
                    .collect::<Vec<_>>()
            );
            driver.sample_environment(anat, &points, &mut rows);
            assert_eq!(rows, baseline);
        }
    }

    #[test]
    fn refreshes_geometry_while_retaining_the_point_keys() {
        let (mut h, mut points, mut rows) = scenario(Side::R);
        let (driver, anat) = h.driver(Side::R);
        driver.sample_environment(anat, &points, &mut rows);
        let baseline = rows.clone();
        let index = rows
            .iter()
            .position(|r| r.valid && r.key.is_some_and(|k| k % 3 == 0))
            .expect("a valid torso row");
        let point = rows[index].point_index.unwrap();
        points[point].position.x += 1.0;
        driver.sample_environment(anat, &points, &mut rows);
        assert_eq!(
            rows.iter().map(|r| r.key).collect::<Vec<_>>(),
            baseline.iter().map(|r| r.key).collect::<Vec<_>>()
        );
        assert_ne!(rows[index].distance, baseline[index].distance);
        let changed = rows.clone();
        driver.sample_environment(anat, &points, &mut rows);
        assert_eq!(rows, changed);
    }

    // --- tests/rig/arm-path.test.ts "settles to the box optimum" ----------------------------------

    fn request_of(s: &mut Stream) -> ArmPathRequest {
        ArmPathRequest {
            wrist: s.vec3(),
            hand: s.vec3(),
            palm: s.opt_vec3(),
            elbow: s.opt_vec3(),
            curls: s.spec(),
            spread: s.spec(),
        }
    }

    fn pose_of(s: &mut Stream) -> Option<VolumePose> {
        s.flag().then(|| VolumePose {
            o: s.vec3(),
            up: s.vec3(),
            right: s.vec3(),
            fwd: s.vec3(),
        })
    }

    /// The TS run's last plan after 140 frames of `cover`, with what the environment held then,
    /// from `tests/corpora/rig-d-battery-box`; every plan to the box minimum and every probe
    /// around it replay bit for bit, and no probe inside the box improves on it.
    #[test]
    fn settles_to_the_box_optimum() {
        let corpus = Corpus::load("rig-d-battery-box");
        let case = corpus.case(0);
        let mut s = Stream::new(case.output("stream"));
        s.what = "box".to_string();
        let mut h = Driven::new();
        let definition = {
            let d = h.drivers[1].as_ref().unwrap();
            hash_halves(&definition_values(&d.calibration, &d.hand_geometry))
        };
        s.same(&definition, "definition");
        let start = s.q();
        let context = context_of(&mut s);
        let request = request_of(&mut s);
        let held = request_of(&mut s);
        let frame = BodyVolumeFrame {
            torso: pose_of(&mut s),
            head: pose_of(&mut s),
        };
        if s.flag() {
            for i in 0..h.graph.len() as u32 {
                let (p, q, k) = (s.vec3(), s.quat(), s.vec3());
                h.graph.set_local_position(i, &p);
                h.graph.set_local_quaternion(i, &q);
                h.graph.set_local_scale(i, &k);
            }
            h.graph.update_matrix_world(0, true);
            h.anat.face_mut().expect("a face").refresh(&mut h.graph);
        }
        let (driver, anat) = h.driver(Side::R);
        driver.environment.volume_frame = frame;
        driver.request = held;

        let calls = s.index();
        let mut q = start;
        let mut status = ArmPathStatus::Progress;
        for _ in 0..calls {
            let bounds = *driver.fill_bounds(&q, 0.0, false);
            let mut environment = Sampling {
                state: &mut driver.environment,
                anat,
            };
            driver.solver.plan(
                &request,
                &q,
                &context,
                &bounds,
                &mut environment,
                &mut driver.output,
            );
            status = driver.output.status;
            q = driver.output.q;
            s.same(&q, "plan q");
            s.same(&[status as usize as f64], "plan status");
        }
        assert_eq!(status, ArmPathStatus::Stationary);

        let hand_length = h.profile.limb[Side::R as usize].tip[Finger::Middle as usize].unwrap();
        let (driver, anat) = h.driver(Side::R);
        let span = context.upper_length + context.lower_length + hand_length;
        let mut hand = request.hand;
        hand.normalize();
        let palm = request.palm.map(|p| {
            let mut n = p;
            n.add_scaled_vector(&hand, -p.dot(&hand)).normalize();
            n
        });
        let along = |from: &Vec3, dir: &Vec3| {
            let mut v = *from;
            v.add_scaled_vector(dir, hand_length);
            v
        };
        let mut targets = vec![request.wrist, along(&request.wrist, &hand)];
        if let Some(palm) = palm {
            targets.push(along(&request.wrist, &palm));
        }
        let calibration = driver.calibration.clone();
        let primary = |at: &[f64; DOFS]| {
            let mut c = ArmConfiguration::default();
            configuration_from_q(at, &mut c);
            let mut fk = ArmForwardResult::default();
            forward_arm(&c, &calibration, &context, &mut fk);
            let reached = [
                fk.wrist,
                along(&fk.wrist, &fk.h),
                along(&fk.wrist, &fk.palm),
            ];
            let mut sum = 0.0;
            for (t, r) in targets.iter().zip(reached) {
                let d = t.distance_to(&r) / span;
                sum += d * d;
            }
            sum
        };
        let at_end = primary(&q);
        s.same(&[at_end], "primary");
        let bounds = *driver.fill_bounds(&q, 0.0, false);
        let (mut probed, mut better) = (0, 0);
        for dof in 0..DOFS {
            for sign in [-1.0, 1.0] {
                let mut moved = q;
                moved[dof] += sign * 1e-3;
                if moved[dof] < bounds.lower[dof] || moved[dof] > bounds.upper[dof] {
                    s.same(&[-1.0, 0.0], "probe");
                    continue;
                }
                if !driver.validate_locked_pose(
                    anat,
                    &moved,
                    &context,
                    &request.curls,
                    &request.spread,
                    DriverOutput::Bridge,
                ) {
                    s.same(&[0.0, 0.0], "probe");
                    continue;
                }
                probed += 1;
                let drop = at_end - primary(&moved);
                s.same(&[1.0, drop], "probe");
                if drop > EPSILON_2_3 * js_max(1.0, at_end) {
                    better += 1;
                }
            }
        }
        assert!(s.done());
        assert!(probed > 0);
        assert_eq!(better, 0);
    }
}
