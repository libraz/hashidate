//! The rig, ported from `src/engine/rig/`: one module per TS file, and `rig.ts`'s `Rig` here.
//!
//! The TS `Rig` holds the profile and reaches the scene through its bones; this one owns the
//! numeric profile and its collaborators, and takes the [`Graph`] with every call that reads or
//! writes a node. Every update the TS makes is made here, in the same order. Its per-side records
//! are fixed arrays, so a frame allocates nothing: the TS allocations (the leg set of
//! `transportTopologySupported`, the clavicle clone of `tryStaticAimArm`, the curl spread of
//! `curlFinger`) are stack values, and `measure` returns the readings' numbers while the labels
//! stay in TS. The constrained driver's environment is always the native one, so the TS checks
//! that it was not replaced reduce to the driver being present. A side commit is passed by value
//! (`ArmFrameSideCommit`), carrying the two fields of the plan output the commit reads; a refusal
//! the TS throws or reports as text is a code. `lastAcceptedHandPose` is the capture scratch,
//! as in TS, flagged present when the last capture succeeded.

pub mod arm_chain;
pub mod arm_configuration;
pub mod arm_driver;
pub mod arm_path;
pub mod arm_qp;
pub mod arm_route;
pub mod arm_twists;
pub mod elbow;
pub mod finger_axes;
pub mod finger_clearance;
pub mod girdle;
pub mod hand_geometry;
pub mod hands;
pub mod legs;
pub mod point;
pub mod reach;
pub mod skeleton;
pub mod spine;

use crate::anatomy::arm::ArmAnatomy;
use crate::anatomy::cost::Reading;
use crate::anatomy::joints::{FINGER_WIDTH, HAND_CONTACT, JointTable};
use crate::math::f::{hypot3, js_max};
use crate::math::{Mat3, Mat4, Quat, Vec3, clamp, lerp};
use crate::profile::{ArmSlot, BoneSlot, Finger, Profile, Side};
use crate::scene::graph::{Graph, NO_NODE, Parent};
use arm_chain::{ArmChain, ArmChainPort};
use arm_configuration::{ArmConfiguration, ArmForwardContext, ArmForwardResult};
use arm_driver::{
    ArmDriver, ArmDriverAcceptedSnapshot, DriverInput, DriverOutput, DriverRefusal,
    FRAME_TOLERANCE, positive_conformal_scale,
};
use arm_path::plan::ArmPathStatus;
use arm_twists::ArmTwists;
use elbow::{ElbowContext, ElbowSearch};
use finger_axes::FingerAxes;
use finger_clearance::{FingerClearance, FingerRig, hand_frame};
use girdle::ShoulderGirdle;
use hand_geometry::{
    HandContact, HandContactCalibration, HandGeometrySample, capture_hand_contact_geometry,
    make_hand_geometry_sample, sample_hand_contact, sample_hand_geometry,
};
use hands::{FingerSpec, Hands};
use legs::GroundedLegs;
use point::{PointRequest, PointSolver};
use reach::{ArmSolution, ReachLinks, length, solve_reach};
use skeleton::SkeletonRefresh;
use spine::{OffsetSlot, SpineOffsets};

/// The avatar's root, the first node of the table.
const ROOT: u32 = 0;

/// The bones the body snapshot holds, in the TS `BODY_SNAPSHOT_SLOTS` order.
const BODY_SNAPSHOT_SLOTS: [BoneSlot; 7] = [
    BoneSlot::Hips,
    BoneSlot::Spine,
    BoneSlot::Chest,
    BoneSlot::Neck,
    BoneSlot::Head,
    BoneSlot::ShoulderL,
    BoneSlot::ShoulderR,
];

/// The links below the clavicle, in [`ArmSlot`] order.
const ARM_LINKS: [ArmSlot; 3] = [ArmSlot::UpperArm, ArmSlot::LowerArm, ArmSlot::Hand];

/// The small body context reconstructed for each arm feasibility sample.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RigBodyPoseSnapshot {
    /// Per `BODY_SNAPSHOT_SLOTS`: present where that bone was resolved at construction.
    pub slots: [Option<Quat>; 7],
    pub hips_position: Vec3,
    /// Signed authored jump translation; the foot solver clamps its anchor lift.
    pub rise: f64,
    /// Radians about world up the skeleton is turned; the slots hold the pre-turn pelvis.
    pub turn: f64,
}

/// One side of `commitArmFrame`. Of the TS plan output the commit reads `q` and `forward` only,
/// and those two are what it carries.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArmFrameSideCommit {
    pub q: [f64; 7],
    pub forward: ArmForwardResult,
    pub context: ArmForwardContext,
    pub curls: FingerSpec,
    pub spread: FingerSpec,
}

/// One side of the default pose Body may install before its first frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StandingArmPose {
    pub shoulder: Vec3,
    pub upper_arm: Vec3,
    pub lower_arm: Vec3,
    pub hand: Vec3,
    pub palm: Vec3,
    pub curls: FingerSpec,
    pub spread: FingerSpec,
}

/// The last displayed arm frame, in the character coordinates Body follows.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AcceptedArmState {
    /// Per [`ArmSlot`].
    pub directions: [[f64; 3]; 4],
    pub palm: [f64; 3],
    /// Per [`Finger`].
    pub curls: [f64; 5],
    pub spread: [f64; 5],
    pub forearm_roll: f64,
}

/// `HandSensePose` as the rig captures it, every field written.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HandSensePose {
    pub knuckle: Vec3,
    pub palm: Vec3,
    pub forearm: Vec3,
    pub index: Vec3,
    pub little: Vec3,
}

/// One side's hand-contact prediction: what `predictHandContact` lends out.
#[derive(Clone, Debug, PartialEq)]
pub struct ContactPrediction {
    pub calibration: HandContactCalibration,
    /// The TS `shape` is its points' positions.
    pub sample: HandGeometrySample,
    pub contact: Vec3,
    pub bind_frame: Mat3,
}

/// Why one side's constrained arm solver is off; the TS line is `${side}: ${reason}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArmSolverOffReason {
    /// "no palm frame (fingers unresolved)"
    NoPalmFrame,
    /// The driver's own refusal.
    Refused(DriverRefusal),
    /// "rest arm pose unreadable"
    RestPoseUnreadable,
    /// "rest arm pose outside the calibrated model"
    RestPoseOutsideModel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArmSolverOff {
    pub side: Side,
    pub reason: ArmSolverOffReason,
}

/// Why turning the limits back on refused. The TS throws "Could not restore a feasible arm
/// pose; anatomical limits remain disabled."
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitsRefusal {
    NoFeasiblePose,
}

/// The world frames one side's calibration was captured in, with their scales.
#[derive(Clone, Copy, Debug)]
struct ArmFrameSnapshot {
    carriers: [(Parent, f64); 6],
    len: usize,
    valid: bool,
}

impl Default for ArmFrameSnapshot {
    fn default() -> Self {
        ArmFrameSnapshot {
            carriers: [(Parent::Node(ROOT), 0.0); 6],
            len: 0,
            valid: false,
        }
    }
}

/// The pelvis around the last plant: what it was handed and what the plant left.
#[derive(Clone, Copy, Debug, Default)]
struct PlantRecord {
    pre_plant_hips: Vec3,
    post_plant_hips: Vec3,
    pre_turn_hips_q: Quat,
    post_turn_hips_q: Quat,
}

/// How often the rig refreshed the scene: full passes over the root (its own and the one
/// `GroundedLegs.apply` starts with) and `SkeletonRefresh.run`s standing in for one.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RigPasses {
    pub full: usize,
    pub skeleton: usize,
}

/// One `ArmTwists` call the rig made: `accept` or `stage`, and the side.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TwistCall {
    Accept(Side),
    Stage(Side),
}

/// `restOf`: the rest orientation captured at construction. Every bone that reaches here came
/// out of the profile, so the table always has it; the identity stands in otherwise.
fn rest_quat(rest: &[Option<Quat>], bone: u32) -> Quat {
    rest[bone as usize].unwrap_or_default()
}

/// A full finger record as the `FingerSpec` the TS passes it as.
fn spec_of(values: &[f64; 5]) -> FingerSpec {
    values.map(Some)
}

fn rest_dir(p: &Profile, slot: BoneSlot) -> Vec3 {
    p.rest_dir[slot as usize].expect("a resolved bone has a rest direction")
}

// rig.ts Rig.fingerClearance
//
// How far off the skin a finger's bones are held: half its thickness, from the knuckle pitch.
fn finger_clearance(p: &Profile, side: Side) -> f64 {
    0.5 * FINGER_WIDTH * p.limb[side as usize].pitch.unwrap_or(0.0)
}

// rig.ts Rig.armContext
//
// Give the anatomy model this arm's origin and segment lengths, so it can
// place the arm instead of only pointing it. Needed for the torso clearance,
// which is a question about positions — and about the whole arm, not just the
// elbow: reaching across the body puts both ends of the arm outside the trunk
// and the middle of it inside.
fn arm_context(p: &Profile, graph: &mut Graph, anat: &mut ArmAnatomy, side: Side) -> bool {
    let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side));
    let limb = &p.limb[side as usize];
    let (Some(upper), Some(la)) = (upper, length(limb.upper)) else {
        anat.clear_arm();
        return false;
    };
    graph.update_world_matrix(upper, true, false, false);
    // The hand's collision proxy runs from the wrist to where the hand *touches*
    // — half its length, the middle of the palm — and stops there.
    //
    // It has to stop there, and the number has to be the same one the motion
    // layer backs the wrist off by. A reach places the palm on its anchor, and
    // the anchor is a point on the skin; test any further down the hand and the
    // samples past the contact point are inside the body *by construction*.
    // Testing 60% against a 50% back-off did exactly that, and left the poses
    // that touch the face reading 24 to 43 percent buried with the arm itself
    // completely clear.
    let s = graph.world_position(upper);
    anat.set_arm(
        &s,
        la,
        limb.lower.unwrap_or(0.0),
        limb.tip[Finger::Middle as usize].unwrap_or(0.0) * HAND_CONTACT,
    );
    true
}

// rig.ts Rig.constructor, the humeral front: the humerus's front at rest, in its own space, the
// way the elbow folds.
fn measure_humeral_front(p: &Profile, graph: &mut Graph, side: Side) -> Option<Vec3> {
    let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side))?;
    let chest = p.chest()?;
    let body = p.body?;
    graph.update_world_matrix(upper, true, false, false);
    let mut q = graph.world_quaternion(upper);
    let mut along = rest_dir(p, BoneSlot::arm(ArmSlot::UpperArm, side));
    along.apply_quaternion(&q);
    let mut front = body.forward;
    front.apply_quaternion(&graph.world_quaternion(chest));
    let d = -front.dot(&along);
    front.add_scaled_vector(&along, d);
    if front.length_sq() <= 1e-8 {
        return None;
    }
    q.invert();
    Some(*front.normalize().apply_quaternion(&q))
}

// rig.ts Rig.captureArmFrameMetrics, for one side
fn capture_arm_frame_metrics(p: &Profile, graph: &mut Graph, side: Side) -> ArmFrameSnapshot {
    let mut snapshot = ArmFrameSnapshot::default();
    let chest = p.chest();
    let head = p.bone(BoneSlot::Head).or_else(|| p.bone(BoneSlot::Neck));
    let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side));
    let lower = p.bone(BoneSlot::arm(ArmSlot::LowerArm, side));
    let hand = p.bone(BoneSlot::arm(ArmSlot::Hand, side));
    let parent = upper.and_then(|u| graph.three_parent_of(u));
    let (Some(parent), Some(upper), Some(lower), Some(hand)) = (parent, upper, lower, hand) else {
        return snapshot;
    };
    let node = |b: Option<u32>| b.map(Parent::Node);
    for object in [
        Some(parent),
        node(Some(upper)),
        node(Some(lower)),
        node(Some(hand)),
        node(chest),
        node(head),
    ] {
        let Some(object) = object else {
            continue;
        };
        if snapshot.carriers[..snapshot.len]
            .iter()
            .any(|&(o, _)| o == object)
        {
            continue;
        }
        graph.update_parent_world(object);
        let Some(scale) = positive_conformal_scale(&graph.current_parent_world(object)) else {
            snapshot.valid = false;
            snapshot.len = 0;
            break;
        };
        snapshot.carriers[snapshot.len] = (object, scale);
        snapshot.len += 1;
    }
    snapshot.valid = snapshot.len > 0;
    snapshot
}

// rig.ts Rig.makeArmContext
fn make_arm_context(side: Side) -> ArmForwardContext {
    ArmForwardContext {
        side,
        shoulder: Vec3::default(),
        upper_length: 0.0,
        lower_length: 0.0,
        up: Vec3::default(),
        right: Vec3::default(),
        forward: Vec3::default(),
        upper_parent_world: Quat::default(),
    }
}

// rig.ts Rig.makeBodyPoseSnapshot
fn make_body_pose_snapshot(p: &Profile) -> RigBodyPoseSnapshot {
    RigBodyPoseSnapshot {
        slots: BODY_SNAPSHOT_SLOTS.map(|slot| p.bone(slot).map(|_| Quat::default())),
        ..RigBodyPoseSnapshot::default()
    }
}

// rig.ts Rig.transportUp
//
// World-up metres expressed in the actual hips parent's local frame.
fn transport_up(p: &Profile, graph: &mut Graph) -> Vec3 {
    let mut up = Vec3::new(0.0, 1.0, 0.0);
    if let Some(parent) = p
        .bone(BoneSlot::Hips)
        .and_then(|h| graph.three_parent_of(h))
    {
        graph.update_parent_world(parent);
        let mut inverse = Mat3::default();
        inverse
            .set_from_matrix4(&graph.current_parent_world(parent))
            .invert();
        up.apply_matrix3(&inverse);
    }
    up
}

// rig.ts Rig.captureBodyPose
fn capture_body_pose(
    p: &Profile,
    graph: &mut Graph,
    plant: &PlantRecord,
    out: &mut RigBodyPoseSnapshot,
    rise: f64,
    turn: f64,
) {
    for (k, &slot) in BODY_SNAPSHOT_SLOTS.iter().enumerate() {
        if let (Some(bone), Some(target)) = (p.bone(slot), out.slots[k].as_mut()) {
            *target = graph.local_quaternion(bone);
        }
    }
    out.rise = rise;
    out.turn = turn;
    if let Some(hips) = p.bone(BoneSlot::Hips) {
        // Same for the yaw: the snapshot keeps the pelvis as posed, so replaying
        // the turn does not turn an already-turned pelvis again.
        if out.slots[0].is_some() && graph.local_quaternion(hips).equals(&plant.post_turn_hips_q) {
            out.slots[0] = Some(plant.pre_turn_hips_q);
        }
        // Contact may have corrected the pelvis. Preserve its authored input so
        // retries do not feed a previous leg correction back into the next one.
        let position = graph.local_position(hips);
        out.hips_position = if position.equals(&plant.post_plant_hips) {
            plant.pre_plant_hips
        } else {
            position
        };
        let up = transport_up(p, graph);
        out.hips_position.add_scaled_vector(&up, -out.rise);
    }
}

// rig.ts Rig.writeWorldRotation
fn write_world_rotation(graph: &mut Graph, bone: u32, world: &Quat) {
    match graph.three_parent_of(bone) {
        Some(parent) => {
            graph.update_parent_world(parent);
            let mut local = graph.parent_world_quaternion(parent);
            local.invert().multiply(world);
            graph.set_local_quaternion(bone, &local);
        }
        None => graph.set_local_quaternion(bone, world),
    }
    graph.update_world_matrix(bone, false, true, false);
}

// rig.ts Rig.toAcceptedCharacter
fn to_accepted_character(
    anat: &mut ArmAnatomy,
    graph: &mut Graph,
    p: &Profile,
    out: &mut [f64; 3],
    value: &Vec3,
    side: Side,
) {
    if anat.update(graph) {
        let lateral = if side == Side::R { 1.0 } else { -1.0 };
        out[0] = value.dot(anat.right()) * lateral;
        out[1] = value.dot(anat.up());
        out[2] = value.dot(anat.fwd());
    } else {
        let lateral = if side == Side::L {
            p.side_sign
        } else {
            -p.side_sign
        };
        out[0] = value.x * lateral;
        out[1] = value.y;
        out[2] = value.z;
    }
    let length = hypot3(out[0], out[1], out[2]);
    if length > 1e-12 {
        out[0] /= length;
        out[1] /= length;
        out[2] /= length;
    }
}

// rig.ts Rig.staticPlan
//
// Plan the static request from the accepted pose; the plan is the driver's `output`.
fn static_plan(
    driver: &mut ArmDriver,
    anat: &mut ArmAnatomy,
    context: &ArmForwardContext,
    links: &[Vec3; 3],
) -> bool {
    let palm = driver.request.palm;
    if !driver.configuration_from_pose(context, &links[0], &links[1], &links[2], palm.as_ref()) {
        return false;
    }
    let start = driver.accepted_q;
    let status = driver.plan_from(anat, &start, context, 0.0, false).status;
    if matches!(status, ArmPathStatus::Progress | ArmPathStatus::Settled) {
        return true;
    }
    // A static pose has no temporal path promise; if the optimization cannot
    // move, or stops short at a box minimum, test the exact inverse request as
    // a complete endpoint.
    let target = driver.target_q;
    driver.restore_endpoint_from(anat, &target, context, 0.0, false)
}

/// The rig's side of `ArmChain`: its clock, limiter switch, rest map, roll tables and helpers.
struct RigChainPort<'a> {
    p: &'a Profile,
    rest: &'a [Option<Quat>],
    dt: f64,
    limits: bool,
    fore_roll: &'a mut [f64; 2],
    upper_roll: &'a mut [f64; 2],
    twists: Option<&'a mut ArmTwists>,
    #[cfg(test)]
    twist_calls: &'a mut Vec<TwistCall>,
}

impl ArmChainPort for RigChainPort<'_> {
    fn dt(&self) -> f64 {
        self.dt
    }

    fn limits_enabled(&self) -> bool {
        self.limits
    }

    fn arm_context(&mut self, graph: &mut Graph, anat: &mut ArmAnatomy, side: Side) -> bool {
        arm_context(self.p, graph, anat, side)
    }

    fn rest_of(&self, bone: u32) -> Quat {
        rest_quat(self.rest, bone)
    }

    fn record_rolls(&mut self, side: Side, fore: f64, humeral: f64) {
        self.fore_roll[side as usize] = fore;
        self.upper_roll[side as usize] = humeral;
    }

    fn stage_twists(&mut self, graph: &mut Graph, side: Side) {
        if let Some(twists) = self.twists.as_mut() {
            twists.stage(graph, side);
            #[cfg(test)]
            self.twist_calls.push(TwistCall::Stage(side));
        }
    }
}

/// The rig's side of `ArmChain`, borrowing the rig's fields apart from the chain and anatomy.
macro_rules! chain_port {
    ($rig:ident) => {
        RigChainPort {
            p: &$rig.p,
            rest: &$rig.rest,
            dt: $rig.dt,
            limits: $rig.limits_enabled,
            fore_roll: &mut $rig.fore_roll,
            upper_roll: &mut $rig.upper_roll,
            twists: $rig.arm_twists.as_mut(),
            #[cfg(test)]
            twist_calls: &mut $rig.twist_calls,
        }
    };
}

/// The rig's side of `ElbowSearch`: the reach, the arm context and the clock.
struct RigElbowPort<'a> {
    p: &'a Profile,
    joints: &'a JointTable,
    dt: f64,
}

impl ElbowContext for RigElbowPort<'_> {
    fn solve_reach(
        &mut self,
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        side: Side,
        target_world: &Vec3,
        angle: f64,
        out: &mut ReachLinks,
        framed: bool,
    ) -> bool {
        solve_reach(
            self.p,
            self.joints,
            graph,
            anat,
            side,
            target_world,
            angle,
            out,
            Some(framed),
        )
    }

    fn arm_context(&mut self, graph: &mut Graph, anat: &mut ArmAnatomy, side: Side) -> bool {
        arm_context(self.p, graph, anat, side)
    }

    fn dt(&self) -> f64 {
        self.dt
    }
}

/// Bone layer.
///
/// Poses are expressed as *world-space direction targets* for each limb rather
/// than local Euler angles. Rest orientations differ wildly between avatars, so
/// "point the forearm down and slightly forward" ports across rigs while
/// "rotate 72 degrees about local X" does not.
///
/// Per frame the caller resets to the rest pose, stacks additive offsets for the
/// spine chain, then aims the arm chains parent-first.
///
/// What is here is the arm: aiming a chain, keeping it inside its anatomical
/// stops, and spending the roll that turns a palm over. The five questions that
/// are not the arm's are beside it — `spine` for the additive half of a
/// frame, `hands` for the fingers, `elbow` for where the elbow goes once a
/// wrist position is fixed, `girdle` for the clavicle's turn that makes the
/// arm room, and `point` for turning a fingertip bearing into a wrist
/// target. `legs` adds optional standing contact before those arm targets
/// are solved, so a pelvis correction also moves their reach origins.
pub struct Rig {
    pub p: Profile,
    arm_twists: Option<ArmTwists>,
    /// bone -> rest quaternion, per node; `None` for a node the profile does not name.
    pub rest: Vec<Option<Quat>>,
    /// The rest map's bones in the order the TS map holds them, which `reset` walks.
    rest_nodes: Vec<u32>,

    pub anat: ArmAnatomy,
    pub joints: JointTable,

    /// The additive half of a frame: spine and eyes. See `spine`.
    spine: SpineOffsets,
    /// The clavicle's room-making turn. See `girdle`.
    girdle: ShoulderGirdle,
    /// Optional standing legs: foot contact is solved before the arms.
    legs: Option<GroundedLegs>,
    /// The pass that stands in for a full one once only bones have moved; see `skeleton_only`.
    skeleton: SkeletonRefresh,
    /// The fingers, which are curled rather than aimed. See `hands`.
    hands: Hands,
    /// Fingers held off the face, and the shape they last took. See `finger_clearance`.
    fingers: FingerClearance,
    /// The arm's bone writes, roll budget and limiter slew. See `arm_chain`.
    chain: ArmChain,
    /// Where the elbow goes once a wrist position is fixed. See `elbow`.
    elbow: ElbowSearch,
    /// A bearing, back-solved into an arm. See `point`.
    point: PointSolver,

    limits_enabled: bool,
    /// Seconds since the last frame, for the limiter's slew. Written by the body
    /// layer at the top of its own update; a caller that poses the rig by hand and
    /// never sets it gets the nominal frame, which is what a single-shot pose
    /// wants anyway.
    pub dt: f64,

    /// The humerus's front at rest, in its own space: the way the elbow folds.
    humeral_front: [Option<Vec3>; 2],
    contact_prediction: [Option<ContactPrediction>; 2],
    /// Why the constrained arm solver is off, one entry per side whose arm bones
    /// resolved but built no driver. It needs both sides, so any entry here means
    /// both arms run the legacy chain.
    pub arm_solver_off: Vec<ArmSolverOff>,
    arm_drivers: [Option<ArmDriver>; 2],
    arm_frame_snapshots: [ArmFrameSnapshot; 2],
    arm_continuation_ready: bool,
    /// Each side's reusable FK frame, which `armForwardContext` refreshes and returns.
    pub(crate) arm_contexts: [ArmForwardContext; 2],
    /// Whether the last capture of each side's hand succeeded; the pose is `hand_pose`.
    accepted_hand_pose: [bool; 2],
    hand_pose: [HandSensePose; 2],
    accepted_arm_state: [AcceptedArmState; 2],
    body_initialization_state: [AcceptedArmState; 2],
    posed_curls: [[f64; 5]; 2],
    posed_spread: [[f64; 5]; 2],
    accepted_body_pose: RigBodyPoseSnapshot,
    proposed_body_pose: RigBodyPoseSnapshot,
    external_arm_revision: u64,
    standing_bootstrap_claimed: bool,
    accepted_rise: f64,
    accepted_turn: f64,
    last_plant_success: bool,
    plant: PlantRecord,
    /// `readActualArmPose`: the posed upper arm, forearm, hand and palm directions.
    actual: [Vec3; 4],
    static_bounded_configuration: ArmConfiguration,
    static_q: [f64; 7],
    /// The accepted driver states a static operation or a re-seed rolls back to.
    driver_snapshots: [ArmDriverAcceptedSnapshot; 2],

    /// Total pronation, both bones.
    pub fore_roll: [f64; 2],
    /// Axial twist given to the humerus.
    pub upper_roll: [f64; 2],

    #[cfg(test)]
    pub(crate) passes: RigPasses,
    /// Sides whose evaluation a test stands in for: what replacing the TS driver's environment
    /// does to every check that the evaluation is native.
    #[cfg(test)]
    pub(crate) custom_evaluator: [bool; 2],
    #[cfg(test)]
    pub(crate) twist_calls: Vec<TwistCall>,
    /// Run a full pass before every plant, as the TS tests' eager reference wraps `plantLegs`.
    #[cfg(test)]
    pub(crate) eager_plant: bool,
}

impl Rig {
    // rig.ts Rig.constructor
    pub fn new(profile: Profile, graph: &mut Graph) -> Rig {
        let p = profile;
        graph.update_world_matrix(ROOT, true, true, false);
        let skeleton = SkeletonRefresh::new(graph, ROOT);
        let arm_frame_snapshots = Side::BOTH.map(|side| capture_arm_frame_metrics(&p, graph, side));

        let mut rest = vec![None; graph.len()];
        let mut rest_nodes = Vec::new();
        for &b in p.bones.iter().chain(p.finger_bones.iter().flatten()) {
            if b == NO_NODE {
                continue;
            }
            if rest[b as usize].is_none() {
                rest_nodes.push(b);
            }
            rest[b as usize] = Some(graph.local_quaternion(b));
        }
        let arm_twists = ArmTwists::create(&p, graph);
        let spine = SpineOffsets::new(&p, graph);
        let legs = GroundedLegs::create(&p, graph, &|b| rest_quat(&rest, b));

        let joints = p.anatomy.clone().unwrap_or_else(JointTable::human);
        let girdle = ShoulderGirdle::new();
        let hands = Hands::new(&p, graph);

        // Anatomy has to be built after the finger axes: it reads the same rest
        // geometry to work out which side of the hand the thumb is on.
        let anat = ArmAnatomy::new(&p, graph);
        let fingers = FingerClearance::new(&p, &hands, &anat, |side| finger_clearance(&p, side));
        let elbow = ElbowSearch::new();
        let point = PointSolver::new();

        let humeral_front = Side::BOTH.map(|side| measure_humeral_front(&p, graph, side));
        let chain = ArmChain::new(*hands.palm_local(), humeral_front);

        let mut plant = PlantRecord::default();
        if let Some(hips) = p.bone(BoneSlot::Hips) {
            plant.pre_plant_hips = graph.local_position(hips);
            plant.post_plant_hips = graph.local_position(hips);
            plant.pre_turn_hips_q = graph.local_quaternion(hips);
            plant.post_turn_hips_q = graph.local_quaternion(hips);
        }
        let snapshot = make_body_pose_snapshot(&p);
        let mut rig = Rig {
            p,
            arm_twists,
            rest,
            rest_nodes,
            anat,
            joints,
            spine,
            girdle,
            legs,
            skeleton,
            hands,
            fingers,
            chain,
            elbow,
            point,
            limits_enabled: true,
            dt: 1.0 / 60.0,
            humeral_front,
            contact_prediction: [None, None],
            arm_solver_off: Vec::with_capacity(2),
            arm_drivers: [None, None],
            arm_frame_snapshots,
            arm_continuation_ready: false,
            arm_contexts: Side::BOTH.map(make_arm_context),
            accepted_hand_pose: [false; 2],
            hand_pose: [HandSensePose::default(); 2],
            accepted_arm_state: [AcceptedArmState::default(); 2],
            body_initialization_state: [AcceptedArmState::default(); 2],
            posed_curls: [[0.0; 5]; 2],
            posed_spread: [[0.0; 5]; 2],
            accepted_body_pose: snapshot,
            proposed_body_pose: snapshot,
            external_arm_revision: 0,
            standing_bootstrap_claimed: false,
            accepted_rise: 0.0,
            accepted_turn: 0.0,
            last_plant_success: true,
            plant,
            actual: [Vec3::default(); 4],
            static_bounded_configuration: ArmConfiguration::default(),
            static_q: [0.0; 7],
            driver_snapshots: [ArmDriverAcceptedSnapshot::default(); 2],
            fore_roll: [0.0; 2],
            upper_roll: [0.0; 2],
            #[cfg(test)]
            passes: RigPasses::default(),
            #[cfg(test)]
            custom_evaluator: [false; 2],
            #[cfg(test)]
            twist_calls: Vec::new(),
            #[cfg(test)]
            eager_plant: false,
        };
        capture_body_pose(
            &rig.p,
            graph,
            &rig.plant,
            &mut rig.accepted_body_pose,
            0.0,
            0.0,
        );
        capture_body_pose(
            &rig.p,
            graph,
            &rig.plant,
            &mut rig.proposed_body_pose,
            0.0,
            0.0,
        );
        for side in Side::BOTH {
            rig.build_driver(graph, side);
        }
        rig.arm_continuation_ready = rig.both_arm_frames_supported(graph);
        rig
    }

