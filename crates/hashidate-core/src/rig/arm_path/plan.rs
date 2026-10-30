//! `rig/arm-path.ts`, everything but `ArmStepSolver`: the plan's request, bounds, environment and
//! output, the seven-value configuration order, and the module helpers the solver steps with.
//!
//! A proxy point is named by its kind and index (and, on a finger, its joint) rather than by the
//! string id the TS builds from them; the two are equivalent, as both are unique per point. A
//! clearance row's key is a number the environment chooses, where the TS has a string, so the
//! rows the environment writes on every sample allocate nothing. An unset key, the TS `''`, is
//! `None`, as is an unset point index, the TS `-1`. Fixed-length typed arrays are fixed-length
//! arrays, which leaves the length checks the TS makes on them to the type.

use crate::anatomy::joints::TORSO_SAMPLES;
use crate::math::f::{CBRT_EPSILON, EPSILON_2_3, js_max, js_min};
use crate::math::{Quat, Vec3};
use crate::profile::Finger;
use crate::rig::arm_configuration::{
    ArmCalibration, ArmConfiguration, ArmForwardContext, ArmForwardResult,
};
use crate::rig::hand_geometry::HandGeometryCalibration;
use crate::rig::hands::FingerSpec;
use core::f64::consts::PI;

pub(super) const DOFS: usize = 7;
pub(super) const LANDMARKS: usize = 3;
pub(super) const DIRECTION_COMPONENTS: usize = 3;
pub(super) const MAX_ITERATIONS: usize = 6;
pub(super) const MAX_LINE_SEARCHES: usize = 6;
pub(super) const MAX_SWEEP_DEPTH: usize = 8;
pub(super) const MAX_ENVIRONMENT_BATCHES: usize = 96;
/// Metres outside the surface a restore aims for. The face field's normal is not
/// its distance gradient, so aiming at exactly zero only approaches the surface.
pub(super) const RESTORE_MARGIN: f64 = 1e-6;
// cbrt(Number.EPSILON) and EPSILON^(2/3), as the bits V8 and the core agree on.
pub(super) const DIFFERENCE_SCALE: f64 = CBRT_EPSILON;
pub(super) const LEXICAL_EPSILON: f64 = EPSILON_2_3;
pub(super) const FULL_TURN: f64 = 2.0 * PI;
pub(super) const SETTLED_POSITION_FRACTION: f64 = 1e-6;
pub(super) const SETTLED_ORIENTATION: f64 = 1e-5;
/// Accepted moves that remove at most this fraction of the starting primary
/// error, on physical stops only, mean the plan has stopped at a box minimum.
pub(super) const STATIONARY_FRACTION: f64 = 1e-3;
const FRAME_TOLERANCE: f64 = 1e-4;
/// Weight of squared wrist deviation past its comfortable band, in radians, beside
/// the elbow's squared miss. At 10 the pole still held fingerTouch at −20.1°; at
/// 100 every hold the band can reach lands between −19.8° and −19.0°.
pub(super) const DEVIATION_COMFORT_WEIGHT: f64 = 100.0;
/// How far inside the band the comfort term aims, so the pole cannot balance it on the edge.
pub(super) const DEVIATION_COMFORT_MARGIN: f64 = PI / 180.0;

// arm-path.ts halvings
//
// Two to the minus `line` for a whole `line`: 0.5 multiplied in `line` times, which is exact.
pub(super) fn halvings(line: usize) -> f64 {
    let mut alpha = 1.0;
    for _ in 0..line {
        alpha *= 0.5;
    }
    alpha
}

/// `ArmPathPointKind`, in declaration order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArmPathPointKind {
    Upper,
    Forearm,
    Hand,
    Finger,
}

/// Stable proxy point identity. Positions are overwritten on each evaluation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArmPathPoint {
    pub kind: ArmPathPointKind,
    pub index: usize,
    pub finger: Option<Finger>,
    pub joint_index: Option<usize>,
    pub tip: Option<bool>,
    pub position: Vec3,
}

/// A clearance row's key: stable across every sample and unique among the rows.
pub type ClearanceKey = u32;

