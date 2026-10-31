//! Exports for the rig, its anatomy and face, the character frame and the arm transaction. The
//! functions, codes, scratch offsets and record layouts are tabled in `src/core/abi/rig.ts`.
//!
//! Records are flat f64 runs. The rig-owned ones the caller views in place (`Vec3`, `Quat`,
//! `Mat3`, `AcceptedArmState`, `HandSensePose`) are the core's own structs, so their field
//! offsets are asserted below rather than assumed.

use core::mem::{offset_of, size_of};

use hashidate_core::math::{Mat3, Quat, Vec3};
use hashidate_core::motion::arm_transaction::{ArmFollowed, ArmTransaction};
use hashidate_core::motion::frame::CharacterFrame;
use hashidate_core::profile::{Finger, NO_NODE, Side};
use hashidate_core::rig::arm_configuration::{
    ArmForwardContext, ArmForwardResult, CalibrationRefusal,
};
use hashidate_core::rig::arm_driver::DriverRefusal;
use hashidate_core::rig::finger_clearance::hand_frame;
use hashidate_core::rig::hand_geometry::{ContactSurface, HandContact, PalmRegion};
use hashidate_core::rig::hands::FingerSpec;
use hashidate_core::rig::point::PointRequest;
use hashidate_core::rig::reach::{ArmSolution, ReachLinks, pole_angle, reach_ref};
use hashidate_core::rig::spine::OffsetSlot;
use hashidate_core::rig::{
    AcceptedArmState, ArmFrameSideCommit, ArmSolverOffReason, HandSensePose, Rig, StandingArmPose,
};
use hashidate_core::scene::graph::Graph;

use crate::profile::{Builder, take};
use crate::scene::with_scenes;

const _: () = {
    assert!(size_of::<Vec3>() == 24 && offset_of!(Vec3, x) == 0);
    assert!(offset_of!(Vec3, y) == 8 && offset_of!(Vec3, z) == 16);
    assert!(size_of::<Quat>() == 32 && offset_of!(Quat, x) == 0 && offset_of!(Quat, y) == 8);
    assert!(offset_of!(Quat, z) == 16 && offset_of!(Quat, w) == 24);
    assert!(size_of::<Mat3>() == 72 && offset_of!(Mat3, elements) == 0);
    assert!(size_of::<AcceptedArmState>() == 8 * ARM_STATE);
    assert!(offset_of!(AcceptedArmState, directions) == 0);
    assert!(offset_of!(AcceptedArmState, palm) == 96);
    assert!(offset_of!(AcceptedArmState, curls) == 120);
    assert!(offset_of!(AcceptedArmState, spread) == 160);
    assert!(offset_of!(AcceptedArmState, forearm_roll) == 200);
    assert!(size_of::<HandSensePose>() == 8 * HAND_POSE);
    assert!(offset_of!(HandSensePose, knuckle) == 0 && offset_of!(HandSensePose, palm) == 24);
    assert!(offset_of!(HandSensePose, forearm) == 48 && offset_of!(HandSensePose, index) == 72);
    assert!(offset_of!(HandSensePose, little) == 96);
    assert!(9 + SOLUTION <= SCRATCH && 2 * STANDING <= SCRATCH);
    assert!(FORWARD + 10 <= SCRATCH && READING * READINGS <= SCRATCH);
};

/// f64 in an `AcceptedArmState`: directions 12, palm 3, curls 5, spread 5, forearmRoll.
const ARM_STATE: usize = 26;
/// f64 in a `HandSensePose`: knuckle, palm, forearm, index, little.
const HAND_POSE: usize = 15;
/// f64 in an `ArmSolution`.
const SOLUTION: usize = 23;
/// f64 in an `ArmForwardContext`.
const CONTEXT: usize = 19;
/// f64 in an `ArmForwardResult`.
const FORWARD: usize = 42;
/// f64 in one side of `commitArmFrame`: q 7, forward, context, curls 5, spread 5.
const SIDE_COMMIT: usize = 7 + FORWARD + CONTEXT + 10;
/// f64 in one side of `bootstrapStandingPose`: five directions, curls 5, spread 5.
const STANDING: usize = 25;
/// f64 per joint reading.
const READING: usize = 8;
const READINGS: usize = 9;
/// u32 per `armSolverOff` entry: side, reason, driver refusal, calibration refusal.
const SOLVER_OFF: usize = 4;
const SCRATCH: usize = 2 * SIDE_COMMIT;
/// f64 in the hand-frame buffer: point 3, palm 3, out 9.
const HAND_FRAME: usize = 15;

const LAYOUT: usize = 27;

const FOLLOWED: usize = 0;
const FOLLOWED_LEN: usize = 54;
const TX_Q: usize = FOLLOWED + FOLLOWED_LEN;
const TX_NOTES: usize = TX_Q + 7;
/// f64 per note: side, upperArm 3, lowerArm 3, hand 3.
const NOTE: usize = 10;
const TX_WORK: usize = TX_NOTES + 2 * NOTE;
const TX_BUFFER: usize = TX_WORK + 8;

const LIMITS_OK: u32 = 0;
const LIMITS_NO_FEASIBLE_POSE: u32 = 1;

/// A rig over a scene graph, its character frame, and the buffers it is spoken to through.
pub struct Handle {
    rig: Rig,
    frame: CharacterFrame,
    /// The `hd_scene_new` handle the rig reads and writes, retained until free.
    scene: u32,
    scratch: [f64; SCRATCH],
    /// Per side, the copy `hd_rig_finger_shape` makes: xyz per point.
    shape: [Vec<f64>; 2],
    solver_off: [u32; 2 * SOLVER_OFF],
    readings: [f64; READING * READINGS],
    layout: [u32; LAYOUT],
}

/// An arm transaction, the rig it was made for, and the buffer its calls read and write.
pub struct Transaction {
    tx: ArmTransaction,
    /// The `hd_rig_new` handle, checked on every call that takes one.
    rig: usize,
    buffer: [f64; TX_BUFFER],
}

fn ptr<T>(v: &[T]) -> u32 {
    v.as_ptr() as usize as u32
}

fn addr<T>(r: &T) -> u32 {
    r as *const T as usize as u32
}

fn side(code: u32) -> Side {
    match code {
        0 => Side::L,
        1 => Side::R,
        _ => panic!("side code {code} out of range"),
    }
}

fn finger(code: u32) -> Finger {
    *Finger::ALL
        .get(code as usize)
        .unwrap_or_else(|| panic!("finger code {code} out of range"))
}

fn tristate(code: u32) -> Option<bool> {
    match code {
        0 => Some(false),
        1 => Some(true),
        2 => None,
        _ => panic!("tri-state code {code} out of range"),
    }
}

fn v3(s: &[f64], at: usize) -> Vec3 {
    Vec3::new(s[at], s[at + 1], s[at + 2])
}

fn put3(s: &mut [f64], at: usize, v: &Vec3) {
    s[at..at + 3].copy_from_slice(&[v.x, v.y, v.z]);
}

fn q4(s: &[f64], at: usize) -> Quat {
    Quat::new(s[at], s[at + 1], s[at + 2], s[at + 3])
}

fn put4(s: &mut [f64], at: usize, q: &Quat) {
    s[at..at + 4].copy_from_slice(&[q.x, q.y, q.z, q.w]);
}

fn tuple(s: &[f64], at: usize) -> [f64; 3] {
    [s[at], s[at + 1], s[at + 2]]
}

/// A finger record of 5 f64 at `at`, finger `i` present where bit `i` of `bits` is set.
fn spec(s: &[f64], at: usize, bits: u32) -> FingerSpec {
    core::array::from_fn(|i| (bits & (1 << i) != 0).then_some(s[at + i]))
}

fn read_solution(s: &[f64], at: usize) -> ArmSolution {
    ArmSolution {
        links: ReachLinks {
            upper_arm: v3(s, at),
            lower_arm: v3(s, at + 3),
        },
        hand: v3(s, at + 6),
        palm: v3(s, at + 9),
        tip: v3(s, at + 12),
        twist: s[at + 15],
        strain: (s[at + 16] != 0.0).then_some(s[at + 17]),
        swivel_dir: v3(s, at + 18),
        clasp: (s[at + 21] != 0.0).then_some(s[at + 22] != 0.0),
    }
}

