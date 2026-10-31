//! `motion/arm-transaction.ts`: the constrained arm commit of one frame.
//!
//! The TS transaction holds the rig, the character frame, Body's `ArmResolver` and live
//! references to Body's followed records. Here the rig and the graph arrive with each call, the
//! character frame is the transaction's own copy, and the followed records are an
//! [`ArmFollowed`] the caller fills before each call that reads them. `ArmResolver.note` stays in
//! TS: `commit` leaves the notes it would have made in [`ArmTransaction::notes`], in the order
//! the TS makes them, for the caller to replay after the call.
//!
//! The TS commit record points at the driver's output and the rig's context; both are read only
//! by `commitArmFrame` in the same commit and neither changes in between, so the record here is
//! an [`ArmFrameSideCommit`] filled by value. The TS scratch `_sampleQ`, `_rawQ`, `_armWorldVec`,
//! `_palmWorldVector` and `_acceptedTuple` is written before it is read in every call, and lives
//! on the stack or in the notes.

use crate::anatomy::arm::ArmAnatomy;
use crate::math::Vec3;
use crate::math::f::{atan2, cos, js_max, sin};
use crate::profile::{ArmSlot, Side};
use crate::rig::arm_configuration::{
    ArmConfiguration, ArmForwardContext, ArmForwardResult, forward_arm,
};
use crate::rig::arm_driver::{ArmDriver, DriverOutput};
use crate::rig::arm_path::plan::{ArmPathStatus, configuration_from_q};
use crate::rig::arm_route::{ArmRoute, clamp_to_box, validation_samples};
use crate::rig::hands::FingerSpec;
use crate::rig::{ArmFrameSideCommit, Rig};
use crate::scene::graph::Graph;

use super::frame::{CharacterFrame, side_mirror};

const DOFS: usize = 7;

/// What one frame's constrained arm commit spent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ArmFrameWork {
    /// Frames whose goal is the solver's step rather than the raw q.
    pub plans: usize,
    /// Locked pose checks, holds included.
    pub validations: usize,
    /// Commands whose endpoint was pushed clear and committed.
    pub repairs: usize,
    /// Arms brought to rest on the stop tail.
    pub stop_tails: usize,
    /// Arms that kept their accepted pose because neither validated.
    pub holds: usize,
    pub solver_calls: usize,
    pub solver_iterations: usize,
    pub environment_batches: usize,
}

/// The followed arm state the transaction reads, owned by `Body`: the TS `ArmFollowed`, as the
/// records stand when the call is made. Per side; `palm_w` and `twist` are the followers' `value`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ArmFollowed {
    /// Per [`ArmSlot`]; the shoulder is not read.
    pub arm_dirs: [[[f64; 3]; 4]; 2],
    pub palm_out: [[f64; 3]; 2],
    pub palm_w: [f64; 2],
    pub twist: [f64; 2],
    /// Per [`crate::profile::Finger`].
    pub finger_spec: [[f64; 5]; 2],
    pub finger_spread_spec: [[f64; 5]; 2],
}

/// One `ArmResolver.note(side, upperArm, lowerArm, hand)` a commit makes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArmNote {
    pub side: Side,
    pub upper_arm: [f64; 3],
    pub lower_arm: [f64; 3],
    pub hand: [f64; 3],
}

/// Which locked check a validation is, for the tests that make one fail.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Check {
    Command,
    /// The endpoint restore of a failed command, with its slew check.
    Restore,
    /// The check of a plan from the accepted pose.
    Repair,
    StopTail,
    Hold,
}

/// A test's verdict on a check: true refuses it whatever the driver found.
#[cfg(test)]
pub(crate) type Refusal = Box<dyn FnMut(Side, Check) -> bool>;

fn spec(values: &[f64; 5]) -> FingerSpec {
    values.map(Some)
}

/// The constrained arm commit of one frame: forms each arm's command from the followed
/// directions, validates it at fixed density, recovers an arm whose command fails, and commits
/// both arms to the rig against the body as followed. Owns the per-side routes and the scratch
/// the commit refills each frame.
pub struct ArmTransaction {
    axes: CharacterFrame,
    pub work: ArmFrameWork,
    /// Each constrained arm's tracked goal and residual carry.
    pub routes: [ArmRoute; 2],
    /// This frame's commanded q, per side.
    command_q: [[f64; DOFS]; 2],
    /// Whether a side's command is already formed this frame; the clasp leader's is, early.
    commanded: [bool; 2],
    sample_curls: FingerSpec,
    sample_spread: FingerSpec,
    command_configuration: ArmConfiguration,
    command_forward: ArmForwardResult,
    /// Each side's last commit record; kept across frames as the TS keeps it.
    commit: [Option<ArmFrameSideCommit>; 2],
    /// What the last `commit` would have told `ArmResolver.note`; `note_count` of them.
    notes: [ArmNote; 2],
    note_count: usize,
    #[cfg(test)]
    pub(crate) check: Check,
    #[cfg(test)]
    pub(crate) refuse: Option<Refusal>,
}

