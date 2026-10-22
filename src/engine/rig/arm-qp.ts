/**
 * @file The arm solver's constrained-step kernel: a dual active-set QP over
 * linear rows `a_i·δ ≥ b_i` in seven joint coordinates.
 *
 * The Gram matrix of the working set is held explicitly and refactored on every
 * change, which is cheap because at most seven independent rows can be active.
 * Termination is finite rather than geometric: a full step strictly raises the
 * dual objective and a partial step shrinks the working set, so the convergence
 * rate no longer depends on the angle between two active stops in the metric.
 * Imports nothing, so it can be driven directly with any metric.
 */

const DOFS = 7;

/** Absolute row violation accepted as satisfied, in the row's own units. */
export const CONSTRAINT_EPSILON = 2e-10;
/** A candidate row whose curvature against the working set is below τ·(a·z) is dependent on it. */
export const DEPENDENCY_TOLERANCE = 1e-10;

export type QpResult = 'optimal' | 'infeasible' | 'failed';

export interface QpScratch {
  /** Row indices of the working set, in insertion order. */
  working: Int32Array;
  gram: Float64Array;
  gramFactor: Float64Array;
  r: Float64Array;
  d: Float64Array;
}

export function makeQpScratch(): QpScratch {
  return {
    working: new Int32Array(DOFS),
    gram: new Float64Array(DOFS * DOFS),
    gramFactor: new Float64Array(DOFS * DOFS),
    r: new Float64Array(DOFS),
    d: new Float64Array(DOFS),
  };
}

function dot(a: Float64Array, aOffset: number, b: Float64Array, bOffset: number): number {
  let sum = 0;
  for (let k = 0; k < DOFS; k++) sum += a[aOffset + k] * b[bOffset + k];
  return sum;
}

/** Rebuild G_W = A_W Z_Wᵀ and its Cholesky factor; false when a pivot is not positive. */
function factorGram(A: Float64Array, Z: Float64Array, size: number, scratch: QpScratch): boolean {
  const { working, gram, gramFactor } = scratch;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= i; j++) {
      gram[i * DOFS + j] = dot(A, working[i] * DOFS, Z, working[j] * DOFS);
    }
  }
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = gram[i * DOFS + j];
      for (let k = 0; k < j; k++) sum -= gramFactor[i * DOFS + k] * gramFactor[j * DOFS + k];
      if (i === j) {
        if (!(sum > 0 && Number.isFinite(sum))) return false;
        gramFactor[i * DOFS + i] = Math.sqrt(sum);
      } else {
        gramFactor[i * DOFS + j] = sum / gramFactor[j * DOFS + j];
      }
    }
  }
  return true;
}

/** Solve G_W r = r in place with the current factor. */
function solveGram(size: number, scratch: QpScratch): void {
  const { gramFactor: l, r } = scratch;
  for (let i = 0; i < size; i++) {
    let sum = r[i];
    for (let k = 0; k < i; k++) sum -= l[i * DOFS + k] * r[k];
    r[i] = sum / l[i * DOFS + i];
  }
  for (let i = size - 1; i >= 0; i--) {
    let sum = r[i];
    for (let k = i + 1; k < size; k++) sum -= l[k * DOFS + i] * r[k];
    r[i] = sum / l[i * DOFS + i];
  }
}

/**
 * Dual active-set on the rows a_i·δ ≥ b_i, with Z holding one z_i per row and
 * stationarity δ = u + Σ λ_i z_i. In the primary step z_i = H⁻¹a_i; in the
 * nullspace step the caller passes z_i = P H⁻¹ P a_i, and the same iteration applies.
 *
 * Rows and z_i are stored with stride 7 in `A` and `Z`; `lambda` needs `count`
 * entries. Writes δ and λ in every outcome, but only `'optimal'` certifies them:
 * every row holds within `CONSTRAINT_EPSILON`, λ is non-negative and
 * complementary to the slack. `'infeasible'` means a violated row is a
 * non-negative combination's opposite of the working set, so no damping of the
 * metric can satisfy it; `'failed'` means a rounding breakdown or the iteration
 * cap, 3·(count + 7).
 */
