//! `rig/arm-configuration.ts`: how the roll that turns the palm to face somewhere is split up
//! the arm, and the anatomical configuration of an arm in both directions.
//!
//! Three joints turn a palm over, and only one of them is below the elbow.
//! Rotating the humerus about its own axis carries the whole limb round; the
//! radius crossing the ulna adds pronation; the wrist itself contributes nothing
//! at all — it has no axial degree of freedom, and what a rig puts on the hand
//! bone is pronation rendered in the wrong place, because the skeleton has no
//! twist bone to put it on.
//!
//! Spending them in that order matters, and getting it wrong is what this used to
//! do. Charging the whole roll to forearm and wrist gave a hand reaching for the
//! mouth 150 degrees of pronation against a limit of 80 — nearly twice the range
//! a forearm has, while the shoulder above it sat unrotated with its own range
//! untouched. Skin weighted across a joint twisted that far collapses to zero
//! volume, so it does not merely look wrong: the wrist disappears.
//!
//! The shoulder is asked first, then the forearm, and the wrist takes only the
//! share of the forearm's pronation that has to be rendered above the joint for
//! the twist to reach the hand.
//!
//! The TS keeps forward scratch on each result and inverse scratch per output object; both are
//! written before they are read in every call, so here they are locals of the call.

use crate::anatomy::arm_frame::{humeral_reference, lateral_reference};
use crate::anatomy::joints::{JointDof, JointTable};
use crate::anatomy::strain::{clamp_dof, elevation_ceiling};
use crate::math::f::{acos, atan2, cos, hypot, js_max, js_round, sin, sqrt};
use crate::math::{Quat, Vec3, clamp};
use crate::profile::Side;
use core::f64::consts::PI;

// PRONATION_SPLIT is a rendering choice, not an anatomical one: both parts are
// the same rotation, and the measurement reports their sum as pronation. A real
// forearm twists progressively along its length, so the lower bone taking the
// larger share is what looks right.
pub const PRONATION_SPLIT: f64 = 0.4; // of the total pronation, the share on the hand

/// A bone's rest axis and rotation as handed to [`capture_arm_calibration`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BoneCalibrationInput {
    pub axis: Vec3,
    pub rest: Quat,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct UpperCalibrationInput {
    pub axis: Vec3,
    pub rest: Quat,
    pub front: Vec3,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HandCalibrationInput {
    pub axis: Vec3,
    pub rest: Quat,
    pub palm: Vec3,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArmCalibrationInput<'a> {
    pub upper: UpperCalibrationInput,
    pub lower: BoneCalibrationInput,
    pub hand: HandCalibrationInput,
    pub radial_sign: f64,
    pub joints: &'a JointTable,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BoneCalibration {
    pub axis: Vec3,
    pub rest: Quat,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct UpperCalibration {
    pub axis: Vec3,
    pub rest: Quat,
    pub front: Vec3,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HandCalibration {
    pub axis: Vec3,
    pub rest: Quat,
    pub palm: Vec3,
}

/// Rest geometry and hard joint ranges captured independently of a live rig.
#[derive(Clone, Debug, PartialEq)]
pub struct ArmCalibration {
    pub upper: UpperCalibration,
    pub lower: BoneCalibration,
    pub hand: HandCalibration,
    pub radial_sign: f64,
    pub joints: JointTable,
}

/// Why [`capture_arm_calibration`] refused, one per message the TS throws.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CalibrationRefusal {
    /// "arm calibration axis must be nonzero"
    ZeroAxis,
    /// "upper humeral front must not parallel its axis"
    FrontAlongAxis,
    /// "hand palm normal must not parallel its axis"
    PalmAlongAxis,
    /// "wrist hard ranges must stay inside a 90 degree combined bend"
    WristBeyondInverse,
}

/// Anatomical angles for one arm; angles remain scalar and unwrapped.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ArmConfiguration {
    pub shoulder_plane: f64,
    /// Fraction of the plane's own elevation ceiling; unbounded requests may exceed 1.
    pub shoulder_lift: f64,
    pub humeral_rotation: f64,
    pub elbow_flex: f64,
    /// Total pronation, split between forearm and hand rendering.
    pub forearm_roll: f64,
    pub wrist_flex: f64,
    pub wrist_dev: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ArmDirections {
    pub upper_arm: Vec3,
    pub lower_arm: Vec3,
    pub hand: Vec3,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArmForwardContext {
    pub side: Side,
    pub shoulder: Vec3,
    pub upper_length: f64,
    pub lower_length: f64,
    pub up: Vec3,
    pub right: Vec3,
    pub forward: Vec3,
    /// World frame of the parent above the upper-arm bone.
    pub upper_parent_world: Quat,
}

#[derive(Clone, Copy, Debug, Default)]
struct ArmForwardScratch {
    lateral: Vec3,
    bend: Vec3,
    reference: Vec3,
    perp: Vec3,
    current_axis: Vec3,
    current_front: Vec3,
    current_palm: Vec3,
    neutral_palm: Vec3,
    radial: Vec3,
    wrist_swing: Vec3,
    cross: Vec3,
    upper_rest_world: Quat,
    lower_rest_world: Quat,
    lower_neutral_world: Quat,
    hand_rest_world: Quat,
    hand_neutral_world: Quat,
    swing: Quat,
    twist: Quat,
}

#[derive(Clone, Copy, Debug, Default)]
struct ArmInverseScratch {
    u: Vec3,
    l: Vec3,
    h: Vec3,
    lateral: Vec3,
    bend: Vec3,
    reference: Vec3,
    perp: Vec3,
    normal: Vec3,
    radial: Vec3,
    swing: Vec3,
    twist: Quat,
    neutral: ArmForwardResult,
    neutral_scratch: ArmForwardScratch,
}

/// Directions, positions and bone rotations for one forward-kinematic pose. The default is
/// `makeArmForwardResult`'s: zero vectors and identity rotations.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ArmForwardResult {
    pub u: Vec3,
    pub l: Vec3,
    pub h: Vec3,
    pub palm: Vec3,
    pub elbow: Vec3,
    pub wrist: Vec3,
    pub upper_world: Quat,
    pub lower_world: Quat,
    pub hand_world: Quat,
    pub upper_local: Quat,
    pub lower_local: Quat,
    pub hand_local: Quat,
}

// arm-configuration.ts validateWristInverseDomain
fn validate_wrist_inverse_domain(joints: &JointTable) -> Result<(), CalibrationRefusal> {
    let flexion = joints.wrist.flexion.max;
    let deviation = joints.wrist.deviation.max;
    let max_flexion = js_max(flexion[0].abs(), flexion[1].abs());
    let max_deviation = js_max(deviation[0].abs(), deviation[1].abs());

    // The exact wrist inverse loses its palm-normal projection at 90 degrees.
    // Reject a hard-range rectangle that could reach that singular pose.
    if hypot(&[max_flexion, max_deviation]) >= PI / 2.0 {
        return Err(CalibrationRefusal::WristBeyondInverse);
    }
    Ok(())
}

// arm-configuration.ts unitAxis
fn unit_axis(mut axis: Vec3) -> Result<Vec3, CalibrationRefusal> {
    if axis.length_sq() < 1e-12 {
        return Err(CalibrationRefusal::ZeroAxis);
    }
    Ok(*axis.normalize())
}

// arm-configuration.ts captureArmCalibration
//
// Copy all avatar-owned rest data so later bone edits cannot change this calibration.
pub fn capture_arm_calibration(
    input: &ArmCalibrationInput,
) -> Result<ArmCalibration, CalibrationRefusal> {
    let upper_axis = unit_axis(input.upper.axis)?;
    let mut upper_front = input.upper.front;
    upper_front.add_scaled_vector(&upper_axis, -input.upper.front.dot(&upper_axis));
    if upper_front.length_sq() < 1e-12 {
        return Err(CalibrationRefusal::FrontAlongAxis);
    }
    upper_front.normalize();

    let lower_axis = unit_axis(input.lower.axis)?;
    let hand_axis = unit_axis(input.hand.axis)?;
    let mut hand_palm = input.hand.palm;
    hand_palm.add_scaled_vector(&hand_axis, -input.hand.palm.dot(&hand_axis));
    if hand_palm.length_sq() < 1e-12 {
        return Err(CalibrationRefusal::PalmAlongAxis);
    }
    hand_palm.normalize();
    let joints = input.joints.clone();
    validate_wrist_inverse_domain(&joints)?;

    let normalized = |q: &Quat| {
        let mut q = *q;
        q.normalize();
        q
    };
    Ok(ArmCalibration {
        upper: UpperCalibration {
            axis: upper_axis,
            front: upper_front,
            rest: normalized(&input.upper.rest),
        },
        lower: BoneCalibration {
            axis: lower_axis,
            rest: normalized(&input.lower.rest),
        },
        hand: HandCalibration {
            axis: hand_axis,
            palm: hand_palm,
            rest: normalized(&input.hand.rest),
        },
        radial_sign: if input.radial_sign < 0.0 { -1.0 } else { 1.0 },
        joints,
    })
}

// arm-configuration.ts aimWorld
//
// Build a calibrated local/world quaternion for a bone whose child axis is aimed.
fn aim_world(
    rest_world: &Quat,
    local_axis: &Vec3,
    target: &Vec3,
    current_axis: &mut Vec3,
    swing: &mut Quat,
    out: &mut Quat,
) {
    current_axis
        .copy(local_axis)
        .apply_quaternion(rest_world)
        .normalize();
    swing.set_from_unit_vectors(current_axis, target);
    out.copy(swing).multiply(rest_world);
}

// arm-configuration.ts aimUpper
//
// Match a calibrated local direction and front to the chosen humeral frame.
fn aim_upper(
    calibration: &ArmCalibration,
    context: &ArmForwardContext,
    u: &Vec3,
    bend: &Vec3,
    out: &mut Quat,
    scratch: &mut ArmForwardScratch,
) {
    scratch
        .upper_rest_world
        .copy(&context.upper_parent_world)
        .multiply(&calibration.upper.rest);
    aim_world(
        &scratch.upper_rest_world,
        &calibration.upper.axis,
        u,
        &mut scratch.current_axis,
        &mut scratch.swing,
        out,
    );
    scratch
        .current_front
        .copy(&calibration.upper.front)
        .apply_quaternion(out);
    let along = -scratch.current_front.dot(u);
    scratch
        .current_front
        .add_scaled_vector(u, along)
        .normalize();
    let angle = atan2(
        scratch
            .cross
            .cross_vectors(&scratch.current_front, bend)
            .dot(u),
        scratch.current_front.dot(bend),
    );
    scratch.twist.set_from_axis_angle(u, angle);
    out.premultiply(&scratch.twist);
}

// arm-configuration.ts neutralHandFrame
//
// Shared zero-roll hand frame for forward poses and their direction inverse.
fn neutral_hand_frame(
    calibration: &ArmCalibration,
    context: &ArmForwardContext,
    u: &Vec3,
    l: &Vec3,
    bend: &Vec3,
    out: &mut ArmForwardResult,
    s: &mut ArmForwardScratch,
) {
    aim_upper(calibration, context, u, bend, &mut out.upper_world, s);
    s.lower_rest_world
        .copy(&out.upper_world)
        .multiply(&calibration.lower.rest);
    aim_world(
        &s.lower_rest_world,
        &calibration.lower.axis,
        l,
        &mut s.current_axis,
        &mut s.swing,
        &mut s.lower_neutral_world,
    );
    s.hand_rest_world
        .copy(&s.lower_neutral_world)
        .multiply(&calibration.hand.rest);
    aim_world(
        &s.hand_rest_world,
        &calibration.hand.axis,
        l,
        &mut s.current_axis,
        &mut s.swing,
        &mut s.hand_neutral_world,
    );
    s.neutral_palm
        .copy(&calibration.hand.palm)
        .apply_quaternion(&s.hand_neutral_world);
    let along = -s.neutral_palm.dot(l);
    s.neutral_palm.add_scaled_vector(l, along).normalize();
}

// arm-configuration.ts aimHand
//
// Aim the hand to an axis and palm normal with a world-space roll about its axis.
fn aim_hand(
    calibration: &ArmCalibration,
    parent_world: &Quat,
    target_axis: &Vec3,
    target_palm: &Vec3,
    out: &mut Quat,
    scratch: &mut ArmForwardScratch,
) {
    scratch
        .hand_rest_world
        .copy(parent_world)
        .multiply(&calibration.hand.rest);
    aim_world(
        &scratch.hand_rest_world,
        &calibration.hand.axis,
        target_axis,
        &mut scratch.current_axis,
        &mut scratch.swing,
        out,
    );

    scratch
        .current_palm
        .copy(&calibration.hand.palm)
        .apply_quaternion(out);
    let along = -scratch.current_palm.dot(target_axis);
    scratch
        .current_palm
        .add_scaled_vector(target_axis, along)
        .normalize();
    scratch
        .neutral_palm
        .copy(target_palm)
        .add_scaled_vector(target_axis, -target_palm.dot(target_axis))
        .normalize();
    let angle = atan2(
        scratch
            .cross
            .cross_vectors(&scratch.current_palm, &scratch.neutral_palm)
            .dot(target_axis),
        scratch.current_palm.dot(&scratch.neutral_palm),
    );
    scratch.twist.set_from_axis_angle(target_axis, angle);
    out.premultiply(&scratch.twist);
}

// arm-configuration.ts boundArmConfiguration
//
// Explicitly bound a requested configuration to the captured hard joint ranges.
pub fn bound_arm_configuration<'o>(
    configuration: &ArmConfiguration,
    calibration: &ArmCalibration,
    out: &'o mut ArmConfiguration,
) -> &'o mut ArmConfiguration {
    let joints = &calibration.joints;
    out.shoulder_plane = configuration.shoulder_plane;
    out.shoulder_lift = clamp(configuration.shoulder_lift, 0.0, 1.0);
    out.humeral_rotation = clamp_dof(configuration.humeral_rotation, &joints.shoulder.rotation);
    out.elbow_flex = clamp_dof(configuration.elbow_flex, &joints.elbow.flexion);
    out.forearm_roll = clamp_dof(configuration.forearm_roll, &joints.elbow.rotation);
    out.wrist_flex = clamp_dof(configuration.wrist_flex, &joints.wrist.flexion);
    out.wrist_dev = clamp_dof(configuration.wrist_dev, &joints.wrist.deviation);
    out
}