    // rig.ts Rig.constructor, one side of its driver loop: a constrained driver, or why not.
    fn build_driver(&mut self, graph: &mut Graph, side: Side) {
        let s = side as usize;
        if self
            .p
            .bone(BoneSlot::arm(ArmSlot::UpperArm, side))
            .is_none()
        {
            return;
        }
        let off = |rig: &mut Rig, reason| rig.arm_solver_off.push(ArmSolverOff { side, reason });
        let (Some(palm_local), Some(humeral_front)) =
            (self.hands.palm_local()[s], self.humeral_front[s])
        else {
            off(self, ArmSolverOffReason::NoPalmFrame);
            return;
        };
        let created = {
            let rest = &self.rest;
            let input = DriverInput {
                profile: &self.p,
                side,
                joints: &self.joints,
                rest: &|b| rest[b as usize],
                finger_axes: &self.hands.fingers,
                palm_local,
                radial_sign: self.anat.radial_sign[s],
                humeral_front,
                finger_clearance: finger_clearance(&self.p, side),
            };
            ArmDriver::create(&input, graph)
        };
        let mut driver = match created {
            Ok(driver) => driver,
            Err(refusal) => {
                off(self, ArmSolverOffReason::Refused(refusal));
                return;
            }
        };
        if !(self.read_arm_forward_context(graph, side, true)
            && self.read_actual_arm_pose(graph, side))
        {
            off(self, ArmSolverOffReason::RestPoseUnreadable);
            return;
        }
        let [u, l, h, n] = self.actual;
        if !driver.seed_from_pose(&self.arm_contexts[s], &u, &l, &h, &n) {
            off(self, ArmSolverOffReason::RestPoseOutsideModel);
            return;
        }
        let mut axis = driver.calibration.hand.axis;
        let mut bind_frame = Mat3::default();
        if hand_frame(&mut axis, &driver.calibration.hand.palm, &mut bind_frame).is_some() {
            self.contact_prediction[s] = Some(ContactPrediction {
                calibration: capture_hand_contact_geometry(
                    &driver.hand_geometry,
                    &driver.calibration.hand.palm,
                ),
                sample: make_hand_geometry_sample(&driver.hand_geometry),
                contact: Vec3::default(),
                bind_frame,
            });
        }
        let roll = driver.accepted_configuration.forearm_roll;
        let forward = driver.accepted_forward;
        self.arm_drivers[s] = Some(driver);
        self.accepted_hand_pose[s] = self.capture_hand_pose(graph, side, true);
        self.fore_roll[s] = roll;
        let (curls, spread) = (
            spec_of(&self.posed_curls[s]),
            spec_of(&self.posed_spread[s]),
        );
        self.capture_accepted_arm_state(graph, side, Some(&forward), &curls, &spread);
    }

    /// One full pass over the root.
    fn full_pass(&mut self, graph: &mut Graph) {
        #[cfg(test)]
        {
            self.passes.full += 1;
        }
        graph.update_matrix_world(ROOT, true);
    }

    fn twists_stage(&mut self, graph: &mut Graph, side: Side) {
        if let Some(twists) = self.arm_twists.as_mut() {
            twists.stage(graph, side);
            #[cfg(test)]
            self.twist_calls.push(TwistCall::Stage(side));
        }
    }

    fn twists_accept(&mut self, graph: &mut Graph, side: Side) {
        if let Some(twists) = self.arm_twists.as_mut() {
            twists.accept(graph, side);
            #[cfg(test)]
            self.twist_calls.push(TwistCall::Accept(side));
        }
    }

    // rig.ts Rig.limitsEnabled (get)
    //
    // Off switch for the anatomical limiting, so a pose can be compared against
    // what the raw geometry produces. Worth keeping: when a gesture looks
    // wrong, the first question is whether the limiter caused it or revealed
    // it, and that is one toggle rather than an afternoon. Only the limiting
    // goes: hand contact is still predicted and the face still clears the hand,
    // so both runs are asked for the same reach.
    pub fn limits_enabled(&self) -> bool {
        self.limits_enabled
    }

    // rig.ts Rig.limitsEnabled (set)
    pub fn set_limits_enabled(&mut self, graph: &mut Graph, on: bool) -> Result<(), LimitsRefusal> {
        if on == self.limits_enabled {
            return Ok(());
        }
        if !on {
            self.limits_enabled = false;
            self.invalidate_arm_continuation();
            return Ok(());
        }

        // Rotations and translation preserve the captured anatomy. A live scale,
        // reflection or shear does not, so keep the legacy path until that metric
        // returns to the one the arm calibration describes.
        if !self.both_arm_frames_supported(graph) {
            self.limits_enabled = true;
            self.invalidate_arm_continuation();
            return Ok(());
        }

        // The diagnostic path can leave a pose outside the hard box or inside the
        // body. Preflight every supported side before exposing constrained mode;
        // a failed re-seed must leave the displayed and accepted poses untouched.
        let (rise, turn) = (self.accepted_rise, self.accepted_turn);
        if !self.reseed_constrained_arms(graph, rise, turn) {
            self.limits_enabled = false;
            self.invalidate_arm_continuation();
            return Err(LimitsRefusal::NoFeasiblePose);
        }
        self.limits_enabled = true;
        self.arm_continuation_ready = true;
        self.chain.release_slew();
        self.external_arm_revision += 1;
        Ok(())
    }

    // rig.ts Rig.fingerAxis and Rig.fingerSplayAxis
    //
    // Curl axis per finger bone and splay axis for proximal finger bones, in that bone's own space.
    pub fn finger_axes(&self) -> &FingerAxes {
        &self.hands.fingers
    }

    // rig.ts Rig.palmLocal
    //
    // Palm normal in hand-bone space.
    pub fn palm_local(&self) -> &[Option<Vec3>; 2] {
        self.hands.palm_local()
    }

    // rig.ts Rig.externalArmRevision
    pub fn external_arm_revision(&self) -> u64 {
        self.external_arm_revision
    }

    // rig.ts Rig.acceptedArmState
    pub fn accepted_arm_state(&self, side: Side) -> &AcceptedArmState {
        &self.accepted_arm_state[side as usize]
    }

    // rig.ts Rig.bootstrapStandingPose
    //
    // Install the default standing pose once, before the first Body frame.
    //
    // This is deliberately a paired static endpoint transaction: no clock or
    // follower has advanced yet, and a partial shoulder/arm pair would make the
    // first displayed pose depend on which side happened to validate first.
    pub fn bootstrap_standing_pose(
        &mut self,
        graph: &mut Graph,
        poses: &[StandingArmPose; 2],
    ) -> bool {
        if self.standing_bootstrap_claimed {
            return false;
        }
        self.standing_bootstrap_claimed = true;
        if !(self.external_arm_revision == 0
            && self.limits_enabled
            && self.both_arm_frames_supported(graph))
        {
            return false;
        }

        let shoulders = Side::BOTH.map(|side| {
            self.p
                .bone(BoneSlot::arm(ArmSlot::Shoulder, side))
                .map(|b| graph.local_quaternion(b))
        });
        let committed = self.bootstrap_pair(graph, poses);
        if !committed {
            for side in Side::BOTH {
                let shoulder = self.p.bone(BoneSlot::arm(ArmSlot::Shoulder, side));
                if let (Some(shoulder), Some(prior)) = (shoulder, shoulders[side as usize]) {
                    graph.set_local_quaternion(shoulder, &prior);
                }
            }
            self.full_pass(graph);
            self.anat.update(graph);
        }
        committed
    }

    // rig.ts Rig.bootstrapStandingPose, the body of its `try`: whether the pair committed.
    fn bootstrap_pair(&mut self, graph: &mut Graph, poses: &[StandingArmPose; 2]) -> bool {
        for side in Side::BOTH {
            let pose = &poses[side as usize];
            let direction_ok = |d: &Vec3| {
                d.x.is_finite() && d.y.is_finite() && d.z.is_finite() && d.length_sq() > 1e-12
            };
            let finite = |spec: &FingerSpec| spec.iter().all(|v| v.is_some_and(f64::is_finite));
            if !([
                pose.shoulder,
                pose.upper_arm,
                pose.lower_arm,
                pose.hand,
                pose.palm,
            ]
            .iter()
            .all(direction_ok)
                && finite(&pose.curls)
                && finite(&pose.spread))
            {
                return false;
            }
            if !self.can_write_arm(side) {
                return false;
            }
        }

        // Both clavicles change the shoulder origins, so stage both before
        // capturing either FK context.
        self.aim_shoulder(graph, Side::L, Some(&poses[0].shoulder));
        self.aim_shoulder(graph, Side::R, Some(&poses[1].shoulder));
        self.full_pass(graph);

        for side in Side::BOTH {
            let s = side as usize;
            let pose = &poses[s];
            let context_ok = self.read_arm_forward_context(graph, side, true);
            let Some(driver) = self.arm_drivers[s].as_mut() else {
                return false;
            };
            if !context_ok {
                return false;
            }
            let context = &self.arm_contexts[s];

            driver.capture_volume_frame(graph, &mut self.anat);
            let palm = driver
                .compose_request(
                    context,
                    &pose.upper_arm,
                    &pose.lower_arm,
                    &pose.hand,
                    Some(&pose.palm),
                    1.0,
                    0.0,
                    &pose.curls,
                    &pose.spread,
                    false,
                )
                .palm;
            let Some(palm) = palm else {
                return false;
            };
            if !driver.configuration_from_pose(
                context,
                &pose.upper_arm,
                &pose.lower_arm,
                &pose.hand,
                Some(&palm),
            ) {
                return false;
            }

            let target_q = driver.target_q;
            if !driver.validate_locked_pose(
                &mut self.anat,
                &target_q,
                context,
                &pose.curls,
                &pose.spread,
                DriverOutput::Output,
            ) {
                let target = driver.target_configuration;
                driver.bound_configuration(&target, &mut self.static_bounded_configuration);
                driver.configuration_to_q(&self.static_bounded_configuration, &mut self.static_q);
                driver.request_for_configuration(
                    &self.static_bounded_configuration,
                    context,
                    &pose.curls,
                    &pose.spread,
                );
                if !driver.restore_endpoint_from(
                    &mut self.anat,
                    &self.static_q,
                    context,
                    0.0,
                    false,
                ) {
                    return false;
                }
            }
        }

        let plans = Side::BOTH.map(|side| {
            let s = side as usize;
            let output = &self.arm_drivers[s]
                .as_ref()
                .expect("both sides were planned")
                .output;
            ArmFrameSideCommit {
                q: output.q,
                forward: output.forward,
                context: self.arm_contexts[s],
                curls: poses[s].curls,
                spread: poses[s].spread,
            }
        });
        let (rise, turn) = (self.accepted_rise, self.accepted_turn);
        if !self.commit_arm_frame(graph, &plans, rise, turn, false) {
            return false;
        }

        for side in Side::BOTH {
            let Some(driver) = self.arm_drivers[side as usize].as_mut() else {
                return false;
            };
            let roll = driver.accepted_configuration.forearm_roll;
            driver.set_request_roll_history(roll);
        }
        let (rise, turn) = (self.accepted_rise, self.accepted_turn);
        capture_body_pose(
            &self.p,
            graph,
            &self.plant,
            &mut self.proposed_body_pose,
            rise,
            turn,
        );
        true
    }

    // rig.ts Rig.armStateForBodyInitialization
    //
    // Read the authoritative accepted pose, or measure the live legacy pose.
    pub fn arm_state_for_body_initialization(
        &mut self,
        graph: &mut Graph,
        side: Side,
    ) -> &AcceptedArmState {
        let s = side as usize;
        if self.limits_enabled
            && self.arm_continuation_ready
            && self.arm_frame_supported(graph, side)
        {
            return &self.accepted_arm_state[s];
        }

        let out = &mut self.body_initialization_state[s];
        out.directions = [[0.0; 3]; 4];
        out.palm = [0.0; 3];
        if self.read_actual_arm_pose(graph, side) {
            let [u, l, h, n] = self.actual;
            let out = &mut self.body_initialization_state[s];
            let (anat, p) = (&mut self.anat, &self.p);
            to_accepted_character(anat, graph, p, &mut out.directions[1], &u, side);
            to_accepted_character(anat, graph, p, &mut out.directions[2], &l, side);
            to_accepted_character(anat, graph, p, &mut out.directions[3], &h, side);
            to_accepted_character(anat, graph, p, &mut out.palm, &n, side);
            if let Some(shoulder) = p.bone(BoneSlot::arm(ArmSlot::Shoulder, side)) {
                let mut d = rest_dir(p, BoneSlot::arm(ArmSlot::Shoulder, side));
                d.apply_quaternion(&graph.world_quaternion(shoulder))
                    .normalize();
                to_accepted_character(anat, graph, p, &mut out.directions[0], &d, side);
            }
        }
        let out = &mut self.body_initialization_state[s];
        out.curls = self.posed_curls[s];
        out.spread = self.posed_spread[s];
        out.forearm_roll = self.fore_roll[s];
        out
    }

    // rig.ts Rig.armDriver
    pub fn arm_driver(&self, side: Side) -> Option<&ArmDriver> {
        self.arm_drivers[side as usize].as_ref()
    }

    /// `armDriver(side)` with the anatomy its solves sample, for the arm transaction's own
    /// calls on the driver.
    pub fn arm_driver_mut(&mut self, side: Side) -> Option<(&mut ArmDriver, &mut ArmAnatomy)> {
        let driver = self.arm_drivers[side as usize].as_mut()?;
        Some((driver, &mut self.anat))
    }

    // rig.ts Rig.predictHandContact
    //
    // Borrowed metric hand-bone geometry; valid until the next prediction for this side.
    //
    // Not gated on the limiter: the calibration is the avatar's shape alone, and
    // withholding it with the limiter off moved that run's blowKiss request 5.8 cm.
    pub fn predict_hand_contact(
        &mut self,
        graph: &mut Graph,
        side: Side,
        selector: &HandContact,
        curls: &FingerSpec,
        spread: &FingerSpec,
    ) -> Option<&ContactPrediction> {
        let s = side as usize;
        if self.contact_prediction[s].is_none() || !self.both_arm_frames_supported(graph) {
            return None;
        }
        let clearance = finger_clearance(&self.p, side);
        let prediction = self.contact_prediction[s].as_mut()?;
        if !sample_hand_contact(
            &prediction.calibration,
            curls,
            spread,
            selector,
            clearance,
            &mut prediction.contact,
        ) {
            return None;
        }
        sample_hand_geometry(
            &prediction.calibration.geometry,
            curls,
            spread,
            &mut prediction.sample,
        );
        for point in &prediction.sample.points {
            let p = &point.position;
            if !(p.x.is_finite() && p.y.is_finite() && p.z.is_finite()) {
                return None;
            }
        }
        Some(prediction)
    }

    /// One side's prediction record, present once construction calibrated the hand: the record
    /// `predict_hand_contact` refills in place and lends out.
    pub fn contact_prediction(&self, side: Side) -> Option<&ContactPrediction> {
        self.contact_prediction[side as usize].as_ref()
    }

    // rig.ts Rig.armFrameSupportedFromUpdatedRoot
    fn arm_frame_supported_from_updated_root(&self, graph: &mut Graph, side: Side) -> bool {
        let snapshot = &self.arm_frame_snapshots[side as usize];
        if !(self.arm_drivers[side as usize].is_some() && snapshot.valid && snapshot.len > 0) {
            return false;
        }
        for &(object, captured) in &snapshot.carriers[..snapshot.len] {
            graph.update_parent_world(object);
            let Some(scale) = positive_conformal_scale(&graph.current_parent_world(object)) else {
                return false;
            };
            if (scale - captured).abs() > js_max(scale, captured) * FRAME_TOLERANCE {
                return false;
            }
        }
        true
    }

    // rig.ts Rig.armFrameSupported
    fn arm_frame_supported(&self, graph: &mut Graph, side: Side) -> bool {
        graph.update_world_matrix(ROOT, true, false, false);
        self.arm_frame_supported_from_updated_root(graph, side)
    }

    // rig.ts Rig.constrainedSideSupported
    fn constrained_side_supported(&mut self, graph: &mut Graph, side: Side) -> bool {
        if !self.limits_enabled {
            return false;
        }
        if self.arm_frame_supported(graph, side) {
            return true;
        }
        self.invalidate_arm_continuation();
        false
    }

    // rig.ts Rig.bothArmFramesSupported
    fn both_arm_frames_supported(&self, graph: &mut Graph) -> bool {
        graph.update_world_matrix(ROOT, true, false, false);
        self.arm_frame_supported_from_updated_root(graph, Side::L)
            && self.arm_frame_supported_from_updated_root(graph, Side::R)
    }

    // rig.ts Rig.invalidateArmContinuation
    fn invalidate_arm_continuation(&mut self) {
        if !self.arm_continuation_ready {
            return;
        }
        self.arm_continuation_ready = false;
        self.chain.release_continuity();
    }

    // rig.ts Rig.beginBodyArmFrame
    //
    // Body uses one shared support decision for both arms at the start of a frame.
    pub fn begin_body_arm_frame(&mut self, graph: &mut Graph) -> bool {
        if !(self.limits_enabled && self.both_arm_frames_supported(graph)) {
            self.invalidate_arm_continuation();
            return false;
        }
        self.arm_continuation_ready
    }

    // rig.ts Rig.finishLegacyBodyFrame
    //
    // Re-seed only after a complete legacy frame has been rendered. The TS defaults `turn` to 0.
    pub fn finish_legacy_body_frame(&mut self, graph: &mut Graph, rise: f64, turn: f64) {
        if !(self.limits_enabled && self.both_arm_frames_supported(graph)) {
            self.invalidate_arm_continuation();
        } else if !self.arm_continuation_ready && self.reseed_constrained_arms(graph, rise, turn) {
            self.arm_continuation_ready = true;
            self.external_arm_revision += 1;
        }
        self.twists_accept(graph, Side::L);
        self.twists_accept(graph, Side::R);
    }

    // rig.ts Rig.armForwardContext
    //
    // Refresh and return this side's reusable FK frame.
    pub fn arm_forward_context(
        &mut self,
        graph: &mut Graph,
        side: Side,
    ) -> Option<&ArmForwardContext> {
        self.read_arm_forward_context(graph, side, true)
            .then(|| &self.arm_contexts[side as usize])
    }

    // rig.ts Rig.armForwardContextFromUpdatedBody
    //
    // Read synchronously after applyBodyContext has refreshed the scene.
    // Native evaluation only changes scratch state between the two arm reads.
    // Custom evaluators and a hips frame outside the root retain eager refreshes.
    pub fn arm_forward_context_from_updated_body(
        &mut self,
        graph: &mut Graph,
        side: Side,
    ) -> Option<&ArmForwardContext> {
        if !self.native_arm_evaluation() {
            return self.arm_forward_context(graph, side);
        }
        let mut parent = self.p.bone(BoneSlot::Hips).and_then(|h| graph.parent_of(h));
        while let Some(node) = parent {
            if node == ROOT {
                return self
                    .read_arm_forward_context(graph, side, false)
                    .then(|| &self.arm_contexts[side as usize]);
            }
            parent = graph.parent_of(node);
        }
        self.arm_forward_context(graph, side)
    }

    /// The TS checks that a side's driver still evaluates on its native environment.
    fn native(&self, side: Side) -> bool {
        #[cfg(test)]
        if self.custom_evaluator[side as usize] {
            return false;
        }
        self.arm_drivers[side as usize].is_some()
    }

    // rig.ts Rig.nativeArmEvaluation
    //
    // Both arms evaluate natively, which writes scratch state and never the scene.
    fn native_arm_evaluation(&self) -> bool {
        self.native(Side::L) && self.native(Side::R)
    }

    // rig.ts Rig.skeletonOnly
    //
    // True when the legs were planted this frame and only bones have moved since:
    // that plant refreshed the whole scene, so the skeleton is all a pass need cover.
    // A custom arm evaluator may have moved anything after it, so it keeps full passes.
    fn skeleton_only(&self, after_plant: bool) -> bool {
        after_plant && self.legs.is_some() && self.native_arm_evaluation()
    }

    // rig.ts Rig.refreshScene
    fn refresh_scene(&mut self, graph: &mut Graph, after_plant: bool) {
        if self.skeleton_only(after_plant) {
            #[cfg(test)]
            {
                self.passes.skeleton += 1;
            }
            self.skeleton.run(graph);
        } else {
            self.full_pass(graph);
        }
    }

    // rig.ts Rig.readArmForwardContext: whether `arm_contexts[side]` was refreshed.
    fn read_arm_forward_context(
        &mut self,
        graph: &mut Graph,
        side: Side,
        refresh_scene: bool,
    ) -> bool {
        let s = side as usize;
        let upper = self.p.bone(BoneSlot::arm(ArmSlot::UpperArm, side));
        let parent = upper.and_then(|u| graph.three_parent_of(u));
        let upper_length = self.p.limb[s].upper.unwrap_or(0.0);
        let lower_length = self.p.limb[s].lower.unwrap_or(0.0);
        let (Some(upper), Some(parent)) = (upper, parent) else {
            return false;
        };
        if !(upper_length > 0.0 && lower_length > 0.0 && self.anat.update(graph)) {
            return false;
        }
        if refresh_scene {
            self.full_pass(graph);
        }
        if !arm_context(&self.p, graph, &mut self.anat, side) {
            return false;
        }
        graph.update_world_matrix(upper, true, false, false);
        graph.update_parent_world(parent);
        let context = &mut self.arm_contexts[s];
        context.shoulder = graph.world_position(upper);
        context.upper_length = upper_length;
        context.lower_length = lower_length;
        context.up = *self.anat.up();
        context.right = *self.anat.right();
        context.forward = *self.anat.fwd();
        context.upper_parent_world = graph.parent_world_quaternion(parent);
        true
    }

    // rig.ts Rig.captureProposedBodyContext
    //
    // Capture the once-followed body context that candidate arms will use. The TS defaults
    // `turn` to 0.
    pub fn capture_proposed_body_context(&mut self, graph: &mut Graph, rise: f64, turn: f64) {
        capture_body_pose(
            &self.p,
            graph,
            &self.plant,
            &mut self.proposed_body_pose,
            rise,
            turn,
        );
    }

    // rig.ts Rig.applyBodyContext
    //
    // Rebuild articulation and common airborne transport with separate progress.
    //
    // `after_plant`: the caller planted the legs earlier this frame and has moved only bones
    // since. The TS defaults `transportProgress` to `alpha` and `afterPlant` to false.
    pub fn apply_body_context(
        &mut self,
        graph: &mut Graph,
        alpha: f64,
        transport_progress: f64,
        after_plant: bool,
    ) -> f64 {
        let a = self.accepted_body_pose;
        let b = self.proposed_body_pose;
        let blend = clamp(alpha, 0.0, 1.0);
        for (k, &slot) in BODY_SNAPSHOT_SLOTS.iter().enumerate() {
            let (Some(bone), Some(qa), Some(qb)) = (self.p.bone(slot), a.slots[k], b.slots[k])
            else {
                continue;
            };
            let mut q = qa;
            q.slerp(&qb, blend);
            graph.set_local_quaternion(bone, &q);
        }
        let progress = clamp(transport_progress, 0.0, 1.0);
        let rise = lerp(a.rise, b.rise, progress);
        if let Some(hips) = self.p.bone(BoneSlot::Hips) {
            let mut position = Vec3::default();
            position.lerp_vectors(&a.hips_position, &b.hips_position, blend);
            let up = transport_up(&self.p, graph);
            position.add_scaled_vector(&up, rise);
            graph.set_local_position(hips, &position);
        }
        let turn = lerp(a.turn, b.turn, progress);
        self.plant_legs(graph, rise, turn, after_plant);
        // Grounded legs refresh the whole scene before they read it and every bone
        // they write after that, so only a body without them still needs a pass.
        if self.legs.is_none() {
            self.full_pass(graph);
        }
        self.anat.update(graph);
        rise
    }

    // rig.ts Rig.stageArmForward
    pub fn stage_arm_forward(
        &mut self,
        graph: &mut Graph,
        side: Side,
        forward: &ArmForwardResult,
        curls: &FingerSpec,
        spread: &FingerSpec,
    ) -> bool {
        if !self.can_write_arm(side) {
            return false;
        }
        self.write_arm_forward(graph, side, forward);
        self.curl_hand_bones(graph, side, curls, spread);
        self.copy_posed_finger_spec(side, curls, spread);
        self.full_pass(graph);
        true
    }

    // rig.ts Rig.commitArmFrame
    //
    // Apply and accept both sides only after the common-alpha frame is complete. `after_plant`
    // as for `apply_body_context`; the TS defaults `turn` to 0 and `afterPlant` to false.
    pub fn commit_arm_frame(
        &mut self,
        graph: &mut Graph,
        plans: &[ArmFrameSideCommit; 2],
        rise: f64,
        turn: f64,
        after_plant: bool,
    ) -> bool {
        for side in Side::BOTH {
            if !self.can_write_arm(side) {
                return false;
            }
        }
        // Each side writes only its own chain and reads its parents fresh, so one
        // pass after both covers what either side's fingers left stale.
        for side in Side::BOTH {
            let plan = &plans[side as usize];
            self.write_arm_forward(graph, side, &plan.forward);
            self.curl_hand_bones(graph, side, &plan.curls, &plan.spread);
            self.copy_posed_finger_spec(side, &plan.curls, &plan.spread);
        }
        self.refresh_scene(graph, after_plant);
        for side in Side::BOTH {
            let s = side as usize;
            let plan = &plans[s];
            let Some(driver) = self.arm_drivers[s].as_mut() else {
                return false;
            };
            driver.accept(&plan.q, &plan.context, &plan.curls, &plan.spread);
            let roll = driver.accepted_configuration.forearm_roll;
            let forward = driver.accepted_forward;
            self.fore_roll[s] = roll;
            self.upper_roll[s] = 0.0;
            self.fingers.note_fingers(&self.p, graph, side);
            self.accepted_hand_pose[s] = self.capture_hand_pose(graph, side, false);
            self.capture_accepted_arm_state(graph, side, Some(&forward), &plan.curls, &plan.spread);
        }
        capture_body_pose(
            &self.p,
            graph,
            &self.plant,
            &mut self.accepted_body_pose,
            rise,
            turn,
        );
        self.accepted_rise = rise;
        self.accepted_turn = turn;
        self.twists_accept(graph, Side::L);
        self.twists_accept(graph, Side::R);
        true
    }

    // rig.ts Rig.commitArmTransport
    //
    // Accept only the common signed jump translation after an articulated frame
    // could not be certified. Native torso/head/face self-clearances are invariant
    // under this rigid upper-body translation and yaw. Legs still solve contact;
    // custom environments and carriers outside the hips subtree have no such
    // guarantee. The TS defaults `turn` to 0 and `afterPlant` to false.
    pub fn commit_arm_transport(
        &mut self,
        graph: &mut Graph,
        lift: f64,
        turn: f64,
        after_plant: bool,
    ) -> bool {
        if !(lift.is_finite()
            && turn.is_finite()
            && lift == self.proposed_body_pose.rise
            && turn == self.proposed_body_pose.turn
            && (lift != self.accepted_rise || turn != self.accepted_turn)
            && self.limits_enabled
            && self.arm_continuation_ready
            && self.both_arm_frames_supported(graph))
        {
            return false;
        }
        for side in Side::BOTH {
            if !(self.native(side) && self.can_write_arm(side)) {
                return false;
            }
        }
        if !self.transport_topology_supported(graph) {
            return false;
        }
        for snapshot in [&self.accepted_body_pose, &self.proposed_body_pose] {
            let position = snapshot.hips_position;
            if ![
                position.x,
                position.y,
                position.z,
                snapshot.rise,
                snapshot.turn,
            ]
            .iter()
            .all(|v| v.is_finite())
            {
                return false;
            }
            for (k, &slot) in BODY_SNAPSHOT_SLOTS.iter().enumerate() {
                if self.p.bone(slot).is_none() {
                    continue;
                }
                match snapshot.slots[k] {
                    Some(q) if [q.x, q.y, q.z, q.w].iter().all(|v| v.is_finite()) => {}
                    _ => return false,
                }
            }
        }
        self.apply_body_context(graph, 0.0, 1.0, after_plant);
        let left = self
            .arm_forward_context_from_updated_body(graph, Side::L)
            .is_some();
        let right = self
            .arm_forward_context_from_updated_body(graph, Side::R)
            .is_some();
        if !(left && right && self.last_plant_success) {
            self.apply_body_context(graph, 0.0, 0.0, after_plant);
            return false;
        }
        // Both contexts are ready before accepted history changes on either side.
        // Keep configurations, controls and roll history exactly as last accepted.
        for side in Side::BOTH {
            let s = side as usize;
            let context = self.arm_contexts[s];
            let driver = self.arm_drivers[s].as_mut().expect("checked native above");
            let forward = *driver.refresh_accepted_forward(&context);
            let (curls, spread) = (
                spec_of(&driver.accepted_curls),
                spec_of(&driver.accepted_spread),
            );
            self.write_arm_forward(graph, side, &forward);
            self.curl_hand_bones(graph, side, &curls, &spread);
            self.copy_posed_finger_spec(side, &curls, &spread);
        }
        self.refresh_scene(graph, after_plant);
        for side in Side::BOTH {
            let s = side as usize;
            self.fingers.note_fingers(&self.p, graph, side);
            self.accepted_hand_pose[s] = self.capture_hand_pose(graph, side, false);
            let driver = self.arm_drivers[s].as_ref().expect("checked native above");
            let (forward, curls, spread) = (
                driver.accepted_forward,
                spec_of(&driver.accepted_curls),
                spec_of(&driver.accepted_spread),
            );
            self.capture_accepted_arm_state(graph, side, Some(&forward), &curls, &spread);
        }
        capture_body_pose(
            &self.p,
            graph,
            &self.plant,
            &mut self.accepted_body_pose,
            lift,
            turn,
        );
        self.accepted_rise = lift;
        self.accepted_turn = turn;
        true
    }