impl ArmTransaction {
    // arm-transaction.ts ArmTransaction.constructor
    pub fn new(axes: CharacterFrame, lead_floor: f64) -> ArmTransaction {
        ArmTransaction {
            axes,
            work: ArmFrameWork::default(),
            routes: [ArmRoute::new(lead_floor), ArmRoute::new(lead_floor)],
            command_q: [[0.0; DOFS]; 2],
            commanded: [false; 2],
            sample_curls: [Some(0.0); 5],
            sample_spread: [Some(0.0); 5],
            command_configuration: ArmConfiguration::default(),
            command_forward: ArmForwardResult::default(),
            commit: [None; 2],
            notes: [ArmNote {
                side: Side::L,
                upper_arm: [0.0; 3],
                lower_arm: [0.0; 3],
                hand: [0.0; 3],
            }; 2],
            note_count: 0,
            #[cfg(test)]
            check: Check::Command,
            #[cfg(test)]
            refuse: None,
        }
    }

    /// The `ArmResolver.note` calls the last `commit` made in TS, in order.
    pub fn notes(&self) -> &[ArmNote] {
        &self.notes[..self.note_count]
    }

    /// Whether a side's command is formed this frame.
    pub fn commanded(&self, side: Side) -> bool {
        self.commanded[side as usize]
    }

    // arm-transaction.ts ArmTransaction.beginFrame
    //
    // Clear the work counters at the start of a frame.
    pub fn begin_frame(&mut self) {
        self.work = ArmFrameWork::default();
    }

    // arm-transaction.ts ArmTransaction.recordArmSolve
    fn record_arm_solve(&mut self, iterations: usize, environment_batches: usize) {
        self.work.solver_calls += 1;
        self.work.solver_iterations += iterations;
        self.work.environment_batches += environment_batches;
    }

    // arm-transaction.ts ArmTransaction.stageClaspLeader
    //
    // Form and stage the clasp leader's command ahead of the commit, which still validates it.
    pub fn stage_clasp_leader(
        &mut self,
        rig: &mut Rig,
        graph: &mut Graph,
        followed: &ArmFollowed,
        side: Side,
        dt: f64,
        frame_ready: bool,
    ) {
        let s = side as usize;
        if rig.arm_driver(side).is_none() {
            return;
        }
        let Some(context) = rig.arm_forward_context(graph, side).copied() else {
            return;
        };
        // The follower's clasp reads the leader's hand off the rig, so the
        // leader's command is formed now and staged; the commit validates it.
        let (driver, anat) = rig.arm_driver_mut(side).expect("checked above");
        driver.capture_volume_frame(graph, anat);
        self.command_arm(
            driver,
            anat,
            graph,
            followed,
            side,
            &context,
            dt,
            frame_ready,
        );
        forward_arm(
            configuration_from_q(&self.command_q[s], &mut self.command_configuration),
            &driver.calibration,
            &context,
            &mut self.command_forward,
        );
        rig.stage_arm_forward(
            graph,
            side,
            &self.command_forward,
            &spec(&followed.finger_spec[s]),
            &spec(&followed.finger_spread_spec[s]),
        );
    }

    // arm-transaction.ts ArmTransaction.retime
    //
    // Give every route the same entrance length.
    pub fn retime(&mut self, seconds: f64) {
        for route in &mut self.routes {
            route.retime(seconds);
        }
    }

    // arm-transaction.ts ArmTransaction.resetRoute
    //
    // Restart a side's route from a pose set from outside.
    pub fn reset_route(&mut self, side: Side, q: &[f64; DOFS]) {
        self.routes[side as usize].reset(q);
    }

