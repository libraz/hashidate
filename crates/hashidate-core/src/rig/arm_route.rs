//! `rig/arm-route.ts`: per-frame goal tracking for one constrained arm.
//!
//! Each frame the goal is one bounded solver step continuing its own chain
//! toward the frame's request, or the raw q where that is the same branch. The
//! command is the goal plus a residual carry: where what is shown and the goal
//! part — a gesture starts or ends, a recovery lands elsewhere, a stop tail
//! ends — the gap is carried with its rate and eased out over the lead, as the
//! spine's carry is.
//! When a frame cannot be validated, a quartic tail brings the accepted jet to rest.
//!
//! All arrays are in the solver's q order, relative to the upper arm's parent. The TS reads the
//! driver's `environment` through the driver; here the anatomy it samples arrives with `track`.

// The route indexes several seven-value arrays by the same DOF, as the TS does, and its negated
// comparisons are what let a NaN fail them.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use crate::anatomy::arm::ArmAnatomy;
use crate::math::f::{atan2, cos, js_max, js_min, sin, sqrt};
use crate::rig::arm_configuration::{
    ArmConfiguration, ArmForwardContext, ArmForwardResult, forward_arm,
};
use crate::rig::arm_driver::{ArmDriver, DriverOutput, LIMIT_SLEW};
use crate::rig::arm_path::plan::{ArmPathBounds, ArmPathStatus, configuration_from_q};
use crate::rig::hands::FingerSpec;

const DOFS: usize = 7;

/// Seconds between locked validations of a frame's arm motion. Sets collision
/// coverage per second rather than per frame, so a slow frame is checked as
/// densely along its path as two fast ones.
pub const VALIDATION_INTERVAL: f64 = 1.0 / 60.0;

/// Most validations one frame may spend, reached below 20 fps. Past it a frame is
/// too long to cover anyway, and the cap keeps a stall from compounding.
pub const MAX_VALIDATION_SAMPLES: f64 = 4.0;

/// Wrist flexion and deviation in q order, which the slew check rate-limits directly.
pub const SLEW_WRIST_DOFS: [usize; 2] = [5, 6];

/// Share of the slew allowance a slowed step settles for, and the evaluations
/// its search may spend. The last 2% is not visible; listen into cover needed
/// at most four evaluations.
const SLEW_FILL: f64 = 0.98;
const SLEW_SEARCH: usize = 6;

// arm-route.ts residualCarry
//
// One derivative of the residual carry: a cubic Hermite from `from` at rate
// `rate` to rest at zero over `duration`, as the spine's carry eases a cut
// rate out. Zero once the duration has passed. `order` is 0 or 1.
pub fn residual_carry(from: f64, rate: f64, duration: f64, time: f64, order: u8) -> f64 {
    if !(duration > 0.0) || time >= duration {
        return 0.0;
    }
    let s = js_max(0.0, time) / duration;
    if order == 0 {
        return from * (1.0 + 2.0 * s) * (1.0 - s) * (1.0 - s)
            + rate * s * (1.0 - s) * (1.0 - s) * duration;
    }
    (from * 6.0 * s * (s - 1.0)) / duration + rate * (1.0 - s) * (1.0 - 3.0 * s)
}

/// The bone rotations the slew check compares; an `ArmForwardResult` provides them, and only its
/// three local rotations are read.
pub type ArmSlewPose = ArmForwardResult;

// arm-route.ts difference
//
// Plane difference taken the short way round; every other DOF is a plain difference.
fn difference(a: &[f64; DOFS], b: &[f64; DOFS], i: usize) -> f64 {
    let d = a[i] - b[i];
    if i == 0 { atan2(sin(d), cos(d)) } else { d }
}

// arm-route.ts stopTail
//
// One derivative of the quartic that brings the jet (x0, v0, a0) to rest with
// zero velocity and acceleration at `h`, held afterwards. `order` is 0, 1 or 2.
pub fn stop_tail(x0: f64, v0: f64, a0: f64, h: f64, t: f64, order: u8) -> f64 {
    if !(h > 0.0) {
        return if order == 0 { x0 } else { 0.0 };
    }
    if t >= h && order != 0 {
        return 0.0;
    }
    let s = js_min(js_max(0.0, t), h);
    let b3 = -(v0 / (h * h) + (2.0 * a0) / (3.0 * h));
    let b4 = v0 / (2.0 * h * h * h) + a0 / (4.0 * h * h);
    if order == 0 {
        return x0 + s * (v0 + s * (0.5 * a0 + s * (b3 + s * b4)));
    }
    if order == 1 {
        return v0 + s * (a0 + s * (3.0 * b3 + s * 4.0 * b4));
    }
    a0 + s * (6.0 * b3 + s * 12.0 * b4)
}

// arm-route.ts clampToBox
//
// Clamp each q component into the bounds. The TS lets `out` alias `q`; in place here is
// `clamp_to_box(&q.clone(), bounds, q)`, the same values.
pub fn clamp_to_box<'o>(
    q: &[f64; DOFS],
    bounds: &ArmPathBounds,
    out: &'o mut [f64; DOFS],
) -> &'o mut [f64; DOFS] {
    for i in 0..DOFS {
        out[i] = js_min(bounds.upper[i], js_max(bounds.lower[i], q[i]));
    }
    out
}

// arm-route.ts validationSamples
//
// Locked validations for one frame of `dt` seconds.
pub fn validation_samples(dt: f64) -> f64 {
    js_min(
        MAX_VALIDATION_SAMPLES,
        js_max(1.0, (dt / VALIDATION_INTERVAL - 1e-9).ceil()),
    )
}

