import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINGER_WIDTH, JOINTS } from '@/engine/anatomy';
import { ReachAnchors } from '@/engine/motion/anchors';
import type { Side } from '@/engine/types';
import { DT, fingerDepth, harness } from './harness';

const step = (h: ReturnType<typeof harness>): void => {
  h.rig.reset();
  h.body.update(DT);
};

afterEach(() => vi.restoreAllMocks());

const SIDES: readonly Side[] = ['L', 'R'];
const FPS = [30, 60, 120] as const;
const ROUTES = [
  { from: 'listen', to: 'cover' },
  { from: 'cover', to: 'listen' },
  { from: 'cuteSalute', to: 'cover' },
  { from: 'cover', to: 'cuteSalute' },
] as const;
const ROUTE_CASES = ROUTES.flatMap((route) =>
  SIDES.flatMap((side) => FPS.map((fps) => ({ ...route, side, fps }))),
);
const STOP_CASES = ['listen', 'cuteSalute'].flatMap((from) =>
  SIDES.flatMap((side) => FPS.map((fps) => ({ from, side, fps }))),
);

const HARD_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  rotation: JOINTS.shoulder.dofs.rotation.max,
  elbow: JOINTS.elbow.dofs.flexion.max,
  forearm: JOINTS.elbow.dofs.rotation.max,
  wristFlex: JOINTS.wrist.dofs.flexion.max,
  wristDev: JOINTS.wrist.dofs.deviation.max,
};

interface SafetyTrace {
  clearance: number;
  deepest: number;
  hardExcess: number;
  queryExcess: number;
  invalidRows: number;
  measuredRows: number;
}

function safetyTrace(h: ReturnType<typeof harness>, side: Side): SafetyTrace {
  const clearance = 0.5 * FINGER_WIDTH * (h.profile.limb?.[`pitch.${side}`] ?? 0);
  const trace: SafetyTrace = {
    clearance,
    deepest: 0,
    hardExcess: 0,
    queryExcess: 0,
    invalidRows: 0,
    measuredRows: 0,
  };
  const depth = fingerDepth(h, side);
  trace.deepest = Math.max(trace.deepest, depth);
  const rows = h.rig.measure(side);
  if (!rows) {
    trace.invalidRows++;
    return trace;
  }
  for (const row of rows) {
    if (!row.measured) continue;
    trace.measuredRows++;
    const [lo, hi] = row.range;
    if (![row.deg, row.strain, lo, hi].every(Number.isFinite) || lo > hi) {
      trace.invalidRows++;
      continue;
    }
    trace.queryExcess = Math.max(trace.queryExcess, lo - row.deg, row.deg - hi, 0);
    const hard = HARD_RANGES[row.id];
    if (hard) {
      const hardLo = (hard[0] * 180) / Math.PI;
      const hardHi = (hard[1] * 180) / Math.PI;
      trace.hardExcess = Math.max(trace.hardExcess, hardLo - row.deg, row.deg - hardHi, 0);
    }
  }
  return trace;
}

function mergeTrace(into: SafetyTrace, next: SafetyTrace): void {
  into.deepest = Math.max(into.deepest, next.deepest);
  into.hardExcess = Math.max(into.hardExcess, next.hardExcess);
  into.queryExcess = Math.max(into.queryExcess, next.queryExcess);
  into.invalidRows += next.invalidRows;
  into.measuredRows = Math.max(into.measuredRows, next.measuredRows);
}

function emptyTrace(h: ReturnType<typeof harness>, side: Side): SafetyTrace {
  return {
    clearance: 0.5 * FINGER_WIDTH * (h.profile.limb?.[`pitch.${side}`] ?? 0),
    deepest: 0,
    hardExcess: 0,
    queryExcess: 0,
    invalidRows: 0,
    measuredRows: 0,
  };
}

function assertSafe(trace: SafetyTrace, label: string): void {
  expect(trace.clearance, `${label}: synthetic finger clearance`).toBeGreaterThan(0);
  expect(trace.deepest, `${label}: deepest finger point`).toBeLessThan(trace.clearance);
  expect(trace.hardExcess, `${label}: joint hard-stop excess`).toBeLessThanOrEqual(1e-4);
  expect(
    trace.queryExcess,
    `${label}: measured joint outside returned query bounds`,
  ).toBeLessThanOrEqual(1e-4);
  expect(trace.invalidRows, `${label}: non-finite or malformed joint query`).toBe(0);
  expect(trace.measuredRows, `${label}: at least one measured joint`).toBeGreaterThan(0);
}

