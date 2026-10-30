//! `rig/arm-qp.ts`: the arm solver's constrained-step kernel, a dual active-set QP over
//! linear rows `a_i·δ ≥ b_i` in seven joint coordinates.
//!
//! The Gram matrix of the working set is held explicitly and refactored on every
//! change, which is cheap because at most seven independent rows can be active.
//! Termination is finite rather than geometric: a full step strictly raises the
//! dual objective and a partial step shrinks the working set, so the convergence
//! rate no longer depends on the angle between two active stops in the metric.
//! Imports nothing but the JS min/max, so it can be driven directly with any metric.
//!
//! The working set's size is signed, as the TS `number` is: a partial step with no blocking
//! row (reachable only through NaN) shrinks it past zero exactly as the TS does, and the reads
//! and writes the TS makes at a negative index (no-ops on a typed array) are no-ops here.

// The kernel indexes several arrays by the same row and joint, as the TS does, and its negated
// comparisons are what let a NaN fail them.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use crate::math::f::{js_max, js_min, sqrt};

const DOFS: usize = 7;

/// Absolute row violation accepted as satisfied, in the row's own units.
pub const CONSTRAINT_EPSILON: f64 = 2e-10;
/// A candidate row whose curvature against the working set is below τ·(a·z) is dependent on it.
pub const DEPENDENCY_TOLERANCE: f64 = 1e-10;

/// How a solve ended; see [`solve_dual_active_set`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QpResult {
    Optimal,
    Infeasible,
    Failed,
}

/// The kernel's work area, reused across solves.
#[derive(Clone, Debug, PartialEq)]
pub struct QpScratch {
    /// Row indices of the working set, in insertion order.
    pub working: [i32; DOFS],
    pub gram: [f64; DOFS * DOFS],
    pub gram_factor: [f64; DOFS * DOFS],
    pub r: [f64; DOFS],
    pub d: [f64; DOFS],
}

// arm-qp.ts makeQpScratch
pub fn make_qp_scratch() -> QpScratch {
    QpScratch {
        working: [0; DOFS],
        gram: [0.0; DOFS * DOFS],
        gram_factor: [0.0; DOFS * DOFS],
        r: [0.0; DOFS],
        d: [0.0; DOFS],
    }
}

// arm-qp.ts dot
fn dot(a: &[f64], a_offset: usize, b: &[f64], b_offset: usize) -> f64 {
    let mut sum = 0.0;
    for k in 0..DOFS {
        sum += a[a_offset + k] * b[b_offset + k];
    }
    sum
}

/// `working[k] * DOFS` as an offset into the row arrays.
fn row(working: &[i32; DOFS], k: usize) -> usize {
    working[k] as usize * DOFS
}

// arm-qp.ts factorGram
//
// Rebuild G_W = A_W Z_Wᵀ and its Cholesky factor; false when a pivot is not positive.
fn factor_gram(a: &[f64], z: &[f64], size: isize, scratch: &mut QpScratch) -> bool {
    let size = size.max(0) as usize;
    let QpScratch {
        working,
        gram,
        gram_factor,
        ..
    } = scratch;
    for i in 0..size {
        for j in 0..=i {
            gram[i * DOFS + j] = dot(a, row(working, i), z, row(working, j));
        }
    }
    for i in 0..size {
        for j in 0..=i {
            let mut sum = gram[i * DOFS + j];
            for k in 0..j {
                sum -= gram_factor[i * DOFS + k] * gram_factor[j * DOFS + k];
            }
            if i == j {
                if !(sum > 0.0 && sum.is_finite()) {
                    return false;
                }
                gram_factor[i * DOFS + i] = sqrt(sum);
            } else {
                gram_factor[i * DOFS + j] = sum / gram_factor[j * DOFS + j];
            }
        }
    }
    true
}

// arm-qp.ts solveGram
//
// Solve G_W r = r in place with the current factor.
fn solve_gram(size: isize, scratch: &mut QpScratch) {
    let size = size.max(0) as usize;
    let QpScratch {
        gram_factor: l, r, ..
    } = scratch;
    for i in 0..size {
        let mut sum = r[i];
        for k in 0..i {
            sum -= l[i * DOFS + k] * r[k];
        }
        r[i] = sum / l[i * DOFS + i];
    }
    for i in (0..size).rev() {
        let mut sum = r[i];
        for k in i + 1..size {
            sum -= l[k * DOFS + i] * r[k];
        }
        r[i] = sum / l[i * DOFS + i];
    }
}