/// One signed surface distance in metres, with an outward world-space normal. The default is
/// `makeClearance`'s: no key, no point, invalid, infinitely far.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArmPathClearance {
    /// Stable across every sample; multiple surfaces may constrain one point.
    pub key: Option<ClearanceKey>,
    pub point_index: Option<usize>,
    /// Invalid optional surfaces retain their stable slot but add no constraint.
    pub valid: bool,
    pub distance: f64,
    /// World-space distance gradient; radial tables need not have a unit gradient.
    pub normal: Vec3,
}

// arm-path.ts makeClearance
impl Default for ArmPathClearance {
    fn default() -> ArmPathClearance {
        ArmPathClearance {
            key: None,
            point_index: None,
            valid: false,
            distance: f64::INFINITY,
            normal: Vec3::default(),
        }
    }
}

/// Fixed-cardinality clearance query. Rows may be returned in any order.
pub trait ArmPathEnvironment {
    fn row_count(&self) -> usize;
    fn sample(&mut self, points: &[ArmPathPoint], out: &mut [ArmPathClearance]);
}

/// Target wrist is a point; hand and palm are world-space directions.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArmPathRequest {
    pub wrist: Vec3,
    pub hand: Vec3,
    pub palm: Option<Vec3>,
    pub curls: FingerSpec,
    pub spread: FingerSpec,
    pub elbow: Option<Vec3>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArmPathBounds {
    /// Absolute seven-component bounds in path coordinate order.
    pub lower: [f64; DOFS],
    pub upper: [f64; DOFS],
}

/// `stationary`: the exact QP step stopped improving the request at a residual,
/// a local minimum of the box rather than a failure to move.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArmPathStatus {
    Progress,
    Settled,
    Stationary,
    Blocked,
}

/// Reusable answer buffer. `q` is exactly the raw configuration sent to FK.
#[derive(Clone, Debug, PartialEq)]
pub struct ArmPathPlanOutput {
    pub q: [f64; DOFS],
    pub configuration: ArmConfiguration,
    pub forward: ArmForwardResult,
    pub points: Vec<ArmPathPoint>,
    pub clearances: Vec<ArmPathClearance>,
    pub status: ArmPathStatus,
    pub position_error: f64,
    pub orientation_error: f64,
    pub secondary_error: f64,
    pub max_violation: f64,
    pub iterations: usize,
    pub environment_batches: usize,
}

/// One pose the solver holds: its q, what FK made of it, and how it measures.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct PathState {
    pub q: [f64; DOFS],
    pub configuration: ArmConfiguration,
    pub forward: ArmForwardResult,
    pub points: Vec<ArmPathPoint>,
    pub clearances: Vec<ArmPathClearance>,
    pub primary_error: f64,
    pub secondary_error: f64,
    pub position_error: f64,
    pub orientation_error: f64,
    pub max_violation: f64,
    pub penetration_square_sum: f64,
}

/// The supplied bounds narrowed to the joints' physical ones.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct ResolvedBounds {
    pub lower: [f64; DOFS],
    pub upper: [f64; DOFS],
    /// True where the supplied bound is narrower than the joint's physical one.
    pub lower_temporal: [bool; DOFS],
    pub upper_temporal: [bool; DOFS],
}

// arm-path.ts configurationToQ
//
// Encode one configuration in the solver's stable seven-value order.
pub fn configuration_to_q(configuration: &ArmConfiguration, out: &mut [f64; DOFS]) {
    out[0] = configuration.shoulder_plane;
    out[1] = configuration.shoulder_lift * PI;
    out[2] = configuration.humeral_rotation;
    out[3] = configuration.elbow_flex;
    out[4] = configuration.forearm_roll;
    out[5] = configuration.wrist_flex;
    out[6] = configuration.wrist_dev;
}

