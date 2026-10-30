//! `rig/arm-path.ts` `ArmStepSolver`: a damped, box- and clearance-constrained numerical stepper
//! over raw FK.
//!
//! The TS holds its seventeen path states as named fields and passes them to its methods by
//! reference; here they live in one table, named by the indices below, so a method can read one
//! state while it writes another. The resolved bounds the TS passes beside `this` are a copy taken
//! once per call, as nothing writes them after `createBounds`. The TS instance scratch that every
//! method writes before it reads (the retraction vectors, the forced-row scratch) is local.
//!
//! The TS `rowMap` is the registered key list itself: a key's row is its position there, which is
//! the order the map was filled in, and during registration the map holds exactly the keys
//! registered so far. Every buffer is allocated at construction or when the environment's row
//! count changes, as in the TS. A broken clearance-row contract panics with the TS message.
//!
//! Nothing a call reads was written by an earlier call: the solver keeps no pose history.

// The solver indexes several buffers by the same row and joint, as the TS does, and its negated
// comparisons are what let a NaN fail them.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use super::plan::{
    ArmPathBounds, ArmPathClearance, ArmPathEnvironment, ArmPathPlanOutput, ArmPathPoint,
    ArmPathRequest, ArmPathStatus, ClearanceKey, DEVIATION_COMFORT_MARGIN,
    DEVIATION_COMFORT_WEIGHT, DIFFERENCE_SCALE, DIRECTION_COMPONENTS, DOFS, FULL_TURN, LANDMARKS,
    LEXICAL_EPSILON, MAX_ENVIRONMENT_BATCHES, MAX_ITERATIONS, MAX_LINE_SEARCHES, MAX_SWEEP_DEPTH,
    PathState, RESTORE_MARGIN, ResolvedBounds, SETTLED_ORIENTATION, SETTLED_POSITION_FRACTION,
    STATIONARY_FRACTION, clone_rows, configuration_from_q, copy_forward, create_bounds, dot_row,
    finite_spec, finite_vector, halvings, make_state, proxy_points, valid_context, valid_forward,
};
use crate::anatomy::joints::{HAND_CONTACT, TORSO_ARM_START, TORSO_SAMPLES};
use crate::anatomy::strain::elevation_ceiling;
use crate::math::f::{acos, atan2, cos, hypot, hypot3, js_max, js_min, sqrt};
use crate::math::{Vec3, clamp};
use crate::rig::arm_configuration::{
    ArmCalibration, ArmDirections, ArmForwardContext, ArmForwardResult,
    configuration_of_directions, forward_arm,
};
use crate::rig::arm_qp::{
    CONSTRAINT_EPSILON, QpResult, QpScratch, make_qp_scratch, solve_dual_active_set,
};
use crate::rig::hand_geometry::{
    HandGeometryCalibration, HandGeometrySample, make_hand_geometry_sample, sample_hand_geometry,
};
use core::f64::consts::PI;

// The path states, in the TS `allStates` order.
const CURRENT: usize = 0;
const ORIGINAL_START: usize = 1;
const CERTIFIED_CHECKPOINT: usize = 2;
const CANDIDATE: usize = 3;
const PROBE_PLUS: usize = 4;
const PROBE_MINUS: usize = 5;
/// The first of the three `quarterStates`.
const QUARTER: usize = 6;
/// The first of the `MAX_SWEEP_DEPTH` `recursiveStates`.
const RECURSIVE: usize = QUARTER + 3;
const STATE_COUNT: usize = RECURSIVE + MAX_SWEEP_DEPTH;
/// The TS `clearanceStates`: the states whose rows are ever sampled or copied.
const CLEARANCE_STATES: [usize; 5] = [
    CURRENT,
    ORIGINAL_START,
    CERTIFIED_CHECKPOINT,
    CANDIDATE,
    QUARTER,
];

/// A damped, box- and clearance-constrained numerical stepper over raw FK.
pub struct ArmStepSolver {
    calibration: ArmCalibration,
    hand_geometry: HandGeometryCalibration,
    template_points: Vec<ArmPathPoint>,
    states: Vec<PathState>,
    prepared_sweep_fractions: [f64; MAX_ENVIRONMENT_BATCHES],
    prepared_sweep_count: usize,
    reserved_sweep_fractions: [f64; MAX_ENVIRONMENT_BATCHES],
    reserved_sweep_count: usize,
    has_certified_progress: bool,
    current_is_certified: bool,
    resolved_bounds: ResolvedBounds,
    hand_sample: HandGeometrySample,
    local_finger_points: Vec<Vec3>,
    target_wrist: Vec3,
    target_hand: Vec3,
    target_palm: Vec3,
    target_elbow: Vec3,
    target_landmarks: [f64; LANDMARKS * DIRECTION_COMPONENTS],
    residual: [f64; LANDMARKS * DIRECTION_COMPONENTS],
    pole_gradient: [f64; 2],
    pole_ray: f64,
    jacobian: [f64; LANDMARKS * DIRECTION_COMPONENTS * DOFS],
    elbow_jacobian: [f64; DIRECTION_COMPONENTS * DOFS],
    projected_elbow_jacobian: [f64; DIRECTION_COMPONENTS * DOFS],
    secondary_vector: [f64; DOFS],
    comfort_row: [f64; DOFS],
    point_jacobian: Vec<f64>,
    trial_q: [f64; DOFS],
    normal_matrix: [f64; DOFS * DOFS],
    hessian: [f64; DOFS * DOFS],
    cholesky: [f64; DOFS * DOFS],
    right_hand: [f64; DOFS],
    solved: [f64; DOFS],
    solve_scratch: [f64; DOFS],
    qp_delta: [f64; DOFS],
    primary_delta: [f64; DOFS],
    primary_basis_count: usize,
    primary_rank_threshold: f64,
    qp_a: Vec<f64>,
    qp_b: Vec<f64>,
    qp_z: Vec<f64>,
    qp_lambda: Vec<f64>,
    qp_scratch: QpScratch,
    /// Why the last `make_constrained_step` returned; `None` is the TS `'rejected'`, a false
    /// outside the kernel.
    last_qp_result: Option<QpResult>,
    /// The last successful constrained step leaned on a temporal box row.
    last_step_temporal: bool,
    /// The keys in row order, which is also the TS `rowMap`: see the module comment.
    registered_keys: Vec<Option<ClearanceKey>>,
    registered_point_indices: Vec<Option<usize>>,
    forced_distance: Vec<f64>,
    forced_normals: Vec<Vec3>,
    forced_points: Vec<Vec3>,
    forced_point_index: Vec<Option<usize>>,
    forced_rows: Vec<bool>,
    query_rows: Vec<ArmPathClearance>,
    /// `None` until the first call, where the TS has `-1`.
    row_count: Option<usize>,
    qp_capacity: usize,
    hand_length: f64,
    span: f64,
    resolution: f64,
    environment_batches: usize,
    key_contract_ready: bool,
    new_forced_rows: bool,
    request_has_palm: bool,
    request_has_elbow: bool,
    roundoff_tolerance: f64,
    row_basis: [f64; DOFS * DOFS],
    mapped_seen: Vec<bool>,
    start_q: [f64; DOFS],
    #[cfg(test)]
    trace: tests::Trace,
}

/// One state to read and another to write, from the state table.
fn pair(states: &mut [PathState], read: usize, write: usize) -> (&PathState, &mut PathState) {
    assert_ne!(read, write, "a state copied onto itself");
    if read < write {
        let (head, tail) = states.split_at_mut(write);
        (&head[read], &mut tail[0])
    } else {
        let (head, tail) = states.split_at_mut(read);
        (&tail[0], &mut head[write])
    }
}

/// One component of a vector, by axis.
fn component(v: &Vec3, axis: usize) -> f64 {
    match axis {
        0 => v.x,
        1 => v.y,
        _ => v.z,
    }
}

// arm-path.ts ArmStepSolver.solveLinear
//
// The factor and the substitution scratch are passed in, so the matrix, the right-hand side and
// the answer may be any of the solver's other buffers.
fn solve_linear(
    cholesky: &mut [f64; DOFS * DOFS],
    solve_scratch: &mut [f64; DOFS],
    matrix: &[f64; DOFS * DOFS],
    rhs: &[f64],
    out: &mut [f64],
    rhs_offset: usize,
    out_offset: usize,
) -> bool {
    cholesky.fill(0.0);
    for i in 0..DOFS {
        for j in 0..=i {
            let mut sum = matrix[i * DOFS + j];
            for k in 0..j {
                sum -= cholesky[i * DOFS + k] * cholesky[j * DOFS + k];
            }
            if i == j {
                if !(sum > 0.0 && sum.is_finite()) {
                    return false;
                }
                cholesky[i * DOFS + j] = sqrt(sum);
            } else {
                cholesky[i * DOFS + j] = sum / cholesky[j * DOFS + j];
            }
        }
    }
    for i in 0..DOFS {
        let mut sum = rhs[rhs_offset + i];
        for j in 0..i {
            sum -= cholesky[i * DOFS + j] * solve_scratch[j];
        }
        solve_scratch[i] = sum / cholesky[i * DOFS + i];
    }
    for i in (0..DOFS).rev() {
        let mut sum = solve_scratch[i];
        for j in i + 1..DOFS {
            sum -= cholesky[j * DOFS + i] * out[out_offset + j];
        }
        out[out_offset + i] = sum / cholesky[i * DOFS + i];
    }
    for i in 0..DOFS {
        if !out[out_offset + i].is_finite() {
            return false;
        }
    }
    true
}

// arm-path.ts ArmStepSolver.projectToPrimaryNullspace
fn project_to_primary_nullspace(
    row_basis: &[f64; DOFS * DOFS],
    primary_basis_count: usize,
    vector: &mut [f64],
    vector_offset: usize,
) {
    for basis_index in 0..primary_basis_count {
        let offset = basis_index * DOFS;
        let mut projection = 0.0;
        for i in 0..DOFS {
            projection += row_basis[offset + i] * vector[vector_offset + i];
        }
        for i in 0..DOFS {
            vector[vector_offset + i] -= row_basis[offset + i] * projection;
        }
    }
}

// arm-path.ts ArmStepSolver.predictedPointDisplacement
fn predicted_point_displacement(
    point_jacobian: &[f64],
    point_index: usize,
    delta: &[f64; DOFS],
) -> f64 {
    let mut x = 0.0;
    let mut y = 0.0;
    let mut z = 0.0;
    for dof in 0..DOFS {
        let offset = point_index * 3 * DOFS + dof;
        x += point_jacobian[offset] * delta[dof];
        y += point_jacobian[offset + DOFS] * delta[dof];
        z += point_jacobian[offset + 2 * DOFS] * delta[dof];
    }
    hypot3(x, y, z)
}

impl ArmStepSolver {
    // arm-path.ts ArmStepSolver.constructor
    pub fn new(
        calibration: &ArmCalibration,
        hand_geometry: &HandGeometryCalibration,
        measured_hand_length: f64,
        sweep_resolution: f64,
    ) -> ArmStepSolver {
        assert!(
            measured_hand_length > 0.0 && measured_hand_length.is_finite(),
            "measured hand length must be finite and positive"
        );
        assert!(
            sweep_resolution > 0.0 && sweep_resolution.is_finite(),
            "sweep resolution must be finite and positive"
        );
        let template_points = proxy_points(hand_geometry);
        let states = (0..STATE_COUNT)
            .map(|_| make_state(&template_points))
            .collect();
        let hand_sample = make_hand_geometry_sample(hand_geometry);
        let local_finger_points = vec![Vec3::default(); hand_sample.points.len()];
        ArmStepSolver {
            calibration: calibration.clone(),
            hand_geometry: hand_geometry.clone(),
            template_points,
            states,
            prepared_sweep_fractions: [0.0; MAX_ENVIRONMENT_BATCHES],
            prepared_sweep_count: 0,
            reserved_sweep_fractions: [0.0; MAX_ENVIRONMENT_BATCHES],
            reserved_sweep_count: 0,
            has_certified_progress: false,
            current_is_certified: true,
            resolved_bounds: ResolvedBounds::default(),
            hand_sample,
            local_finger_points,
            target_wrist: Vec3::default(),
            target_hand: Vec3::default(),
            target_palm: Vec3::default(),
            target_elbow: Vec3::default(),
            target_landmarks: [0.0; LANDMARKS * DIRECTION_COMPONENTS],
            residual: [0.0; LANDMARKS * DIRECTION_COMPONENTS],
            pole_gradient: [0.0; 2],
            pole_ray: 0.0,
            jacobian: [0.0; LANDMARKS * DIRECTION_COMPONENTS * DOFS],
            elbow_jacobian: [0.0; DIRECTION_COMPONENTS * DOFS],
            projected_elbow_jacobian: [0.0; DIRECTION_COMPONENTS * DOFS],
            secondary_vector: [0.0; DOFS],
            comfort_row: [0.0; DOFS],
            point_jacobian: Vec::new(),
            trial_q: [0.0; DOFS],
            normal_matrix: [0.0; DOFS * DOFS],
            hessian: [0.0; DOFS * DOFS],
            cholesky: [0.0; DOFS * DOFS],
            right_hand: [0.0; DOFS],
            solved: [0.0; DOFS],
            solve_scratch: [0.0; DOFS],
            qp_delta: [0.0; DOFS],
            primary_delta: [0.0; DOFS],
            primary_basis_count: 0,
            primary_rank_threshold: 0.0,
            qp_a: Vec::new(),
            qp_b: Vec::new(),
            qp_z: Vec::new(),
            qp_lambda: Vec::new(),
            qp_scratch: make_qp_scratch(),
            last_qp_result: None,
            last_step_temporal: false,
            registered_keys: Vec::new(),
            registered_point_indices: Vec::new(),
            forced_distance: Vec::new(),
            forced_normals: Vec::new(),
            forced_points: Vec::new(),
            forced_point_index: Vec::new(),
            forced_rows: Vec::new(),
            query_rows: Vec::new(),
            row_count: None,
            qp_capacity: 0,
            hand_length: measured_hand_length,
            span: 0.0,
            resolution: sweep_resolution,
            environment_batches: 0,
            key_contract_ready: false,
            new_forced_rows: false,
            request_has_palm: false,
            request_has_elbow: false,
            roundoff_tolerance: 0.0,
            row_basis: [0.0; DOFS * DOFS],
            mapped_seen: Vec::new(),
            start_q: [0.0; DOFS],
            #[cfg(test)]
            trace: tests::Trace::default(),
        }
    }