// arm-qp.ts solveDualActiveSet
//
// Dual active-set on the rows a_i·δ ≥ b_i, with Z holding one z_i per row and
// stationarity δ = u + Σ λ_i z_i. In the primary step z_i = H⁻¹a_i; in the
// nullspace step the caller passes z_i = P H⁻¹ P a_i, and the same iteration applies.
//
// Rows and z_i are stored with stride 7 in `A` and `Z`; `lambda` needs `count`
// entries. Writes δ and λ in every outcome, but only `'optimal'` certifies them:
// every row holds within `CONSTRAINT_EPSILON`, λ is non-negative and
// complementary to the slack. `'infeasible'` means a violated row is a
// non-negative combination's opposite of the working set, so no damping of the
// metric can satisfy it; `'failed'` means a rounding breakdown or the iteration
// cap, 3·(count + 7).
#[allow(clippy::too_many_arguments)]
pub fn solve_dual_active_set(
    a: &[f64],
    b: &[f64],
    z: &[f64],
    count: usize,
    u: &[f64],
    delta: &mut [f64],
    lambda: &mut [f64],
    scratch: &mut QpScratch,
) -> QpResult {
    delta[..DOFS].copy_from_slice(&u[..DOFS]);
    lambda[..count].fill(0.0);
    let mut size: isize = 0;
    let limit = 3 * (count + DOFS);
    let mut iterations = 0;

    loop {
        // Most violated row outside the working set; ties go to the smallest index.
        let mut p: isize = -1;
        let mut worst = CONSTRAINT_EPSILON;
        for i in 0..count {
            let mut member = false;
            for k in 0..size.max(0) as usize {
                if scratch.working[k] as usize == i {
                    member = true;
                }
            }
            if member {
                continue;
            }
            let violation = b[i] - dot(a, i * DOFS, delta, 0);
            if violation > worst {
                worst = violation;
                p = i as isize;
            }
        }
        if p < 0 {
            break;
        }
        let p = p as usize;
        let p_offset = p * DOFS;
        let denominator = dot(a, p_offset, z, p_offset);

        loop {
            iterations += 1;
            if iterations > limit {
                return QpResult::Failed;
            }
            let n = size.max(0) as usize;
            for k in 0..n {
                scratch.r[k] = dot(a, row(&scratch.working, k), z, p_offset);
            }
            solve_gram(size, scratch);
            for j in 0..DOFS {
                let mut value = z[p_offset + j];
                for k in 0..n {
                    value -= scratch.r[k] * z[row(&scratch.working, k) + j];
                }
                scratch.d[j] = value;
            }
            let curvature = dot(a, p_offset, &scratch.d, 0);

            // Largest dual step before a working row's multiplier reaches zero.
            let mut dual_step = f64::INFINITY;
            let mut blocking: isize = -1;
            for k in 0..n {
                if !(scratch.r[k] > 0.0) {
                    continue;
                }
                let ratio = lambda[scratch.working[k] as usize] / scratch.r[k];
                // `working[-1]` is undefined in the TS, and a comparison with it is false.
                if ratio < dual_step
                    || (ratio == dual_step
                        && blocking >= 0
                        && scratch.working[k] < scratch.working[blocking as usize])
                {
                    dual_step = ratio;
                    blocking = k as isize;
                }
            }

            let step;
            if curvature <= DEPENDENCY_TOLERANCE * denominator {
                if blocking < 0 {
                    return QpResult::Infeasible;
                }
                step = dual_step;
            } else {
                let primal_step = (b[p] - dot(a, p_offset, delta, 0)) / curvature;
                step = js_min(primal_step, dual_step);
                for j in 0..DOFS {
                    delta[j] += step * scratch.d[j];
                }
                if primal_step <= dual_step {
                    for k in 0..n {
                        lambda[scratch.working[k] as usize] -= step * scratch.r[k];
                    }
                    lambda[p] += step;
                    if size >= 0 {
                        scratch.working[size as usize] = p as i32;
                    }
                    size += 1;
                    if !factor_gram(a, z, size, scratch) {
                        return QpResult::Failed;
                    }
                    break;
                }
            }
            for k in 0..n {
                lambda[scratch.working[k] as usize] -= step * scratch.r[k];
            }
            lambda[p] += step;
            if blocking >= 0 {
                lambda[scratch.working[blocking as usize] as usize] = 0.0;
            }
            let mut k = blocking;
            while k < size - 1 {
                if k >= 0 {
                    scratch.working[k as usize] = scratch.working[k as usize + 1];
                }
                k += 1;
            }
            size -= 1;
            if !factor_gram(a, z, size, scratch) {
                return QpResult::Failed;
            }
        }
    }

    // Rebuild δ from λ so the certificate checks the stationary point itself.
    let mut lambda_max = 0.0;
    delta[..DOFS].copy_from_slice(&u[..DOFS]);
    for i in 0..count {
        if lambda[i] == 0.0 {
            continue;
        }
        lambda_max = js_max(lambda_max, lambda[i]);
        for k in 0..DOFS {
            delta[k] += lambda[i] * z[i * DOFS + k];
        }
    }
    for i in 0..count {
        let slack = dot(a, i * DOFS, delta, 0) - b[i];
        if !(slack >= -CONSTRAINT_EPSILON) {
            return QpResult::Failed;
        }
        if !(lambda[i] >= -CONSTRAINT_EPSILON * js_max(1.0, lambda_max)) {
            return QpResult::Failed;
        }
        if !((lambda[i] * slack).abs() <= CONSTRAINT_EPSILON * js_max(1.0, lambda[i].abs())) {
            return QpResult::Failed;
        }
    }
    QpResult::Optimal
}