    // arm-transaction.ts ArmTransaction.commandArm
    //
    // Form one arm's command for this frame: the route's goal for the request the followed
    // directions make, plus its residual carry, slowed to the slew allowance.
    #[allow(clippy::too_many_arguments)]
    fn command_arm(
        &mut self,
        driver: &mut ArmDriver,
        anat: &mut ArmAnatomy,
        graph: &mut Graph,
        followed: &ArmFollowed,
        side: Side,
        context: &ArmForwardContext,
        dt: f64,
        frame_ready: bool,
    ) {
        let s = side as usize;
        let ready = Some(frame_ready);
        let lateral = Some(side_mirror(side));
        let axes = self.axes;
        let axial = axes.axial_mirror(anat, graph, side, ready);
        let directions = &followed.arm_dirs[s];
        let values = [
            &directions[ArmSlot::UpperArm as usize],
            &directions[ArmSlot::LowerArm as usize],
            &directions[ArmSlot::Hand as usize],
            &followed.palm_out[s],
        ];
        let mut world = [Vec3::default(); 4];
        for (out, value) in world.iter_mut().zip(values) {
            axes.to_world(anat, graph, out, value, side, lateral, ready)
                .normalize();
        }
        let [upper, lower, hand, palm] = world;
        let curls = spec(&followed.finger_spec[s]);
        let spread = spec(&followed.finger_spread_spec[s]);
        let request_palm = driver
            .compose_request(
                context,
                &upper,
                &lower,
                &hand,
                Some(&palm),
                js_max(0.0, followed.palm_w[s]),
                followed.twist[s] * axial,
                &curls,
                &spread,
                true,
            )
            .palm;
        let route = &mut self.routes[s];
        let raw = if driver.configuration_from_pose(
            context,
            &upper,
            &lower,
            &hand,
            request_palm.as_ref(),
        ) {
            driver.target_q
        } else {
            route.q_acc
        };

        self.work.environment_batches +=
            route.track(driver, anat, context, &raw, &curls, &spread, dt);
        if route.solved() {
            self.work.plans += 1;
        }
        let command = &mut self.command_q[s];
        route.command(driver, command);
        // A command past the slew allowance is a seam, not a movement: take the
        // allowed share of the step and carry on from there.
        let driver: &ArmDriver = driver;
        if route.limit_slew(command, &driver.accepted_forward, driver, context, dt) {
            route.absorb(command);
        }
        self.commanded[s] = true;
    }

    // arm-transaction.ts ArmTransaction.validateCommand
    //
    // Check the frame's motion from the accepted pose to the command at fixed density in time,
    // arm and fingers together. The last check lands in `driver.output`, which is what the frame
    // commits.
    fn validate_command(
        &mut self,
        driver: &mut ArmDriver,
        anat: &mut ArmAnatomy,
        followed: &ArmFollowed,
        side: Side,
        context: &ArmForwardContext,
        dt: f64,
    ) -> bool {
        let s = side as usize;
        let command = self.command_q[s];
        let accepted = self.routes[s].q_acc;
        let curls = spec(&followed.finger_spec[s]);
        let spread = spec(&followed.finger_spread_spec[s]);
        let n = validation_samples(dt);
        #[cfg(test)]
        {
            self.check = Check::Command;
        }
        let mut i = 1.0;
        while i <= n {
            let last = i == n;
            let mut q = command;
            let mut c = curls;
            let mut sp = spread;
            if !last {
                let share = i / n;
                for j in 0..DOFS {
                    let d = command[j] - accepted[j];
                    q[j] = accepted[j] + (if j == 0 { atan2(sin(d), cos(d)) } else { d }) * share;
                }
                for f in 0..5 {
                    let from_curl = driver.accepted_curls[f];
                    let from_spread = driver.accepted_spread[f];
                    self.sample_curls[f] =
                        Some(from_curl + (followed.finger_spec[s][f] - from_curl) * share);
                    self.sample_spread[f] = Some(
                        from_spread + (followed.finger_spread_spec[s][f] - from_spread) * share,
                    );
                }
                c = self.sample_curls;
                sp = self.sample_spread;
            }
            if !self.validate_arm_pose(driver, anat, context, &q, &c, &sp, last) {
                return false;
            }
            i += 1.0;
        }
        true
    }

    // arm-transaction.ts ArmTransaction.validateArmPose
    //
    // One locked check of `q`, recorded in the frame's work.
    #[allow(clippy::too_many_arguments)]
    fn validate_arm_pose(
        &mut self,
        driver: &mut ArmDriver,
        anat: &mut ArmAnatomy,
        context: &ArmForwardContext,
        q: &[f64; DOFS],
        curls: &FingerSpec,
        spread: &FingerSpec,
        last: bool,
    ) -> bool {
        driver.request_for_configuration(
            configuration_from_q(q, &mut self.command_configuration),
            context,
            curls,
            spread,
        );
        let out = if last {
            DriverOutput::Output
        } else {
            DriverOutput::Bridge
        };
        let valid = driver.validate_locked_pose(anat, q, context, curls, spread, out);
        #[cfg(test)]
        let valid = valid && !self.refused(driver.side());
        self.work.validations += 1;
        let out = match out {
            DriverOutput::Output => &driver.output,
            DriverOutput::Bridge => &driver.bridge_output,
        };
        self.record_arm_solve(out.iterations, out.environment_batches);
        valid
    }