fn write_solution(s: &mut [f64], at: usize, o: &ArmSolution) {
    put3(s, at, &o.links.upper_arm);
    put3(s, at + 3, &o.links.lower_arm);
    put3(s, at + 6, &o.hand);
    put3(s, at + 9, &o.palm);
    put3(s, at + 12, &o.tip);
    s[at + 15] = o.twist;
    s[at + 16] = f64::from(u8::from(o.strain.is_some()));
    s[at + 17] = o.strain.unwrap_or(0.0);
    put3(s, at + 18, &o.swivel_dir);
    s[at + 21] = f64::from(u8::from(o.clasp.is_some()));
    s[at + 22] = f64::from(u8::from(o.clasp.unwrap_or(false)));
}

fn read_context(s: &[f64], at: usize) -> ArmForwardContext {
    ArmForwardContext {
        side: side(s[at] as u32),
        shoulder: v3(s, at + 1),
        upper_length: s[at + 4],
        lower_length: s[at + 5],
        up: v3(s, at + 6),
        right: v3(s, at + 9),
        forward: v3(s, at + 12),
        upper_parent_world: q4(s, at + 15),
    }
}

fn write_context(s: &mut [f64], at: usize, c: &ArmForwardContext) {
    s[at] = f64::from(c.side as u8);
    put3(s, at + 1, &c.shoulder);
    s[at + 4] = c.upper_length;
    s[at + 5] = c.lower_length;
    put3(s, at + 6, &c.up);
    put3(s, at + 9, &c.right);
    put3(s, at + 12, &c.forward);
    put4(s, at + 15, &c.upper_parent_world);
}

fn read_forward(s: &[f64], at: usize) -> ArmForwardResult {
    ArmForwardResult {
        u: v3(s, at),
        l: v3(s, at + 3),
        h: v3(s, at + 6),
        palm: v3(s, at + 9),
        elbow: v3(s, at + 12),
        wrist: v3(s, at + 15),
        upper_world: q4(s, at + 18),
        lower_world: q4(s, at + 22),
        hand_world: q4(s, at + 26),
        upper_local: q4(s, at + 30),
        lower_local: q4(s, at + 34),
        hand_local: q4(s, at + 38),
    }
}

fn contact(kind: u32, which: u32, segment: u32, surface: u32, fraction: f64) -> HandContact {
    let surface = match surface {
        0 => Some(ContactSurface::Center),
        1 => Some(ContactSurface::Pad),
        2 => Some(ContactSurface::Back),
        3 => None,
        _ => panic!("contact surface code {surface} out of range"),
    };
    match kind {
        0 => HandContact::Palm {
            region: match which {
                0 => PalmRegion::Heel,
                1 => PalmRegion::Center,
                _ => panic!("palm region code {which} out of range"),
            },
            surface,
        },
        1 => {
            assert!(segment < 2, "contact segment {segment} out of range");
            HandContact::Finger {
                finger: finger(which),
                segment: segment as u8,
                fraction,
                surface,
            }
        }
        _ => panic!("contact kind {kind} out of range"),
    }
}

fn refusal_codes(r: DriverRefusal) -> [u32; 2] {
    match r {
        DriverRefusal::Unresolved => [0, NO_NODE],
        DriverRefusal::NotConformal => [1, NO_NODE],
        DriverRefusal::NoParent => [2, NO_NODE],
        DriverRefusal::Calibration(c) => [
            3,
            match c {
                CalibrationRefusal::ZeroAxis => 0,
                CalibrationRefusal::FrontAlongAxis => 1,
                CalibrationRefusal::PalmAlongAxis => 2,
                CalibrationRefusal::WristBeyondInverse => 3,
            },
        ],
        DriverRefusal::HandLength => [4, NO_NODE],
        DriverRefusal::SweepResolution => [5, NO_NODE],
    }
}

fn solver_off_record(reason: ArmSolverOffReason) -> [u32; 3] {
    match reason {
        ArmSolverOffReason::NoPalmFrame => [0, NO_NODE, NO_NODE],
        ArmSolverOffReason::Refused(r) => {
            let [refusal, calibration] = refusal_codes(r);
            [1, refusal, calibration]
        }
        ArmSolverOffReason::RestPoseUnreadable => [2, NO_NODE, NO_NODE],
        ArmSolverOffReason::RestPoseOutsideModel => [3, NO_NODE, NO_NODE],
    }
}

impl Handle {
    /// Runs `f` on the rig, the graph it was created on and the scratch.
    fn run<R>(&mut self, f: impl FnOnce(&mut Rig, &mut Graph, &mut [f64; SCRATCH]) -> R) -> R {
        let scene = self.scene;
        let (rig, scratch) = (&mut self.rig, &mut self.scratch);
        with_scenes(|scenes| f(rig, &mut scenes.get(scene).graph, scratch))
    }
}

/// The handle behind `h`.
///
/// # Safety
/// `h` must come from `hd_rig_new` and not have been passed to `hd_rig_free`.
unsafe fn handle<'a>(h: *mut Handle) -> &'a mut Handle {
    // SAFETY: the caller passes a live pointer from `Box::into_raw` in `hd_rig_new`, and the
    // single-threaded module never holds two references to it at once.
    unsafe { &mut *h }
}

/// The transaction behind `t`, checked against the rig `h` it was made for.
///
/// # Safety
/// `t` must come from `hd_rig_new_transaction` and not have been freed.
unsafe fn transaction<'a>(t: *mut Transaction, h: *mut Handle) -> &'a mut Transaction {
    // SAFETY: as for `handle`, for `hd_rig_new_transaction`.
    let t = unsafe { &mut *t };
    assert!(
        h.is_null() || t.rig == h as usize,
        "transaction used with another rig"
    );
    t
}

/// Creates a rig from the profile `profile` (consumed) over scene graph `scene`, and registers it
/// as a dependent of that graph.
///
/// # Safety
/// `profile` must come from `hd_profile_new` and not have been freed or handed over before.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_new(scene: u32, profile: *mut Builder) -> *mut Handle {
    // SAFETY: forwarded from this function's contract.
    let profile = unsafe { take(profile) };
    let rig = with_scenes(|scenes| {
        let graph = &mut scenes.get(scene).graph;
        let n = graph.len();
        let node = |b: u32| assert!(b == NO_NODE || (b as usize) < n, "node {b} out of range");
        profile.bones.iter().copied().for_each(node);
        profile
            .finger_bones
            .iter()
            .flatten()
            .copied()
            .for_each(node);
        for t in profile.arm_twists.iter().flatten() {
            [t.primary, t.next, t.helper].into_iter().for_each(node);
        }
        let rig = Rig::new(profile, graph);
        scenes.retain(scene);
        rig
    });
    let shape = Side::BOTH.map(|side| {
        let points: usize = Finger::ALL
            .iter()
            .map(|&f| rig.p.finger(f, side).len())
            .filter(|&len| len > 0)
            .map(|len| len + 1)
            .sum();
        vec![0.0; 3 * points]
    });
    let mut solver_off = [NO_NODE; 2 * SOLVER_OFF];
    for (k, off) in rig.arm_solver_off.iter().enumerate() {
        let [reason, refusal, calibration] = solver_off_record(off.reason);
        solver_off[SOLVER_OFF * k..SOLVER_OFF * (k + 1)].copy_from_slice(&[
            off.side as u32,
            reason,
            refusal,
            calibration,
        ]);
    }
    let frame = CharacterFrame::new(&rig.p);
    let mut h = Box::new(Handle {
        rig,
        frame,
        scene,
        scratch: [0.0; SCRATCH],
        shape,
        solver_off,
        readings: [0.0; READING * READINGS],
        layout: [0; LAYOUT],
    });
    let rig = &h.rig;
    let palm = rig.palm_local();
    let prediction = Side::BOTH.map(|side| rig.contact_prediction(side));
    let contact = prediction.map(|p| p.map_or(0, |p| addr(&p.contact)));
    let bind = prediction.map(|p| p.map_or(0, |p| addr(&p.bind_frame)));
    let points = prediction.map(|p| p.map_or(&[][..], |p| &p.sample.points[..]));
    let first = points.map(|p| p.first().map_or(0, |p| addr(&p.position)));
    h.layout = [
        ptr(&h.scratch),
        addr(rig.anat.right()),
        addr(rig.anat.up()),
        addr(rig.anat.fwd()),
        addr(rig.anat.axis_o()),
        ptr(&rig.anat.radial_sign),
        ptr(&rig.fore_roll),
        ptr(&rig.upper_roll),
        palm[0].as_ref().map_or(0, addr),
        palm[1].as_ref().map_or(0, addr),
        ptr(&h.shape[0]),
        ptr(&h.shape[1]),
        (h.shape[0].len() / 3) as u32,
        (h.shape[1].len() / 3) as u32,
        contact[0],
        contact[1],
        bind[0],
        bind[1],
        first[0],
        first[1],
        points[0].len() as u32,
        points[1].len() as u32,
        size_of::<hashidate_core::rig::hand_geometry::HandGeometryPoint>() as u32,
        u32::from(rig.anat.face().is_some()),
        ptr(&h.solver_off),
        rig.arm_solver_off.len() as u32,
        ptr(&h.readings),
    ];
    Box::into_raw(h)
}