#[cfg(test)]
mod tests {
    //! `tests/rig/arm-qp.test.ts`: the kernel against a converged Hildreth reference, on box and
    //! clearance rows shaped like the solver's own; and the recorded `solveDualActiveSet` calls.
    use super::*;
    use crate::corpus_replay::Corpus;
    use crate::math::f::hypot;

    /// Joints u is pushed past, in order: an upper, a lower and an upper stop.
    const ACTIVE: [(usize, f64); 3] = [(4, 1.0), (6, -1.0), (2, 1.0)];
    /// The joint whose lower and upper stops coincide.
    const PAIR_DOF: usize = 1;
    const REFERENCE_SWEEPS: usize = 20_000;

    struct Case {
        coupling: f64,
        active_box_rows: usize,
        projection_rank: usize,
        clearance_rows: usize,
        on_stop: bool,
        opposite_dependent_pair: bool,
        feasible: bool,
    }

    /// coverwise pairwise over the seven factors; `feasible = no` needs a clearance row.
    #[rustfmt::skip]
    const ROWS: [(f64, usize, usize, usize, bool, bool, bool); 18] = [
        (-0.999, 1, 7, 1, false, false, false),
        (-0.5, 3, 7, 2, true, true, true),
        (-0.999, 2, 6, 2, true, false, false),
        (0.999, 1, 6, 0, false, true, true),
        (0.0, 2, 7, 0, true, false, true),
        (0.5, 2, 5, 2, false, true, false),
        (0.0, 1, 5, 1, true, true, false),
        (0.999, 3, 5, 1, true, false, false),
        (0.0, 3, 6, 2, false, true, false),
        (0.999, 2, 7, 1, true, true, true),
        (-0.5, 2, 6, 1, false, false, false),
        (-0.999, 3, 5, 0, false, true, true),
        (0.5, 1, 6, 1, true, false, true),
        (-0.5, 1, 5, 0, true, true, true),
        (0.5, 1, 5, 0, false, true, true),
        (0.999, 1, 6, 2, false, false, false),
        (0.5, 1, 7, 2, true, false, true),
        (0.5, 3, 6, 1, true, true, true),
    ];

    fn mulberry32(seed: u32) -> impl FnMut() -> f64 {
        let mut state = seed;
        move || {
            state = state.wrapping_add(0x6d2b_79f5);
            let mut t = state;
            t = (t ^ (t >> 15)).wrapping_mul(t | 1);
            t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
            (t ^ (t >> 14)) as f64 / 4_294_967_296.0
        }
    }

    fn dotv(a: &[f64], b: &[f64]) -> f64 {
        dot(a, 0, b, 0)
    }

    fn normalized(v: &[f64]) -> Vec<f64> {
        let length = hypot(v);
        v.iter().map(|x| x / length).collect()
    }

    type M = Vec<Vec<f64>>;