    // rig.ts Rig.transportTopologySupported
    //
    // Every self-clearance carrier must share the hips translation, not leg IK.
    fn transport_topology_supported(&self, graph: &Graph) -> bool {
        let p = &self.p;
        let Some(hips) = p.bone(BoneSlot::Hips) else {
            return false;
        };
        let leg_bones = [
            BoneSlot::UpperLegL,
            BoneSlot::LowerLegL,
            BoneSlot::FootL,
            BoneSlot::ToeL,
            BoneSlot::UpperLegR,
            BoneSlot::LowerLegR,
            BoneSlot::FootR,
            BoneSlot::ToeR,
        ]
        .map(|slot| p.bones[slot as usize]);
        let carried = |object: u32| {
            let mut node = Some(object);
            while let Some(n) = node {
                if leg_bones.contains(&n) {
                    return false;
                }
                if n == hips {
                    return true;
                }
                node = graph.parent_of(n);
            }
            false
        };
        for slot in BODY_SNAPSHOT_SLOTS {
            if let Some(bone) = p.bone(slot)
                && !carried(bone)
            {
                return false;
            }
        }
        for side in Side::BOTH {
            for link in ARM_LINKS {
                let bone = p.bone(BoneSlot::arm(link, side));
                // A parent in the ancestor mirror is never carried by the hips.
                let parent = bone.and_then(|b| graph.three_parent_of(b));
                match (bone, parent) {
                    (Some(bone), Some(Parent::Node(parent)))
                        if carried(bone) && carried(parent) => {}
                    _ => return false,
                }
            }
            for finger in Finger::ALL {
                if !p.finger(finger, side).iter().all(|&b| carried(b)) {
                    return false;
                }
            }
        }
        true
    }

    // rig.ts Rig.lastAcceptedHandPose
    pub fn last_accepted_hand_pose(&self, side: Side) -> Option<&HandSensePose> {
        let s = side as usize;
        self.accepted_hand_pose[s].then(|| &self.hand_pose[s])
    }

    // rig.ts Rig.reset
    //
    // Start a frame: every controlled bone back to its rest orientation.
    pub fn reset(&mut self, graph: &mut Graph) {
        for &bone in &self.rest_nodes {
            graph.set_local_quaternion(bone, &rest_quat(&self.rest, bone));
        }
        if let Some(twists) = self.arm_twists.as_ref() {
            twists.reset(graph);
        }
        self.spine.clear();
        self.posed_curls = [[0.0; 5]; 2];
        self.posed_spread = [[0.0; 5]; 2];
    }

    // rig.ts Rig.canWriteArm
    fn can_write_arm(&self, side: Side) -> bool {
        self.arm_drivers[side as usize].is_some()
            && ARM_LINKS
                .iter()
                .all(|&link| self.p.bone(BoneSlot::arm(link, side)).is_some())
    }

    // rig.ts Rig.writeArmForward
    fn write_arm_forward(&mut self, graph: &mut Graph, side: Side, forward: &ArmForwardResult) {
        let [upper, lower, hand] = ARM_LINKS.map(|link| self.p.bone(BoneSlot::arm(link, side)));
        let (Some(upper), Some(lower), Some(hand)) = (upper, lower, hand) else {
            return;
        };
        write_world_rotation(graph, upper, &forward.upper_world);
        write_world_rotation(graph, lower, &forward.lower_world);
        write_world_rotation(graph, hand, &forward.hand_world);
        self.twists_stage(graph, side);
    }

    // rig.ts Rig.readActualArmPose: into `actual`.
    fn read_actual_arm_pose(&mut self, graph: &mut Graph, side: Side) -> bool {
        let [upper, lower, hand] = ARM_LINKS.map(|link| self.p.bone(BoneSlot::arm(link, side)));
        let (Some(upper), Some(lower), Some(hand), Some(palm)) =
            (upper, lower, hand, self.hands.palm_local()[side as usize])
        else {
            return false;
        };
        self.full_pass(graph);
        let p = &self.p;
        let dir = |graph: &mut Graph, bone: u32, link: ArmSlot| {
            let mut v = rest_dir(p, BoneSlot::arm(link, side));
            v.apply_quaternion(&graph.world_quaternion(bone))
                .normalize();
            v
        };
        let u = dir(graph, upper, ArmSlot::UpperArm);
        let l = dir(graph, lower, ArmSlot::LowerArm);
        let h = dir(graph, hand, ArmSlot::Hand);
        let mut n = palm;
        n.apply_quaternion(&graph.world_quaternion(hand))
            .normalize();
        self.actual = [u, l, h, n];
        true
    }

    // rig.ts Rig.captureHandPose: into `hand_pose[side]`, whether it was captured. Without
    // `refresh_scene` the caller refreshed the scene and wrote nothing since.
    fn capture_hand_pose(&mut self, graph: &mut Graph, side: Side, refresh_scene: bool) -> bool {
        let p = &self.p;
        let hand = p.bone(BoneSlot::arm(ArmSlot::Hand, side));
        let elbow = p.bone(BoneSlot::arm(ArmSlot::LowerArm, side));
        let palm_local = self.hands.palm_local()[side as usize];
        let knuckle = p.finger_root(Finger::Middle, side);
        let index = p.finger_root(Finger::Index, side);
        let little = p.finger_root(Finger::Little, side);
        let (Some(hand), Some(elbow), Some(palm_local), Some(knuckle), Some(index), Some(little)) =
            (hand, elbow, palm_local, knuckle, index, little)
        else {
            return false;
        };
        if refresh_scene {
            self.full_pass(graph);
        }
        let out = &mut self.hand_pose[side as usize];
        out.knuckle = graph.world_position(knuckle);
        let q = graph.world_quaternion(hand);
        out.palm = palm_local;
        out.palm.apply_quaternion(&q).normalize();
        out.forearm = graph.world_position(hand);
        let a = graph.world_position(elbow);
        out.forearm.sub(&a).normalize();
        out.index = graph.world_position(index);
        out.little = graph.world_position(little);
        true
    }

    // rig.ts Rig.captureAcceptedArmState
    fn capture_accepted_arm_state(
        &mut self,
        graph: &mut Graph,
        side: Side,
        forward: Option<&ArmForwardResult>,
        curls: &FingerSpec,
        spread: &FingerSpec,
    ) -> bool {
        let s = side as usize;
        let links = match forward {
            Some(f) => [f.u, f.l, f.h, f.palm],
            None => {
                if !self.read_actual_arm_pose(graph, side) {
                    return false;
                }
                self.actual
            }
        };
        let (anat, p) = (&mut self.anat, &self.p);
        let state = &mut self.accepted_arm_state[s];
        to_accepted_character(anat, graph, p, &mut state.directions[1], &links[0], side);
        to_accepted_character(anat, graph, p, &mut state.directions[2], &links[1], side);
        to_accepted_character(anat, graph, p, &mut state.directions[3], &links[2], side);
        to_accepted_character(anat, graph, p, &mut state.palm, &links[3], side);
        if let Some(shoulder) = p.bone(BoneSlot::arm(ArmSlot::Shoulder, side)) {
            let mut d = rest_dir(p, BoneSlot::arm(ArmSlot::Shoulder, side));
            d.apply_quaternion(&graph.world_quaternion(shoulder))
                .normalize();
            to_accepted_character(anat, graph, p, &mut state.directions[0], &d, side);
        }
        for f in 0..5 {
            state.curls[f] = curls[f].unwrap_or(0.0);
            state.spread[f] = spread[f].unwrap_or(0.0);
        }
        state.forearm_roll = self.arm_drivers[s]
            .as_ref()
            .map_or(self.fore_roll[s], |d| d.accepted_configuration.forearm_roll);
        true
    }

    // rig.ts Rig.copyPosedFingerSpec
    fn copy_posed_finger_spec(&mut self, side: Side, curls: &FingerSpec, spread: &FingerSpec) {
        let s = side as usize;
        for f in 0..5 {
            self.posed_curls[s][f] = curls[f].unwrap_or(0.0);
            self.posed_spread[s][f] = spread[f].unwrap_or(0.0);
        }
    }

    /// The TS `this.hands.curlHand(side, curls, spread)`.
    fn curl_hand_bones(
        &self,
        graph: &mut Graph,
        side: Side,
        curls: &FingerSpec,
        spread: &FingerSpec,
    ) {
        let rest = &self.rest;
        self.hands.curl_hand(
            &self.p,
            &self.joints,
            graph,
            &|b| rest_quat(rest, b),
            side,
            curls,
            spread,
        );
    }

    // rig.ts Rig.addOffset
    //
    // Accumulate a small additive rotation on a spine-chain slot (radians).
    pub fn add_offset(&mut self, slot: OffsetSlot, x: f64, y: f64, z: f64) {
        self.spine.add(slot, x, y, z);
    }

    // rig.ts Rig.commitSpine
    //
    // Bake accumulated spine offsets into local quaternions.
    pub fn commit_spine(&self, graph: &mut Graph) {
        let rest = &self.rest;
        self.spine.commit(&self.p, graph, &|b| rest_quat(rest, b));
    }

    // rig.ts Rig.readHeadOffset
    pub fn read_head_offset(&self, graph: &mut Graph, out: &mut Quat) -> bool {
        self.spine.read_head_offset(&self.p, graph, out)
    }

    // rig.ts Rig.commitEyes
    pub fn commit_eyes(&self, graph: &mut Graph) {
        let rest = &self.rest;
        self.spine
            .commit_eyes(&self.p, graph, &|b| rest_quat(rest, b));
    }

    // rig.ts Rig.plantLegs
    //
    // Keep standing feet planted, or carry their contact points through a hop.
    // `turn` (radians about world up) yaws the whole skeleton about the stance
    // centre and carries the legs through the same turn. `after_plant` as for
    // `apply_body_context`; the TS defaults `turn` to 0 and `afterPlant` to false.
    pub fn plant_legs(&mut self, graph: &mut Graph, rise: f64, turn: f64, after_plant: bool) {
        #[cfg(test)]
        if self.eager_plant {
            self.full_pass(graph);
        }
        let hips = self.p.bone(BoneSlot::Hips);
        if let Some(hips) = hips {
            self.plant.pre_plant_hips = graph.local_position(hips);
            self.plant.pre_turn_hips_q = graph.local_quaternion(hips);
        }
        let yaw = if turn.is_finite() { turn } else { 0.0 };
        if let Some(hips) = hips
            && yaw != 0.0
        {
            self.turn_hips(graph, hips, yaw);
        }
        let skeleton_only = self.skeleton_only(after_plant);
        self.last_plant_success = match self.legs.as_mut() {
            Some(legs) => {
                #[cfg(test)]
                {
                    if skeleton_only {
                        self.passes.skeleton += 1;
                    } else {
                        self.passes.full += 1;
                    }
                }
                legs.apply(
                    &self.p,
                    graph,
                    rise,
                    yaw,
                    skeleton_only.then_some(&self.skeleton),
                )
            }
            None => true,
        };
        if let Some(hips) = hips {
            self.plant.post_plant_hips = graph.local_position(hips);
            self.plant.post_turn_hips_q = graph.local_quaternion(hips);
        }
    }

    // rig.ts Rig.turnHips
    //
    // Pivot on the stance centre, not the hips: the pelvis sits a few centimetres
    // ahead of the feet, and a yaw about its own vertical sweeps each foot on that
    // radius and lands it off its mark.
    fn turn_hips(&self, graph: &mut Graph, hips: u32, turn: f64) {
        let Some(parent) = graph.three_parent_of(hips) else {
            return;
        };
        graph.update_parent_world(parent);
        graph.update_matrix(hips);
        let mut world = Mat4::default();
        world.multiply_matrices(
            &graph.current_parent_world(parent),
            &graph.local_matrix(hips),
        );
        let pivot = match self.legs.as_ref() {
            Some(legs) => legs.stance_pivot(graph),
            None => *Vec3::default().set_from_matrix_position(&world),
        };
        // T(p) R_y(turn) T(-p) hipsWorld, carried back through the parent's inverse.
        let mut scratch = Mat4::default();
        world.premultiply(scratch.make_translation(-pivot.x, -pivot.y, -pivot.z));
        world.premultiply(scratch.make_rotation_y(turn));
        world.premultiply(scratch.make_translation(pivot.x, pivot.y, pivot.z));
        world.premultiply(scratch.copy(&graph.current_parent_world(parent)).invert());
        let (mut position, mut quaternion, mut scale) =
            (Vec3::default(), Quat::default(), Vec3::default());
        world.decompose(&mut position, &mut quaternion, &mut scale);
        graph.set_local_position(hips, &position);
        graph.set_local_quaternion(hips, &quaternion);
        graph.update_matrix(hips);
    }

    // rig.ts Rig.girdleRoom
    //
    // See `ShoulderGirdle.girdleRoom`.
    #[allow(clippy::too_many_arguments)]
    pub fn girdle_room(
        &self,
        graph: &mut Graph,
        side: Side,
        target_world: &Vec3,
        dir: &[f64; 3],
        weight: f64,
        turn_out: &mut Vec3,
    ) {
        self.girdle.girdle_room(
            &self.p,
            &self.joints,
            graph,
            side,
            target_world,
            dir,
            weight,
            turn_out,
        );
    }

    // rig.ts Rig.turnGirdle
    //
    // See `ShoulderGirdle.turnGirdle`.
    pub fn turn_girdle(&self, dir: &mut [f64; 3], turn: &Vec3) {
        self.girdle.turn_girdle(dir, turn);
    }

    // rig.ts Rig.aimShoulder
    //
    // Pose the shoulder alone.
    //
    // Split out of `aimArm` because a reach has to be solved from where the upper
    // arm will be, and that is not where it rests: the clavicle carries it a
    // noticeable distance. The caller poses the shoulder, solves, then poses the
    // rest of the chain — `aimArm` re-aims the shoulder to the same direction on
    // its way past, which costs one quaternion and keeps the chain in one place.
    pub fn aim_shoulder(&mut self, graph: &mut Graph, side: Side, dir: Option<&Vec3>) {
        let port = chain_port!(self);
        self.chain.aim_shoulder(&self.p, graph, &port, side, dir);
    }

    // rig.ts Rig.seedDriverFromActual, against `arm_contexts[side]`
    fn seed_driver_from_actual(&mut self, graph: &mut Graph, side: Side) -> bool {
        let s = side as usize;
        if !self.read_actual_arm_pose(graph, side) {
            return false;
        }
        let [u, l, h, n] = self.actual;
        let context = self.arm_contexts[s];
        let (curls, spread) = (
            spec_of(&self.posed_curls[s]),
            spec_of(&self.posed_spread[s]),
        );
        let driver = self.arm_drivers[s]
            .as_mut()
            .expect("a seeded side has a driver");
        if !driver.seed_from_pose(&context, &u, &l, &h, &n) {
            return false;
        }
        let q = driver.accepted_q;
        driver.accept(&q, &context, &curls, &spread);
        true
    }

    // rig.ts Rig.restoreDriverAfterRejectedStatic
    fn restore_driver_after_rejected_static(&mut self, side: Side) {
        let s = side as usize;
        if let Some(driver) = self.arm_drivers[s].as_mut() {
            driver.restore_accepted_state(&self.driver_snapshots[s]);
        }
    }

    // rig.ts Rig.commitStaticArm, committing the driver's `output`. The TS defaults
    // `bumpRevision` to true.
    #[allow(clippy::too_many_arguments)]
    fn commit_static_arm(
        &mut self,
        graph: &mut Graph,
        side: Side,
        context: &ArmForwardContext,
        curls: &FingerSpec,
        spread: &FingerSpec,
        bump_revision: bool,
    ) {
        let s = side as usize;
        let Some(driver) = self.arm_drivers[s].as_ref() else {
            return;
        };
        let (q, forward) = (driver.output.q, driver.output.forward);
        self.write_arm_forward(graph, side, &forward);
        self.curl_hand_bones(graph, side, curls, spread);
        self.copy_posed_finger_spec(side, curls, spread);
        self.full_pass(graph);
        let driver = self.arm_drivers[s].as_mut().expect("checked above");
        driver.accept(&q, context, curls, spread);
        let roll = driver.accepted_configuration.forearm_roll;
        let accepted = driver.accepted_forward;
        self.fore_roll[s] = roll;
        self.upper_roll[s] = 0.0;
        self.fingers.note_fingers(&self.p, graph, side);
        self.accepted_hand_pose[s] = self.capture_hand_pose(graph, side, false);
        self.capture_accepted_arm_state(graph, side, Some(&accepted), curls, spread);
        let (rise, turn) = (self.accepted_rise, self.accepted_turn);
        capture_body_pose(
            &self.p,
            graph,
            &self.plant,
            &mut self.accepted_body_pose,
            rise,
            turn,
        );
        if bump_revision {
            self.external_arm_revision += 1;
        }
        self.twists_accept(graph, side);
    }

    // rig.ts Rig.tryStaticAimArm
    #[allow(clippy::too_many_arguments)]
    fn try_static_aim_arm(
        &mut self,
        graph: &mut Graph,
        side: Side,
        dirs: &[Option<Vec3>; 4],
        twist: f64,
        palm_target: Option<&Vec3>,
        palm_weight: f64,
    ) -> bool {
        let s = side as usize;
        let Some(driver) = self.arm_drivers[s].as_ref() else {
            return false;
        };
        driver.capture_accepted_state(&mut self.driver_snapshots[s]);
        let clavicle = self.p.bone(BoneSlot::arm(ArmSlot::Shoulder, side));
        let prior_clavicle = clavicle.map(|c| graph.local_quaternion(c));
        self.aim_shoulder(graph, side, dirs[0].as_ref());
        if !(self.read_arm_forward_context(graph, side, true)
            && self.seed_driver_from_actual(graph, side))
        {
            if let (Some(clavicle), Some(prior)) = (clavicle, prior_clavicle) {
                graph.set_local_quaternion(clavicle, &prior);
            }
            self.full_pass(graph);
            self.restore_driver_after_rejected_static(side);
            return false;
        }

        let link = |d: Option<Vec3>| {
            let mut v = d.expect("an aimed arm names its upper arm, forearm and hand");
            v.normalize();
            v
        };
        let links = [link(dirs[1]), link(dirs[2]), link(dirs[3])];
        let target_palm = palm_target.map(|t| {
            let mut v = *t;
            v.normalize();
            v
        });
        let context = self.arm_contexts[s];
        let (curls, spread) = (
            spec_of(&self.posed_curls[s]),
            spec_of(&self.posed_spread[s]),
        );
        let driver = self.arm_drivers[s].as_mut().expect("checked above");
        driver.capture_volume_frame(graph, &mut self.anat);
        let prior_roll = driver.request_roll_history();
        driver.compose_request(
            &context,
            &links[0],
            &links[1],
            &links[2],
            target_palm.as_ref(),
            palm_weight,
            twist,
            &curls,
            &spread,
            true,
        );
        if !static_plan(driver, &mut self.anat, &context, &links) {
            driver.set_request_roll_history(prior_roll);
            if let (Some(clavicle), Some(prior)) = (clavicle, prior_clavicle) {
                graph.set_local_quaternion(clavicle, &prior);
            }
            self.full_pass(graph);
            self.restore_driver_after_rejected_static(side);
            return false;
        }
        self.commit_static_arm(graph, side, &context, &curls, &spread, true);
        true
    }

    // rig.ts Rig.tryStaticHand
    fn try_static_hand(
        &mut self,
        graph: &mut Graph,
        side: Side,
        curls: &FingerSpec,
        spread: &FingerSpec,
    ) -> bool {
        let s = side as usize;
        let Some(driver) = self.arm_drivers[s].as_ref() else {
            return false;
        };
        driver.capture_accepted_state(&mut self.driver_snapshots[s]);
        if !(self.read_arm_forward_context(graph, side, true)
            && self.seed_driver_from_actual(graph, side))
        {
            self.restore_driver_after_rejected_static(side);
            return false;
        }
        let context = self.arm_contexts[s];
        let driver = self.arm_drivers[s].as_mut().expect("checked above");
        driver.capture_volume_frame(graph, &mut self.anat);
        let accepted = driver.accepted_configuration;
        driver.request_for_configuration(&accepted, &context, curls, spread);
        let start = driver.accepted_q;
        let status = driver
            .plan_from(&mut self.anat, &start, &context, 0.0, false)
            .status;
        if status == ArmPathStatus::Blocked
            && !driver.restore_endpoint_from(&mut self.anat, &start, &context, 0.0, false)
        {
            self.restore_driver_after_rejected_static(side);
            return false;
        }
        self.commit_static_arm(graph, side, &context, curls, spread, true);
        true
    }

    // rig.ts Rig.noteExternalArmEdit
    fn note_external_arm_edit(&mut self, graph: &mut Graph, side: Side) {
        let s = side as usize;
        self.twists_accept(graph, side);
        let (curls, spread) = (
            spec_of(&self.posed_curls[s]),
            spec_of(&self.posed_spread[s]),
        );
        if !self.capture_accepted_arm_state(graph, side, None, &curls, &spread) {
            return;
        }
        self.accepted_hand_pose[s] = self.capture_hand_pose(graph, side, false);
        let (rise, turn) = (self.accepted_rise, self.accepted_turn);
        capture_body_pose(
            &self.p,
            graph,
            &self.plant,
            &mut self.accepted_body_pose,
            rise,
            turn,
        );
        self.external_arm_revision += 1;
    }

    // rig.ts Rig.reseedConstrainedArms. The TS defaults `rise` and `turn` to the accepted ones.
    fn reseed_constrained_arms(&mut self, graph: &mut Graph, rise: f64, turn: f64) -> bool {
        for side in Side::BOTH {
            let s = side as usize;
            if let Some(driver) = self.arm_drivers[s].as_ref() {
                driver.capture_accepted_state(&mut self.driver_snapshots[s]);
            }
        }

        let mut pending = [false; 2];
        for side in Side::BOTH {
            let s = side as usize;
            let context_ok = self.read_arm_forward_context(graph, side, true);
            if self.arm_drivers[s].is_none() {
                continue;
            }
            if !(context_ok && self.seed_driver_from_actual(graph, side)) {
                self.restore_reseed_snapshots();
                return false;
            }
            let context = self.arm_contexts[s];
            let (curls, spread) = (
                spec_of(&self.posed_curls[s]),
                spec_of(&self.posed_spread[s]),
            );
            let driver = self.arm_drivers[s].as_mut().expect("checked above");
            driver.capture_volume_frame(graph, &mut self.anat);
            let accepted = driver.accepted_configuration;
            driver.bound_configuration(&accepted, &mut self.static_bounded_configuration);
            driver.configuration_to_q(&self.static_bounded_configuration, &mut self.static_q);
            driver.request_for_configuration(
                &self.static_bounded_configuration,
                &context,
                &curls,
                &spread,
            );
            let valid = driver.validate_locked_pose(
                &mut self.anat,
                &self.static_q,
                &context,
                &curls,
                &spread,
                DriverOutput::Output,
            );
            let endpoint_valid = valid
                || driver.restore_endpoint_from(
                    &mut self.anat,
                    &self.static_q,
                    &context,
                    0.0,
                    false,
                );
            if !endpoint_valid {
                self.restore_reseed_snapshots();
                return false;
            }
            pending[s] = true;
        }

        self.accepted_rise = rise;
        self.accepted_turn = turn;
        for side in Side::BOTH {
            let s = side as usize;
            if !pending[s] {
                continue;
            }
            let context = self.arm_contexts[s];
            let (curls, spread) = (
                spec_of(&self.posed_curls[s]),
                spec_of(&self.posed_spread[s]),
            );
            self.commit_static_arm(graph, side, &context, &curls, &spread, false);
            let driver = self.arm_drivers[s]
                .as_mut()
                .expect("a pending side has a driver");
            let roll = driver.accepted_configuration.forearm_roll;
            driver.set_request_roll_history(roll);
        }
        true
    }

    // rig.ts Rig.restoreReseedSnapshots
    fn restore_reseed_snapshots(&mut self) {
        for side in Side::BOTH {
            self.restore_driver_after_rejected_static(side);
        }
    }

    // rig.ts Rig.aimArm
    //
    // Pose one arm. `dirs` holds world-space unit directions in `ArmSlot` order;
    // omitted slots keep their rest orientation relative to the parent. A constrained aim
    // needs the upper arm, forearm and hand, as the TS reads them unchecked.
    //
    // Returns false when a constrained side rejected the request: the arm, its
    // clavicle and the accepted history stay exactly as they were. Falling back
    // to the unconstrained writer there would publish a pose no limit certified.
    // The TS defaults `twist` to 0, `palmTarget` to null and `palmWeight` to 1.
    #[allow(clippy::too_many_arguments)]
    pub fn aim_arm(
        &mut self,
        graph: &mut Graph,
        side: Side,
        dirs: &[Option<Vec3>; 4],
        twist: f64,
        palm_target: Option<&Vec3>,
        palm_weight: f64,
    ) -> bool {
        if self.constrained_side_supported(graph, side) {
            return self.try_static_aim_arm(graph, side, dirs, twist, palm_target, palm_weight);
        }
        self.aim_arm_legacy(graph, side, dirs, twist, palm_target, palm_weight);
        self.note_external_arm_edit(graph, side);
        true
    }

    // rig.ts Rig.aimArmLegacy
    //
    // Legacy single-chain path, used only when limiting is explicitly disabled or unsupported.
    #[allow(clippy::too_many_arguments)]
    pub fn aim_arm_legacy(
        &mut self,
        graph: &mut Graph,
        side: Side,
        dirs: &[Option<Vec3>; 4],
        twist: f64,
        palm_target: Option<&Vec3>,
        palm_weight: f64,
    ) {
        let mut port = chain_port!(self);
        self.chain.aim_arm_legacy(
            &self.p,
            &self.joints,
            graph,
            &mut self.anat,
            &mut port,
            side,
            dirs,
            twist,
            palm_target,
            palm_weight,
        );
    }

    // rig.ts Rig.measure
    //
    // Measure one arm as it currently stands, for the panel.
    //
    // Reads the posed bones rather than the requested directions on purpose: what
    // is worth showing is the pose that survived the clamp, not the one that was
    // asked for. The labels are the TS side's; this returns the readings' numbers.
    pub fn measure(&mut self, graph: &mut Graph, side: Side) -> Option<[Reading; 9]> {
        let p = &self.p;
        let [u, l, h] = ARM_LINKS.map(|link| p.bone(BoneSlot::arm(link, side)));
        let (Some(u), Some(l), Some(h)) = (u, l, h) else {
            return None;
        };
        if !self.anat.update(graph) {
            return None;
        }
        arm_context(p, graph, &mut self.anat, side);
        let palm = match self.hands.palm_local()[side as usize] {
            Some(local) => {
                let mut v = local;
                v.apply_quaternion(&graph.world_quaternion(h)).normalize();
                v
            }
            None => {
                let mut v = *self.anat.up();
                v.negate();
                v
            }
        };
        let dir = |graph: &mut Graph, bone: u32, link: ArmSlot| {
            let mut v = rest_dir(p, BoneSlot::arm(link, side));
            v.apply_quaternion(&graph.world_quaternion(bone))
                .normalize();
            v
        };
        let du = dir(graph, u, ArmSlot::UpperArm);
        let dl = dir(graph, l, ArmSlot::LowerArm);
        let dh = dir(graph, h, ArmSlot::Hand);
        self.anat.measure(
            side,
            &du,
            &dl,
            &dh,
            Some(&palm),
            self.fore_roll[side as usize],
            self.upper_roll[side as usize],
        );
        Some(self.anat.report())
    }