/// Frees a rig and every buffer it owns, and releases its graph; a graph already freed is left
/// alone.
///
/// # Safety
/// `h` must come from `hd_rig_new` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_free(h: *mut Handle) {
    // SAFETY: the caller passes the pointer `Box::into_raw` returned, once.
    let h = unsafe { Box::from_raw(h) };
    with_scenes(|scenes| scenes.release(h.scene));
}

/// The address table, valid until `hd_rig_free`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_layout(h: *mut Handle) -> *const u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.layout.as_ptr()
}

/// The scratch the per-call exports read and write.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_scratch(h: *mut Handle) -> *mut f64 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.scratch.as_mut_ptr()
}

/// `rig.dt`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_dt(h: *mut Handle) -> f64 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.rig.dt
}

/// `rig.dt = dt`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_set_dt(h: *mut Handle, dt: f64) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.rig.dt = dt;
}

/// `rig.limitsEnabled`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_limits_enabled(h: *mut Handle) -> u32 {
    // SAFETY: forwarded from this function's contract.
    u32::from(unsafe { handle(h) }.rig.limits_enabled())
}

/// `rig.limitsEnabled = on`; returns LIMITS_*.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_set_limits_enabled(h: *mut Handle, on: u32) -> u32 {
    // SAFETY: forwarded from this function's contract.
    let refused = unsafe { handle(h) }.run(|rig, g, _| rig.set_limits_enabled(g, on != 0).is_err());
    if refused {
        LIMITS_NO_FEASIBLE_POSE
    } else {
        LIMITS_OK
    }
}

/// `rig.externalArmRevision`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_external_arm_revision(h: *mut Handle) -> f64 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.rig.external_arm_revision() as f64
}

/// `rig.reset()`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_reset(h: *mut Handle) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| rig.reset(g));
}

/// `rig.addOffset(slot, x, y, z)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_add_offset(h: *mut Handle, slot: u32, x: f64, y: f64, z: f64) {
    let slot = *OffsetSlot::ALL
        .get(slot as usize)
        .unwrap_or_else(|| panic!("offset slot {slot} out of range"));
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.rig.add_offset(slot, x, y, z);
}

/// `rig.commitSpine()`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_commit_spine(h: *mut Handle) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| rig.commit_spine(g));
}

/// `rig.readHeadOffset(out)`, `out` in and out at scratch 0.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_read_head_offset(h: *mut Handle) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let mut out = q4(s, 0);
        let ok = rig.read_head_offset(g, &mut out);
        put4(s, 0, &out);
        u32::from(ok)
    })
}

/// `rig.commitEyes()`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_commit_eyes(h: *mut Handle) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| rig.commit_eyes(g));
}

/// `rig.plantLegs(rise, turn, afterPlant)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_plant_legs(h: *mut Handle, rise: f64, turn: f64, after: u32) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| rig.plant_legs(g, rise, turn, after != 0));
}

/// `rig.beginBodyArmFrame()`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_begin_body_arm_frame(h: *mut Handle) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| u32::from(rig.begin_body_arm_frame(g)))
}

/// `rig.finishLegacyBodyFrame(rise, turn)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_finish_legacy_body_frame(h: *mut Handle, rise: f64, turn: f64) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| rig.finish_legacy_body_frame(g, rise, turn));
}

/// `rig.armForwardContext(side)`; the context to scratch 0 when present.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_arm_forward_context(h: *mut Handle, side_code: u32) -> u32 {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| match rig.arm_forward_context(g, side) {
        Some(c) => {
            write_context(s, 0, c);
            1
        }
        None => 0,
    })
}

/// `rig.armForwardContextFromUpdatedBody(side)`; the context to scratch 0 when present.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_arm_forward_context_from_updated_body(
    h: *mut Handle,
    side_code: u32,
) -> u32 {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(
        |rig, g, s| match rig.arm_forward_context_from_updated_body(g, side) {
            Some(c) => {
                write_context(s, 0, c);
                1
            }
            None => 0,
        },
    )
}

/// `rig.captureProposedBodyContext(rise, turn)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_capture_proposed_body_context(
    h: *mut Handle,
    rise: f64,
    turn: f64,
) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| rig.capture_proposed_body_context(g, rise, turn));
}

/// `rig.applyBodyContext(alpha, transportProgress, afterPlant)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_apply_body_context(
    h: *mut Handle,
    alpha: f64,
    transport_progress: f64,
    after: u32,
) -> f64 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }
        .run(|rig, g, _| rig.apply_body_context(g, alpha, transport_progress, after != 0))
}

/// `rig.stageArmForward(side, forward, curls, spread)`: forward at scratch 0, curls at 42,
/// spread at 47.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_stage_arm_forward(
    h: *mut Handle,
    side_code: u32,
    curl_bits: u32,
    spread_bits: u32,
) -> u32 {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let forward = read_forward(s, 0);
        let curls = spec(s, FORWARD, curl_bits);
        let spread = spec(s, FORWARD + 5, spread_bits);
        u32::from(rig.stage_arm_forward(g, side, &forward, &curls, &spread))
    })
}

/// `rig.commitArmFrame(plans, rise, turn, afterPlant)`: SIDE_COMMIT records for L then R from
/// scratch 0; `bits` holds L's curls in bits 0-4, L's spread 5-9, R's curls 10-14, R's spread
/// 15-19.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_commit_arm_frame(
    h: *mut Handle,
    rise: f64,
    turn: f64,
    after: u32,
    bits: u32,
) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let plans = [0, 1].map(|k| {
            let at = SIDE_COMMIT * k;
            let mut q = [0.0; 7];
            q.copy_from_slice(&s[at..at + 7]);
            let side_bits = bits >> (10 * k);
            ArmFrameSideCommit {
                q,
                forward: read_forward(s, at + 7),
                context: read_context(s, at + 7 + FORWARD),
                curls: spec(s, at + 7 + FORWARD + CONTEXT, side_bits & 0x1f),
                spread: spec(s, at + 7 + FORWARD + CONTEXT + 5, (side_bits >> 5) & 0x1f),
            }
        });
        u32::from(rig.commit_arm_frame(g, &plans, rise, turn, after != 0))
    })
}

/// `rig.commitArmTransport(lift, turn, afterPlant)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_commit_arm_transport(
    h: *mut Handle,
    lift: f64,
    turn: f64,
    after: u32,
) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }
        .run(|rig, g, _| u32::from(rig.commit_arm_transport(g, lift, turn, after != 0)))
}

/// `rig.girdleRoom(side, target, dir, weight, turnOut)`: dir at scratch 0, turnOut in and out
/// at 3.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn hd_rig_girdle_room(
    h: *mut Handle,
    side_code: u32,
    tx: f64,
    ty: f64,
    tz: f64,
    weight: f64,
) {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let dir = tuple(s, 0);
        let mut turn = v3(s, 3);
        rig.girdle_room(g, side, &Vec3::new(tx, ty, tz), &dir, weight, &mut turn);
        put3(s, 3, &turn);
    });
}