    /// P = I − VVᵀ over the first `7 − rank` of the orthonormalized ones and alternating vectors.
    fn projector(rank: usize) -> M {
        let ones = normalized(&[1.0; DOFS]);
        let alternating: Vec<f64> = (0..DOFS)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let along = dotv(&alternating, &ones);
        let second = normalized(
            &alternating
                .iter()
                .zip(&ones)
                .map(|(x, o)| x - along * o)
                .collect::<Vec<_>>(),
        );
        let removed: Vec<&Vec<f64>> = [&ones, &second].into_iter().take(DOFS - rank).collect();
        (0..DOFS)
            .map(|i| {
                (0..DOFS)
                    .map(|j| {
                        let identity = if i == j { 1.0 } else { 0.0 };
                        identity - removed.iter().fold(0.0, |sum, v| sum + v[i] * v[j])
                    })
                    .collect()
            })
            .collect()
    }

    fn apply(m: &M, v: &[f64]) -> Vec<f64> {
        m.iter()
            .map(|row| row.iter().zip(v).fold(0.0, |sum, (x, y)| sum + x * y))
            .collect()
    }

    /// Gauss–Jordan inverse of a small symmetric positive-definite matrix.
    fn invert(m: &M) -> M {
        let n = m.len();
        let mut a: M = m
            .iter()
            .enumerate()
            .map(|(i, row)| {
                let mut r = row.clone();
                r.extend((0..n).map(|j| if i == j { 1.0 } else { 0.0 }));
                r
            })
            .collect();
        for col in 0..n {
            let mut pivot = col;
            for r in col + 1..n {
                if a[r][col].abs() > a[pivot][col].abs() {
                    pivot = r;
                }
            }
            a.swap(col, pivot);
            let scale = a[col][col];
            for j in 0..2 * n {
                a[col][j] /= scale;
            }
            for r in 0..n {
                if r == col {
                    continue;
                }
                let factor = a[r][col];
                for j in 0..2 * n {
                    a[r][j] -= factor * a[col][j];
                }
            }
        }
        a.into_iter().map(|row| row[n..].to_vec()).collect()
    }

    /// Move `v` within range(P) until its coordinates in `dofs` are zero.
    fn zero_within_range(p: &M, v: Vec<f64>, dofs: &[usize]) -> Vec<f64> {
        if dofs.is_empty() {
            return v;
        }
        let columns: Vec<Vec<f64>> = dofs
            .iter()
            .map(|&d| p.iter().map(|row| row[d]).collect())
            .collect();
        let gram: M = (0..dofs.len())
            .map(|i| dofs.iter().map(|&d| columns[i][d]).collect())
            .collect();
        let weights = apply(
            &invert(&gram),
            &dofs.iter().map(|&d| v[d]).collect::<Vec<_>>(),
        );
        v.iter()
            .enumerate()
            .map(|(k, x)| {
                x - columns
                    .iter()
                    .zip(&weights)
                    .fold(0.0, |sum, (column, w)| sum + w * column[k])
            })
            .collect()
    }

    struct Problem {
        rows: Vec<f64>,
        b: Vec<f64>,
        z: Vec<f64>,
        u: Vec<f64>,
        count: usize,
        /// Box rows (outside the coincident pair) that u violates.
        crossed: usize,
        feasible_point: Vec<f64>,
    }