    /// Whether the test seam refuses the check now running.
    #[cfg(test)]
    fn refused(&mut self, side: Side) -> bool {
        let check = self.check;
        self.refuse
            .as_mut()
            .is_some_and(|refuse| refuse(side, check))
    }

    // arm-transaction.ts ArmTransaction.recoverArm
    //
    // An arm whose command did not validate. Repair the command's endpoint and restart the
    // correction from it; failing that, bring the accepted motion to rest; failing that, hold the
    // accepted pose. Leaves the pose to commit in `driver.output`; false when even the hold fails.
    fn recover_arm(
        &mut self,
        driver: &mut ArmDriver,
        anat: &mut ArmAnatomy,
        followed: &ArmFollowed,
        side: Side,
        context: &ArmForwardContext,
        dt: f64,
    ) -> bool {
        let s = side as usize;
        let curls = spec(&followed.finger_spec[s]);
        let spread = spec(&followed.finger_spread_spec[s]);
        let command = self.command_q[s];
        driver.request_for_configuration(
            configuration_from_q(&command, &mut self.command_configuration),
            context,
            &curls,
            &spread,
        );
        // A repair is a step like any other: one past the slew allowance is a seam.
        let mut repaired = driver.restore_endpoint_from(anat, &command, context, dt, true) && {
            let d: &ArmDriver = driver;
            self.routes[s].slew_ratio(&d.output.q, &d.accepted_forward, d, context, dt) <= 1.0
        };
        #[cfg(test)]
        {
            self.check = Check::Restore;
            repaired = repaired && !self.refused(side);
        }
        self.record_arm_solve(driver.output.iterations, driver.output.environment_batches);
        if !repaired {
            // Pushing a point out of the face converges only linearly, since its
            // reported normal is not the distance's gradient; approached from the
            // accepted side instead, the same contact stays clear at every step.
            let start = self.routes[s].q_acc;
            let planned = driver.plan_from(anat, &start, context, dt, true);
            let (status, mut q) = (planned.status, planned.q);
            self.record_arm_solve(planned.iterations, planned.environment_batches);
            if status != ArmPathStatus::Blocked {
                let d: &ArmDriver = driver;
                self.routes[s].limit_slew(&mut q, &d.accepted_forward, d, context, dt);
                #[cfg(test)]
                {
                    self.check = Check::Repair;
                }
                repaired = self.validate_arm_pose(driver, anat, context, &q, &curls, &spread, true);
            }
        }
        if repaired {
            self.work.repairs += 1;
            self.command_q[s] = driver.output.q;
            self.routes[s].absorb(&self.command_q[s]);
            self.arm_commit(driver, side, context, &curls, &spread);
            return true;
        }

        let route = &mut self.routes[s];
        route.begin_stop(dt);
        let tail = &mut self.command_q[s];
        route.tail_sample(tail);
        let bounds = *driver.fill_bounds(&route.q_acc, 0.0, false);
        let sampled = *tail;
        clamp_to_box(&sampled, &bounds, tail);
        let d: &ArmDriver = driver;
        route.limit_slew(tail, &d.accepted_forward, d, context, dt);
        let tail = *tail;
        #[cfg(test)]
        {
            self.check = Check::StopTail;
        }
        if self.validate_arm_pose(driver, anat, context, &tail, &curls, &spread, true) {
            self.work.stop_tails += 1;
            self.arm_commit(driver, side, context, &curls, &spread);
            return true;
        }

        self.work.holds += 1;
        let route = &mut self.routes[s];
        self.command_q[s] = route.q_acc;
        route.absorb(&self.command_q[s]);
        let held = route.q_acc;
        let accepted_curls = spec(&driver.accepted_curls);
        let accepted_spread = spec(&driver.accepted_spread);
        #[cfg(test)]
        {
            self.check = Check::Hold;
        }
        if !self.validate_arm_pose(
            driver,
            anat,
            context,
            &held,
            &accepted_curls,
            &accepted_spread,
            true,
        ) {
            return false;
        }
        self.arm_commit(driver, side, context, &accepted_curls, &accepted_spread);
        true
    }

    // arm-transaction.ts ArmTransaction.armCommit
    //
    // One side's commit record, from this frame's output and context.
    fn arm_commit(
        &mut self,
        driver: &ArmDriver,
        side: Side,
        context: &ArmForwardContext,
        curls: &FingerSpec,
        spread: &FingerSpec,
    ) {
        self.commit[side as usize] = Some(ArmFrameSideCommit {
            q: driver.output.q,
            forward: driver.output.forward,
            context: *context,
            curls: *curls,
            spread: *spread,
        });
    }