// arm-path.ts configurationFromQ
//
// Decode the solver's seven-value order back into a configuration.
pub fn configuration_from_q<'o>(
    q: &[f64; DOFS],
    out: &'o mut ArmConfiguration,
) -> &'o mut ArmConfiguration {
    out.shoulder_plane = q[0];
    out.shoulder_lift = q[1] / PI;
    out.humeral_rotation = q[2];
    out.elbow_flex = q[3];
    out.forearm_roll = q[4];
    out.wrist_flex = q[5];
    out.wrist_dev = q[6];
    out
}

// arm-path.ts point
fn point(
    kind: ArmPathPointKind,
    index: usize,
    finger: Option<Finger>,
    joint_index: Option<usize>,
    tip: Option<bool>,
) -> ArmPathPoint {
    ArmPathPoint {
        kind,
        index,
        finger,
        joint_index,
        tip,
        position: Vec3::default(),
    }
}

// arm-path.ts proxyPoints
pub(super) fn proxy_points(hand: &HandGeometryCalibration) -> Vec<ArmPathPoint> {
    let mut out = Vec::with_capacity(3 * TORSO_SAMPLES + 1 + hand.points.len());
    for i in 0..=TORSO_SAMPLES {
        out.push(point(ArmPathPointKind::Upper, i, None, None, None));
    }
    for i in 1..=TORSO_SAMPLES {
        out.push(point(ArmPathPointKind::Forearm, i, None, None, None));
    }
    for i in 1..=TORSO_SAMPLES {
        out.push(point(ArmPathPointKind::Hand, i, None, None, None));
    }
    for finger in &hand.points {
        let index = out.len();
        out.push(point(
            ArmPathPointKind::Finger,
            index,
            Some(finger.finger),
            Some(finger.joint_index),
            Some(finger.tip),
        ));
    }
    out
}

// arm-path.ts makeState
pub(super) fn make_state(template: &[ArmPathPoint]) -> PathState {
    PathState {
        q: [0.0; DOFS],
        configuration: ArmConfiguration::default(),
        forward: ArmForwardResult::default(),
        points: template
            .iter()
            .map(|p| ArmPathPoint {
                position: Vec3::default(),
                ..*p
            })
            .collect(),
        clearances: Vec::new(),
        primary_error: f64::INFINITY,
        secondary_error: f64::INFINITY,
        position_error: f64::INFINITY,
        orientation_error: f64::INFINITY,
        max_violation: f64::INFINITY,
        penetration_square_sum: f64::INFINITY,
    }
}

// arm-path.ts cloneRows
pub(super) fn clone_rows(count: usize) -> Vec<ArmPathClearance> {
    vec![ArmPathClearance::default(); count]
}