/// `rig.turnGirdle(dir, turn)`: dir in and out at scratch 0, turn at 3.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_turn_girdle(h: *mut Handle) {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let s = &mut h.scratch;
    let mut dir = tuple(s, 0);
    h.rig.turn_girdle(&mut dir, &v3(s, 3));
    s[0..3].copy_from_slice(&dir);
}

/// `rig.aimShoulder(side, dir)`; `has_dir` 0 is a null dir.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_aim_shoulder(
    h: *mut Handle,
    side_code: u32,
    has_dir: u32,
    x: f64,
    y: f64,
    z: f64,
) {
    let side = side(side_code);
    let dir = (has_dir != 0).then(|| Vec3::new(x, y, z));
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| rig.aim_shoulder(g, side, dir.as_ref()));
}

/// The dirs record at scratch 0 (ArmSlot order, present by `dir_bits`) and the palm at 12.
fn aim_inputs(s: &[f64], dir_bits: u32, has_palm: u32) -> ([Option<Vec3>; 4], Option<Vec3>) {
    let dirs = core::array::from_fn(|i| (dir_bits & (1 << i) != 0).then(|| v3(s, 3 * i)));
    (dirs, (has_palm != 0).then(|| v3(s, 12)))
}

/// `rig.aimArm(side, dirs, twist, palmTarget, palmWeight)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_aim_arm(
    h: *mut Handle,
    side_code: u32,
    dir_bits: u32,
    twist: f64,
    has_palm: u32,
    palm_weight: f64,
) -> u32 {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let (dirs, palm) = aim_inputs(s, dir_bits, has_palm);
        u32::from(rig.aim_arm(g, side, &dirs, twist, palm.as_ref(), palm_weight))
    })
}

/// `rig.aimArmLegacy(side, dirs, twist, palmTarget, palmWeight)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_aim_arm_legacy(
    h: *mut Handle,
    side_code: u32,
    dir_bits: u32,
    twist: f64,
    has_palm: u32,
    palm_weight: f64,
) {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let (dirs, palm) = aim_inputs(s, dir_bits, has_palm);
        rig.aim_arm_legacy(g, side, &dirs, twist, palm.as_ref(), palm_weight);
    });
}

/// `rig.measure(side)`; the readings to the readings buffer when present.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_measure(h: *mut Handle, side_code: u32) -> u32 {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let Some(readings) = h.run(|rig, g, _| rig.measure(g, side)) else {
        return 0;
    };
    for (k, r) in readings.iter().enumerate() {
        h.readings[READING * k..READING * (k + 1)].copy_from_slice(&[
            f64::from(r.id as u8),
            r.deg,
            f64::from(u8::from(r.percent)),
            r.strain,
            f64::from(r.zone as u8),
            r.range[0],
            r.range[1],
            f64::from(u8::from(r.measured)),
        ]);
    }
    1
}

/// `rig.solveReachNatural(side, target, handDir, out, pole)`: target at scratch 0, handDir at 3,
/// pole at 6, out in and out at 9.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_solve_reach_natural(
    h: *mut Handle,
    side_code: u32,
    has_hand_dir: u32,
    has_pole: u32,
) -> u32 {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let target = v3(s, 0);
        let hand_dir = (has_hand_dir != 0).then(|| v3(s, 3));
        let pole = (has_pole != 0).then(|| v3(s, 6));
        let mut out = read_solution(s, 9);
        let ok =
            rig.solve_reach_natural(g, side, &target, hand_dir.as_ref(), &mut out, pole.as_ref());
        write_solution(s, 9, &out);
        u32::from(ok)
    })
}

/// `rig.solvePoint(side, spec, out)`: azimuth, elevation, extent at scratch 0-2, point at 3,
/// palm at 6, out in and out at 9; `bits` marks azimuth, elevation, extent, point, palm present
/// (bits 0-4); `finger` is a finger code or `NO_NODE`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_solve_point(
    h: *mut Handle,
    side_code: u32,
    bits: u32,
    finger_code: u32,
) -> u32 {
    let side = side(side_code);
    let finger = (finger_code != NO_NODE).then(|| finger(finger_code));
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let has = |i: u32| bits & (1 << i) != 0;
        let spec = PointRequest {
            azimuth: has(0).then_some(s[0]),
            elevation: has(1).then_some(s[1]),
            extent: has(2).then_some(s[2]),
            finger,
            point: has(3).then(|| v3(s, 3)),
            palm: has(4).then(|| v3(s, 6)),
        };
        let mut out = read_solution(s, 9);
        let ok = rig.solve_point(g, side, &spec, &mut out);
        write_solution(s, 9, &out);
        u32::from(ok)
    })
}

/// `rig.solveReach(side, target, elbowAngle, out, framed)`, and `solveReach` over the rig's
/// profile, joints and anatomy: target at scratch 0, out in and out at 3.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_solve_reach(
    h: *mut Handle,
    side_code: u32,
    elbow_angle: f64,
    framed: u32,
) -> u32 {
    let side = side(side_code);
    let framed = tristate(framed);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let target = v3(s, 0);
        let mut out = ReachLinks {
            upper_arm: v3(s, 3),
            lower_arm: v3(s, 6),
        };
        let ok = rig.solve_reach(g, side, &target, elbow_angle, &mut out, framed);
        put3(s, 3, &out.upper_arm);
        put3(s, 6, &out.lower_arm);
        u32::from(ok)
    })
}

/// `rig.curlFinger(name, side, amount)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_curl_finger(
    h: *mut Handle,
    finger_code: u32,
    side_code: u32,
    amount: f64,
) -> u32 {
    let (finger, side) = (finger(finger_code), side(side_code));
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| u32::from(rig.curl_finger(g, finger, side, amount)))
}

/// `rig.curlHand(side, spec, spread)`: spec at scratch 0, spread at 5.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_curl_hand(
    h: *mut Handle,
    side_code: u32,
    spec_bits: u32,
    spread_bits: u32,
) -> u32 {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let (curls, spread) = (spec(s, 0, spec_bits), spec(s, 5, spread_bits));
        u32::from(rig.curl_hand(g, side, &curls, &spread))
    })
}

/// `rig.curlFingerLegacy(name, side, amount)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_curl_finger_legacy(
    h: *mut Handle,
    finger_code: u32,
    side_code: u32,
    amount: f64,
) {
    let (finger, side) = (finger(finger_code), side(side_code));
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| rig.curl_finger_legacy(g, finger, side, amount));
}

/// `rig.curlHandLegacy(side, spec, spread)`: spec at scratch 0, spread at 5.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_curl_hand_legacy(
    h: *mut Handle,
    side_code: u32,
    spec_bits: u32,
    spread_bits: u32,
) {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let (curls, spread) = (spec(s, 0, spec_bits), spec(s, 5, spread_bits));
        rig.curl_hand_legacy(g, side, &curls, &spread);
    });
}

/// `rig.fingerClearance(side)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_finger_clearance(h: *mut Handle, side_code: u32) -> f64 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.rig.finger_clearance(side(side_code))
}

/// `rig.fingerShape(side)`, copied to the side's shape buffer; returns the point count.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_finger_shape(h: *mut Handle, side_code: u32) -> u32 {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let shape = h.rig.finger_shape(side);
    let out = &mut h.shape[side as usize];
    for (k, v) in shape.iter().enumerate() {
        put3(out, 3 * k, v);
    }
    shape.len() as u32
}

/// `rig.fingerFrame(side)`: the address of the side's Mat3.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_finger_frame(h: *mut Handle, side_code: u32) -> u32 {
    // SAFETY: forwarded from this function's contract.
    addr(unsafe { handle(h) }.rig.finger_frame(side(side_code)))
}

/// `rig.predictHandContact(side, selector, curls, spread)`: curls at scratch 0, spread at 5;
/// returns 1 when the side's prediction record (layout) holds a result, 0 for null.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn hd_rig_predict_hand_contact(
    h: *mut Handle,
    side_code: u32,
    kind: u32,
    which: u32,
    segment: u32,
    surface: u32,
    fraction: f64,
    curl_bits: u32,
    spread_bits: u32,
) -> u32 {
    let side = side(side_code);
    let selector = contact(kind, which, segment, surface, fraction);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let (curls, spread) = (spec(s, 0, curl_bits), spec(s, 5, spread_bits));
        u32::from(
            rig.predict_hand_contact(g, side, &selector, &curls, &spread)
                .is_some(),
        )
    })
}