    // rig.ts Rig.solveReachNatural
    //
    // Reach a wrist to a world position, choosing the elbow rather than being
    // told it.
    //
    // The authored alternative is `solveReach` with an explicit angle, and it is
    // the wrong default: the angle is measured from the body's forward direction
    // about a line whose bearing changes with every target, so one constant means
    // a different elbow for every gesture that uses it. Every face-touching pose
    // in the table carried the same -0.3, which put the elbow in front of the
    // chest for a hand going to the crown and folded the arm across the face.
    //
    // `pole` is a world point the elbow is drawn toward, as the gesture table
    // states one; without it the search predicts its own. See `ElbowSearch`.
    // Returns whether `out` was solved (the TS returns `out` or null).
    pub fn solve_reach_natural(
        &mut self,
        graph: &mut Graph,
        side: Side,
        target_world: &Vec3,
        hand_dir: Option<&Vec3>,
        out: &mut ArmSolution,
        pole: Option<&Vec3>,
    ) -> bool {
        let mut ctx = RigElbowPort {
            p: &self.p,
            joints: &self.joints,
            dt: self.dt,
        };
        self.elbow
            .search(
                &self.p,
                graph,
                &mut self.anat,
                &mut ctx,
                side,
                target_world,
                hand_dir,
                None,
                out,
                pole,
            )
            .is_some()
    }

    // rig.ts Rig.solvePoint
    //
    // Back-solve an arm from a fingertip. See `point`, which holds the
    // arithmetic that turns a bearing into a wrist target.
    pub fn solve_point(
        &mut self,
        graph: &mut Graph,
        side: Side,
        spec: &PointRequest,
        out: &mut ArmSolution,
    ) -> bool {
        let elbow = self.elbow;
        let mut ctx = RigElbowPort {
            p: &self.p,
            joints: &self.joints,
            dt: self.dt,
        };
        let profile = &self.p;
        let mut search = |graph: &mut Graph,
                          anat: &mut ArmAnatomy,
                          side: Side,
                          wrist: &Vec3,
                          hand_dir: Option<&Vec3>,
                          palm_n: Option<&Vec3>,
                          out: &mut ArmSolution| {
            elbow.search(
                profile, graph, anat, &mut ctx, side, wrist, hand_dir, palm_n, out, None,
            )
        };
        self.point.solve(
            profile,
            &self.joints,
            graph,
            &mut self.anat,
            &mut search,
            side,
            spec,
            out,
        )
    }

    // rig.ts Rig.solveReach
    //
    // Solve a two-link reach so the wrist lands on `targetWorld`. See
    // `reach`, which holds the geometry, and `reachRef` for `framed`.
    pub fn solve_reach(
        &mut self,
        graph: &mut Graph,
        side: Side,
        target_world: &Vec3,
        elbow_angle: f64,
        out: &mut ReachLinks,
        framed: Option<bool>,
    ) -> bool {
        solve_reach(
            &self.p,
            &self.joints,
            graph,
            &mut self.anat,
            side,
            target_world,
            elbow_angle,
            out,
            framed,
        )
    }

    // rig.ts Rig.curlFinger
    //
    // Curl a finger. See `Hands.curlFinger`.
    //
    // Returns false when a constrained side rejected the shape, as `aim_arm`.
    pub fn curl_finger(
        &mut self,
        graph: &mut Graph,
        name: Finger,
        side: Side,
        amount: f64,
    ) -> bool {
        let s = side as usize;
        if self.constrained_side_supported(graph, side) {
            let mut curls = spec_of(&self.posed_curls[s]);
            curls[name as usize] = Some(amount);
            let spread = spec_of(&self.posed_spread[s]);
            return self.try_static_hand(graph, side, &curls, &spread);
        }
        self.curl_finger_legacy(graph, name, side, amount);
        self.posed_curls[s][name as usize] = amount;
        self.note_external_arm_edit(graph, side);
        true
    }

    // rig.ts Rig.curlHand
    //
    // Returns false when a constrained side rejected the shape, as `aim_arm`. The TS defaults
    // `spread` to `{}`.
    pub fn curl_hand(
        &mut self,
        graph: &mut Graph,
        side: Side,
        spec: &FingerSpec,
        spread: &FingerSpec,
    ) -> bool {
        if self.constrained_side_supported(graph, side) {
            return self.try_static_hand(graph, side, spec, spread);
        }
        self.curl_hand_legacy(graph, side, spec, spread);
        self.note_external_arm_edit(graph, side);
        true
    }

    // rig.ts Rig.curlFingerLegacy
    //
    // Legacy direct finger write, used by Body only for an explicit limiter opt-out.
    pub fn curl_finger_legacy(&mut self, graph: &mut Graph, name: Finger, side: Side, amount: f64) {
        // Keep the splay the record holds, as the constrained path does.
        let rest = &self.rest;
        self.hands.curl_finger(
            &self.p,
            &self.joints,
            graph,
            &|b| rest_quat(rest, b),
            name,
            side,
            amount,
            self.posed_spread[side as usize][name as usize],
        );
    }

    // rig.ts Rig.curlHandLegacy
    //
    // Legacy direct hand write, used by Body only for an explicit limiter opt-out. The TS
    // defaults `spread` to `{}`.
    pub fn curl_hand_legacy(
        &mut self,
        graph: &mut Graph,
        side: Side,
        spec: &FingerSpec,
        spread: &FingerSpec,
    ) {
        self.curl_hand_bones(graph, side, spec, spread);
        // Before clearance bends any: record the uncropped shape in the frame the
        // reached hand actually carries wherever it is placed next.
        self.fingers.note_fingers(&self.p, graph, side);
        let rest = &self.rest;
        let rig = FingerRig {
            p: &self.p,
            joints: &self.joints,
            hands: &self.hands,
            rest_of: &|b| rest_quat(rest, b),
        };
        let posed =
            self.fingers
                .curl_clear_of_face(&rig, graph, &mut self.anat, side, spec, spread);
        // `clearFingers` can bend the fingers farther or straighten them to keep
        // their tips off the face. Preserve the final rendered controls for the
        // next constrained re-seed, rather than the values before clearance.
        self.copy_posed_finger_spec(side, &posed, spread);
        self.twists_stage(graph, side);
    }

    // rig.ts Rig.fingerClearance
    //
    // How far off the skin a finger's bones are held: half its thickness, from the knuckle pitch.
    pub fn finger_clearance(&self, side: Side) -> f64 {
        finger_clearance(&self.p, side)
    }

    // rig.ts Rig.fingerShape
    //
    // The hand's finger joints and tips as last posed, in the frame of the
    // pointing direction and palm it actually reached (see `handFrame`): where
    // a hand puts its fingers, for placing it somewhere it has not been yet. A
    // roll budget and wrist limits can leave the hand short of the request;
    // measuring the bones in that requested frame makes the recorded shape
    // depend on how much the pose was clamped. `clearFace` feeds that shape into
    // the next frame's wrist target, so the mismatch feeds back into the arm and
    // made face poses depend on the update rate.
    pub fn finger_shape(&self, side: Side) -> &[Vec3] {
        self.fingers.finger_shape(side)
    }

    // rig.ts Rig.fingerFrame
    //
    // The world frame, as `handFrame` builds it, that the hand reached when
    // `fingerShape` was recorded: the two together are the hand as last posed.
    pub fn finger_frame(&self, side: Side) -> &Mat3 {
        self.fingers.finger_frame(side)
    }
}

/// What the rig's tests share: node access, the base avatar in the shapes the TS tests build,
/// and the arm wiring `Rig` gives the reach, elbow and point solvers.
#[cfg(test)]
pub(crate) mod testkit {
    use super::arm_chain::{ArmChain, ArmChainPort};
    use super::arm_configuration::{
        ArmCalibration, ArmConfiguration, ArmForwardContext, ArmForwardResult,
    };
    use super::arm_driver::{ArmDriver, DriverInput};
    use super::arm_twists::ArmTwists;
    use super::elbow::{ElbowContext, ElbowSearch};
    use super::hand_geometry::HandGeometryCalibration;
    use super::hands::FingerSpec;
    use super::hands::Hands;
    use super::point::{PointRequest, PointSolver};
    use super::reach::{ArmSolution, ReachLinks, length, solve_reach};
    use crate::anatomy::arm::ArmAnatomy;
    use crate::anatomy::joints::{FINGER_WIDTH, HAND_CONTACT, JointTable};
    use crate::anatomy::testkit as anatomy;
    use crate::math::{Mat4, Quat, Vec3};
    use crate::profile::{ArmSlot, BoneSlot, Finger, Profile, Side, base};
    use crate::scene::graph::{Graph, NO_NODE, RECORD, Shape, flag};

    /// `new Quaternion().setFromEuler(new Euler(x, y, z))`.
    pub fn euler(x: f64, y: f64, z: f64) -> Quat {
        *Quat::default().set_from_euler_xyz(x, y, z)
    }

    pub fn bone(p: &Profile, slot: BoneSlot) -> u32 {
        p.bone(slot)
            .unwrap_or_else(|| panic!("the base avatar has no {slot:?}"))
    }

    /// Every node's local quaternion as it stands, for a `restOf`.
    pub fn rest_table(g: &Graph) -> Vec<f64> {
        g.quaternion.clone()
    }

    /// `restOf` over a table from [`rest_table`].
    pub fn rest_of(table: &[f64]) -> impl Fn(u32) -> Quat + '_ {
        move |i| {
            let n = 4 * i as usize;
            Quat::new(table[n], table[n + 1], table[n + 2], table[n + 3])
        }
    }

    /// The base avatar with its world matrices current.
    pub fn avatar() -> (Graph, Profile) {
        anatomy::graph_and_profile(0.0, 1.0)
    }

    /// `armatureScale: 0.01`: the root scaled by a hundredth and every other node's offset
    /// stated a hundred times larger, so the world is unchanged and local units are centimetres.
    pub fn centimetre(g: &mut Graph) {
        for s in &mut g.scale[0..3] {
            *s *= 0.01;
        }
        for p in &mut g.position[3..] {
            *p /= 0.01;
        }
        g.update_matrix_world(0, true);
    }

    /// The base avatar with a plain node inserted between the root and the hips, the frame the
    /// legs then measure in. Returns the frame's node.
    pub fn with_frame_above_hips() -> (Graph, Profile, u32) {
        let (src, mut p) = base::avatar();
        let h = bone(&p, BoneSlot::Hips);
        let remap = |i: u32| if i == NO_NODE || i < h { i } else { i + 1 };
        let n = src.len();
        let mut g = Graph::new(Shape {
            nodes: n + 1,
            meshes: src.mesh_nodes.len(),
            skeletons: src.skeleton_offsets.len() - 1,
            bones: src.bone_nodes.len(),
        });
        let identity = Mat4::default();
        for i in 0..n {
            if i == h as usize {
                let mut r = [0.0; RECORD];
                r[3..7].copy_from_slice(&[0.0, 0.0, 0.0, 1.0]);
                r[7..10].copy_from_slice(&[1.0; 3]);
                r[13..29].copy_from_slice(&identity.elements);
                r[29..45].copy_from_slice(&identity.elements);
                g.push_node(
                    src.parent[i],
                    flag::MATRIX_AUTO_UPDATE | flag::MATRIX_WORLD_AUTO_UPDATE,
                    &r,
                );
            }
            let mut r = [0.0; RECORD];
            r[0..3].copy_from_slice(&src.position[3 * i..3 * i + 3]);
            r[3..7].copy_from_slice(&src.quaternion[4 * i..4 * i + 4]);
            r[7..10].copy_from_slice(&src.scale[3 * i..3 * i + 3]);
            r[10..13].copy_from_slice(&src.pivot[3 * i..3 * i + 3]);
            r[13..29].copy_from_slice(&src.matrix[16 * i..16 * i + 16]);
            r[29..45].copy_from_slice(&src.matrix_world[16 * i..16 * i + 16]);
            let parent = if i == h as usize {
                h
            } else {
                remap(src.parent[i])
            };
            g.push_node(parent, src.flags[i], &r);
        }
        let mat = |s: &[f64], k: usize| {
            let mut e = [0.0; 16];
            e.copy_from_slice(&s[16 * k..16 * k + 16]);
            Mat4::from_elements(e)
        };
        for (m, &node) in src.mesh_nodes.iter().enumerate() {
            g.push_mesh(
                remap(node),
                &mat(&src.bind_matrix, m),
                &mat(&src.bind_matrix_inverse, m),
            );
        }
        for s in 0..src.skeleton_offsets.len() - 1 {
            g.push_skeleton();
            for b in src.skeleton_offsets[s] as usize..src.skeleton_offsets[s + 1] as usize {
                g.push_bone(remap(src.bone_nodes[b]), &mat(&src.bone_inverses, b));
            }
        }
        g.build();
        for b in &mut p.bones {
            *b = remap(*b);
        }
        for chain in &mut p.finger_bones {
            for b in chain {
                *b = remap(*b);
            }
        }
        for t in p.arm_twists.iter_mut().flatten() {
            t.primary = remap(t.primary);
            t.next = remap(t.next);
            t.helper = remap(t.helper);
        }
        g.update_matrix_world(0, true);
        (g, p, h)
    }

    /// `parent.add(helper); helper.add(child)` before the profile is built: a plain node with
    /// the given transform inserted above `child`, which keeps its own. The table stays in
    /// traverse order with the helper just before `child`; the profile is renumbered to match.
    /// Returns the helper's node.
    pub fn with_helper_above(
        src: &Graph,
        p: &Profile,
        child: u32,
        position: &Vec3,
        quaternion: &Quat,
        scale: &Vec3,
    ) -> (Graph, Profile, u32) {
        let mut p = p.clone();
        let remap = |i: u32| {
            if i == NO_NODE || i < child { i } else { i + 1 }
        };
        let n = src.len();
        let mut g = Graph::new(Shape {
            nodes: n + 1,
            meshes: src.mesh_nodes.len(),
            skeletons: src.skeleton_offsets.len() - 1,
            bones: src.bone_nodes.len(),
        });
        let identity = Mat4::default();
        for i in 0..n {
            if i == child as usize {
                let mut r = [0.0; RECORD];
                r[0..3].copy_from_slice(&[position.x, position.y, position.z]);
                r[3..7].copy_from_slice(&[quaternion.x, quaternion.y, quaternion.z, quaternion.w]);
                r[7..10].copy_from_slice(&[scale.x, scale.y, scale.z]);
                r[13..29].copy_from_slice(&identity.elements);
                r[29..45].copy_from_slice(&identity.elements);
                g.push_node(
                    src.parent[i],
                    flag::MATRIX_AUTO_UPDATE | flag::MATRIX_WORLD_AUTO_UPDATE,
                    &r,
                );
            }
            let mut r = [0.0; RECORD];
            r[0..3].copy_from_slice(&src.position[3 * i..3 * i + 3]);
            r[3..7].copy_from_slice(&src.quaternion[4 * i..4 * i + 4]);
            r[7..10].copy_from_slice(&src.scale[3 * i..3 * i + 3]);
            r[10..13].copy_from_slice(&src.pivot[3 * i..3 * i + 3]);
            r[13..29].copy_from_slice(&src.matrix[16 * i..16 * i + 16]);
            r[29..45].copy_from_slice(&src.matrix_world[16 * i..16 * i + 16]);
            let parent = if i == child as usize {
                child
            } else {
                remap(src.parent[i])
            };
            g.push_node(parent, src.flags[i], &r);
        }
        let mat = |s: &[f64], k: usize| {
            let mut e = [0.0; 16];
            e.copy_from_slice(&s[16 * k..16 * k + 16]);
            Mat4::from_elements(e)
        };
        for (m, &node) in src.mesh_nodes.iter().enumerate() {
            g.push_mesh(
                remap(node),
                &mat(&src.bind_matrix, m),
                &mat(&src.bind_matrix_inverse, m),
            );
        }
        for s in 0..src.skeleton_offsets.len() - 1 {
            g.push_skeleton();
            for b in src.skeleton_offsets[s] as usize..src.skeleton_offsets[s + 1] as usize {
                g.push_bone(remap(src.bone_nodes[b]), &mat(&src.bone_inverses, b));
            }
        }
        g.build();
        for b in &mut p.bones {
            *b = remap(*b);
        }
        for chain in &mut p.finger_bones {
            for b in chain {
                *b = remap(*b);
            }
        }
        for t in p.arm_twists.iter_mut().flatten() {
            t.primary = remap(t.primary);
            t.next = remap(t.next);
            t.helper = remap(t.helper);
        }
        g.update_matrix_world(0, true);
        (g, p, child)
    }

    /// 64-bit FNV-1a over every node's position, quaternion, scale, matrix, matrixWorld and
    /// matrixWorldNeedsUpdate, in node order: f64 little-endian with NaN as one pattern, the
    /// flag as a byte. `record-corpora.test.ts` hashes the TS tree the same way.
    pub fn graph_hash(g: &Graph) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut byte = |b: u8| {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        };
        let f64s = |values: &[f64], byte: &mut dyn FnMut(u8)| {
            for &v in values {
                let bits = if v.is_nan() {
                    0x7ff8_0000_0000_0000
                } else {
                    v.to_bits()
                };
                for b in bits.to_le_bytes() {
                    byte(b);
                }
            }
        };
        for i in 0..g.len() {
            f64s(&g.position[3 * i..3 * i + 3], &mut byte);
            f64s(&g.quaternion[4 * i..4 * i + 4], &mut byte);
            f64s(&g.scale[3 * i..3 * i + 3], &mut byte);
            f64s(&g.matrix[16 * i..16 * i + 16], &mut byte);
            f64s(&g.matrix_world[16 * i..16 * i + 16], &mut byte);
            byte(u8::from(g.flags[i] & flag::MATRIX_WORLD_NEEDS_UPDATE != 0));
        }
        h
    }

    /// 64-bit FNV-1a over f64s, little-endian with NaN as one pattern: `makeFnv64().f64s(values)`.
    pub fn fnv_f64s(values: &[f64]) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for &v in values {
            let bits = if v.is_nan() {
                0x7ff8_0000_0000_0000
            } else {
                v.to_bits()
            };
            for b in bits.to_le_bytes() {
                h ^= u64::from(b);
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        h
    }

    /// `Rig.armContext`: hand the anatomy model this arm's origin and segment lengths.
    pub fn arm_context(p: &Profile, graph: &mut Graph, anat: &mut ArmAnatomy, side: Side) -> bool {
        let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side));
        let limb = &p.limb[side as usize];
        let (Some(upper), Some(la)) = (upper, length(limb.upper)) else {
            anat.clear_arm();
            return false;
        };
        graph.update_world_matrix(upper, true, false, false);
        let s = graph.world_position(upper);
        anat.set_arm(
            &s,
            la,
            limb.lower.unwrap_or(0.0),
            limb.tip[Finger::Middle as usize].unwrap_or(0.0) * HAND_CONTACT,
        );
        true
    }

    /// The elbow search's view of the rig, as `Rig` wires it.
    pub struct Context<'a> {
        pub p: &'a Profile,
        pub joints: &'a JointTable,
        pub dt: f64,
    }

    impl ElbowContext for Context<'_> {
        fn solve_reach(
            &mut self,
            graph: &mut Graph,
            anat: &mut ArmAnatomy,
            side: Side,
            target_world: &Vec3,
            angle: f64,
            out: &mut ReachLinks,
            framed: bool,
        ) -> bool {
            solve_reach(
                self.p,
                self.joints,
                graph,
                anat,
                side,
                target_world,
                angle,
                out,
                Some(framed),
            )
        }

        fn arm_context(&mut self, graph: &mut Graph, anat: &mut ArmAnatomy, side: Side) -> bool {
            arm_context(self.p, graph, anat, side)
        }

        fn dt(&self) -> f64 {
            self.dt
        }
    }

    /// The arm solvers of a `Rig` on the base avatar, with its frame refreshed.
    pub struct Arms {
        pub graph: Graph,
        pub profile: Profile,
        pub anat: ArmAnatomy,
        pub joints: JointTable,
        pub elbow: ElbowSearch,
        pub point: PointSolver,
        pub dt: f64,
    }

    impl Arms {
        pub fn new() -> Arms {
            let (graph, profile) = avatar();
            Arms::of(graph, profile)
        }

        pub fn of(mut graph: Graph, profile: Profile) -> Arms {
            let anat = ArmAnatomy::new(&profile, &mut graph);
            let joints = profile.anatomy.clone().unwrap_or_else(JointTable::human);
            let mut arms = Arms {
                graph,
                profile,
                anat,
                joints,
                elbow: ElbowSearch::new(),
                point: PointSolver::new(),
                dt: 1.0 / 60.0,
            };
            assert!(arms.anat.update(&mut arms.graph));
            arms
        }

        pub fn shoulder(&mut self, side: Side) -> Vec3 {
            let upper = bone(&self.profile, BoneSlot::arm(ArmSlot::UpperArm, side));
            self.graph.update_world_matrix(upper, true, false, false);
            self.graph.world_position(upper)
        }

        /// `Rig.solveReach`, with `framed` left to the solver.
        pub fn solve_reach(
            &mut self,
            side: Side,
            target: &Vec3,
            angle: f64,
            out: &mut ReachLinks,
        ) -> bool {
            solve_reach(
                &self.profile,
                &self.joints,
                &mut self.graph,
                &mut self.anat,
                side,
                target,
                angle,
                out,
                None,
            )
        }

        /// `Rig.solveReachNatural`.
        pub fn solve_reach_natural(
            &mut self,
            side: Side,
            target: &Vec3,
            hand_dir: Option<&Vec3>,
            out: &mut ArmSolution,
            pole: Option<&Vec3>,
        ) -> bool {
            let mut ctx = Context {
                p: &self.profile,
                joints: &self.joints,
                dt: self.dt,
            };
            self.elbow
                .search(
                    &self.profile,
                    &mut self.graph,
                    &mut self.anat,
                    &mut ctx,
                    side,
                    target,
                    hand_dir,
                    None,
                    out,
                    pole,
                )
                .is_some()
        }

        /// `Rig.solvePoint`.
        pub fn solve_point(
            &mut self,
            side: Side,
            spec: &PointRequest,
            out: &mut ArmSolution,
        ) -> bool {
            let elbow = self.elbow;
            let mut ctx = Context {
                p: &self.profile,
                joints: &self.joints,
                dt: self.dt,
            };
            let profile = &self.profile;
            let mut search = |graph: &mut Graph,
                              anat: &mut ArmAnatomy,
                              side: Side,
                              wrist: &Vec3,
                              hand_dir: Option<&Vec3>,
                              palm_n: Option<&Vec3>,
                              out: &mut ArmSolution| {
                elbow.search(
                    profile, graph, anat, &mut ctx, side, wrist, hand_dir, palm_n, out, None,
                )
            };
            self.point.solve(
                profile,
                &self.joints,
                &mut self.graph,
                &mut self.anat,
                &mut search,
                side,
                spec,
                out,
            )
        }
    }

    /// vitest's `toBeCloseTo(b, digits)`.
    pub fn close(a: f64, b: f64, digits: i32) {
        anatomy::close(a, b, digits);
    }

    /// `Rig`'s rest map, per node: every profile bone and finger bone as it stands, `None`
    /// elsewhere.
    pub fn rig_rest(g: &Graph, p: &Profile) -> Vec<Option<Quat>> {
        let mut table = vec![None; g.len()];
        for &b in p.bones.iter().chain(p.finger_bones.iter().flatten()) {
            if b != NO_NODE {
                table[b as usize] = Some(g.local_quaternion(b));
            }
        }
        table
    }

    /// `Rig.fingerClearance`.
    pub fn finger_clearance(p: &Profile, side: Side) -> f64 {
        0.5 * FINGER_WIDTH * p.limb[side as usize].pitch.unwrap_or(0.0)
    }

    /// The humeral front the `Rig` constructor derives from the body frame, in upper-arm space.
    pub fn humeral_front(p: &Profile, g: &mut Graph, side: Side) -> Option<Vec3> {
        let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side))?;
        let chest = p.chest()?;
        let body = p.body?;
        g.update_world_matrix(upper, true, false, false);
        let mut q = g.world_quaternion(upper);
        let mut along = p.rest_dir[BoneSlot::arm(ArmSlot::UpperArm, side) as usize]?;
        along.apply_quaternion(&q);
        let mut front = body.forward;
        front.apply_quaternion(&g.world_quaternion(chest));
        let d = -front.dot(&along);
        front.add_scaled_vector(&along, d);
        if front.length_sq() <= 1e-8 {
            return None;
        }
        q.invert();
        Some(*front.normalize().apply_quaternion(&q))
    }

    /// `Rig.readArmForwardContext(side, true)`.
    pub fn forward_context(
        p: &Profile,
        g: &mut Graph,
        anat: &mut ArmAnatomy,
        side: Side,
    ) -> Option<ArmForwardContext> {
        let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side))?;
        let parent = g.parent_of(upper)?;
        let limb = &p.limb[side as usize];
        let upper_length = limb.upper.unwrap_or(0.0);
        let lower_length = limb.lower.unwrap_or(0.0);
        if !(upper_length > 0.0 && lower_length > 0.0 && anat.update(g)) {
            return None;
        }
        g.update_matrix_world(0, true);
        if !arm_context(p, g, anat, side) {
            return None;
        }
        g.update_world_matrix(upper, true, false, false);
        g.update_world_matrix(parent, true, false, false);
        let shoulder = g.world_position(upper);
        Some(ArmForwardContext {
            side,
            shoulder,
            upper_length,
            lower_length,
            up: *anat.up(),
            right: *anat.right(),
            forward: *anat.fwd(),
            upper_parent_world: g.world_quaternion(parent),
        })
    }

    /// `Rig.readActualArmPose`: the posed upper arm, forearm, hand and palm directions.
    pub fn actual_arm_pose(p: &Profile, g: &mut Graph, palm: &Vec3, side: Side) -> [Vec3; 4] {
        g.update_matrix_world(0, true);
        let dir = |g: &mut Graph, slot: ArmSlot| {
            let b = bone(p, BoneSlot::arm(slot, side));
            let mut v = p.rest_dir[BoneSlot::arm(slot, side) as usize].unwrap();
            v.apply_quaternion(&g.world_quaternion(b)).normalize();
            v
        };
        let u = dir(g, ArmSlot::UpperArm);
        let l = dir(g, ArmSlot::LowerArm);
        let h = dir(g, ArmSlot::Hand);
        let mut n = *palm;
        n.apply_quaternion(&g.world_quaternion(bone(p, BoneSlot::arm(ArmSlot::Hand, side))))
            .normalize();
        [u, l, h, n]
    }

    /// A battery's records, read front to back, with what each one wrote checked as it is read.
    pub struct Stream<'a> {
        values: &'a [f64],
        at: usize,
        pub what: String,
    }

    impl<'a> Stream<'a> {
        pub fn new(values: &'a [f64]) -> Stream<'a> {
            Stream {
                values,
                at: 0,
                what: String::new(),
            }
        }

        pub fn done(&self) -> bool {
            self.at == self.values.len()
        }

        pub fn f64(&mut self) -> f64 {
            let v = self.values[self.at];
            self.at += 1;
            v
        }

        pub fn take(&mut self, n: usize) -> &'a [f64] {
            let v = &self.values[self.at..self.at + n];
            self.at += n;
            v
        }

        pub fn index(&mut self) -> usize {
            let v = self.f64();
            assert!(
                v >= 0.0 && v.fract() == 0.0,
                "{}: {v} is not an index",
                self.what
            );
            v as usize
        }

        pub fn flag(&mut self) -> bool {
            self.f64() == 1.0
        }

        pub fn vec3(&mut self) -> Vec3 {
            let v = self.take(3);
            Vec3::new(v[0], v[1], v[2])
        }

        pub fn quat(&mut self) -> Quat {
            let v = self.take(4);
            Quat::new(v[0], v[1], v[2], v[3])
        }

        pub fn q(&mut self) -> [f64; 7] {
            self.take(7).try_into().unwrap()
        }

        pub fn opt_vec3(&mut self) -> Option<Vec3> {
            self.flag().then(|| self.vec3())
        }

        pub fn spec(&mut self) -> FingerSpec {
            std::array::from_fn(|_| self.flag().then(|| self.f64()))
        }

        pub fn side(&mut self) -> Side {
            Side::BOTH[self.index()]
        }

        /// The next values are what the TS wrote; they must be `got`, bit for bit.
        pub fn same(&mut self, got: &[f64], name: &str) {
            let want = self.take(got.len());
            let g: Vec<u64> = got.iter().map(|v| v.to_bits()).collect();
            let w: Vec<u64> = want.iter().map(|v| v.to_bits()).collect();
            assert_eq!(g, w, "{}: {name}: {got:?} against {want:?}", self.what);
        }

        pub fn same_flag(&mut self, b: bool, name: &str) {
            self.same(&[f64::from(u8::from(b))], name);
        }

        pub fn same_opt_vec3(&mut self, v: Option<&Vec3>, name: &str) {
            match v {
                Some(v) => self.same(&[1.0, v.x, v.y, v.z], name),
                None => self.same(&[0.0], name),
            }
        }

        pub fn same_spec(&mut self, spec: &FingerSpec, name: &str) {
            for v in spec {
                match v {
                    Some(v) => self.same(&[1.0, *v], name),
                    None => self.same(&[0.0], name),
                }
            }
        }
    }

    pub fn halves(h: u64) -> [f64; 2] {
        [(h >> 32) as f64, (h & 0xffff_ffff) as f64]
    }

    pub fn hash_halves(values: &[f64]) -> [f64; 2] {
        halves(fnv_f64s(values))
    }

    pub fn present(into: &mut Vec<f64>, v: Option<f64>) {
        match v {
            Some(v) => into.extend([1.0, v]),
            None => into.push(0.0),
        }
    }

    pub fn present_vec(into: &mut Vec<f64>, v: Option<&Vec3>) {
        match v {
            Some(v) => into.extend([1.0, v.x, v.y, v.z]),
            None => into.push(0.0),
        }
    }

    pub fn v3(v: &Vec3) -> [f64; 3] {
        [v.x, v.y, v.z]
    }

    pub fn q4(q: &Quat) -> [f64; 4] {
        [q.x, q.y, q.z, q.w]
    }

    /// `definitionValues`: a calibration and hand geometry in the solver battery's order.
    pub fn definition_values(c: &ArmCalibration, g: &HandGeometryCalibration) -> Vec<f64> {
        let mut v = Vec::new();
        v.extend(v3(&c.upper.axis));
        v.extend(q4(&c.upper.rest));
        v.extend(v3(&c.upper.front));
        v.extend(v3(&c.lower.axis));
        v.extend(q4(&c.lower.rest));
        v.extend(v3(&c.hand.axis));
        v.extend(q4(&c.hand.rest));
        v.extend(v3(&c.hand.palm));
        v.push(c.radial_sign);
        present(&mut v, g.hand_present.map(|p| f64::from(u8::from(p))));
        v.extend([g.metric_scale, g.points.len() as f64]);
        for point in &g.points {
            v.extend([
                point.finger as usize as f64,
                point.joint_index as f64,
                f64::from(u8::from(point.tip)),
            ]);
            match &point.nodes {
                Some(nodes) => {
                    v.extend([1.0, nodes.len() as f64]);
                    for node in nodes {
                        v.extend(v3(&node.position));
                        v.extend(q4(&node.rest));
                        v.extend(v3(&node.scale));
                        present_vec(&mut v, node.curl_axis.as_ref());
                        present_vec(&mut v, node.splay_axis.as_ref());
                        present(&mut v, node.joint_index.map(|i| i as f64));
                    }
                }
                None => v.push(0.0),
            }
            present(&mut v, point.previous_point.map(|i| i as f64));
            present(&mut v, point.last_point.map(|i| i as f64));
        }
        v
    }

    pub fn configuration_values(c: &ArmConfiguration) -> [f64; 7] {
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

    pub fn configuration_of(v: &[f64]) -> ArmConfiguration {
        ArmConfiguration {
            shoulder_plane: v[0],
            shoulder_lift: v[1],
            humeral_rotation: v[2],
            elbow_flex: v[3],
            forearm_roll: v[4],
            wrist_flex: v[5],
            wrist_dev: v[6],
        }
    }

    pub fn forward_values(r: &ArmForwardResult) -> Vec<f64> {
        let mut out = Vec::with_capacity(42);
        for v in [r.u, r.l, r.h, r.palm, r.elbow, r.wrist] {
            out.extend(v3(&v));
        }
        for q in [
            r.upper_world,
            r.lower_world,
            r.hand_world,
            r.upper_local,
            r.lower_local,
            r.hand_local,
        ] {
            out.extend(q4(&q));
        }
        out
    }

    pub fn context_values(c: &ArmForwardContext) -> Vec<f64> {
        let mut out = vec![c.side as usize as f64];
        out.extend(v3(&c.shoulder));
        out.extend([c.upper_length, c.lower_length]);
        out.extend(v3(&c.up));
        out.extend(v3(&c.right));
        out.extend(v3(&c.forward));
        out.extend(q4(&c.upper_parent_world));
        out
    }

    pub fn context_of(s: &mut Stream) -> ArmForwardContext {
        ArmForwardContext {
            side: s.side(),
            shoulder: s.vec3(),
            upper_length: s.f64(),
            lower_length: s.f64(),
            up: s.vec3(),
            right: s.vec3(),
            forward: s.vec3(),
            upper_parent_world: s.quat(),
        }
    }

    /// `Rig`'s side of `ArmChain`: its clock, limiter switch, rest map, roll tables and helpers.
    pub struct ChainPort<'a> {
        pub p: &'a Profile,
        pub rest: &'a [Option<Quat>],
        pub dt: f64,
        pub limits: bool,
        pub fore_roll: &'a mut [f64; 2],
        pub upper_roll: &'a mut [f64; 2],
        pub twists: Option<&'a mut ArmTwists>,
    }

    impl ArmChainPort for ChainPort<'_> {
        fn dt(&self) -> f64 {
            self.dt
        }

        fn limits_enabled(&self) -> bool {
            self.limits
        }

        fn arm_context(&mut self, graph: &mut Graph, anat: &mut ArmAnatomy, side: Side) -> bool {
            arm_context(self.p, graph, anat, side)
        }

        fn rest_of(&self, bone: u32) -> Quat {
            self.rest[bone as usize].unwrap_or_default()
        }

        fn record_rolls(&mut self, side: Side, fore: f64, humeral: f64) {
            self.fore_roll[side as usize] = fore;
            self.upper_roll[side as usize] = humeral;
        }

        fn stage_twists(&mut self, graph: &mut Graph, side: Side) {
            if let Some(twists) = self.twists.as_mut() {
                twists.stage(graph, side);
            }
        }
    }

    /// The constrained arms of a `Rig`, wired and seeded as its constructor does: the base avatar's
    /// anatomy, finger axes, humeral fronts and one `ArmDriver` per side.
    pub struct Driven {
        pub graph: Graph,
        pub profile: Profile,
        pub anat: ArmAnatomy,
        pub joints: JointTable,
        pub rest: Vec<Option<Quat>>,
        pub twists: Option<ArmTwists>,
        pub hands: Hands,
        pub humeral_front: [Option<Vec3>; 2],
        pub chain: ArmChain,
        pub drivers: [Option<ArmDriver>; 2],
        /// The context each driver was seeded in.
        pub seeded: [Option<ArmForwardContext>; 2],
        /// `Rig.dt`.
        pub dt: f64,
        pub limits: bool,
        /// `Rig.foreRoll` and `Rig.upperRoll`.
        pub fore_roll: [f64; 2],
        pub upper_roll: [f64; 2],
    }

    impl Driven {
        pub fn new() -> Driven {
            let (graph, profile) = avatar();
            Driven::of(graph, profile)
        }

        pub fn of(mut graph: Graph, profile: Profile) -> Driven {
            graph.update_world_matrix(0, true, true, false);
            let rest = rig_rest(&graph, &profile);
            let twists = ArmTwists::create(&profile, &mut graph);
            let joints = profile.anatomy.clone().unwrap_or_else(JointTable::human);
            let hands = Hands::new(&profile, &mut graph);
            let mut anat = ArmAnatomy::new(&profile, &mut graph);
            let humeral_front = Side::BOTH.map(|s| humeral_front(&profile, &mut graph, s));
            let chain = ArmChain::new(*hands.palm_local(), humeral_front);
            let mut drivers = [None, None];
            let mut seeded = [None, None];
            for side in Side::BOTH {
                let (Some(palm), Some(front)) = (
                    hands.palm_local()[side as usize],
                    humeral_front[side as usize],
                ) else {
                    continue;
                };
                let input = DriverInput {
                    profile: &profile,
                    side,
                    joints: &joints,
                    rest: &|i| rest[i as usize],
                    finger_axes: &hands.fingers,
                    palm_local: palm,
                    radial_sign: anat.radial_sign[side as usize],
                    humeral_front: front,
                    finger_clearance: finger_clearance(&profile, side),
                };
                let Ok(mut driver) = ArmDriver::create(&input, &mut graph) else {
                    continue;
                };
                let Some(context) = forward_context(&profile, &mut graph, &mut anat, side) else {
                    continue;
                };
                let [u, l, h, n] = actual_arm_pose(&profile, &mut graph, &palm, side);
                if driver.seed_from_pose(&context, &u, &l, &h, &n) {
                    drivers[side as usize] = Some(driver);
                    seeded[side as usize] = Some(context);
                }
            }
            Driven {
                graph,
                profile,
                anat,
                joints,
                rest,
                twists,
                hands,
                humeral_front,
                chain,
                drivers,
                seeded,
                dt: 1.0 / 60.0,
                limits: true,
                fore_roll: [0.0; 2],
                upper_roll: [0.0; 2],
            }
        }

        /// `rig.aimArmLegacy(side, dirs, twist, palmTarget, palmWeight)`.
        pub fn aim_arm_legacy(
            &mut self,
            side: Side,
            dirs: &[Option<Vec3>; 4],
            twist: f64,
            palm_target: Option<&Vec3>,
            palm_weight: f64,
        ) {
            let mut port = ChainPort {
                p: &self.profile,
                rest: &self.rest,
                dt: self.dt,
                limits: self.limits,
                fore_roll: &mut self.fore_roll,
                upper_roll: &mut self.upper_roll,
                twists: self.twists.as_mut(),
            };
            self.chain.aim_arm_legacy(
                &self.profile,
                &self.joints,
                &mut self.graph,
                &mut self.anat,
                &mut port,
                side,
                dirs,
                twist,
                palm_target,
                palm_weight,
            );
        }

        /// `rig.armForwardContext(side)`.
        pub fn context(&mut self, side: Side) -> ArmForwardContext {
            forward_context(&self.profile, &mut self.graph, &mut self.anat, side)
                .expect("the base avatar has an arm context")
        }

        /// One side's driver and the anatomy it samples, borrowed together.
        pub fn driver(&mut self, side: Side) -> (&mut ArmDriver, &mut ArmAnatomy) {
            (
                self.drivers[side as usize]
                    .as_mut()
                    .expect("the base avatar has a constrained arm"),
                &mut self.anat,
            )
        }

        /// `driver.captureVolumeFrame()`.
        pub fn capture_volume_frame(&mut self, side: Side) {
            let driver = self.drivers[side as usize].as_mut().unwrap();
            driver.capture_volume_frame(&mut self.graph, &mut self.anat);
        }
    }
}