    fn build(c: &Case, seed: u32) -> Problem {
        let mut random = mulberry32(seed);
        let p = projector(c.projection_rank);
        let mut h: M = (0..DOFS)
            .map(|i| (0..DOFS).map(|j| if i == j { 1.0 } else { 0.0 }).collect())
            .collect();
        h[ACTIVE[0].0][ACTIVE[1].0] = c.coupling;
        h[ACTIVE[1].0][ACTIVE[0].0] = c.coupling;
        let metric = invert(&h);
        let pair = c.opposite_dependent_pair;

        let mut pinned = Vec::new();
        if c.on_stop {
            pinned.push(ACTIVE[0].0);
        }
        if pair {
            pinned.push(PAIR_DOF);
        }
        let start: Vec<f64> = (0..DOFS).map(|_| 0.4 * random() - 0.2).collect();
        let feasible_point = zero_within_range(&p, apply(&p, &start), &pinned);
        let mut push = vec![0.0; DOFS];
        for &(dof, sign) in &ACTIVE[..c.active_box_rows] {
            push[dof] = 0.8 * sign;
        }
        let pushed = apply(&p, &push);
        let u: Vec<f64> = feasible_point
            .iter()
            .zip(&pushed)
            .map(|(x, y)| x + y)
            .collect();

        let mut rows: Vec<(Vec<f64>, f64)> = Vec::new();
        for dof in 0..DOFS {
            let active = ACTIVE[..c.active_box_rows]
                .iter()
                .position(|&(d, _)| d == dof);
            let (lower, upper) = if pair && dof == PAIR_DOF {
                (0.0, 0.0)
            } else if let Some(active) = active {
                let slack = if c.on_stop && active == 0 { 0.0 } else { 0.05 };
                if ACTIVE[active].1 > 0.0 {
                    (
                        js_min(feasible_point[dof], u[dof]) - 0.5,
                        feasible_point[dof] + slack,
                    )
                } else {
                    (
                        feasible_point[dof] - slack,
                        js_max(feasible_point[dof], u[dof]) + 0.5,
                    )
                }
            } else {
                (
                    js_min(feasible_point[dof], u[dof]) - 0.3,
                    js_max(feasible_point[dof], u[dof]) + 0.3,
                )
            };
            let mut axis = vec![0.0; DOFS];
            axis[dof] = 1.0;
            rows.push((axis.clone(), lower));
            rows.push((axis.iter().map(|x| -x).collect(), -upper));
        }
        let mut crossed = 0;
        for dof in 0..DOFS {
            if pair && dof == PAIR_DOF {
                continue;
            }
            for (a, b) in &rows[2 * dof..2 * dof + 2] {
                if dotv(a, &u) < *b {
                    crossed += 1;
                }
            }
        }

        let away = normalized(
            &u.iter()
                .zip(&feasible_point)
                .map(|(x, f)| f - x)
                .collect::<Vec<_>>(),
        );
        for i in 0..c.clearance_rows {
            if !c.feasible && i == 0 {
                // Demands the first active joint sit past the stop u was pushed through.
                let mut axis = vec![0.0; DOFS];
                axis[ACTIVE[0].0] = 1.0;
                let b = -rows[2 * ACTIVE[0].0 + 1].1 + 0.1;
                rows.push((axis, b));
                continue;
            }
            let a = normalized(
                &away
                    .iter()
                    .map(|x| x + 0.6 * (2.0 * random() - 1.0))
                    .collect::<Vec<_>>(),
            );
            let b = dotv(&a, &feasible_point) - 0.02;
            rows.push((a, b));
        }

        let count = rows.len();
        let mut flat = vec![0.0; count * DOFS];
        let mut b = vec![0.0; count];
        let mut z = vec![0.0; count * DOFS];
        for (i, (a, bi)) in rows.iter().enumerate() {
            flat[i * DOFS..(i + 1) * DOFS].copy_from_slice(a);
            b[i] = *bi;
            z[i * DOFS..(i + 1) * DOFS].copy_from_slice(&apply(&p, &apply(&metric, &apply(&p, a))));
        }
        Problem {
            rows: flat,
            b,
            z,
            u,
            count,
            crossed,
            feasible_point,
        }
    }

    /// Hildreth's dual coordinate ascent, run to convergence.
    fn hildreth(problem: &Problem) -> (Vec<f64>, Vec<f64>) {
        let Problem {
            rows,
            b,
            z,
            u,
            count,
            ..
        } = problem;
        let mut delta = u.clone();
        let mut lambda = vec![0.0; *count];
        let denominator: Vec<f64> = (0..*count)
            .map(|i| dot(rows, i * DOFS, z, i * DOFS))
            .collect();
        for _ in 0..REFERENCE_SWEEPS {
            for i in 0..*count {
                let next = js_max(
                    0.0,
                    lambda[i] + (b[i] - dot(rows, i * DOFS, &delta, 0)) / denominator[i],
                );
                let change = next - lambda[i];
                lambda[i] = next;
                for k in 0..DOFS {
                    delta[k] += z[i * DOFS + k] * change;
                }
            }
        }
        (delta, lambda)
    }