/// `rig.bootstrapStandingPose(poses)`: STANDING records for L then R from scratch 0; `bits` holds
/// L's curls in bits 0-4, L's spread 5-9, R's curls 10-14, R's spread 15-19.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_bootstrap_standing_pose(h: *mut Handle, bits: u32) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let poses = [0, 1].map(|k| {
            let at = STANDING * k;
            let side_bits = bits >> (10 * k);
            StandingArmPose {
                shoulder: v3(s, at),
                upper_arm: v3(s, at + 3),
                lower_arm: v3(s, at + 6),
                hand: v3(s, at + 9),
                palm: v3(s, at + 12),
                curls: spec(s, at + 15, side_bits & 0x1f),
                spread: spec(s, at + 20, (side_bits >> 5) & 0x1f),
            }
        });
        u32::from(rig.bootstrap_standing_pose(g, &poses))
    })
}

/// `rig.armStateForBodyInitialization(side)`: the address of the ARM_STATE record it returns.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_arm_state_for_body_initialization(
    h: *mut Handle,
    side_code: u32,
) -> u32 {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| addr(rig.arm_state_for_body_initialization(g, side)))
}

/// `rig.acceptedArmState(side)`: the address of its ARM_STATE record.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_accepted_arm_state(h: *mut Handle, side_code: u32) -> u32 {
    // SAFETY: forwarded from this function's contract.
    addr(unsafe { handle(h) }.rig.accepted_arm_state(side(side_code)))
}

/// `rig.armDriver(side)`: the address of its `acceptedQ` (7 f64), 0 for null.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_arm_driver(h: *mut Handle, side_code: u32) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }
        .rig
        .arm_driver(side(side_code))
        .map_or(0, |d| ptr(&d.accepted_q))
}

/// `rig.lastAcceptedHandPose(side)`: the address of its HAND_POSE record, 0 for null.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_last_accepted_hand_pose(h: *mut Handle, side_code: u32) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }
        .rig
        .last_accepted_hand_pose(side(side_code))
        .map_or(0, addr)
}

/// `rig.fingerAxis.get(node)`: the address of the axis, 0 where the map has none.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_finger_axis(h: *mut Handle, node: u32) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }
        .rig
        .finger_axes()
        .axis(node)
        .map_or(0, addr)
}

/// `rig.fingerSplayAxis.get(node)`: the address of the axis, 0 where the map has none.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_finger_splay_axis(h: *mut Handle, node: u32) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }
        .rig
        .finger_axes()
        .splay_axis(node)
        .map_or(0, addr)
}

/// `reachRef(rig.anat, n, perp, framed)`: n at scratch 0, perp out at 3.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_reach_ref(h: *mut Handle, framed: u32) {
    let framed = tristate(framed);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let n = v3(s, 0);
        let mut perp = Vec3::default();
        reach_ref(g, &mut rig.anat, &n, &mut perp, framed);
        put3(s, 3, &perp);
    });
}

/// `poleAngle(rig.p, rig.anat, side, target, pole)`: target at scratch 0, pole at 3; returns 1
/// with the angle at 6, or 0 for null.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_pole_angle(h: *mut Handle, side_code: u32) -> u32 {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, s| {
        let (target, pole) = (v3(s, 0), v3(s, 3));
        match pole_angle(&rig.p, g, &mut rig.anat, side, &target, &pole) {
            Some(angle) => {
                s[6] = angle;
                1
            }
            None => 0,
        }
    })
}

/// `handFrame(point, palm, out)` over a HAND_FRAME buffer: point in and out at 0, palm at 3, out
/// in and out at 6; returns 1, or 0 for null.
///
/// # Safety
/// `buf` must point to HAND_FRAME writable f64, such as a block from `hd_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_hand_frame(buf: *mut f64) -> u32 {
    // SAFETY: the caller passes HAND_FRAME writable f64 the module holds no other reference to.
    let s = unsafe { std::slice::from_raw_parts_mut(buf, HAND_FRAME) };
    let mut point = v3(s, 0);
    let palm = v3(s, 3);
    let mut elements = [0.0; 9];
    elements.copy_from_slice(&s[6..15]);
    let mut out = Mat3 { elements };
    let ok = hand_frame(&mut point, &palm, &mut out).is_some();
    put3(s, 0, &point);
    s[6..15].copy_from_slice(&out.elements);
    u32::from(ok)
}

/// `rig.anat.update()`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_anat_update(h: *mut Handle) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| u32::from(rig.anat.update(g)))
}

/// `rig.anat.surface(P)`: P in and out at scratch 0.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_anat_surface(h: *mut Handle) -> f64 {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let mut p = v3(&h.scratch, 0);
    let depth = h.rig.anat.surface(&mut p);
    put3(&mut h.scratch, 0, &p);
    depth
}

/// `rig.anat.face.refresh()`; traps without a face (layout FACE 0).
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_face_refresh(h: *mut Handle) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.run(|rig, g, _| {
        rig.anat
            .face_mut()
            .expect("the avatar has no face surface")
            .refresh(g);
    });
}

/// `rig.anat.face.shortfall(P, clear, outward)`: outward in and out at scratch 0.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_face_shortfall(
    h: *mut Handle,
    x: f64,
    y: f64,
    z: f64,
    clear: f64,
) -> f64 {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let mut outward = v3(&h.scratch, 0);
    let face = h
        .rig
        .anat
        .face_mut()
        .expect("the avatar has no face surface");
    let short = face.shortfall(&Vec3::new(x, y, z), clear, &mut outward);
    put3(&mut h.scratch, 0, &outward);
    short
}

/// `rig.anat.face.sample(P, out)`: out (distance, normal 3, valid) at scratch 0.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_face_sample(h: *mut Handle, x: f64, y: f64, z: f64) {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let face = h
        .rig
        .anat
        .face_mut()
        .expect("the avatar has no face surface");
    let mut out = Default::default();
    face.sample(&Vec3::new(x, y, z), &mut out);
    let s = &mut h.scratch;
    s[0] = out.distance;
    put3(s, 1, &out.normal);
    s[4] = f64::from(u8::from(out.valid));
}

/// `rig.characterFrame.ready()`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_frame_ready(h: *mut Handle) -> u32 {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let frame = h.frame;
    h.run(|rig, g, _| u32::from(frame.ready(&mut rig.anat, g)))
}

/// `rig.characterFrame.legacyMirror(side)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_frame_legacy_mirror(h: *mut Handle, side_code: u32) -> f64 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.frame.legacy_mirror(side(side_code))
}

/// `rig.characterFrame.axialMirror(side, frameReady)`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_frame_axial_mirror(
    h: *mut Handle,
    side_code: u32,
    ready: u32,
) -> f64 {
    let (side, ready) = (side(side_code), tristate(ready));
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let frame = h.frame;
    h.run(|rig, g, _| frame.axial_mirror(&mut rig.anat, g, side, ready))
}

/// `rig.characterFrame.toWorld(out, value, side, lateral, frameReady)`: value at scratch 0, out
/// at 3; `has_lateral` 0 takes the default.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_frame_to_world(
    h: *mut Handle,
    side_code: u32,
    has_lateral: u32,
    lateral: f64,
    ready: u32,
) {
    let (side, ready) = (side(side_code), tristate(ready));
    let lateral = (has_lateral != 0).then_some(lateral);
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let frame = h.frame;
    h.run(|rig, g, s| {
        let value = tuple(s, 0);
        let mut out = Vec3::default();
        frame.to_world(&mut rig.anat, g, &mut out, &value, side, lateral, ready);
        put3(s, 3, &out);
    });
}

/// `rig.characterFrame.tupleToWorld(out, value, side, lateral, frameReady)`: as
/// `hd_rig_frame_to_world`.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_frame_tuple_to_world(
    h: *mut Handle,
    side_code: u32,
    has_lateral: u32,
    lateral: f64,
    ready: u32,
) {
    let (side, ready) = (side(side_code), tristate(ready));
    let lateral = (has_lateral != 0).then_some(lateral);
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let frame = h.frame;
    h.run(|rig, g, s| {
        let value = tuple(s, 0);
        let mut out = [0.0; 3];
        frame.tuple_to_world(&mut rig.anat, g, &mut out, &value, side, lateral, ready);
        s[3..6].copy_from_slice(&out);
    });
}