function transitionSafety(from: string, to: string, side: Side, fps: number): void {
  const h = harness(0, { random: () => 0.5 });
  const dt = 1 / fps;
  const step = () => {
    h.rig.reset();
    h.body.update(dt);
  };
  step();
  h.body.play(from, side);
  const outgoing = h.body.gesture;
  if (!outgoing) throw new Error(`${from} did not start`);
  for (let i = 0; i < Math.ceil((outgoing.lead + 0.15) / dt); i++) step();
  if (h.body.gesture?.id !== from || h.body.blend !== 1)
    throw new Error(`${from} did not reach a committed pose before switching`);

  h.body.play(to, side);
  const trace = emptyTrace(h, side);
  for (let i = 0; i < Math.ceil(1.05 / dt); i++) {
    step();
    mergeTrace(trace, safetyTrace(h, side));
  }
  assertSafe(trace, `${from}→${to} ${side} ${fps}Hz`);
}

function stoppedEntranceSafety(from: string, side: Side, fps: number): void {
  const h = harness(0, { random: () => 0.5 });
  const dt = 1 / fps;
  const step = () => {
    h.rig.reset();
    h.body.update(dt);
  };
  step();
  h.body.play(from, side);
  const outgoing = h.body.gesture;
  if (!outgoing) throw new Error(`${from} did not start`);
  for (let i = 0; i < Math.ceil((outgoing.lead + 0.15) / dt); i++) step();

  h.body.play('cover', side);
  const trace = emptyTrace(h, side);
  for (let i = 0; i < Math.ceil(0.18 / dt); i++) {
    step();
    mergeTrace(trace, safetyTrace(h, side));
  }
  h.body.stopGesture();
  for (let i = 0; i < Math.ceil(0.8 / dt); i++) {
    step();
    mergeTrace(trace, safetyTrace(h, side));
  }
  assertSafe(trace, `${from}→cover→stop ${side} ${fps}Hz`);
}

