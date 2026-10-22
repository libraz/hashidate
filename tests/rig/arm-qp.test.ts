import { describe, expect, it } from 'vitest';
import {
  CONSTRAINT_EPSILON,
  makeQpScratch,
  type QpResult,
  solveDualActiveSet,
} from '@/engine/rig/arm-qp';

/**
 * The arm solver's constrained-step kernel against a converged Hildreth
 * reference, on box and clearance rows shaped like the solver's own: stops
 * that meet at a corner, a coupled metric, a projected (nullspace) step.
 */

const DOFS = 7;
/** Joints u is pushed past, in order: an upper, a lower and an upper stop. */
const ACTIVE: readonly { dof: number; sign: 1 | -1 }[] = [
  { dof: 4, sign: 1 },
  { dof: 6, sign: -1 },
  { dof: 2, sign: 1 },
];
/** The joint whose lower and upper stops coincide. */
const PAIR_DOF = 1;
const REFERENCE_SWEEPS = 20_000;

interface Case {
  coupling: number;
  activeBoxRows: number;
  projectionRank: number;
  clearanceRows: number;
  start: 'interior' | 'onStop';
  oppositeDependentPair: 'no' | 'yes';
  feasible: 'yes' | 'no';
}

/** coverwise pairwise over the seven factors; `feasible = no` needs a clearance row. */
const COLUMNS = [
  'coupling',
  'activeBoxRows',
  'projectionRank',
  'clearanceRows',
  'start',
  'oppositeDependentPair',
  'feasible',
] as const;
const ROWS: readonly (readonly (number | string)[])[] = [
  [-0.999, 1, 7, 1, 'interior', 'no', 'no'],
  [-0.5, 3, 7, 2, 'onStop', 'yes', 'yes'],
  [-0.999, 2, 6, 2, 'onStop', 'no', 'no'],
  [0.999, 1, 6, 0, 'interior', 'yes', 'yes'],
  [0, 2, 7, 0, 'onStop', 'no', 'yes'],
  [0.5, 2, 5, 2, 'interior', 'yes', 'no'],
  [0, 1, 5, 1, 'onStop', 'yes', 'no'],
  [0.999, 3, 5, 1, 'onStop', 'no', 'no'],
  [0, 3, 6, 2, 'interior', 'yes', 'no'],
  [0.999, 2, 7, 1, 'onStop', 'yes', 'yes'],
  [-0.5, 2, 6, 1, 'interior', 'no', 'no'],
  [-0.999, 3, 5, 0, 'interior', 'yes', 'yes'],
  [0.5, 1, 6, 1, 'onStop', 'no', 'yes'],
  [-0.5, 1, 5, 0, 'onStop', 'yes', 'yes'],
  [0.5, 1, 5, 0, 'interior', 'yes', 'yes'],
  [0.999, 1, 6, 2, 'interior', 'no', 'no'],
  [0.5, 1, 7, 2, 'onStop', 'no', 'yes'],
  [0.5, 3, 6, 1, 'onStop', 'yes', 'yes'],
];
const CASES: Case[] = ROWS.map(
  (row) => Object.fromEntries(COLUMNS.map((column, i) => [column, row[i]])) as unknown as Case,
);

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>, aOffset = 0, bOffset = 0): number => {
  let sum = 0;
  for (let i = 0; i < DOFS; i++) sum += a[aOffset + i] * b[bOffset + i];
  return sum;
};

function normalize(v: number[]): number[] {
  const length = Math.hypot(...v);
  return v.map((x) => x / length);
}

/** P = I − VVᵀ over the first `7 − rank` of the orthonormalized ones and alternating vectors. */
function projector(rank: number): number[][] {
  const ones = normalize(Array(DOFS).fill(1));
  const alternating = Array.from({ length: DOFS }, (_, i) => (i % 2 === 0 ? 1 : -1));
  const along = dot(alternating, ones);
  const second = normalize(alternating.map((x, i) => x - along * ones[i]));
  const removed = [ones, second].slice(0, DOFS - rank);
  return Array.from({ length: DOFS }, (_, i) =>
    Array.from(
      { length: DOFS },
      (_, j) => (i === j ? 1 : 0) - removed.reduce((sum, v) => sum + v[i] * v[j], 0),
    ),
  );
}

const apply = (m: number[][], v: ArrayLike<number>): number[] =>
  m.map((row) => row.reduce((sum, x, j) => sum + x * v[j], 0));