// arm-route.ts armStepWithinSlew
//
// How many times over the slew allowance one step travels: the wrist DOFs
// directly, the three bones as local rotation angles. At most 1 is within.
pub fn arm_step_within_slew(
    from_q: &[f64; DOFS],
    from: &ArmSlewPose,
    to_q: &[f64; DOFS],
    to: &ArmSlewPose,
    dt: f64,
) -> f64 {
    let allowance = LIMIT_SLEW * js_max(0.0, dt) + sqrt(f64::EPSILON);
    let mut step = 0.0;
    for dof in SLEW_WRIST_DOFS {
        step = js_max(step, (to_q[dof] - from_q[dof]).abs());
    }
    step = js_max(
        js_max(
            js_max(step, from.upper_local.angle_to(&to.upper_local)),
            from.lower_local.angle_to(&to.lower_local),
        ),
        from.hand_local.angle_to(&to.hand_local),
    );
    step / allowance
}

/// Goal tracker for one arm; owned by the body, one per side.
#[derive(Clone, Debug)]
pub struct ArmRoute {
    /// Where the solver put this frame's request.
    pub goal_q: [f64; DOFS],
    /// Accepted jet.
    pub q_acc: [f64; DOFS],
    pub v_acc: [f64; DOFS],
    pub a_acc: [f64; DOFS],
    /// Jet the stop tail starts from.
    pub tail0: [f64; DOFS],
    pub tail_v: [f64; DOFS],
    pub tail_a: [f64; DOFS],
    /// The residual carry's start and rate there.
    pub carry_from: [f64; DOFS],
    pub carry_rate: [f64; DOFS],
    /// The goal's rate over the last accepted frame, away from discontinuities.
    goal_velocity: [f64; DOFS],
    goal_prev: [f64; DOFS],

    carry_time: f64,
    carry_duration: f64,
    /// A discontinuity is due: the next track restarts the carry from the accepted jet.
    recarry: bool,
    has_goal_prev: bool,
    projected: bool,
    solved: bool,
    stopping: bool,
    tail_t: f64,
    configuration: ArmConfiguration,
    step: [f64; DOFS],
    forward: ArmForwardResult,
    goal_forward: ArmForwardResult,
    /// Shortest carry and stop-tail length, in seconds.
    lead_floor: f64,
    /// How often `track` took each way to its goal, in [`TrackBranch`] order.
    #[cfg(test)]
    pub branches: [usize; 6],
}

/// The ways `track` finds a goal, for the tests that check a run reached each one.
#[cfg(test)]
#[derive(Clone, Copy, Debug)]
pub enum TrackBranch {
    Raw,
    StationaryStep,
    Planned,
    BlockedStep,
    BlockedRestore,
    Reseed,
}

impl ArmRoute {
    // arm-route.ts ArmRoute.constructor
    //
    // `lead_floor`: shortest carry and stop-tail length, in seconds.
    pub fn new(lead_floor: f64) -> ArmRoute {
        ArmRoute {
            goal_q: [0.0; DOFS],
            q_acc: [0.0; DOFS],
            v_acc: [0.0; DOFS],
            a_acc: [0.0; DOFS],
            tail0: [0.0; DOFS],
            tail_v: [0.0; DOFS],
            tail_a: [0.0; DOFS],
            carry_from: [0.0; DOFS],
            carry_rate: [0.0; DOFS],
            goal_velocity: [0.0; DOFS],
            goal_prev: [0.0; DOFS],
            carry_time: 0.0,
            carry_duration: lead_floor,
            recarry: false,
            has_goal_prev: false,
            projected: false,
            solved: false,
            stopping: false,
            tail_t: 0.0,
            configuration: ArmConfiguration::default(),
            step: [0.0; DOFS],
            forward: ArmForwardResult::default(),
            goal_forward: ArmForwardResult::default(),
            lead_floor,
            #[cfg(test)]
            branches: [0; 6],
        }
    }

    // arm-route.ts ArmRoute.projected
    //
    // The solver moved this frame's goal off the raw q.
    pub fn projected(&self) -> bool {
        self.projected
    }

    // arm-route.ts ArmRoute.solved
    //
    // This frame's goal came from a solver call rather than the raw q itself.
    pub fn solved(&self) -> bool {
        self.solved
    }

    // arm-route.ts ArmRoute.stopping
    pub fn stopping(&self) -> bool {
        self.stopping
    }

    // arm-route.ts ArmRoute.reset
    //
    // Forget the route: `q` is accepted and at rest, with nothing carried.
    pub fn reset(&mut self, q: &[f64; DOFS]) {
        self.q_acc = *q;
        self.v_acc = [0.0; DOFS];
        self.a_acc = [0.0; DOFS];
        self.goal_q = *q;
        self.carry_from = [0.0; DOFS];
        self.carry_rate = [0.0; DOFS];
        self.goal_velocity = [0.0; DOFS];
        self.carry_time = 0.0;
        self.recarry = false;
        self.has_goal_prev = false;
        self.projected = false;
        self.solved = false;
        self.stopping = false;
        self.tail_t = 0.0;
    }

    // arm-route.ts ArmRoute.retime
    //
    // A gesture started, began its exit or ended: carry whatever the goal does
    // next out over `seconds`.
    pub fn retime(&mut self, seconds: f64) {
        self.carry_duration = js_max(seconds, self.lead_floor);
        self.recarry = true;
    }