export function solveDualActiveSet(
  A: Float64Array,
  b: Float64Array,
  Z: Float64Array,
  count: number,
  u: Float64Array,
  delta: Float64Array,
  lambda: Float64Array,
  scratch: QpScratch,
): QpResult {
  const { working, r, d } = scratch;
  for (let k = 0; k < DOFS; k++) delta[k] = u[k];
  lambda.fill(0, 0, count);
  let size = 0;
  const limit = 3 * (count + DOFS);
  let iterations = 0;

  for (;;) {
    // Most violated row outside the working set; ties go to the smallest index.
    let p = -1;
    let worst = CONSTRAINT_EPSILON;
    for (let i = 0; i < count; i++) {
      let member = false;
      for (let k = 0; k < size; k++) if (working[k] === i) member = true;
      if (member) continue;
      const violation = b[i] - dot(A, i * DOFS, delta, 0);
      if (violation > worst) {
        worst = violation;
        p = i;
      }
    }
    if (p < 0) break;
    const pOffset = p * DOFS;
    const denominator = dot(A, pOffset, Z, pOffset);

    for (;;) {
      if (++iterations > limit) return 'failed';
      for (let k = 0; k < size; k++) r[k] = dot(A, working[k] * DOFS, Z, pOffset);
      solveGram(size, scratch);
      for (let j = 0; j < DOFS; j++) {
        let value = Z[pOffset + j];
        for (let k = 0; k < size; k++) value -= r[k] * Z[working[k] * DOFS + j];
        d[j] = value;
      }
      const curvature = dot(A, pOffset, d, 0);

      // Largest dual step before a working row's multiplier reaches zero.
      let dualStep = Number.POSITIVE_INFINITY;
      let blocking = -1;
      for (let k = 0; k < size; k++) {
        if (!(r[k] > 0)) continue;
        const ratio = lambda[working[k]] / r[k];
        if (ratio < dualStep || (ratio === dualStep && working[k] < working[blocking])) {
          dualStep = ratio;
          blocking = k;
        }
      }

      let step: number;
      if (curvature <= DEPENDENCY_TOLERANCE * denominator) {
        if (blocking < 0) return 'infeasible';
        step = dualStep;
      } else {
        const primalStep = (b[p] - dot(A, pOffset, delta, 0)) / curvature;
        step = Math.min(primalStep, dualStep);
        for (let j = 0; j < DOFS; j++) delta[j] += step * d[j];
        if (primalStep <= dualStep) {
          for (let k = 0; k < size; k++) lambda[working[k]] -= step * r[k];
          lambda[p] += step;
          working[size++] = p;
          if (!factorGram(A, Z, size, scratch)) return 'failed';
          break;
        }
      }
      for (let k = 0; k < size; k++) lambda[working[k]] -= step * r[k];
      lambda[p] += step;
      lambda[working[blocking]] = 0;
      for (let k = blocking; k < size - 1; k++) working[k] = working[k + 1];
      size--;
      if (!factorGram(A, Z, size, scratch)) return 'failed';
    }
  }

  // Rebuild δ from λ so the certificate checks the stationary point itself.
  let lambdaMax = 0;
  for (let k = 0; k < DOFS; k++) delta[k] = u[k];
  for (let i = 0; i < count; i++) {
    if (lambda[i] === 0) continue;
    lambdaMax = Math.max(lambdaMax, lambda[i]);
    for (let k = 0; k < DOFS; k++) delta[k] += lambda[i] * Z[i * DOFS + k];
  }
  for (let i = 0; i < count; i++) {
    const slack = dot(A, i * DOFS, delta, 0) - b[i];
    if (!(slack >= -CONSTRAINT_EPSILON)) return 'failed';
    if (!(lambda[i] >= -CONSTRAINT_EPSILON * Math.max(1, lambdaMax))) return 'failed';
    if (!(Math.abs(lambda[i] * slack) <= CONSTRAINT_EPSILON * Math.max(1, Math.abs(lambda[i]))))
      return 'failed';
  }
  return 'optimal';
}