/** Gauss–Jordan inverse of a small symmetric positive-definite matrix. */
function invert(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const scale = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= scale;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      for (let j = 0; j < 2 * n; j++) a[r][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/** Move `v` within range(P) until its coordinates in `dofs` are zero. */
function zeroWithinRange(p: number[][], v: number[], dofs: number[]): number[] {
  if (dofs.length === 0) return v;
  const columns = dofs.map((d) => p.map((row) => row[d]));
  const gram = dofs.map((_, i) => dofs.map((d) => columns[i][d]));
  const weights = apply(
    invert(gram),
    dofs.map((d) => v[d]),
  );
  return v.map((x, k) => x - columns.reduce((sum, column, i) => sum + weights[i] * column[k], 0));
}

interface Problem {
  rowMatrix: Float64Array;
  b: Float64Array;
  zMatrix: Float64Array;
  u: Float64Array;
  count: number;
  /** Box rows (outside the coincident pair) that u violates. */
  crossed: number;
  feasiblePoint: number[];
}

function build(c: Case, seed: number): Problem {
  const random = mulberry32(seed);
  const p = projector(c.projectionRank);
  const h: number[][] = Array.from({ length: DOFS }, (_, i) =>
    Array.from({ length: DOFS }, (_, j) => (i === j ? 1 : 0)),
  );
  h[ACTIVE[0].dof][ACTIVE[1].dof] = c.coupling;
  h[ACTIVE[1].dof][ACTIVE[0].dof] = c.coupling;
  const metric = invert(h);
  const pair = c.oppositeDependentPair === 'yes';

  const pinned: number[] = [];
  if (c.start === 'onStop') pinned.push(ACTIVE[0].dof);
  if (pair) pinned.push(PAIR_DOF);
  const feasiblePoint = zeroWithinRange(
    p,
    apply(
      p,
      Array.from({ length: DOFS }, () => 0.4 * random() - 0.2),
    ),
    pinned,
  );
  const push = Array(DOFS).fill(0);
  for (let i = 0; i < c.activeBoxRows; i++) push[ACTIVE[i].dof] = 0.8 * ACTIVE[i].sign;
  const pushed = apply(p, push);
  const u = feasiblePoint.map((x, i) => x + pushed[i]);

  const rows: { a: number[]; b: number }[] = [];
  for (let dof = 0; dof < DOFS; dof++) {
    let lower: number;
    let upper: number;
    const active = ACTIVE.findIndex((entry, i) => entry.dof === dof && i < c.activeBoxRows);
    if (pair && dof === PAIR_DOF) {
      lower = 0;
      upper = 0;
    } else if (active >= 0) {
      const slack = c.start === 'onStop' && active === 0 ? 0 : 0.05;
      if (ACTIVE[active].sign > 0) {
        upper = feasiblePoint[dof] + slack;
        lower = Math.min(feasiblePoint[dof], u[dof]) - 0.5;
      } else {
        lower = feasiblePoint[dof] - slack;
        upper = Math.max(feasiblePoint[dof], u[dof]) + 0.5;
      }
    } else {
      lower = Math.min(feasiblePoint[dof], u[dof]) - 0.3;
      upper = Math.max(feasiblePoint[dof], u[dof]) + 0.3;
    }
    const axis = Array(DOFS).fill(0);
    axis[dof] = 1;
    rows.push({ a: axis, b: lower });
    rows.push({ a: axis.map((x) => -x), b: -upper });
  }
  let crossed = 0;
  for (let dof = 0; dof < DOFS; dof++) {
    if (pair && dof === PAIR_DOF) continue;
    for (const row of rows.slice(2 * dof, 2 * dof + 2)) if (dot(row.a, u) < row.b) crossed++;
  }

  const away = normalize(u.map((x, i) => feasiblePoint[i] - x));
  for (let i = 0; i < c.clearanceRows; i++) {
    if (c.feasible === 'no' && i === 0) {
      // Demands the first active joint sit past the stop u was pushed through.
      const axis = Array(DOFS).fill(0);
      axis[ACTIVE[0].dof] = 1;
      rows.push({ a: axis, b: rows[2 * ACTIVE[0].dof + 1].b * -1 + 0.1 });
      continue;
    }
    const a = normalize(away.map((x) => x + 0.6 * (2 * random() - 1)));
    rows.push({ a, b: dot(a, feasiblePoint) - 0.02 });
  }

  const count = rows.length;
  const rowMatrix = new Float64Array(count * DOFS);
  const b = new Float64Array(count);
  const zMatrix = new Float64Array(count * DOFS);
  rows.forEach((row, i) => {
    rowMatrix.set(row.a, i * DOFS);
    b[i] = row.b;
    zMatrix.set(apply(p, apply(metric, apply(p, row.a))), i * DOFS);
  });
  return { rowMatrix, b, zMatrix, u: Float64Array.from(u), count, crossed, feasiblePoint };
}

/** Hildreth's dual coordinate ascent, run to convergence. */
function hildreth(problem: Problem): { delta: Float64Array; lambda: Float64Array } {
  const { rowMatrix, b, zMatrix, u, count } = problem;
  const delta = Float64Array.from(u);
  const lambda = new Float64Array(count);
  const denominator = Array.from({ length: count }, (_, i) =>
    dot(rowMatrix, zMatrix, i * DOFS, i * DOFS),
  );
  for (let sweep = 0; sweep < REFERENCE_SWEEPS; sweep++) {
    for (let i = 0; i < count; i++) {
      const next = Math.max(
        0,
        lambda[i] + (b[i] - dot(rowMatrix, delta, i * DOFS)) / denominator[i],
      );
      const change = next - lambda[i];
      lambda[i] = next;
      for (let k = 0; k < DOFS; k++) delta[k] += zMatrix[i * DOFS + k] * change;
    }
  }
  return { delta, lambda };
}

const scratch = makeQpScratch();

describe('solveDualActiveSet', () => {
  it.each(CASES.map((c, i) => [i, c] as const))('case %i %o', (index, c) => {
    const problem = build(c, 1000 + index);
    const { rowMatrix, b, zMatrix, u, count } = problem;
    expect(problem.crossed, 'u crosses the intended stops').toBe(c.activeBoxRows);
    for (let i = 0; i < count; i++) {
      if (c.feasible === 'no' && i === count - c.clearanceRows) continue;
      expect(dot(rowMatrix, problem.feasiblePoint, i * DOFS)).toBeGreaterThanOrEqual(b[i] - 1e-12);
    }

    const delta = new Float64Array(DOFS);
    const lambda = new Float64Array(count);
    const result: QpResult = solveDualActiveSet(
      rowMatrix,
      b,
      zMatrix,
      count,
      u,
      delta,
      lambda,
      scratch,
    );
    if (c.feasible === 'no') {
      expect(result).toBe('infeasible');
      return;
    }
    expect(result).toBe('optimal');

    // The reference itself must have converged, or the construction is wrong.
    const reference = hildreth(problem);
    for (let i = 0; i < count; i++) {
      const slack = dot(rowMatrix, reference.delta, i * DOFS) - b[i];
      expect(slack, `reference row ${i}`).toBeGreaterThanOrEqual(-1e-13);
      expect(Math.abs(reference.lambda[i] * slack), `reference row ${i}`).toBeLessThanOrEqual(
        1e-12,
      );
    }

    let lambdaMax = 0;
    for (let i = 0; i < count; i++) lambdaMax = Math.max(lambdaMax, lambda[i]);
    for (let i = 0; i < count; i++) {
      const slack = dot(rowMatrix, delta, i * DOFS) - b[i];
      expect(slack, `row ${i}`).toBeGreaterThanOrEqual(-CONSTRAINT_EPSILON);
      expect(lambda[i], `row ${i}`).toBeGreaterThanOrEqual(
        -CONSTRAINT_EPSILON * Math.max(1, lambdaMax),
      );
      expect(Math.abs(lambda[i] * slack), `row ${i}`).toBeLessThanOrEqual(
        CONSTRAINT_EPSILON * Math.max(1, Math.abs(lambda[i])),
      );
    }
    // Stationarity: δ = u + Σ λ_i z_i.
    for (let k = 0; k < DOFS; k++) {
      let expected = u[k];
      for (let i = 0; i < count; i++) expected += lambda[i] * zMatrix[i * DOFS + k];
      expect(Math.abs(delta[k] - expected)).toBeLessThan(1e-12);
    }
    let gap = 0;
    for (let k = 0; k < DOFS; k++) gap = Math.hypot(gap, delta[k] - reference.delta[k]);
    expect(gap).toBeLessThan(1e-9);
  });
});