    // arm-route.ts ArmRoute.track
    //
    // Find this frame's goal for the request `driver` holds, whose analytic
    // inverse is `raw`. One bounded solver step continues the goal's own chain,
    // as the per-frame solve always has. The raw decomposition replaces it only
    // when that step is not still travelling and raw is within one frame's slew
    // of the chain: elsewhere it can be another branch of the same hand, and
    // switching to it is a jump. Only a blocked chain moves to raw's branch, by
    // `reseed`, and the slew and the carry's absorb keep that jump off the
    // committed arm. Returns the environment batches spent.
    #[allow(clippy::too_many_arguments)]
    pub fn track(
        &mut self,
        driver: &mut ArmDriver,
        anat: &mut ArmAnatomy,
        context: &ArmForwardContext,
        raw: &[f64; DOFS],
        curls: &FingerSpec,
        spread: &FingerSpec,
        dt: f64,
    ) -> usize {
        let goal = self.goal_q;
        let planned = driver.plan_from(anat, &goal, context, dt, true);
        let mut batches = planned.environment_batches;
        let status = planned.status;
        let planned_q = planned.q;
        let blocked = status == ArmPathStatus::Blocked;
        let chain_error = planned.position_error;
        let bounds = *driver.fill_bounds(raw, 0.0, false);
        let mut in_box = true;
        let mut i = 0;
        while i < DOFS && in_box {
            in_box = raw[i] >= bounds.lower[i] && raw[i] <= bounds.upper[i];
            i += 1;
        }
        let mut use_raw = status != ArmPathStatus::Progress && in_box;
        if use_raw {
            forward_arm(
                configuration_from_q(&self.goal_q, &mut self.configuration),
                &driver.calibration,
                context,
                &mut self.goal_forward,
            );
            forward_arm(
                configuration_from_q(raw, &mut self.configuration),
                &driver.calibration,
                context,
                &mut self.forward,
            );
            use_raw =
                arm_step_within_slew(&self.goal_q, &self.goal_forward, raw, &self.forward, dt)
                    <= 1.0;
        }
        if use_raw {
            use_raw = driver.validate_locked_pose(
                anat,
                raw,
                context,
                curls,
                spread,
                DriverOutput::Bridge,
            );
            batches += driver.bridge_output.environment_batches;
        }
        self.solved = !use_raw;
        #[cfg(test)]
        let branch = |route: &mut ArmRoute, b: TrackBranch| route.branches[b as usize] += 1;
        if use_raw {
            #[cfg(test)]
            branch(self, TrackBranch::Raw);
            self.goal_q = *raw;
        } else if status == ArmPathStatus::Stationary {
            // A chain stopped at a minimum of the box short of the request can be a
            // local one; an admissible raw is still reached one box step at a time.
            let stepped =
                in_box && self.step_toward_raw(driver, anat, context, raw, curls, spread, dt);
            if in_box {
                batches += driver.bridge_output.environment_batches;
            }
            #[cfg(test)]
            if stepped {
                branch(self, TrackBranch::StationaryStep);
            }
            self.goal_q = if stepped { self.step } else { planned_q };
        } else if status != ArmPathStatus::Blocked {
            #[cfg(test)]
            branch(self, TrackBranch::Planned);
            self.goal_q = planned_q;
        } else {
            // A blocked chain is not always a blocked arm: the solver's step can fail
            // from a corner of the joint box, and holding the goal there would hold
            // it for good. One box step toward an admissible raw keeps it reachable.
            let stepped =
                in_box && self.step_toward_raw(driver, anat, context, raw, curls, spread, dt);
            if in_box {
                batches += driver.bridge_output.environment_batches;
            }
            if stepped {
                #[cfg(test)]
                branch(self, TrackBranch::BlockedStep);
                self.goal_q = self.step;
            } else if driver.restore_endpoint_from(anat, &goal, context, dt, true) {
                #[cfg(test)]
                branch(self, TrackBranch::BlockedRestore);
                // The chain's last goal is not clear in this frame: push it clear first.
                batches += driver.output.environment_batches;
                self.goal_q = driver.output.q;
            } else {
                batches += driver.output.environment_batches;
            }
        }
        if blocked && !in_box && chain_error.is_finite() {
            #[cfg(test)]
            branch(self, TrackBranch::Reseed);
            batches += self.reseed(driver, anat, context, raw, chain_error, dt);
        }
        let mut projected = false;
        let mut i = 0;
        while i < DOFS && !projected {
            projected = self.goal_q[i] != raw[i];
            i += 1;
        }
        self.projected = projected;

        self.carry_time += js_max(0.0, dt);
        if self.recarry || self.stopping {
            // The carry starts at the last accepted frame, from the accepted jet.
            for i in 0..DOFS {
                self.carry_from[i] = difference(&self.q_acc, &self.goal_q, i);
                self.carry_rate[i] = self.v_acc[i] - self.goal_velocity[i];
            }
            self.carry_time = js_max(0.0, dt);
            self.recarry = false;
            self.stopping = false;
        }
        batches
    }

    // arm-route.ts ArmRoute.reseed
    //
    // Take a blocked chain over to the branch the request's own inverse names,
    // where a plan from there misses the request by less than the chain does.
    // Returns the environment batches spent.
    //
    // The chain is a local descent, so it keeps the branch it started on: from
    // listen, whose forearm holds its pronation stop, cover's chain stopped
    // blocked at that stop with a finger on the cheek, 4 cm and 73° of palm off,
    // while the same request from rest settled on the supination stop 1.4 cm and
    // 3° off. `raw` decomposes the request without that history; held to the box,
    // it seeds one plan on the request's branch. The carry eases the switch.
    fn reseed(
        &mut self,
        driver: &mut ArmDriver,
        anat: &mut ArmAnatomy,
        context: &ArmForwardContext,
        raw: &[f64; DOFS],
        chain_error: f64,
        dt: f64,
    ) -> usize {
        let bounds = *driver.fill_bounds(raw, 0.0, false);
        clamp_to_box(raw, &bounds, &mut self.step);
        let step = self.step;
        let seeded = driver.plan_from(anat, &step, context, dt, true);
        if seeded.status != ArmPathStatus::Blocked && seeded.position_error < chain_error {
            self.goal_q = seeded.q;
        }
        seeded.environment_batches
    }