/// `rig.characterFrame.toCharacter(out, value, side, frameReady)`: value at scratch 0, out at 3.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_frame_to_character(h: *mut Handle, side_code: u32, ready: u32) {
    let (side, ready) = (side(side_code), tristate(ready));
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let frame = h.frame;
    h.run(|rig, g, s| {
        let value = v3(s, 0);
        let mut out = Vec3::default();
        frame.to_character(&mut rig.anat, g, &mut out, &value, side, ready);
        put3(s, 3, &out);
    });
}

impl Transaction {
    fn followed(&self) -> ArmFollowed {
        let b = &self.buffer[FOLLOWED..FOLLOWED + FOLLOWED_LEN];
        let mut f = ArmFollowed::default();
        for s in 0..2 {
            for slot in 0..4 {
                f.arm_dirs[s][slot] = tuple(b, 12 * s + 3 * slot);
            }
            f.palm_out[s] = tuple(b, 24 + 3 * s);
            f.palm_w[s] = b[30 + s];
            f.twist[s] = b[32 + s];
            f.finger_spec[s].copy_from_slice(&b[34 + 5 * s..39 + 5 * s]);
            f.finger_spread_spec[s].copy_from_slice(&b[44 + 5 * s..49 + 5 * s]);
        }
        f
    }

    fn publish_work(&mut self) {
        let w = &self.tx.work;
        let counts = [
            w.plans,
            w.validations,
            w.repairs,
            w.stop_tails,
            w.holds,
            w.solver_calls,
            w.solver_iterations,
            w.environment_batches,
        ];
        for (k, c) in counts.into_iter().enumerate() {
            self.buffer[TX_WORK + k] = c as f64;
        }
    }
}

/// `rig.armTransaction(arm, output, leadFloor)`: a transaction over rig `h` with its character
/// frame.
///
/// # Safety
/// As for `hd_rig_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_new_transaction(
    h: *mut Handle,
    lead_floor: f64,
) -> *mut Transaction {
    // SAFETY: forwarded from this function's contract.
    let frame = unsafe { handle(h) }.frame;
    let mut t = Box::new(Transaction {
        tx: ArmTransaction::new(frame, lead_floor),
        rig: h as usize,
        buffer: [0.0; TX_BUFFER],
    });
    t.publish_work();
    Box::into_raw(t)
}

/// Frees a transaction.
///
/// # Safety
/// `t` must come from `hd_rig_new_transaction` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_free_transaction(t: *mut Transaction) {
    // SAFETY: the caller passes the pointer `Box::into_raw` returned, once.
    drop(unsafe { Box::from_raw(t) });
}

/// The transaction's buffer: followed, q, notes, work.
///
/// # Safety
/// As for `hd_rig_free_transaction`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_tx_buffer(t: *mut Transaction) -> *mut f64 {
    // SAFETY: forwarded from this function's contract.
    unsafe { transaction(t, std::ptr::null_mut()) }
        .buffer
        .as_mut_ptr()
}

/// `transaction.beginFrame()`.
///
/// # Safety
/// As for `hd_rig_free_transaction`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_tx_begin_frame(t: *mut Transaction) {
    // SAFETY: forwarded from this function's contract.
    let t = unsafe { transaction(t, std::ptr::null_mut()) };
    t.tx.begin_frame();
    t.publish_work();
}

/// `transaction.retime(seconds)`.
///
/// # Safety
/// As for `hd_rig_free_transaction`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_tx_retime(t: *mut Transaction, seconds: f64) {
    // SAFETY: forwarded from this function's contract.
    unsafe { transaction(t, std::ptr::null_mut()) }
        .tx
        .retime(seconds);
}

/// `transaction.resetRoute(side, q)`: q at the buffer's Q.
///
/// # Safety
/// As for `hd_rig_free_transaction`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_tx_reset_route(t: *mut Transaction, side_code: u32) {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    let t = unsafe { transaction(t, std::ptr::null_mut()) };
    let mut q = [0.0; 7];
    q.copy_from_slice(&t.buffer[TX_Q..TX_Q + 7]);
    t.tx.reset_route(side, &q);
}

/// `transaction.stageClaspLeader(side, dt, frameReady)` on rig `h`, reading the followed record.
///
/// # Safety
/// As for `hd_rig_free_transaction`, and `h` is the live rig the transaction was made for.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_tx_stage_clasp_leader(
    t: *mut Transaction,
    h: *mut Handle,
    side_code: u32,
    dt: f64,
    frame_ready: u32,
) {
    let side = side(side_code);
    // SAFETY: forwarded from this function's contract.
    let (t, h) = unsafe { (transaction(t, h), handle(h)) };
    let followed = t.followed();
    h.run(|rig, g, _| {
        t.tx.stage_clasp_leader(rig, g, &followed, side, dt, frame_ready != 0)
    });
    t.publish_work();
}

/// `transaction.commit(dt, hipsRise, hipsTurn)` on rig `h`, reading the followed record; returns
/// the count of NOTE records written for `ArmResolver.note`, in call order.
///
/// # Safety
/// As for `hd_rig_tx_stage_clasp_leader`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_rig_tx_commit(
    t: *mut Transaction,
    h: *mut Handle,
    dt: f64,
    hips_rise: f64,
    hips_turn: f64,
) -> u32 {
    // SAFETY: forwarded from this function's contract.
    let (t, h) = unsafe { (transaction(t, h), handle(h)) };
    let followed = t.followed();
    h.run(|rig, g, _| t.tx.commit(rig, g, &followed, dt, hips_rise, hips_turn));
    let notes = t.tx.notes();
    let count = notes.len();
    for (k, n) in notes.iter().enumerate() {
        let at = TX_NOTES + NOTE * k;
        t.buffer[at] = f64::from(n.side as u8);
        t.buffer[at + 1..at + 4].copy_from_slice(&n.upper_arm);
        t.buffer[at + 4..at + 7].copy_from_slice(&n.lower_arm);
        t.buffer[at + 7..at + 10].copy_from_slice(&n.hand);
    }
    t.publish_work();
    count as u32
}

#[cfg(test)]
mod tests {
    //! Builds the base synthetic avatar of `hashidate-core/tests/corpora/avatar-base` through the
    //! same calls the facade makes, and runs one frame of them: a wiring check, not a parity one.

    use super::*;
    use crate::profile::*;
    use crate::scene::{hd_scene_build, hd_scene_free, hd_scene_new};
    use hashidate_core::math::Mat4;
    use hashidate_core::rig::hand_geometry::HandGeometryPoint;
    use hashidate_core::scene::graph::{RECORD, flag};

    const SLOTS: [&str; 23] = [
        "hips",
        "spine",
        "chest",
        "neck",
        "head",
        "eye.L",
        "eye.R",
        "shoulder.L",
        "shoulder.R",
        "upperArm.L",
        "upperArm.R",
        "lowerArm.L",
        "lowerArm.R",
        "hand.L",
        "hand.R",
        "upperLeg.L",
        "upperLeg.R",
        "lowerLeg.L",
        "lowerLeg.R",
        "foot.L",
        "foot.R",
        "toe.L",
        "toe.R",
    ];
    const FINGERS: [&str; 5] = ["thumb", "index", "middle", "ring", "little"];
    const SIDES: [&str; 2] = ["L", "R"];
    const LIMB: [&str; 6] = ["upper", "lower", "thigh", "shin", "pitch", "proximal"];
    const TWISTS: [&str; 4] = ["upperArm.L", "upperArm.R", "lowerArm.L", "lowerArm.R"];

    /// `avatar-base.json`'s named arrays over `avatar-base.bin`.
    struct Base {
        index: Vec<(String, String, usize, usize)>,
        bytes: Vec<u8>,
    }