    #[test]
    fn solves_every_pairwise_case_to_the_hildreth_reference() {
        let mut scratch = make_qp_scratch();
        for (index, &(coupling, active, rank, clearance, on_stop, pair, feasible)) in
            ROWS.iter().enumerate()
        {
            let c = Case {
                coupling,
                active_box_rows: active,
                projection_rank: rank,
                clearance_rows: clearance,
                on_stop,
                opposite_dependent_pair: pair,
                feasible,
            };
            let problem = build(&c, 1000 + index as u32);
            let Problem {
                rows,
                b,
                z,
                u,
                count,
                ..
            } = &problem;
            let count = *count;
            assert_eq!(
                problem.crossed, active,
                "case {index}: u crosses the intended stops"
            );
            for i in 0..count {
                if !feasible && i == count - clearance {
                    continue;
                }
                assert!(dot(rows, i * DOFS, &problem.feasible_point, 0) >= b[i] - 1e-12);
            }

            let mut delta = vec![0.0; DOFS];
            let mut lambda = vec![0.0; count];
            let result =
                solve_dual_active_set(rows, b, z, count, u, &mut delta, &mut lambda, &mut scratch);
            if !feasible {
                assert_eq!(result, QpResult::Infeasible, "case {index}");
                continue;
            }
            assert_eq!(result, QpResult::Optimal, "case {index}");

            // The reference itself must have converged, or the construction is wrong.
            let (reference_delta, reference_lambda) = hildreth(&problem);
            for i in 0..count {
                let slack = dot(rows, i * DOFS, &reference_delta, 0) - b[i];
                assert!(slack >= -1e-13, "case {index}: reference row {i}");
                assert!((reference_lambda[i] * slack).abs() <= 1e-12);
            }

            let lambda_max = lambda.iter().fold(0.0, |m, &l| js_max(m, l));
            for i in 0..count {
                let slack = dot(rows, i * DOFS, &delta, 0) - b[i];
                assert!(slack >= -CONSTRAINT_EPSILON, "case {index}: row {i}");
                assert!(lambda[i] >= -CONSTRAINT_EPSILON * js_max(1.0, lambda_max));
                assert!(
                    (lambda[i] * slack).abs() <= CONSTRAINT_EPSILON * js_max(1.0, lambda[i].abs())
                );
            }
            // Stationarity: δ = u + Σ λ_i z_i.
            for k in 0..DOFS {
                let mut expected = u[k];
                for i in 0..count {
                    expected += lambda[i] * z[i * DOFS + k];
                }
                assert!((delta[k] - expected).abs() < 1e-12);
            }
            let mut gap = 0.0;
            for k in 0..DOFS {
                gap = hypot(&[gap, delta[k] - reference_delta[k]]);
            }
            assert!(gap < 1e-9, "case {index}: {gap}");
        }
    }

    fn bits(values: &[f64]) -> Vec<u64> {
        values.iter().map(|v| v.to_bits()).collect()
    }

    #[test]
    fn replays_the_recorded_calls_bit_for_bit() {
        let corpus = Corpus::load("solveDualActiveSet");
        assert!(corpus.cases() > 0);
        for (n, case) in corpus.iter().enumerate() {
            let count = case.scalar("count", false) as usize;
            let mut u = case.input("u").to_vec();
            let mut delta = case.input("delta").to_vec();
            let mut lambda = case.input("lambda").to_vec();
            let mut scratch = make_qp_scratch();
            for (k, &w) in case.input("scratch.working").iter().enumerate() {
                scratch.working[k] = w as i32;
            }
            scratch.gram.copy_from_slice(case.input("scratch.gram"));
            scratch
                .gram_factor
                .copy_from_slice(case.input("scratch.gramFactor"));
            scratch.r.copy_from_slice(case.input("scratch.r"));
            scratch.d.copy_from_slice(case.input("scratch.d"));
            let result = solve_dual_active_set(
                case.input("A"),
                case.input("b"),
                case.input("Z"),
                count,
                &u,
                &mut delta,
                &mut lambda,
                &mut scratch,
            );
            u.truncate(DOFS);
            let index = match result {
                QpResult::Optimal => 0.0,
                QpResult::Infeasible => 1.0,
                QpResult::Failed => 2.0,
            };
            assert_eq!(index, case.scalar("return", true), "case {n}: result");
            let working: Vec<f64> = scratch.working.iter().map(|&w| w as f64).collect();
            for (name, got) in [
                ("u", &u[..]),
                ("delta", &delta[..]),
                ("lambda", &lambda[..]),
                ("scratch.working", &working[..]),
                ("scratch.gram", &scratch.gram[..]),
                ("scratch.gramFactor", &scratch.gram_factor[..]),
                ("scratch.r", &scratch.r[..]),
                ("scratch.d", &scratch.d[..]),
            ] {
                assert_eq!(bits(got), bits(case.output(name)), "case {n}: {name}");
            }
        }
    }
}