describe('face clearance during a reach', () => {
  it('clears the destination before carrying the wrist through a listen-to-cover transition', () => {
    const h = harness(0, { random: () => 0.5 });
    for (let i = 0; i < 30; i++) step(h);
    h.body.play('listen', 'R');
    for (let i = 0; i < 120; i++) step(h);

    const targets: THREE.Vector3[] = [];
    let frameTarget: THREE.Vector3 | null = null;
    const solve = h.rig.solveReachNatural.bind(h.rig);
    vi.spyOn(h.rig, 'solveReachNatural').mockImplementation((side, target, hand, out, pole) => {
      if (side === 'R') frameTarget = target.clone();
      return solve(side, target, hand, out, pole);
    });

    h.body.play('cover', 'R');
    // `play` resolves a distance probe and the two live slots can both solve
    // the same side. Keep one final incoming target from each actual frame.
    frameTarget = null;
    for (let i = 0; i < 150; i++) {
      step(h);
      if (frameTarget) targets.push(frameTarget);
      frameTarget = null;
    }

    const steps = targets.slice(1).map((target, i) => target.distanceTo(targets[i]));
    expect(targets.length).toBeGreaterThan(100);
    // Endpoint clearance used to be applied after travel, which turned one
    // small pose change into a 12.5 cm wrist-target step on this transition.
    expect(Math.max(...steps)).toBeLessThan(0.06);
  });

  it('keeps a frozen-pose search boundary bounded across adjacent requests', () => {
    const h = harness(0, { random: () => 0.5 });
    for (let i = 0; i < 30; i++) step(h);
    h.body.play('listen', 'R');
    for (let i = 0; i < 120; i++) step(h);
    h.body.play('cover', 'R');
    for (let i = 0; i < 23; i++) step(h);

    const original = ReachAnchors.prototype.clearReached;
    let oneMicrometreOutputStep: number | undefined;
    let cutoffResolved: readonly [boolean, boolean] | undefined;
    vi.spyOn(ReachAnchors.prototype, 'clearReached').mockImplementation(function (
      this: ReachAnchors,
      target,
      reach,
      side,
      frameReady,
    ) {
      if (oneMicrometreOutputStep === undefined && side === 'R' && reach.at === 'mouth') {
        const center = target.clone();
        const face = h.rig.anat?.face;
        const faceProfile = h.profile.face;
        const head = h.profile.bones.head;
        if (!(face && faceProfile && head)) throw new Error('synthetic rig has no measured face');
        face.refresh();
        head.updateWorldMatrix(true, false);
        const outward = faceProfile.forward.clone().transformDirection(head.matrixWorld);
        const frame = h.rig.fingerFrame(side).clone();
        const shape = h.rig.fingerShape(side).map((point) => point.clone());
        const clear = h.rig.fingerClearance(side);
        const fingerReach = Math.max(...shape.map((point) => point.length()));
        const cap = fingerReach + clear;
        const oldGrid = Math.floor(cap / clear) * clear;
        const normalScratch = new THREE.Vector3();
        const clearAt = (input: THREE.Vector3, offset: number): boolean => {
          for (const local of shape) {
            const point = local
              .clone()
              .applyMatrix3(frame)
              .add(input)
              .addScaledVector(outward, offset);
            if (face.shortfall(point, clear, normalScratch) > 0) return false;
          }
          return true;
        };
        const targetAt = (offset: number): THREE.Vector3 =>
          center.clone().addScaledVector(outward, offset);

        // The old loop tested clear-sized steps and returned unchanged as soon
        // as its next step exceeded `reach + clear`. Find that exact last-grid
        // crossing along the fixed mouth normal, excluding an already-clear
        // far-wall toggle by requiring both requests to penetrate at offset 0.
        const ray: { offset: number; atZero: boolean; atGrid: boolean; atCap: boolean }[] = [];
        const raySamples = 1200;
        const rayRadius = 0.3;
        for (let i = 0; i <= raySamples; i++) {
          const offset = -rayRadius + (2 * rayRadius * i) / raySamples;
          const candidate = targetAt(offset);
          ray.push({
            offset,
            atZero: clearAt(candidate, 0),
            atGrid: clearAt(candidate, oldGrid),
            atCap: clearAt(candidate, cap),
          });
        }
        let bracket = -1;
        for (let i = 1; i < ray.length; i++) {
          const a = ray[i - 1];
          const b = ray[i];
          if (!(a.atZero || b.atZero) && a.atGrid !== b.atGrid && a.atCap && b.atCap) {
            bracket = i - 1;
            break;
          }
        }
        if (bracket < 0)
          throw new Error('no monotone old-grid clearance crossing with both starts penetrating');

        let left = ray[bracket].offset;
        let right = ray[bracket + 1].offset;
        const leftGridClear = ray[bracket].atGrid;
        for (let i = 0; i < 32 && Math.abs(right - left) > 0.1e-6; i++) {
          const middle = 0.5 * (left + right);
          const candidate = targetAt(middle);
          if (clearAt(candidate, oldGrid) === leftGridClear) left = middle;
          else right = middle;
        }
        const boundary = 0.5 * (left + right);
        const aOffset = boundary - 0.5e-6;
        const bOffset = boundary + 0.5e-6;
        const inputA = targetAt(aOffset);
        const inputB = targetAt(bOffset);
        if (clearAt(inputA, 0) || clearAt(inputB, 0))
          throw new Error('cutoff witness must penetrate at the uncorrected target');
        if (clearAt(inputA, oldGrid) === clearAt(inputB, oldGrid))
          throw new Error('one-micrometre targets did not straddle the old tested grid');
        if (!(clearAt(inputA, cap) && clearAt(inputB, cap)))
          throw new Error('cutoff witness must be solvable within the exact cap');

        const outputA = inputA.clone();
        const outputB = inputB.clone();
        const resolvedA = original.call(this, outputA, reach, side, frameReady);
        const resolvedB = original.call(this, outputB, reach, side, frameReady);
        cutoffResolved = [resolvedA, resolvedB];
        oneMicrometreOutputStep = outputA.distanceTo(outputB);
        let unresolved: THREE.Vector3 | undefined;
        for (let i = 0; i < ray.length; i++) {
          if (!(ray[i].atZero || ray[i].atCap)) {
            unresolved = targetAt(ray[i].offset);
            break;
          }
        }
        if (!unresolved) throw new Error('frozen ray did not exercise an exhausted clearance cap');
        const unresolvedInput = unresolved.clone();
        const resolved = original.call(this, unresolved, reach, side, frameReady);
        if (resolved) throw new Error('an exhausted clearance cap was reported as resolved');
        if (unresolved.distanceTo(unresolvedInput) > cap + 1e-6)
          throw new Error('best-effort clearance exceeded the existing reach cap');
        expect(unresolved.distanceTo(unresolvedInput)).toBeCloseTo(cap, 6);
      }
      return original.call(this, target, reach, side, frameReady);
    });
    step(h);

    if (cutoffResolved === undefined) throw new Error('cover did not request face clearance');
    expect(cutoffResolved).toEqual([true, true]);
    if (oneMicrometreOutputStep === undefined)
      throw new Error('finite-cap witness was not evaluated');
    const clearance = h.rig.fingerClearance('R');
    expect(oneMicrometreOutputStep).toBeLessThanOrEqual(clearance / 8 + 1e-6 + 1e-6);
  });

  it.each(ROUTE_CASES)(
    'keeps committed poses safe through $from→$to $side at $fps Hz',
    ({ from, to, side, fps }) => transitionSafety(from, to, side, fps),
  );

  it.each(STOP_CASES)(
    'keeps the arm safe when $from→cover stops mid-entrance ($side, $fps Hz)',
    ({ from, side, fps }) => stoppedEntranceSafety(from, side, fps),
  );
});