/// `tests/corpora/rig-a-battery`: the TS rig leaf modules on the base avatar through a fixed run
/// of their calls, replayed step by step on the port. See `record-corpora.test.ts`.
#[cfg(test)]
mod battery {
    use super::elbow::ElbowSearch;
    use super::girdle::ShoulderGirdle;
    use super::legs::GroundedLegs;
    use super::point::{PointRequest, PointSolver};
    use super::reach::{
        ArmSolution, ReachLinks, near_reach, pole_angle, reach_ref, solve_reach, swivel_of,
    };
    use super::skeleton::SkeletonRefresh;
    use super::spine::{OffsetSlot, SpineOffsets};
    use super::testkit::{Context, avatar, graph_hash, rest_of, rest_table};
    use crate::anatomy::arm::ArmAnatomy;
    use crate::anatomy::joints::JointTable;
    use crate::corpus_replay::{Case, Corpus};
    use crate::math::{Quat, Vec3};
    use crate::profile::{Finger, Side};
    use crate::scene::graph::{Graph, flag};

    const KINDS: [&str; 20] = [
        "skeleton.build",
        "legs.create",
        "spine.build",
        "anat.build",
        "update",
        "skeleton.run",
        "legs.apply",
        "legs.pivot",
        "spine.commit",
        "spine.eyes",
        "spine.head",
        "girdle.room",
        "girdle.turn",
        "reach.near",
        "reach.ref",
        "reach.solve",
        "reach.pole",
        "reach.swivel",
        "elbow.search",
        "point.solve",
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

        fn flag(&self, name: &str) -> bool {
            self.scalar(name) == 1.0
        }

        fn vec3(&self, name: &str) -> Vec3 {
            let v = self.input(name);
            Vec3::new(v[0], v[1], v[2])
        }

        fn opt_vec3(&self, name: &str) -> Option<Vec3> {
            self.flag(&format!("{name}.present"))
                .then(|| self.vec3(name))
        }

        fn opt_bool(&self, name: &str) -> Option<bool> {
            self.flag(&format!("{name}.present"))
                .then(|| self.flag(name))
        }

        fn side(&self) -> Side {
            Side::BOTH[self.scalar("side") as usize]
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

        fn same_vec(&self, v: &Vec3, name: &str) {
            self.same(&[v.x, v.y, v.z], name);
        }

        fn same_bool(&self, b: bool, name: &str) {
            self.same(&[if b { 1.0 } else { 0.0 }], name);
        }

        fn same_option(&self, v: Option<f64>, name: &str) {
            self.same_bool(v.is_some(), "ok");
            self.same(&[v.unwrap_or(0.0)], name);
        }

        fn same_touched(&self, g: &Graph) {
            let len = self.case.output("touched.len")[0] as usize;
            for k in 0..len {
                let at = |field: &str| format!("touched[{k}].{field}");
                let node = self.case.output(&at("node"))[0] as usize;
                self.same(&g.position[3 * node..3 * node + 3], &at("position"));
                self.same(&g.quaternion[4 * node..4 * node + 4], &at("quaternion"));
                self.same(
                    &g.matrix_world[16 * node..16 * node + 16],
                    &at("matrixWorld"),
                );
                let dirty = g.flags[node] & flag::MATRIX_WORLD_NEEDS_UPDATE != 0;
                self.same_bool(dirty, &at("matrixWorldNeedsUpdate"));
            }
        }

        fn same_solution(&self, o: &ArmSolution) {
            self.same_vec(&o.links.upper_arm, "upperArm");
            self.same_vec(&o.links.lower_arm, "lowerArm");
            self.same_vec(&o.swivel_dir, "swivelDir");
        }
    }

    fn quat(q: &Quat) -> [f64; 4] {
        [q.x, q.y, q.z, q.w]
    }

    #[test]
    fn replays_the_ts_rig_bit_for_bit() {
        let corpus = Corpus::load("rig-a-battery");
        let (mut g, p) = avatar();
        let rest = rest_table(&g);
        let joints = JointTable::human();
        let mut skeleton = None;
        let mut legs = None;
        let mut spine = None;
        let mut anat: Option<ArmAnatomy> = None;
        let girdle = ShoulderGirdle::new();
        let elbow = ElbowSearch::new();
        let point = PointSolver::new();
        let mut slots = [ArmSolution::default(); 4];
        let mut seen = [0; 20];

        for (n, case) in corpus.iter().enumerate() {
            let k = case.scalar("kind", false) as usize;
            seen[k] += 1;
            let s = Step {
                case,
                n,
                kind: KINDS[k],
            };
            if s.flag("set.present") {
                let node = s.scalar("set.node") as usize;
                g.position[3 * node..3 * node + 3].copy_from_slice(s.input("set.position"));
                g.quaternion[4 * node..4 * node + 4].copy_from_slice(s.input("set.quaternion"));
            }
            if s.flag("update") {
                g.update_matrix_world(0, true);
            }
            match s.kind {
                "skeleton.build" => {
                    let refresh = SkeletonRefresh::new(&g, 0);
                    let list = |v: &[u32]| {
                        let mut out = vec![v.len() as f64];
                        out.extend(v.iter().map(|&i| f64::from(i)));
                        out
                    };
                    let names = |name: &str, len: usize| {
                        let mut out = vec![s.case.output(&format!("{name}.len"))[0]];
                        for i in 0..len {
                            out.push(s.case.output(&format!("{name}[{i}]"))[0]);
                        }
                        out
                    };
                    assert_eq!(list(&refresh.path), names("path", refresh.path.len()));
                    assert_eq!(
                        list(&refresh.subtrees),
                        names("subtrees", refresh.subtrees.len())
                    );
                    skeleton = Some(refresh);
                }
                "legs.create" => {
                    let created =
                        GroundedLegs::create(&p, &mut g, &rest_of(&rest)).expect("grounded legs");
                    for (i, side) in ["L", "R"].iter().enumerate() {
                        let state = &created.legs[i];
                        let at = |field: &str| format!("legs.{side}.{field}");
                        s.same_vec(&state.knee_pole, &at("kneePole"));
                        s.same_vec(&state.anchor_root, &at("anchorRoot"));
                        s.same(&[state.soft_zone], &at("softZone"));
                        s.same(&[state.upper_length], &at("upperLength"));
                        s.same(&[state.lower_length], &at("lowerLength"));
                    }
                    legs = Some(created);
                }
                "spine.build" => {
                    let built = SpineOffsets::new(&p, &mut g);
                    for slot in OffsetSlot::ALL {
                        let name = ["hips", "spine", "chest", "neck", "head", "eye.L", "eye.R"]
                            [slot as usize];
                        let q = built.basis_q(slot);
                        s.same_bool(q.is_some(), &format!("basis.{name}.present"));
                        if let Some(q) = q {
                            s.same(&quat(&q), &format!("basis.{name}"));
                        }
                    }
                    spine = Some(built);
                }
                "anat.build" => {
                    let a = anat.get_or_insert_with(|| ArmAnatomy::new(&p, &mut g));
                    s.same_bool(a.update(&mut g), "ok");
                }
                "update" => g.update_matrix_world(0, true),
                "skeleton.run" => skeleton.as_ref().unwrap().run(&mut g),
                "legs.apply" => {
                    let refresh = if s.flag("refresh") {
                        skeleton.as_ref()
                    } else {
                        None
                    };
                    let ok = legs.as_mut().unwrap().apply(
                        &p,
                        &mut g,
                        s.scalar("rise"),
                        s.scalar("yaw"),
                        refresh,
                    );
                    s.same_bool(ok, "ok");
                    s.same_touched(&g);
                }
                "legs.pivot" => {
                    let pivot = legs.as_ref().unwrap().stance_pivot(&mut g);
                    s.same_vec(&pivot, "value3");
                }
                "spine.commit" => {
                    let spine = spine.as_mut().unwrap();
                    spine.clear();
                    for i in 0..s.scalar("adds.len") as usize {
                        let slot = OffsetSlot::ALL[s.scalar(&format!("adds[{i}].slot")) as usize];
                        let o = s.input(&format!("adds[{i}].offset"));
                        spine.add(slot, o[0], o[1], o[2]);
                    }
                    spine.commit(&p, &mut g, &rest_of(&rest));
                    s.same_touched(&g);
                }
                "spine.eyes" => {
                    spine
                        .as_ref()
                        .unwrap()
                        .commit_eyes(&p, &mut g, &rest_of(&rest));
                    s.same_touched(&g);
                }
                "spine.head" => {
                    let mut q = Quat::default();
                    let ok = spine.as_ref().unwrap().read_head_offset(&p, &mut g, &mut q);
                    s.same_bool(ok, "ok");
                    s.same(&quat(&q), "q");
                }
                "girdle.room" => {
                    let d = s.input("dir");
                    let mut turn = s.vec3("turn");
                    girdle.girdle_room(
                        &p,
                        &joints,
                        &mut g,
                        s.side(),
                        &s.vec3("target"),
                        &[d[0], d[1], d[2]],
                        s.scalar("weight"),
                        &mut turn,
                    );
                    s.same_vec(&turn, "value3");
                }
                "girdle.turn" => {
                    let d = s.input("dir");
                    let mut dir = [d[0], d[1], d[2]];
                    girdle.turn_girdle(&mut dir, &s.vec3("turn"));
                    s.same(&dir, "value3");
                }
                "reach.near" => {
                    s.same(
                        &[near_reach(s.scalar("la"), s.scalar("lf"), &joints)],
                        "value",
                    );
                }
                "reach.ref" => {
                    let mut perp = Vec3::default();
                    reach_ref(
                        &mut g,
                        anat.as_mut().unwrap(),
                        &s.vec3("n"),
                        &mut perp,
                        s.opt_bool("framed"),
                    );
                    s.same_vec(&perp, "value3");
                }
                "reach.solve" => {
                    let mut links = ReachLinks::default();
                    let ok = solve_reach(
                        &p,
                        &joints,
                        &mut g,
                        anat.as_mut().unwrap(),
                        s.side(),
                        &s.vec3("target"),
                        s.scalar("angle"),
                        &mut links,
                        s.opt_bool("framed"),
                    );
                    s.same_bool(ok, "ok");
                    s.same_vec(&links.upper_arm, "upperArm");
                    s.same_vec(&links.lower_arm, "lowerArm");
                }
                "reach.pole" => {
                    let a = pole_angle(
                        &p,
                        &mut g,
                        anat.as_mut().unwrap(),
                        Side::R,
                        &s.vec3("target"),
                        &s.vec3("pole"),
                    );
                    s.same_option(a, "value");
                }
                "reach.swivel" => {
                    let a = swivel_of(
                        &mut g,
                        anat.as_mut().unwrap(),
                        &s.vec3("n"),
                        &s.vec3("w"),
                        s.opt_bool("framed"),
                    );
                    s.same_option(a, "value");
                }
                "elbow.search" => {
                    let mut ctx = Context {
                        p: &p,
                        joints: &joints,
                        dt: s.scalar("dt"),
                    };
                    let (hand_dir, palm_n, pole) = (
                        s.opt_vec3("handDir"),
                        s.opt_vec3("palmN"),
                        s.opt_vec3("pole"),
                    );
                    let slot = &mut slots[s.scalar("slot") as usize];
                    let strain = elbow.search(
                        &p,
                        &mut g,
                        anat.as_mut().unwrap(),
                        &mut ctx,
                        s.side(),
                        &s.vec3("target"),
                        hand_dir.as_ref(),
                        palm_n.as_ref(),
                        slot,
                        pole.as_ref(),
                    );
                    s.same_option(strain, "value");
                    s.same_solution(slot);
                }
                "point.solve" => {
                    let mut ctx = Context {
                        p: &p,
                        joints: &joints,
                        dt: s.scalar("dt"),
                    };
                    let request = PointRequest {
                        azimuth: Some(s.scalar("azimuth")),
                        elevation: Some(s.scalar("elevation")),
                        extent: s.flag("extent.present").then(|| s.scalar("extent")),
                        finger: s
                            .flag("finger.present")
                            .then(|| Finger::ALL[s.scalar("finger") as usize]),
                        point: s.opt_vec3("point"),
                        palm: s.opt_vec3("palm"),
                    };
                    let profile = &p;
                    let mut search = |graph: &mut Graph,
                                      anat: &mut ArmAnatomy,
                                      side: Side,
                                      wrist: &Vec3,
                                      hand_dir: Option<&Vec3>,
                                      palm_n: Option<&Vec3>,
                                      out: &mut ArmSolution| {
                        elbow.search(
                            profile, graph, anat, &mut ctx, side, wrist, hand_dir, palm_n, out,
                            None,
                        )
                    };
                    let slot = &mut slots[s.scalar("slot") as usize];
                    let ok = point.solve(
                        &p,
                        &joints,
                        &mut g,
                        anat.as_mut().unwrap(),
                        &mut search,
                        s.side(),
                        &request,
                        slot,
                    );
                    s.same_bool(ok, "ok");
                    s.same_solution(slot);
                    s.same_vec(&slot.hand, "hand");
                    s.same_vec(&slot.palm, "palm");
                    s.same_vec(&slot.tip, "tip");
                    s.same(&[slot.twist], "twist");
                    s.same(&[slot.strain.unwrap_or(0.0)], "value");
                }
                other => panic!("unknown step {other}"),
            }
            let h = graph_hash(&g);
            s.same(&[(h >> 32) as f64, (h & 0xffff_ffff) as f64], "hash");
        }
        assert_eq!(
            seen,
            [1, 1, 1, 2, 2, 1, 7, 1, 2, 1, 1, 3, 3, 1, 4, 5, 4, 2, 8, 8]
        );
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    use crate::anatomy::joints::JointTable;
    use crate::rig::arm_configuration::CalibrationRefusal;
    use crate::rig::hands::EMPTY_SPEC;
    use crate::rig::testkit::{avatar, bone, centimetre, close};
    use crate::scene::graph::{Parent, RECORD, flag};

    const LEGS: [BoneSlot; 8] = [
        BoneSlot::UpperLegL,
        BoneSlot::LowerLegL,
        BoneSlot::FootL,
        BoneSlot::ToeL,
        BoneSlot::UpperLegR,
        BoneSlot::LowerLegR,
        BoneSlot::FootR,
        BoneSlot::ToeR,
    ];
    const ARM: [ArmSlot; 4] = [
        ArmSlot::Shoulder,
        ArmSlot::UpperArm,
        ArmSlot::LowerArm,
        ArmSlot::Hand,
    ];
    /// The links an outside edit leaves fixed, as `tests/rig/arm-static.test.ts` gives them.
    const ARM_EDIT: [[f64; 3]; 4] = [
        [0.34, -0.83, 0.44],
        [0.38, -0.79, 0.48],
        [0.08, -0.36, 0.93],
        [0.1, -0.2, 0.97],
    ];
    /// `BASE_POSE`, `BASE_PALM` and `BASE_FINGERS` of `motion/gestures/base.ts`.
    const BASE_POSE: [[f64; 3]; 4] = [
        [0.95, -0.26, 0.06],
        [0.3, -0.94, 0.14],
        [0.17, -0.95, 0.26],
        [0.13, -0.96, 0.24],
    ];
    const BASE_PALM: [f64; 3] = [-0.88, 0.06, -0.47];
    const BASE_FINGERS: [f64; 5] = [0.22, 0.28, 0.34, 0.4, 0.46];

    fn v(a: [f64; 3]) -> Vec3 {
        Vec3::new(a[0], a[1], a[2])
    }

    fn dirs(upper: [f64; 3]) -> [Option<Vec3>; 4] {
        [
            Some(v(ARM_EDIT[0])),
            Some(v(upper)),
            Some(v(ARM_EDIT[2])),
            Some(v(ARM_EDIT[3])),
        ]
    }

    fn build(edit: impl FnOnce(&mut Graph, &mut Profile)) -> (Graph, Rig) {
        let (mut g, mut p) = avatar();
        edit(&mut g, &mut p);
        let rig = Rig::new(p, &mut g);
        (g, rig)
    }

    fn plain() -> (Graph, Rig) {
        build(|_, _| {})
    }

    /// `buildRig({ legs: false })`: the profile names no leg.
    fn no_legs(_: &mut Graph, p: &mut Profile) {
        for slot in LEGS {
            p.bones[slot as usize] = NO_NODE;
        }
    }

    fn bits(values: &[f64]) -> Vec<u64> {
        values.iter().map(|v| v.to_bits()).collect()
    }

    /// Every node's raw state, skinned bind matrices included: a world getter would refresh a
    /// stale matrix away.
    fn matrices(g: &Graph) -> Vec<u64> {
        let mut out = Vec::new();
        for values in [
            &g.position,
            &g.quaternion,
            &g.scale,
            &g.matrix,
            &g.matrix_world,
            &g.bind_matrix,
            &g.bind_matrix_inverse,
        ] {
            out.extend(bits(values));
        }
        out
    }

    fn arm_quaternions(g: &Graph, p: &Profile) -> Vec<u64> {
        let mut out = Vec::new();
        for side in Side::BOTH {
            for slot in ARM {
                if let Some(b) = p.bone(BoneSlot::arm(slot, side)) {
                    let q = g.local_quaternion(b);
                    out.extend(bits(&[q.x, q.y, q.z, q.w]));
                }
            }
        }
        out
    }

    fn finger_quaternions(g: &Graph, p: &Profile) -> Vec<u64> {
        let mut out = Vec::new();
        for chain in &p.finger_bones {
            for &b in chain {
                let q = g.local_quaternion(b);
                out.extend(bits(&[q.x, q.y, q.z, q.w]));
            }
        }
        out
    }

    fn accepted_q(rig: &Rig, side: Side) -> [f64; 7] {
        rig.arm_driver(side).expect("a constrained arm").accepted_q
    }

    fn snapshot(rig: &Rig, side: Side) -> Option<ArmDriverAcceptedSnapshot> {
        rig.arm_driver(side).map(|d| {
            let mut s = ArmDriverAcceptedSnapshot::default();
            d.capture_accepted_state(&mut s);
            s
        })
    }

    /// Accepted driver states, sensed hands and accepted controls of both sides.
    #[allow(clippy::type_complexity)]
    fn histories(
        rig: &Rig,
    ) -> [(
        Option<ArmDriverAcceptedSnapshot>,
        Option<HandSensePose>,
        AcceptedArmState,
    ); 2] {
        Side::BOTH.map(|side| {
            (
                snapshot(rig, side),
                rig.last_accepted_hand_pose(side).copied(),
                *rig.accepted_arm_state(side),
            )
        })
    }

    /// The largest component difference of two rotations, either sign: `angleTo` floors at
    /// several e-8 near identical rotations.
    fn quaternion_delta(a: &Quat, b: &Quat) -> f64 {
        let sign = if a.dot(b) < 0.0 { -1.0 } else { 1.0 };
        [
            (a.x - sign * b.x).abs(),
            (a.y - sign * b.y).abs(),
            (a.z - sign * b.z).abs(),
            (a.w - sign * b.w).abs(),
        ]
        .into_iter()
        .fold(0.0, js_max)
    }

    /// The bones of one arm against the driver's accepted forward result.
    fn arm_matches_accepted(rig: &Rig, g: &mut Graph, side: Side) -> f64 {
        let d = rig.arm_driver(side).expect("a constrained arm");
        let f = d.accepted_forward;
        let mut worst: f64 = 0.0;
        for (slot, q) in [
            (ArmSlot::UpperArm, f.upper_world),
            (ArmSlot::LowerArm, f.lower_world),
            (ArmSlot::Hand, f.hand_world),
        ] {
            let b = bone(&rig.p, BoneSlot::arm(slot, side));
            g.update_world_matrix(b, true, false, false);
            worst = js_max(worst, quaternion_delta(&g.world_quaternion(b), &q));
        }
        worst
    }

    /// A character-space direction in the body frame, as Body hands the rig its standing pose.
    fn character(rig: &Rig, side: Side, d: [f64; 3]) -> Vec3 {
        let mut d = v(d);
        d.normalize();
        let sign = if side == Side::R { 1.0 } else { -1.0 };
        let mut w = *rig.anat.right();
        w.multiply_scalar(d.x * sign)
            .add_scaled_vector(rig.anat.up(), d.y)
            .add_scaled_vector(rig.anat.fwd(), d.z)
            .normalize();
        w
    }

    /// Body's standing pose, built from the gesture table's base pose in the current body frame.
    fn standing(rig: &mut Rig, g: &mut Graph) -> [StandingArmPose; 2] {
        assert!(rig.anat.update(g));
        Side::BOTH.map(|side| {
            let link = |k: usize| {
                let rest = (k > 0).then(|| rig.p.arm_rest[k]).flatten();
                character(rig, side, rest.map_or(BASE_POSE[k], |r| [r.x, r.y, r.z]))
            };
            StandingArmPose {
                shoulder: link(0),
                upper_arm: link(1),
                lower_arm: link(2),
                hand: link(3),
                palm: character(rig, side, BASE_PALM),
                curls: BASE_FINGERS.map(Some),
                spread: [Some(0.0); 5],
            }
        })
    }

    /// Both sides' accepted arms, as the arm transaction commits a frame it could not improve.
    fn accepted_plans(rig: &mut Rig, g: &mut Graph, from_body: bool) -> [ArmFrameSideCommit; 2] {
        Side::BOTH.map(|side| {
            let context = if from_body {
                *rig.arm_forward_context_from_updated_body(g, side)
                    .expect("an arm context")
            } else {
                *rig.arm_forward_context(g, side).expect("an arm context")
            };
            let d = rig.arm_driver(side).expect("a constrained arm");
            ArmFrameSideCommit {
                q: d.accepted_q,
                forward: d.accepted_forward,
                context,
                curls: spec_of(&d.accepted_curls),
                spread: spec_of(&d.accepted_spread),
            }
        })
    }

    /// One constrained frame as Body and the arm transaction drive it, holding the accepted arms.
    fn frame(rig: &mut Rig, g: &mut Graph) -> bool {
        rig.reset(g);
        rig.plant_legs(g, 0.0, 0.0, false);
        rig.capture_proposed_body_context(g, 0.0, 0.0);
        rig.apply_body_context(g, 1.0, 1.0, true);
        let plans = accepted_plans(rig, g, true);
        rig.commit_arm_frame(g, &plans, 0.0, 0.0, true)
    }

    fn passes(rig: &Rig) -> RigPasses {
        rig.passes
    }

    fn since(rig: &Rig, start: RigPasses) -> (usize, usize) {
        (
            rig.passes.full - start.full,
            rig.passes.skeleton - start.skeleton,
        )
    }

    /// Put a plain parent above the root, as a viewer's scene or a test's group does.
    fn wrap_root(g: &mut Graph, position: [f64; 3], auto: bool, matrix: Option<[f64; 16]>) {
        g.set_ancestors(1);
        let r = &mut g.ancestors[0..RECORD];
        r.fill(0.0);
        r[0..3].copy_from_slice(&position);
        r[3..7].copy_from_slice(&[0.0, 0.0, 0.0, 1.0]);
        r[7..10].copy_from_slice(&[1.0; 3]);
        let identity = Mat4::default();
        r[13..29].copy_from_slice(&matrix.unwrap_or(identity.elements));
        r[29..45].copy_from_slice(&identity.elements);
        g.ancestor_flags[0] = flag::MATRIX_WORLD_AUTO_UPDATE
            | flag::MATRIX_WORLD_NEEDS_UPDATE
            | if auto { flag::MATRIX_AUTO_UPDATE } else { 0 };
    }

    fn rotate_ancestor_y(g: &mut Graph, angle: f64) {
        let mut q = Quat::new(
            g.ancestors[3],
            g.ancestors[4],
            g.ancestors[5],
            g.ancestors[6],
        );
        q.premultiply(Quat::default().set_from_axis_angle(&Vec3::new(0.0, 1.0, 0.0), angle));
        g.ancestors[3..7].copy_from_slice(&[q.x, q.y, q.z, q.w]);
    }

    fn turn_y(q: &Quat, angle: f64) -> Quat {
        let mut out = *Quat::default().set_from_axis_angle(&Vec3::new(0.0, 1.0, 0.0), angle);
        out.multiply(q);
        out
    }

    fn nudge(g: &mut Graph, b: u32, by: [f64; 3]) {
        let mut p = g.local_position(b);
        p.add(&v(by));
        g.set_local_position(b, &p);
    }

    // --- a profile bone at the root reads the mirrored ancestor as its parent ----------------

    /// The hips slot on the root, the root under one turned, scaled and moved ancestor.
    fn root_hips() -> (Graph, Rig) {
        build(|g, p| {
            no_legs(g, p);
            p.bones[BoneSlot::Hips as usize] = ROOT;
            wrap_root(g, [0.2, -0.1, 0.3], true, None);
            let mut q = Quat::default();
            q.set_from_axis_angle(&Vec3::new(0.0, 0.0, 1.0), 0.3);
            g.ancestors[3..7].copy_from_slice(&[q.x, q.y, q.z, q.w]);
            g.ancestors[7..10].copy_from_slice(&[2.0; 3]);
            g.update_world_matrix(ROOT, true, true, false);
        })
    }

    #[test]
    fn turns_a_root_hips_in_the_frame_of_its_mirrored_ancestor() {
        let (mut g, mut rig) = root_hips();
        assert_eq!(g.three_parent_of(ROOT), Some(Parent::Ancestor(0)));
        let before = g.world_position(ROOT);
        let before_q = g.world_quaternion(ROOT);
        rig.plant_legs(&mut g, 0.0, core::f64::consts::PI / 2.0, false);
        g.update_matrix_world(ROOT, true);
        assert!(g.world_position(ROOT).distance_to(&before) < 1e-9);
        let mut expected = *Quat::default()
            .set_from_axis_angle(&Vec3::new(0.0, 1.0, 0.0), core::f64::consts::PI / 2.0);
        expected.multiply(&before_q);
        assert!(g.world_quaternion(ROOT).angle_to(&expected) < 1e-7);
    }

    #[test]
    fn lifts_a_root_hips_along_world_up_through_its_mirrored_ancestor() {
        let (mut g, mut rig) = root_hips();
        let before = g.world_position(ROOT);
        rig.capture_proposed_body_context(&mut g, 0.05, 0.0);
        close(rig.apply_body_context(&mut g, 0.0, 1.0, false), 0.05, 12);
        let mut lifted = before;
        lifted.add(&Vec3::new(0.0, 0.05, 0.0));
        assert!(g.world_position(ROOT).distance_to(&lifted) < 1e-9);
    }

    // --- tests/rig/frame-refresh.test.ts ------------------------------------------------------

    #[test]
    fn leaves_no_matrix_of_a_frame_stale() {
        for legs in [true, false] {
            let (mut g, mut rig) = build(|g, p| {
                if !legs {
                    no_legs(g, p);
                }
            });
            let poses = standing(&mut rig, &mut g);
            assert!(rig.bootstrap_standing_pose(&mut g, &poses));
            for _ in 0..4 {
                assert!(frame(&mut rig, &mut g));
                let played = matrices(&g);
                // Nothing the frame wrote was left with a stale world matrix.
                g.update_matrix_world(ROOT, true);
                assert_eq!(matrices(&g), played, "legs={legs}");
            }
        }
    }

    #[test]
    fn commits_both_arms_with_one_scene_pass() {
        for legs in [true, false] {
            let (mut g, mut rig) = build(|g, p| {
                if !legs {
                    no_legs(g, p);
                }
            });
            for _ in 0..3 {
                rig.reset(&mut g);
                rig.plant_legs(&mut g, 0.0, 0.0, false);
                rig.capture_proposed_body_context(&mut g, 0.0, 0.0);
                rig.apply_body_context(&mut g, 1.0, 1.0, true);
                let plans = accepted_plans(&mut rig, &mut g, true);
                let start = passes(&rig);
                assert!(rig.commit_arm_frame(&mut g, &plans, 0.0, 0.0, true));
                // With grounded legs the frame's plant covered the scene and the skeleton is all
                // the commit refreshes; without them it is one full pass.
                let expected = if legs { (0, 1) } else { (1, 0) };
                assert_eq!(since(&rig, start), expected, "legs={legs}");
            }
        }
    }

    #[test]
    fn plays_a_skeleton_refresh_as_full_passes_would() {
        let (mut ga, mut actual) = plain();
        let (mut gb, mut reference) = plain();
        // A side whose evaluation is not native keeps full passes everywhere.
        reference.custom_evaluator = [true, false];
        for _ in 0..8 {
            for g in [&mut ga, &mut gb] {
                // Moved between frames, as a viewer places the avatar: the plant's full pass
                // catches it.
                let q = turn_y(&g.local_quaternion(ROOT), 0.05);
                g.set_local_quaternion(ROOT, &q);
                g.position[0] += 0.01;
            }
            assert!(frame(&mut actual, &mut ga));
            assert!(frame(&mut reference, &mut gb));
            assert_eq!(matrices(&ga), matrices(&gb));
            assert_eq!(histories(&actual), histories(&reference));
        }
        assert!(actual.passes.skeleton >= 2 * 8);
        assert_eq!(reference.passes.skeleton, 0);
    }

    // --- tests/rig/body-context-matrices.test.ts ----------------------------------------------

    #[test]
    fn performs_only_the_necessary_full_root_passes() {
        for legs in [true, false] {
            let (mut g, mut rig) = build(|g, p| {
                if !legs {
                    no_legs(g, p);
                }
            });
            rig.capture_proposed_body_context(&mut g, 0.0, 0.0);
            let start = passes(&rig);
            rig.apply_body_context(&mut g, 0.5, 1.0, false);
            assert_eq!(since(&rig, start), (1, 0), "legs={legs}");
            let start = passes(&rig);
            for side in Side::BOTH {
                assert!(
                    rig.arm_forward_context_from_updated_body(&mut g, side)
                        .is_some()
                );
            }
            assert_eq!(since(&rig, start), (0, 0), "legs={legs}");
            assert!(rig.arm_forward_context(&mut g, Side::L).is_some());
            assert_eq!(since(&rig, start), (1, 0), "legs={legs}");
        }
    }

    #[test]
    fn matches_eager_raw_matrices_and_accepted_history() {
        for (legs, scale, transformed) in [
            (true, 1.0, false),
            (true, 0.01, true),
            (false, 1.0, true),
            (false, 0.01, false),
        ] {
            let make = || {
                build(|g, p| {
                    if !legs {
                        no_legs(g, p);
                    }
                    if scale != 1.0 {
                        centimetre(g);
                    }
                    if transformed {
                        g.position[0..3].copy_from_slice(&[0.3, 0.2, -0.4]);
                        let q = turn_y(&g.local_quaternion(ROOT), 0.4);
                        g.set_local_quaternion(ROOT, &q);
                        for s in &mut g.scale[0..3] {
                            *s *= 1.1;
                        }
                        wrap_root(g, [-0.1, 0.05, 0.2], true, None);
                    }
                    g.update_world_matrix(ROOT, true, true, false);
                })
            };
            let (mut ga, mut actual) = make();
            let (mut gb, mut reference) = make();
            reference.eager_plant = true;
            for (g, rig) in [(&mut ga, &mut actual), (&mut gb, &mut reference)] {
                let hips = bone(&rig.p, BoneSlot::Hips);
                nudge(g, hips, [0.0, 0.03 / scale, 0.0]);
                let chest = bone(&rig.p, BoneSlot::Chest);
                let mut q = g.local_quaternion(chest);
                q.multiply(Quat::default().set_from_axis_angle(&Vec3::new(1.0, 0.0, 0.0), 0.04));
                g.set_local_quaternion(chest, &q);
                rig.plant_legs(g, 0.03, 0.0, false);
                rig.capture_proposed_body_context(g, 0.03, 0.0);
            }
            let before = matrices(&ga);
            for alpha in [0.0, 0.25, 0.75, 1.0, 0.5, 0.0] {
                if transformed {
                    for g in [&mut ga, &mut gb] {
                        g.position[0] += 0.01;
                        rotate_ancestor_y(g, 0.03);
                        g.ancestors[1] += 0.005;
                    }
                }
                actual.apply_body_context(&mut ga, alpha, alpha, false);
                reference.apply_body_context(&mut gb, alpha, alpha, false);
                assert_eq!(matrices(&ga), matrices(&gb), "{legs} {scale} {transformed}");
                for side in Side::BOTH {
                    let a = actual
                        .arm_forward_context_from_updated_body(&mut ga, side)
                        .copied();
                    let b = reference.arm_forward_context(&mut gb, side).copied();
                    assert_eq!(a, b, "{legs} {scale} {transformed} {side:?}");
                    assert_eq!(snapshot(&actual, side), snapshot(&reference, side));
                }
                assert_eq!(matrices(&ga), matrices(&gb), "{legs} {scale} {transformed}");
            }
            assert_ne!(matrices(&ga), before);
        }
    }

    #[test]
    fn retains_eager_equivalence_off_the_native_path() {
        for scenario in ["custom evaluator", "missing hips", "failed planting"] {
            let (mut ga, mut actual) = plain();
            let (mut gb, mut reference) = plain();
            reference.eager_plant = true;
            for (g, rig) in [(&mut ga, &mut actual), (&mut gb, &mut reference)] {
                rig.capture_proposed_body_context(g, 0.0, 0.0);
                match scenario {
                    "custom evaluator" => rig.custom_evaluator[0] = true,
                    "missing hips" => rig.p.bones[BoneSlot::Hips as usize] = NO_NODE,
                    _ => {
                        let thigh = bone(&rig.p, BoneSlot::UpperLegL);
                        nudge(g, thigh, [10.0, 0.0, 0.0]);
                    }
                }
                rig.apply_body_context(g, 0.5, 1.0, false);
            }
            let start = passes(&actual);
            let a = actual
                .arm_forward_context_from_updated_body(&mut ga, Side::L)
                .copied();
            let b = reference.arm_forward_context(&mut gb, Side::L).copied();
            assert_eq!(a, b, "{scenario}");
            assert_eq!(matrices(&ga), matrices(&gb), "{scenario}");
            if scenario != "failed planting" {
                assert_eq!(since(&actual, start).0, 1, "{scenario}");
            }
        }
    }

    // --- tests/rig/arm-solver-off.test.ts -------------------------------------------------------

    #[test]
    fn reports_nothing_when_both_drivers_build() {
        let (_, rig) = plain();
        assert!(rig.arm_driver(Side::L).is_some());
        assert!(rig.arm_driver(Side::R).is_some());
        assert!(rig.arm_solver_off.is_empty());
    }

    #[test]
    fn names_each_side_and_the_calibration_that_refused_it() {
        let (_, rig) = build(|_, p| {
            let mut anatomy = JointTable::human();
            anatomy.wrist.flexion.max = [-1.3, 1.3];
            anatomy.wrist.deviation.max = [-0.9, 0.9];
            p.anatomy = Some(anatomy);
        });
        assert!(rig.arm_driver(Side::L).is_none());
        assert!(rig.arm_driver(Side::R).is_none());
        let refused = ArmSolverOffReason::Refused(DriverRefusal::Calibration(
            CalibrationRefusal::WristBeyondInverse,
        ));
        assert_eq!(
            rig.arm_solver_off,
            [
                ArmSolverOff {
                    side: Side::L,
                    reason: refused
                },
                ArmSolverOff {
                    side: Side::R,
                    reason: refused
                },
            ]
        );
    }

    // --- tests/motion/body/matrix-refresh.test.ts ---------------------------------------------

    #[test]
    fn reuses_the_completed_body_refresh_for_both_native_arm_readers() {
        let (mut g, mut rig) = plain();
        rig.capture_proposed_body_context(&mut g, 0.0, 0.0);
        let start = passes(&rig);
        rig.apply_body_context(&mut g, 1.0, 1.0, false);
        for side in Side::BOTH {
            assert!(
                rig.arm_forward_context_from_updated_body(&mut g, side)
                    .is_some()
            );
            let (driver, anat) = rig.arm_driver_mut(side).expect("a native driver");
            driver.capture_volume_frame(&mut g, anat);
            assert_eq!(since(&rig, start), (1, 0), "{side:?}");
        }
    }

    // --- tests/motion/body/eye-compensation.test.ts --------------------------------------------

    #[test]
    fn reads_the_head_as_the_last_spine_commit_left_it() {
        let (mut g, mut rig) = plain();
        let head = bone(&rig.p, BoneSlot::Head);
        let rest = g.local_quaternion(head);
        rig.add_offset(OffsetSlot::Head, 0.01, 0.0, 0.0);
        rig.commit_spine(&mut g);
        rig.add_offset(OffsetSlot::Head, 0.02, 0.0, 0.0);
        rig.commit_spine(&mut g);
        let mut offset = Quat::default();
        assert!(rig.read_head_offset(&mut g, &mut offset));
        close(offset.angle_to(&Quat::default()), 0.03, 10);
        let mut moved = rest;
        moved.invert().multiply(&g.local_quaternion(head));
        close(moved.angle_to(&Quat::default()), 0.03, 10);
        // The eyes commit after it and leave the head where it is.
        let posed = g.local_quaternion(head);
        rig.commit_eyes(&mut g);
        assert_eq!(g.local_quaternion(head), posed);
    }

    // --- tests/motion/body/transaction.test.ts, the rig's half ---------------------------------

    #[test]
    fn starts_at_the_default_standing_pose_before_the_first_frame() {
        let (mut g, mut rig) = plain();
        let revision = rig.external_arm_revision();
        let wrists = Side::BOTH.map(|side| {
            let b = bone(&rig.p, BoneSlot::arm(ArmSlot::Hand, side));
            g.world_position(b)
        });
        let poses = standing(&mut rig, &mut g);
        assert!(rig.bootstrap_standing_pose(&mut g, &poses));
        for side in Side::BOTH {
            assert!(arm_matches_accepted(&rig, &mut g, side) < 1e-8, "{side:?}");
            let d = rig.arm_driver(side).unwrap();
            assert_eq!(d.accepted_curls, BASE_FINGERS);
            let f = d.accepted_forward;
            let pose = &poses[side as usize];
            assert!(f.u.angle_to(&pose.upper_arm) < 1e-7);
            assert!(f.l.angle_to(&pose.lower_arm) < 1e-7);
            assert!(f.h.angle_to(&pose.hand) < 1e-7);
            let hand = bone(&rig.p, BoneSlot::arm(ArmSlot::Hand, side));
            let wrist = g.world_position(hand);
            assert!(wrist.distance_to(&f.wrist) < 1e-7);
            assert!(wrists[side as usize].distance_to(&wrist) > 0.1);
        }
        assert_eq!(rig.external_arm_revision(), revision);
        // The claim is spent: a second Body leaves the pose alone.
        let arms = arm_quaternions(&g, &rig.p);
        assert!(!rig.bootstrap_standing_pose(&mut g, &poses));
        assert_eq!(arm_quaternions(&g, &rig.p), arms);
    }

    #[test]
    fn reenables_from_the_closed_fist_rendered_with_limits_disabled() {
        let (mut g, mut rig) = plain();
        rig.set_limits_enabled(&mut g, false).unwrap();
        let fist = [Some(0.7), Some(0.92), Some(0.94), Some(0.95), Some(0.96)];
        rig.curl_hand_legacy(&mut g, Side::R, &fist, &EMPTY_SPEC);
        let fingers = finger_quaternions(&g, &rig.p);
        let revision = rig.external_arm_revision();
        rig.set_limits_enabled(&mut g, true).unwrap();
        assert!(rig.limits_enabled());
        assert_eq!(rig.external_arm_revision(), revision + 1);
        assert_eq!(finger_quaternions(&g, &rig.p), fingers);
        let d = rig.arm_driver(Side::R).unwrap();
        assert_eq!(d.accepted_curls, rig.accepted_arm_state(Side::R).curls);
        assert_eq!(d.accepted_spread, rig.accepted_arm_state(Side::R).spread);
        assert!(d.accepted_curls.iter().all(|&c| c > 0.5));
        assert!(arm_matches_accepted(&rig, &mut g, Side::R) < 1e-10);
    }

    /// Body's legacy frame: both arms through the legacy chain, then the frame's close.
    fn legacy_frame(rig: &mut Rig, g: &mut Graph) {
        rig.reset(g);
        for side in Side::BOTH {
            let sign = if side == Side::R { 1.0 } else { -1.0 };
            let arm = [0.3 * sign, -0.94, 0.14];
            rig.aim_arm_legacy(g, side, &dirs(arm), 0.0, None, 1.0);
        }
        rig.finish_legacy_body_frame(g, 0.0, 0.0);
    }

    #[test]
    fn uses_the_legacy_pair_through_live_rescale_then_reseeds_once() {
        let (mut g, mut rig) = plain();
        let revision = rig.external_arm_revision();
        let qs = Side::BOTH.map(|side| accepted_q(&rig, side));
        let states = Side::BOTH.map(|side| *rig.accepted_arm_state(side));
        g.position[0..3].copy_from_slice(&[0.13, -0.04, 0.07]);
        let q = turn_y(&g.local_quaternion(ROOT), 0.37);
        g.set_local_quaternion(ROOT, &q);
        assert!(rig.begin_body_arm_frame(&mut g));

        let scale = g.local_scale(ROOT);
        let mut larger = scale;
        larger.multiply_scalar(1.2);
        g.set_local_scale(ROOT, &larger);
        assert!(!rig.begin_body_arm_frame(&mut g));
        rig.set_limits_enabled(&mut g, false).unwrap();
        assert_eq!(rig.set_limits_enabled(&mut g, true), Ok(()));
        assert!(rig.limits_enabled());
        assert_eq!(Side::BOTH.map(|side| accepted_q(&rig, side)), qs);
        assert_eq!(Side::BOTH.map(|side| *rig.accepted_arm_state(side)), states);
        assert_eq!(rig.external_arm_revision(), revision);

        legacy_frame(&mut rig, &mut g);
        assert_eq!(rig.external_arm_revision(), revision);

        g.set_local_scale(ROOT, &scale);
        assert!(!rig.begin_body_arm_frame(&mut g));
        legacy_frame(&mut rig, &mut g);
        assert_eq!(rig.external_arm_revision(), revision + 1);
        for side in Side::BOTH {
            assert!(arm_matches_accepted(&rig, &mut g, side) < 1e-10, "{side:?}");
        }
        assert!(rig.begin_body_arm_frame(&mut g));
        legacy_frame(&mut rig, &mut g);
        assert_eq!(rig.external_arm_revision(), revision + 1);
    }

    // --- tests/motion/body/leg-transport.test.ts, the rig's half -------------------------------

    #[test]
    fn separates_world_up_lift_from_articulation() {
        for scale in [1.0, 0.01] {
            let (mut g, mut rig) = build(|g, _| {
                if scale != 1.0 {
                    centimetre(g);
                }
            });
            let at =
                |g: &mut Graph, rig: &Rig, slot: BoneSlot| g.world_position(bone(&rig.p, slot));
            let before = at(&mut g, &rig, BoneSlot::Hips);
            let feet = [BoneSlot::FootL, BoneSlot::FootR].map(|f| at(&mut g, &rig, f));
            let lift = 0.06;
            let hips = bone(&rig.p, BoneSlot::Hips);
            nudge(&mut g, hips, [0.0, lift / scale, 0.0]);
            rig.plant_legs(&mut g, lift, 0.0, false);
            rig.capture_proposed_body_context(&mut g, lift, 0.0);
            for step in 0..=20 {
                let progress = f64::from(step) / 20.0;
                close(
                    rig.apply_body_context(&mut g, 0.0, progress, false),
                    lift * progress,
                    12,
                );
                let up = Vec3::new(0.0, lift * progress, 0.0);
                let mut want = before;
                want.add(&up);
                assert!(at(&mut g, &rig, BoneSlot::Hips).distance_to(&want) < 1e-7);
                for (k, f) in [BoneSlot::FootL, BoneSlot::FootR].iter().enumerate() {
                    let mut want = feet[k];
                    want.add(&up);
                    assert!(at(&mut g, &rig, *f).distance_to(&want) < 1e-7, "{scale}");
                }
            }
        }
    }

    #[test]
    fn commits_signed_transport_with_unchanged_accepted_joints_and_self_clearances() {
        for lift in [0.06, -0.03] {
            let (mut g, mut rig) = plain();
            let poses = standing(&mut rig, &mut g);
            assert!(rig.bootstrap_standing_pose(&mut g, &poses));
            let saved = Side::BOTH.map(|side| {
                let context = *rig.arm_forward_context(&mut g, side).unwrap();
                let knuckle = rig.last_accepted_hand_pose(side).unwrap().knuckle;
                let (d, anat) = rig.arm_driver_mut(side).unwrap();
                d.capture_volume_frame(&mut g, anat);
                let (q, curls, spread) = (d.accepted_q, d.accepted_curls, d.accepted_spread);
                assert!(d.validate_locked_pose(
                    anat,
                    &q,
                    &context,
                    &spec_of(&curls),
                    &spec_of(&spread),
                    DriverOutput::Bridge,
                ));
                let rows: Vec<(bool, f64)> = d
                    .bridge_output
                    .clearances
                    .iter()
                    .map(|r| (r.valid, r.distance))
                    .collect();
                (q, curls, spread, d.accepted_forward.wrist, knuckle, rows)
            });
            let hips = bone(&rig.p, BoneSlot::Hips);
            nudge(&mut g, hips, [0.0, lift, 0.0]);
            rig.plant_legs(&mut g, lift, 0.0, false);
            rig.capture_proposed_body_context(&mut g, lift, 0.0);
            for step in 0..=20 {
                rig.apply_body_context(&mut g, 0.0, f64::from(step) / 20.0, false);
                for side in Side::BOTH {
                    let (q, curls, spread, _, _, rows) = &saved[side as usize];
                    let context = *rig.arm_forward_context(&mut g, side).unwrap();
                    let (d, anat) = rig.arm_driver_mut(side).unwrap();
                    d.capture_volume_frame(&mut g, anat);
                    assert!(d.validate_locked_pose(
                        anat,
                        q,
                        &context,
                        &spec_of(curls),
                        &spec_of(spread),
                        DriverOutput::Bridge,
                    ));
                    for (row, (valid, distance)) in d.bridge_output.clearances.iter().zip(rows) {
                        assert_eq!(row.valid, *valid);
                        if row.valid {
                            close(row.distance, *distance, 10);
                        }
                    }
                }
            }
            assert!(rig.commit_arm_transport(&mut g, lift, 0.0, false));
            let delta = Vec3::new(0.0, lift, 0.0);
            for side in Side::BOTH {
                let (q, curls, spread, wrist, knuckle, _) = &saved[side as usize];
                let d = rig.arm_driver(side).unwrap();
                assert_eq!(d.accepted_q, *q);
                assert_eq!(d.accepted_curls, *curls);
                assert_eq!(d.accepted_spread, *spread);
                let mut moved = *wrist;
                moved.add(&delta);
                assert!(d.accepted_forward.wrist.distance_to(&moved) < 1e-10);
                let accepted = d.accepted_forward.wrist;
                let hand = bone(&rig.p, BoneSlot::arm(ArmSlot::Hand, side));
                assert!(g.world_position(hand).distance_to(&accepted) < 1e-10);
                let mut moved = *knuckle;
                moved.add(&delta);
                let sensed = rig.last_accepted_hand_pose(side).unwrap().knuckle;
                assert!(sensed.distance_to(&moved) < 1e-10);
                assert_eq!(rig.accepted_arm_state(side).curls, *curls);
            }
            assert!(!rig.commit_arm_transport(&mut g, lift, 0.0, false));
            // The accepted body snapshot now owns the transported frame as well.
            rig.apply_body_context(&mut g, 0.0, 0.0, false);
            for side in Side::BOTH {
                let mut moved = saved[side as usize].3;
                moved.add(&delta);
                let hand = bone(&rig.p, BoneSlot::arm(ArmSlot::Hand, side));
                assert!(g.world_position(hand).distance_to(&moved) < 1e-10);
            }
            nudge(&mut g, hips, [0.0, -lift, 0.0]);
            rig.plant_legs(&mut g, 0.0, 0.0, false);
            rig.capture_proposed_body_context(&mut g, 0.0, 0.0);
            assert!(rig.commit_arm_transport(&mut g, 0.0, 0.0, false));
            for side in Side::BOTH {
                let hand = bone(&rig.p, BoneSlot::arm(ArmSlot::Hand, side));
                assert!(g.world_position(hand).distance_to(&saved[side as usize].3) < 1e-10);
            }
        }
    }

    #[test]
    fn rejects_transport_with_a_replaced_native_evaluator() {
        let (mut g, mut rig) = plain();
        let hips = bone(&rig.p, BoneSlot::Hips);
        nudge(&mut g, hips, [0.0, 0.04, 0.0]);
        rig.plant_legs(&mut g, 0.04, 0.0, false);
        rig.capture_proposed_body_context(&mut g, 0.04, 0.0);
        rig.custom_evaluator[0] = true;
        let before = g.world_position(hips);
        let q = accepted_q(&rig, Side::L);
        assert!(!rig.commit_arm_transport(&mut g, 0.04, 0.0, false));
        assert_eq!(g.world_position(hips).distance_to(&before), 0.0);
        assert_eq!(accepted_q(&rig, Side::L), q);
    }

    #[test]
    fn rejects_signed_transport_before_accepted_history_changes() {
        // A head detached from the hips and a finger carried by a foot are hierarchy changes in
        // TS; here the profile names a node outside the hips' carry instead.
        for problem in ["detached head", "finger below leg", "failed leg solve"] {
            let (mut g, mut rig) = plain();
            let q = accepted_q(&rig, Side::L);
            let wrist = rig.arm_driver(Side::L).unwrap().accepted_forward.wrist;
            let hips = bone(&rig.p, BoneSlot::Hips);
            nudge(&mut g, hips, [0.0, 0.03, 0.0]);
            rig.plant_legs(&mut g, 0.03, 0.0, false);
            rig.capture_proposed_body_context(&mut g, 0.03, 0.0);
            match problem {
                "detached head" => rig.p.bones[BoneSlot::Head as usize] = ROOT,
                "finger below leg" => {
                    let foot = bone(&rig.p, BoneSlot::FootL);
                    rig.p.finger_bones[Finger::Middle as usize][0] = foot;
                }
                _ => {
                    // The lateral offset exceeds the leg's reach at every possible pelvis
                    // height. This exercises the real supported solver's failure result.
                    let thigh = bone(&rig.p, BoneSlot::UpperLegL);
                    nudge(&mut g, thigh, [10.0, 0.0, 0.0]);
                }
            }
            assert!(
                !rig.commit_arm_transport(&mut g, 0.03, 0.0, false),
                "{problem}"
            );
            assert_eq!(accepted_q(&rig, Side::L), q, "{problem}");
            let now = rig.arm_driver(Side::L).unwrap().accepted_forward.wrist;
            assert_eq!(now.distance_to(&wrist), 0.0, "{problem}");
        }
    }

    #[test]
    fn reconstructs_the_same_pre_plant_candidate_after_repeated_capture_and_retries() {
        let (mut g, mut rig) = plain();
        let hips = bone(&rig.p, BoneSlot::Hips);
        nudge(&mut g, hips, [0.03, -0.03, 0.0]);
        rig.plant_legs(&mut g, 0.0, 0.0, false);
        rig.capture_proposed_body_context(&mut g, 0.0, 0.0);
        rig.apply_body_context(&mut g, 1.0, 1.0, false);
        let expected = g.world_position(hips);
        for _ in 0..5 {
            rig.capture_proposed_body_context(&mut g, 0.0, 0.0);
            rig.apply_body_context(&mut g, 0.5, 1.0, false);
            rig.apply_body_context(&mut g, 1.0, 1.0, false);
            assert!(g.world_position(hips).distance_to(&expected) < 1e-12);
        }
    }

    // --- tests/rig/fingers.test.ts, the legacy splay ------------------------------------------

    #[test]
    fn keeps_the_splay_it_records_on_the_legacy_path() {
        const EXACT: f64 = 1e-9;
        let (mut g, mut rig) = plain();
        let knuckle = rig.p.finger(Finger::Index, Side::R)[0];
        let index = |amount: f64| {
            let mut spec = EMPTY_SPEC;
            spec[Finger::Index as usize] = Some(amount);
            spec
        };
        rig.set_limits_enabled(&mut g, false).unwrap();
        rig.curl_hand(&mut g, Side::R, &index(0.8), &EMPTY_SPEC);
        let unsplayed = g.local_quaternion(knuckle);
        rig.curl_hand(&mut g, Side::R, &index(0.8), &index(0.3));
        let splayed = g.local_quaternion(knuckle);
        // Positive control: the splay is visible on this knuckle.
        assert!(splayed.angle_to(&unsplayed) > 1e-3);

        rig.curl_hand(&mut g, Side::R, &index(0.4), &index(0.3));
        rig.curl_finger(&mut g, Finger::Index, Side::R, 0.8);
        assert!(g.local_quaternion(knuckle).angle_to(&splayed) < EXACT);
        let recorded = *rig.arm_state_for_body_initialization(&mut g, Side::R);
        assert_eq!(recorded.curls[Finger::Index as usize], 0.8);
        assert_eq!(recorded.spread[Finger::Index as usize], 0.3);

        // Re-enabling re-seeds the constrained arm from the record.
        rig.set_limits_enabled(&mut g, true).unwrap();
        assert!(g.local_quaternion(knuckle).angle_to(&splayed) < 1e-6);
    }

    // --- tests/rig/arm-static.test.ts ---------------------------------------------------------

    #[test]
    fn restores_the_clavicle_and_driver_when_an_aim_is_invalid() {
        let (mut g, mut rig) = plain();
        let arms = arm_quaternions(&g, &rig.p);
        let before = snapshot(&rig, Side::R);
        let revision = rig.external_arm_revision();
        assert!(!rig.aim_arm(&mut g, Side::R, &dirs([f64::NAN, 0.2, 0.9]), 0.0, None, 1.0));
        assert_eq!(arm_quaternions(&g, &rig.p), arms);
        assert_eq!(snapshot(&rig, Side::R), before);
        assert_eq!(rig.external_arm_revision(), revision);
    }

    #[test]
    fn does_not_partially_reenable_when_the_second_arm_cannot_be_seeded() {
        let (mut g, mut rig) = plain();
        rig.set_limits_enabled(&mut g, false).unwrap();
        rig.aim_arm(&mut g, Side::L, &dirs([-0.42, -0.79, 0.44]), 0.0, None, 1.0);
        let arms = arm_quaternions(&g, &rig.p);
        let qs = Side::BOTH.map(|side| accepted_q(&rig, side));
        let revision = rig.external_arm_revision();
        let states = Side::BOTH.map(|side| *rig.accepted_arm_state(side));
        // The left arm preflights first and mutates its driver's temporary seed.
        // The right context then fails, exercising rollback after partial staging.
        rig.p.limb[Side::R as usize].upper = Some(0.0);
        assert_eq!(
            rig.set_limits_enabled(&mut g, true),
            Err(LimitsRefusal::NoFeasiblePose)
        );
        assert!(!rig.limits_enabled());
        assert_eq!(arm_quaternions(&g, &rig.p), arms);
        assert_eq!(Side::BOTH.map(|side| accepted_q(&rig, side)), qs);
        assert_eq!(rig.external_arm_revision(), revision);
        assert_eq!(Side::BOTH.map(|side| *rig.accepted_arm_state(side)), states);
    }

    #[test]
    fn reenables_from_the_displayed_pose_and_publishes_one_revision() {
        let (mut g, mut rig) = plain();
        rig.set_limits_enabled(&mut g, false).unwrap();
        rig.aim_arm(&mut g, Side::R, &dirs([0.38, -0.79, 0.48]), 0.0, None, 1.0);
        let revision = rig.external_arm_revision();
        rig.set_limits_enabled(&mut g, true).unwrap();
        assert!(rig.limits_enabled());
        assert_eq!(rig.external_arm_revision(), revision + 1);
        assert!(accepted_q(&rig, Side::R).iter().all(|v| v.is_finite()));
        let hand = bone(&rig.p, BoneSlot::HandR);
        g.update_world_matrix(hand, true, false, false);
        let d = rig.arm_driver(Side::R).unwrap();
        assert!(
            g.world_quaternion(hand)
                .angle_to(&d.accepted_forward.hand_world)
                < 1e-8
        );
        assert!(d.output.max_violation <= 2e-10);
    }

    #[test]
    fn refreshes_a_moved_ancestor_and_rejects_an_equal_length_shear() {
        let (mut g, mut rig) = plain();
        let q = accepted_q(&rig, Side::R);
        let revision = rig.external_arm_revision();
        // Leave the ancestor's world stale: the support check must refresh the external chain.
        wrap_root(&mut g, [0.2, -0.1, 0.07], true, None);
        rotate_ancestor_y(&mut g, 0.41);
        assert!(rig.begin_body_arm_frame(&mut g));

        // The first two columns both have unit length, but their dot product is 0.1.
        // A scale-only check would accept this shear and the calibrated FK would not.
        let shear = [
            0.9949874371,
            0.1,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
        ];
        g.ancestors[13..29].copy_from_slice(&shear);
        g.ancestor_flags[0] = flag::MATRIX_WORLD_AUTO_UPDATE | flag::MATRIX_WORLD_NEEDS_UPDATE;
        assert!(!rig.begin_body_arm_frame(&mut g));

        rig.set_limits_enabled(&mut g, false).unwrap();
        assert_eq!(rig.set_limits_enabled(&mut g, true), Ok(()));
        assert!(rig.limits_enabled());
        assert_eq!(accepted_q(&rig, Side::R), q);
        assert_eq!(rig.external_arm_revision(), revision);

        // The legacy chain takes the aim: the accepted history is not touched by it.
        assert!(rig.aim_arm(&mut g, Side::R, &dirs([0.38, -0.79, 0.48]), 0.0, None, 1.0));
        assert_eq!(accepted_q(&rig, Side::R), q);
        assert_eq!(rig.external_arm_revision(), revision + 1);
    }

    #[test]
    fn uses_the_legacy_frame_for_nonuniform_scale_and_reflection() {
        for scale in [[1.0, 1.1, 1.0], [-1.0, 1.0, 1.0]] {
            let (mut g, mut rig) = plain();
            g.set_local_scale(ROOT, &v(scale));
            assert!(!rig.begin_body_arm_frame(&mut g));
            assert!(rig.limits_enabled());
        }
    }

    #[test]
    fn does_not_replace_an_official_static_pose_when_body_bootstraps() {
        let (mut g, mut rig) = plain();
        let curls = [Some(0.2), Some(0.3), Some(0.4), Some(0.5), Some(0.6)];
        assert!(rig.aim_arm(&mut g, Side::R, &dirs([0.38, -0.79, 0.48]), 0.0, None, 1.0));
        assert!(rig.curl_hand(&mut g, Side::R, &curls, &EMPTY_SPEC));
        let revision = rig.external_arm_revision();
        let arms = arm_quaternions(&g, &rig.p);
        let fingers = finger_quaternions(&g, &rig.p);
        let states = Side::BOTH.map(|side| *rig.accepted_arm_state(side));
        let poses = standing(&mut rig, &mut g);
        assert!(!rig.bootstrap_standing_pose(&mut g, &poses));
        assert_eq!(rig.external_arm_revision(), revision);
        assert_eq!(arm_quaternions(&g, &rig.p), arms);
        assert_eq!(finger_quaternions(&g, &rig.p), fingers);
        assert_eq!(Side::BOTH.map(|side| *rig.accepted_arm_state(side)), states);
    }

    #[test]
    fn consumes_the_bootstrap_claim_and_rolls_back_both_shoulders_on_a_failed_preflight() {
        let (mut g, mut rig) = plain();
        let arms = arm_quaternions(&g, &rig.p);
        let fingers = finger_quaternions(&g, &rig.p);
        let qs = Side::BOTH.map(|side| accepted_q(&rig, side));
        let revision = rig.external_arm_revision();
        let poses = standing(&mut rig, &mut g);
        let length = rig.p.limb[Side::R as usize].upper;
        rig.p.limb[Side::R as usize].upper = Some(0.0);
        assert!(!rig.bootstrap_standing_pose(&mut g, &poses));
        assert_eq!(arm_quaternions(&g, &rig.p), arms);
        assert_eq!(finger_quaternions(&g, &rig.p), fingers);
        assert_eq!(Side::BOTH.map(|side| accepted_q(&rig, side)), qs);
        assert_eq!(rig.external_arm_revision(), revision);

        rig.p.limb[Side::R as usize].upper = length;
        assert!(!rig.bootstrap_standing_pose(&mut g, &poses));
        assert_eq!(arm_quaternions(&g, &rig.p), arms);
        assert_eq!(finger_quaternions(&g, &rig.p), fingers);
        assert_eq!(rig.external_arm_revision(), revision);
    }

    #[test]
    fn preserves_the_current_pose_when_the_first_bootstrap_cannot_run() {
        for case in ["limits disabled", "unsupported live scale"] {
            let (mut g, mut rig) = plain();
            if case == "limits disabled" {
                rig.set_limits_enabled(&mut g, false).unwrap();
            } else {
                g.set_local_scale(ROOT, &Vec3::new(1.1, 1.0, 1.0));
            }
            let arms = arm_quaternions(&g, &rig.p);
            let fingers = finger_quaternions(&g, &rig.p);
            let revision = rig.external_arm_revision();
            let poses = standing(&mut rig, &mut g);
            assert!(!rig.bootstrap_standing_pose(&mut g, &poses), "{case}");
            assert_eq!(arm_quaternions(&g, &rig.p), arms, "{case}");
            assert_eq!(finger_quaternions(&g, &rig.p), fingers, "{case}");
            assert_eq!(rig.external_arm_revision(), revision, "{case}");
        }
    }

    // --- tests/rig/arm-twists-lifecycle.test.ts, the rig's half --------------------------------

    fn sideways(side: Side) -> [Option<Vec3>; 4] {
        let sign = if side == Side::L { -1.0 } else { 1.0 };
        [Some(Vec3::new(sign, 0.0, 0.0)); 4]
    }

    /// The profile's bones as posed, and what the rig accepted, sensed and measured.
    fn canonical(rig: &mut Rig, g: &mut Graph) -> Vec<u64> {
        g.update_matrix_world(ROOT, true);
        let mut out = Vec::new();
        let nodes: Vec<u32> = rig
            .p
            .bones
            .iter()
            .chain(rig.p.finger_bones.iter().flatten())
            .copied()
            .filter(|&b| b != NO_NODE)
            .collect();
        for b in nodes {
            let i = b as usize;
            out.extend(bits(&g.position[3 * i..3 * i + 3]));
            out.extend(bits(&g.quaternion[4 * i..4 * i + 4]));
            out.extend(bits(&g.scale[3 * i..3 * i + 3]));
            out.extend(bits(&g.matrix[16 * i..16 * i + 16]));
            out.extend(bits(&g.matrix_world[16 * i..16 * i + 16]));
        }
        for side in Side::BOTH {
            let mut v = Vec::new();
            let s = rig.accepted_arm_state(side);
            for d in &s.directions {
                v.extend(d);
            }
            v.extend(s.palm);
            v.extend(s.curls);
            v.extend(s.spread);
            v.push(s.forearm_roll);
            if let Some(d) = snapshot(rig, side) {
                v.extend(d.q);
                v.extend(d.curls);
                v.extend(d.spread);
                v.push(d.roll_history);
            }
            for p in rig.finger_shape(side) {
                v.extend([p.x, p.y, p.z]);
            }
            if let Some(rows) = rig.measure(g, side) {
                for r in rows {
                    v.extend([r.deg, r.strain]);
                }
            }
            out.extend(bits(&v));
        }
        out.push(rig.external_arm_revision());
        out
    }

    #[test]
    fn stages_the_legacy_roll_and_resets_the_helpers_after_the_legacy_frame() {
        for side in Side::BOTH {
            let (mut g, mut rig) = plain();
            rig.set_limits_enabled(&mut g, false).unwrap();
            let upper = rig.p.arm_twists[side as usize].unwrap();
            let lower = rig.p.arm_twists[2 + side as usize].unwrap();
            let upper_rest = g.local_quaternion(upper.helper);
            let lower_rest = g.local_quaternion(lower.helper);
            let angle = 80.0 * (core::f64::consts::PI / 180.0);
            let axis = rest_dir(&rig.p, BoneSlot::arm(ArmSlot::LowerArm, side));
            let mut palm = rig.palm_local()[side as usize].unwrap();
            palm.apply_axis_angle(&axis, angle);
            rig.aim_arm_legacy(&mut g, side, &sideways(side), 0.0, Some(&palm), 1.0);
            let twist = |share: f64, rest: &Quat| {
                let mut q = *Quat::default().set_from_axis_angle(&axis, angle * share);
                *q.multiply(rest)
            };
            assert!(
                g.local_quaternion(upper.helper)
                    .angle_to(&twist(0.3, &upper_rest))
                    < 1e-7
            );
            assert!(
                g.local_quaternion(lower.helper)
                    .angle_to(&twist(0.2, &lower_rest))
                    < 1e-7
            );
            rig.finish_legacy_body_frame(&mut g, 0.0, 0.0);
            rig.reset(&mut g);
            assert_eq!(g.local_quaternion(upper.helper), upper_rest);
            assert_eq!(g.local_quaternion(lower.helper), lower_rest);
        }
    }

    #[test]
    fn keeps_primary_and_finger_transforms_identical_with_and_without_helpers() {
        for constrained in [false, true] {
            let (mut ga, mut actual) = plain();
            let (mut gb, mut control) = build(|_, p| p.arm_twists = [None; 4]);
            for (g, rig) in [(&mut ga, &mut actual), (&mut gb, &mut control)] {
                rig.set_limits_enabled(g, constrained).unwrap();
                let poses = standing(rig, g);
                rig.bootstrap_standing_pose(g, &poses);
            }
            assert_eq!(
                canonical(&mut actual, &mut ga),
                canonical(&mut control, &mut gb)
            );
            for (g, rig) in [(&mut ga, &mut actual), (&mut gb, &mut control)] {
                let mut d = sideways(Side::R);
                d[2] = Some(Vec3::new(0.8, -0.2, 0.4));
                d[3] = Some(Vec3::new(0.6, 0.1, 0.7));
                rig.aim_arm(g, Side::R, &d, 0.8, None, 1.0);
                let mut curls = EMPTY_SPEC;
                curls[Finger::Index as usize] = Some(0.8);
                curls[Finger::Little as usize] = Some(0.2);
                rig.curl_hand(g, Side::R, &curls, &EMPTY_SPEC);
            }
            assert_eq!(
                canonical(&mut actual, &mut ga),
                canonical(&mut control, &mut gb),
                "constrained={constrained}"
            );
        }
    }

    #[test]
    fn accepts_bootstrap_static_and_paired_success_but_never_staging_or_rejection() {
        use TwistCall::{Accept, Stage};
        let (mut g, mut rig) = plain();
        let poses = standing(&mut rig, &mut g);
        rig.twist_calls.clear();
        assert!(rig.bootstrap_standing_pose(&mut g, &poses));
        let accepted: Vec<_> = rig
            .twist_calls
            .iter()
            .filter(|c| matches!(c, Accept(_)))
            .copied()
            .collect();
        assert_eq!(accepted, [Accept(Side::L), Accept(Side::R)]);

        rig.twist_calls.clear();
        let forward = rig.arm_driver(Side::R).unwrap().accepted_forward;
        assert!(rig.stage_arm_forward(&mut g, Side::R, &forward, &EMPTY_SPEC, &EMPTY_SPEC));
        assert_eq!(rig.twist_calls, [Stage(Side::R)]);

        rig.twist_calls.clear();
        assert!(!rig.aim_arm(&mut g, Side::R, &dirs([f64::NAN, 0.0, 0.0]), 0.0, None, 1.0));
        assert!(!rig.twist_calls.iter().any(|c| matches!(c, Accept(_))));

        rig.twist_calls.clear();
        let mut index = EMPTY_SPEC;
        index[Finger::Index as usize] = Some(0.2);
        assert!(rig.curl_hand(&mut g, Side::R, &index, &EMPTY_SPEC));
        assert_eq!(rig.twist_calls.last(), Some(&Accept(Side::R)));
        assert_eq!(
            rig.twist_calls
                .iter()
                .filter(|c| matches!(c, Accept(_)))
                .count(),
            1
        );

        let plans = accepted_plans(&mut rig, &mut g, false);
        rig.twist_calls.clear();
        assert!(rig.commit_arm_frame(&mut g, &plans, 0.0, 0.0, false));
        assert_eq!(
            rig.twist_calls[rig.twist_calls.len() - 2..],
            [Accept(Side::L), Accept(Side::R)]
        );

        rig.twist_calls.clear();
        rig.p.bones[BoneSlot::HandR as usize] = NO_NODE;
        assert!(!rig.commit_arm_frame(&mut g, &plans, 0.0, 0.0, false));
        assert!(rig.twist_calls.is_empty());
    }

    #[test]
    fn does_not_accept_a_failed_bootstrap_or_limit_reentry_preflight() {
        use TwistCall::Accept;
        let (mut g, mut rig) = plain();
        let poses = standing(&mut rig, &mut g);
        rig.twist_calls.clear();
        rig.p.limb[Side::R as usize].upper = Some(0.0);
        assert!(!rig.bootstrap_standing_pose(&mut g, &poses));
        assert!(!rig.twist_calls.iter().any(|c| matches!(c, Accept(_))));
        rig.set_limits_enabled(&mut g, false).unwrap();
        assert!(rig.set_limits_enabled(&mut g, true).is_err());
        assert!(!rig.twist_calls.iter().any(|c| matches!(c, Accept(_))));
        // A completed legacy frame is accepted even if constrained re-seeding cannot succeed.
        rig.finish_legacy_body_frame(&mut g, 0.0, 0.0);
        assert_eq!(rig.twist_calls, [Accept(Side::L), Accept(Side::R)]);
    }

    #[test]
    fn stages_signed_transport_without_accepting_helper_history() {
        use TwistCall::Stage;
        for lift in [0.02, -0.02] {
            let (mut g, mut rig) = plain();
            let poses = standing(&mut rig, &mut g);
            assert!(rig.bootstrap_standing_pose(&mut g, &poses));
            let helper = rig.p.arm_twists[3].unwrap().helper;
            let before = g.world_position(helper);
            let q = accepted_q(&rig, Side::R);
            let hips = bone(&rig.p, BoneSlot::Hips);
            nudge(&mut g, hips, [0.0, lift, 0.0]);
            rig.plant_legs(&mut g, lift, 0.0, false);
            rig.capture_proposed_body_context(&mut g, lift, 0.0);
            rig.twist_calls.clear();
            assert!(rig.commit_arm_transport(&mut g, lift, 0.0, false));
            assert_eq!(rig.twist_calls, [Stage(Side::L), Stage(Side::R)]);
            assert_eq!(accepted_q(&rig, Side::R), q);
            let mut moved = before;
            moved.add(&Vec3::new(0.0, lift, 0.0));
            assert!(g.world_position(helper).distance_to(&moved) < 1e-10);
            rig.twist_calls.clear();
            assert!(!rig.commit_arm_transport(&mut g, lift, 0.0, false));
            assert!(rig.twist_calls.is_empty());
        }
    }

    #[test]
    fn stages_finger_clearance_and_accepts_external_legacy_writes() {
        use TwistCall::{Accept, Stage};
        let (mut g, mut rig) = plain();
        rig.set_limits_enabled(&mut g, false).unwrap();
        rig.twist_calls.clear();
        let mut index = EMPTY_SPEC;
        index[Finger::Index as usize] = Some(0.9);
        rig.curl_hand_legacy(&mut g, Side::R, &index, &EMPTY_SPEC);
        assert_eq!(rig.twist_calls, [Stage(Side::R)]);
        rig.twist_calls.clear();
        rig.p.bones[BoneSlot::UpperArmR as usize] = NO_NODE;
        index[Finger::Index as usize] = Some(0.5);
        rig.curl_hand(&mut g, Side::R, &index, &EMPTY_SPEC);
        assert_eq!(
            rig.twist_calls
                .iter()
                .filter(|c| matches!(c, Accept(_)))
                .copied()
                .collect::<Vec<_>>(),
            [Accept(Side::R)]
        );
        rig.twist_calls.clear();
        rig.finish_legacy_body_frame(&mut g, 0.0, 0.0);
        assert_eq!(rig.twist_calls, [Accept(Side::L), Accept(Side::R)]);
    }

    /// `tests/corpora/rig-battery-*`: every call the director's layers make into the base
    /// avatar's TS `Rig`, its anatomy, its face and its arm drivers through a few short scripts,
    /// with what the other layers did to the tree in between, replayed on the port. See
    /// `record-corpora.test.ts`.
    pub(crate) mod battery {
        use super::*;
        use crate::anatomy::strain::StrainZone;
        use crate::corpus_replay::Corpus;
        use crate::profile::base;
        use crate::rig::arm_driver::DriverOutput;
        use crate::rig::arm_path::plan::{ArmPathPlanOutput, ArmPathRequest};
        use crate::rig::hand_geometry::{ContactSurface, PalmRegion};
        use crate::rig::testkit::{
            Stream, configuration_of, configuration_values, context_of, context_values,
            forward_values, graph_hash, halves, hash_halves,
        };
        use crate::scene::graph::flag;

        /// The record tags; the last three are the motion battery's, which [`replay`] hands on.
        const TAGS: [&str; 12] = [
            "begin", "new", "rig", "anat", "face", "driver", "dt", "frame", "end", "txNew", "tx",
            "axes",
        ];
        const METHODS: [&str; 38] = [
            "acceptedArmState",
            "bootstrapStandingPose",
            "armStateForBodyInitialization",
            "armDriver",
            "predictHandContact",
            "beginBodyArmFrame",
            "finishLegacyBodyFrame",
            "armForwardContext",
            "armForwardContextFromUpdatedBody",
            "captureProposedBodyContext",
            "applyBodyContext",
            "stageArmForward",
            "commitArmFrame",
            "commitArmTransport",
            "lastAcceptedHandPose",
            "reset",
            "addOffset",
            "commitSpine",
            "readHeadOffset",
            "commitEyes",
            "plantLegs",
            "girdleRoom",
            "turnGirdle",
            "aimShoulder",
            "aimArm",
            "aimArmLegacy",
            "measure",
            "solveReachNatural",
            "solvePoint",
            "solveReach",
            "curlFinger",
            "curlHand",
            "curlFingerLegacy",
            "curlHandLegacy",
            "fingerClearance",
            "fingerShape",
            "fingerFrame",
            "limitsEnabled",
        ];
        /// The calls that neither read nor write the tree, recorded without a diff or a state.
        const READS: [&str; 8] = [
            "acceptedArmState",
            "armDriver",
            "lastAcceptedHandPose",
            "addOffset",
            "fingerClearance",
            "fingerShape",
            "fingerFrame",
            "turnGirdle",
        ];
        const DRIVER_METHODS: [&str; 9] = [
            "captureVolumeFrame",
            "composeRequest",
            "configurationFromPose",
            "fillBounds",
            "planFrom",
            "restoreEndpointFrom",
            "validateLockedPose",
            "requestForConfiguration",
            "refreshAcceptedForward",
        ];
        /// A node's state as the recording dumps it.
        const NODE: usize = 43;

        fn files(name: &str) -> Vec<String> {
            let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/corpora");
            ('a'..='z')
                .map(|c| format!("{name}-{c}"))
                .take_while(|name| dir.join(format!("{name}.json")).exists())
                .collect()
        }

        pub(crate) fn spec(s: &mut Stream) -> FingerSpec {
            let mask = s.index();
            std::array::from_fn(|i| (mask & (1 << i) != 0).then(|| s.f64()))
        }

        fn put_spec(out: &mut Vec<f64>, spec: &FingerSpec) {
            let mask = spec
                .iter()
                .enumerate()
                .filter(|(_, v)| v.is_some())
                .fold(0, |m, (i, _)| m | (1 << i));
            out.push(f64::from(mask));
            out.extend(spec.iter().flatten());
        }

        fn put_opt_vec(out: &mut Vec<f64>, v: Option<&Vec3>) {
            match v {
                Some(v) => out.extend([1.0, v.x, v.y, v.z]),
                None => out.push(0.0),
            }
        }

        pub(crate) fn put_vec(out: &mut Vec<f64>, v: &Vec3) {
            out.extend([v.x, v.y, v.z]);
        }

        fn forward_of(s: &mut Stream) -> ArmForwardResult {
            ArmForwardResult {
                u: s.vec3(),
                l: s.vec3(),
                h: s.vec3(),
                palm: s.vec3(),
                elbow: s.vec3(),
                wrist: s.vec3(),
                upper_world: s.quat(),
                lower_world: s.quat(),
                hand_world: s.quat(),
                upper_local: s.quat(),
                lower_local: s.quat(),
                hand_local: s.quat(),
            }
        }

        fn solution_of(s: &mut Stream) -> ArmSolution {
            ArmSolution {
                links: ReachLinks {
                    upper_arm: s.vec3(),
                    lower_arm: s.vec3(),
                },
                hand: s.vec3(),
                palm: s.vec3(),
                tip: s.vec3(),
                twist: s.f64(),
                strain: s.flag().then(|| s.f64()),
                swivel_dir: s.vec3(),
                clasp: s.flag().then(|| s.flag()),
            }
        }

        fn put_solution(out: &mut Vec<f64>, o: &ArmSolution) {
            for v in [o.links.upper_arm, o.links.lower_arm, o.hand, o.palm, o.tip] {
                put_vec(out, &v);
            }
            out.push(o.twist);
            match o.strain {
                Some(v) => out.extend([1.0, v]),
                None => out.push(0.0),
            }
            put_vec(out, &o.swivel_dir);
            match o.clasp {
                Some(v) => out.extend([1.0, f64::from(u8::from(v))]),
                None => out.push(0.0),
            }
        }

        fn put_arm_state(out: &mut Vec<f64>, s: &AcceptedArmState) {
            for d in &s.directions {
                out.extend(d);
            }
            out.extend(s.palm);
            out.extend(s.curls);
            out.extend(s.spread);
            out.push(s.forearm_roll);
        }

        fn put_sense(out: &mut Vec<f64>, pose: Option<&HandSensePose>) {
            match pose {
                Some(p) => {
                    out.push(1.0);
                    for v in [p.knuckle, p.palm, p.forearm, p.index, p.little] {
                        put_vec(out, &v);
                    }
                }
                None => out.push(0.0),
            }
        }

        fn put_request(out: &mut Vec<f64>, r: &ArmPathRequest) {
            put_vec(out, &r.wrist);
            put_vec(out, &r.hand);
            put_opt_vec(out, r.palm.as_ref());
            put_spec(out, &r.curls);
            put_spec(out, &r.spread);
            put_opt_vec(out, r.elbow.as_ref());
        }

        fn put_plan(out: &mut Vec<f64>, o: &ArmPathPlanOutput) {
            out.extend(o.q);
            out.extend(configuration_values(&o.configuration));
            out.extend(forward_values(&o.forward));
            out.push(o.status as usize as f64);
            out.extend([
                o.position_error,
                o.orientation_error,
                o.secondary_error,
                o.max_violation,
                o.iterations as f64,
                o.environment_batches as f64,
                o.points.len() as f64,
            ]);
            for p in &o.points {
                put_vec(out, &p.position);
            }
            out.push(o.clearances.len() as f64);
            for r in &o.clearances {
                out.extend([
                    r.point_index.map_or(-1.0, |p| p as f64),
                    f64::from(u8::from(r.valid)),
                    r.distance,
                    r.normal.x,
                    r.normal.y,
                    r.normal.z,
                ]);
            }
        }

        /// `rigStateValues`: what the rig keeps that a caller can see or a later call reads.
        pub(crate) fn state_values(rig: &Rig) -> Vec<f64> {
            let b = |v: bool| f64::from(u8::from(v));
            let mut v = vec![
                b(rig.limits_enabled),
                b(rig.arm_continuation_ready),
                rig.external_arm_revision as f64,
                rig.accepted_rise,
                rig.accepted_turn,
                b(rig.last_plant_success),
                b(rig.standing_bootstrap_claimed),
                rig.dt,
                rig.fore_roll[0],
                rig.fore_roll[1],
                rig.upper_roll[0],
                rig.upper_roll[1],
            ];
            for x in [rig.anat.up(), rig.anat.right(), rig.anat.fwd()] {
                put_vec(&mut v, x);
            }
            for side in Side::BOTH {
                let s = side as usize;
                put_arm_state(&mut v, &rig.accepted_arm_state[s]);
                v.extend(rig.posed_curls[s]);
                v.extend(rig.posed_spread[s]);
                put_sense(&mut v, rig.last_accepted_hand_pose(side));
                let Some(d) = rig.arm_drivers[s].as_ref() else {
                    v.push(0.0);
                    continue;
                };
                v.push(1.0);
                v.extend(d.accepted_q);
                v.extend(configuration_values(&d.accepted_configuration));
                v.extend(d.accepted_curls);
                v.extend(d.accepted_spread);
                v.push(d.request_roll_history());
                v.extend(forward_values(&d.accepted_forward));
                v.extend(d.output.q);
                v.extend(d.bridge_output.q);
                v.extend(d.target_q);
            }
            for pose in [&rig.accepted_body_pose, &rig.proposed_body_pose] {
                for q in &pose.slots {
                    match q {
                        Some(q) => v.extend([1.0, q.x, q.y, q.z, q.w]),
                        None => v.push(0.0),
                    }
                }
                put_vec(&mut v, &pose.hips_position);
                v.extend([pose.rise, pose.turn]);
            }
            put_vec(&mut v, &rig.plant.pre_plant_hips);
            put_vec(&mut v, &rig.plant.post_plant_hips);
            for q in [rig.plant.pre_turn_hips_q, rig.plant.post_turn_hips_q] {
                v.extend([q.x, q.y, q.z, q.w]);
            }
            v
        }

        /// Write one node's recorded parts: TRS, matrix, matrixWorld, the flag, by `mask`.
        pub(crate) fn write_parts(g: &mut Graph, i: usize, mask: usize, s: &mut Stream) {
            if mask & 1 != 0 {
                g.position[3 * i..3 * i + 3].copy_from_slice(s.take(3));
                g.quaternion[4 * i..4 * i + 4].copy_from_slice(s.take(4));
                g.scale[3 * i..3 * i + 3].copy_from_slice(s.take(3));
            }
            if mask & 2 != 0 {
                g.matrix[16 * i..16 * i + 16].copy_from_slice(s.take(16));
            }
            if mask & 4 != 0 {
                g.matrix_world[16 * i..16 * i + 16].copy_from_slice(s.take(16));
            }
            if mask & 8 != 0 {
                if s.flag() {
                    g.flags[i] |= flag::MATRIX_WORLD_NEEDS_UPDATE;
                } else {
                    g.flags[i] &= !flag::MATRIX_WORLD_NEEDS_UPDATE;
                }
            }
        }

        /// What the other layers changed since the last record.
        pub(crate) fn apply_diff(g: &mut Graph, s: &mut Stream) {
            for _ in 0..s.index() {
                let i = s.index();
                let mask = s.index();
                write_parts(g, i, mask, s);
            }
        }

        /// The last context each side's driver calls carried.
        struct Contexts([Option<ArmForwardContext>; 2]);

        impl Contexts {
            fn read(&mut self, s: &mut Stream, side: Side) -> ArmForwardContext {
                if s.flag() {
                    self.0[side as usize] = Some(context_of(s));
                }
                self.0[side as usize].expect("a context before its repeat")
            }
        }

        fn arm(s: &mut Stream) -> [Option<Vec3>; 4] {
            std::array::from_fn(|_| s.opt_vec3())
        }

        fn contact(s: &mut Stream) -> HandContact {
            let surface = |s: &mut Stream| {
                s.flag().then(|| {
                    [
                        ContactSurface::Center,
                        ContactSurface::Pad,
                        ContactSurface::Back,
                    ][s.index()]
                })
            };
            if s.index() == 0 {
                let region = [PalmRegion::Heel, PalmRegion::Center][s.index()];
                HandContact::Palm {
                    region,
                    surface: surface(s),
                }
            } else {
                let finger = Finger::ALL[s.index()];
                let segment = s.f64() as u8;
                let fraction = s.f64();
                HandContact::Finger {
                    finger,
                    segment,
                    fraction,
                    surface: surface(s),
                }
            }
        }

        /// A plan output's `q` and `forward` as a commit is handed them.
        fn plan_reference(rig: &Rig, s: &mut Stream, side: Side) -> ([f64; 7], ArmForwardResult) {
            let driver = rig.arm_drivers[side as usize].as_ref();
            match s.index() {
                0 => {
                    let o = &driver.expect("a driver").output;
                    (o.q, o.forward)
                }
                1 => {
                    let o = &driver.expect("a driver").bridge_output;
                    (o.q, o.forward)
                }
                4 => (s.q(), forward_of(s)),
                k => panic!("{}: plan reference {k}", s.what),
            }
        }

        fn forward_reference(rig: &Rig, s: &mut Stream, side: Side) -> ArmForwardResult {
            let driver = rig.arm_drivers[side as usize].as_ref();
            match s.index() {
                0 => driver.expect("a driver").output.forward,
                1 => driver.expect("a driver").bridge_output.forward,
                2 => driver.expect("a driver").accepted_forward,
                4 => forward_of(s),
                k => panic!("{}: forward reference {k}", s.what),
            }
        }

        fn context_reference(rig: &Rig, s: &mut Stream, side: Side) -> ArmForwardContext {
            match s.index() {
                3 => rig.arm_contexts[side as usize],
                4 => context_of(s),
                k => panic!("{}: context reference {k}", s.what),
            }
        }

        /// Replay one `Rig` call; its output values as the recording hashes them.
        fn rig_call(rig: &mut Rig, g: &mut Graph, method: &str, s: &mut Stream) -> Vec<f64> {
            let mut out = Vec::new();
            let b = |v: bool| f64::from(u8::from(v));
            match method {
                "acceptedArmState" => {
                    let side = s.side();
                    put_arm_state(&mut out, rig.accepted_arm_state(side));
                }
                "bootstrapStandingPose" => {
                    let poses = [(); 2].map(|_| {
                        let [shoulder, upper_arm, lower_arm, hand, palm] =
                            [(); 5].map(|_| s.vec3());
                        let curls = spec(s);
                        let spread = spec(s);
                        StandingArmPose {
                            shoulder,
                            upper_arm,
                            lower_arm,
                            hand,
                            palm,
                            curls,
                            spread,
                        }
                    });
                    out.push(b(rig.bootstrap_standing_pose(g, &poses)));
                }
                "armStateForBodyInitialization" => {
                    let side = s.side();
                    let state = *rig.arm_state_for_body_initialization(g, side);
                    put_arm_state(&mut out, &state);
                }
                "armDriver" => match rig.arm_driver(s.side()) {
                    Some(d) => {
                        out.push(1.0);
                        out.extend(d.accepted_q);
                    }
                    None => out.push(0.0),
                },
                "predictHandContact" => {
                    let side = s.side();
                    let selector = contact(s);
                    let curls = spec(s);
                    let spread = spec(s);
                    match rig.predict_hand_contact(g, side, &selector, &curls, &spread) {
                        Some(p) => {
                            out.push(1.0);
                            put_vec(&mut out, &p.contact);
                            out.push(p.sample.points.len() as f64);
                            for point in &p.sample.points {
                                put_vec(&mut out, &point.position);
                            }
                            out.extend(p.bind_frame.elements);
                        }
                        None => out.push(0.0),
                    }
                }
                "beginBodyArmFrame" => out.push(b(rig.begin_body_arm_frame(g))),
                "finishLegacyBodyFrame" => {
                    let (rise, turn) = (s.f64(), s.f64());
                    rig.finish_legacy_body_frame(g, rise, turn);
                }
                "armForwardContext" | "armForwardContextFromUpdatedBody" => {
                    let side = s.side();
                    let context = if method == "armForwardContext" {
                        rig.arm_forward_context(g, side)
                    } else {
                        rig.arm_forward_context_from_updated_body(g, side)
                    };
                    match context {
                        Some(c) => {
                            out.push(1.0);
                            out.extend(context_values(c));
                        }
                        None => out.push(0.0),
                    }
                }
                "captureProposedBodyContext" => {
                    let (rise, turn) = (s.f64(), s.f64());
                    rig.capture_proposed_body_context(g, rise, turn);
                }
                "applyBodyContext" => {
                    let (alpha, transport, after) = (s.f64(), s.f64(), s.flag());
                    out.push(rig.apply_body_context(g, alpha, transport, after));
                }
                "stageArmForward" => {
                    let side = s.side();
                    let forward = forward_reference(rig, s, side);
                    let curls = spec(s);
                    let spread = spec(s);
                    out.push(b(rig.stage_arm_forward(g, side, &forward, &curls, &spread)));
                }
                "commitArmFrame" => {
                    let plans = Side::BOTH.map(|side| {
                        let (q, forward) = plan_reference(rig, s, side);
                        let context = context_reference(rig, s, side);
                        let curls = spec(s);
                        let spread = spec(s);
                        ArmFrameSideCommit {
                            q,
                            forward,
                            context,
                            curls,
                            spread,
                        }
                    });
                    let (rise, turn, after) = (s.f64(), s.f64(), s.flag());
                    out.push(b(rig.commit_arm_frame(g, &plans, rise, turn, after)));
                }
                "commitArmTransport" => {
                    let (lift, turn, after) = (s.f64(), s.f64(), s.flag());
                    out.push(b(rig.commit_arm_transport(g, lift, turn, after)));
                }
                "lastAcceptedHandPose" => {
                    let side = s.side();
                    put_sense(&mut out, rig.last_accepted_hand_pose(side));
                }
                "reset" => rig.reset(g),
                "addOffset" => {
                    let slot = OffsetSlot::ALL[s.index()];
                    let [x, y, z] = [s.f64(), s.f64(), s.f64()];
                    rig.add_offset(slot, x, y, z);
                }
                "commitSpine" => rig.commit_spine(g),
                "readHeadOffset" => {
                    let mut q = Quat::default();
                    let ok = rig.read_head_offset(g, &mut q);
                    out.push(b(ok));
                    if ok {
                        out.extend([q.x, q.y, q.z, q.w]);
                    }
                }
                "commitEyes" => rig.commit_eyes(g),
                "plantLegs" => {
                    let (rise, turn, after) = (s.f64(), s.f64(), s.flag());
                    rig.plant_legs(g, rise, turn, after);
                }
                "girdleRoom" => {
                    let side = s.side();
                    let target = s.vec3();
                    let d = s.vec3();
                    let weight = s.f64();
                    let mut turn = s.vec3();
                    rig.girdle_room(g, side, &target, &[d.x, d.y, d.z], weight, &mut turn);
                    put_vec(&mut out, &turn);
                }
                "turnGirdle" => {
                    let d = s.vec3();
                    let turn = s.vec3();
                    let mut dir = [d.x, d.y, d.z];
                    rig.turn_girdle(&mut dir, &turn);
                    out.extend(dir);
                }
                "aimShoulder" => {
                    let side = s.side();
                    let dir = s.opt_vec3();
                    rig.aim_shoulder(g, side, dir.as_ref());
                }
                "aimArm" | "aimArmLegacy" => {
                    let side = s.side();
                    let dirs = arm(s);
                    let twist = s.f64();
                    let palm = s.opt_vec3();
                    let weight = s.f64();
                    if method == "aimArm" {
                        out.push(b(rig.aim_arm(g, side, &dirs, twist, palm.as_ref(), weight)));
                    } else {
                        rig.aim_arm_legacy(g, side, &dirs, twist, palm.as_ref(), weight);
                    }
                }
                "measure" => match rig.measure(g, s.side()) {
                    Some(rows) => {
                        out.extend([1.0, rows.len() as f64]);
                        for row in &rows {
                            let zone = match row.zone {
                                StrainZone::Natural => 0.0,
                                StrainZone::Strained => 1.0,
                                StrainZone::Limit => 2.0,
                            };
                            out.extend([
                                row.deg,
                                row.strain,
                                zone,
                                row.range[0],
                                row.range[1],
                                b(row.measured),
                            ]);
                        }
                    }
                    None => out.push(0.0),
                },
                "solveReachNatural" => {
                    let side = s.side();
                    let target = s.vec3();
                    let hand_dir = s.opt_vec3();
                    let mut solution = solution_of(s);
                    let pole = s.opt_vec3();
                    let ok = rig.solve_reach_natural(
                        g,
                        side,
                        &target,
                        hand_dir.as_ref(),
                        &mut solution,
                        pole.as_ref(),
                    );
                    out.push(b(ok));
                    put_solution(&mut out, &solution);
                }
                "solvePoint" => {
                    let side = s.side();
                    let request = PointRequest {
                        azimuth: s.flag().then(|| s.f64()),
                        elevation: s.flag().then(|| s.f64()),
                        extent: s.flag().then(|| s.f64()),
                        finger: s.flag().then(|| Finger::ALL[s.index()]),
                        point: s.opt_vec3(),
                        palm: s.opt_vec3(),
                    };
                    let mut solution = solution_of(s);
                    out.push(b(rig.solve_point(g, side, &request, &mut solution)));
                    put_solution(&mut out, &solution);
                }
                "solveReach" => {
                    let side = s.side();
                    let target = s.vec3();
                    let angle = s.f64();
                    let mut links = ReachLinks {
                        upper_arm: s.vec3(),
                        lower_arm: s.vec3(),
                    };
                    let framed = s.flag().then(|| s.flag());
                    out.push(b(
                        rig.solve_reach(g, side, &target, angle, &mut links, framed)
                    ));
                    put_vec(&mut out, &links.upper_arm);
                    put_vec(&mut out, &links.lower_arm);
                }
                "curlFinger" | "curlFingerLegacy" => {
                    let finger = Finger::ALL[s.index()];
                    let side = s.side();
                    let amount = s.f64();
                    if method == "curlFinger" {
                        out.push(b(rig.curl_finger(g, finger, side, amount)));
                    } else {
                        rig.curl_finger_legacy(g, finger, side, amount);
                    }
                }
                "curlHand" | "curlHandLegacy" => {
                    let side = s.side();
                    let curls = spec(s);
                    let spread = spec(s);
                    if method == "curlHand" {
                        out.push(b(rig.curl_hand(g, side, &curls, &spread)));
                    } else {
                        rig.curl_hand_legacy(g, side, &curls, &spread);
                    }
                }
                "fingerClearance" => out.push(rig.finger_clearance(s.side())),
                "fingerShape" => {
                    let shape = rig.finger_shape(s.side());
                    out.push(shape.len() as f64);
                    for v in shape {
                        put_vec(&mut out, v);
                    }
                }
                "fingerFrame" => out.extend(rig.finger_frame(s.side()).elements),
                "limitsEnabled" => {
                    let on = s.flag();
                    out.push(b(rig.set_limits_enabled(g, on).is_err()));
                }
                other => panic!("{}: no replay for {other}", s.what),
            }
            out
        }

        /// Replay one call the arm transaction made on a driver.
        fn driver_call(
            rig: &mut Rig,
            g: &mut Graph,
            method: &str,
            side: Side,
            contexts: &mut Contexts,
            s: &mut Stream,
        ) -> Vec<f64> {
            let mut out = Vec::new();
            let b = |v: bool| f64::from(u8::from(v));
            let (driver, anat) = rig.arm_driver_mut(side).expect("a driver");
            match method {
                "captureVolumeFrame" => driver.capture_volume_frame(g, anat),
                "composeRequest" => {
                    let context = contexts.read(s, side);
                    let [u, l, h] = [s.vec3(), s.vec3(), s.vec3()];
                    let palm = s.opt_vec3();
                    let (weight, twist) = (s.f64(), s.f64());
                    let curls = spec(s);
                    let spread = spec(s);
                    let advance = s.flag();
                    let request = driver.compose_request(
                        &context,
                        &u,
                        &l,
                        &h,
                        palm.as_ref(),
                        weight,
                        twist,
                        &curls,
                        &spread,
                        advance,
                    );
                    put_request(&mut out, request);
                    out.push(driver.request_roll_history());
                }
                "configurationFromPose" => {
                    let context = contexts.read(s, side);
                    let [u, l, h] = [s.vec3(), s.vec3(), s.vec3()];
                    let palm = s.opt_vec3();
                    out.push(b(driver.configuration_from_pose(
                        &context,
                        &u,
                        &l,
                        &h,
                        palm.as_ref(),
                    )));
                    out.extend(driver.target_q);
                    out.extend(configuration_values(&driver.target_configuration));
                }
                "fillBounds" => {
                    let q = s.q();
                    let (dt, temporal) = (s.f64(), s.flag());
                    let bounds = driver.fill_bounds(&q, dt, temporal);
                    out.extend(bounds.lower);
                    out.extend(bounds.upper);
                }
                "planFrom" => {
                    let q = s.q();
                    let context = contexts.read(s, side);
                    let (dt, temporal) = (s.f64(), s.flag());
                    let plan = driver.plan_from(anat, &q, &context, dt, temporal);
                    put_plan(&mut out, plan);
                }
                "restoreEndpointFrom" => {
                    let q = s.q();
                    let context = contexts.read(s, side);
                    let (dt, temporal) = (s.f64(), s.flag());
                    out.push(b(
                        driver.restore_endpoint_from(anat, &q, &context, dt, temporal)
                    ));
                    put_plan(&mut out, &driver.output);
                }
                "validateLockedPose" => {
                    let q = s.q();
                    let context = contexts.read(s, side);
                    let curls = spec(s);
                    let spread = spec(s);
                    let which = if s.index() == 0 {
                        DriverOutput::Output
                    } else {
                        DriverOutput::Bridge
                    };
                    let ok =
                        driver.validate_locked_pose(anat, &q, &context, &curls, &spread, which);
                    out.push(b(ok));
                    put_plan(
                        &mut out,
                        match which {
                            DriverOutput::Output => &driver.output,
                            DriverOutput::Bridge => &driver.bridge_output,
                        },
                    );
                }
                "requestForConfiguration" => {
                    let configuration = configuration_of(s.take(7));
                    let context = contexts.read(s, side);
                    let curls = spec(s);
                    let spread = spec(s);
                    let request =
                        driver.request_for_configuration(&configuration, &context, &curls, &spread);
                    put_request(&mut out, request);
                    out.push(driver.request_roll_history());
                }
                "refreshAcceptedForward" => {
                    let context = contexts.read(s, side);
                    out.extend(forward_values(driver.refresh_accepted_forward(&context)));
                }
                other => panic!("{}: no replay for {other}", s.what),
            }
            out
        }

        /// A heavy record's close: the output when there is one, the rig's state and the tree.
        pub(crate) fn same_close(s: &mut Stream, rig: &Rig, g: &Graph, out: &[f64]) {
            if !out.is_empty() {
                s.same(&hash_halves(out), "output");
            }
            s.same(&hash_halves(&state_values(rig)), "state");
            s.same(&halves(graph_hash(g)), "tree");
        }

        /// A call the rig battery's loop does not replay itself: the tag, the tree, the rig and
        /// the stream at the record's body.
        pub(crate) type Extra<'e> = dyn FnMut(&str, &mut Graph, &mut Rig, &mut Stream) + 'e;

        /// Replay the call battery `name`, handing the motion tags to `extra`. Returns how often
        /// each tag and method was replayed, and the fixtures that ended.
        pub(crate) fn replay(
            name: &str,
            extra: &mut Extra,
        ) -> (std::collections::BTreeMap<String, usize>, usize) {
            let files = files(name);
            assert!(!files.is_empty(), "no {name} files");
            let mut begin: Vec<f64> = Vec::new();
            let mut built: Option<(Graph, Profile)> = None;
            let mut live: Option<(Graph, Rig)> = None;
            let mut contexts = Contexts([None, None]);
            let mut seen = std::collections::BTreeMap::<String, usize>::new();
            let mut fixtures = 0;
            let mut n = 0;
            for file in &files {
                let corpus = Corpus::load(file);
                let mut s = Stream::new(corpus.case(0).output("stream"));
                while !s.done() {
                    let tag = TAGS[s.index()];
                    s.what = format!("{file} #{n} {tag}");
                    n += 1;
                    *seen.entry(tag.to_owned()).or_default() += 1;
                    match tag {
                        "begin" => {
                            assert!(live.is_none(), "{}: a fixture left open", s.what);
                            let nodes = s.index();
                            if s.flag() {
                                begin = s.take(nodes * NODE).to_vec();
                            }
                            let (mut g, p) = base::avatar();
                            assert_eq!(g.len(), nodes, "{}", s.what);
                            let mut dump = Stream::new(&begin);
                            for i in 0..nodes {
                                write_parts(&mut g, i, 15, &mut dump);
                            }
                            built = Some((g, p));
                            contexts = Contexts([None, None]);
                        }
                        "new" => {
                            let (mut g, p) = built.take().expect("a begin before new");
                            let rig = Rig::new(p, &mut g);
                            let mut off = vec![rig.arm_solver_off.len() as f64];
                            off.extend(rig.arm_solver_off.iter().map(|o| o.side as usize as f64));
                            s.same(&hash_halves(&off), "armSolverOff");
                            s.same(&halves(graph_hash(&g)), "tree");
                            s.same(&hash_halves(&state_values(&rig)), "state");
                            live = Some((g, rig));
                        }
                        "dt" => live.as_mut().expect("a rig").1.dt = s.f64(),
                        "rig" => {
                            let (g, rig) = live.as_mut().expect("a rig");
                            let method = METHODS[s.index()];
                            s.what = format!("{file} #{} rig.{method}", n - 1);
                            *seen.entry(method.to_owned()).or_default() += 1;
                            let heavy = !READS.contains(&method);
                            if heavy {
                                apply_diff(g, &mut s);
                            }
                            let out = rig_call(rig, g, method, &mut s);
                            if heavy {
                                same_close(&mut s, rig, g, &out);
                            } else if !out.is_empty() {
                                s.same(&hash_halves(&out), "output");
                            }
                        }
                        "anat" => {
                            let (g, rig) = live.as_mut().expect("a rig");
                            assert_eq!(s.index(), 0, "{}: anat.update", s.what);
                            apply_diff(g, &mut s);
                            let out = [f64::from(u8::from(rig.anat.update(g)))];
                            same_close(&mut s, rig, g, &out);
                        }
                        "face" => {
                            let (g, rig) = live.as_mut().expect("a rig");
                            assert_eq!(s.index(), 0, "{}: face.refresh", s.what);
                            apply_diff(g, &mut s);
                            rig.anat.face_mut().expect("a face").refresh(g);
                            same_close(&mut s, rig, g, &[]);
                        }
                        "driver" => {
                            let (g, rig) = live.as_mut().expect("a rig");
                            let method = DRIVER_METHODS[s.index()];
                            let side = s.side();
                            s.what = format!("{file} #{} driver.{method} {side:?}", n - 1);
                            *seen.entry(format!("driver.{method}")).or_default() += 1;
                            let heavy = method == "captureVolumeFrame";
                            if heavy {
                                apply_diff(g, &mut s);
                            }
                            let out = driver_call(rig, g, method, side, &mut contexts, &mut s);
                            if heavy {
                                same_close(&mut s, rig, g, &out);
                            } else {
                                s.same(&hash_halves(&out), "output");
                            }
                        }
                        "frame" => {
                            let (g, rig) = live.as_mut().expect("a rig");
                            for _ in 0..s.index() {
                                let i = s.index();
                                write_parts(g, i, 1, &mut s);
                            }
                            g.update_matrix_world(ROOT, true);
                            s.same(&hash_halves(&state_values(rig)), "state");
                            s.same(&halves(graph_hash(g)), "tree");
                        }
                        "end" => {
                            let (mut g, rig) = live.take().expect("a rig");
                            apply_diff(&mut g, &mut s);
                            same_close(&mut s, &rig, &g, &[rig.arm_solver_off.len() as f64]);
                            fixtures += 1;
                        }
                        other => {
                            let (g, rig) = live.as_mut().expect("a rig");
                            extra(other, g, rig, &mut s);
                        }
                    }
                }
            }
            assert!(live.is_none(), "the last fixture did not end");
            (seen, fixtures)
        }

        #[test]
        fn replays_the_ts_rig_through_the_director_bit_for_bit() {
            let (seen, fixtures) = replay("rig-battery", &mut |tag, _, _, s| {
                panic!("{}: no replay for {tag}", s.what)
            });
            assert_eq!(fixtures, 4);
            for method in [
                "bootstrapStandingPose",
                "applyBodyContext",
                "commitArmFrame",
                "armForwardContextFromUpdatedBody",
                "stageArmForward",
                "plantLegs",
                "aimArm",
                "aimArmLegacy",
                "curlFinger",
                "curlHand",
                "curlHandLegacy",
                "measure",
                "solveReachNatural",
                "solvePoint",
                "predictHandContact",
                "finishLegacyBodyFrame",
                "limitsEnabled",
                "driver.planFrom",
                "face",
            ] {
                assert!(
                    seen.get(method).is_some_and(|&c| c > 0),
                    "{method} never replayed"
                );
            }
        }
    }
}