    fn field<'a>(entry: &'a str, key: &str) -> &'a str {
        let at = entry.find(&format!("\"{key}\"")).unwrap() + key.len() + 2;
        let rest = entry[at..].trim_start_matches([':', ' ', '"']);
        rest.split(['"', ',', '\n', '}']).next().unwrap().trim()
    }

    impl Base {
        fn load() -> Base {
            let dir = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../hashidate-core/tests/corpora"
            );
            let json = std::fs::read_to_string(format!("{dir}/avatar-base.json")).unwrap();
            let index = json
                .split('{')
                .skip(2)
                .map(|e| {
                    let n = |k| field(e, k).parse().unwrap();
                    (
                        field(e, "name").to_owned(),
                        field(e, "kind").to_owned(),
                        n("offset"),
                        n("len"),
                    )
                })
                .collect();
            let bytes = std::fs::read(format!("{dir}/avatar-base.bin")).unwrap();
            Base { index, bytes }
        }

        fn raw(&self, name: &str, kind: &str, width: usize) -> Option<Vec<&[u8]>> {
            let (_, k, offset, len) = self.index.iter().find(|e| e.0 == name)?;
            assert_eq!(k, kind, "{name}");
            Some(
                self.bytes[*offset..offset + len * width]
                    .chunks(width)
                    .collect(),
            )
        }

        fn u32(&self, name: &str) -> Option<Vec<u32>> {
            let raw = self.raw(name, "u32", 4)?;
            Some(
                raw.iter()
                    .map(|c| u32::from_le_bytes((*c).try_into().unwrap()))
                    .collect(),
            )
        }

        fn f64(&self, name: &str) -> Option<Vec<f64>> {
            let raw = self.raw(name, "f64", 8)?;
            Some(
                raw.iter()
                    .map(|c| f64::from_le_bytes((*c).try_into().unwrap()))
                    .collect(),
            )
        }

        fn f32(&self, name: &str) -> Option<Vec<f32>> {
            let raw = self.raw(name, "f32", 4)?;
            Some(
                raw.iter()
                    .map(|c| f32::from_le_bytes((*c).try_into().unwrap()))
                    .collect(),
            )
        }

        fn one(&self, name: &str) -> Option<f64> {
            self.f64(name).map(|v| v[0])
        }
    }

    fn mat4(s: &[f64], i: usize) -> Mat4 {
        Mat4::from_elements(s[16 * i..16 * i + 16].try_into().unwrap())
    }

    /// The node table, registered as `SceneGraph` registers it.
    fn scene(base: &Base) -> u32 {
        let get = |name: &str| base.f64(name).unwrap();
        let kind = base.u32("node.kind").unwrap();
        let parent = base.u32("node.parent").unwrap();
        let flags = base.u32("node.flags").unwrap();
        let (position, quaternion, scale, pivot) = (
            get("node.position"),
            get("node.quaternion"),
            get("node.scale"),
            get("node.pivot"),
        );
        let (matrix, world) = (get("node.matrix"), get("node.matrixWorld"));
        let meshes = base.u32("skinned.node").unwrap();
        let bind_mode = base.u32("skinned.bindMode").unwrap();
        let counts = base.u32("skeleton.boneCount").unwrap();
        let bones = base.u32("skeleton.bones").unwrap();
        let (bind, bind_inverse) = (get("skinned.bindMatrix"), get("skinned.bindMatrixInverse"));
        let inverses = get("skeleton.boneInverses");
        let h = hd_scene_new(
            kind.len() as u32,
            meshes.len() as u32,
            counts.len() as u32,
            bones.len() as u32,
        );
        with_scenes(|scenes| {
            let g = &mut scenes.get(h).graph;
            let mut record = [0.0; RECORD];
            for i in 0..kind.len() {
                record[0..3].copy_from_slice(&position[3 * i..3 * i + 3]);
                record[3..7].copy_from_slice(&quaternion[4 * i..4 * i + 4]);
                record[7..10].copy_from_slice(&scale[3 * i..3 * i + 3]);
                record[10..13].copy_from_slice(&pivot[3 * i..3 * i + 3]);
                record[13..29].copy_from_slice(&matrix[16 * i..16 * i + 16]);
                record[29..45].copy_from_slice(&world[16 * i..16 * i + 16]);
                let mut f = flags[i] as u8;
                match kind[i] {
                    1 => f |= flag::BONE,
                    3 => {
                        f |= flag::SKINNED;
                        let m = meshes.iter().position(|&n| n as usize == i).unwrap();
                        if bind_mode[m] == 1 {
                            f |= flag::DETACHED;
                        }
                    }
                    _ => {}
                }
                g.push_node(parent[i], f, &record);
            }
            for (m, &node) in meshes.iter().enumerate() {
                g.push_mesh(node, &mat4(&bind, m), &mat4(&bind_inverse, m));
            }
            let mut b = 0;
            for &count in &counts {
                g.push_skeleton();
                for _ in 0..count {
                    g.push_bone(bones[b], &mat4(&inverses, b));
                    b += 1;
                }
            }
        });
        hd_scene_build(h);
        h
    }

    /// The profile, assembled through `hd_profile_*` as the facade assembles it.
    fn profile(base: &Base) -> *mut Builder {
        let p = hd_profile_new();
        // SAFETY: `p` is live until handed to `hd_rig_new`, and the scratch and the buffers the
        // calls return are written within their lengths.
        unsafe {
            for (i, slot) in SLOTS.iter().enumerate() {
                let node = base.u32(&format!("profile.bones.{slot}")).unwrap()[0];
                hd_profile_bone(p, i as u32, node);
                if let Some(d) = base.f64(&format!("profile.restDir.{slot}")) {
                    hd_profile_rest_dir(p, i as u32, d[0], d[1], d[2]);
                }
            }
            for (s, side) in SIDES.iter().enumerate() {
                for (f, finger) in FINGERS.iter().enumerate() {
                    let Some(chain) = base.u32(&format!("profile.fingerBones.{finger}.{side}"))
                    else {
                        continue;
                    };
                    hd_profile_finger(p, s as u32, f as u32, chain.len() as u32);
                    for (i, &node) in chain.iter().enumerate() {
                        let d = base
                            .f64(&format!("profile.restDir.{finger}.{side}.{i}"))
                            .unwrap();
                        hd_profile_finger_bone(
                            p, s as u32, f as u32, i as u32, node, d[0], d[1], d[2],
                        );
                    }
                }
                for (k, key) in LIMB.iter().enumerate() {
                    if let Some(v) = base.one(&format!("profile.limb.{key}.{side}")) {
                        hd_profile_limb(p, s as u32, k as u32, v);
                    }
                }
                for (f, finger) in FINGERS.iter().enumerate() {
                    if let Some(v) = base.one(&format!("profile.limb.tip.{side}.{finger}")) {
                        hd_profile_limb(p, s as u32, 6 + f as u32, v);
                    }
                }
            }
            hd_profile_side_sign(p, base.one("profile.sideSign").unwrap());
            let scratch = std::slice::from_raw_parts_mut(hd_profile_scratch(p), 16);
            let mut at = 0;
            for name in ["origin", "right", "up", "forward"] {
                scratch[at..at + 3]
                    .copy_from_slice(&base.f64(&format!("profile.face.{name}")).unwrap());
                at += 3;
            }
            scratch[12] = base.one("profile.face.ipd").unwrap();
            let mouth = base.f64("profile.face.mouth");
            if let Some(m) = &mouth {
                scratch[13..16].copy_from_slice(m);
            }
            hd_profile_face(p, u32::from(mouth.is_some()));
            for (k, name) in ["right", "up", "forward"].iter().enumerate() {
                scratch[3 * k..3 * k + 3]
                    .copy_from_slice(&base.f64(&format!("profile.body.{name}")).unwrap());
            }
            let span = base.one("profile.body.span");
            scratch[9] = span.unwrap_or(0.0);
            hd_profile_body(p, u32::from(span.is_some()));
            for (k, slot) in TWISTS.iter().enumerate() {
                let node = |f: &str| {
                    base.u32(&format!("profile.armTwists.{slot}.{f}"))
                        .map(|v| v[0])
                };
                if let Some(primary) = node("primary") {
                    hd_profile_arm_twist(
                        p,
                        k as u32,
                        primary,
                        node("next").unwrap(),
                        node("helper").unwrap(),
                    );
                }
            }
            for (part, name) in ["torso", "head"].iter().enumerate() {
                let one = |f: &str| base.one(&format!("measure.{name}.{f}")).unwrap();
                let r = base.f32(&format!("measure.{name}.r"));
                let cells = r.as_ref().map_or(0, Vec::len);
                let out = hd_profile_volume(
                    p,
                    part as u32,
                    u32::from(r.is_some()),
                    cells as u32,
                    one("bands"),
                    one("sectors"),
                    one("top"),
                    one("bottom"),
                    one("radius"),
                );
                if let Some(r) = r {
                    std::slice::from_raw_parts_mut(out, cells).copy_from_slice(&r);
                }
            }
            let pos = base.f32("measure.face.pos").unwrap();
            let nrm = base.f32("measure.face.nrm").unwrap();
            let out = hd_profile_face_skin(p, (pos.len() / 3) as u32);
            std::slice::from_raw_parts_mut(out, pos.len()).copy_from_slice(&pos);
            std::slice::from_raw_parts_mut(hd_profile_face_normals(p), nrm.len())
                .copy_from_slice(&nrm);
        }
        p
    }

    fn finite(values: &[f64]) -> bool {
        values.iter().all(|v| v.is_finite())
    }

    #[test]
    fn the_base_avatar_runs_one_frame_through_the_exports() {
        let base = Base::load();
        let scene = scene(&base);
        let p = profile(&base);
        // SAFETY: every handle below is live until freed at the end, and each scratch is read
        // and written within SCRATCH.
        unsafe {
            let h = hd_rig_new(scene, p);
            let layout = std::slice::from_raw_parts(hd_rig_layout(h), LAYOUT);
            let rig = &handle(h).rig;
            assert_eq!(layout[1], addr(rig.anat.right()));
            assert_eq!(layout[4], addr(rig.anat.axis_o()));
            assert_eq!(layout[6], ptr(&rig.fore_roll));
            assert_ne!(layout[8], 0, "palmLocal.L");
            assert_eq!(layout[23], 1, "face");
            assert_eq!(layout[25], 0, "armSolverOff");
            assert_eq!(layout[22] as usize, size_of::<HandGeometryPoint>());
            for side in 0..2 {
                assert_ne!(layout[14 + side], 0, "contact");
                assert_ne!(layout[18 + side], 0, "shape");
                assert!(layout[12 + side] > 0, "shape capacity");
                assert_ne!(hd_rig_arm_driver(h, side as u32), 0);
                assert_ne!(hd_rig_last_accepted_hand_pose(h, side as u32), 0);
            }
            assert_eq!(hd_rig_limits_enabled(h), 1);

            hd_rig_set_dt(h, 1.0 / 60.0);
            assert_eq!(hd_rig_dt(h), 1.0 / 60.0);
            let tx = hd_rig_new_transaction(h, 0.12);
            let buffer = std::slice::from_raw_parts_mut(hd_rig_tx_buffer(tx), TX_BUFFER);
            for side in 0..2u32 {
                let q = hd_rig_arm_driver(h, side);
                assert_eq!(
                    q,
                    ptr(&handle(h).rig.arm_driver(side_of(side)).unwrap().accepted_q)
                );
                let accepted = handle(h).rig.arm_driver(side_of(side)).unwrap().accepted_q;
                buffer[TX_Q..TX_Q + 7].copy_from_slice(&accepted);
                hd_rig_tx_reset_route(tx, side);
            }

            // One frame, in the order Body makes the calls.
            hd_rig_tx_begin_frame(tx);
            hd_rig_reset(h);
            hd_rig_add_offset(h, 2, 0.02, 0.01, 0.0);
            hd_rig_add_offset(h, 4, 0.0, 0.05, 0.0);
            hd_rig_commit_spine(h);
            hd_rig_plant_legs(h, 0.0, 0.0, 0);
            assert_eq!(hd_rig_anat_update(h), 1);
            assert_eq!(hd_rig_begin_body_arm_frame(h), 1);
            assert_eq!(hd_rig_frame_ready(h), 1);
            let s = std::slice::from_raw_parts_mut(hd_rig_scratch(h), SCRATCH);
            s[0..3].copy_from_slice(&[0.0, -1.0, 0.2]);
            hd_rig_frame_to_world(h, 1, 0, 0.0, 2);
            let world = v3(s, 3);
            assert!((world.length() - 1.0).abs() < 1e-12);
            s[0..3].copy_from_slice(&[world.x, world.y, world.z]);
            hd_rig_frame_to_character(h, 1, 1);
            assert!((s[3] - 0.0).abs() < 1e-9 && (s[4] + 1.0 / 1.04f64.sqrt()).abs() < 1e-9);
            for side in 0..2u32 {
                let state = *handle(h).rig.accepted_arm_state(side_of(side));
                assert_eq!(
                    hd_rig_accepted_arm_state(h, side),
                    addr(handle(h).rig.accepted_arm_state(side_of(side)))
                );
                let s = side as usize;
                for slot in 0..4 {
                    buffer[12 * s + 3 * slot..12 * s + 3 * slot + 3]
                        .copy_from_slice(&state.directions[slot]);
                }
                buffer[24 + 3 * s..27 + 3 * s].copy_from_slice(&state.palm);
                buffer[30 + s] = 1.0;
                buffer[32 + s] = 0.0;
                buffer[34 + 5 * s..39 + 5 * s].copy_from_slice(&state.curls);
                buffer[44 + 5 * s..49 + 5 * s].copy_from_slice(&state.spread);
            }
            let notes = hd_rig_tx_commit(tx, h, 1.0 / 60.0, 0.0, 0.0);
            assert!(notes <= 2);
            for k in 0..notes as usize {
                assert!(finite(
                    &buffer[TX_NOTES + NOTE * k..TX_NOTES + NOTE * (k + 1)]
                ));
            }
            assert!(buffer[TX_WORK + 1] >= 2.0, "both arms validated");
            hd_rig_commit_eyes(h);
            s[0..4].copy_from_slice(&[0.0, 0.0, 0.0, 1.0]);
            assert_eq!(hd_rig_read_head_offset(h), 1);
            assert!(finite(&s[0..4]));

            // The queries motion makes between those calls.
            let shoulder = with_scenes(|g| {
                let g = &mut g.get(scene).graph;
                let upper = handle(h).rig.p.bones[9];
                g.update_world_matrix(upper, true, false, false);
                g.world_position(upper)
            });
            let fwd = *handle(h).rig.anat.fwd();
            s[0..3].copy_from_slice(&[
                shoulder.x + 0.3 * fwd.x,
                shoulder.y + 0.3 * fwd.y,
                shoulder.z + 0.3 * fwd.z,
            ]);
            s[9..9 + SOLUTION].fill(0.0);
            assert_eq!(hd_rig_solve_reach_natural(h, 1, 0, 0), 1);
            assert!(finite(&s[9..9 + SOLUTION]));
            assert_eq!(hd_rig_measure(h, 1), 1);
            assert!(finite(&handle(h).readings));
            s[0..10].fill(0.0);
            assert_eq!(
                hd_rig_predict_hand_contact(h, 1, 0, 1, 0, 3, 0.0, 0x1f, 0x1f),
                1
            );
            hd_rig_face_refresh(h);
            let head = handle(h).rig.p.bones[4];
            let at = with_scenes(|g| g.get(scene).graph.world_position(head));
            hd_rig_face_sample(h, at.x, at.y, at.z + 0.2);
            assert!(finite(&s[0..5]));
            let points = hd_rig_finger_shape(h, 1);
            assert!(points > 0 && points <= layout[13]);
            assert!(finite(&handle(h).shape[1][..3 * points as usize]));
            assert_eq!(
                hd_rig_finger_frame(h, 1),
                addr(handle(h).rig.finger_frame(Side::R))
            );
            assert!(hd_rig_finger_clearance(h, 1) > 0.0);

            let buf = [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            ];
            let mut buf = buf;
            assert_eq!(hd_rig_hand_frame(buf.as_mut_ptr()), 1);
            assert!(finite(&buf));

            hd_rig_free_transaction(tx);
            hd_rig_free(h);
        }
        hd_scene_free(scene);
    }

    fn side_of(code: u32) -> Side {
        side(code)
    }

    #[test]
    #[should_panic(expected = "tri-state code 3 out of range")]
    fn a_code_out_of_range_traps() {
        tristate(3);
    }
}