// arm-configuration.ts forwardArm
//
// Pure forward kinematics for one anatomically configured arm.
pub fn forward_arm<'o>(
    configuration: &ArmConfiguration,
    calibration: &ArmCalibration,
    context: &ArmForwardContext,
    out: &'o mut ArmForwardResult,
) -> &'o mut ArmForwardResult {
    let mut s = ArmForwardScratch::default();
    let plane = configuration.shoulder_plane;
    let theta = configuration.shoulder_lift
        * elevation_ceiling(plane, &calibration.joints.shoulder.elevation).max;
    s.lateral.copy(&context.right);
    if context.side == Side::L {
        s.lateral.negate();
    }
    out.u
        .copy(&context.up)
        .multiply_scalar(-cos(theta))
        .add_scaled_vector(&s.lateral, sin(theta) * cos(plane))
        .add_scaled_vector(&context.forward, sin(theta) * sin(plane))
        .normalize();

    let humeral_rotation = configuration.humeral_rotation;
    let flex = configuration.elbow_flex;
    humeral_reference(&out.u, &context.up, &context.forward, &mut s.reference);
    lateral_reference(
        &out.u,
        &s.reference,
        &context.up,
        &context.forward,
        &s.lateral,
        &mut s.perp,
    );
    s.bend
        .copy(&s.reference)
        .multiply_scalar(cos(humeral_rotation))
        .add_scaled_vector(&s.perp, sin(humeral_rotation))
        .normalize();
    let u = out.u;
    out.l
        .copy(&u)
        .multiply_scalar(cos(flex))
        .add_scaled_vector(&s.bend, sin(flex))
        .normalize();

    let (l, bend) = (out.l, s.bend);
    neutral_hand_frame(calibration, context, &u, &l, &bend, out, &mut s);
    out.upper_local
        .copy(&context.upper_parent_world)
        .invert()
        .multiply(&out.upper_world);

    let forearm_roll = configuration.forearm_roll;
    let wrist_flex = configuration.wrist_flex;
    let wrist_dev = configuration.wrist_dev;
    s.twist.set_from_axis_angle(&out.l, forearm_roll);
    out.palm
        .copy(&s.neutral_palm)
        .apply_quaternion(&s.twist)
        .normalize();
    let wrist_angle = hypot(&[wrist_flex, wrist_dev]);
    if wrist_angle < 1e-12 {
        out.h.copy(&l);
    } else {
        s.radial
            .cross_vectors(&out.palm, &out.l)
            .multiply_scalar(calibration.radial_sign)
            .normalize();
        s.wrist_swing
            .copy(&out.palm)
            .multiply_scalar(wrist_flex / wrist_angle)
            .add_scaled_vector(&s.radial, wrist_dev / wrist_angle);
        out.h
            .copy(&l)
            .multiply_scalar(cos(wrist_angle))
            .add_scaled_vector(&s.wrist_swing, sin(wrist_angle))
            .normalize();
        out.palm
            .multiply_scalar(cos(wrist_angle))
            .add_scaled_vector(&l, (-sin(wrist_angle) * wrist_flex) / wrist_angle)
            .normalize();
    }

    let carry = forearm_roll * (1.0 - PRONATION_SPLIT);
    out.lower_local
        .copy(&out.upper_world)
        .invert()
        .multiply(&s.lower_neutral_world);
    s.twist.set_from_axis_angle(&calibration.lower.axis, carry);
    out.lower_local.multiply(&s.twist);
    let (upper_world, lower_local) = (out.upper_world, out.lower_local);
    out.lower_world.copy(&upper_world).multiply(&lower_local);

    let (lower_world, h, palm) = (out.lower_world, out.h, out.palm);
    aim_hand(
        calibration,
        &lower_world,
        &h,
        &palm,
        &mut out.hand_world,
        &mut s,
    );
    out.hand_local
        .copy(&lower_world)
        .invert()
        .multiply(&out.hand_world);

    out.elbow
        .copy(&context.shoulder)
        .add_scaled_vector(&u, context.upper_length);
    let elbow = out.elbow;
    out.wrist
        .copy(&elbow)
        .add_scaled_vector(&l, context.lower_length);
    out
}