    // arm-path.ts ArmStepSolver.plan
    //
    // Plan one bounded move. The caller owns and commits the returned q; this
    // method has no pose history and never changes the request, bounds or context.
    pub fn plan<'o>(
        &mut self,
        request: &ArmPathRequest,
        start: &[f64; DOFS],
        context: &ArmForwardContext,
        bounds: &ArmPathBounds,
        environment: &mut dyn ArmPathEnvironment,
        out: &'o mut ArmPathPlanOutput,
    ) -> &'o mut ArmPathPlanOutput {
        Self::reset_output(out);
        self.reset_search_scratch();
        #[cfg(test)]
        {
            self.trace.iteration = 0;
        }
        if !create_bounds(&self.calibration, bounds, &mut self.resolved_bounds)
            || out.clearances.len() != environment.row_count()
            || out.points.len() != self.template_points.len()
            || !Self::valid_request(request)
            || !valid_context(context)
        {
            out.status = ArmPathStatus::Blocked;
            Self::copy_safe_start(out, start);
            return out;
        }
        let resolved = self.resolved_bounds;
        if self.row_count != Some(environment.row_count()) {
            self.prepare_rows(environment.row_count());
        }
        self.span = context.upper_length + context.lower_length + self.hand_length;
        if !self.span.is_finite() || self.span <= 0.0 {
            Self::copy_safe_start(out, start);
            return out;
        }
        self.roundoff_tolerance = 64.0 * f64::EPSILON * js_max(1.0, self.span);
        self.request_has_palm = request.palm.is_some();
        self.request_has_elbow = request.elbow.is_some();
        self.target_wrist.copy(&request.wrist);
        self.target_hand.copy(&request.hand).normalize();
        self.target_palm.set(0.0, 0.0, 0.0);
        if let Some(palm) = &request.palm {
            let along = -palm.dot(&self.target_hand);
            self.target_palm
                .copy(palm)
                .add_scaled_vector(&self.target_hand, along);
            if self.target_palm.length_sq() < 1e-12 {
                out.status = ArmPathStatus::Blocked;
                Self::copy_safe_start(out, start);
                return out;
            }
            self.target_palm.normalize();
        }
        if let Some(elbow) = &request.elbow {
            self.target_elbow.copy(elbow);
        }
        self.start_q = *start;
        sample_hand_geometry(
            &self.hand_geometry,
            &request.curls,
            &request.spread,
            &mut self.hand_sample,
        );
        for i in 0..self.hand_sample.points.len() {
            self.local_finger_points[i].copy(&self.hand_sample.points[i].position);
        }
        for i in 0..DOFS {
            if !start[i].is_finite() || start[i] < resolved.lower[i] || start[i] > resolved.upper[i]
            {
                out.status = ArmPathStatus::Blocked;
                Self::copy_safe_start(out, start);
                return out;
            }
            self.states[CURRENT].q[i] = start[i];
        }
        self.fill_target_landmarks();
        if !self.evaluate_geometry(CURRENT, context, &resolved) {
            out.status = ArmPathStatus::Blocked;
            Self::copy_safe_start(out, start);
            return out;
        }
        if !self.sample_clearances(CURRENT, environment, MAX_ENVIRONMENT_BATCHES) {
            out.status = ArmPathStatus::Blocked;
            Self::copy_safe_start(out, start);
            return out;
        }
        self.measure_state(CURRENT);
        if self.states[CURRENT].max_violation > self.roundoff_tolerance {
            // A moving environment can push into a clear goal. Push it clear first;
            // like restoreEndpoint, the chord from the start to the cleared pose is
            // not swept, and the push neither counts as progress nor as iterations.
            self.copy_state(CURRENT, ORIGINAL_START);
            self.push_clear(context, &resolved, environment);
            if self.states[CURRENT].max_violation > self.roundoff_tolerance {
                self.copy_to_output(ORIGINAL_START, out, ArmPathStatus::Blocked);
                return out;
            }
        }
        self.copy_state(CURRENT, ORIGINAL_START);
        self.copy_state(CURRENT, CERTIFIED_CHECKPOINT);

        if self.is_settled(CURRENT) {
            self.copy_to_output(CURRENT, out, ArmPathStatus::Settled);
            return out;
        }

        let mut damping_scale = 1.0;
        // Signals for the status: an accepted gauge move, a temporal row under an
        // accepted step, and whether the last iteration's exact QP step was spent.
        let mut gauge_accepted = false;
        let mut temporal_accepted = false;
        let mut last_qp_optimal = false;
        let mut last_step_spent = false;
        for iteration in 0..MAX_ITERATIONS {
            out.iterations = iteration + 1;
            #[cfg(test)]
            {
                self.trace.iteration = iteration + 1;
            }
            self.new_forced_rows = false;
            last_qp_optimal = false;
            last_step_spent = false;
            if !self.linearize(CURRENT, context, &resolved) {
                if !self.certify_current(context, &resolved, environment)
                    && self.new_forced_rows
                    && iteration + 1 < MAX_ITERATIONS
                    && self.environment_batches < MAX_ENVIRONMENT_BATCHES
                {
                    damping_scale *= 10.0;
                    continue;
                }
                break;
            }
            let mut accepted_this_iteration = false;
            let mut line_evaluated = false;
            let mut line_only_better = true;
            let mut step_temporal = false;
            let mut predicted_descent = f64::INFINITY;
            let mut qp_attempts = 0;
            let mut line_candidates = 0;
            let mut damping = self.initial_damping() * damping_scale;

            let primary_settled = self.is_primary_settled(CURRENT);
            let pole_plane = if primary_settled {
                None
            } else {
                self.pole_gauge_proposal(CURRENT, context, &resolved)
            };
            if let Some(pole_plane) = pole_plane {
                let line = line_candidates;
                line_candidates += 1;
                self.trial_q = self.states[CURRENT].q;
                self.trial_q[0] = pole_plane;
                self.states[CANDIDATE].q = self.trial_q;
                line_evaluated = true;
                if !self.evaluate_plan_candidate(context, &resolved, environment, line) {
                    line_only_better = false;
                } else if self.better_pole_gauge(CANDIDATE, CURRENT, self.pole_ray) {
                    self.accept_plan_candidate(&*environment);
                    #[cfg(test)]
                    {
                        self.trace.gauge_moves += 1;
                    }
                    accepted_this_iteration = true;
                    gauge_accepted = true;
                    damping_scale = 1.0;
                }
            }
            if !accepted_this_iteration {
                let mut primary_available = primary_settled;
                self.primary_delta.fill(0.0);
                while !primary_available
                    && qp_attempts < MAX_LINE_SEARCHES
                    && line_candidates < MAX_LINE_SEARCHES
                    && self.environment_batches < MAX_ENVIRONMENT_BATCHES
                {
                    self.build_hessian(damping);
                    qp_attempts += 1;
                    if !solve_linear(
                        &mut self.cholesky,
                        &mut self.solve_scratch,
                        &self.hessian,
                        &self.right_hand,
                        &mut self.solved,
                        0,
                        0,
                    ) {
                        damping *= 10.0;
                        continue;
                    }
                    let unconstrained = self.solved;
                    let stepped =
                        self.make_constrained_step(CURRENT, &resolved, &unconstrained, true, false);
                    last_qp_optimal = self.last_qp_result == Some(QpResult::Optimal);
                    if !stepped {
                        // Feasibility does not depend on damping, so a larger one cannot help.
                        if self.last_qp_result == Some(QpResult::Infeasible) {
                            break;
                        }
                        damping *= 10.0;
                        continue;
                    }
                    self.primary_delta = self.qp_delta;
                    step_temporal = self.last_step_temporal;
                    predicted_descent = self.predicted_descent(&self.primary_delta);
                    primary_available = true;
                }
                if primary_available {
                    let mut secondary = false;
                    // The TS counts this attempt too, but nothing reads the count after it.
                    if self.request_has_elbow && qp_attempts < MAX_LINE_SEARCHES {
                        secondary = self.make_secondary_step(CURRENT, &resolved);
                        // The elbow step rides on the primary one; its temporal rows bind the move too.
                        if secondary && self.last_step_temporal {
                            step_temporal = true;
                        }
                    }
                    if !secondary {
                        self.qp_delta = self.primary_delta;
                    }
                    // A successful but tiny primary step can still permit useful elbow motion.
                    if Self::step_norm(&self.qp_delta) >= 1e-10 {
                        // A successful QP owns the remaining dyadic line sequence for this GN iteration.
                        while line_candidates < MAX_LINE_SEARCHES {
                            let line = line_candidates;
                            line_candidates += 1;
                            let alpha = halvings(line);
                            line_evaluated = true;
                            if !(self.write_hierarchy_candidate(
                                CURRENT, context, &resolved, alpha, secondary,
                            ) && self.evaluate_plan_candidate(
                                context,
                                &resolved,
                                environment,
                                line,
                            )) {
                                line_only_better = false;
                                continue;
                            }
                            if !self.better(CANDIDATE, CURRENT) {
                                continue;
                            }
                            self.accept_plan_candidate(&*environment);
                            #[cfg(test)]
                            {
                                self.trace.accepted_lines[line] += 1;
                            }
                            accepted_this_iteration = true;
                            if step_temporal {
                                temporal_accepted = true;
                            }
                            damping_scale = 1.0;
                            break;
                        }
                    }
                }
            }

            // An exact step that is zero, or whose every line candidate lost only on
            // the objective with a model descent below the tolerance, is spent.
            last_step_spent = last_qp_optimal
                && !accepted_this_iteration
                && (Self::step_norm(&self.primary_delta) < 1e-10
                    || (line_evaluated
                        && line_only_better
                        && predicted_descent
                            <= Self::lexical_tolerance(self.states[CURRENT].primary_error)));

            let stopping = self.is_settled(CURRENT)
                || !(accepted_this_iteration || self.new_forced_rows)
                || iteration + 1 == MAX_ITERATIONS
                || self.environment_batches >= MAX_ENVIRONMENT_BATCHES;
            if stopping {
                if !self.certify_current(context, &resolved, environment)
                    && self.new_forced_rows
                    && iteration + 1 < MAX_ITERATIONS
                    && self.environment_batches < MAX_ENVIRONMENT_BATCHES
                {
                    damping_scale *= 10.0;
                    continue;
                }
                break;
            }
            if !accepted_this_iteration {
                damping_scale *= 10.0;
            }
        }

        let accepted = self.has_certified_progress;
        let negligible = self.states[ORIGINAL_START].primary_error
            - self.states[CURRENT].primary_error
            <= STATIONARY_FRACTION * self.states[ORIGINAL_START].primary_error;
        // The two stationary cases stay apart, as the TS states them.
        #[allow(clippy::if_same_then_else)]
        let status = if self.is_primary_settled(CURRENT) {
            ArmPathStatus::Settled
        } else if gauge_accepted {
            ArmPathStatus::Progress
        } else if last_qp_optimal && !accepted && last_step_spent {
            ArmPathStatus::Stationary
        } else if last_qp_optimal && accepted && negligible && !temporal_accepted {
            ArmPathStatus::Stationary
        } else if accepted {
            ArmPathStatus::Progress
        } else {
            ArmPathStatus::Blocked
        };
        self.copy_to_output(CURRENT, out, status);
        out
    }

    // arm-path.ts ArmStepSolver.evaluatePlanCandidate
    //
    // Keep the first improving move fully certified, including swept-row feedback.
    // Later GN endpoints share one reserved original-start certificate instead of
    // paying for overlapping chords after every improvement. Geometry preflight
    // is query-free; a rejected endpoint must leave the current reservation intact.
    fn evaluate_plan_candidate(
        &mut self,
        context: &ArmForwardContext,
        bounds: &ResolvedBounds,
        environment: &mut dyn ArmPathEnvironment,
        line: usize,
    ) -> bool {
        #[cfg(test)]
        {
            self.trace.candidates[self.trace.iteration] += 1;
        }
        if !self.evaluate_geometry(CANDIDATE, context, bounds) {
            return false;
        }
        self.prepared_sweep_count = 0;
        let speculative = self.has_certified_progress && environment.row_count() > 0;
        let ceiling = if speculative {
            MAX_ENVIRONMENT_BATCHES
        } else {
            self.line_trial_query_ceiling(line)
        };
        let budget = ceiling as isize - self.environment_batches as isize;
        if environment.row_count() > 0 {
            if self.minimum_sweep_batches(ORIGINAL_START, CANDIDATE) > budget as f64 {
                return false;
            }
            if !self.prepare_sweep(ORIGINAL_START, CANDIDATE, context, bounds, budget) {
                return false;
            }
            // The endpoint costs one query even if it is rejected. Preserve enough
            // queries to certify either the old current or this candidate afterwards.
            if speculative
                && self.environment_batches
                    + 1
                    + self.reserved_sweep_count.max(self.prepared_sweep_count)
                    > MAX_ENVIRONMENT_BATCHES
            {
                return false;
            }
        }
        if !self.sample_clearances(CANDIDATE, environment, ceiling) {
            return false;
        }
        self.measure_state(CANDIDATE);
        if self.states[CANDIDATE].max_violation > self.roundoff_tolerance {
            self.remember_failed_rows(CANDIDATE);
            return false;
        }
        speculative
            || self.validate_prepared_sweep(CANDIDATE, context, bounds, environment, ceiling)
    }

    // arm-path.ts ArmStepSolver.acceptPlanCandidate
    fn accept_plan_candidate(&mut self, environment: &dyn ArmPathEnvironment) {
        self.copy_state(CANDIDATE, CURRENT);
        if !self.has_certified_progress || environment.row_count() == 0 {
            self.copy_state(CURRENT, CERTIFIED_CHECKPOINT);
            self.has_certified_progress = true;
            self.current_is_certified = true;
            self.reserved_sweep_count = 0;
        } else {
            // Even a zero-lift gauge move changes the q chord that will be emitted.
            // Its certificate cannot be inherited from equal endpoint FK alone.
            self.current_is_certified = false;
            self.reserved_sweep_count = self.prepared_sweep_count;
            let n = self.prepared_sweep_count;
            self.reserved_sweep_fractions[..n].copy_from_slice(&self.prepared_sweep_fractions[..n]);
        }
    }

    // arm-path.ts ArmStepSolver.certifyCurrent
    //
    // Certify before any exit; failed speculative work can only expose the checkpoint.
    fn certify_current(
        &mut self,
        context: &ArmForwardContext,
        bounds: &ResolvedBounds,
        environment: &mut dyn ArmPathEnvironment,
    ) -> bool {
        if self.current_is_certified {
            return true;
        }
        #[cfg(test)]
        let observed = tests::Certificate::before(self);
        self.prepared_sweep_count = self.reserved_sweep_count;
        let n = self.reserved_sweep_count;
        self.prepared_sweep_fractions[..n].copy_from_slice(&self.reserved_sweep_fractions[..n]);
        let certified = self.validate_prepared_sweep(
            CURRENT,
            context,
            bounds,
            environment,
            MAX_ENVIRONMENT_BATCHES,
        );
        self.reserved_sweep_count = 0;
        self.current_is_certified = true;
        if certified {
            self.copy_state(CURRENT, CERTIFIED_CHECKPOINT);
        } else {
            self.copy_state(CERTIFIED_CHECKPOINT, CURRENT);
        }
        #[cfg(test)]
        {
            observed.after(self, certified);
        }
        certified
    }

    // arm-path.ts ArmStepSolver.restoreEndpoint
    //
    // Restore only the requested endpoint after the context or finger shape changed.
    // The caller must certify any bridge from the previously committed pose.
    pub fn restore_endpoint(
        &mut self,
        request: &ArmPathRequest,
        start: &[f64; DOFS],
        context: &ArmForwardContext,
        bounds: &ArmPathBounds,
        environment: &mut dyn ArmPathEnvironment,
        out: &mut ArmPathPlanOutput,
    ) -> bool {
        Self::reset_output(out);
        self.reset_search_scratch();
        #[cfg(test)]
        {
            self.trace.iteration = 0;
        }
        if !create_bounds(&self.calibration, bounds, &mut self.resolved_bounds)
            || out.clearances.len() != environment.row_count()
            || out.points.len() != self.template_points.len()
            || !Self::valid_request(request)
            || !valid_context(context)
        {
            Self::copy_safe_start(out, start);
            return false;
        }

        let resolved = self.resolved_bounds;
        if self.row_count != Some(environment.row_count()) {
            self.prepare_rows(environment.row_count());
        }
        self.registered_point_indices.fill(None);
        self.span = context.upper_length + context.lower_length + self.hand_length;
        if !self.span.is_finite() || self.span <= 0.0 {
            Self::copy_safe_start(out, start);
            return false;
        }
        self.roundoff_tolerance = 64.0 * f64::EPSILON * js_max(1.0, self.span);
        self.request_has_palm = request.palm.is_some();
        self.request_has_elbow = request.elbow.is_some();
        self.target_wrist.copy(&request.wrist);
        self.target_hand.copy(&request.hand).normalize();
        self.target_palm.set(0.0, 0.0, 0.0);
        if let Some(palm) = &request.palm {
            let along = -palm.dot(&self.target_hand);
            self.target_palm
                .copy(palm)
                .add_scaled_vector(&self.target_hand, along);
            if self.target_palm.length_sq() < 1e-12 {
                Self::copy_safe_start(out, start);
                return false;
            }
            self.target_palm.normalize();
        }
        if let Some(elbow) = &request.elbow {
            self.target_elbow.copy(elbow);
        }
        self.start_q = *start;
        sample_hand_geometry(
            &self.hand_geometry,
            &request.curls,
            &request.spread,
            &mut self.hand_sample,
        );
        for i in 0..self.hand_sample.points.len() {
            self.local_finger_points[i].copy(&self.hand_sample.points[i].position);
        }
        for i in 0..DOFS {
            if !start[i].is_finite() || start[i] < resolved.lower[i] || start[i] > resolved.upper[i]
            {
                Self::copy_safe_start(out, start);
                return false;
            }
            self.states[CURRENT].q[i] = start[i];
        }
        self.fill_target_landmarks();
        if !(self.evaluate_geometry(CURRENT, context, &resolved)
            && self.sample_clearances(CURRENT, environment, MAX_ENVIRONMENT_BATCHES))
        {
            Self::copy_safe_start(out, start);
            out.environment_batches = self.environment_batches;
            return false;
        }
        self.measure_state(CURRENT);
        if self.states[CURRENT].max_violation <= self.roundoff_tolerance {
            let status = if self.is_settled(CURRENT) {
                ArmPathStatus::Settled
            } else {
                ArmPathStatus::Progress
            };
            self.copy_to_output(CURRENT, out, status);
            return true;
        }
        let iterations = self.push_clear(context, &resolved, environment);
        if self.states[CURRENT].max_violation <= self.roundoff_tolerance {
            let status = if self.is_settled(CURRENT) {
                ArmPathStatus::Settled
            } else {
                ArmPathStatus::Progress
            };
            self.copy_to_output(CURRENT, out, status);
            out.iterations = iterations;
            return true;
        }

        Self::copy_safe_start(out, start);
        out.status = ArmPathStatus::Blocked;
        out.position_error = f64::INFINITY;
        out.orientation_error = f64::INFINITY;
        out.secondary_error = f64::INFINITY;
        out.max_violation = f64::INFINITY;
        out.iterations = iterations;
        out.environment_batches = self.environment_batches;
        false
    }

    // arm-path.ts ArmStepSolver.pushClear
    //
    // Penetration-only GN on `current` until it is clear. Returns the iterations
    // used; the caller reads success off `current.maxViolation`.
    fn push_clear(
        &mut self,
        context: &ArmForwardContext,
        bounds: &ResolvedBounds,
        environment: &mut dyn ArmPathEnvironment,
    ) -> usize {
        #[cfg(test)]
        {
            self.trace.push_clears += 1;
        }
        let mut used = 0;
        for iteration in 0..MAX_ITERATIONS {
            used = iteration + 1;
            if !self.linearize_penetration(CURRENT, context, bounds) {
                break;
            }
            let mut qp_attempts = 0;
            let mut line_candidates = 0;
            let mut damping = self.initial_damping();
            let mut accepted = false;
            while qp_attempts < MAX_LINE_SEARCHES
                && line_candidates < MAX_LINE_SEARCHES
                && self.environment_batches < MAX_ENVIRONMENT_BATCHES
            {
                self.build_hessian(damping);
                qp_attempts += 1;
                if !solve_linear(
                    &mut self.cholesky,
                    &mut self.solve_scratch,
                    &self.hessian,
                    &self.right_hand,
                    &mut self.solved,
                    0,
                    0,
                ) {
                    damping *= 10.0;
                    continue;
                }
                let unconstrained = self.solved;
                if !self.make_constrained_step(CURRENT, bounds, &unconstrained, false, false) {
                    if self.last_qp_result == Some(QpResult::Infeasible) {
                        break;
                    }
                    damping *= 10.0;
                    continue;
                }
                if Self::step_norm(&self.qp_delta) < 1e-10 {
                    break;
                }

                while line_candidates < MAX_LINE_SEARCHES {
                    let line = line_candidates;
                    line_candidates += 1;
                    let alpha = halvings(line);
                    let (q, delta) = (self.states[CURRENT].q, self.qp_delta);
                    if !self.write_bounded_trial(&q, &delta, alpha, bounds) {
                        continue;
                    }
                    self.states[CANDIDATE].q = self.trial_q;
                    if !self.evaluate_geometry(CANDIDATE, context, bounds) {
                        continue;
                    }
                    if !self.sample_clearances(CANDIDATE, environment, MAX_ENVIRONMENT_BATCHES) {
                        break;
                    }
                    self.measure_state(CANDIDATE);
                    if !self.improves_penetration(CANDIDATE, CURRENT) {
                        continue;
                    }

                    self.copy_state(CANDIDATE, CURRENT);
                    accepted = true;
                    if self.states[CURRENT].max_violation <= self.roundoff_tolerance {
                        return used;
                    }
                    break;
                }
                // A successful QP owns the remaining endpoint line sequence for this iteration.
                break;
            }
            if !accepted {
                break;
            }
        }
        used
    }

    // arm-path.ts ArmStepSolver.resetOutput
    //
    // The forward result's default is the TS reset: zero vectors and identity rotations.
    fn reset_output(out: &mut ArmPathPlanOutput) {
        out.q.fill(0.0);
        configuration_from_q(&out.q, &mut out.configuration);
        out.forward = ArmForwardResult::default();
        for path_point in &mut out.points {
            path_point.position.set(0.0, 0.0, 0.0);
        }
        for row in &mut out.clearances {
            *row = ArmPathClearance::default();
        }
        out.status = ArmPathStatus::Blocked;
        out.position_error = f64::INFINITY;
        out.orientation_error = f64::INFINITY;
        out.secondary_error = f64::INFINITY;
        out.max_violation = f64::INFINITY;
        out.iterations = 0;
        out.environment_batches = 0;
    }

    // arm-path.ts ArmStepSolver.resetSearchScratch
    fn reset_search_scratch(&mut self) {
        self.environment_batches = 0;
        self.prepared_sweep_count = 0;
        self.reserved_sweep_count = 0;
        self.has_certified_progress = false;
        self.current_is_certified = true;
        self.key_contract_ready = false;
        self.new_forced_rows = false;
        self.registered_point_indices.fill(None);
        // Probes and the other sweep states only evaluate geometry; their rows stay neutral.
        for state in CLEARANCE_STATES {
            for row in &mut self.states[state].clearances {
                *row = ArmPathClearance::default();
            }
        }
        // Inactive payloads are never read; rememberFailedRows overwrites every field.
        self.forced_rows.fill(false);
    }

    // arm-path.ts ArmStepSolver.copySafeStart
    fn copy_safe_start(out: &mut ArmPathPlanOutput, start: &[f64; DOFS]) {
        if !start.iter().all(|v| v.is_finite()) {
            return;
        }
        out.q = *start;
        configuration_from_q(&out.q, &mut out.configuration);
    }

    // arm-path.ts ArmStepSolver.validRequest
    fn valid_request(request: &ArmPathRequest) -> bool {
        finite_vector(&request.wrist)
            && finite_vector(&request.hand)
            && request.hand.length_sq() > 1e-12
            && request.palm.as_ref().is_none_or(finite_vector)
            && request.elbow.as_ref().is_none_or(finite_vector)
            && finite_spec(&request.curls)
            && finite_spec(&request.spread)
    }

    // arm-path.ts ArmStepSolver.prepareRows
    fn prepare_rows(&mut self, count: usize) {
        #[cfg(test)]
        {
            self.trace.row_layouts += 1;
        }
        self.row_count = Some(count);
        self.query_rows = clone_rows(count);
        for state in &mut self.states {
            state.clearances = clone_rows(count);
        }
        self.forced_distance = vec![f64::INFINITY; count];
        self.forced_normals = vec![Vec3::default(); count];
        self.forced_points = vec![Vec3::default(); count];
        self.forced_point_index = vec![None; count];
        self.forced_rows = vec![false; count];
        let max_points = self.template_points.len();
        self.point_jacobian = vec![0.0; max_points * DIRECTION_COMPONENTS * DOFS];
        self.mapped_seen = vec![false; count];
        self.registered_keys = vec![None; count];
        self.registered_point_indices = vec![None; count];
        self.qp_capacity = count + 2 * DOFS;
        self.qp_a = vec![0.0; self.qp_capacity * DOFS];
        self.qp_b = vec![0.0; self.qp_capacity];
        self.qp_z = vec![0.0; self.qp_capacity * DOFS];
        self.qp_lambda = vec![0.0; self.qp_capacity];
    }

    // arm-path.ts ArmStepSolver.withinBounds
    fn within_bounds(q: &[f64; DOFS], bounds: &ResolvedBounds) -> bool {
        for i in 0..DOFS {
            if !q[i].is_finite() || q[i] < bounds.lower[i] || q[i] > bounds.upper[i] {
                return false;
            }
        }
        true
    }

    // arm-path.ts ArmStepSolver.writeBoundedTrial
    fn write_bounded_trial(
        &mut self,
        start: &[f64; DOFS],
        delta: &[f64; DOFS],
        alpha: f64,
        bounds: &ResolvedBounds,
    ) -> bool {
        for dof in 0..DOFS {
            let raw = start[dof] + alpha * delta[dof];
            if !raw.is_finite() {
                return false;
            }
            let bounded = js_max(bounds.lower[dof], js_min(bounds.upper[dof], raw));
            if (bounded - raw).abs() > CONSTRAINT_EPSILON {
                return false;
            }
            self.trial_q[dof] = bounded;
        }
        Self::within_bounds(&self.trial_q, bounds)
    }

    // arm-path.ts ArmStepSolver.fillTargetLandmarks
    fn fill_target_landmarks(&mut self) {
        let h = self.target_hand;
        self.target_landmarks[0] = self.target_wrist.x;
        self.target_landmarks[1] = self.target_wrist.y;
        self.target_landmarks[2] = self.target_wrist.z;
        self.target_landmarks[3] = self.target_wrist.x + self.hand_length * h.x;
        self.target_landmarks[4] = self.target_wrist.y + self.hand_length * h.y;
        self.target_landmarks[5] = self.target_wrist.z + self.hand_length * h.z;
        if self.request_has_palm {
            self.target_landmarks[6] = self.target_wrist.x + self.hand_length * self.target_palm.x;
            self.target_landmarks[7] = self.target_wrist.y + self.hand_length * self.target_palm.y;
            self.target_landmarks[8] = self.target_wrist.z + self.hand_length * self.target_palm.z;
        }
    }

    // arm-path.ts ArmStepSolver.evaluateGeometry
    fn evaluate_geometry(
        &mut self,
        state: usize,
        context: &ArmForwardContext,
        bounds: &ResolvedBounds,
    ) -> bool {
        let s = &mut self.states[state];
        if !Self::within_bounds(&s.q, bounds) {
            return false;
        }
        configuration_from_q(&s.q, &mut s.configuration);
        forward_arm(&s.configuration, &self.calibration, context, &mut s.forward);
        if !valid_forward(&s.forward) {
            return false;
        }
        let samples = TORSO_SAMPLES as f64;
        let mut cursor = 0;
        let span = context.upper_length * (1.0 - TORSO_ARM_START);
        for i in 0..=TORSO_SAMPLES {
            s.points[cursor]
                .position
                .copy(&context.shoulder)
                .add_scaled_vector(
                    &s.forward.u,
                    context.upper_length * TORSO_ARM_START + (span * i as f64) / samples,
                );
            cursor += 1;
        }
        for i in 1..=TORSO_SAMPLES {
            s.points[cursor]
                .position
                .copy(&s.forward.elbow)
                .add_scaled_vector(&s.forward.l, (context.lower_length * i as f64) / samples);
            cursor += 1;
        }
        for i in 1..=TORSO_SAMPLES {
            s.points[cursor]
                .position
                .copy(&s.forward.wrist)
                .add_scaled_vector(
                    &s.forward.h,
                    (self.hand_length * HAND_CONTACT * i as f64) / samples,
                );
            cursor += 1;
        }
        for i in 0..self.local_finger_points.len() {
            s.points[cursor]
                .position
                .copy(&self.local_finger_points[i])
                .apply_quaternion(&s.forward.hand_world)
                .add(&s.forward.wrist);
            cursor += 1;
        }
        if cursor != s.points.len() {
            return false;
        }
        s.points.iter().all(|p| finite_vector(&p.position))
    }

    // arm-path.ts ArmStepSolver.sampleClearances
    fn sample_clearances(
        &mut self,
        state: usize,
        environment: &mut dyn ArmPathEnvironment,
        query_ceiling: usize,
    ) -> bool {
        if environment.row_count() == 0 {
            return true;
        }
        if self.environment_batches >= query_ceiling.min(MAX_ENVIRONMENT_BATCHES) {
            return false;
        }
        for row in &mut self.query_rows {
            *row = ArmPathClearance::default();
        }
        environment.sample(&self.states[state].points, &mut self.query_rows);
        self.environment_batches += 1;
        let points = self.states[state].points.len();
        if !self.key_contract_ready {
            // Register every key before validating row values, preserving rejection order.
            for i in 0..self.query_rows.len() {
                let row = &self.query_rows[i];
                assert!(
                    row.key.is_some()
                        && row.point_index.is_some_and(|p| p < points)
                        && !self.registered_keys[..i].contains(&row.key),
                    "clearance rows need unique stable keys and valid point indices"
                );
                self.registered_keys[i] = row.key;
                self.registered_point_indices[i] = row.point_index;
            }
            self.key_contract_ready = true;
        }
        self.mapped_seen.fill(false);
        for slot in 0..self.query_rows.len() {
            let row = self.query_rows[slot];
            let index = if self.registered_keys[slot] == row.key {
                Some(slot)
            } else {
                self.registered_keys.iter().position(|k| *k == row.key)
            };
            let index = match index {
                Some(index) if !self.mapped_seen[index] => index,
                _ => panic!("clearance row keys must stay stable and unique across samples"),
            };
            assert!(
                self.registered_point_indices[index] == row.point_index,
                "clearance key changed its stable point index"
            );
            self.mapped_seen[index] = true;
            let canonical = self.states[state].clearances.get_mut(index);
            let canonical = match canonical {
                Some(c) if c.point_index.is_none() || c.point_index == row.point_index => c,
                _ => panic!("clearance key changed its stable point index"),
            };
            if canonical.point_index.is_none() {
                canonical.point_index = row.point_index;
            }
            canonical.key = row.key;
            canonical.valid = row.valid;
            canonical.distance = row.distance;
            canonical.normal.copy(&row.normal);
            assert!(
                !(row.valid
                    && (!(row.distance.is_finite() && finite_vector(&row.normal))
                        || row.normal.length_sq() < 1e-12)),
                "valid clearance rows need a finite distance and nonzero finite normal"
            );
        }
        true
    }

    // arm-path.ts ArmStepSolver.measureState
    fn measure_state(&mut self, state: usize) {
        let mut sum = 0.0;
        let landmark_count = if self.request_has_palm {
            LANDMARKS
        } else {
            LANDMARKS - 1
        };
        let s = &self.states[state];
        for landmark in 0..landmark_count {
            let wrist = &s.forward.wrist;
            for axis in 0..DIRECTION_COMPONENTS {
                let wrist_component = component(wrist, axis);
                let direction = if landmark == 1 {
                    &s.forward.h
                } else {
                    &s.forward.palm
                };
                let value = if landmark == 0 {
                    wrist_component
                } else {
                    wrist_component + self.hand_length * component(direction, axis)
                };
                let error = (self.target_landmarks[landmark * 3 + axis] - value) / self.span;
                self.residual[landmark * 3 + axis] = error;
                sum += error * error;
            }
        }
        let position_error = sqrt(sum) * self.span;
        let orientation_error = self.orientation_error(&s.forward);
        let secondary_error = if self.request_has_elbow {
            let dx = (self.target_elbow.x - s.forward.elbow.x) / self.span;
            let dy = (self.target_elbow.y - s.forward.elbow.y) / self.span;
            let dz = (self.target_elbow.z - s.forward.elbow.z) / self.span;
            let excess = self.deviation_excess(s.q[6]);
            dx * dx + dy * dy + dz * dz + DEVIATION_COMFORT_WEIGHT * excess * excess
        } else {
            0.0
        };
        let mut violation: f64 = 0.0;
        let mut penetration_square_sum = 0.0;
        for clearance in &s.clearances {
            if clearance.valid && clearance.distance < 0.0 {
                violation = js_max(violation, -clearance.distance);
                let normalized = clearance.distance / self.span;
                penetration_square_sum += normalized * normalized;
            }
        }
        let s = &mut self.states[state];
        s.primary_error = sum;
        s.position_error = position_error;
        s.orientation_error = orientation_error;
        s.secondary_error = secondary_error;
        s.max_violation = js_max(0.0, violation);
        s.penetration_square_sum = penetration_square_sum;
    }

    // arm-path.ts ArmStepSolver.orientationError
    fn orientation_error(&self, forward_result: &ArmForwardResult) -> f64 {
        let hand_dot = clamp(forward_result.h.dot(&self.target_hand), -1.0, 1.0);
        let mut error = acos(hand_dot);
        if self.request_has_palm {
            let palm_dot = clamp(forward_result.palm.dot(&self.target_palm), -1.0, 1.0);
            error = js_max(error, acos(palm_dot));
        }
        error
    }

    // arm-path.ts ArmStepSolver.poleGaugeProposal
    //
    // At zero elevation shoulderPlane is only a gauge. Choose a bounded plane
    // that points the next positive lift along the primary landmark descent.
    fn pole_gauge_proposal(
        &mut self,
        state: usize,
        context: &ArmForwardContext,
        bounds: &ResolvedBounds,
    ) -> Option<f64> {
        let q = self.states[state].q;
        if q[1] != 0.0
            || self.right_hand[1] > 0.0
            || !(bounds.upper[0] > bounds.lower[0])
            || !(bounds.upper[1] > 0.0)
        {
            return None;
        }
        if !self.pole_primary_gradient(state, context) {
            return None;
        }
        let g_l = self.pole_gradient[0];
        let g_f = self.pole_gradient[1];
        let magnitude = hypot(&[g_l, g_f]);
        let primary_error = self.states[state].primary_error;
        if !magnitude.is_finite()
            || magnitude * DIFFERENCE_SCALE <= Self::lexical_tolerance(primary_error)
        {
            return None;
        }

        let ray = atan2(g_f, g_l);
        self.pole_ray = ray;
        let first_equivalent = ((q[0] - ray) / FULL_TURN).floor();
        let mut best = q[0];
        let mut best_alignment = f64::NEG_INFINITY;
        let mut best_movement = f64::INFINITY;
        for offset in 0..2 {
            let equivalent = ray + (first_equivalent + f64::from(offset)) * FULL_TURN;
            let target = js_max(bounds.lower[0], js_min(bounds.upper[0], equivalent));
            let alignment = cos(target - ray);
            let movement = (target - q[0]).abs();
            if alignment > best_alignment
                || (alignment == best_alignment && movement < best_movement)
            {
                best = target;
                best_alignment = alignment;
                best_movement = movement;
            }
        }
        if best == q[0]
            || best_alignment - cos(q[0] - ray) <= Self::lexical_tolerance(primary_error)
        {
            return None;
        }
        Some(best)
    }

    // arm-path.ts ArmStepSolver.polePrimaryGradient
    //
    // Four pure FK probes estimate only the primary tangent at the lift pole.
    fn pole_primary_gradient(&mut self, state: usize, context: &ArmForwardContext) -> bool {
        let half = DIFFERENCE_SCALE;
        let positive_l = self.pole_probe(state, context, 0.0, half, PROBE_PLUS);
        let negative_l = self.pole_probe(state, context, PI, half, PROBE_MINUS);
        if !(positive_l && negative_l) {
            return false;
        }
        let g_l = self.pole_derivative(half);

        let positive_f = self.pole_probe(state, context, PI / 2.0, half, PROBE_PLUS);
        let negative_f = self.pole_probe(state, context, (3.0 * PI) / 2.0, half, PROBE_MINUS);
        if !(positive_f && negative_f) {
            return false;
        }
        let g_f = self.pole_derivative(half);
        if !(g_l.is_finite() && g_f.is_finite()) {
            return false;
        }
        self.pole_gradient[0] = g_l;
        self.pole_gradient[1] = g_f;
        true
    }

    /// The TS `polePrimaryGradient`'s two identical loops: the residual-weighted central
    /// difference of the landmarks between the two probes.
    fn pole_derivative(&self, half: f64) -> f64 {
        let landmark_count = if self.request_has_palm {
            LANDMARKS
        } else {
            LANDMARKS - 1
        };
        let mut g = 0.0;
        for landmark in 0..landmark_count {
            for axis in 0..DIRECTION_COMPONENTS {
                let row = landmark * DIRECTION_COMPONENTS + axis;
                let derivative =
                    (self.landmark_component(&self.states[PROBE_PLUS].forward, landmark, axis)
                        - self.landmark_component(
                            &self.states[PROBE_MINUS].forward,
                            landmark,
                            axis,
                        ))
                        / (2.0 * half * self.span);
                g += derivative * self.residual[row];
            }
        }
        g
    }

    // arm-path.ts ArmStepSolver.poleProbe
    fn pole_probe(
        &mut self,
        state: usize,
        context: &ArmForwardContext,
        plane: f64,
        physical_elevation: f64,
        out: usize,
    ) -> bool {
        let ceiling = elevation_ceiling(plane, &self.calibration.joints.shoulder.elevation).max;
        if !(ceiling.is_finite() && ceiling > 0.0) {
            return false;
        }
        let q = self.states[state].q;
        let o = &mut self.states[out];
        o.q = q;
        o.q[0] = plane;
        o.q[1] = (PI * physical_elevation) / ceiling;
        if !o.q[1].is_finite() {
            return false;
        }
        configuration_from_q(&o.q, &mut o.configuration);
        forward_arm(&o.configuration, &self.calibration, context, &mut o.forward);
        #[cfg(test)]
        {
            let c = &self.states[out].configuration;
            self.trace
                .pole_probes
                .push((c.shoulder_plane, c.shoulder_lift));
        }
        true
    }

    // arm-path.ts ArmStepSolver.betterPoleGauge
    fn better_pole_gauge(&self, candidate: usize, current: usize, ray_plane: f64) -> bool {
        let (candidate, current) = (&self.states[candidate], &self.states[current]);
        let tolerance = Self::lexical_tolerance(current.primary_error);
        if candidate.max_violation < current.max_violation - self.roundoff_tolerance {
            return true;
        }
        if candidate.max_violation > current.max_violation + self.roundoff_tolerance {
            return false;
        }
        if candidate.primary_error < current.primary_error - tolerance {
            return true;
        }
        if candidate.primary_error > current.primary_error + tolerance {
            return false;
        }
        if candidate.secondary_error < current.secondary_error - tolerance {
            return true;
        }
        if candidate.secondary_error > current.secondary_error + tolerance {
            return false;
        }
        cos(candidate.q[0] - ray_plane) > cos(current.q[0] - ray_plane) + tolerance
    }

    // arm-path.ts ArmStepSolver.linearize
    fn linearize(
        &mut self,
        state: usize,
        context: &ArmForwardContext,
        bounds: &ResolvedBounds,
    ) -> bool {
        self.measure_state(state);
        self.jacobian.fill(0.0);
        self.elbow_jacobian.fill(0.0);
        self.point_jacobian.fill(0.0);
        let q = self.states[state].q;
        let landmark_count = if self.request_has_palm {
            LANDMARKS
        } else {
            LANDMARKS - 1
        };
        for dof in 0..DOFS {
            let h = DIFFERENCE_SCALE * js_max(1.0, q[dof].abs());
            let can_minus = q[dof] - h >= bounds.lower[dof];
            let can_plus = q[dof] + h <= bounds.upper[dof];
            if !(can_minus || can_plus) {
                continue;
            }
            let use_minus = can_minus;
            let use_plus = can_plus;
            let low_q = if use_minus { q[dof] - h } else { q[dof] };
            let high_q = if use_plus { q[dof] + h } else { q[dof] };
            if high_q == low_q {
                continue;
            }
            self.states[PROBE_MINUS].q = q;
            self.states[PROBE_PLUS].q = q;
            self.states[PROBE_MINUS].q[dof] = low_q;
            self.states[PROBE_PLUS].q[dof] = high_q;
            if !self.evaluate_geometry(PROBE_MINUS, context, bounds) {
                continue;
            }
            if !self.evaluate_geometry(PROBE_PLUS, context, bounds) {
                continue;
            }
            let divisor = high_q - low_q;
            let (minus, plus) = (&self.states[PROBE_MINUS], &self.states[PROBE_PLUS]);
            for landmark in 0..landmark_count {
                for axis in 0..DIRECTION_COMPONENTS {
                    let minus_value = self.landmark_component(&minus.forward, landmark, axis);
                    let plus_value = self.landmark_component(&plus.forward, landmark, axis);
                    let index = (landmark * DIRECTION_COMPONENTS + axis) * DOFS + dof;
                    self.jacobian[index] = (plus_value - minus_value) / (divisor * self.span);
                }
            }
            let elbow_offset = dof;
            self.elbow_jacobian[elbow_offset] =
                (plus.forward.elbow.x - minus.forward.elbow.x) / (divisor * self.span);
            self.elbow_jacobian[DOFS + elbow_offset] =
                (plus.forward.elbow.y - minus.forward.elbow.y) / (divisor * self.span);
            self.elbow_jacobian[2 * DOFS + elbow_offset] =
                (plus.forward.elbow.z - minus.forward.elbow.z) / (divisor * self.span);
            for point_index in 0..self.states[state].points.len() {
                let minus = &self.states[PROBE_MINUS].points[point_index].position;
                let plus = &self.states[PROBE_PLUS].points[point_index].position;
                let offset = point_index * DIRECTION_COMPONENTS * DOFS + dof;
                self.point_jacobian[offset] = (plus.x - minus.x) / divisor;
                self.point_jacobian[offset + DOFS] = (plus.y - minus.y) / divisor;
                self.point_jacobian[offset + 2 * DOFS] = (plus.z - minus.z) / divisor;
            }
        }
        self.normal_matrix.fill(0.0);
        self.right_hand.fill(0.0);
        for row in 0..landmark_count * DIRECTION_COMPONENTS {
            let offset = row * DOFS;
            for i in 0..DOFS {
                let ji = self.jacobian[offset + i];
                self.right_hand[i] += ji * self.residual[row];
                for j in 0..DOFS {
                    self.normal_matrix[i * DOFS + j] += ji * self.jacobian[offset + j];
                }
            }
        }
        self.normal_matrix.iter().all(|v| v.is_finite())
            && self.right_hand.iter().all(|v| v.is_finite())
    }

    // arm-path.ts ArmStepSolver.linearizePenetration
    fn linearize_penetration(
        &mut self,
        state: usize,
        context: &ArmForwardContext,
        bounds: &ResolvedBounds,
    ) -> bool {
        self.point_jacobian.fill(0.0);
        let q = self.states[state].q;
        for dof in 0..DOFS {
            let h = DIFFERENCE_SCALE * js_max(1.0, q[dof].abs());
            let can_minus = q[dof] - h >= bounds.lower[dof];
            let can_plus = q[dof] + h <= bounds.upper[dof];
            if !(can_minus || can_plus) {
                continue;
            }
            let low_q = if can_minus { q[dof] - h } else { q[dof] };
            let high_q = if can_plus { q[dof] + h } else { q[dof] };
            if high_q == low_q {
                continue;
            }
            self.states[PROBE_MINUS].q = q;
            self.states[PROBE_PLUS].q = q;
            self.states[PROBE_MINUS].q[dof] = low_q;
            self.states[PROBE_PLUS].q[dof] = high_q;
            if !self.evaluate_geometry(PROBE_MINUS, context, bounds) {
                return false;
            }
            if !self.evaluate_geometry(PROBE_PLUS, context, bounds) {
                return false;
            }
            let divisor = high_q - low_q;
            for point_index in 0..self.states[state].points.len() {
                let minus = &self.states[PROBE_MINUS].points[point_index].position;
                let plus = &self.states[PROBE_PLUS].points[point_index].position;
                let offset = point_index * DIRECTION_COMPONENTS * DOFS + dof;
                self.point_jacobian[offset] = (plus.x - minus.x) / divisor;
                self.point_jacobian[offset + DOFS] = (plus.y - minus.y) / divisor;
                self.point_jacobian[offset + 2 * DOFS] = (plus.z - minus.z) / divisor;
            }
        }

        self.normal_matrix.fill(0.0);
        self.right_hand.fill(0.0);
        let s = &self.states[state];
        for clearance in &s.clearances {
            if !clearance.valid || clearance.distance >= 0.0 {
                continue;
            }
            let Some(point_index) = clearance.point_index.filter(|&p| p < s.points.len()) else {
                return false;
            };
            let row_offset = point_index * DIRECTION_COMPONENTS * DOFS;
            let residual = (clearance.distance - RESTORE_MARGIN) / self.span;
            let n = &clearance.normal;
            let pj = &self.point_jacobian;
            for i in 0..DOFS {
                let ji = (n.x * pj[row_offset + i]
                    + n.y * pj[row_offset + DOFS + i]
                    + n.z * pj[row_offset + 2 * DOFS + i])
                    / self.span;
                self.right_hand[i] -= ji * residual;
                for j in 0..DOFS {
                    let jj = (n.x * pj[row_offset + j]
                        + n.y * pj[row_offset + DOFS + j]
                        + n.z * pj[row_offset + 2 * DOFS + j])
                        / self.span;
                    self.normal_matrix[i * DOFS + j] += ji * jj;
                }
            }
        }
        self.normal_matrix.iter().all(|v| v.is_finite())
            && self.right_hand.iter().all(|v| v.is_finite())
    }

    // arm-path.ts ArmStepSolver.landmarkComponent
    fn landmark_component(&self, result: &ArmForwardResult, landmark: usize, axis: usize) -> f64 {
        let mut value = component(&result.wrist, axis);
        if landmark == 1 {
            value += self.hand_length * component(&result.h, axis);
        } else if landmark != 0 {
            value += self.hand_length * component(&result.palm, axis);
        }
        value
    }

    // arm-path.ts ArmStepSolver.initialDamping
    fn initial_damping(&self) -> f64 {
        let mut trace = 0.0;
        for i in 0..DOFS {
            trace += self.normal_matrix[i * DOFS + i];
        }
        js_max(trace / DOFS as f64, 1e-12) * 1e-4
    }

    // arm-path.ts ArmStepSolver.buildHessian
    fn build_hessian(&mut self, damping: f64) {
        self.hessian = self.normal_matrix;
        for i in 0..DOFS {
            self.hessian[i * DOFS + i] += damping;
        }
    }

    // arm-path.ts ArmStepSolver.makeConstrainedStep
    //
    // `unconstrained` is the TS argument of that name; the clearances are always the stepped
    // state's own, which the TS passes beside it.
    fn make_constrained_step(
        &mut self,
        state: usize,
        bounds: &ResolvedBounds,
        unconstrained: &[f64; DOFS],
        include_clearance_constraints: bool,
        nullspace: bool,
    ) -> bool {
        #[cfg(test)]
        {
            self.trace.qp_calls[self.trace.iteration] += 1;
        }
        self.last_qp_result = None;
        let q = self.states[state].q;
        let mut constraint_count = 0;
        for dof in 0..DOFS {
            let lower_offset = constraint_count * DOFS;
            constraint_count += 1;
            self.qp_a[lower_offset..lower_offset + DOFS].fill(0.0);
            self.qp_a[lower_offset + dof] = 1.0;
            self.qp_b[constraint_count - 1] = bounds.lower[dof] - q[dof];
            let upper_offset = constraint_count * DOFS;
            constraint_count += 1;
            self.qp_a[upper_offset..upper_offset + DOFS].fill(0.0);
            self.qp_a[upper_offset + dof] = -1.0;
            self.qp_b[constraint_count - 1] = q[dof] - bounds.upper[dof];
        }
        if include_clearance_constraints {
            let s = &self.states[state];
            for row in 0..s.clearances.len() {
                let clearance = &s.clearances[row];
                let forced = self.forced_rows[row];
                if !(clearance.valid || forced) {
                    continue;
                }
                let point_index = if forced {
                    self.forced_point_index[row]
                } else {
                    clearance.point_index
                };
                let Some(point_index) = point_index.filter(|&p| p < s.points.len()) else {
                    continue;
                };
                let displacement =
                    predicted_point_displacement(&self.point_jacobian, point_index, unconstrained);
                if !(nullspace || forced)
                    && clearance.distance
                        > clearance.normal.length() * displacement + self.roundoff_tolerance
                {
                    continue;
                }
                if constraint_count >= self.qp_capacity {
                    return false;
                }
                let offset = constraint_count * DOFS;
                let normal = if forced {
                    &self.forced_normals[row]
                } else {
                    &clearance.normal
                };
                for dof in 0..DOFS {
                    let jx = self.point_jacobian[point_index * 3 * DOFS + dof];
                    let jy = self.point_jacobian[(point_index * 3 + 1) * DOFS + dof];
                    let jz = self.point_jacobian[(point_index * 3 + 2) * DOFS + dof];
                    self.qp_a[offset + dof] =
                        (normal.x * jx + normal.y * jy + normal.z * jz) / self.span;
                }
                let distance = if forced {
                    let mut scratch = Vec3::default();
                    scratch.sub_vectors(&s.points[point_index].position, &self.forced_points[row]);
                    self.forced_distance[row] + normal.dot(&scratch)
                } else {
                    clearance.distance
                };
                self.qp_b[constraint_count] = -distance / self.span;
                constraint_count += 1;
            }
        }
        for constraint in 0..constraint_count {
            let a_offset = constraint * DOFS;
            if nullspace {
                self.qp_b[constraint] -= dot_row(&self.qp_a, constraint, &self.primary_delta, 0);
                self.secondary_vector
                    .copy_from_slice(&self.qp_a[a_offset..a_offset + DOFS]);
                project_to_primary_nullspace(
                    &self.row_basis,
                    self.primary_basis_count,
                    &mut self.secondary_vector,
                    0,
                );
                if !solve_linear(
                    &mut self.cholesky,
                    &mut self.solve_scratch,
                    &self.hessian,
                    &self.secondary_vector,
                    &mut self.qp_z,
                    0,
                    a_offset,
                ) {
                    return false;
                }
                project_to_primary_nullspace(
                    &self.row_basis,
                    self.primary_basis_count,
                    &mut self.qp_z,
                    a_offset,
                );
            } else if !solve_linear(
                &mut self.cholesky,
                &mut self.solve_scratch,
                &self.hessian,
                &self.qp_a,
                &mut self.qp_z,
                a_offset,
                a_offset,
            ) {
                return false;
            }
            let denominator = dot_row(&self.qp_a, constraint, &self.qp_z, a_offset);
            if !(denominator > 1e-16) && self.qp_b[constraint] > CONSTRAINT_EPSILON {
                return false;
            }
        }
        let result = solve_dual_active_set(
            &self.qp_a,
            &self.qp_b,
            &self.qp_z,
            constraint_count,
            unconstrained,
            &mut self.qp_delta,
            &mut self.qp_lambda,
            &mut self.qp_scratch,
        );
        #[cfg(test)]
        {
            self.trace.qp_results[result as usize] += 1;
        }
        if result != QpResult::Optimal {
            self.last_qp_result = Some(result);
            return false;
        }
        if nullspace {
            project_to_primary_nullspace(
                &self.row_basis,
                self.primary_basis_count,
                &mut self.qp_delta,
                0,
            );
        }
        for constraint in 0..constraint_count {
            if dot_row(&self.qp_a, constraint, &self.qp_delta, 0)
                < self.qp_b[constraint] - CONSTRAINT_EPSILON
            {
                return false;
            }
        }
        for dof in 0..DOFS {
            let endpoint = q[dof]
                + self.qp_delta[dof]
                + if nullspace {
                    self.primary_delta[dof]
                } else {
                    0.0
                };
            if !endpoint.is_finite() {
                return false;
            }
            let bounded = js_max(bounds.lower[dof], js_min(bounds.upper[dof], endpoint));
            if (bounded - endpoint).abs() > CONSTRAINT_EPSILON {
                return false;
            }
            // Clamping individual coordinates would leave the primary nullspace.
            if !nullspace {
                self.qp_delta[dof] = bounded - q[dof];
            }
        }
        for constraint in 0..constraint_count {
            if dot_row(&self.qp_a, constraint, &self.qp_delta, 0)
                < self.qp_b[constraint] - CONSTRAINT_EPSILON
            {
                return false;
            }
        }
        if !self.qp_delta.iter().all(|v| v.is_finite()) {
            return false;
        }
        self.last_step_temporal = false;
        for dof in 0..DOFS {
            if self.last_step_temporal {
                break;
            }
            self.last_step_temporal = (bounds.lower_temporal[dof] && self.qp_lambda[2 * dof] > 0.0)
                || (bounds.upper_temporal[dof] && self.qp_lambda[2 * dof + 1] > 0.0);
        }
        #[cfg(test)]
        {
            self.trace.temporal_steps += usize::from(self.last_step_temporal);
        }
        self.last_qp_result = Some(QpResult::Optimal);
        true
    }

    // arm-path.ts ArmStepSolver.rememberFailedRows
    fn remember_failed_rows(&mut self, state: usize) {
        let s = &self.states[state];
        for i in 0..s.clearances.len() {
            let row = &s.clearances[i];
            if !row.valid || row.distance >= -self.roundoff_tolerance {
                continue;
            }
            self.forced_rows[i] = true;
            self.forced_distance[i] = row.distance;
            self.forced_normals[i].copy(&row.normal);
            self.forced_point_index[i] = row.point_index;
            let point = row.point_index.expect("a sampled row names its point");
            self.forced_points[i].copy(&s.points[point].position);
            self.new_forced_rows = true;
        }
    }

    // arm-path.ts ArmStepSolver.prepareSweep
    fn prepare_sweep(
        &mut self,
        start: usize,
        end: usize,
        context: &ArmForwardContext,
        bounds: &ResolvedBounds,
        query_budget: isize,
    ) -> bool {
        self.prepared_sweep_count = 0;
        if query_budget < 1 {
            return false;
        }
        let (start_q, end_q) = (self.states[start].q, self.states[end].q);
        for quarter in 0..3 {
            let fraction = (quarter + 1) as f64 / 4.0;
            let state = QUARTER + quarter;
            if !Self::interpolate_sweep_q(
                &mut self.states[state].q,
                &start_q,
                &end_q,
                fraction,
                bounds,
            ) {
                return false;
            }
            if !self.evaluate_geometry(state, context, bounds) {
                return false;
            }
            if !self.remember_sweep_fraction(fraction, query_budget) {
                return false;
            }
        }
        for interval in 0..4 {
            let a = if interval == 0 {
                start
            } else {
                QUARTER + interval - 1
            };
            let b = if interval == 3 {
                end
            } else {
                QUARTER + interval
            };
            if !self.prepare_sweep_interval(
                start,
                end,
                a,
                b,
                interval as f64 / 4.0,
                (interval + 1) as f64 / 4.0,
                0,
                context,
                bounds,
                query_budget,
            ) {
                return false;
            }
        }
        true
    }

    // arm-path.ts ArmStepSolver.prepareSweepInterval
    //
    // Adaptive FK sampling at a fixed proxy resolution; this is not exact mesh CCD.
    #[allow(clippy::too_many_arguments)]
    fn prepare_sweep_interval(
        &mut self,
        full_start: usize,
        full_end: usize,
        a: usize,
        b: usize,
        a_fraction: f64,
        b_fraction: f64,
        depth: usize,
        context: &ArmForwardContext,
        bounds: &ResolvedBounds,
        query_budget: isize,
    ) -> bool {
        if self.max_point_travel(a, b) <= self.resolution {
            return true;
        }
        if depth >= MAX_SWEEP_DEPTH {
            return false;
        }
        let middle = RECURSIVE + depth;
        let middle_fraction = (a_fraction + b_fraction) / 2.0;
        let (start_q, end_q) = (self.states[full_start].q, self.states[full_end].q);
        if !Self::interpolate_sweep_q(
            &mut self.states[middle].q,
            &start_q,
            &end_q,
            middle_fraction,
            bounds,
        ) {
            return false;
        }
        if !self.evaluate_geometry(middle, context, bounds) {
            return false;
        }
        if !self.remember_sweep_fraction(middle_fraction, query_budget) {
            return false;
        }
        self.prepare_sweep_interval(
            full_start,
            full_end,
            a,
            middle,
            a_fraction,
            middle_fraction,
            depth + 1,
            context,
            bounds,
            query_budget,
        ) && self.prepare_sweep_interval(
            full_start,
            full_end,
            middle,
            b,
            middle_fraction,
            b_fraction,
            depth + 1,
            context,
            bounds,
            query_budget,
        )
    }

    // arm-path.ts ArmStepSolver.rememberSweepFraction
    fn remember_sweep_fraction(&mut self, fraction: f64, query_budget: isize) -> bool {
        if self.prepared_sweep_count >= self.prepared_sweep_fractions.len() {
            return false;
        }
        self.prepared_sweep_fractions[self.prepared_sweep_count] = fraction;
        self.prepared_sweep_count += 1;
        // One additional query is reserved for the candidate endpoint itself.
        (self.prepared_sweep_count + 1) as isize <= query_budget
    }

    // arm-path.ts ArmStepSolver.interpolateSweepQ
    fn interpolate_sweep_q(
        out: &mut [f64; DOFS],
        start: &[f64; DOFS],
        end: &[f64; DOFS],
        fraction: f64,
        bounds: &ResolvedBounds,
    ) -> bool {
        for dof in 0..DOFS {
            let raw = start[dof] + (end[dof] - start[dof]) * fraction;
            if !raw.is_finite() {
                return false;
            }
            let bounded = js_max(bounds.lower[dof], js_min(bounds.upper[dof], raw));
            if (bounded - raw).abs() > CONSTRAINT_EPSILON {
                return false;
            }
            out[dof] = bounded;
        }
        true
    }

    // arm-path.ts ArmStepSolver.validatePreparedSweep
    //
    // Replay the exact geometry-only fraction list with actual environment queries.
    fn validate_prepared_sweep(
        &mut self,
        end: usize,
        context: &ArmForwardContext,
        bounds: &ResolvedBounds,
        environment: &mut dyn ArmPathEnvironment,
        query_ceiling: usize,
    ) -> bool {
        if environment.row_count() == 0 {
            return true;
        }
        let sample = QUARTER;
        for i in 0..self.prepared_sweep_count {
            let (start_q, end_q) = (self.states[ORIGINAL_START].q, self.states[end].q);
            if !Self::interpolate_sweep_q(
                &mut self.states[sample].q,
                &start_q,
                &end_q,
                self.prepared_sweep_fractions[i],
                bounds,
            ) {
                return false;
            }
            if !self.evaluate_geometry(sample, context, bounds) {
                return false;
            }
            if !self.sample_clearances(sample, environment, query_ceiling) {
                return false;
            }
            self.measure_state(sample);
            if self.states[sample].max_violation > self.roundoff_tolerance {
                self.remember_failed_rows(sample);
                return false;
            }
        }
        true
    }

    // arm-path.ts ArmStepSolver.lineTrialQueryCeiling
    fn line_trial_query_ceiling(&self, line_candidates_used: usize) -> usize {
        if line_candidates_used >= MAX_LINE_SEARCHES {
            return self.environment_batches;
        }
        let remaining_trials = MAX_LINE_SEARCHES - line_candidates_used;
        self.environment_batches
            + (MAX_ENVIRONMENT_BATCHES - self.environment_batches) / remaining_trials
    }

    // arm-path.ts ArmStepSolver.minimumSweepBatches
    fn minimum_sweep_batches(&self, start: usize, end: usize) -> f64 {
        let travel = self.max_point_travel(start, end);
        if !travel.is_finite() {
            return f64::INFINITY;
        }
        js_max(4.0, (travel / self.resolution).ceil())
    }

    // arm-path.ts ArmStepSolver.maxPointTravel
    fn max_point_travel(&self, a: usize, b: usize) -> f64 {
        let (a, b) = (&self.states[a], &self.states[b]);
        let mut max = 0.0;
        for i in 0..a.points.len() {
            max = js_max(max, a.points[i].position.distance_to(&b.points[i].position));
        }
        max
    }

    // arm-path.ts ArmStepSolver.makeSecondaryStep
    fn make_secondary_step(&mut self, state: usize, bounds: &ResolvedBounds) -> bool {
        if !self.request_has_elbow {
            return false;
        }
        let row_count = if self.request_has_palm { 9 } else { 6 };
        let mut basis_count = 0;
        self.row_basis.fill(0.0);
        let mut largest: f64 = 0.0;
        for row in 0..row_count {
            let mut norm = 0.0;
            for dof in 0..DOFS {
                let entry = self.jacobian[row * DOFS + dof];
                norm += entry * entry;
            }
            largest = js_max(largest, sqrt(norm));
        }
        let threshold = DIFFERENCE_SCALE * largest;
        self.primary_rank_threshold = threshold;
        for row in 0..row_count {
            for dof in 0..DOFS {
                self.secondary_vector[dof] = self.jacobian[row * DOFS + dof];
            }
            for _pass in 0..2 {
                for basis_index in 0..basis_count {
                    let offset = basis_index * DOFS;
                    let mut projection = 0.0;
                    for dof in 0..DOFS {
                        projection += self.secondary_vector[dof] * self.row_basis[offset + dof];
                    }
                    for dof in 0..DOFS {
                        self.secondary_vector[dof] -= projection * self.row_basis[offset + dof];
                    }
                }
            }
            let mut norm = 0.0;
            for dof in 0..DOFS {
                let entry = self.secondary_vector[dof];
                norm += entry * entry;
            }
            norm = sqrt(norm);
            if norm <= threshold {
                continue;
            }
            let offset = basis_count * DOFS;
            basis_count += 1;
            for dof in 0..DOFS {
                self.row_basis[offset + dof] = self.secondary_vector[dof] / norm;
            }
        }
        self.primary_basis_count = basis_count;
        if basis_count >= DOFS {
            return false;
        }

        self.projected_elbow_jacobian.fill(0.0);
        for axis in 0..DIRECTION_COMPONENTS {
            for dof in 0..DOFS {
                self.secondary_vector[dof] = self.elbow_jacobian[axis * DOFS + dof];
            }
            for basis_index in 0..basis_count {
                let offset = basis_index * DOFS;
                let mut projection = 0.0;
                for dof in 0..DOFS {
                    projection += self.secondary_vector[dof] * self.row_basis[offset + dof];
                }
                for dof in 0..DOFS {
                    self.secondary_vector[dof] -= projection * self.row_basis[offset + dof];
                }
            }
            self.projected_elbow_jacobian[axis * DOFS..axis * DOFS + DOFS]
                .copy_from_slice(&self.secondary_vector);
        }
        self.normal_matrix.fill(0.0);
        self.right_hand.fill(0.0);
        let elbow = self.states[state].forward.elbow;
        let elbow_error_x = (self.target_elbow.x - elbow.x) / self.span
            - dot_row(&self.elbow_jacobian, 0, &self.primary_delta, 0);
        let elbow_error_y = (self.target_elbow.y - elbow.y) / self.span
            - dot_row(&self.elbow_jacobian, 1, &self.primary_delta, 0);
        let elbow_error_z = (self.target_elbow.z - elbow.z) / self.span
            - dot_row(&self.elbow_jacobian, 2, &self.primary_delta, 0);
        let pj = &self.projected_elbow_jacobian;
        for i in 0..DOFS {
            for j in 0..DOFS {
                for axis in 0..DIRECTION_COMPONENTS {
                    self.normal_matrix[i * DOFS + j] += pj[axis * DOFS + i] * pj[axis * DOFS + j];
                }
            }
            self.right_hand[i] = pj[i] * elbow_error_x
                + pj[DOFS + i] * elbow_error_y
                + pj[2 * DOFS + i] * elbow_error_z;
        }
        // The pole may not spend wrist deviation past the comfortable band the hand does not need.
        let excess = self.deviation_excess(self.states[state].q[6] + self.primary_delta[6]);
        if excess != 0.0 {
            let row = &mut self.comfort_row;
            row.fill(0.0);
            row[6] = 1.0;
            project_to_primary_nullspace(&self.row_basis, self.primary_basis_count, row, 0);
            for i in 0..DOFS {
                for j in 0..DOFS {
                    self.normal_matrix[i * DOFS + j] += DEVIATION_COMFORT_WEIGHT * row[i] * row[j];
                }
                self.right_hand[i] -= DEVIATION_COMFORT_WEIGHT * row[i] * excess;
            }
        }
        let mut trace = 0.0;
        for i in 0..DOFS {
            trace += self.normal_matrix[i * DOFS + i];
        }
        let damping = js_max(trace / DOFS as f64, 1e-12) * 1e-4;
        self.build_hessian(damping);
        project_to_primary_nullspace(
            &self.row_basis,
            self.primary_basis_count,
            &mut self.right_hand,
            0,
        );
        if !solve_linear(
            &mut self.cholesky,
            &mut self.solve_scratch,
            &self.hessian,
            &self.right_hand,
            &mut self.solved,
            0,
            0,
        ) {
            return false;
        }
        // A second projection removes small numerical leakage from the damped solve.
        project_to_primary_nullspace(
            &self.row_basis,
            self.primary_basis_count,
            &mut self.solved,
            0,
        );
        if self.solved.iter().all(|value| value.abs() < 1e-10) {
            return false;
        }
        let unconstrained = self.solved;
        if !self.make_constrained_step(state, bounds, &unconstrained, true, true) {
            return false;
        }
        let leakage = self.primary_rank_threshold * Self::step_norm(&self.qp_delta)
            + Self::lexical_tolerance(0.0);
        for row in 0..row_count {
            if dot_row(&self.jacobian, row, &self.qp_delta, 0).abs() > leakage {
                return false;
            }
        }
        for dof in 0..DOFS {
            self.qp_delta[dof] += self.primary_delta[dof];
        }
        self.qp_delta.iter().all(|v| v.is_finite())
    }

    // arm-path.ts ArmStepSolver.deviationExcess
    //
    // Signed radians `deviation` lies past its comfort aim, zero inside it.
    fn deviation_excess(&self, deviation: f64) -> f64 {
        let [free0, free1] = self.calibration.joints.wrist.deviation.free;
        let lower = free0 + DEVIATION_COMFORT_MARGIN;
        let upper = free1 - DEVIATION_COMFORT_MARGIN;
        if deviation < lower {
            return deviation - lower;
        }
        if deviation > upper {
            return deviation - upper;
        }
        0.0
    }

    // arm-path.ts ArmStepSolver.writeHierarchyCandidate
    fn write_hierarchy_candidate(
        &mut self,
        state: usize,
        context: &ArmForwardContext,
        bounds: &ResolvedBounds,
        alpha: f64,
        secondary: bool,
    ) -> bool {
        let (q, primary_delta) = (self.states[state].q, self.primary_delta);
        if !self.write_bounded_trial(&q, &primary_delta, alpha, bounds) {
            return false;
        }
        self.states[CANDIDATE].q = self.trial_q;
        if !secondary {
            return true;
        }
        let primary = PROBE_MINUS;
        let hierarchical = PROBE_PLUS;
        self.states[primary].q = self.trial_q;
        if !self.evaluate_geometry(primary, context, bounds) {
            return false;
        }
        let qp_delta = self.qp_delta;
        if self.write_bounded_trial(&q, &qp_delta, alpha, bounds) {
            self.states[hierarchical].q = self.trial_q;
            if self.evaluate_geometry(hierarchical, context, bounds) {
                let retracted = self.retract_elbow(primary, hierarchical, context, bounds);
                #[cfg(test)]
                {
                    self.trace
                        .note_retraction(&self.states, primary, CANDIDATE, retracted);
                }
                if retracted {
                    return true;
                }
            }
        }
        self.states[CANDIDATE].q = self.states[primary].q;
        true
    }

    // arm-path.ts ArmStepSolver.retractElbow
    //
    // A differential nullspace step has second-order hand error. Retract its elbow
    // onto the two-link circle of the primary step's achieved wrist, then preserve
    // that step's achieved hand frame. The linear clearance rows guide the proposal;
    // actual endpoint and original-start sweep queries still decide acceptance.
    fn retract_elbow(
        &mut self,
        primary: usize,
        hierarchical: usize,
        context: &ArmForwardContext,
        bounds: &ResolvedBounds,
    ) -> bool {
        let primary_forward = self.states[primary].forward;
        let mut n = Vec3::default();
        n.sub_vectors(&primary_forward.wrist, &context.shoulder);
        let d = n.length();
        if !(d > self.roundoff_tolerance) {
            return false;
        }
        n.multiply_scalar(1.0 / d);
        let mut center = Vec3::default();
        center.copy(&context.shoulder).add_scaled_vector(
            &n,
            (context.upper_length * context.upper_length
                - context.lower_length * context.lower_length
                + d * d)
                / (2.0 * d),
        );
        let radius = primary_forward.elbow.distance_to(&center);
        if !(radius > self.roundoff_tolerance) {
            return false;
        }
        let mut elbow = Vec3::default();
        elbow.sub_vectors(&self.states[hierarchical].forward.elbow, &center);
        let along = -elbow.dot(&n);
        elbow.add_scaled_vector(&n, along);
        let projected_radius = elbow.length();
        if !(projected_radius > self.roundoff_tolerance) {
            return false;
        }
        elbow
            .multiply_scalar(radius / projected_radius)
            .add(&center);
        let mut directions = ArmDirections::default();
        directions.upper_arm.sub_vectors(&elbow, &context.shoulder);
        directions
            .lower_arm
            .sub_vectors(&primary_forward.wrist, &elbow);
        directions.hand.copy(&primary_forward.h);
        let primary_elbow_flex = self.states[primary].q[3];
        let (previous, candidate) = pair(&mut self.states, hierarchical, CANDIDATE);
        if !configuration_of_directions(
            &directions,
            if self.request_has_palm {
                Some(&primary_forward.palm)
            } else {
                None
            },
            &self.calibration,
            context,
            Some(&previous.configuration),
            &mut candidate.configuration,
        ) {
            return false;
        }
        let configuration = candidate.configuration;
        let q = &mut candidate.q;
        q[0] = configuration.shoulder_plane;
        q[1] = configuration.shoulder_lift * PI;
        q[2] = configuration.humeral_rotation;
        // Fixed wrist distance and link lengths fix unsigned elbow flex exactly.
        // Reusing it avoids an acos round trip crossing an active bound by roundoff.
        q[3] = primary_elbow_flex;
        q[4] = configuration.forearm_roll;
        q[5] = configuration.wrist_flex;
        q[6] = configuration.wrist_dev;
        // Never clamp an inverse result: it would undo the hand-preserving retraction.
        if !self.evaluate_geometry(CANDIDATE, context, bounds) {
            return false;
        }
        let achieved = &self.states[CANDIDATE].forward;
        if achieved.wrist.distance_to(&primary_forward.wrist)
            > SETTLED_POSITION_FRACTION * self.span
            || acos(clamp(achieved.h.dot(&primary_forward.h), -1.0, 1.0)) > SETTLED_ORIENTATION
            || (self.request_has_palm
                && acos(clamp(achieved.palm.dot(&primary_forward.palm), -1.0, 1.0))
                    > SETTLED_ORIENTATION)
        {
            return false;
        }
        self.measure_state(primary);
        self.measure_state(CANDIDATE);
        let (primary, candidate) = (&self.states[primary], &self.states[CANDIDATE]);
        let tolerance = Self::lexical_tolerance(primary.primary_error);
        candidate.primary_error <= primary.primary_error + tolerance
            && candidate.secondary_error < primary.secondary_error - tolerance
    }

    // arm-path.ts ArmStepSolver.better
    fn better(&self, candidate: usize, current: usize) -> bool {
        let (candidate, current) = (&self.states[candidate], &self.states[current]);
        let tolerance = Self::lexical_tolerance(current.primary_error);
        if candidate.max_violation < current.max_violation - self.roundoff_tolerance {
            return true;
        }
        if candidate.max_violation > current.max_violation + self.roundoff_tolerance {
            return false;
        }
        if candidate.primary_error < current.primary_error - tolerance {
            return true;
        }
        if candidate.primary_error > current.primary_error + tolerance {
            return false;
        }
        // Below the tolerance but above settled is a band no step could leave.
        if self.primary_settled(candidate) && !self.primary_settled(current) {
            return true;
        }
        if candidate.secondary_error < current.secondary_error - tolerance {
            return true;
        }
        if candidate.secondary_error > current.secondary_error + tolerance {
            return false;
        }
        Self::configuration_displacement(&candidate.q, &self.start_q)
            < Self::configuration_displacement(&current.q, &self.start_q) - tolerance
    }

    // arm-path.ts ArmStepSolver.improvesPenetration
    fn improves_penetration(&self, candidate: usize, current: usize) -> bool {
        let (candidate, current) = (&self.states[candidate], &self.states[current]);
        if candidate.max_violation < current.max_violation - self.roundoff_tolerance {
            return true;
        }
        if candidate.max_violation > current.max_violation + self.roundoff_tolerance {
            return false;
        }
        let sum_tolerance = 64.0
            * f64::EPSILON
            * js_max(
                js_max(1.0, candidate.penetration_square_sum),
                current.penetration_square_sum,
            );
        candidate.penetration_square_sum < current.penetration_square_sum - sum_tolerance
    }

    // arm-path.ts ArmStepSolver.lexicalTolerance
    fn lexical_tolerance(primary: f64) -> f64 {
        LEXICAL_EPSILON * js_max(1.0, primary)
    }

    // arm-path.ts ArmStepSolver.configurationDisplacement
    fn configuration_displacement(a: &[f64; DOFS], b: &[f64; DOFS]) -> f64 {
        let mut result = 0.0;
        for i in 0..DOFS {
            let delta = a[i] - b[i];
            result += delta * delta;
        }
        result
    }

    // arm-path.ts ArmStepSolver.isSettled
    fn is_settled(&self, state: usize) -> bool {
        let s = &self.states[state];
        self.primary_settled(s)
            && (!self.request_has_elbow
                || s.secondary_error <= SETTLED_POSITION_FRACTION * SETTLED_POSITION_FRACTION)
    }

    // arm-path.ts ArmStepSolver.isPrimarySettled
    fn is_primary_settled(&self, state: usize) -> bool {
        self.primary_settled(&self.states[state])
    }

    /// `isPrimarySettled` on a state already borrowed.
    fn primary_settled(&self, state: &PathState) -> bool {
        state.position_error <= SETTLED_POSITION_FRACTION * self.span
            && state.orientation_error <= SETTLED_ORIENTATION
    }

    // arm-path.ts ArmStepSolver.predictedDescent
    //
    // Descent the damped GN model predicts for `step`: gᵀδ − ½δᵀHδ.
    fn predicted_descent(&self, step: &[f64; DOFS]) -> f64 {
        let mut result = 0.0;
        for i in 0..DOFS {
            let mut curvature = 0.0;
            for j in 0..DOFS {
                curvature += self.hessian[i * DOFS + j] * step[j];
            }
            result += step[i] * (self.right_hand[i] - 0.5 * curvature);
        }
        result
    }

    // arm-path.ts ArmStepSolver.stepNorm
    fn step_norm(step: &[f64; DOFS]) -> f64 {
        let mut sum = 0.0;
        for i in 0..DOFS {
            sum += step[i] * step[i];
        }
        sqrt(sum)
    }

    // arm-path.ts ArmStepSolver.copyState
    fn copy_state(&mut self, source: usize, target: usize) {
        let (source, target) = pair(&mut self.states, source, target);
        target.q = source.q;
        target.configuration = source.configuration;
        copy_forward(&source.forward, &mut target.forward);
        for i in 0..source.points.len() {
            target.points[i].position.copy(&source.points[i].position);
        }
        for i in 0..source.clearances.len() {
            target.clearances[i] = source.clearances[i];
        }
        target.primary_error = source.primary_error;
        target.secondary_error = source.secondary_error;
        target.position_error = source.position_error;
        target.orientation_error = source.orientation_error;
        target.max_violation = source.max_violation;
        target.penetration_square_sum = source.penetration_square_sum;
    }

    // arm-path.ts ArmStepSolver.copyToOutput
    fn copy_to_output(&self, source: usize, out: &mut ArmPathPlanOutput, status: ArmPathStatus) {
        let source = &self.states[source];
        out.q = source.q;
        configuration_from_q(&out.q, &mut out.configuration);
        copy_forward(&source.forward, &mut out.forward);
        for i in 0..source.points.len() {
            out.points[i].position.copy(&source.points[i].position);
        }
        for i in 0..source.clearances.len() {
            out.clearances[i] = source.clearances[i];
        }
        out.status = status;
        out.position_error = source.position_error;
        out.orientation_error = source.orientation_error;
        out.secondary_error = source.secondary_error;
        out.max_violation = source.max_violation;
        out.environment_batches = self.environment_batches;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the TS tests observe by spying on the solver's private methods, recorded where those
    /// methods run.
    #[derive(Default)]
    pub(super) struct Trace {
        /// The TS `output.iterations` while a call runs: 0 outside the plan loop.
        pub iteration: usize,
        pub certificates: Vec<Certificate>,
        pub retractions: Vec<Retraction>,
        pub qp_calls: [usize; MAX_ITERATIONS + 1],
        pub candidates: [usize; MAX_ITERATIONS + 1],
        pub pole_probes: Vec<(f64, f64)>,
        pub accepted_lines: [usize; MAX_LINE_SEARCHES],
        pub push_clears: usize,
        pub row_layouts: usize,
        pub qp_results: [usize; 3],
        pub temporal_steps: usize,
        pub gauge_moves: usize,
    }

    /// A `certifyCurrent` that had work to do.
    #[derive(Clone, Debug)]
    pub(super) struct Certificate {
        pub attempted: [f64; DOFS],
        pub checkpoint: [f64; DOFS],
        pub returned: [f64; DOFS],
        pub certified: bool,
        pub settled: bool,
        pub iteration: usize,
    }

    impl Certificate {
        pub fn before(solver: &ArmStepSolver) -> Certificate {
            Certificate {
                attempted: solver.states[CURRENT].q,
                checkpoint: solver.states[CERTIFIED_CHECKPOINT].q,
                returned: [0.0; DOFS],
                certified: false,
                settled: solver.is_settled(CURRENT),
                iteration: solver.trace.iteration,
            }
        }

        pub fn after(mut self, solver: &mut ArmStepSolver, certified: bool) {
            self.returned = solver.states[CURRENT].q;
            self.certified = certified;
            solver.trace.certificates.push(self);
        }
    }

    /// A `retractElbow`, measured against its primary state as `observeHierarchy` does.
    #[derive(Clone, Copy, Debug)]
    pub(super) struct Retraction {
        pub accepted: bool,
        pub primary_change: f64,
        pub elbow_improvement: f64,
        pub wrist_movement: f64,
        pub hand_movement: f64,
        pub palm_movement: f64,
    }

    impl Trace {
        pub fn note_retraction(
            &mut self,
            states: &[PathState],
            primary: usize,
            candidate: usize,
            accepted: bool,
        ) {
            let (p, c) = (&states[primary], &states[candidate]);
            self.retractions.push(Retraction {
                accepted,
                primary_change: c.primary_error - p.primary_error,
                elbow_improvement: p.secondary_error - c.secondary_error,
                wrist_movement: c.forward.wrist.distance_to(&p.forward.wrist),
                hand_movement: c.forward.h.distance_to(&p.forward.h),
                palm_movement: c.forward.palm.distance_to(&p.forward.palm),
            });
        }
    }

    // --- the recorded battery ------------------------------------------------------------------

    use super::super::plan::make_arm_path_plan_output;
    use crate::anatomy::joints::JointTable;
    use crate::corpus_replay::Corpus;
    use crate::math::Quat;
    use crate::profile::{Finger, Side};
    use crate::rig::arm_configuration::{BoneCalibration, HandCalibration, UpperCalibration};
    use crate::rig::hand_geometry::{FingerJointPath, FingerPointPath};
    use crate::rig::hands::FingerSpec;
    use crate::rig::testkit::fnv_f64s;
    use std::collections::HashMap;

    /// A slot's recorded key and point.
    type Layout = (Option<ClearanceKey>, Option<usize>);

    /// A battery file's stream, read front to back.
    struct Stream<'a> {
        values: &'a [f64],
        at: usize,
    }

    impl<'a> Stream<'a> {
        fn done(&self) -> bool {
            self.at == self.values.len()
        }

        fn f64(&mut self) -> f64 {
            let v = self.values[self.at];
            self.at += 1;
            v
        }

        fn take(&mut self, n: usize) -> &'a [f64] {
            let v = &self.values[self.at..self.at + n];
            self.at += n;
            v
        }

        fn index(&mut self) -> usize {
            let v = self.f64();
            assert!(v >= 0.0 && v.fract() == 0.0, "{v} is not an index");
            v as usize
        }

        /// A TS index that may be `-1` for none.
        fn index_or_none(&mut self) -> Option<usize> {
            let v = self.f64();
            (v >= 0.0).then_some(v as usize)
        }

        fn flag(&mut self) -> bool {
            self.f64() == 1.0
        }

        fn vec3(&mut self) -> Vec3 {
            let v = self.take(3);
            Vec3::new(v[0], v[1], v[2])
        }

        fn quat(&mut self) -> Quat {
            let v = self.take(4);
            Quat::new(v[0], v[1], v[2], v[3])
        }

        fn q(&mut self) -> [f64; DOFS] {
            self.take(DOFS).try_into().expect("seven values")
        }

        fn opt_f64(&mut self) -> Option<f64> {
            self.flag().then(|| self.f64())
        }

        fn opt_vec3(&mut self) -> Option<Vec3> {
            self.flag().then(|| self.vec3())
        }

        fn spec(&mut self) -> FingerSpec {
            std::array::from_fn(|_| self.opt_f64())
        }
    }

    /// A solver definition: what it was built from.
    struct Definition {
        geometry: HandGeometryCalibration,
        solver: ArmStepSolver,
    }

    fn definition(s: &mut Stream) -> Definition {
        let hand_length = s.f64();
        let resolution = s.f64();
        let calibration = ArmCalibration {
            upper: UpperCalibration {
                axis: s.vec3(),
                rest: s.quat(),
                front: s.vec3(),
            },
            lower: BoneCalibration {
                axis: s.vec3(),
                rest: s.quat(),
            },
            hand: HandCalibration {
                axis: s.vec3(),
                rest: s.quat(),
                palm: s.vec3(),
            },
            radial_sign: s.f64(),
            joints: JointTable::human(),
        };
        let hand_present = s.opt_f64().map(|v| v == 1.0);
        let metric_scale = s.f64();
        let n = s.index();
        let points = (0..n)
            .map(|_| {
                let finger = Finger::ALL[s.index()];
                let joint_index = s.index();
                let tip = s.flag();
                let nodes = s.flag().then(|| {
                    let count = s.index();
                    (0..count)
                        .map(|_| FingerJointPath {
                            position: s.vec3(),
                            rest: s.quat(),
                            scale: s.vec3(),
                            curl_axis: s.opt_vec3(),
                            splay_axis: s.opt_vec3(),
                            joint_index: s.opt_f64().map(|v| v as usize),
                        })
                        .collect()
                });
                FingerPointPath {
                    finger,
                    joint_index,
                    tip,
                    nodes,
                    previous_point: s.opt_f64().map(|v| v as usize),
                    last_point: s.opt_f64().map(|v| v as usize),
                }
            })
            .collect();
        let geometry = HandGeometryCalibration {
            hand_present,
            metric_scale,
            joints: JointTable::human(),
            points,
        };
        let solver = ArmStepSolver::new(&calibration, &geometry, hand_length, resolution);
        Definition { geometry, solver }
    }

    /// One recorded row: its slot, and its key and point when they changed.
    struct Entry {
        slot: usize,
        layout: Option<Layout>,
        valid: bool,
        distance: f64,
        normal: Vec3,
    }

    struct Sample {
        hash: [f64; 2],
        entries: Vec<Entry>,
    }

    fn sample(s: &mut Stream) -> Sample {
        let hash = [s.f64(), s.f64()];
        let n = s.index();
        let entries = (0..n)
            .map(|_| {
                let tag = s.f64();
                let (slot, layout) = if tag < 0.0 {
                    let slot = (-tag) as usize - 1;
                    let key = s.index_or_none().map(|k| k as ClearanceKey);
                    (slot, Some((key, s.index_or_none())))
                } else {
                    (tag as usize, None)
                };
                Entry {
                    slot,
                    layout,
                    valid: s.flag(),
                    distance: s.f64(),
                    normal: s.vec3(),
                }
            })
            .collect();
        Sample { hash, entries }
    }

    fn halves(h: u64) -> [f64; 2] {
        [(h >> 32) as f64, (h & 0xffff_ffff) as f64]
    }

    fn points_hash(points: &[ArmPathPoint]) -> [f64; 2] {
        let flat: Vec<f64> = points
            .iter()
            .flat_map(|p| [p.position.x, p.position.y, p.position.z])
            .collect();
        halves(fnv_f64s(&flat))
    }

    fn rows_hash(rows: &[ArmPathClearance]) -> [f64; 2] {
        let flat: Vec<f64> = rows
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
        halves(fnv_f64s(&flat))
    }

    /// Answers each `sample` with the next recorded one, after checking it asks about the same
    /// points bit for bit.
    struct Recorded<'a> {
        rows: usize,
        samples: Vec<Sample>,
        next: usize,
        layout: &'a mut Vec<Layout>,
        at: String,
    }

    impl ArmPathEnvironment for Recorded<'_> {
        fn row_count(&self) -> usize {
            self.rows
        }

        fn sample(&mut self, points: &[ArmPathPoint], out: &mut [ArmPathClearance]) {
            let at = format!("{} sample {}", self.at, self.next);
            let recorded = self
                .samples
                .get(self.next)
                .unwrap_or_else(|| panic!("{at}: the TS made no such sample"));
            self.next += 1;
            assert_eq!(points_hash(points), recorded.hash, "{at}: points");
            if self.layout.len() != out.len() {
                *self.layout = vec![(None, None); out.len()];
            }
            for (slot, row) in out.iter_mut().enumerate() {
                *row = ArmPathClearance {
                    key: self.layout[slot].0,
                    point_index: self.layout[slot].1,
                    ..ArmPathClearance::default()
                };
            }
            for e in &recorded.entries {
                if let Some(layout) = e.layout {
                    self.layout[e.slot] = layout;
                    out[e.slot].key = layout.0;
                    out[e.slot].point_index = layout.1;
                }
                out[e.slot].valid = e.valid;
                out[e.slot].distance = e.distance;
                out[e.slot].normal = e.normal;
            }
        }
    }

    fn bits(values: &[f64]) -> Vec<u64> {
        values.iter().map(|v| v.to_bits()).collect()
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

    /// What one battery file exercised, summed over its calls and its solvers.
    #[derive(Default, Debug)]
    struct Coverage {
        plans: usize,
        restores: usize,
        statuses: [usize; 4],
        refused: usize,
        samples: usize,
        elbow: usize,
        no_elbow: usize,
        no_palm: usize,
        row_counts: Vec<usize>,
        push_clears: usize,
        row_layouts: usize,
        failed_certificates: usize,
        certificates: usize,
        accepted_retractions: usize,
        halvings: usize,
        gauge_moves: usize,
        temporal_steps: usize,
        qp_results: [usize; 3],
    }

    impl Coverage {
        fn add(&mut self, other: &Coverage) {
            self.plans += other.plans;
            self.restores += other.restores;
            for i in 0..4 {
                self.statuses[i] += other.statuses[i];
            }
            self.refused += other.refused;
            self.samples += other.samples;
            self.elbow += other.elbow;
            self.no_elbow += other.no_elbow;
            self.no_palm += other.no_palm;
            for &r in &other.row_counts {
                if !self.row_counts.contains(&r) {
                    self.row_counts.push(r);
                }
            }
            self.push_clears += other.push_clears;
            self.row_layouts += other.row_layouts;
            self.failed_certificates += other.failed_certificates;
            self.certificates += other.certificates;
            self.accepted_retractions += other.accepted_retractions;
            self.halvings += other.halvings;
            self.gauge_moves += other.gauge_moves;
            self.temporal_steps += other.temporal_steps;
            for i in 0..3 {
                self.qp_results[i] += other.qp_results[i];
            }
        }
    }

    /// Replay one battery file on one Rust solver per recorded definition, in recorded order.
    fn replay(name: &str) -> Coverage {
        let corpus = Corpus::load(name);
        let case = corpus.case(0);
        let mut s = Stream {
            values: case.output("stream"),
            at: 0,
        };
        let mut records = 0;
        let mut definitions: Vec<Definition> = Vec::new();
        let mut layouts: HashMap<usize, Vec<Layout>> = HashMap::new();
        let mut coverage = Coverage::default();
        let mut call = 0;
        while !s.done() {
            records += 1;
            let tag = s.index();
            if tag == 0 {
                let id = s.index();
                assert_eq!(id, definitions.len(), "{name}: definitions in order");
                definitions.push(definition(&mut s));
                continue;
            }
            let at = format!("{name} call {call}");
            let def = s.index();
            let request = ArmPathRequest {
                wrist: s.vec3(),
                hand: s.vec3(),
                palm: s.opt_vec3(),
                curls: s.spec(),
                spread: s.spec(),
                elbow: s.opt_vec3(),
            };
            let start = s.q();
            let context = ArmForwardContext {
                side: Side::BOTH[s.index()],
                shoulder: s.vec3(),
                upper_length: s.f64(),
                lower_length: s.f64(),
                up: s.vec3(),
                right: s.vec3(),
                forward: s.vec3(),
                upper_parent_world: s.quat(),
            };
            let bounds = ArmPathBounds {
                lower: s.q(),
                upper: s.q(),
            };
            let rows = s.index();
            let output_rows = s.index();
            let n = s.index();
            let samples: Vec<Sample> = (0..n).map(|_| sample(&mut s)).collect();
            let d = &mut definitions[def];
            let mut out = make_arm_path_plan_output(&d.geometry, output_rows);
            let mut environment = Recorded {
                rows,
                samples,
                next: 0,
                layout: layouts.entry(def).or_default(),
                at: at.clone(),
            };
            let returned = if tag == 1 {
                d.solver.plan(
                    &request,
                    &start,
                    &context,
                    &bounds,
                    &mut environment,
                    &mut out,
                );
                true
            } else {
                d.solver.restore_endpoint(
                    &request,
                    &start,
                    &context,
                    &bounds,
                    &mut environment,
                    &mut out,
                )
            };
            assert_eq!(environment.next, n, "{at}: samples taken");
            assert_eq!(returned, s.flag(), "{at}: returned");
            assert_eq!(bits(&out.q), bits(&s.q()), "{at}: q");
            let c = &out.configuration;
            let conf = [
                c.shoulder_plane,
                c.shoulder_lift,
                c.humeral_rotation,
                c.elbow_flex,
                c.forearm_roll,
                c.wrist_flex,
                c.wrist_dev,
            ];
            assert_eq!(bits(&conf), bits(&s.q()), "{at}: configuration");
            assert_eq!(
                bits(&forward_values(&out.forward)),
                bits(s.take(42)),
                "{at}: forward"
            );
            assert_eq!(out.status as usize, s.index(), "{at}: status");
            for (v, k) in [
                (out.position_error, "positionError"),
                (out.orientation_error, "orientationError"),
                (out.secondary_error, "secondaryError"),
                (out.max_violation, "maxViolation"),
            ] {
                assert_eq!(v.to_bits(), s.f64().to_bits(), "{at}: {k}");
            }
            assert_eq!(out.iterations, s.index(), "{at}: iterations");
            assert_eq!(out.environment_batches, s.index(), "{at}: batches");
            assert_eq!(points_hash(&out.points), [s.f64(), s.f64()], "{at}: points");
            assert_eq!(rows_hash(&out.clearances), [s.f64(), s.f64()], "{at}: rows");

            if tag == 1 {
                coverage.plans += 1;
                coverage.statuses[out.status as usize] += 1;
            } else {
                coverage.restores += 1;
                coverage.refused += usize::from(!returned);
            }
            coverage.samples += n;
            if request.elbow.is_some() {
                coverage.elbow += 1;
            } else {
                coverage.no_elbow += 1;
            }
            coverage.no_palm += usize::from(request.palm.is_none());
            if !coverage.row_counts.contains(&rows) {
                coverage.row_counts.push(rows);
            }
            call += 1;
        }
        assert_eq!(
            records as f64,
            case.scalar("records", false),
            "{name}: records"
        );
        for d in &definitions {
            let t = &d.solver.trace;
            coverage.push_clears += t.push_clears;
            coverage.row_layouts += t.row_layouts;
            coverage.certificates += t.certificates.len();
            coverage.failed_certificates += t.certificates.iter().filter(|c| !c.certified).count();
            coverage.accepted_retractions += t.retractions.iter().filter(|r| r.accepted).count();
            coverage.halvings += t.accepted_lines[1..].iter().sum::<usize>();
            coverage.gauge_moves += t.gauge_moves;
            coverage.temporal_steps += t.temporal_steps;
            for i in 0..3 {
                coverage.qp_results[i] += t.qp_results[i];
            }
        }
        coverage
    }

    const BATTERY: [&str; 5] = [
        "arm-path-solver-battery-a",
        "arm-path-solver-battery-b",
        "arm-path-solver-battery-c",
        "arm-path-solver-battery-d",
        "arm-path-solver-battery-e",
    ];

    /// `tests/corpora/arm-path-solver-battery-*`: every recorded call, with every sample the TS
    /// made, replayed bit for bit on one solver per definition; see the recorder's file comment.
    #[test]
    fn replays_the_solver_battery_bit_for_bit() {
        let mut total = Coverage::default();
        for name in BATTERY {
            let coverage = replay(name);
            eprintln!("{name}: {coverage:?}");
            total.add(&coverage);
        }
        eprintln!("battery: {total:?}");
        let c = &total;
        // Every status, and both answers of a restore.
        assert!(c.statuses.iter().all(|&n| n > 0), "{:?}", c.statuses);
        assert!(c.refused > 0 && c.restores > c.refused);
        // Elbow and palm requests both ways, several row counts on one solver.
        assert!(c.elbow > 0 && c.no_elbow > 0 && c.no_palm > 0);
        assert!(c.row_counts.len() > 3 && c.row_layouts > c.row_counts.len());
        // The steps a plan can take.
        for (n, what) in [
            (c.push_clears, "push clear"),
            (c.failed_certificates, "failed certificate"),
            (c.accepted_retractions, "accepted retraction"),
            (c.halvings, "accepted halving"),
            (c.gauge_moves, "gauge move"),
            (c.temporal_steps, "temporal step"),
            (c.qp_results[QpResult::Infeasible as usize], "infeasible QP"),
        ] {
            assert!(n > 0, "the battery has no {what}");
        }
    }

    // --- the properties of `tests/rig/arm-path.test.ts` ---------------------------------------

    use crate::math::f::{CBRT_EPSILON, EPSILON_2_3};
    use crate::profile::{ArmSlot, BoneSlot};
    use crate::rig::arm_configuration::{
        ArmCalibrationInput, ArmConfiguration, BoneCalibrationInput, HandCalibrationInput,
        UpperCalibrationInput, capture_arm_calibration,
    };
    use crate::rig::finger_axes::solve_finger_axes;
    use crate::rig::hand_geometry::capture_hand_geometry;
    use crate::rig::hands::EMPTY_SPEC;
    use crate::rig::testkit::{avatar, bone, rest_of, rest_table};
    use std::panic::{AssertUnwindSafe, catch_unwind};

    const HAND_PROXY: usize = TORSO_SAMPLES * 2 + 1;
    const UP: Vec3 = Vec3::new(0.0, 1.0, 0.0);
    const RIGHT: Vec3 = Vec3::new(1.0, 0.0, 0.0);
    const FORWARD: Vec3 = Vec3::new(0.0, 0.0, 1.0);

    /// An environment of `rows` rows filled by `fill`, given the 1-based sample count.
    struct Env<F> {
        rows: usize,
        calls: usize,
        fill: F,
    }

    impl<F: FnMut(usize, &[ArmPathPoint], &mut [ArmPathClearance])> ArmPathEnvironment for Env<F> {
        fn row_count(&self) -> usize {
            self.rows
        }

        fn sample(&mut self, points: &[ArmPathPoint], out: &mut [ArmPathClearance]) {
            self.calls += 1;
            (self.fill)(self.calls, points, out);
        }
    }

    fn env<F: FnMut(usize, &[ArmPathPoint], &mut [ArmPathClearance])>(
        rows: usize,
        fill: F,
    ) -> Env<F> {
        Env {
            rows,
            calls: 0,
            fill,
        }
    }

    fn free() -> Env<impl FnMut(usize, &[ArmPathPoint], &mut [ArmPathClearance])> {
        env(0, |_, _, _| {})
    }

    fn set_row(
        row: &mut ArmPathClearance,
        key: u32,
        point: usize,
        valid: bool,
        distance: f64,
        normal: Vec3,
    ) {
        *row = ArmPathClearance {
            key: Some(key),
            point_index: Some(point),
            valid,
            distance,
            normal,
        };
    }

    /// One valid row on `point`, with `field` giving its distance and normal at the point.
    fn row_env(
        key: u32,
        point: usize,
        mut field: impl FnMut(&Vec3) -> (f64, Vec3),
    ) -> Env<impl FnMut(usize, &[ArmPathPoint], &mut [ArmPathClearance])> {
        env(1, move |_, points, rows| {
            let (d, n) = field(&points[point].position);
            set_row(&mut rows[0], key, point, true, d, n);
        })
    }

    /// The plane `offset - p·axis`, its normal `-axis`.
    fn plane(
        point: usize,
        axis: Vec3,
        offset: f64,
    ) -> Env<impl FnMut(usize, &[ArmPathPoint], &mut [ArmPathClearance])> {
        row_env(0, point, move |p| (offset - p.dot(&axis), neg(axis)))
    }

    fn sphere(
        point: usize,
        center: Vec3,
        radius: f64,
    ) -> Env<impl FnMut(usize, &[ArmPathPoint], &mut [ArmPathClearance])> {
        row_env(0, point, move |p| sphere_row(p, &center, radius))
    }

    fn sphere_row(p: &Vec3, center: &Vec3, radius: f64) -> (f64, Vec3) {
        let mut n = sub(*p, *center);
        let d = n.length() - radius;
        if n.length_sq() < 1e-12 {
            n = UP;
        } else {
            n.normalize();
        }
        (d, n)
    }

    fn sub(a: Vec3, b: Vec3) -> Vec3 {
        let mut v = Vec3::default();
        v.sub_vectors(&a, &b);
        v
    }

    fn neg(mut v: Vec3) -> Vec3 {
        *v.negate()
    }

    fn unit(mut v: Vec3) -> Vec3 {
        *v.normalize()
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 5e-13
    }

    struct Fixture {
        calibration: ArmCalibration,
        context: ArmForwardContext,
        geometry: HandGeometryCalibration,
        hand_length: f64,
        solver: ArmStepSolver,
    }

    impl Fixture {
        fn new(side: Side, yaw: f64, scale: f64) -> Fixture {
            let identity = Quat::default();
            let joints = JointTable::human();
            let calibration = capture_arm_calibration(&ArmCalibrationInput {
                upper: UpperCalibrationInput {
                    axis: UP,
                    rest: identity,
                    front: FORWARD,
                },
                lower: BoneCalibrationInput {
                    axis: UP,
                    rest: identity,
                },
                hand: HandCalibrationInput {
                    axis: UP,
                    rest: identity,
                    palm: FORWARD,
                },
                radial_sign: if side == Side::L { -1.0 } else { 1.0 },
                joints: &joints,
            })
            .expect("the fixture calibrates");
            let mut rotation = Quat::default();
            rotation.set_from_axis_angle(&UP, yaw);
            let turn = |mut v: Vec3| *v.apply_quaternion(&rotation);
            let context = ArmForwardContext {
                side,
                shoulder: turn(Vec3::default()),
                upper_length: 0.31 * scale,
                lower_length: 0.27 * scale,
                up: turn(UP),
                right: turn(RIGHT),
                forward: turn(FORWARD),
                upper_parent_world: rotation,
            };
            // No finger chains is a valid captured hand shape for the numeric kernel.
            let geometry = HandGeometryCalibration {
                hand_present: None,
                metric_scale: scale,
                joints: JointTable::human(),
                points: Vec::new(),
            };
            Fixture::of(calibration, context, geometry, 0.1 * scale, 0.006 * scale)
        }

        fn of(
            calibration: ArmCalibration,
            context: ArmForwardContext,
            geometry: HandGeometryCalibration,
            hand_length: f64,
            resolution: f64,
        ) -> Fixture {
            let solver = ArmStepSolver::new(&calibration, &geometry, hand_length, resolution);
            Fixture {
                calibration,
                context,
                geometry,
                hand_length,
                solver,
            }
        }

        fn base() -> Fixture {
            Fixture::new(Side::R, 0.0, 1.0)
        }

        /// The base avatar's right hand in place of the empty one.
        fn fingers() -> Fixture {
            let h = Fixture::base();
            Fixture::of(
                h.calibration,
                h.context,
                finger_geometry(),
                h.hand_length,
                0.006,
            )
        }

        fn solver(&self, resolution: f64) -> ArmStepSolver {
            ArmStepSolver::new(
                &self.calibration,
                &self.geometry,
                self.hand_length,
                resolution,
            )
        }

        fn out(&self, rows: usize) -> ArmPathPlanOutput {
            make_arm_path_plan_output(&self.geometry, rows)
        }

        fn forward(&self, q: &[f64; DOFS]) -> ArmForwardResult {
            forward_of(&self.calibration, &self.context, q)
        }

        fn request_at(&self, q: &[f64; DOFS]) -> ArmPathRequest {
            let fk = self.forward(q);
            ArmPathRequest {
                wrist: fk.wrist,
                hand: fk.h,
                palm: Some(fk.palm),
                curls: EMPTY_SPEC,
                spread: EMPTY_SPEC,
                elbow: None,
            }
        }

        fn primary_error_at(&self, q: &[f64; DOFS], request: &ArmPathRequest) -> f64 {
            let r = self.forward(q);
            let hand = unit(request.hand);
            let l = self.hand_length;
            let at =
                |base: Vec3, dir: &Vec3| *Vec3::default().copy(&base).add_scaled_vector(dir, l);
            let mut sum = 0.0;
            let mut add = |e: f64| sum += e * e;
            add(r.wrist.distance_to(&request.wrist));
            add(at(r.wrist, &r.h).distance_to(&at(request.wrist, &hand)));
            if let Some(palm) = request.palm {
                let mut p = palm;
                p.add_scaled_vector(&hand, -palm.dot(&hand)).normalize();
                add(at(r.wrist, &r.palm).distance_to(&at(request.wrist, &p)));
            }
            sqrt(sum)
        }

        fn hand_proxy(&self, q: &[f64; DOFS]) -> Vec3 {
            let r = self.forward(q);
            let mut p = r.wrist;
            p.add_scaled_vector(
                &r.h,
                (self.hand_length * HAND_CONTACT) / TORSO_SAMPLES as f64,
            );
            p
        }

        fn plan(
            &mut self,
            request: &ArmPathRequest,
            start: &[f64; DOFS],
            bounds: &ArmPathBounds,
            environment: &mut dyn ArmPathEnvironment,
        ) -> ArmPathPlanOutput {
            let mut out = self.out(environment.row_count());
            self.solver
                .plan(request, start, &self.context, bounds, environment, &mut out);
            out
        }

        /// Every landmark and frame of `out` against FK of its own q.
        fn assert_exact(&self, out: &ArmPathPlanOutput, frames: f64) {
            let exact = self.forward(&out.q);
            let f = &out.forward;
            for (a, b) in [
                (f.wrist, exact.wrist),
                (f.elbow, exact.elbow),
                (f.u, exact.u),
                (f.l, exact.l),
                (f.h, exact.h),
                (f.palm, exact.palm),
            ] {
                assert!(a.distance_to(&b) < 1e-12);
            }
            for (a, b) in [
                (f.upper_world, exact.upper_world),
                (f.lower_world, exact.lower_world),
                (f.hand_world, exact.hand_world),
            ] {
                assert!(1.0 - a.dot(&b).abs() < frames);
            }
        }
    }

    fn forward_of(
        calibration: &ArmCalibration,
        context: &ArmForwardContext,
        q: &[f64; DOFS],
    ) -> ArmForwardResult {
        let mut c = ArmConfiguration::default();
        configuration_from_q(q, &mut c);
        let mut r = ArmForwardResult::default();
        forward_arm(&c, calibration, context, &mut r);
        r
    }

    fn finger_geometry() -> HandGeometryCalibration {
        let (mut graph, profile) = avatar();
        let rest = rest_table(&graph);
        let axes = solve_finger_axes(&profile, &mut graph);
        let hand = bone(&profile, BoneSlot::arm(ArmSlot::Hand, Side::R));
        let scale = graph.world_scale(hand).x;
        let joints = profile.anatomy.clone().unwrap_or_else(JointTable::human);
        let rest = rest_of(&rest);
        capture_hand_geometry(
            &profile,
            &graph,
            Side::R,
            &|i| Some(rest(i)),
            &axes,
            &joints,
            scale,
        )
    }

    /// The neutral 60 Hz trace: its fixture, request, bounds and start.
    fn neutral() -> (Fixture, ArmPathRequest, ArmPathBounds, [f64; DOFS]) {
        let identity = Quat::default();
        let calibration = ArmCalibration {
            upper: UpperCalibration {
                axis: RIGHT,
                rest: identity,
                front: Vec3::new(0.0, 0.0, -1.0),
            },
            lower: BoneCalibration {
                axis: RIGHT,
                rest: identity,
            },
            hand: HandCalibration {
                axis: RIGHT,
                rest: identity,
                palm: Vec3::new(0.0, -1.0, 0.0),
            },
            radial_sign: -1.0,
            joints: JointTable::human(),
        };
        let context = ArmForwardContext {
            side: Side::R,
            shoulder: Vec3::new(0.155901888668811, 1.1405163252064308, -0.006688540336977538),
            upper_length: 0.17,
            lower_length: 0.14999999999999997,
            up: UP,
            right: RIGHT,
            forward: Vec3::new(0.0, 0.0, -1.0),
            upper_parent_world: Quat::new(
                4.377774469290759e-19,
                0.03068963967145867,
                -0.1329884385763209,
                0.9906423275945099,
            ),
        };
        let h = Fixture::of(
            calibration,
            context,
            finger_geometry(),
            0.1187500000000001,
            0.0011250000000000001,
        );
        let request = ArmPathRequest {
            wrist: Vec3::new(
                0.23258893762054733,
                0.8375989149964106,
                -0.06958939001876399,
            ),
            hand: Vec3::new(
                0.1302542439055869,
                -0.9618774934566418,
                -0.24046937336416044,
            ),
            palm: Some(Vec3::new(
                -0.8799221644217047,
                -0.22391718724853235,
                0.419044243265706,
            )),
            curls: [
                Some(0.24745597271258368),
                Some(0.31225594371769966),
                Some(0.3759045026355887),
                Some(0.43840089115382835),
                Some(0.49974139671977874),
            ],
            spread: [
                Some(0.0),
                Some(-6.759174985994615e-10),
                Some(-3.1398130906790893e-10),
                Some(8.305082845022316e-12),
                Some(3.189180344303935e-10),
            ],
            elbow: Some(Vec3::new(
                0.2070761780500716,
                0.9801702184784808,
                -0.03056987538156583,
            )),
        };
        let w = 0.23333333333333334;
        let bounds = ArmPathBounds {
            lower: [-w, 1.3823428885128457, -w, 0.0, -w, -w, -w],
            upper: [w, 1.8490095551795125, w, w, w, w, w],
        };
        (
            h,
            request,
            bounds,
            [0.0, 1.615676221846179, 0.0, 0.0, 0.0, 0.0, 0.0],
        )
    }

    fn full_bounds() -> ArmPathBounds {
        let j = JointTable::human();
        ArmPathBounds {
            lower: [
                -PI,
                0.0,
                j.shoulder.rotation.max[0],
                j.elbow.flexion.max[0],
                j.elbow.rotation.max[0],
                j.wrist.flexion.max[0],
                j.wrist.deviation.max[0],
            ],
            upper: [
                PI,
                PI,
                j.shoulder.rotation.max[1],
                j.elbow.flexion.max[1],
                j.elbow.rotation.max[1],
                j.wrist.flexion.max[1],
                j.wrist.deviation.max[1],
            ],
        }
    }

    fn bounded_around(q: &[f64; DOFS], half_width: f64) -> ArmPathBounds {
        let full = full_bounds();
        ArmPathBounds {
            lower: std::array::from_fn(|i| js_max(full.lower[i], q[i] - half_width)),
            upper: std::array::from_fn(|i| js_min(full.upper[i], q[i] + half_width)),
        }
    }

    fn pole_q(plane: f64) -> [f64; DOFS] {
        [
            plane,
            0.0,
            0.8775014769549042,
            0.6286143089887103,
            -1.3097985816478976,
            0.29435979269206314,
            0.004239725810632073,
        ]
    }

    const POLE_PLANE: f64 = -1.0605277708708791;

    fn pole_bounds(q: &[f64; DOFS], half_width: f64) -> ArmPathBounds {
        let mut b = bounded_around(q, half_width);
        b.lower[0] = q[0] - half_width;
        b.upper[0] = q[0] + half_width;
        b
    }

    fn within(q: &[f64; DOFS], b: &ArmPathBounds) -> bool {
        (0..DOFS).all(|i| q[i] >= b.lower[i] && q[i] <= b.upper[i])
    }

    /// The straight q chord from `start` to `end` at `t`.
    fn chord(start: &[f64; DOFS], end: &[f64; DOFS], t: f64) -> [f64; DOFS] {
        std::array::from_fn(|i| start[i] + (end[i] - start[i]) * t)
    }

    fn moving(status: ArmPathStatus) -> bool {
        matches!(status, ArmPathStatus::Progress | ArmPathStatus::Settled)
    }

    fn safe_env(offset: f64) -> Env<impl FnMut(usize, &[ArmPathPoint], &mut [ArmPathClearance])> {
        row_env(0, HAND_PROXY, move |p| (p.y + offset, UP))
    }

    #[test]
    fn makes_bounded_progress_toward_a_feasible_fk_goal() {
        let mut h = Fixture::base();
        let start = [0.0, 0.0, 0.0, 0.2, 0.0, 0.0, 0.0];
        let goal = [0.42, 0.64, 0.35, 0.82, 0.28, 0.22, -0.13];
        let request = h.request_at(&goal);
        let bound = full_bounds();
        let out = h.plan(&request, &start, &bound, &mut free());
        assert!(moving(out.status));
        assert!(out.position_error < 0.12);
        assert!(out.iterations > 0);
        assert_ne!(out.q, start);
        assert!(within(&out.q, &bound));
    }

    #[test]
    fn makes_certified_progress_for_the_neutral_target_under_14_60_boxes() {
        let (mut h, request, bound, start) = neutral();
        let initial = h.primary_error_at(&start, &request);
        let mut e = safe_env(100.0);
        let out = h.plan(&request, &start, &bound, &mut e);
        assert!(moving(out.status));
        assert!(out.position_error < initial);
        assert_ne!(out.q, start);
        assert!(out.environment_batches <= 96);
        assert_eq!(e.calls, out.environment_batches);
        assert!(within(&out.q, &bound));
        h.assert_exact(&out, 1e-14);
        for sample in 0..=4096 {
            let q = chord(&start, &out.q, sample as f64 / 4096.0);
            assert!(within(&q, &bound));
            assert!(h.hand_proxy(&q).y + 100.0 >= 0.0);
        }
    }

    #[test]
    fn escapes_a_zero_lift_pole_before_continuing_toward_the_neutral_target() {
        let (mut h, request, _, _) = neutral();
        let start = pole_q(POLE_PLANE);
        let limit = pole_bounds(&start, 14.0 / 60.0);
        let initial = h.primary_error_at(&start, &request);
        let mut e = safe_env(100.0);
        let out = h.plan(&request, &start, &limit, &mut e);
        assert!(moving(out.status));
        assert!(out.q[1] > 0.0);
        assert!(out.position_error < initial);
        assert!(out.environment_batches <= 96);
        assert_eq!(e.calls, out.environment_batches);
        assert!(within(&out.q, &limit));
        h.assert_exact(&out, 1.0);
        for sample in 0..=4096 {
            let q = chord(&start, &out.q, sample as f64 / 4096.0);
            assert!(within(&q, &limit));
            assert!(h.hand_proxy(&q).y + 100.0 >= 0.0);
        }
    }

    #[test]
    fn finds_positive_lift_primary_descent_from_the_pole_plane() {
        for (side, plane) in [
            (Side::R, POLE_PLANE),
            (Side::R, POLE_PLANE + 2.0 * PI),
            (Side::L, POLE_PLANE),
        ] {
            let (mut h, request, _, _) = neutral();
            h.context.side = side;
            let start = pole_q(plane);
            let limit = pole_bounds(&start, 14.0 / 60.0);
            let initial = h.primary_error_at(&start, &request);
            let mut out = h.plan(&request, &start, &limit, &mut free());
            assert!(moving(out.status));
            assert_ne!(out.q[0], start[0]);
            assert!(out.position_error < initial);
            assert!(within(&out.q, &limit));
            // The first plan may end with the lift exactly on its stop; continuing from
            // its result must leave the pole with the error still falling.
            let mut error = out.position_error;
            for _ in 0..3 {
                if out.q[1] > 1e-3 {
                    break;
                }
                let from = out.q;
                let b = pole_bounds(&from, 14.0 / 60.0);
                out = h.plan(&request, &from, &b, &mut free());
                assert!(moving(out.status));
                assert!(out.position_error <= error);
                error = out.position_error;
                assert!(within(&out.q, &b));
            }
            assert!(out.q[1] > 1e-3, "{side:?} {plane}");
        }
    }

    #[test]
    fn probes_the_pole_at_the_exact_physical_elevation_scale() {
        let (mut h, request, _, _) = neutral();
        let start = pole_q(POLE_PLANE);
        h.plan(
            &request,
            &start,
            &pole_bounds(&start, 14.0 / 60.0),
            &mut free(),
        );
        let planes = [0.0, PI, PI / 2.0, (3.0 * PI) / 2.0];
        let probes: Vec<(f64, f64)> = h
            .solver
            .trace
            .pole_probes
            .iter()
            .copied()
            .filter(|&(p, l)| planes.contains(&p) && l > 0.0 && l < 1e-4)
            .collect();
        assert_eq!(probes.iter().map(|p| p.0).collect::<Vec<_>>(), planes);
        for (plane, lift) in probes {
            let physical =
                lift * elevation_ceiling(plane, &h.calibration.joints.shoulder.elevation).max;
            assert!(close(physical, CBRT_EPSILON));
        }
    }

    #[test]
    fn keeps_caller_locked_plane_and_lift_bounds_exact_at_the_pole() {
        let (mut h, request, _, _) = neutral();
        let start = pole_q(POLE_PLANE);
        let initial = h.primary_error_at(&start, &request);
        for locked in [0, 1] {
            let mut limit = pole_bounds(&start, 14.0 / 60.0);
            limit.lower[locked] = start[locked];
            limit.upper[locked] = start[locked];
            let out = h.plan(&request, &start, &limit, &mut free());
            assert_eq!(out.status, ArmPathStatus::Stationary);
            assert!(close(out.position_error, initial));
            assert_eq!(out.q, start);
        }
    }

    #[test]
    fn does_not_use_the_pole_gauge_at_a_small_positive_lift() {
        let (mut h, request, _, _) = neutral();
        let mut start = pole_q(POLE_PLANE);
        start[1] = 1e-8;
        let mut limit = pole_bounds(&start, 14.0 / 60.0);
        limit.lower[0] = start[0] - 1e-4;
        limit.upper[0] = start[0] + 1e-4;
        let out = h.plan(&request, &start, &limit, &mut free());
        assert_eq!(out.status, ArmPathStatus::Progress);
        assert_ne!(out.q[0], limit.lower[0]);
        assert_ne!(out.q[0], limit.upper[0]);
        assert!(within(&out.q, &limit));
    }

    #[test]
    fn keeps_the_gauge_move_collision_safe_and_rejects_a_colliding_lift() {
        let (mut h, request, _, _) = neutral();
        let start = pole_q(POLE_PLANE);
        let limit = pole_bounds(&start, 14.0 / 60.0);
        let initial_forward = h.forward(&start);
        let center = h.hand_proxy(&start);
        let initial = h.primary_error_at(&start, &request);
        let mut e = row_env(0, HAND_PROXY, move |p| {
            let d = sub(*p, center);
            (
                -d.length(),
                if d.length_sq() > 0.0 {
                    neg(unit(d))
                } else {
                    UP
                },
            )
        });
        let out = h.plan(&request, &start, &limit, &mut e);
        assert_eq!(out.status, ArmPathStatus::Progress);
        assert_ne!(out.q[0], start[0]);
        assert_eq!(out.q[1], 0.0);
        let (f, i) = (&out.forward, &initial_forward);
        for (a, b) in [
            (f.u, i.u),
            (f.l, i.l),
            (f.h, i.h),
            (f.palm, i.palm),
            (f.elbow, i.elbow),
            (f.wrist, i.wrist),
        ] {
            assert!(a.distance_to(&b) < 1e-12);
        }
        for (a, b) in [
            (f.upper_world, i.upper_world),
            (f.lower_world, i.lower_world),
            (f.hand_world, i.hand_world),
        ] {
            assert!(a.angle_to(&b) < 1e-7);
        }
        assert!(close(out.position_error, initial));
        assert_eq!(out.max_violation, 0.0);
        assert_eq!(out.environment_batches, e.calls);
        assert!(out.environment_batches <= 96);
        assert!(close(out.clearances[0].distance, 0.0));
    }

    #[test]
    fn shares_the_fixed_sweep_query_budget_across_line_search_halvings() {
        let mut h = Fixture::base();
        h.solver = h.solver(0.001);
        let start = [0.08, 0.48, -0.04, 0.58, 0.01, 0.02, 0.0];
        let goal = [0.95, 1.18, -0.4, 1.25, 0.45, 0.23, -0.13];
        let request = h.request_at(&goal);
        let initial = h.primary_error_at(&start, &request);
        let mut e = safe_env(10.0);
        let out = h.plan(&request, &start, &full_bounds(), &mut e);
        assert!(moving(out.status));
        assert!(out.position_error < initial);
        assert!(out.iterations > 0);
        assert!(out.environment_batches <= 96);
        assert_eq!(e.calls, out.environment_batches);
        for sample in 0..=4096 {
            let q = chord(&start, &out.q, sample as f64 / 4096.0);
            assert!(h.hand_proxy(&q).y + 10.0 >= 0.0);
        }
    }

    /// The circle the elbow can turn on about the shoulder-wrist axis of `wrist`.
    fn elbow_circle(h: &Fixture, wrist: &Vec3) -> (Vec3, Vec3) {
        let n = unit(sub(*wrist, h.context.shoulder));
        let d = wrist.distance_to(&h.context.shoulder);
        let (u, l) = (h.context.upper_length, h.context.lower_length);
        let mut center = h.context.shoulder;
        center.add_scaled_vector(&n, (u * u - l * l + d * d) / (2.0 * d));
        (n, center)
    }

    fn turned(radial: Vec3, axis: &Vec3, angle: f64, center: &Vec3) -> Vec3 {
        let mut v = radial;
        *v.apply_axis_angle(axis, angle).add(center)
    }

    #[test]
    fn uses_continuous_authored_elbow_guidance_during_primary_progress() {
        for (side, yaw, scale, palm, width, flex, limit) in [
            (Side::R, 0.0, 1.0, true, 0.5, 0.2, 0.04),
            (Side::L, 0.0, 1.0, true, 0.5, 0.2, 0.04),
            (Side::R, 0.6, 0.5, true, 0.5, 0.2, 0.04),
            (Side::L, -0.5, 1.7, true, 0.5, 0.2, 0.04),
            (Side::R, 0.3, 1.0, false, 0.5, 0.2, 0.04),
            (Side::R, 0.0, 1.0, true, 14.0 / 60.0, 0.08, 0.02),
        ] {
            let mut h = Fixture::new(side, yaw, scale);
            let start = [0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05];
            let mut goal = start;
            goal[3] += flex;
            let mut request = h.request_at(&goal);
            if !palm {
                request.palm = None;
            }
            let mut bound = bounded_around(&start, width);
            bound.upper[3] = start[3] + limit;
            let reference = h.plan(&request, &start, &bound, &mut free());
            assert_eq!(reference.status, ArmPathStatus::Progress);
            let (n, center) = elbow_circle(&h, &reference.forward.wrist);
            let radial = sub(reference.forward.elbow, center);
            let span = h.context.upper_length + h.context.lower_length + h.hand_length;
            let mut elbows = Vec::new();
            for sign in [-1.0, 1.0] {
                let target = turned(radial, &n, sign * 0.2, &center);
                let mut solver = h.solver(0.006 * scale);
                let mut e = row_env(0, TORSO_SAMPLES, move |p| (p.y + scale, UP));
                let mut out = h.out(1);
                let r = ArmPathRequest {
                    elbow: Some(target),
                    ..request
                };
                solver.plan(&r, &start, &h.context, &bound, &mut e, &mut out);
                assert_eq!(out.status, ArmPathStatus::Progress);
                elbows.push(out.forward.elbow);
                assert!(
                    out.forward.elbow.distance_to(&target)
                        < reference.forward.elbow.distance_to(&target) - 0.001 * scale
                );
                let ratio = |e: f64| (e / span) * (e / span);
                assert!(ratio(out.position_error) <= ratio(reference.position_error) + EPSILON_2_3);
                let t = &solver.trace;
                let active: Vec<_> = t.retractions.iter().filter(|r| r.accepted).collect();
                assert!(!active.is_empty());
                for event in active {
                    assert!(event.primary_change <= EPSILON_2_3);
                    assert!(event.elbow_improvement > EPSILON_2_3);
                    assert!(event.wrist_movement <= 1e-6 * span);
                    assert!(event.hand_movement <= 1e-5);
                    if palm {
                        assert!(event.palm_movement <= 1e-5);
                    }
                }
                assert!(t.qp_calls.iter().all(|&n| n <= 6));
                assert!(t.candidates.iter().all(|&n| n <= 6));
                assert!(out.iterations <= 6);
                assert_eq!(out.environment_batches, e.calls);
                assert!(e.calls <= 96);
                assert!(close(
                    h.primary_error_at(&out.q, &request),
                    out.position_error
                ));
                h.assert_exact(&out, 1.0);
                for sample in 0..=1024 {
                    let q = chord(&start, &out.q, sample as f64 / 1024.0);
                    assert!(within(&q, &bound));
                    assert!(h.forward(&q).elbow.y + scale >= 0.0);
                }
            }
            assert!(elbows[0].distance_to(&elbows[1]) > 0.002 * scale);
        }
    }

    #[test]
    fn falls_back_to_the_primary_move_when_retraction_exceeds_tight_wrist_bounds() {
        let mut h = Fixture::base();
        let start = [0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05];
        let mut goal = start;
        goal[3] = 1.0;
        let request = h.request_at(&goal);
        let mut bound = bounded_around(&start, 14.0 / 60.0);
        bound.upper[3] = start[3] + 0.04;
        bound.lower[5] = start[5] - 0.02;
        bound.upper[5] = start[5] + 0.02;
        let reference = h.plan(&request, &start, &bound, &mut free());
        let n = unit(sub(reference.forward.wrist, h.context.shoulder));
        let mut center = h.context.shoulder;
        center.add_scaled_vector(&n, sub(reference.forward.elbow, h.context.shoulder).dot(&n));
        let target = turned(sub(reference.forward.elbow, center), &n, -0.2, &center);
        let mut solver = h.solver(0.006);
        let mut out = h.out(0);
        let r = ArmPathRequest {
            elbow: Some(target),
            ..request
        };
        solver.plan(&r, &start, &h.context, &bound, &mut free(), &mut out);
        assert!(!solver.trace.retractions.is_empty());
        assert!(solver.trace.retractions.iter().all(|r| !r.accepted));
        assert_eq!(bits(&out.q), bits(&reference.q));
        assert_eq!(out.position_error, reference.position_error);
        assert!(within(&out.q, &bound));
    }

    #[test]
    fn keeps_finite_hand_preserving_elbow_guidance_safe() {
        for kind in ["locked", "straight", "pole", "near-pole"] {
            let mut h = Fixture::base();
            let mut start = [0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05];
            match kind {
                "straight" => start[3] = 0.0,
                "pole" => start[1] = 0.0,
                "near-pole" => start[1] = 1e-4,
                _ => {}
            }
            let initial = h.forward(&start);
            let mut elbow = initial.elbow;
            elbow.add(&Vec3::new(0.01, 0.005, 0.01));
            let request = ArmPathRequest {
                elbow: Some(elbow),
                ..h.request_at(&start)
            };
            let bound = bounded_around(&start, if kind == "locked" { 0.0 } else { 14.0 / 60.0 });
            let mut e = row_env(0, TORSO_SAMPLES, |p| (p.dot(&UP) + 1.0, UP));
            let out = h.plan(&request, &start, &bound, &mut e);
            assert!(out.q.iter().all(|v| v.is_finite()));
            assert!(out.forward.wrist.distance_to(&initial.wrist) < 1e-6);
            assert!(out.forward.h.distance_to(&initial.h) < 1e-5);
            assert!(out.forward.palm.distance_to(&initial.palm) < 1e-5);
            if kind == "locked" || kind == "straight" {
                assert_eq!(out.q, start, "{kind}");
            }
            assert_eq!(out.environment_batches, e.calls);
            assert!(e.calls <= 96);
            assert!(out.iterations <= 6);
            assert!(close(
                h.primary_error_at(&out.q, &request),
                out.position_error
            ));
            for sample in 0..=512 {
                let q = chord(&start, &out.q, sample as f64 / 512.0);
                assert!(within(&q, &bound));
                assert!(h.forward(&q).elbow.y + 1.0 >= 0.0);
            }
        }
    }

    #[test]
    fn respects_an_elbow_plane_during_secondary_motion() {
        for blocking in [true, false] {
            let mut h = Fixture::base();
            let start = [0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05];
            let initial = h.forward(&start);
            let n = unit(sub(initial.wrist, h.context.shoulder));
            let mut center = h.context.shoulder;
            center.add_scaled_vector(&n, sub(initial.elbow, h.context.shoulder).dot(&n));
            let radial = sub(initial.elbow, center);
            let target = turned(radial, &n, -0.1, &center);
            let request = ArmPathRequest {
                elbow: Some(target),
                ..h.request_at(&start)
            };
            let bound = bounded_around(&start, 14.0 / 60.0);
            let reference = h.plan(&request, &start, &bound, &mut free());
            assert!(reference.forward.elbow.distance_to(&initial.elbow) > 0.001);
            let mut normal = if blocking {
                unit(*Vec3::default().cross_vectors(&n, &radial))
            } else {
                n
            };
            let middle = chord(&start, &reference.q, 0.5);
            if !blocking && normal.dot(&sub(h.forward(&middle).elbow, initial.elbow)) < 0.0 {
                normal.negate();
            }
            let base = initial.elbow;
            let mut e = row_env(0, TORSO_SAMPLES, move |p| {
                (normal.dot(&sub(*p, base)), normal)
            });
            let mut solver = h.solver(0.006);
            let mut out = h.out(1);
            solver.plan(&request, &start, &h.context, &bound, &mut e, &mut out);
            if blocking {
                assert!(normal.dot(&sub(target, initial.elbow)) < -0.001);
                assert!(out.forward.elbow.distance_to(&target) > 0.001);
            } else {
                assert!(solver.trace.retractions.iter().any(|r| r.accepted));
                assert!(out.forward.elbow.distance_to(&initial.elbow) > 0.001);
            }
            assert!(out.forward.wrist.distance_to(&initial.wrist) < 1e-6);
            assert!(out.forward.h.distance_to(&initial.h) < 1e-5);
            assert!(out.forward.palm.distance_to(&initial.palm) < 1e-5);
            assert_eq!(out.environment_batches, e.calls);
            assert!(e.calls <= 96);
            assert!(out.iterations <= 6);
            for sample in 0..=2048 {
                let q = chord(&start, &out.q, sample as f64 / 2048.0);
                assert!(normal.dot(&sub(h.forward(&q).elbow, initial.elbow)) >= -1e-10);
                assert!(within(&q, &bound));
            }
        }
    }

    #[test]
    fn reserves_one_final_chord_certificate_through_several_gn_endpoints() {
        let mut h = Fixture::base();
        let start = [0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05];
        let goal = [0.35, 1.0, 0.15, 0.9, 0.25, 0.1, 0.05];
        let request = h.request_at(&goal);
        let bound = bounded_around(&start, 14.0 / 60.0);
        let reference = h.plan(&request, &start, &bound, &mut free());
        assert_eq!(reference.status, ArmPathStatus::Settled);
        h.solver = h.solver(0.003);
        let mut e = safe_env(1.0);
        let out = h.plan(&request, &start, &bound, &mut e);
        assert_eq!(out.status, ArmPathStatus::Settled);
        assert!(out.position_error < 1e-5);
        assert!(out.iterations > 1 && out.iterations <= 6);
        assert_eq!(out.environment_batches, e.calls);
        assert!(e.calls <= 96);
        assert!(close(
            h.primary_error_at(&out.q, &request),
            out.position_error
        ));
        for sample in 0..=2048 {
            let q = chord(&start, &out.q, sample as f64 / 2048.0);
            assert!(within(&q, &bound));
            assert!(h.hand_proxy(&q).y + 1.0 >= 0.0);
        }
    }

    #[test]
    fn rejects_an_uncertified_sphere_crossing() {
        for incompatible_elbow in [false, true] {
            let mut h = Fixture::base();
            h.solver = h.solver(0.003);
            let start = [0.0, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05];
            let mut goal = start;
            goal[0] = 0.3;
            if incompatible_elbow {
                goal[3] += 0.2;
            }
            let mut middle = start;
            middle[0] = 0.15;
            let center = h.hand_proxy(&middle);
            let radius = 0.008;
            let mut bound = ArmPathBounds {
                lower: start,
                upper: start,
            };
            bound.upper[0] = goal[0];
            let request = h.request_at(&goal);
            // A local query domain exposes the interior obstacle during the chord
            // replay, while both clear endpoints have no active separating plane.
            let mut e = env(1, move |_, points, rows| {
                let (d, n) = sphere_row(&points[HAND_PROXY].position, &center, radius);
                set_row(&mut rows[0], 0, HAND_PROXY, d < 0.012, d, n);
            });
            let out = h.plan(&request, &start, &bound, &mut e);
            let certificates = &h.solver.trace.certificates;
            assert!(
                certificates.iter().any(|c| !c.certified),
                "{certificates:?}"
            );
            if incompatible_elbow {
                let last = certificates.last().unwrap();
                assert_eq!(last.iteration, 6);
                assert_eq!(out.iterations, 6);
                assert_eq!(out.q, last.checkpoint);
            } else {
                assert!(certificates[0].settled);
                assert!(certificates[0].iteration < 6);
                assert!(out.iterations > certificates[0].iteration);
            }
            for event in certificates.iter().filter(|c| !c.certified) {
                assert!(h.hand_proxy(&event.attempted).distance_to(&center) - radius > 0.0);
                assert_eq!(event.returned, event.checkpoint);
            }
            assert_eq!(out.status, ArmPathStatus::Progress);
            assert!(out.q[0] > 0.0 && out.q[0] < middle[0]);
            assert_eq!(e.calls, out.environment_batches);
            assert!(e.calls <= 96);
            assert!(close(
                out.position_error,
                h.primary_error_at(&out.q, &request)
            ));
            h.assert_exact(&out, 1e-12);
            assert!(close(
                out.clearances[0].distance,
                h.hand_proxy(&out.q).distance_to(&center) - radius
            ));
            for sample in 0..=2048 {
                let q = chord(&start, &out.q, sample as f64 / 2048.0);
                assert!(h.hand_proxy(&q).distance_to(&center) - radius >= -1e-9);
            }
        }
    }

    #[test]
    fn protects_the_exact_final_certificate_reservation() {
        for fits in [true, false] {
            let h = Fixture::base();
            let mut solver = h.solver(0.003);
            let start = [0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05];
            let goal = [0.35, 1.0, 0.15, 0.9, 0.25, 0.1, 0.05];
            let request = h.request_at(&goal);
            let bound = bounded_around(&start, 14.0 / 60.0);
            let mut e = safe_env(1.0);
            let mut out = h.out(1);
            solver.plan(&request, &start, &h.context, &bound, &mut e, &mut out);
            assert_eq!(out.status, ArmPathStatus::Settled);
            let mut resolved = ResolvedBounds::default();
            assert!(create_bounds(&h.calibration, &bound, &mut resolved));
            // Reuse real FK, endpoint sampling and preflight, then position only the
            // spent-work counter at the two adjacent admission boundaries.
            solver.environment_batches = 0;
            solver.states[CANDIDATE].q = solver.states[CURRENT].q;
            assert!(solver.evaluate_plan_candidate(&h.context, &resolved, &mut e, 0));
            solver.accept_plan_candidate(&e);
            let reserved = solver.reserved_sweep_count;
            let fractions = solver.reserved_sweep_fractions[..reserved].to_vec();
            let current = solver.states[CURRENT].q;
            assert!(reserved > 3);
            solver.environment_batches = 96 - reserved - usize::from(fits);
            e.calls = 0;
            if !fits {
                solver.states[CANDIDATE].q = start;
            }
            assert_eq!(
                solver.evaluate_plan_candidate(&h.context, &resolved, &mut e, 0),
                fits
            );
            assert_eq!(e.calls, usize::from(fits));
            if fits {
                solver.accept_plan_candidate(&e);
            } else {
                assert_eq!(solver.prepared_sweep_count, 3);
                assert_eq!(solver.reserved_sweep_count, reserved);
                assert_eq!(solver.reserved_sweep_fractions[..reserved], fractions[..]);
            }
            assert!(!solver.current_is_certified);
            assert!(solver.certify_current(&h.context, &resolved, &mut e));
            assert_eq!(solver.environment_batches, 96);
            assert_eq!(e.calls, reserved + usize::from(fits));
            assert_eq!(solver.states[CURRENT].q, current);
            assert!(solver.current_is_certified);
        }
    }

    #[test]
    fn reports_an_unreachable_request_as_finite_stationary_progress() {
        let mut h = Fixture::base();
        let request = ArmPathRequest {
            wrist: Vec3::new(8.0, 4.0, -7.0),
            hand: FORWARD,
            palm: Some(UP),
            curls: EMPTY_SPEC,
            spread: EMPTY_SPEC,
            elbow: None,
        };
        let mut next = [0.0, 0.3, 0.0, 0.4, 0.0, 0.0, 0.0];
        let mut out = h.out(0);
        for _ in 0..10 {
            out = h.plan(&request, &next, &full_bounds(), &mut free());
            if out.status != ArmPathStatus::Progress {
                break;
            }
            next = out.q;
        }
        assert_eq!(out.status, ArmPathStatus::Stationary);
        assert!(out.position_error > 1.0 && out.position_error.is_finite());
        assert!(out.q.iter().all(|v| v.is_finite()));
        assert_eq!(out.max_violation, 0.0);
    }

    #[test]
    fn keeps_q_in_the_exact_rendered_frame() {
        for (side, yaw, scale) in [
            (Side::R, 0.0, 1.0),
            (Side::L, 0.0, 1.0),
            (Side::R, 0.7, 1.0),
            (Side::R, 0.0, 0.01),
            (Side::L, 0.7, 0.01),
        ] {
            let mut h = Fixture::new(side, yaw, scale);
            let start = [0.0, 0.18, 0.1, 0.5, 0.02, 0.04, -0.02];
            let request = h.request_at(&start);
            let out = h.plan(&request, &start, &full_bounds(), &mut free());
            let exact = h.forward(&out.q);
            assert_eq!(out.status, ArmPathStatus::Settled);
            assert!(out.forward.wrist.distance_to(&exact.wrist) < 1e-12);
            assert!(1.0 - out.forward.hand_world.dot(&exact.hand_world).abs() < 1e-14);
            assert!(out.position_error < 1e-7 * scale + 1e-12);
        }
    }

    #[test]
    fn rejects_an_empty_strict_bound_without_changing_the_start() {
        let mut h = Fixture::base();
        let start = [0.0, 0.2, 0.0, 0.3, 0.0, 0.0, 0.0];
        let mut strict = full_bounds();
        strict.lower[0] = 0.1;
        strict.upper[0] = 0.05;
        let request = h.request_at(&[0.4, 0.5, 0.3, 0.7, 0.0, 0.0, 0.0]);
        let out = h.plan(&request, &start, &strict, &mut free());
        assert_eq!(out.status, ArmPathStatus::Blocked);
        assert_eq!(out.q, start);
    }

    #[test]
    fn marks_an_invalid_world_frame_blocked_before_querying_clearance() {
        let mut h = Fixture::base();
        let start = [0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03];
        let request = h.request_at(&start);
        h.context.right = h.context.up;
        let mut e = env(1, |_, _, _| {});
        let out = h.plan(&request, &start, &full_bounds(), &mut e);
        assert_eq!(out.status, ArmPathStatus::Blocked);
        assert_eq!(out.q, start);
        assert_eq!(out.position_error, f64::INFINITY);
        assert_eq!(out.orientation_error, f64::INFINITY);
        assert_eq!(out.max_violation, f64::INFINITY);
        assert_eq!(out.environment_batches, 0);
        assert_eq!(e.calls, 0);
    }

    /// The panic message of `f`, which must panic.
    fn panic_of(f: impl FnOnce()) -> String {
        let payload = catch_unwind(AssertUnwindSafe(f)).expect_err("no panic");
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_owned()))
            .unwrap_or_default()
    }

    #[test]
    fn rejects_a_stable_key_that_changes_its_point_index_between_states() {
        let mut h = Fixture::base();
        let start = [0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03];
        let request = h.request_at(&[0.42, 0.64, 0.35, 0.82, 0.28, 0.22, -0.13]);
        let mut e = env(1, |n, _, rows| {
            let point = HAND_PROXY + usize::from(n > 1);
            set_row(
                &mut rows[0],
                0,
                point,
                false,
                f64::INFINITY,
                Vec3::default(),
            );
        });
        let message = panic_of(|| {
            h.plan(&request, &start, &full_bounds(), &mut e);
        });
        assert!(message.contains("stable point index"), "{message}");
    }

    #[test]
    fn rejects_a_broken_row_contract_and_resets_it_for_the_next_call() {
        for (fail_at, fault, message) in [
            (1, "duplicate", "unique stable keys"),
            (1, "point-range", "valid point indices"),
            (1, "omitted-row", "unique stable keys"),
            (1, "distance", "finite distance"),
            (1, "normal", "nonzero finite normal"),
            (2, "changed-key", "stable and unique"),
            (2, "duplicate", "stable and unique"),
            (2, "changed-point", "stable point index"),
            (2, "omitted-distance", "finite distance"),
            (2, "omitted-normal", "nonzero finite normal"),
        ] {
            let mut h = Fixture::base();
            let start = [0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03];
            let request = h.request_at(&[0.42, 0.64, 0.35, 0.82, 0.28, 0.22, -0.13]);
            let mut out = h.out(2);
            let mut e = env(2, |n, _, rows| {
                let failing = n == fail_at;
                for (slot, row) in rows.iter_mut().enumerate() {
                    if failing && fault == "omitted-row" && slot == 1 {
                        continue;
                    }
                    row.key = Some(slot as u32);
                    row.point_index = Some(slot);
                    row.valid = true;
                    if !(failing && fault == "omitted-distance" && slot == 0) {
                        row.distance = 1.0;
                    }
                    if !(failing && fault == "omitted-normal" && slot == 0) {
                        row.normal = UP;
                    }
                }
                if !failing {
                    return;
                }
                match fault {
                    "duplicate" => {
                        rows[0].key = rows[1].key;
                        rows[0].point_index = rows[1].point_index;
                        // Registration errors must precede this invalid value on the first query.
                        if fail_at == 1 {
                            rows[0].distance = f64::NAN;
                        }
                    }
                    "point-range" => {
                        rows[0].distance = f64::NAN;
                        rows[1].point_index = None;
                    }
                    "distance" => rows[0].distance = f64::NAN,
                    "normal" => rows[0].normal = Vec3::default(),
                    "changed-key" => rows[0].key = Some(99),
                    "changed-point" => rows[0].point_index = Some(2),
                    _ => {}
                }
            });
            let got = panic_of(|| {
                h.solver.plan(
                    &request,
                    &start,
                    &h.context,
                    &full_bounds(),
                    &mut e,
                    &mut out,
                );
            });
            assert!(got.contains(message), "{fault}: {got}");
            assert_eq!(e.calls, fail_at, "{fault}");

            // A new public call establishes its own key order and point identities, even after a panic.
            let recovery = || {
                env(2, |_, _, rows: &mut [ArmPathClearance]| {
                    for (slot, row) in rows.iter_mut().enumerate() {
                        set_row(row, 100 + (1 - slot as u32), 2 - slot, true, 1.0, UP);
                    }
                })
            };
            let settled = h.request_at(&start);
            assert!(h.solver.restore_endpoint(
                &settled,
                &start,
                &h.context,
                &full_bounds(),
                &mut recovery(),
                &mut out
            ));
            let mut fresh = Fixture::base();
            let mut fresh_out = fresh.out(2);
            fresh.solver.restore_endpoint(
                &settled,
                &start,
                &h.context,
                &full_bounds(),
                &mut recovery(),
                &mut fresh_out,
            );
            assert_eq!(out, fresh_out, "{fault}");
            assert_eq!(out.environment_batches, 1);
        }
    }

    fn entering_plane(
        point: usize,
        axis: Vec3,
        activation: f64,
        offset: f64,
    ) -> Env<impl FnMut(usize, &[ArmPathPoint], &mut [ArmPathClearance])> {
        env(1, move |_, points, rows| {
            let c = points[point].position.dot(&axis);
            let valid = c >= activation;
            if valid {
                set_row(&mut rows[0], 0, point, true, offset - c, neg(axis));
            } else {
                set_row(
                    &mut rows[0],
                    0,
                    point,
                    false,
                    f64::INFINITY,
                    Vec3::default(),
                );
            }
        })
    }

    #[test]
    fn keeps_reused_plan_and_restore_calls_identical_to_fresh_solvers() {
        let mut h = Fixture::base();
        let start = [0.04, 0.52, 0.06, 0.6, 0.01, 0.03, 0.0];
        let goal = [0.66, 0.9, 0.28, 1.0, 0.22, 0.18, -0.07];
        let request = h.request_at(&goal);
        let (from, to) = (h.hand_proxy(&start), h.hand_proxy(&goal));
        let axis = unit(sub(to, from));
        let origin = from.dot(&axis);
        let travel = to.dot(&axis) - origin;
        let mut obstacle = entering_plane(
            HAND_PROXY,
            axis,
            origin + travel * 0.08,
            origin + travel * 0.46,
        );
        let mut active = 0;
        let obstructed = {
            let mut e = env(1, |n, points, rows| {
                (obstacle.fill)(n, points, rows);
                active += usize::from(rows[0].valid);
            });
            h.plan(&request, &start, &full_bounds(), &mut e)
        };
        assert_eq!(obstructed.status, ArmPathStatus::Progress);
        // The obstacle must have shaped the plan: its row was live and the answer differs from a free one.
        assert!(active > 0);
        let free_out = Fixture::base().plan(&request, &start, &full_bounds(), &mut free());
        let deviation = (0..DOFS)
            .map(|i| (obstructed.q[i] - free_out.q[i]).abs())
            .fold(0.0, js_max);
        assert!(deviation >= 1e-3);

        let mut fresh = Fixture::base();
        for (call, rows) in [2usize, 2, 3, 0, 1, 2].into_iter().enumerate() {
            let mut traces: Vec<Vec<Vec<f64>>> = Vec::new();
            let mut outputs = Vec::new();
            for f in [&mut h, &mut fresh] {
                let mut trace: Vec<Vec<f64>> = Vec::new();
                let mut out = f.out(rows);
                {
                    let mut e = env(rows, |_, points, out_rows| {
                        trace.push(
                            points
                                .iter()
                                .flat_map(|p| [p.position.x, p.position.y, p.position.z])
                                .collect(),
                        );
                        let n = out_rows.len();
                        for (slot, row) in out_rows.iter_mut().enumerate() {
                            let index = (slot + call + trace.len()) % n;
                            let valid = index.is_multiple_of(2);
                            let normal = if valid { UP } else { Vec3::default() };
                            let d = if valid { 1.0 } else { f64::INFINITY };
                            set_row(
                                row,
                                (call * 100 + index) as u32,
                                index + call,
                                valid,
                                d,
                                normal,
                            );
                        }
                    });
                    if call.is_multiple_of(2) {
                        f.solver.plan(
                            &request,
                            &start,
                            &f.context,
                            &full_bounds(),
                            &mut e,
                            &mut out,
                        );
                    } else {
                        assert!(f.solver.restore_endpoint(
                            &request,
                            &start,
                            &f.context,
                            &full_bounds(),
                            &mut e,
                            &mut out
                        ));
                    }
                }
                assert_eq!(out.environment_batches, trace.len());
                assert!(out.environment_batches <= 96);
                traces.push(trace);
                outputs.push(out);
            }
            assert_eq!(traces[0], traces[1]);
            assert_eq!(outputs[0], outputs[1]);
            if rows > 0 && call.is_multiple_of(2) {
                assert!(traces[0].len() > 1);
            }
        }
    }

    /// The curled index fingertip pushed into a plane or a sphere; see the TS fixture.
    fn curled_finger_collision(
        on_sphere: bool,
    ) -> (
        Fixture,
        ArmPathRequest,
        [f64; DOFS],
        usize,
        Vec3,
        Vec3,
        Vec3,
        f64,
        ArmPathBounds,
    ) {
        let mut h = Fixture::fingers();
        let start = [0.1, 0.45, 0.1, 0.55, 0.0, 0.0, 0.0];
        let mut curls = EMPTY_SPEC;
        curls[Finger::Index as usize] = Some(0.8);
        let request = ArmPathRequest {
            curls,
            ..h.request_at(&start)
        };
        let out = h.plan(&request, &start, &full_bounds(), &mut free());
        let point = out
            .points
            .iter()
            .position(|p| {
                p.finger == Some(Finger::Index) && p.joint_index == Some(2) && p.tip == Some(true)
            })
            .expect("the index fingertip");
        let curled = out.points[point].position;
        let open_request = ArmPathRequest {
            curls: EMPTY_SPEC,
            ..request
        };
        let open = h
            .plan(&open_request, &start, &full_bounds(), &mut free())
            .points[point]
            .position;
        let mut q_plus = start;
        q_plus[0] += 0.25;
        let plus_request = ArmPathRequest {
            curls,
            ..h.request_at(&q_plus)
        };
        let plus = h
            .plan(&plus_request, &q_plus, &full_bounds(), &mut free())
            .points[point]
            .position;
        let outward = unit(sub(plus, curled));
        let boundary = curled.dot(&outward) + 0.002;
        let mut center = curled;
        center.add_scaled_vector(&outward, -0.05);
        let mut restricted = full_bounds();
        restricted.lower = start;
        restricted.upper = start;
        restricted.upper[0] = start[0] + 0.4;
        (
            h,
            request,
            start,
            point,
            curled,
            open,
            if on_sphere { center } else { outward },
            boundary,
            restricted,
        )
    }

    fn finger_env(
        on_sphere: bool,
        point: usize,
        v: Vec3,
        boundary: f64,
    ) -> Env<impl FnMut(usize, &[ArmPathPoint], &mut [ArmPathClearance])> {
        row_env(0, point, move |p| {
            if on_sphere {
                sphere_row(p, &v, 0.052)
            } else {
                (p.dot(&v) - boundary, v)
            }
        })
    }

    #[test]
    fn restores_a_newly_colliding_curled_fingertip_through_a_bounded_endpoint_move() {
        for on_sphere in [false, true] {
            let (mut h, request, start, point, curled, open, v, boundary, restricted) =
                curled_finger_collision(on_sphere);
            assert!(open.distance_to(&curled) > 1e-3);
            let mut e = finger_env(on_sphere, point, v, boundary);
            let collision = h.plan(&request, &start, &restricted, &mut e);
            // The start is pushed clear before planning.
            assert_ne!(collision.status, ArmPathStatus::Blocked);
            assert!(collision.max_violation <= 64.0 * f64::EPSILON);
            assert!(collision.clearances[0].distance >= -1e-12);
            let mut out = h.out(1);
            assert!(h.solver.restore_endpoint(
                &request,
                &start,
                &h.context,
                &restricted,
                &mut e,
                &mut out
            ));
            assert!(out.max_violation <= 64.0 * f64::EPSILON);
            assert!(out.clearances[0].distance >= -1e-12);
            assert!(out.q[0] > start[0]);
            assert_eq!(out.q[1..], start[1..]);
            assert!(out.forward.wrist.distance_to(&h.forward(&out.q).wrist) < 1e-12);
        }
    }

    #[test]
    fn clears_a_start_pushed_into_the_face_and_then_plans() {
        let mut h = Fixture::base();
        let start = [0.05, 0.54, 0.08, 0.62, 0.02, 0.04, 0.0];
        let goal = [0.52, 0.84, 0.26, 0.94, 0.2, 0.16, -0.06];
        let request = h.request_at(&goal);
        let from = h.hand_proxy(&start);
        // The surface faces the goal and has moved 1 mm past the start's proxy.
        let axis = unit(sub(from, h.hand_proxy(&goal)));
        let out = h.plan(
            &request,
            &start,
            &full_bounds(),
            &mut plane(HAND_PROXY, axis, from.dot(&axis) - 1e-3),
        );
        assert_ne!(out.status, ArmPathStatus::Blocked);
        assert!(out.max_violation <= 64.0 * f64::EPSILON);
        assert!(out.clearances[0].distance >= -1e-12);
        assert!(out.iterations >= 1);
        assert!(h.solver.trace.push_clears > 0);
    }

    #[test]
    fn fails_restoration_under_a_locked_infeasible_box_and_resets_the_output() {
        let (mut h, request, start, point, _, _, v, boundary, _) = curled_finger_collision(false);
        let locked = ArmPathBounds {
            lower: start,
            upper: start,
        };
        let mut out = h.out(1);
        let mut e = finger_env(false, point, v, boundary);
        assert!(
            !h.solver
                .restore_endpoint(&request, &start, &h.context, &locked, &mut e, &mut out)
        );
        assert_eq!(out.status, ArmPathStatus::Blocked);
        assert_eq!(out.q, start);
        assert_eq!(out.max_violation, f64::INFINITY);
        assert_eq!(out.position_error, f64::INFINITY);
        assert!(out.points.iter().all(|p| p.position.length_sq() == 0.0));
    }

    #[test]
    fn returns_an_already_feasible_endpoint_unchanged() {
        let mut h = Fixture::base();
        let start = [0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03];
        let request = h.request_at(&start);
        let mut out = h.out(0);
        assert!(h.solver.restore_endpoint(
            &request,
            &start,
            &h.context,
            &full_bounds(),
            &mut free(),
            &mut out
        ));
        assert_eq!(out.status, ArmPathStatus::Settled);
        assert_eq!(out.q, start);
        assert_eq!(out.max_violation, 0.0);
    }

    #[test]
    fn rejects_an_invalid_restoration_frame_with_the_start() {
        let mut h = Fixture::base();
        let start = [0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03];
        let request = h.request_at(&start);
        h.context.right = h.context.up;
        let mut out = h.out(0);
        assert!(!h.solver.restore_endpoint(
            &request,
            &start,
            &h.context,
            &full_bounds(),
            &mut free(),
            &mut out
        ));
        assert_eq!(out.status, ArmPathStatus::Blocked);
        assert_eq!(out.q, start);
        assert_eq!(out.max_violation, f64::INFINITY);
    }

    #[test]
    fn converges_through_repeated_absolute_trust_bounds() {
        let mut h = Fixture::base();
        let mut q = [0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03];
        let request = h.request_at(&[0.58, 0.92, -0.32, 1.05, 0.35, 0.23, -0.15]);
        let mut previous = h.primary_error_at(&q, &request);
        let mut status = ArmPathStatus::Progress;
        for _ in 0..12 {
            if status != ArmPathStatus::Progress {
                break;
            }
            let out = h.plan(&request, &q, &bounded_around(&q, 0.18), &mut free());
            status = out.status;
            assert!(out.position_error <= previous + 1e-9);
            assert!(out.q.iter().all(|v| v.is_finite()));
            q = out.q;
            previous = out.position_error;
        }
        assert_eq!(status, ArmPathStatus::Settled);
        assert!(previous < 1e-5);
    }

    #[test]
    fn keeps_an_accepted_transition_on_the_safe_side_of_a_plane() {
        let mut h = Fixture::base();
        let start = [0.05, 0.54, 0.08, 0.62, 0.02, 0.04, 0.0];
        let goal = [0.72, 0.92, 0.32, 1.04, 0.24, 0.19, -0.08];
        let request = h.request_at(&goal);
        let (from, to) = (h.hand_proxy(&start), h.hand_proxy(&goal));
        let axis = unit(sub(to, from));
        let offset = (from.dot(&axis) + to.dot(&axis)) / 2.0;
        let initial = h.primary_error_at(&start, &request);
        let out = h.plan(
            &request,
            &start,
            &full_bounds(),
            &mut plane(HAND_PROXY, axis, offset),
        );
        assert_eq!(out.status, ArmPathStatus::Progress);
        assert!(out.position_error < initial);
        assert!(out.clearances[0].distance >= -1e-10);
        assert!((0..4).any(|i| (out.q[i] - start[i]).abs() > 1e-5));
        assert!(out.environment_batches <= 96);
        for sample in 0..=1024 {
            let q = chord(&start, &out.q, sample as f64 / 1024.0);
            assert!(offset - h.hand_proxy(&q).dot(&axis) >= -1e-9);
        }
    }

    #[test]
    fn allows_a_zero_clearance_tangent_move_when_every_swept_sample_is_safe() {
        let mut h = Fixture::base();
        let start = [0.05, 0.54, 0.08, 0.62, 0.02, 0.04, 0.0];
        let goal = [0.52, 0.84, 0.26, 0.94, 0.2, 0.16, -0.06];
        let request = h.request_at(&goal);
        let (from, to) = (h.hand_proxy(&start), h.hand_proxy(&goal));
        let travel = sub(to, from);
        let mut tangent = travel;
        tangent.cross(&UP);
        if tangent.length_sq() < 1e-12 {
            tangent.cross_vectors(&travel, &RIGHT);
        }
        tangent.normalize();
        let offset = from.dot(&tangent);
        assert!(close(to.dot(&tangent), offset));
        let initial = h.primary_error_at(&start, &request);
        let out = h.plan(
            &request,
            &start,
            &full_bounds(),
            &mut plane(HAND_PROXY, tangent, offset),
        );
        assert!(moving(out.status));
        assert!(out.position_error < initial);
        assert!(out.clearances[0].distance >= -1e-10);
        assert!(out.environment_batches <= 96);
        for sample in 0..=1024 {
            let q = chord(&start, &out.q, sample as f64 / 1024.0);
            assert!(offset - h.hand_proxy(&q).dot(&tangent) >= -1e-9);
        }
    }

    #[test]
    fn keeps_an_approaching_plane_active_at_any_gradient_magnitude() {
        for magnitude in [1.0, 8.0] {
            let mut h = Fixture::base();
            let start = [0.0, 0.5, 0.0, 0.7, 0.0, 0.0, 0.0];
            let mut goal = start;
            goal[5] = 0.4;
            let mut contact = start;
            contact[5] = 0.1;
            let palm = h.forward(&start).palm;
            let offset = h.hand_proxy(&contact).dot(&palm);
            let mut distances = Vec::new();
            let mut strict = ArmPathBounds {
                lower: start,
                upper: start,
            };
            strict.upper[5] = goal[5];
            let request = h.request_at(&goal);
            let out = {
                let mut e = env(1, |_, points, rows| {
                    let d = offset - points[HAND_PROXY].position.dot(&palm);
                    distances.push(d);
                    let mut n = palm;
                    n.multiply_scalar(-magnitude);
                    set_row(&mut rows[0], 0, HAND_PROXY, true, magnitude * d, n);
                });
                h.plan(&request, &start, &strict, &mut e)
            };
            assert_eq!(out.status, ArmPathStatus::Progress);
            assert!(out.q[5] > 0.0);
            assert!(distances.len() > 1);
            assert!(distances[0] > 0.0);
            // Only wrist flex moves here, so its sine arc stays inside the plane
            // when the linear clearance constraint bounds the first proposed step.
            assert!(distances[1] >= -1e-10);
            assert_eq!(out.environment_batches, distances.len());
            assert!(out.environment_batches <= 96);
            assert!(out.forward.wrist.distance_to(&h.forward(&out.q).wrist) < 1e-12);
        }
    }

    #[test]
    fn relinearizes_a_row_that_becomes_valid_inside_its_query_domain() {
        let mut h = Fixture::base();
        let start = [0.04, 0.52, 0.06, 0.6, 0.01, 0.03, 0.0];
        let goal = [0.66, 0.9, 0.28, 1.0, 0.22, 0.18, -0.07];
        let request = h.request_at(&goal);
        let (from, to) = (h.hand_proxy(&start), h.hand_proxy(&goal));
        let axis = unit(sub(to, from));
        let coordinate = from.dot(&axis);
        let travel = to.dot(&axis) - coordinate;
        let (activation, offset) = (coordinate + travel * 0.08, coordinate + travel * 0.46);
        let initial = h.primary_error_at(&start, &request);
        let out = h.plan(
            &request,
            &start,
            &full_bounds(),
            &mut entering_plane(HAND_PROXY, axis, activation, offset),
        );
        assert_eq!(out.status, ArmPathStatus::Progress);
        assert!(out.position_error < initial);
        assert_eq!(out.max_violation, 0.0);
        assert!(out.environment_batches <= 96);
        for sample in 0..=1024 {
            let q = chord(&start, &out.q, sample as f64 / 1024.0);
            let c = h.hand_proxy(&q).dot(&axis);
            if c >= activation {
                assert!(offset - c >= -1e-9);
            }
        }
    }

    #[test]
    fn handles_a_sphere_with_stable_keys_and_rows_in_changing_order() {
        let mut h = Fixture::new(Side::L, 0.7, 0.01);
        let start = [0.08, 0.48, -0.04, 0.58, 0.01, 0.02, 0.0];
        let goal = [0.58, 0.86, -0.28, 0.98, 0.3, 0.18, -0.1];
        let request = h.request_at(&goal);
        let from = h.hand_proxy(&start);
        let mut center = from;
        center.lerp(&h.hand_proxy(&goal), 0.62);
        let radius = from.distance_to(&center) * 0.82;
        let initial = h.primary_error_at(&start, &request);
        let mut e = env(2, move |n, points, rows| {
            let first = usize::from(n.is_multiple_of(2));
            for (slot, which) in [first, 1 - first].into_iter().enumerate() {
                if which == 0 {
                    let (d, normal) = sphere_row(&points[HAND_PROXY].position, &center, radius);
                    set_row(&mut rows[slot], 0, HAND_PROXY, true, d, normal);
                } else {
                    set_row(
                        &mut rows[slot],
                        1,
                        HAND_PROXY + 1,
                        false,
                        f64::INFINITY,
                        Vec3::default(),
                    );
                }
            }
        });
        let out = h.plan(&request, &start, &full_bounds(), &mut e);
        assert_eq!(out.status, ArmPathStatus::Progress);
        assert!(out.position_error < initial);
        assert_eq!(out.max_violation, 0.0);
        assert!(out.environment_batches <= 96);
        let mut keys: Vec<_> = out.clearances.iter().map(|r| r.key).collect();
        keys.sort();
        assert_eq!(keys, [Some(0), Some(1)]);
        assert!(
            !out.clearances
                .iter()
                .find(|r| r.key == Some(1))
                .unwrap()
                .valid
        );
        for sample in 0..=1024 {
            let q = chord(&start, &out.q, sample as f64 / 1024.0);
            assert!(h.hand_proxy(&q).distance_to(&center) - radius >= -1e-9);
        }
    }

    #[test]
    fn never_returns_a_safe_polyline_whose_original_start_chord_cuts_a_sphere() {
        let mut h = Fixture::base();
        let start = [0.08, 0.48, -0.04, 0.58, 0.01, 0.02, 0.0];
        let goal = [0.95, 1.18, -0.4, 1.25, 0.45, 0.23, -0.13];
        let request = h.request_at(&goal);
        let mut center = h.hand_proxy(&start);
        center
            .lerp(&h.hand_proxy(&goal), 0.35)
            .add(&Vec3::new(0.0, 0.03, 0.0));
        let radius = 0.19814247673641228;
        let out = h.plan(
            &request,
            &start,
            &full_bounds(),
            &mut sphere(HAND_PROXY, center, radius),
        );
        assert_eq!(out.max_violation, 0.0);
        for sample in 0..=2048 {
            let q = chord(&start, &out.q, sample as f64 / 2048.0);
            assert!(h.hand_proxy(&q).distance_to(&center) - radius >= -1e-9);
        }
    }

    #[test]
    fn allocates_nothing_while_planning_once_the_rows_are_laid_out() {
        // A second call at the same row count reuses every buffer; only `prepareRows` allocates.
        let mut h = Fixture::base();
        let start = [0.05, 0.54, 0.08, 0.62, 0.02, 0.04, 0.0];
        let request = h.request_at(&[0.72, 0.92, 0.32, 1.04, 0.24, 0.19, -0.08]);
        let mut out = h.out(1);
        let mut e = safe_env(1.0);
        h.solver.plan(
            &request,
            &start,
            &h.context,
            &full_bounds(),
            &mut e,
            &mut out,
        );
        let before = (
            h.solver.qp_a.as_ptr(),
            h.solver.point_jacobian.as_ptr(),
            h.solver.query_rows.as_ptr(),
        );
        h.solver.plan(
            &request,
            &start,
            &h.context,
            &full_bounds(),
            &mut e,
            &mut out,
        );
        let after = (
            h.solver.qp_a.as_ptr(),
            h.solver.point_jacobian.as_ptr(),
            h.solver.query_rows.as_ptr(),
        );
        assert_eq!(before, after);
        assert_eq!(h.solver.trace.row_layouts, 1);
    }
}