// arm-path.ts finiteVector
pub(super) fn finite_vector(value: &Vec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

// arm-path.ts unitVector
fn unit_vector(value: &Vec3) -> bool {
    finite_vector(value) && (value.length_sq() - 1.0).abs() < FRAME_TOLERANCE
}

// arm-path.ts unitQuaternion
fn unit_quaternion(value: &Quat) -> bool {
    value.x.is_finite()
        && value.y.is_finite()
        && value.z.is_finite()
        && value.w.is_finite()
        // `lengthSq`, which sums the same products in the same order as `dot`.
        && (value.dot(value) - 1.0).abs() < FRAME_TOLERANCE
}

// arm-path.ts validContext
pub(super) fn valid_context(context: &ArmForwardContext) -> bool {
    if !(finite_vector(&context.shoulder)
        && unit_vector(&context.up)
        && unit_vector(&context.right)
        && unit_vector(&context.forward)
        && unit_quaternion(&context.upper_parent_world)
        && context.upper_length.is_finite()
        && context.lower_length.is_finite())
        || context.upper_length <= 0.0
        || context.lower_length <= 0.0
    {
        return false;
    }
    context.up.dot(&context.right).abs() < FRAME_TOLERANCE
        && context.up.dot(&context.forward).abs() < FRAME_TOLERANCE
        && context.right.dot(&context.forward).abs() < FRAME_TOLERANCE
}

// arm-path.ts validForward
pub(super) fn valid_forward(forward: &ArmForwardResult) -> bool {
    unit_vector(&forward.u)
        && unit_vector(&forward.l)
        && unit_vector(&forward.h)
        && unit_vector(&forward.palm)
        && forward.h.dot(&forward.palm).abs() < FRAME_TOLERANCE
        && finite_vector(&forward.elbow)
        && finite_vector(&forward.wrist)
        && unit_quaternion(&forward.upper_world)
        && unit_quaternion(&forward.lower_world)
        && unit_quaternion(&forward.hand_world)
        && unit_quaternion(&forward.upper_local)
        && unit_quaternion(&forward.lower_local)
        && unit_quaternion(&forward.hand_local)
}

// arm-path.ts finiteSpec
pub(super) fn finite_spec(spec: &FingerSpec) -> bool {
    spec.iter().all(|v| v.is_none_or(f64::is_finite))
}

// arm-path.ts createBounds
pub(super) fn create_bounds(
    calibration: &ArmCalibration,
    supplied: &ArmPathBounds,
    out: &mut ResolvedBounds,
) -> bool {
    let joints = &calibration.joints;
    for i in 0..DOFS {
        if !(supplied.lower[i].is_finite() && supplied.upper[i].is_finite()) {
            return false;
        }
        let [physical_lower, physical_upper] = match i {
            0 => [f64::NEG_INFINITY, f64::INFINITY],
            1 => [0.0, PI],
            2 => joints.shoulder.rotation.max,
            3 => joints.elbow.flexion.max,
            4 => joints.elbow.rotation.max,
            5 => joints.wrist.flexion.max,
            _ => joints.wrist.deviation.max,
        };
        if !physical_lower.is_finite() && i != 0 {
            return false;
        }
        if !physical_upper.is_finite() && i != 0 {
            return false;
        }
        out.lower[i] = js_max(supplied.lower[i], physical_lower);
        out.upper[i] = js_min(supplied.upper[i], physical_upper);
        out.lower_temporal[i] = supplied.lower[i] > physical_lower;
        out.upper_temporal[i] = supplied.upper[i] < physical_upper;
        if out.lower[i] > out.upper[i] {
            return false;
        }
    }
    true
}

// arm-path.ts copyForward
//
// Copy every landmark and frame of one forward result into another. The result here carries no
// scratch, so that is the whole of it.
pub fn copy_forward(source: &ArmForwardResult, target: &mut ArmForwardResult) {
    *target = *source;
}

// arm-path.ts dotRow
pub(super) fn dot_row(matrix: &[f64], row: usize, vector: &[f64], vector_offset: usize) -> f64 {
    let mut result = 0.0;
    let start = row * DOFS;
    for i in 0..DOFS {
        result += matrix[start + i] * vector[vector_offset + i];
    }
    result
}

// arm-path.ts makeArmPathPlanOutput
//
// Allocate the reusable result object for a solver and a fixed environment row count. The TS
// also takes the arm calibration, which it does not read.
pub fn make_arm_path_plan_output(
    hand_geometry: &HandGeometryCalibration,
    row_count: usize,
) -> ArmPathPlanOutput {
    ArmPathPlanOutput {
        q: [0.0; DOFS],
        configuration: ArmConfiguration::default(),
        forward: ArmForwardResult::default(),
        points: proxy_points(hand_geometry),
        clearances: clone_rows(row_count),
        status: ArmPathStatus::Blocked,
        position_error: f64::INFINITY,
        orientation_error: f64::INFINITY,
        secondary_error: f64::INFINITY,
        max_violation: f64::INFINITY,
        iterations: 0,
        environment_batches: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anatomy::joints::JointTable;
    use crate::corpus_replay::{Case, Corpus};
    use crate::rig::arm_configuration::{BoneCalibration, HandCalibration, UpperCalibration};
    use crate::rig::hand_geometry::FingerPointPath;

    const FIELDS: [&str; 7] = [
        "shoulderPlane",
        "shoulderLift",
        "humeralRotation",
        "elbowFlex",
        "forearmRoll",
        "wristFlex",
        "wristDev",
    ];

    fn bits(values: &[f64]) -> Vec<u64> {
        values.iter().map(|v| v.to_bits()).collect()
    }

    fn vec3(s: &[f64]) -> Vec3 {
        Vec3::new(s[0], s[1], s[2])
    }

    fn quat(s: &[f64]) -> Quat {
        Quat::new(s[0], s[1], s[2], s[3])
    }

    fn q_of(s: &[f64]) -> [f64; DOFS] {
        s.try_into().expect("seven values")
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

    fn configuration_in(case: &Case, at: &str) -> ArmConfiguration {
        let v = |k: usize| case.scalar(&format!("{at}.{}", FIELDS[k]), false);
        ArmConfiguration {
            shoulder_plane: v(0),
            shoulder_lift: v(1),
            humeral_rotation: v(2),
            elbow_flex: v(3),
            forearm_roll: v(4),
            wrist_flex: v(5),
            wrist_dev: v(6),
        }
    }

    fn forward_values(r: &ArmForwardResult) -> Vec<f64> {
        let mut out = Vec::with_capacity(42);
        for v in [r.u, r.l, r.h, r.palm, r.elbow, r.wrist] {
            out.extend([v.x, v.y, v.z]);
        }
        for q in [
            r.upper_world,
            r.lower_world,
            r.hand_world,
            r.upper_local,
            r.lower_local,
            r.hand_local,
        ] {
            out.extend([q.x, q.y, q.z, q.w]);
        }
        out
    }

    /// A recorded `ArmForwardResult` under `at`, read as input or output.
    fn forward_of(case: &Case, at: &str, output: bool) -> ArmForwardResult {
        let read = |k: &str| {
            let name = format!("{at}.{k}");
            if output {
                case.output(&name)
            } else {
                case.input(&name)
            }
        };
        ArmForwardResult {
            u: vec3(read("u")),
            l: vec3(read("l")),
            h: vec3(read("h")),
            palm: vec3(read("palm")),
            elbow: vec3(read("elbow")),
            wrist: vec3(read("wrist")),
            upper_world: quat(read("upperWorld")),
            lower_world: quat(read("lowerWorld")),
            hand_world: quat(read("handWorld")),
            upper_local: quat(read("upperLocal")),
            lower_local: quat(read("lowerLocal")),
            hand_local: quat(read("handLocal")),
        }
    }

    fn calibration() -> ArmCalibration {
        ArmCalibration {
            upper: UpperCalibration::default(),
            lower: BoneCalibration::default(),
            hand: HandCalibration::default(),
            radial_sign: 1.0,
            joints: JointTable::human(),
        }
    }

    fn full_bounds(joints: &JointTable) -> ArmPathBounds {
        ArmPathBounds {
            lower: [
                -PI,
                0.0,
                joints.shoulder.rotation.max[0],
                joints.elbow.flexion.max[0],
                joints.elbow.rotation.max[0],
                joints.wrist.flexion.max[0],
                joints.wrist.deviation.max[0],
            ],
            upper: [
                PI,
                PI,
                joints.shoulder.rotation.max[1],
                joints.elbow.flexion.max[1],
                joints.elbow.rotation.max[1],
                joints.wrist.flexion.max[1],
                joints.wrist.deviation.max[1],
            ],
        }
    }

    #[test]
    fn halvings_is_two_to_the_minus_line_exactly_into_the_subnormals() {
        for line in 0..=1074usize {
            let want = if line <= 1022 {
                f64::from_bits(((1023 - line) as u64) << 52)
            } else {
                f64::from_bits(1u64 << (1074 - line))
            };
            assert_eq!(halvings(line).to_bits(), want.to_bits(), "line {line}");
        }
        assert_eq!(halvings(1075), 0.0);
    }

    #[test]
    fn resolves_supplied_bounds_against_the_physical_ranges() {
        let c = calibration();
        let mut out = ResolvedBounds::default();
        let full = full_bounds(&c.joints);
        assert!(create_bounds(&c, &full, &mut out));
        assert_eq!(out.lower, full.lower);
        assert_eq!(out.upper, full.upper);
        // The plane has no physical range, so a finite one is always narrower.
        assert_eq!(
            out.lower_temporal,
            [true, false, false, false, false, false, false]
        );
        assert_eq!(
            out.upper_temporal,
            [true, false, false, false, false, false, false]
        );

        let mut wide = full;
        wide.lower[3] -= 1.0;
        wide.upper[3] += 1.0;
        let mut narrow = full;
        narrow.lower[5] += 0.1;
        narrow.upper[6] -= 0.1;
        assert!(create_bounds(&c, &wide, &mut out));
        assert_eq!(out.lower[3], c.joints.elbow.flexion.max[0]);
        assert_eq!(out.upper[3], c.joints.elbow.flexion.max[1]);
        assert!(!out.lower_temporal[3] && !out.upper_temporal[3]);
        assert!(create_bounds(&c, &narrow, &mut out));
        assert_eq!(out.lower[5], full.lower[5] + 0.1);
        assert!(out.lower_temporal[5] && !out.upper_temporal[5]);
        assert!(out.upper_temporal[6] && !out.lower_temporal[6]);
    }

    #[test]
    fn rejects_empty_non_finite_and_unbounded_ranges() {
        let c = calibration();
        let mut out = ResolvedBounds::default();
        let full = full_bounds(&c.joints);

        let mut empty = full;
        empty.lower[2] = empty.upper[2] + 1e-9;
        assert!(!create_bounds(&c, &empty, &mut out));
        // A supplied range wholly past the physical stop is empty once narrowed.
        let mut beyond = full;
        beyond.lower[1] = PI + 0.1;
        beyond.upper[1] = PI + 0.2;
        assert!(!create_bounds(&c, &beyond, &mut out));

        for value in [f64::NAN, f64::INFINITY] {
            let mut bad = full;
            bad.upper[0] = value;
            assert!(!create_bounds(&c, &bad, &mut out));
        }

        let mut open = calibration();
        open.joints.wrist.deviation.max[1] = f64::INFINITY;
        assert!(!create_bounds(&open, &full_bounds(&c.joints), &mut out));
    }

    #[test]
    fn configuration_to_q_replays_its_corpus_bit_for_bit() {
        let corpus = Corpus::load("configurationToQ");
        for case in corpus.iter() {
            let mut out = q_of(case.input("out"));
            configuration_to_q(&configuration_in(&case, "configuration"), &mut out);
            assert_eq!(bits(&out), bits(case.output("out")));
        }
    }

    /// The recorded hand's point identities, which are all the output reads of it.
    fn hand_points_of(case: &Case) -> HandGeometryCalibration {
        let n = case.scalar("handGeometry.points.len", false) as usize;
        HandGeometryCalibration {
            hand_present: (case.scalar("handGeometry.handPresent.present", false) == 1.0)
                .then(|| case.scalar("handGeometry.handPresent", false) == 1.0),
            metric_scale: case.scalar("handGeometry.metricScale", false),
            joints: JointTable::human(),
            points: (0..n)
                .map(|i| {
                    let at = |k: &str| case.scalar(&format!("handGeometry.points[{i}].{k}"), false);
                    FingerPointPath {
                        finger: Finger::ALL[at("finger") as usize],
                        joint_index: at("jointIndex") as usize,
                        tip: at("tip") == 1.0,
                        nodes: None,
                        previous_point: None,
                        last_point: None,
                    }
                })
                .collect(),
        }
    }

    fn flag(b: bool) -> f64 {
        f64::from(u8::from(b))
    }

    #[test]
    fn make_arm_path_plan_output_replays_its_corpus_bit_for_bit() {
        let corpus = Corpus::load("makeArmPathPlanOutput");
        let mut fingers = 0;
        for case in corpus.iter() {
            let row_count = case.scalar("rowCount", false) as usize;
            let out = make_arm_path_plan_output(&hand_points_of(&case), row_count);
            let o = |k: &str| case.output(&format!("return.{k}"));
            let s = |k: &str| case.scalar(&format!("return.{k}"), true);
            assert_eq!(bits(&out.q), bits(o("q")));
            let want: Vec<f64> = FIELDS
                .iter()
                .map(|k| s(&format!("configuration.{k}")))
                .collect();
            assert_eq!(bits(&configuration_values(&out.configuration)), bits(&want));
            assert_eq!(
                bits(&forward_values(&out.forward)),
                bits(&forward_values(&forward_of(&case, "return.forward", true)))
            );

            assert_eq!(out.points.len() as f64, s("points.len"));
            for (i, p) in out.points.iter().enumerate() {
                let at = |k: &str| format!("points[{i}].{k}");
                assert_eq!(p.kind as usize as f64, s(&at("kind")));
                assert_eq!(p.index as f64, s(&at("index")));
                assert_eq!(flag(p.finger.is_some()), s(&at("finger.present")));
                assert_eq!(flag(p.joint_index.is_some()), s(&at("jointIndex.present")));
                assert_eq!(flag(p.tip.is_some()), s(&at("tip.present")));
                if let Some(f) = p.finger {
                    fingers += 1;
                    assert_eq!(f as usize as f64, s(&at("finger")));
                    assert_eq!(p.joint_index.unwrap() as f64, s(&at("jointIndex")));
                    assert_eq!(flag(p.tip.unwrap()), s(&at("tip")));
                }
                let v = p.position;
                assert_eq!(bits(&[v.x, v.y, v.z]), bits(o(&at("position"))));
            }

            assert_eq!(out.clearances.len() as f64, s("clearances.len"));
            for (i, r) in out.clearances.iter().enumerate() {
                let at = |k: &str| format!("clearances[{i}].{k}");
                assert_eq!(r.key, None);
                assert_eq!(
                    r.point_index.map_or(-1.0, |p| p as f64),
                    s(&at("pointIndex"))
                );
                assert_eq!(flag(r.valid), s(&at("valid")));
                assert_eq!(r.distance.to_bits(), s(&at("distance")).to_bits());
                let n = r.normal;
                assert_eq!(bits(&[n.x, n.y, n.z]), bits(o(&at("normal"))));
            }

            assert_eq!(out.status as usize as f64, s("status"));
            for (v, k) in [
                (out.position_error, "positionError"),
                (out.orientation_error, "orientationError"),
                (out.secondary_error, "secondaryError"),
                (out.max_violation, "maxViolation"),
            ] {
                assert_eq!(v.to_bits(), s(k).to_bits(), "{k}");
            }
            assert_eq!(out.iterations as f64, s("iterations"));
            assert_eq!(out.environment_batches as f64, s("environmentBatches"));
        }
        assert!(fingers > 0, "the corpus names no finger point");
    }

    /// `tests/corpora/arm-path-plan-battery`: `configurationFromQ` and `copyForward` called
    /// directly in TS, as every one of their callers but the tests is in their own module.
    #[test]
    fn configuration_from_q_and_copy_forward_replay_their_battery_bit_for_bit() {
        let corpus = Corpus::load("arm-path-plan-battery");
        let mut kinds = [0; 2];
        for case in corpus.iter() {
            let kind = case.scalar("kind", false) as usize;
            kinds[kind] += 1;
            match kind {
                0 => {
                    let mut out = configuration_in(&case, "outConf");
                    let q = q_of(case.input("q"));
                    let returned = configuration_values(configuration_from_q(&q, &mut out));
                    assert_eq!(case.scalar("same", true), 1.0);
                    assert_eq!(bits(&returned), bits(&configuration_values(&out)));
                    let want: Vec<f64> = FIELDS
                        .iter()
                        .map(|k| case.scalar(&format!("outConf.{k}"), true))
                        .collect();
                    assert_eq!(bits(&configuration_values(&out)), bits(&want));
                }
                1 => {
                    let source = forward_of(&case, "source", false);
                    let mut target = forward_of(&case, "target", false);
                    copy_forward(&source, &mut target);
                    assert_eq!(
                        bits(&forward_values(&target)),
                        bits(&forward_values(&forward_of(&case, "target", true)))
                    );
                }
                _ => panic!("unknown battery kind {kind}"),
            }
        }
        assert!(kinds.iter().all(|&n| n > 0), "{kinds:?}");
    }
}