// arm-configuration.ts finiteVector
fn finite_vector(value: &Vec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

// arm-configuration.ts unitVector
fn unit_vector(value: &Vec3) -> bool {
    finite_vector(value) && (value.length_sq() - 1.0).abs() < 1e-4
}

// arm-configuration.ts unitQuaternion
fn unit_quaternion(value: &Quat) -> bool {
    value.x.is_finite()
        && value.y.is_finite()
        && value.z.is_finite()
        && value.w.is_finite()
        // `lengthSq`, which sums the same products in the same order as `dot`.
        && (value.dot(value) - 1.0).abs() < 1e-4
}

// arm-configuration.ts finiteRange
fn finite_range(value: &[f64; 2]) -> bool {
    value[0].is_finite() && value[1].is_finite() && value[0] <= value[1]
}

// arm-configuration.ts validContextFrame
fn valid_context_frame(context: &ArmForwardContext) -> bool {
    if !(unit_vector(&context.up)
        && unit_vector(&context.right)
        && unit_vector(&context.forward)
        && unit_quaternion(&context.upper_parent_world)
        && finite_vector(&context.shoulder)
        && context.upper_length.is_finite()
        && context.lower_length.is_finite())
        || context.upper_length <= 0.0
        || context.lower_length <= 0.0
    {
        return false;
    }
    context.up.dot(&context.right).abs() < 1e-4
        && context.up.dot(&context.forward).abs() < 1e-4
        && context.right.dot(&context.forward).abs() < 1e-4
}

// arm-configuration.ts validCalibrationFrame
fn valid_calibration_frame(calibration: &ArmCalibration) -> bool {
    if !(unit_vector(&calibration.upper.axis)
        && unit_vector(&calibration.upper.front)
        && unit_quaternion(&calibration.upper.rest)
        && unit_vector(&calibration.lower.axis)
        && unit_quaternion(&calibration.lower.rest)
        && unit_vector(&calibration.hand.axis)
        && unit_vector(&calibration.hand.palm)
        && unit_quaternion(&calibration.hand.rest))
        || calibration.upper.axis.dot(&calibration.upper.front).abs() >= 1e-4
        || calibration.hand.axis.dot(&calibration.hand.palm).abs() >= 1e-4
        || (calibration.radial_sign != -1.0 && calibration.radial_sign != 1.0)
    {
        return false;
    }
    let joints = &calibration.joints;
    let dofs: [&JointDof; 5] = [
        &joints.shoulder.rotation,
        &joints.elbow.flexion,
        &joints.elbow.rotation,
        &joints.wrist.flexion,
        &joints.wrist.deviation,
    ];
    if joints.shoulder.elevation.len() < 2 || !dofs.iter().all(|d| finite_range(&d.max)) {
        return false;
    }
    let rows = &joints.shoulder.elevation;
    for (index, row) in rows.iter().enumerate() {
        if !row.iter().all(|v| v.is_finite()) {
            return false;
        }
        if index > 0 && row[0] <= rows[index - 1][0] {
            return false;
        }
    }
    let wrist_flexion = joints.wrist.flexion.max;
    let wrist_deviation = joints.wrist.deviation.max;
    let max_flexion = js_max(wrist_flexion[0].abs(), wrist_flexion[1].abs());
    let max_deviation = js_max(wrist_deviation[0].abs(), wrist_deviation[1].abs());
    hypot(&[max_flexion, max_deviation]) < PI / 2.0
}

// arm-configuration.ts unwrapNear
fn unwrap_near(angle: f64, reference: f64) -> f64 {
    reference + atan2(sin(angle - reference), cos(angle - reference))
}

// arm-configuration.ts nearestSupportedRoll
fn nearest_supported_roll(angle: f64, previous: Option<f64>, bounds: &[f64; 2]) -> f64 {
    let turn = PI * 2.0;
    let first = ((bounds[0] - angle) / turn).ceil();
    let last = ((bounds[1] - angle) / turn).floor();
    if first > last {
        return angle;
    }
    let target = previous.filter(|p| p.is_finite()).unwrap_or(0.0);
    let nearest = js_round((target - angle) / turn);
    angle + clamp(nearest, first, last) * turn
}

// arm-configuration.ts configurationOfDirections
//
// Invert measured world directions into an unbounded anatomical request.
// A true result means the geometry could be inverted, not that it is feasible.
pub fn configuration_of_directions(
    directions: &ArmDirections,
    palm: Option<&Vec3>,
    calibration: &ArmCalibration,
    context: &ArmForwardContext,
    previous: Option<&ArmConfiguration>,
    out: &mut ArmConfiguration,
) -> bool {
    if !(finite_vector(&directions.upper_arm)
        && finite_vector(&directions.lower_arm)
        && finite_vector(&directions.hand))
        || directions.upper_arm.length_sq() < 1e-12
        || directions.lower_arm.length_sq() < 1e-12
        || directions.hand.length_sq() < 1e-12
        || palm.is_some_and(|palm| !finite_vector(palm))
        || !valid_calibration_frame(calibration)
        || !valid_context_frame(context)
    {
        return false;
    }

    let mut s = ArmInverseScratch::default();
    s.u.copy(&directions.upper_arm).normalize();
    s.l.copy(&directions.lower_arm).normalize();
    s.h.copy(&directions.hand).normalize();
    let previous_plane = previous
        .map(|p| p.shoulder_plane)
        .filter(|v| v.is_finite())
        .unwrap_or(0.0);
    let previous_rotation = previous
        .map(|p| p.humeral_rotation)
        .filter(|v| v.is_finite())
        .unwrap_or(0.0);
    let previous_roll = previous.map(|p| p.forearm_roll).filter(|v| v.is_finite());

    s.lateral.copy(&context.right);
    if context.side == Side::L {
        s.lateral.negate();
    }
    let theta = acos(clamp(-s.u.dot(&context.up), -1.0, 1.0));
    s.swing
        .copy(&s.u)
        .add_scaled_vector(&context.up, -s.u.dot(&context.up));
    let plane = if s.swing.length_sq() < 1e-10 {
        previous_plane
    } else {
        unwrap_near(
            atan2(s.swing.dot(&context.forward), s.swing.dot(&s.lateral)),
            previous_plane,
        )
    };
    let ceiling = elevation_ceiling(plane, &calibration.joints.shoulder.elevation).max;
    if !ceiling.is_finite() || ceiling <= 0.0 {
        return false;
    }

    let elbow_cos = clamp(s.u.dot(&s.l), -1.0, 1.0);
    let elbow_flex = acos(elbow_cos);
    let bend_length_sq = s
        .bend
        .copy(&s.l)
        .add_scaled_vector(&s.u, -elbow_cos)
        .length_sq();
    humeral_reference(&s.u, &context.up, &context.forward, &mut s.reference);
    lateral_reference(
        &s.u,
        &s.reference,
        &context.up,
        &context.forward,
        &s.lateral,
        &mut s.perp,
    );
    if s.reference.length_sq() < 1e-10 || s.perp.length_sq() < 1e-10 {
        return false;
    }
    let humeral_rotation = if bend_length_sq < 1e-10 {
        previous_rotation
    } else {
        atan2(
            s.bend.dot(&s.perp) / sqrt(bend_length_sq),
            s.bend.dot(&s.reference) / sqrt(bend_length_sq),
        )
    };
    s.bend
        .copy(&s.reference)
        .multiply_scalar(cos(humeral_rotation))
        .add_scaled_vector(&s.perp, sin(humeral_rotation))
        .normalize();

    neutral_hand_frame(
        calibration,
        context,
        &s.u,
        &s.l,
        &s.bend,
        &mut s.neutral,
        &mut s.neutral_scratch,
    );
    let neutral_palm = s.neutral_scratch.neutral_palm;
    if neutral_palm.length_sq() < 1e-10 || !finite_vector(&neutral_palm) {
        return false;
    }
    let wrist_cos = clamp(s.l.dot(&s.h), -1.0, 1.0);
    let wrist_angle = acos(wrist_cos);

    let mut forearm_roll = previous_roll.unwrap_or(0.0);
    if let Some(palm) = palm {
        s.normal.copy(palm).add_scaled_vector(&s.l, -palm.dot(&s.l));
        if s.normal.length_sq() < 1e-10 {
            return false;
        }
        s.normal.normalize();
        if wrist_cos < 0.0 {
            s.normal.negate();
        }
        let roll = atan2(
            s.swing.cross_vectors(&neutral_palm, &s.normal).dot(&s.l),
            neutral_palm.dot(&s.normal),
        );
        forearm_roll =
            nearest_supported_roll(roll, previous_roll, &calibration.joints.elbow.rotation.max);
    } else {
        s.twist.set_from_axis_angle(&s.l, forearm_roll);
        s.normal
            .copy(&neutral_palm)
            .apply_quaternion(&s.twist)
            .normalize();
    }

    s.swing.copy(&s.h).add_scaled_vector(&s.l, -wrist_cos);
    let mut wrist_flex = 0.0;
    let mut wrist_dev = 0.0;
    if wrist_angle > 1e-4 {
        if s.swing.length_sq() < 1e-10 {
            return false;
        }
        s.swing.normalize();
        s.radial
            .cross_vectors(&s.normal, &s.l)
            .multiply_scalar(calibration.radial_sign);
        if s.radial.length_sq() < 1e-10 {
            return false;
        }
        s.radial.normalize();
        wrist_flex = wrist_angle * s.swing.dot(&s.normal);
        wrist_dev = wrist_angle * s.swing.dot(&s.radial);
    }

    out.shoulder_plane = plane;
    out.shoulder_lift = theta / ceiling;
    out.humeral_rotation = humeral_rotation;
    out.elbow_flex = elbow_flex;
    out.forearm_roll = forearm_roll;
    out.wrist_flex = wrist_flex;
    out.wrist_dev = wrist_dev;
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anatomy::arm::ArmAnatomy;
    use crate::anatomy::cost::ReadingId;
    use crate::anatomy::joints::{D, ElevationRow};
    use crate::corpus_replay::{Case, Corpus};
    use crate::profile::{ArmSlot, BoneSlot, Profile};
    use crate::rig::finger_axes::solve_finger_axes;
    use crate::rig::hand_geometry::{
        FINGER_TIP_EXTENSION, capture_hand_geometry, make_hand_geometry_sample,
        sample_hand_geometry,
    };
    use crate::rig::hands::Hands;
    use crate::rig::testkit::{avatar, bone, centimetre, close, euler, rest_of, rest_table};
    use crate::scene::graph::Graph;

    const EXACT: f64 = 1e-8;
    const SIDES: [Side; 2] = Side::BOTH;

    const POSE: ArmConfiguration = ArmConfiguration {
        shoulder_plane: 0.41,
        shoulder_lift: 0.72,
        humeral_rotation: 0.38,
        elbow_flex: 1.1,
        forearm_roll: 0.52,
        wrist_flex: 0.31,
        wrist_dev: -0.19,
    };

    fn slot(slot: ArmSlot, side: Side) -> BoneSlot {
        BoneSlot::arm(slot, side)
    }

    struct Scenario {
        graph: Graph,
        profile: Profile,
        anat: ArmAnatomy,
        calibration: ArmCalibration,
        context: ArmForwardContext,
    }

    /// `buildRig({ armatureScale })`, the arms set obliquely when asked, the root turned by `yaw`.
    fn posed(yaw: f64, scale: f64, oblique: bool) -> (Graph, Profile) {
        let (mut g, p) = avatar();
        if scale != 1.0 {
            assert_eq!(scale, 0.01);
            centimetre(&mut g);
        }
        if oblique {
            for side in SIDES {
                let sign = if side == Side::L { -1.0 } else { 1.0 };
                let set = |g: &mut Graph, s: ArmSlot, q: Quat| {
                    g.set_local_quaternion(bone(&p, slot(s, side)), &q);
                };
                set(
                    &mut g,
                    ArmSlot::UpperArm,
                    euler(0.17 * sign, -0.11 * sign, 0.23),
                );
                set(
                    &mut g,
                    ArmSlot::LowerArm,
                    euler(-0.13 * sign, 0.19, 0.16 * sign),
                );
                set(
                    &mut g,
                    ArmSlot::Hand,
                    euler(0.08, -0.21 * sign, 0.12 * sign),
                );
            }
        }
        g.set_local_quaternion(0, &euler(0.0, yaw, 0.0));
        g.update_matrix_world(0, true);
        (g, p)
    }

    /// `calibrationInput` in the TS test: the bind rotations as they stand, and the front `Rig`
    /// derives from the body frame.
    fn calibration_input<'j>(
        g: &mut Graph,
        p: &Profile,
        anat: &ArmAnatomy,
        side: Side,
        joints: &'j JointTable,
    ) -> ArmCalibrationInput<'j> {
        let upper = bone(p, slot(ArmSlot::UpperArm, side));
        let lower = bone(p, slot(ArmSlot::LowerArm, side));
        let hand = bone(p, slot(ArmSlot::Hand, side));
        let chest = bone(p, BoneSlot::Chest);
        let upper_world = g.world_quaternion(upper);
        let axis = p.rest_dir[slot(ArmSlot::UpperArm, side) as usize].unwrap();
        let mut along = axis;
        along.apply_quaternion(&upper_world);
        let mut front = p.body.unwrap().forward;
        front.apply_quaternion(&g.world_quaternion(chest));
        let d = -front.dot(&along);
        let mut inverse = upper_world;
        inverse.invert();
        front
            .add_scaled_vector(&along, d)
            .normalize()
            .apply_quaternion(&inverse);
        let palm = solve_finger_axes(p, g).palm_local[side as usize].unwrap();
        ArmCalibrationInput {
            upper: UpperCalibrationInput {
                axis,
                front,
                rest: g.local_quaternion(upper),
            },
            lower: BoneCalibrationInput {
                axis: p.rest_dir[slot(ArmSlot::LowerArm, side) as usize].unwrap(),
                rest: g.local_quaternion(lower),
            },
            hand: HandCalibrationInput {
                axis: p.rest_dir[slot(ArmSlot::Hand, side) as usize].unwrap(),
                palm,
                rest: g.local_quaternion(hand),
            },
            radial_sign: anat.radial_sign[side as usize],
            joints,
        }
    }

    fn scenario(
        side: Side,
        yaw: f64,
        scale: f64,
        oblique: bool,
        joints: Option<JointTable>,
    ) -> Scenario {
        let (mut graph, mut profile) = posed(yaw, scale, oblique);
        if joints.is_some() {
            profile.anatomy = joints;
        }
        let mut anat = ArmAnatomy::new(&profile, &mut graph);
        assert!(anat.update(&mut graph));
        let table = profile.anatomy.clone().unwrap_or_else(JointTable::human);
        let input = calibration_input(&mut graph, &profile, &anat, side, &table);
        let calibration = capture_arm_calibration(&input).unwrap();
        let upper = bone(&profile, slot(ArmSlot::UpperArm, side));
        graph.update_world_matrix(upper, true, false, false);
        let parent = graph.parent_of(upper).unwrap();
        let limb = &profile.limb[side as usize];
        let context = ArmForwardContext {
            side,
            shoulder: graph.world_position(upper),
            upper_length: limb.upper.unwrap(),
            lower_length: limb.lower.unwrap(),
            up: *anat.up(),
            right: *anat.right(),
            forward: *anat.fwd(),
            upper_parent_world: graph.world_quaternion(parent),
        };
        Scenario {
            graph,
            profile,
            anat,
            calibration,
            context,
        }
    }

    fn custom_joints() -> JointTable {
        let mut joints = JointTable::human();
        let rows: [ElevationRow; 3] =
            [[-180.0, 30.0, 60.0], [0.0, 30.0, 60.0], [180.0, 30.0, 60.0]];
        joints.shoulder.elevation = rows.to_vec();
        joints
    }

    fn invalid_wrist_joints() -> JointTable {
        let mut joints = JointTable::human();
        joints.wrist.flexion.max = [-PI / 2.0, PI / 2.0];
        joints.wrist.deviation.max = [0.0, 0.0];
        joints
    }

    fn wide_roll_joints() -> JointTable {
        let mut joints = JointTable::human();
        joints.elbow.rotation.max = [-7.0, 7.0];
        joints
    }

    fn forward(c: &ArmConfiguration, h: &Scenario) -> ArmForwardResult {
        let mut out = ArmForwardResult::default();
        forward_arm(c, &h.calibration, &h.context, &mut out);
        out
    }

    fn directions_of(r: &ArmForwardResult) -> ArmDirections {
        ArmDirections {
            upper_arm: r.u,
            lower_arm: r.l,
            hand: r.h,
        }
    }

    /// Every arm-slot bone's quaternion, as `boneQuaternions` collects the profile's.
    fn bone_quaternions(h: &Scenario) -> Vec<f64> {
        h.graph.quaternion.clone()
    }

    /// Pose the arm by an FK result's locals and read it back as `Rig.measure` does.
    fn measured(h: &mut Scenario, side: Side, out: &ArmForwardResult, fore_roll: f64) -> [f64; 7] {
        let p = &h.profile;
        let (u, l, hand) = (
            bone(p, slot(ArmSlot::UpperArm, side)),
            bone(p, slot(ArmSlot::LowerArm, side)),
            bone(p, slot(ArmSlot::Hand, side)),
        );
        h.graph.set_local_quaternion(u, &out.upper_local);
        h.graph.set_local_quaternion(l, &out.lower_local);
        h.graph.set_local_quaternion(hand, &out.hand_local);
        h.graph.update_matrix_world(0, true);
        let palm_local = solve_finger_axes(p, &mut h.graph).palm_local[side as usize].unwrap();
        assert!(h.anat.update(&mut h.graph));
        crate::rig::testkit::arm_context(p, &mut h.graph, &mut h.anat, side);
        let mut dir = |b: u32, s: ArmSlot| {
            let mut v = p.rest_dir[slot(s, side) as usize].unwrap();
            v.apply_quaternion(&h.graph.world_quaternion(b)).normalize();
            v
        };
        let (du, dl, dh) = (
            dir(u, ArmSlot::UpperArm),
            dir(l, ArmSlot::LowerArm),
            dir(hand, ArmSlot::Hand),
        );
        let mut palm = palm_local;
        palm.apply_quaternion(&h.graph.world_quaternion(hand))
            .normalize();
        h.anat
            .measure(side, &du, &dl, &dh, Some(&palm), fore_roll, 0.0);
        let rows = h.anat.report();
        let reading = |id: ReadingId| rows.iter().find(|r| r.id == id).unwrap().deg;
        [
            reading(ReadingId::Elevation),
            reading(ReadingId::Plane),
            reading(ReadingId::Rotation),
            reading(ReadingId::Elbow),
            reading(ReadingId::Forearm),
            reading(ReadingId::WristFlex),
            reading(ReadingId::WristDev),
        ]
    }

    const SCENARIOS: [(Side, f64, f64, bool); 8] = [
        (Side::L, 0.0, 1.0, false),
        (Side::R, 0.0, 0.01, false),
        (Side::L, 0.7, 0.01, false),
        (Side::R, 0.7, 1.0, false),
        (Side::L, 0.0, 0.01, true),
        (Side::R, 0.0, 1.0, true),
        (Side::L, 0.7, 1.0, true),
        (Side::R, 0.7, 0.01, true),
    ];

    #[test]
    fn round_trips_anatomical_dofs_through_the_bones() {
        for (side, yaw, scale, oblique) in SCENARIOS {
            let mut h = scenario(side, yaw, scale, oblique, None);
            let bones = bone_quaternions(&h);
            let out = forward(&POSE, &h);
            assert_eq!(bone_quaternions(&h), bones);

            close(out.u.length(), 1.0, 10);
            close(out.l.length(), 1.0, 10);
            close(out.h.length(), 1.0, 10);
            assert!(out.palm.dot(&out.h).abs() < EXACT);
            let mut palm = h.calibration.hand.palm;
            palm.apply_quaternion(&out.hand_world).normalize();
            assert!(palm.distance_to(&out.palm) < EXACT);
            let mut elbow = h.context.shoulder;
            elbow.add_scaled_vector(&out.u, h.context.upper_length);
            assert!(out.elbow.distance_to(&elbow) < EXACT * js_max(scale, 1.0));
            let mut wrist = out.elbow;
            wrist.add_scaled_vector(&out.l, h.context.lower_length);
            assert!(out.wrist.distance_to(&wrist) < EXACT * js_max(scale, 1.0));

            let r = measured(&mut h, side, &out, POSE.forearm_roll);
            let ceiling =
                elevation_ceiling(POSE.shoulder_plane, &JointTable::human().shoulder.elevation);
            close(r[0], POSE.shoulder_lift * ceiling.max / D, 5);
            close(r[1], POSE.shoulder_plane / D, 5);
            close(r[2], POSE.humeral_rotation / D, 5);
            close(r[3], POSE.elbow_flex / D, 5);
            close(r[4], POSE.forearm_roll / D, 5);
            close(r[5], POSE.wrist_flex / D, 5);
            close(r[6], POSE.wrist_dev / D, 5);
        }
    }

    #[test]
    fn captures_rest_axes_quaternions_palm_frame_and_hard_ranges_by_value() {
        let mut h = scenario(Side::L, 0.7, 1.0, true, Some(custom_joints()));
        let mut joints = custom_joints();
        let mut input = calibration_input(&mut h.graph, &h.profile, &h.anat, Side::L, &joints);
        let captured = capture_arm_calibration(&input).unwrap();
        let (axis, rest, palm) = (captured.upper.axis, captured.upper.rest, captured.hand.palm);
        let ceiling = captured.joints.shoulder.elevation[0][2];

        input.upper.axis.negate();
        input
            .upper
            .rest
            .set_from_axis_angle(&Vec3::new(1.0, 0.0, 0.0), 0.7);
        input.hand.palm.negate();
        joints.shoulder.elevation[0][2] = 170.0;

        assert_eq!(captured.upper.axis, axis);
        assert!(captured.upper.rest.angle_to(&rest) < EXACT);
        assert_eq!(captured.hand.palm, palm);
        assert_eq!(captured.joints.shoulder.elevation[0][2], ceiling);
    }

    #[test]
    fn rejects_wrist_hard_ranges_outside_the_exact_inverse_domain() {
        let mut h = scenario(Side::L, 0.0, 1.0, false, None);
        let joints = invalid_wrist_joints();
        let input = calibration_input(&mut h.graph, &h.profile, &h.anat, Side::L, &joints);
        assert_eq!(
            capture_arm_calibration(&input),
            Err(CalibrationRefusal::WristBeyondInverse)
        );
    }

    #[test]
    fn uses_one_avatar_ceiling_for_forward_placement_measurement_reporting_and_clamp() {
        let mut h = scenario(Side::R, 0.7, 0.01, true, Some(custom_joints()));
        let out = forward(
            &ArmConfiguration {
                shoulder_plane: 0.0,
                shoulder_lift: 1.0,
                ..POSE
            },
            &h,
        );
        let angle = acos(clamp(-out.u.dot(&h.context.up), -1.0, 1.0));
        close(angle, 60.0 * D, 10);

        let r = measured(&mut h, Side::R, &out, POSE.forearm_roll);
        close(r[0], 60.0, 8);
        let row = h.anat.report()[ReadingId::Elevation as usize];
        assert_eq!(row.id, ReadingId::Elevation);
        close(row.range[1], 60.0, 10);

        let mut u = h.context.up;
        u.multiply_scalar(-cos(80.0 * D))
            .add_scaled_vector(&h.context.right, sin(80.0 * D));
        let (mut l, mut hand) = (u, u);
        h.anat.clamp(Side::R, &mut u, &mut l, &mut hand, None);
        let clamped = h.anat.measure(Side::R, &u, &l, &hand, None, 0.0, 0.0);
        close(clamped.elevation, 60.0 * D, 10);
        close(
            h.anat.report()[ReadingId::Elevation as usize].range[1],
            60.0,
            10,
        );
    }

    #[test]
    fn keeps_arm_frames_and_calibration_inputs_independent() {
        let h = scenario(Side::R, 0.7, 1.0, false, None);
        let before = bone_quaternions(&h);
        let axis = h.calibration.upper.axis;
        let out = forward(&POSE, &h);
        assert_eq!(h.calibration.upper.axis, axis);
        assert_eq!(bone_quaternions(&h), before);
        assert!(out.palm.dot(&out.h).abs() < EXACT);
    }

    #[test]
    fn uses_continuous_scalar_angles_across_the_plane_seam_and_humeral_limits() {
        let mut h = scenario(Side::L, 0.7, 0.01, false, None);
        let seam: Vec<ArmForwardResult> = [-0.01, 0.0, 0.01]
            .iter()
            .map(|step| {
                forward(
                    &ArmConfiguration {
                        shoulder_plane: PI + step,
                        humeral_rotation: 0.35,
                        ..POSE
                    },
                    &h,
                )
            })
            .collect();
        assert!(seam[0].u.distance_to(&seam[1].u) < 0.02);
        assert!(seam[1].u.distance_to(&seam[2].u) < 0.02);

        let (start, end) = (-89.0 * D, 89.0 * D);
        let mut previous: Option<Vec3> = None;
        for index in 0..=180 {
            let humeral_rotation = start + ((end - start) * f64::from(index)) / 180.0;
            let out = forward(
                &ArmConfiguration {
                    humeral_rotation,
                    ..POSE
                },
                &h,
            );
            let m = h
                .anat
                .measure(Side::L, &out.u, &out.l, &out.h, Some(&out.palm), 0.0, 0.0);
            close(m.rotation, humeral_rotation, 8);
            assert!(m.rotation.abs() <= JointTable::human().shoulder.rotation.max[1]);
            if let Some(previous) = previous {
                assert!(out.l.distance_to(&previous) < 0.02);
            }
            previous = Some(out.l);
        }
    }

    #[test]
    fn clamps_each_configured_dof_to_its_existing_hard_range() {
        let mut h = scenario(Side::R, 0.0, 1.0, false, None);
        let request = ArmConfiguration {
            shoulder_plane: 0.0,
            shoulder_lift: 1.0,
            humeral_rotation: PI,
            elbow_flex: PI,
            forearm_roll: -PI,
            wrist_flex: PI,
            wrist_dev: -PI,
        };
        let mut bounded = ArmConfiguration::default();
        bound_arm_configuration(&request, &h.calibration, &mut bounded);
        let out = forward(&bounded, &h);
        let r = measured(&mut h, Side::R, &out, bounded.forearm_roll);
        let joints = JointTable::human();
        close(r[2], joints.shoulder.rotation.max[1] / D, 5);
        close(r[3], joints.elbow.flexion.max[1] / D, 5);
        close(r[4], joints.elbow.rotation.max[0] / D, 5);
        close(r[5], joints.wrist.flexion.max[1] / D, 5);
        close(r[6], joints.wrist.deviation.max[0] / D, 5);
    }

    #[test]
    fn keeps_raw_forward_requests_exact_and_clips_only_through_the_explicit_bounder() {
        let h = scenario(Side::R, 0.0, 1.0, false, None);
        let request = ArmConfiguration {
            shoulder_plane: 0.4,
            shoulder_lift: 1.1,
            humeral_rotation: 2.0,
            elbow_flex: 2.8,
            forearm_roll: 0.0,
            wrist_flex: 0.0,
            wrist_dev: 0.0,
        };
        let raw = forward(&request, &h);
        let mut bounded = ArmConfiguration::default();
        bound_arm_configuration(&request, &h.calibration, &mut bounded);
        let bounded_forward = forward(&bounded, &h);
        let joints = JointTable::human();
        assert_eq!(bounded.shoulder_lift, 1.0);
        assert_eq!(bounded.humeral_rotation, joints.shoulder.rotation.max[1]);
        assert_eq!(bounded.elbow_flex, joints.elbow.flexion.max[1]);
        assert!(raw.u.distance_to(&bounded_forward.u) > 0.1);
        assert!(raw.l.distance_to(&bounded_forward.l) > 0.1);
    }

    #[test]
    fn inverts_and_forwards_arm_directions() {
        for (side, yaw, scale, oblique) in SCENARIOS {
            let h = scenario(side, yaw, scale, oblique, None);
            let source = forward(&POSE, &h);
            let mut recovered = ArmConfiguration::default();
            assert!(configuration_of_directions(
                &directions_of(&source),
                Some(&source.palm),
                &h.calibration,
                &h.context,
                None,
                &mut recovered,
            ));
            let want = [
                POSE.shoulder_plane,
                POSE.shoulder_lift,
                POSE.humeral_rotation,
                POSE.elbow_flex,
                POSE.forearm_roll,
                POSE.wrist_flex,
                POSE.wrist_dev,
            ];
            let got = [
                recovered.shoulder_plane,
                recovered.shoulder_lift,
                recovered.humeral_rotation,
                recovered.elbow_flex,
                recovered.forearm_roll,
                recovered.wrist_flex,
                recovered.wrist_dev,
            ];
            for (g, w) in got.iter().zip(want) {
                close(*g, w, 7);
            }
            let result = forward(&recovered, &h);
            assert!(result.u.distance_to(&source.u) < EXACT);
            assert!(result.l.distance_to(&source.l) < EXACT);
            assert!(result.h.distance_to(&source.h) < EXACT);
            assert!(result.palm.distance_to(&source.palm) < EXACT);
        }
    }

    #[test]
    fn unwraps_the_shoulder_plane_near_the_previous_value_across_its_seam() {
        let h = scenario(Side::L, 0.7, 1.0, false, None);
        let source = forward(
            &ArmConfiguration {
                shoulder_plane: -PI + 0.01,
                ..POSE
            },
            &h,
        );
        let mut recovered = ArmConfiguration::default();
        assert!(configuration_of_directions(
            &directions_of(&source),
            Some(&source.palm),
            &h.calibration,
            &h.context,
            Some(&ArmConfiguration {
                shoulder_plane: PI - 0.01,
                ..POSE
            }),
            &mut recovered,
        ));
        close(recovered.shoulder_plane, PI + 0.01, 7);
    }

    #[test]
    fn preserves_prior_pronation_when_the_palm_is_genuinely_unconstrained() {
        let h = scenario(Side::R, 0.7, 1.0, true, None);
        let source = forward(&POSE, &h);
        let previous = ArmConfiguration {
            forearm_roll: 0.73,
            ..POSE
        };
        let mut recovered = ArmConfiguration::default();
        assert!(configuration_of_directions(
            &directions_of(&source),
            None,
            &h.calibration,
            &h.context,
            Some(&previous),
            &mut recovered,
        ));
        assert_eq!(recovered.forearm_roll, previous.forearm_roll);
        let result = forward(&recovered, &h);
        assert!(result.h.distance_to(&source.h) < EXACT);
    }

    #[test]
    fn uses_equivalent_pronation_only_when_it_remains_inside_the_physical_range() {
        for allow_multiple_turns in [false, true] {
            let joints = allow_multiple_turns.then(wide_roll_joints);
            let h = scenario(Side::R, 0.0, 1.0, false, joints);
            let source = forward(
                &ArmConfiguration {
                    forearm_roll: 0.3,
                    ..POSE
                },
                &h,
            );
            let mut recovered = ArmConfiguration::default();
            assert!(configuration_of_directions(
                &directions_of(&source),
                Some(&source.palm),
                &h.calibration,
                &h.context,
                Some(&ArmConfiguration {
                    forearm_roll: PI * 2.0 + 0.3,
                    ..POSE
                }),
                &mut recovered,
            ));
            let want = if allow_multiple_turns {
                PI * 2.0 + 0.3
            } else {
                0.3
            };
            close(recovered.forearm_roll, want, 7);
        }
    }

    #[test]
    fn returns_false_for_degenerate_directions_palm_projections_and_calibration_frames() {
        let mut h = scenario(Side::L, 0.0, 1.0, false, None);
        let source = forward(&POSE, &h);
        let mut output = ArmConfiguration::default();
        let mut inverse =
            |d: ArmDirections, palm: Vec3, c: &ArmCalibration, x: &ArmForwardContext| {
                configuration_of_directions(&d, Some(&palm), c, x, None, &mut output)
            };
        let d = directions_of(&source);
        assert!(!inverse(
            ArmDirections {
                upper_arm: Vec3::default(),
                ..d
            },
            source.palm,
            &h.calibration,
            &h.context
        ));
        assert!(!inverse(d, source.l, &h.calibration, &h.context));
        let mut back = source.l;
        back.negate();
        assert!(!inverse(
            ArmDirections { hand: back, ..d },
            source.palm,
            &h.calibration,
            &h.context
        ));
        assert!(!inverse(
            d,
            source.palm,
            &h.calibration,
            &ArmForwardContext {
                up: Vec3::default(),
                ..h.context
            }
        ));
        h.calibration.upper.axis.set(0.0, 0.0, 0.0);
        assert!(!inverse(d, source.palm, &h.calibration, &h.context));
    }

    #[test]
    fn retains_out_of_range_anatomical_angles_rather_than_clamping_the_inverse() {
        let h = scenario(Side::R, 0.7, 1.0, false, None);
        let (plane, elevation) = (PI / 2.0, 3.1);
        let lateral = h.context.right;
        let mut upper_arm = h.context.up;
        upper_arm
            .multiply_scalar(-cos(elevation))
            .add_scaled_vector(&lateral, sin(elevation) * cos(plane))
            .add_scaled_vector(&h.context.forward, sin(elevation) * sin(plane))
            .normalize();
        let (mut reference, mut perp) = (Vec3::default(), Vec3::default());
        humeral_reference(
            &upper_arm,
            &h.context.up,
            &h.context.forward,
            &mut reference,
        );
        lateral_reference(
            &upper_arm,
            &reference,
            &h.context.up,
            &h.context.forward,
            &lateral,
            &mut perp,
        );
        let mut bend = reference;
        bend.multiply_scalar(cos(2.0))
            .add_scaled_vector(&perp, sin(2.0))
            .normalize();
        let mut lower_arm = upper_arm;
        lower_arm
            .multiply_scalar(cos(2.8))
            .add_scaled_vector(&bend, sin(2.8))
            .normalize();
        let mut palm = h.context.forward;
        palm.add_scaled_vector(&lower_arm, -h.context.forward.dot(&lower_arm));
        if palm.length_sq() < 1e-10 {
            palm.copy(&h.context.right)
                .add_scaled_vector(&lower_arm, -h.context.right.dot(&lower_arm));
        }
        palm.normalize();
        let mut recovered = ArmConfiguration::default();
        assert!(configuration_of_directions(
            &ArmDirections {
                upper_arm,
                lower_arm,
                hand: lower_arm,
            },
            Some(&palm),
            &h.calibration,
            &h.context,
            None,
            &mut recovered,
        ));
        assert!(recovered.shoulder_lift > 1.0);
        close(recovered.humeral_rotation, 2.0, 7);
        close(recovered.elbow_flex, 2.8, 7);
    }

    /// A hand and palm `flex` and `deviation` past the neutral wrist of `base`, as FK bends one.
    fn bent_wrist(
        base: &ArmForwardResult,
        radial_sign: f64,
        flex: f64,
        deviation: f64,
    ) -> (Vec3, Vec3) {
        let angle = hypot(&[flex, deviation]);
        let mut radial = Vec3::default();
        radial
            .cross_vectors(&base.palm, &base.l)
            .multiply_scalar(radial_sign)
            .normalize();
        let mut swing = base.palm;
        swing
            .multiply_scalar(flex / angle)
            .add_scaled_vector(&radial, deviation / angle);
        let mut hand = base.l;
        hand.multiply_scalar(cos(angle))
            .add_scaled_vector(&swing, sin(angle))
            .normalize();
        let mut palm = base.palm;
        palm.multiply_scalar(cos(angle))
            .add_scaled_vector(&base.l, (-sin(angle) * flex) / angle)
            .normalize();
        (hand, palm)
    }

    #[test]
    fn recovers_wrist_requests_beyond_hard_stops_without_clipping_them() {
        let h = scenario(Side::R, 0.7, 1.0, false, None);
        let base = forward(
            &ArmConfiguration {
                wrist_flex: 0.0,
                wrist_dev: 0.0,
                ..POSE
            },
            &h,
        );
        let (hand, palm) = bent_wrist(&base, h.calibration.radial_sign, 1.7, 0.5);
        let mut recovered = ArmConfiguration::default();
        assert!(configuration_of_directions(
            &ArmDirections {
                upper_arm: base.u,
                lower_arm: base.l,
                hand,
            },
            Some(&palm),
            &h.calibration,
            &h.context,
            Some(&POSE),
            &mut recovered,
        ));
        close(recovered.wrist_flex, 1.7, 7);
        close(recovered.wrist_dev, 0.5, 7);
    }

    /// `arm-palm-transport.test.ts`'s scenario: the left arm at unit scale, the right in
    /// centimetres, the root turned for a negative deviation.
    fn transport(
        side: Side,
        flex: f64,
        deviation: f64,
    ) -> (Scenario, ArmConfiguration, ArmForwardResult) {
        let h = scenario(
            side,
            if deviation < 0.0 { 0.7 } else { 0.0 },
            if side == Side::L { 1.0 } else { 0.01 },
            false,
            None,
        );
        let configuration = ArmConfiguration {
            forearm_roll: 0.0,
            wrist_flex: flex,
            wrist_dev: deviation,
            ..POSE
        };
        let f = forward(&configuration, &h);
        (h, configuration, f)
    }

    #[test]
    fn recovers_a_mixed_wrist_palm_turned_about_the_hand_axis() {
        // The palm a partial weight leaves between the FK palm and one turned about the hand,
        // which `ArmDriver.composeRequest` hands the inverse.
        for (side, deviation) in [
            (Side::L, PI / 6.0),
            (Side::R, PI / 6.0),
            (Side::L, -PI / 6.0),
            (Side::R, -PI / 6.0),
        ] {
            let (h, configuration, f) = transport(side, PI / 3.0, deviation);
            let mut weighted = f.palm;
            weighted.apply_axis_angle(&f.h, 0.4 * 0.25);
            let mut recovered = configuration;
            assert!(configuration_of_directions(
                &directions_of(&f),
                Some(&weighted),
                &h.calibration,
                &h.context,
                Some(&configuration),
                &mut recovered,
            ));
            let rebuilt = forward(&recovered, &h);
            assert!(rebuilt.h.distance_to(&f.h) < EXACT);
            assert!(rebuilt.palm.distance_to(&weighted) < EXACT);
        }
    }

    #[test]
    fn keeps_the_canonical_endpoint_actual_hand_and_fingers_consistent() {
        for side in SIDES {
            let (mut h, _, f) = transport(side, PI / 3.0, -PI / 6.0);
            let rest = rest_table(&h.graph);
            let p = h.profile.clone();
            let joints = JointTable::human();
            let hands = Hands::new(&p, &mut h.graph);
            let hand = bone(&p, slot(ArmSlot::Hand, side));
            let metric_scale = h.graph.world_scale(hand).x;
            let restq = rest_of(&rest);
            let geometry = capture_hand_geometry(
                &p,
                &h.graph,
                side,
                &|i| Some(restq(i)),
                &hands.fingers,
                &joints,
                metric_scale,
            );
            let curls = [Some(0.2), Some(0.4), Some(0.6), Some(0.3), Some(0.5)];
            let spread = [None, Some(0.2), None, Some(-0.1), None];

            // Stage the FK pose on the bones, as `Rig.stageArmForward` does.
            for (s, q) in [
                (ArmSlot::UpperArm, f.upper_local),
                (ArmSlot::LowerArm, f.lower_local),
                (ArmSlot::Hand, f.hand_local),
            ] {
                h.graph.set_local_quaternion(bone(&p, slot(s, side)), &q);
            }
            hands.curl_hand(&p, &joints, &mut h.graph, &restq, side, &curls, &spread);
            h.graph.update_matrix_world(0, true);

            let world = h.graph.world_quaternion(hand);
            let mut palm = hands.palm_local()[side as usize].unwrap();
            palm.apply_quaternion(&world);
            assert!(palm.distance_to(&f.palm) < EXACT);
            let mut axis = p.rest_dir[slot(ArmSlot::Hand, side) as usize].unwrap();
            axis.apply_quaternion(&world);
            assert!(axis.distance_to(&f.h) < EXACT);
            assert!(h.graph.world_position(hand).distance_to(&f.wrist) < EXACT);

            let mut sample = make_hand_geometry_sample(&geometry);
            sample_hand_geometry(&geometry, &curls, &spread, &mut sample);
            assert!(!sample.points.is_empty());
            for point in &sample.points {
                let chain = p.finger(point.finger, side);
                let mut actual = h.graph.world_position(chain[point.joint_index]);
                if point.tip {
                    let previous = h.graph.world_position(chain[point.joint_index - 1]);
                    let mut d = actual;
                    d.sub(&previous);
                    actual.add_scaled_vector(&d, FINGER_TIP_EXTENSION);
                }
                let mut predicted = point.position;
                predicted.apply_quaternion(&f.hand_world).add(&f.wrist);
                assert!(
                    actual.distance_to(&predicted) < EXACT,
                    "{:?}.{}.{}",
                    point.finger,
                    point.joint_index,
                    point.tip
                );
            }
        }
    }

    // --- corpora ---

    fn vec3(s: &[f64]) -> Vec3 {
        Vec3::new(s[0], s[1], s[2])
    }

    fn quat(s: &[f64]) -> Quat {
        Quat::new(s[0], s[1], s[2], s[3])
    }

    fn pair(s: &[f64]) -> [f64; 2] {
        [s[0], s[1]]
    }

    fn bits(values: &[f64]) -> Vec<u64> {
        values.iter().map(|v| v.to_bits()).collect()
    }

    fn dof(case: &Case, at: &str) -> JointDof {
        JointDof {
            free: pair(case.input(&format!("{at}.free"))),
            max: pair(case.input(&format!("{at}.max"))),
        }
    }

    /// The recorded `calibration` argument.
    fn calibration_of(case: &Case) -> ArmCalibration {
        let j = |joint: &str, d: &str| dof(case, &format!("calibration.joints.{joint}.dofs.{d}"));
        let rows = case.scalar("calibration.joints.shoulder.elevation.len", false) as usize;
        let digit = |joint: &str| crate::anatomy::joints::Digit {
            proximal: Some(j(joint, "proximal")),
            intermediate: Some(j(joint, "intermediate")),
            distal: Some(j(joint, "distal")),
        };
        let turns = |joint: &str| crate::anatomy::joints::Turns {
            pitch: j(joint, "pitch"),
            yaw: j(joint, "yaw"),
            roll: j(joint, "roll"),
        };
        let joints = JointTable {
            shoulder: crate::anatomy::joints::Shoulder {
                elevation: (0..rows)
                    .map(|i| {
                        let r = case.input(&format!("calibration.joints.shoulder.elevation[{i}]"));
                        [r[0], r[1], r[2]]
                    })
                    .collect(),
                rotation: j("shoulder", "rotation"),
            },
            elbow: crate::anatomy::joints::Elbow {
                flexion: j("elbow", "flexion"),
                rotation: j("elbow", "rotation"),
            },
            wrist: crate::anatomy::joints::Wrist {
                flexion: j("wrist", "flexion"),
                deviation: j("wrist", "deviation"),
            },
            finger: digit("finger"),
            thumb: digit("thumb"),
            neck: turns("neck"),
            spine: turns("spine"),
        };
        ArmCalibration {
            upper: UpperCalibration {
                axis: vec3(case.input("calibration.upper.axis")),
                rest: quat(case.input("calibration.upper.rest")),
                front: vec3(case.input("calibration.upper.front")),
            },
            lower: BoneCalibration {
                axis: vec3(case.input("calibration.lower.axis")),
                rest: quat(case.input("calibration.lower.rest")),
            },
            hand: HandCalibration {
                axis: vec3(case.input("calibration.hand.axis")),
                rest: quat(case.input("calibration.hand.rest")),
                palm: vec3(case.input("calibration.hand.palm")),
            },
            radial_sign: case.scalar("calibration.radialSign", false),
            joints,
        }
    }

    fn context_of(case: &Case) -> ArmForwardContext {
        ArmForwardContext {
            side: Side::BOTH[case.scalar("context.side", false) as usize],
            shoulder: vec3(case.input("context.shoulder")),
            upper_length: case.scalar("context.upperLength", false),
            lower_length: case.scalar("context.lowerLength", false),
            up: vec3(case.input("context.up")),
            right: vec3(case.input("context.right")),
            forward: vec3(case.input("context.forward")),
            upper_parent_world: quat(case.input("context.upperParentWorld")),
        }
    }

    const FIELDS: [&str; 7] = [
        "shoulderPlane",
        "shoulderLift",
        "humeralRotation",
        "elbowFlex",
        "forearmRoll",
        "wristFlex",
        "wristDev",
    ];

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

    fn configuration_bits(c: &ArmConfiguration) -> Vec<u64> {
        bits(&[
            c.shoulder_plane,
            c.shoulder_lift,
            c.humeral_rotation,
            c.elbow_flex,
            c.forearm_roll,
            c.wrist_flex,
            c.wrist_dev,
        ])
    }

    #[test]
    fn forward_arm_replays_its_corpus_bit_for_bit() {
        let corpus = Corpus::load("forwardArm");
        for case in corpus.iter() {
            let mut out = ArmForwardResult::default();
            forward_arm(
                &configuration_in(&case, "configuration"),
                &calibration_of(&case),
                &context_of(&case),
                &mut out,
            );
            for at in ["return", "out"] {
                let v = |k: &str| bits(case.output(&format!("{at}.{k}")));
                assert_eq!(bits(&[out.u.x, out.u.y, out.u.z]), v("u"));
                assert_eq!(bits(&[out.l.x, out.l.y, out.l.z]), v("l"));
                assert_eq!(bits(&[out.h.x, out.h.y, out.h.z]), v("h"));
                assert_eq!(bits(&[out.palm.x, out.palm.y, out.palm.z]), v("palm"));
                assert_eq!(bits(&[out.elbow.x, out.elbow.y, out.elbow.z]), v("elbow"));
                assert_eq!(bits(&[out.wrist.x, out.wrist.y, out.wrist.z]), v("wrist"));
                for (q, k) in [
                    (out.upper_world, "upperWorld"),
                    (out.lower_world, "lowerWorld"),
                    (out.hand_world, "handWorld"),
                    (out.upper_local, "upperLocal"),
                    (out.lower_local, "lowerLocal"),
                    (out.hand_local, "handLocal"),
                ] {
                    assert_eq!(bits(&[q.x, q.y, q.z, q.w]), v(k), "{k}");
                }
            }
        }
    }

    #[test]
    fn configuration_of_directions_replays_its_corpus_bit_for_bit() {
        let corpus = Corpus::load("configurationOfDirections");
        let mut failed = 0;
        for case in corpus.iter() {
            let palm =
                (case.scalar("palm.present", false) == 1.0).then(|| vec3(case.input("palm")));
            let previous = (case.scalar("previous.present", false) == 1.0)
                .then(|| configuration_in(&case, "previous"));
            let mut out = configuration_in(&case, "out");
            let ok = configuration_of_directions(
                &ArmDirections {
                    upper_arm: vec3(case.input("directions.upperArm")),
                    lower_arm: vec3(case.input("directions.lowerArm")),
                    hand: vec3(case.input("directions.hand")),
                },
                palm.as_ref(),
                &calibration_of(&case),
                &context_of(&case),
                previous.as_ref(),
                &mut out,
            );
            assert_eq!(f64::from(u8::from(ok)), case.scalar("return", true));
            failed += usize::from(!ok);
            let want: Vec<u64> = FIELDS
                .iter()
                .map(|k| case.scalar(&format!("out.{k}"), true).to_bits())
                .collect();
            assert_eq!(configuration_bits(&out), want);
        }
        assert!(failed < corpus.cases());
    }
}