    // arm-route.ts ArmRoute.stepTowardRaw
    //
    // Move from the goal toward `raw` by at most one frame's slew per DOF, the
    // box a plan step searches, into `step`; true when that pose validates.
    #[allow(clippy::too_many_arguments)]
    fn step_toward_raw(
        &mut self,
        driver: &mut ArmDriver,
        anat: &mut ArmAnatomy,
        context: &ArmForwardContext,
        raw: &[f64; DOFS],
        curls: &FingerSpec,
        spread: &FingerSpec,
        dt: f64,
    ) -> bool {
        let goal = self.goal_q;
        let bounds = *driver.fill_bounds(&goal, dt, true);
        for i in 0..DOFS {
            let target = self.goal_q[i] + difference(raw, &self.goal_q, i);
            self.step[i] = js_min(bounds.upper[i], js_max(bounds.lower[i], target));
        }
        let step = self.step;
        driver.validate_locked_pose(anat, &step, context, curls, spread, DriverOutput::Bridge)
    }

    // arm-route.ts ArmRoute.command
    //
    // Commanded q: the goal plus the carry, inside the joint box.
    pub fn command<'o>(
        &self,
        driver: &mut ArmDriver,
        out: &'o mut [f64; DOFS],
    ) -> &'o mut [f64; DOFS] {
        for i in 0..DOFS {
            out[i] = self.goal_q[i]
                + residual_carry(
                    self.carry_from[i],
                    self.carry_rate[i],
                    self.carry_duration,
                    self.carry_time,
                    0,
                );
        }
        let bounds = *driver.fill_bounds(&self.q_acc, 0.0, false);
        let q = *out;
        clamp_to_box(&q, &bounds, out)
    }

    // arm-route.ts ArmRoute.limitSlew
    //
    // Shorten the step from the accepted pose to `command`, in place, to within
    // the slew allowance. Bone angles are not linear in q — rotations about
    // different axes partly cancel over a long step — so one 1/k scale lands
    // over; the share is searched instead (regula falsi, Illinois). Returns
    // whether the command was shortened.
    pub fn limit_slew(
        &mut self,
        command: &mut [f64; DOFS],
        accepted: &ArmSlewPose,
        driver: &ArmDriver,
        context: &ArmForwardContext,
        dt: f64,
    ) -> bool {
        let mut k = self.slew_ratio(command, accepted, driver, context, dt);
        if k <= 1.0 {
            return false;
        }
        for i in 0..DOFS {
            self.step[i] = difference(command, &self.q_acc, i);
        }
        let mut lo = 0.0;
        let mut k_lo = 0.0;
        let mut hi = 1.0;
        let mut k_hi = k;
        let mut retained = 0;
        for _ in 0..SLEW_SEARCH {
            let share = lo + ((1.0 - k_lo) * (hi - lo)) / (k_hi - k_lo);
            for i in 0..DOFS {
                command[i] = self.q_acc[i] + self.step[i] * share;
            }
            k = self.slew_ratio(command, accepted, driver, context, dt);
            if k <= 1.0 {
                lo = share;
                k_lo = k;
                if k >= SLEW_FILL {
                    break;
                }
                if retained < 0 {
                    k_hi = 1.0 + (k_hi - 1.0) / 2.0;
                }
                retained = -1;
            } else {
                hi = share;
                k_hi = k;
                if retained > 0 {
                    k_lo = 1.0 - (1.0 - k_lo) / 2.0;
                }
                retained = 1;
            }
        }
        for i in 0..DOFS {
            command[i] = self.q_acc[i] + self.step[i] * lo;
        }
        true
    }

    // arm-route.ts ArmRoute.absorb
    //
    // The frame committed a pose other than the command: carry from it, at the
    // rate the carry had, so the next frame continues from what was shown.
    pub fn absorb(&mut self, committed: &[f64; DOFS]) {
        for i in 0..DOFS {
            let rate = residual_carry(
                self.carry_from[i],
                self.carry_rate[i],
                self.carry_duration,
                self.carry_time,
                1,
            );
            self.carry_from[i] = difference(committed, &self.goal_q, i);
            self.carry_rate[i] = rate;
        }
        self.carry_time = 0.0;
    }

    // arm-route.ts ArmRoute.beginStop
    //
    // Bring the accepted jet to rest over the lead floor, starting from the last accepted frame.
    pub fn begin_stop(&mut self, dt: f64) {
        self.tail0 = self.q_acc;
        self.tail_v = self.v_acc;
        self.tail_a = self.a_acc;
        self.tail_t = js_max(0.0, dt);
        self.stopping = true;
    }

    // arm-route.ts ArmRoute.tailSample
    //
    // The stop tail at the current time.
    pub fn tail_sample<'o>(&self, out: &'o mut [f64; DOFS]) -> &'o mut [f64; DOFS] {
        for i in 0..DOFS {
            out[i] = stop_tail(
                self.tail0[i],
                self.tail_v[i],
                self.tail_a[i],
                self.lead_floor,
                self.tail_t,
                0,
            );
        }
        out
    }

    // arm-route.ts ArmRoute.accept
    //
    // Record the committed q, and the goal's own rate where it was continuous.
    pub fn accept(&mut self, q: &[f64; DOFS], dt: f64) {
        if dt > 0.0 {
            for i in 0..DOFS {
                let v = difference(q, &self.q_acc, i) / dt;
                self.a_acc[i] = (v - self.v_acc[i]) / dt;
                self.v_acc[i] = v;
                self.goal_velocity[i] = if self.has_goal_prev {
                    difference(&self.goal_q, &self.goal_prev, i) / dt
                } else {
                    0.0
                };
            }
        }
        self.q_acc = *q;
        self.goal_prev = self.goal_q;
        self.has_goal_prev = true;
    }

    // arm-route.ts ArmRoute.slewRatio
    //
    // How many times over the slew allowance the step from the accepted pose to `q` is.
    pub fn slew_ratio(
        &mut self,
        q: &[f64; DOFS],
        accepted: &ArmSlewPose,
        driver: &ArmDriver,
        context: &ArmForwardContext,
        dt: f64,
    ) -> f64 {
        forward_arm(
            configuration_from_q(q, &mut self.configuration),
            &driver.calibration,
            context,
            &mut self.forward,
        );
        arm_step_within_slew(&self.q_acc, accepted, q, &self.forward, dt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus_replay::Corpus;
    use crate::math::f::js_round;
    use crate::math::{Quat, Vec3};
    use crate::profile::Side;
    use crate::rig::arm_path::plan::ArmPathPlanOutput;
    use crate::rig::hands::EMPTY_SPEC;
    use crate::rig::testkit::{Driven, close};
    use core::f64::consts::PI;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// Any positive length; the body passes its own lead floor.
    const TAIL: f64 = 0.2;
    const NO_FINGERS: FingerSpec = EMPTY_SPEC;

    struct Scene {
        h: Driven,
        context: ArmForwardContext,
    }

    impl Scene {
        fn new() -> Scene {
            let mut h = Driven::new();
            assert!(h.anat.update(&mut h.graph));
            let context = h.context(Side::R);
            h.capture_volume_frame(Side::R);
            Scene { h, context }
        }

        fn driver(&mut self) -> (&mut ArmDriver, &mut ArmAnatomy) {
            self.h.driver(Side::R)
        }

        fn pose_of(&mut self, q: &[f64; DOFS]) -> ArmForwardResult {
            let context = self.context;
            let (driver, _) = self.driver();
            let mut c = driver.accepted_configuration;
            let mut out = ArmForwardResult::default();
            forward_arm(
                configuration_from_q(q, &mut c),
                &driver.calibration,
                &context,
                &mut out,
            );
            out
        }

        fn validates(&mut self, q: &[f64; DOFS]) -> bool {
            let context = self.context;
            let (driver, anat) = self.driver();
            let accepted = driver.accepted_configuration;
            driver.request_for_configuration(&accepted, &context, &NO_FINGERS, &NO_FINGERS);
            driver.validate_locked_pose(
                anat,
                q,
                &context,
                &NO_FINGERS,
                &NO_FINGERS,
                DriverOutput::Bridge,
            )
        }

        /// Point the driver's request at `q`, as the body's composed request would for its raw q.
        fn request_at(&mut self, q: &[f64; DOFS]) {
            let context = self.context;
            let (driver, _) = self.driver();
            let mut c = driver.accepted_configuration;
            configuration_from_q(q, &mut c);
            driver.request_for_configuration(&c, &context, &NO_FINGERS, &NO_FINGERS);
        }

        fn track(&mut self, route: &mut ArmRoute, raw: &[f64; DOFS], dt: f64) -> usize {
            let context = self.context;
            let (driver, anat) = self.driver();
            route.track(driver, anat, &context, raw, &NO_FINGERS, &NO_FINGERS, dt)
        }

        fn command(&mut self, route: &ArmRoute) -> [f64; DOFS] {
            let mut out = [0.0; DOFS];
            route.command(self.driver().0, &mut out);
            out
        }
    }

    /// An arm held out to the side, well clear of the body.
    fn sideways() -> [f64; DOFS] {
        let mut q = [0.0; DOFS];
        q[1] = 0.5 * PI;
        q[3] = 0.4;
        q
    }

    /// `base` with the forearm rolled `excess` past its range on one side.
    fn over_rolled(driver: &ArmDriver, base: &[f64; DOFS], excess: f64) -> [f64; DOFS] {
        let mut q = *base;
        let [lo, hi] = driver.calibration.joints.elbow.rotation.max;
        q[4] = if excess > 0.0 {
            hi + excess
        } else {
            lo + excess
        };
        q
    }

    fn bits(q: &[f64]) -> Vec<u64> {
        q.iter().map(|v| v.to_bits()).collect()
    }

    // --- closed-form curves --------------------------------------------------------------------

    #[test]
    fn brings_the_stop_tail_to_rest_at_h_and_holds_it() {
        for [x0, v0, a0] in [[0.1, 1.5, 0.0], [-0.4, -3.0, 20.0], [0.0, 0.2, -8.0]] {
            assert_eq!(stop_tail(x0, v0, a0, TAIL, 0.0, 0), x0);
            assert_eq!(stop_tail(x0, v0, a0, TAIL, 0.0, 1), v0);
            assert_eq!(stop_tail(x0, v0, a0, TAIL, 0.0, 2), a0);
            close(stop_tail(x0, v0, a0, TAIL, TAIL * (1.0 - 1e-12), 1), 0.0, 9);
            close(stop_tail(x0, v0, a0, TAIL, TAIL * (1.0 - 1e-12), 2), 0.0, 8);
            let rest = stop_tail(x0, v0, a0, TAIL, TAIL, 0);
            for t in [TAIL * 1.5, TAIL * 10.0] {
                assert_eq!(stop_tail(x0, v0, a0, TAIL, t, 0), rest);
                assert_eq!(stop_tail(x0, v0, a0, TAIL, t, 1), 0.0);
                assert_eq!(stop_tail(x0, v0, a0, TAIL, t, 2), 0.0);
            }
        }
    }

    #[test]
    fn clamps_into_a_box_in_place() {
        let mut q = [4.0, -1.0, 0.5, 2.0, 0.0, 0.0, 0.0];
        let bounds = ArmPathBounds {
            lower: [-3.0, 0.0, -1.0, 0.0, -1.0, -1.0, -1.0],
            upper: [3.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
        };
        let from = q;
        clamp_to_box(&from, &bounds, &mut q);
        assert_eq!(q, [3.0, 0.0, 0.5, 1.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn validates_at_a_fixed_density_per_second_capped() {
        assert_eq!(VALIDATION_INTERVAL, 1.0 / 60.0);
        assert_eq!(validation_samples(1.0 / 120.0), 1.0);
        assert_eq!(validation_samples(1.0 / 60.0), 1.0);
        assert_eq!(validation_samples(1.0 / 30.0), 2.0);
        assert_eq!(validation_samples(1.0 / 20.0), 3.0);
        assert_eq!(validation_samples(1.0 / 5.0), MAX_VALIDATION_SAMPLES);
    }

    #[test]
    fn validation_samples_replays_its_corpus_bit_for_bit() {
        let corpus = Corpus::load("validationSamples");
        assert!(corpus.cases() > 0);
        for case in corpus.iter() {
            let got = validation_samples(case.scalar("dt", false));
            assert_eq!(got.to_bits(), case.scalar("return", true).to_bits());
        }
    }

    #[test]
    fn measures_a_step_against_the_slew_allowance() {
        let dt = 1.0 / 60.0;
        let a = ArmForwardResult::default();
        let mut b = ArmForwardResult::default();
        let qa = [0.0; DOFS];
        let mut qb = [0.0; DOFS];
        assert_eq!(arm_step_within_slew(&qa, &a, &qb, &b, dt), 0.0);
        qb[5] = 2.0 * LIMIT_SLEW * dt;
        close(arm_step_within_slew(&qa, &a, &qb, &b, dt), 2.0, 6);
        qb[5] = 0.0;
        b.lower_local =
            *Quat::default().set_from_axis_angle(&Vec3::new(0.0, 0.0, 1.0), 0.5 * LIMIT_SLEW * dt);
        close(arm_step_within_slew(&qa, &a, &qb, &b, dt), 0.5, 6);
    }

    // --- arm route slew ------------------------------------------------------------------------

    #[test]
    fn shortens_a_long_multi_axis_step_to_just_inside_the_allowance_along_the_step() {
        let dt = 1.0 / 60.0;
        let mut s = Scene::new();
        let from = sideways();
        let mut route = ArmRoute::new(TAIL);
        route.reset(&from);
        let accepted = s.pose_of(&from);
        let mut target = from;
        target[0] += 0.6;
        target[2] += 0.5;
        target[3] += 0.7;
        target[4] += 0.4;
        let k = arm_step_within_slew(&from, &accepted, &target, &s.pose_of(&target), dt);
        // One 1/k scale lands over: the bone angles are not linear in q.
        let once: [f64; DOFS] = std::array::from_fn(|i| from[i] + (target[i] - from[i]) / k);
        assert!(arm_step_within_slew(&from, &accepted, &once, &s.pose_of(&once), dt) > 1.0);

        let mut command = target;
        let context = s.context;
        assert!(route.limit_slew(&mut command, &accepted, s.driver().0, &context, dt));
        let ratio = arm_step_within_slew(&from, &accepted, &command, &s.pose_of(&command), dt);
        assert!(ratio <= 1.0);
        assert!(ratio >= 0.98);
        let share = (command[3] - from[3]) / (target[3] - from[3]);
        for i in 0..DOFS {
            close(command[i] - from[i], (target[i] - from[i]) * share, 12);
        }
    }

    #[test]
    fn leaves_a_step_within_the_allowance_alone() {
        let dt = 1.0 / 60.0;
        let mut s = Scene::new();
        let from = sideways();
        let mut route = ArmRoute::new(TAIL);
        route.reset(&from);
        let mut command = from;
        command[3] += 0.5 * LIMIT_SLEW * dt;
        let before = command;
        let accepted = s.pose_of(&from);
        let context = s.context;
        assert!(!route.limit_slew(&mut command, &accepted, s.driver().0, &context, dt));
        assert_eq!(command, before);
    }

    // --- arm route goal ------------------------------------------------------------------------

    #[test]
    fn takes_an_admissible_raw_q_on_the_chain_for_one_settled_step_and_one_check() {
        let mut s = Scene::new();
        let raw = sideways();
        s.request_at(&raw);
        let mut route = ArmRoute::new(TAIL);
        route.reset(&raw);
        let batches = s.track(&mut route, &raw, 1.0 / 60.0);
        assert_eq!(batches, 2);
        assert!(!route.solved());
        assert!(!route.projected());
        assert_eq!(bits(&route.goal_q), bits(&raw));
    }

    #[test]
    fn solves_a_raw_q_past_the_joint_range_into_it() {
        let mut s = Scene::new();
        let raw = over_rolled(s.driver().0, &sideways(), 0.2);
        s.request_at(&raw);
        let mut route = ArmRoute::new(TAIL);
        route.reset(&sideways());
        s.track(&mut route, &raw, 1.0 / 60.0);
        assert!(route.solved());
        assert!(route.projected());
        let hi = s.driver().0.calibration.joints.elbow.rotation.max[1];
        assert!(route.goal_q[4] <= hi + 1e-12);
        let goal = route.goal_q;
        assert!(s.validates(&goal));
    }

    /// The shallowest grid pose whose only clearance violations are finger rows
    /// against the face, found by reading the rows the locked validation sampled.
    fn face_only_pose(s: &mut Scene) -> Option<[f64; DOFS]> {
        let joints = s.driver().0.calibration.joints.clone();
        let [rot_lo, rot_hi] = joints.shoulder.rotation.max;
        let [flex_lo, flex_hi] = joints.elbow.flexion.max;
        let mut best = None;
        let mut best_depth = f64::INFINITY;
        let mut q = [0.0; DOFS];
        let mut plane = 60.0;
        while plane <= 150.0 {
            let mut lift = 0.3;
            while lift <= 0.95 {
                for r in 0..=4 {
                    for f in 0..=6 {
                        q[0] = plane * (PI / 180.0);
                        q[1] = lift * PI;
                        q[2] = rot_lo + ((rot_hi - rot_lo) * f64::from(r)) / 4.0;
                        q[3] = flex_lo + ((flex_hi - flex_lo) * f64::from(f)) / 6.0;
                        s.driver().0.environment.last_rows.clear();
                        if s.validates(&q) {
                            continue;
                        }
                        let (mut face, mut other) = (0.0, 0.0);
                        for row in &s.driver().0.environment.last_rows {
                            if !(row.valid && row.distance < 0.0) {
                                continue;
                            }
                            if row.key.unwrap() % 3 == 2 {
                                face = js_max(face, -row.distance);
                            } else {
                                other = js_max(other, -row.distance);
                            }
                        }
                        if other == 0.0 && face > 0.002 && face < best_depth {
                            best_depth = face;
                            best = Some(q);
                        }
                    }
                }
                lift += 0.08;
            }
            plane += 15.0;
        }
        best
    }

    #[test]
    fn solves_a_hand_inside_the_face_to_a_feasible_pose() {
        let mut s = Scene::new();
        let in_face =
            face_only_pose(&mut s).expect("no grid pose puts only fingers inside the face");
        assert!(!s.validates(&in_face));
        s.request_at(&in_face);
        let mut route = ArmRoute::new(TAIL);
        route.reset(&s.driver().0.accepted_q);
        s.track(&mut route, &in_face, 1.0 / 60.0);
        assert!(route.solved());
        assert!(route.projected());
        let goal = route.goal_q;
        assert!(s.validates(&goal));
    }

    // --- arm route tracking --------------------------------------------------------------------

    #[test]
    fn eases_the_residual_carry_from_its_jet_to_rest_over_the_duration() {
        for [from, rate, t_end] in [[0.3, 0.0, 0.4], [-0.2, 3.0, 0.12], [0.05, -1.0, 0.9]] {
            close(residual_carry(from, rate, t_end, 0.0, 0), from, 12);
            close(residual_carry(from, rate, t_end, 0.0, 1), rate, 12);
            close(
                residual_carry(from, rate, t_end, t_end * (1.0 - 1e-12), 0),
                0.0,
                9,
            );
            close(
                residual_carry(from, rate, t_end, t_end * (1.0 - 1e-12), 1),
                0.0,
                9,
            );
            assert_eq!(residual_carry(from, rate, t_end, 2.0 * t_end, 0), 0.0);
            let t = 0.37 * t_end;
            let h = 1e-6;
            let slope = (residual_carry(from, rate, t_end, t + h, 0)
                - residual_carry(from, rate, t_end, t - h, 0))
                / (2.0 * h);
            close(residual_carry(from, rate, t_end, t, 1), slope, 5);
        }
    }

    struct Run {
        route: ArmRoute,
        from: [f64; DOFS],
        raw: [f64; DOFS],
        commands: Vec<[f64; DOFS]>,
        dt: f64,
    }

    /// Accept every command toward a raw q that moved off the accepted one in a single step.
    fn run(s: &mut Scene, hz: f64, seconds: f64, lead: f64, jump: f64) -> Run {
        let from = sideways();
        let mut raw = from;
        raw[3] += jump;
        raw[2] -= jump / 2.0;
        let mut route = ArmRoute::new(TAIL);
        route.reset(&from);
        route.retime(lead);
        let dt = 1.0 / hz;
        let mut commands = Vec::new();
        let context = s.context;
        for _ in 0..js_round(seconds * hz) as usize {
            s.request_at(&raw);
            let q = route.q_acc;
            s.driver().0.accept(&q, &context, &NO_FINGERS, &NO_FINGERS);
            s.track(&mut route, &raw, dt);
            let out = s.command(&route);
            route.accept(&out, dt);
            commands.push(out);
        }
        Run {
            route,
            from,
            raw,
            commands,
            dt,
        }
    }

    #[test]
    fn carries_the_last_command_into_a_goal_that_jumped_and_eases_it_out_over_the_lead() {
        let mut s = Scene::new();
        let lead = 0.3;
        let r = run(&mut s, 60.0, 0.5, lead, 0.2);
        // The first frame is one carry step from where the arm was, not at the goal.
        assert!((r.commands[0][3] - r.from[3]).abs() < 0.01);
        assert!((r.commands[0][3] - r.raw[3]).abs() > 0.15);
        // The lead later the carry is spent.
        let done = r.commands[(lead / r.dt).ceil() as usize];
        for i in 0..DOFS {
            close(done[i], r.raw[i], 12);
        }
    }

    #[test]
    fn samples_the_same_carry_at_20_60_and_120_hz() {
        let mut s = Scene::new();
        let samples: Vec<Vec<[f64; DOFS]>> = [20.0, 60.0, 120.0]
            .iter()
            .map(|&hz| {
                // Small enough to be one frame's step even at 120 Hz, so every rate has the same goal.
                let r = run(&mut s, hz, 0.3, 0.3, 0.05);
                let every = (hz / 20.0) as usize;
                r.commands
                    .iter()
                    .enumerate()
                    .filter(|(k, _)| (k + 1) % every == 0)
                    .map(|(_, c)| *c)
                    .collect()
            })
            .collect();
        assert_eq!(samples[0].len(), 6);
        for other in &samples[1..] {
            for (k, c) in other.iter().enumerate() {
                for i in 0..DOFS {
                    close(c[i], samples[0][k][i], 12);
                }
            }
        }
        // Something was carried: the first sample is still well short of the last.
        assert!((samples[0][0][3] - samples[0][5][3]).abs() > 0.01);
    }

    #[test]
    fn carries_on_from_an_absorbed_pose() {
        let mut s = Scene::new();
        let mut r = run(&mut s, 60.0, 0.1, 0.3, 0.2);
        let mut committed = s.command(&r.route);
        for c in &mut committed[1..] {
            *c -= 0.002;
        }
        r.route.absorb(&committed);
        let after = s.command(&r.route);
        for i in 0..DOFS {
            close(after[i], committed[i], 12);
        }
    }

    #[test]
    fn stops_from_the_accepted_jet_one_frame_on() {
        let mut s = Scene::new();
        let mut r = run(&mut s, 60.0, 0.1, 0.3, 0.2);
        r.route.begin_stop(r.dt);
        assert!(r.route.stopping());
        let mut out = [0.0; DOFS];
        r.route.tail_sample(&mut out);
        for i in 0..DOFS {
            let route = &r.route;
            let want = stop_tail(
                route.q_acc[i],
                route.v_acc[i],
                route.a_acc[i],
                TAIL,
                r.dt,
                0,
            );
            assert_eq!(out[i].to_bits(), want.to_bits());
        }
    }

    // --- arm route recovery --------------------------------------------------------------------

    /// A hand brought in to the chest with the forearm, wrist flexion and
    /// deviation all on their stops, as a heart held in front of it leaves them.
    fn pinned(s: &mut Scene) -> [f64; DOFS] {
        let joints = &s.driver().0.calibration.joints;
        [
            1.556,
            0.299,
            -0.181,
            1.655,
            joints.elbow.rotation.max[1],
            joints.wrist.flexion.max[0],
            joints.wrist.deviation.max[0],
        ]
    }

    #[test]
    fn reaches_an_admissible_raw_q_at_rest_when_a_plan_leaves_the_goal() {
        for status in [ArmPathStatus::Blocked, ArmPathStatus::Stationary] {
            let mut s = Scene::new();
            let from = pinned(&mut s);
            let rest = [0.436, 0.336, -0.841, 0.177, 0.512, 0.049, -0.001];
            assert!(s.validates(&from));
            assert!(s.validates(&rest));
            // On a real mesh the solver's step can fail from a clear start on the
            // stops, or stop at a local minimum there: q stays where it started.
            s.driver().0.plan_hook = Some(Box::new(
                move |_, start: &[f64; DOFS], out: &mut ArmPathPlanOutput| {
                    out.status = status;
                    out.q = *start;
                },
            ));
            let mut route = ArmRoute::new(TAIL);
            route.reset(&from);
            let dt = 1.0 / 60.0;
            let context = s.context;
            let mut reached = None;
            for k in 0..60 {
                s.request_at(&rest);
                let q = route.q_acc;
                s.driver().0.accept(&q, &context, &NO_FINGERS, &NO_FINGERS);
                s.track(&mut route, &rest, dt);
                let command = s.command(&route);
                route.accept(&command, dt);
                let gap = (0..DOFS).fold(0.0, |g, i| js_max(g, (route.goal_q[i] - rest[i]).abs()));
                if gap < 1e-9 {
                    reached = Some(k);
                    break;
                }
            }
            // One box step per frame at the slew limit covers the widest DOF.
            let widest = (0..DOFS).fold(0.0, |w, i| js_max(w, (rest[i] - from[i]).abs()));
            let reached = reached.unwrap_or_else(|| panic!("{status:?}: never reached"));
            assert!(
                reached as f64 <= (widest / (LIMIT_SLEW * dt)).ceil(),
                "{status:?}"
            );
        }
    }

    #[test]
    fn a_stationary_plan_keeps_the_goal_without_recovery() {
        let mut s = Scene::new();
        let from = sideways();
        let raw = over_rolled(s.driver().0, &from, 0.2);
        s.request_at(&raw);
        let planned = Rc::new(RefCell::new(None));
        let seen = planned.clone();
        s.driver().0.plan_hook = Some(Box::new(
            move |_, _: &[f64; DOFS], out: &mut ArmPathPlanOutput| {
                out.status = ArmPathStatus::Stationary;
                *seen.borrow_mut() = Some(out.q);
            },
        ));
        let before = s.driver().0.calls;
        let mut route = ArmRoute::new(TAIL);
        route.reset(&from);

        s.track(&mut route, &raw, 1.0 / 60.0);

        let after = s.driver().0.calls;
        let planned = planned.borrow().expect("a plan");
        assert_eq!(after.restore_endpoint_from, before.restore_endpoint_from);
        assert_eq!(after.validate_locked_pose, before.validate_locked_pose);
        assert_eq!(bits(&route.goal_q), bits(&planned));
    }

    #[test]
    fn reseeds_a_blocked_chain_from_raw_held_to_the_box_only_when_it_misses_by_less() {
        for (status, error, taken) in [
            (ArmPathStatus::Progress, 0.01, true),
            (ArmPathStatus::Progress, 0.09, false),
            (ArmPathStatus::Blocked, 0.01, false),
        ] {
            let mut s = Scene::new();
            let from = sideways();
            let raw = over_rolled(s.driver().0, &from, 0.2);
            s.request_at(&raw);
            let starts = Rc::new(RefCell::new(Vec::new()));
            let seeded = Rc::new(RefCell::new(None));
            let (st, se) = (starts.clone(), seeded.clone());
            let first = s.driver().0.calls.plan_from;
            s.driver().0.plan_hook = Some(Box::new(
                move |call, start: &[f64; DOFS], out: &mut ArmPathPlanOutput| {
                    st.borrow_mut().push(*start);
                    if call == first {
                        // The chain: stuck where it started, 5 cm off.
                        out.status = ArmPathStatus::Blocked;
                        out.position_error = 0.05;
                        out.q = *start;
                    } else {
                        out.status = status;
                        out.position_error = error;
                        *se.borrow_mut() = Some(out.q);
                    }
                },
            ));
            let mut route = ArmRoute::new(TAIL);
            route.reset(&from);

            s.track(&mut route, &raw, 1.0 / 60.0);

            let starts = starts.borrow();
            assert_eq!(starts.len(), 2);
            let mut held = [0.0; DOFS];
            let bounds = *s.driver().0.fill_bounds(&raw, 0.0, false);
            clamp_to_box(&raw, &bounds, &mut held);
            assert_eq!(bits(&starts[1]), bits(&held));
            let seeded = seeded.borrow().expect("a seeded plan");
            assert_eq!(
                bits(&route.goal_q) == bits(&seeded),
                taken,
                "{status:?} {error}"
            );
        }
    }
}