    // arm-transaction.ts ArmTransaction.commit
    //
    // Commit both arms against the body as followed: the torso is never held back for an arm,
    // the arm gives way. An arm whose command does not validate holds its accepted pose in the
    // new body. The TS defaults `hips_turn` to 0.
    pub fn commit(
        &mut self,
        rig: &mut Rig,
        graph: &mut Graph,
        followed: &ArmFollowed,
        dt: f64,
        hips_rise: f64,
        hips_turn: f64,
    ) {
        self.note_count = 0;
        rig.capture_proposed_body_context(graph, hips_rise, hips_turn);
        // `Body.update` planted the legs before staging, and the frame has moved only bones since.
        let rise = rig.apply_body_context(graph, 1.0, 1.0, true);
        let axes = self.axes;
        let frame_ready = axes.ready(&mut rig.anat, graph);
        let mut feasible = true;
        for side in Side::BOTH {
            let s = side as usize;
            let has_driver = rig.arm_driver(side).is_some();
            let context = rig
                .arm_forward_context_from_updated_body(graph, side)
                .copied();
            let (true, Some(context)) = (has_driver, context) else {
                feasible = false;
                break;
            };
            let (driver, anat) = rig.arm_driver_mut(side).expect("checked above");
            driver.capture_volume_frame(graph, anat);
            if !self.commanded[s] {
                self.command_arm(
                    driver,
                    anat,
                    graph,
                    followed,
                    side,
                    &context,
                    dt,
                    frame_ready,
                );
            }
            if self.validate_command(driver, anat, followed, side, &context, dt) {
                let curls = spec(&followed.finger_spec[s]);
                let spread = spec(&followed.finger_spread_spec[s]);
                self.arm_commit(driver, side, &context, &curls, &spread);
                continue;
            }
            if !self.recover_arm(driver, anat, followed, side, &context, dt) {
                feasible = false;
                break;
            }
        }
        let mut committed = false;
        if let (true, [Some(left), Some(right)]) = (feasible, self.commit) {
            committed = rig.commit_arm_frame(graph, &[left, right], rise, hips_turn, true);
        }

        if committed {
            let accepted_frame_ready = Some(axes.ready(&mut rig.anat, graph));
            for side in Side::BOTH {
                let s = side as usize;
                let Some(driver) = rig.arm_driver(side) else {
                    continue;
                };
                let accepted_q = driver.accepted_q;
                let forward = driver.accepted_forward;
                self.routes[s].accept(&accepted_q, dt);
                let mut accepted = [Vec3::default(); 3];
                for (out, value) in accepted
                    .iter_mut()
                    .zip([&forward.u, &forward.l, &forward.h])
                {
                    axes.to_character(&mut rig.anat, graph, out, value, side, accepted_frame_ready);
                }
                let tuple = |v: &Vec3| [v.x, v.y, v.z];
                self.notes[self.note_count] = ArmNote {
                    side,
                    upper_arm: tuple(&accepted[0]),
                    lower_arm: tuple(&accepted[1]),
                    hand: tuple(&accepted[2]),
                };
                self.note_count += 1;
            }
        } else {
            // Neither arm moved; each route restarts from the pose it still holds.
            for side in Side::BOTH {
                let s = side as usize;
                if !(rig.arm_driver(side).is_some() && self.commanded[s]) {
                    continue;
                }
                let route = &mut self.routes[s];
                let held = route.q_acc;
                route.absorb(&held);
                route.accept(&held, dt);
            }
        }
        self.commanded = [false; 2];

        // A failed articulation must not hold back the common signed jump
        // translation. This is its own accepted result, not a validated arm frame.
        if !committed {
            committed = rig.commit_arm_transport(graph, hips_rise, hips_turn, true);
        }
        if !committed {
            rig.apply_body_context(graph, 0.0, 0.0, true);
            for side in Side::BOTH {
                let has_driver = rig.arm_driver(side).is_some();
                let context = rig
                    .arm_forward_context_from_updated_body(graph, side)
                    .copied();
                if let (true, Some(context)) = (has_driver, context) {
                    let (driver, _) = rig.arm_driver_mut(side).expect("checked above");
                    let accepted_forward = *driver.refresh_accepted_forward(&context);
                    let curls = spec(&driver.accepted_curls);
                    let spread = spec(&driver.accepted_spread);
                    rig.stage_arm_forward(graph, side, &accepted_forward, &curls, &spread);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{BoneSlot, base};
    use crate::rig::testkit::{Stream, hash_halves};
    use crate::rig::tests::battery::{apply_diff, replay, same_close};

    const DT: f64 = 1.0 / 60.0;
    const LEAD_FLOOR: f64 = 0.12;
    /// One solver call's own cap on environment batches (`arm-path.ts`).
    const SOLVER_CALL: usize = 96;

    /// The most one frame may spend, both arms: per arm the goal's solver step, the raw check
    /// and the restore of a chain start that is not clear; the frame's checks; then recovery — a
    /// restore, a plan from the accepted pose, and the checks of that plan, the stop tail and
    /// the hold.
    fn frame_bound(dt: f64) -> usize {
        2 * (SOLVER_CALL + 1 + SOLVER_CALL + validation_samples(dt) as usize + 3 * SOLVER_CALL + 3)
    }

    const TX_METHODS: [&str; 5] = [
        "beginFrame",
        "retime",
        "resetRoute",
        "stageClaspLeader",
        "commit",
    ];
    const AXES_METHODS: [&str; 6] = [
        "ready",
        "legacyMirror",
        "axialMirror",
        "toWorld",
        "tupleToWorld",
        "toCharacter",
    ];

    fn followed_of(s: &mut Stream) -> ArmFollowed {
        let mut f = ArmFollowed::default();
        for side in 0..2 {
            for slot in 0..4 {
                f.arm_dirs[side][slot] = [s.f64(), s.f64(), s.f64()];
            }
            f.palm_out[side] = [s.f64(), s.f64(), s.f64()];
            f.palm_w[side] = s.f64();
            f.twist[side] = s.f64();
            f.finger_spec[side] = std::array::from_fn(|_| s.f64());
            f.finger_spread_spec[side] = std::array::from_fn(|_| s.f64());
        }
        f
    }

    /// `transactionResult`, then the notes of a commit.
    fn result_values(tx: &ArmTransaction, notes: bool) -> Vec<f64> {
        let w = &tx.work;
        let mut v: Vec<f64> = [
            w.plans,
            w.validations,
            w.repairs,
            w.stop_tails,
            w.holds,
            w.solver_calls,
            w.solver_iterations,
            w.environment_batches,
        ]
        .map(|n| n as f64)
        .to_vec();
        for side in Side::BOTH {
            let r = &tx.routes[side as usize];
            let mut flat = Vec::with_capacity(63);
            for a in [
                &r.goal_q,
                &r.q_acc,
                &r.v_acc,
                &r.a_acc,
                &r.tail0,
                &r.tail_v,
                &r.tail_a,
                &r.carry_from,
                &r.carry_rate,
            ] {
                flat.extend_from_slice(a);
            }
            v.extend(hash_halves(&flat));
            for flag in [r.projected(), r.solved(), r.stopping(), tx.commanded(side)] {
                v.push(f64::from(u8::from(flag)));
            }
        }
        if notes {
            v.push(tx.notes().len() as f64);
            for n in tx.notes() {
                v.push(n.side as usize as f64);
                v.extend(n.upper_arm);
                v.extend(n.lower_arm);
                v.extend(n.hand);
            }
        }
        v
    }

    /// `tests/corpora/motion-battery-*`: the rig battery's director scripts and two more, with
    /// every `ArmTransaction` and `CharacterFrame` call Body makes recorded as one unit and
    /// replayed here on the port, beside every other call Body makes into the rig. The
    /// recording is a fixed golden.
    #[test]
    fn replays_the_ts_arm_transaction_and_character_frame_bit_for_bit() {
        let mut tx: Option<ArmTransaction> = None;
        let mut seen = std::collections::BTreeMap::<String, usize>::new();
        let mut extra = |tag: &str, g: &mut Graph, rig: &mut Rig, s: &mut Stream| match tag {
            "txNew" => {
                tx = Some(ArmTransaction::new(CharacterFrame::new(&rig.p), s.f64()));
            }
            "tx" => {
                let tx = tx.as_mut().expect("a transaction");
                let method = TX_METHODS[s.index()];
                s.what = format!("{} tx.{method}", s.what);
                *seen.entry(format!("tx.{method}")).or_default() += 1;
                let heavy = matches!(method, "stageClaspLeader" | "commit");
                if heavy {
                    apply_diff(g, s);
                }
                let mut dt = DT;
                match method {
                    "beginFrame" => tx.begin_frame(),
                    "retime" => tx.retime(s.f64()),
                    "resetRoute" => {
                        let side = s.side();
                        let q = s.q();
                        tx.reset_route(side, &q);
                    }
                    "stageClaspLeader" => {
                        let side = s.side();
                        dt = s.f64();
                        let ready = s.flag();
                        let followed = followed_of(s);
                        tx.stage_clasp_leader(rig, g, &followed, side, dt, ready);
                    }
                    "commit" => {
                        let (step, rise, turn) = (s.f64(), s.f64(), s.f64());
                        dt = step;
                        let followed = followed_of(s);
                        tx.commit(rig, g, &followed, dt, rise, turn);
                    }
                    other => panic!("{}: no replay for {other}", s.what),
                }
                let out = result_values(tx, method == "commit");
                if heavy {
                    same_close(s, rig, g, &out);
                } else {
                    s.same(&hash_halves(&out), "output");
                }
                // `arm-budget.test.ts`: what one frame's commit may spend.
                if method == "commit" {
                    let w = tx.work;
                    assert!(
                        w.environment_batches <= frame_bound(dt),
                        "{}: {w:?}",
                        s.what
                    );
                    if w.repairs + w.stop_tails + w.holds == 0 {
                        let checks = 2 * validation_samples(dt) as usize;
                        assert!(w.validations <= checks, "{}: {w:?}", s.what);
                    }
                }
            }
            "axes" => {
                let method = AXES_METHODS[s.index()];
                let heavy = s.flag();
                s.what = format!("{} axes.{method}", s.what);
                *seen.entry(format!("axes.{method}")).or_default() += 1;
                if heavy {
                    apply_diff(g, s);
                }
                let axes = CharacterFrame::new(&rig.p);
                let opt_bool = |s: &mut Stream| s.flag().then(|| s.flag());
                let mut out = Vec::new();
                let anat = &mut rig.anat;
                match method {
                    "ready" => out.push(f64::from(u8::from(axes.ready(anat, g)))),
                    "legacyMirror" => out.push(axes.legacy_mirror(s.side())),
                    "axialMirror" => {
                        let side = s.side();
                        let ready = opt_bool(s);
                        out.push(axes.axial_mirror(anat, g, side, ready));
                    }
                    "toWorld" | "tupleToWorld" => {
                        let side = s.side();
                        let value = [s.f64(), s.f64(), s.f64()];
                        let lateral = s.flag().then(|| s.f64());
                        let ready = opt_bool(s);
                        if method == "toWorld" {
                            let mut v = Vec3::default();
                            axes.to_world(anat, g, &mut v, &value, side, lateral, ready);
                            out.extend([v.x, v.y, v.z]);
                        } else {
                            let mut t = [0.0; 3];
                            axes.tuple_to_world(anat, g, &mut t, &value, side, lateral, ready);
                            out.extend(t);
                        }
                    }
                    "toCharacter" => {
                        let side = s.side();
                        let value = s.vec3();
                        let ready = opt_bool(s);
                        let mut v = Vec3::default();
                        axes.to_character(anat, g, &mut v, &value, side, ready);
                        out.extend([v.x, v.y, v.z]);
                    }
                    other => panic!("{}: no replay for {other}", s.what),
                }
                if heavy {
                    same_close(s, rig, g, &out);
                } else {
                    s.same(&hash_halves(&out), "output");
                }
            }
            other => panic!("{}: no replay for {other}", s.what),
        };
        let (rig_seen, fixtures) = replay("motion-battery", &mut extra);
        assert_eq!(fixtures, 6);
        for what in [
            "tx.beginFrame",
            "tx.retime",
            "tx.resetRoute",
            "tx.stageClaspLeader",
            "tx.commit",
            "axes.axialMirror",
            "axes.tupleToWorld",
            "axes.toCharacter",
        ] {
            assert!(
                seen.get(what).is_some_and(|&c| c > 0),
                "{what} never replayed"
            );
        }
        for what in [
            "bootstrapStandingPose",
            "plantLegs",
            "aimArm",
            "limitsEnabled",
        ] {
            assert!(
                rig_seen.get(what).is_some_and(|&c| c > 0),
                "{what} never replayed"
            );
        }
    }

    /// The base avatar's rig at its standing pose, a transaction whose routes start there, and
    /// Body's records holding that pose.
    struct Standing {
        g: Graph,
        rig: Rig,
        tx: ArmTransaction,
        followed: ArmFollowed,
    }

    fn standing() -> Standing {
        let (mut g, p) = base::avatar();
        let rig = Rig::new(p, &mut g);
        let mut tx = ArmTransaction::new(CharacterFrame::new(&rig.p), LEAD_FLOOR);
        let mut followed = ArmFollowed::default();
        for side in Side::BOTH {
            let s = side as usize;
            let state = *rig.accepted_arm_state(side);
            followed.arm_dirs[s] = state.directions;
            followed.palm_out[s] = state.palm;
            followed.palm_w[s] = 1.0;
            followed.finger_spec[s] = state.curls;
            followed.finger_spread_spec[s] = state.spread;
            let q = rig.arm_driver(side).expect("a constrained arm").accepted_q;
            tx.reset_route(side, &q);
        }
        let mut st = Standing {
            g,
            rig,
            tx,
            followed,
        };
        for _ in 0..3 {
            st.frame(0.0);
            assert_eq!(st.tx.notes().len(), 2);
        }
        st
    }

    impl Standing {
        /// One constrained frame as Body drives it, the hips lifted by `rise`.
        fn frame(&mut self, rise: f64) {
            let Standing {
                g,
                rig,
                tx,
                followed,
            } = self;
            rig.reset(g);
            rig.plant_legs(g, rise, 0.0, false);
            assert!(rig.begin_body_arm_frame(g));
            tx.begin_frame();
            tx.commit(rig, g, followed, DT, rise, 0.0);
        }

        fn refuse(&mut self, checks: &'static [Check]) {
            self.tx.refuse = Some(Box::new(|_, check| checks.contains(&check)));
        }

        fn accepted(&self) -> [([f64; 7], Vec3); 2] {
            Side::BOTH.map(|side| {
                let d = self.rig.arm_driver(side).unwrap();
                (d.accepted_q, d.accepted_forward.wrist)
            })
        }

        fn hand(&mut self, side: Side) -> Vec3 {
            let hand = self.rig.p.bone(BoneSlot::arm(ArmSlot::Hand, side)).unwrap();
            self.g.world_position(hand)
        }

        fn lift_hips(&mut self, by: f64) {
            let hips = self.rig.p.bone(BoneSlot::Hips).unwrap() as usize;
            self.g.position[3 * hips + 1] += by;
        }
    }

    #[test]
    fn brings_an_arm_whose_repairs_are_refused_to_rest_on_the_stop_tail() {
        let mut st = standing();
        st.refuse(&[Check::Command, Check::Restore, Check::Repair]);
        st.frame(0.0);
        let w = st.tx.work;
        assert_eq!((w.repairs, w.stop_tails, w.holds), (0, 2, 0));
        assert!(st.tx.routes.iter().all(|r| r.stopping()));
        assert_eq!(st.tx.notes().len(), 2);
    }

    #[test]
    fn holds_the_accepted_pose_when_the_stop_tail_is_refused() {
        let mut st = standing();
        st.refuse(&[
            Check::Command,
            Check::Restore,
            Check::Repair,
            Check::StopTail,
        ]);
        let before = st.accepted();
        st.frame(0.0);
        let w = st.tx.work;
        assert_eq!((w.repairs, w.stop_tails, w.holds), (0, 0, 2));
        assert_eq!(st.tx.notes().len(), 2);
        for (side, (q, _)) in Side::BOTH.into_iter().zip(before) {
            assert_eq!(st.rig.arm_driver(side).unwrap().accepted_q, q);
        }
    }

    #[test]
    fn transports_the_held_arms_when_even_the_hold_is_refused() {
        let mut st = standing();
        st.refuse(&[
            Check::Command,
            Check::Restore,
            Check::Repair,
            Check::StopTail,
            Check::Hold,
        ]);
        let before = st.accepted();
        let lift = 0.04;
        st.lift_hips(lift);
        st.frame(lift);
        // The first side's failed hold ends the frame's articulation.
        assert_eq!(st.tx.work.holds, 1);
        assert!(st.tx.notes().is_empty());
        for (side, (q, wrist)) in Side::BOTH.into_iter().zip(before) {
            let d = st.rig.arm_driver(side).unwrap();
            assert_eq!(d.accepted_q, q);
            let moved = d.accepted_forward.wrist;
            assert!(
                (moved.y - wrist.y - lift).abs() < 1e-9,
                "{side:?}: {moved:?} {wrist:?}"
            );
            assert!(st.hand(side).distance_to(&moved) < 1e-10);
        }
        // Each commanded route restarts from the pose it still holds.
        assert_eq!(st.tx.routes[0].q_acc, before[0].0);
        assert!(!st.tx.commanded(Side::L) && !st.tx.commanded(Side::R));
    }

    #[test]
    fn restages_the_accepted_arms_when_neither_the_frame_nor_its_transport_commits() {
        let mut st = standing();
        st.refuse(&[
            Check::Command,
            Check::Restore,
            Check::Repair,
            Check::StopTail,
            Check::Hold,
        ]);
        let before = st.accepted();
        // No rise to carry: the transport has nothing of its own to accept.
        st.frame(0.0);
        assert!(st.tx.notes().is_empty());
        for (side, (q, wrist)) in Side::BOTH.into_iter().zip(before) {
            assert_eq!(st.rig.arm_driver(side).unwrap().accepted_q, q);
            assert!(st.hand(side).distance_to(&wrist) < 1e-10, "{side:?}");
        }
    }
}
