import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { elevationCeiling } from '@/engine/anatomy/strain';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { LIMIT_SLEW } from '@/engine/rig/arm-driver';
import type { ArmPathClearance } from '@/engine/rig/arm-path';
import {
  ArmRoute,
  armStepWithinSlew,
  clampToBox,
  MAX_VALIDATION_SAMPLES,
  quintic,
  stopTail,
  VALIDATION_INTERVAL,
  validationSamples,
} from '@/engine/rig/arm-route';
import { buildRig } from '../helpers/scene';

/** Any positive length; the body passes its own lead floor. */
const TAIL = 0.2;
const NO_FINGERS = {};

function scene() {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  rig.anat.update();
  const driver = rig.armDriver('R');
  const context = rig.armForwardContext('R');
  if (!(driver && context)) throw new Error('synthetic rig has no constrained right arm');
  driver.captureVolumeFrame();
  return { driver, context };
}

type Scene = ReturnType<typeof scene>;

/** An arm held out to the side, well clear of the body. */
function sideways(): Float64Array {
  const q = new Float64Array(7);
  q[1] = 0.5 * Math.PI;
  q[3] = 0.4;
  return q;
}

/** `base` with the forearm rolled `excess` past its range on one side. */
function overRolled(driver: Scene['driver'], base: Float64Array, excess: number): Float64Array {
  const q = base.slice();
  const [lo, hi] = driver.calibration.joints.elbow.dofs.rotation.max;
  q[4] = excess > 0 ? hi + excess : lo + excess;
  return q;
}

function validates(s: Scene, q: Float64Array): boolean {
  s.driver.requestForConfiguration(
    { ...s.driver.acceptedConfiguration },
    s.context,
    NO_FINGERS,
    NO_FINGERS,
  );
  return s.driver.validateLockedPose(q, s.context, NO_FINGERS, NO_FINGERS);
}

describe('closed-form curves', () => {
  it('meets the quintic boundary jets and holds after', () => {
    for (const [d0, v0, d1, T] of [
      [0, 0, 1, 0.5],
      [0.3, -2, -0.4, 0.12],
      [-1, 4, -1, 0.9],
    ]) {
      expect(quintic(d0, v0, d1, T, 0, 0)).toBeCloseTo(d0, 12);
      expect(quintic(d0, v0, d1, T, 0, 1)).toBeCloseTo(v0, 12);
      expect(quintic(d0, v0, d1, T, 0, 2)).toBeCloseTo(0, 12);
      expect(quintic(d0, v0, d1, T, T * (1 - 1e-12), 0)).toBeCloseTo(d1, 9);
      expect(quintic(d0, v0, d1, T, T * (1 - 1e-12), 1)).toBeCloseTo(0, 9);
      expect(quintic(d0, v0, d1, T, T * (1 - 1e-12), 2)).toBeCloseTo(0, 6);
      expect(quintic(d0, v0, d1, T, 2 * T, 0)).toBe(d1);
      expect(quintic(d0, v0, d1, T, 2 * T, 1)).toBe(0);
      // Derivatives agree with the curve they describe.
      const t = 0.37 * T;
      const h = 1e-6;
      const slope = (quintic(d0, v0, d1, T, t + h, 0) - quintic(d0, v0, d1, T, t - h, 0)) / (2 * h);
      expect(quintic(d0, v0, d1, T, t, 1)).toBeCloseTo(slope, 5);
    }
    expect(quintic(0.2, 1, 0.7, 0, 0, 0)).toBe(0.7);
  });

  it('brings the stop tail to rest at h and holds it', () => {
    for (const [x0, v0, a0] of [
      [0.1, 1.5, 0],
      [-0.4, -3, 20],
      [0, 0.2, -8],
    ]) {
      expect(stopTail(x0, v0, a0, TAIL, 0, 0)).toBe(x0);
      expect(stopTail(x0, v0, a0, TAIL, 0, 1)).toBe(v0);
      expect(stopTail(x0, v0, a0, TAIL, 0, 2)).toBe(a0);
      expect(stopTail(x0, v0, a0, TAIL, TAIL * (1 - 1e-12), 1)).toBeCloseTo(0, 9);
      expect(stopTail(x0, v0, a0, TAIL, TAIL * (1 - 1e-12), 2)).toBeCloseTo(0, 8);
      const rest = stopTail(x0, v0, a0, TAIL, TAIL, 0);
      for (const t of [TAIL * 1.5, TAIL * 10]) {
        expect(stopTail(x0, v0, a0, TAIL, t, 0)).toBe(rest);
        expect(stopTail(x0, v0, a0, TAIL, t, 1)).toBe(0);
        expect(stopTail(x0, v0, a0, TAIL, t, 2)).toBe(0);
      }
    }
  });

  it('clamps into a box, in place', () => {
    const q = Float64Array.from([4, -1, 0.5, 2, 0, 0, 0]);
    const lower = Float64Array.from([-3, 0, -1, 0, -1, -1, -1]);
    const upper = Float64Array.from([3, 1, 1, 1, 1, 1, 1]);
    expect(Array.from(clampToBox(q, { lower, upper }, q))).toEqual([3, 0, 0.5, 1, 0, 0, 0]);
  });

  it('validates at a fixed density per second, capped', () => {
    expect(VALIDATION_INTERVAL).toBe(1 / 60);
    expect(validationSamples(1 / 120)).toBe(1);
    expect(validationSamples(1 / 60)).toBe(1);
    expect(validationSamples(1 / 30)).toBe(2);
    expect(validationSamples(1 / 20)).toBe(3);
    expect(validationSamples(1 / 5)).toBe(MAX_VALIDATION_SAMPLES);
  });

  it('measures a step against the slew allowance', () => {
    const pose = () => ({
      upperLocal: new THREE.Quaternion(),
      lowerLocal: new THREE.Quaternion(),
      handLocal: new THREE.Quaternion(),
    });
    const dt = 1 / 60;
    const a = pose();
    const b = pose();
    const qa = new Float64Array(7);
    const qb = new Float64Array(7);
    expect(armStepWithinSlew(qa, a, qb, b, dt)).toBe(0);
    qb[5] = 2 * LIMIT_SLEW * dt;
    expect(armStepWithinSlew(qa, a, qb, b, dt)).toBeCloseTo(2, 6);
    qb[5] = 0;
    b.lowerLocal.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5 * LIMIT_SLEW * dt);
    expect(armStepWithinSlew(qa, a, qb, b, dt)).toBeCloseTo(0.5, 6);
  });
});

describe('arm route planning', () => {
  it('spends one environment batch on an admissible goal', () => {
    const s = scene();
    const goal = sideways();
    expect(validates(s, goal)).toBe(true);
    const route = new ArmRoute(TAIL);
    route.reset(goal);
    route.request('goal', 0.3);
    expect(route.pending).toBe('goal');
    const batches = route.plan(s.driver, s.context, goal, goal, NO_FINGERS, NO_FINGERS);
    expect(batches).toBe(1);
    expect(route.pending).toBe('none');
    expect(route.projected).toBe(false);
    expect(route.stuck).toBe(false);
    expect(Array.from(route.goalQ)).toEqual(Array.from(goal));
    expect(Array.from(route.dGoal)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('projects a goal past the joint range onto it', () => {
    const s = scene();
    const raw = sideways();
    const goal = overRolled(s.driver, raw, 0.2);
    const route = new ArmRoute(TAIL);
    route.reset(raw);
    route.request('goal', 0.3);
    route.plan(s.driver, s.context, goal, raw, NO_FINGERS, NO_FINGERS);
    expect(route.projected).toBe(true);
    expect(route.stuck).toBe(false);
    expect(route.goalQ[4]).toBeLessThanOrEqual(
      s.driver.calibration.joints.elbow.dofs.rotation.max[1] + 1e-12,
    );
    expect(validates(s, route.goalQ)).toBe(true);
  });

  it('projects a hand inside the face to a feasible pose beside it', () => {
    const s = scene();
    const inFace = faceOnlyPose(s);
    expect(inFace, 'no grid pose puts only fingers inside the face').not.toBeNull();
    if (!inFace) return;
    expect(validates(s, inFace)).toBe(false);
    const route = new ArmRoute(TAIL);
    route.reset(s.driver.acceptedQ);
    route.request('goal', 0.4);
    route.plan(s.driver, s.context, inFace, inFace, NO_FINGERS, NO_FINGERS);
    expect(route.projected).toBe(true);
    expect(route.stuck).toBe(false);
    expect(validates(s, route.goalQ)).toBe(true);
  });
});

/**
 * The shallowest grid pose whose only clearance violations are finger rows
 * against the face, found by reading the rows the locked validation sampled.
 */
function faceOnlyPose(s: Scene): Float64Array | null {
  const environment = s.driver.environment;
  const original = environment.sample.bind(environment);
  let rows: { face: number; other: number } = { face: 0, other: 0 };
  const spy = vi
    .spyOn(environment, 'sample')
    .mockImplementation((points, out: ArmPathClearance[]) => {
      original(points, out);
      let face = 0;
      let other = 0;
      for (const row of out) {
        if (!(row.valid && row.distance < 0)) continue;
        if (row.key.endsWith(':face')) face = Math.max(face, -row.distance);
        else other = Math.max(other, -row.distance);
      }
      rows = { face, other };
    });
  const [rotLo, rotHi] = s.driver.calibration.joints.shoulder.dofs.rotation.max;
  const [flexLo, flexHi] = s.driver.calibration.joints.elbow.dofs.flexion.max;
  let best: Float64Array | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  const q = new Float64Array(7);
  try {
    for (let plane = 60; plane <= 150; plane += 15) {
      for (let lift = 0.3; lift <= 0.95; lift += 0.08) {
        for (let r = 0; r <= 4; r++) {
          for (let f = 0; f <= 6; f++) {
            q[0] = THREE.MathUtils.degToRad(plane);
            q[1] = lift * Math.PI;
            q[2] = rotLo + ((rotHi - rotLo) * r) / 4;
            q[3] = flexLo + ((flexHi - flexLo) * f) / 6;
            rows = { face: 0, other: 0 };
            if (validates(s, q)) continue;
            if (rows.other === 0 && rows.face > 0.002 && rows.face < bestDepth) {
              bestDepth = rows.face;
              best = q.slice();
            }
          }
        }
      }
    }
  } finally {
    spy.mockRestore();
  }
  return best;
}

describe('arm route tracking', () => {
  /** Run a route at `hz` against a fixed raw pose, sampling `at` each listed time. */
  function track(
    s: Scene,
    hz: number,
    seconds: number,
    events: {
      replanAt?: { time: number; goal: Float64Array };
      absorbAt?: { time: number; offset: number };
    } = {},
  ) {
    const raw = sideways();
    const route = new ArmRoute(TAIL);
    route.reset(raw);
    route.request('goal', 0.4);
    route.plan(s.driver, s.context, overRolled(s.driver, raw, 0.25), raw, NO_FINGERS, NO_FINGERS);
    const dt = 1 / hz;
    const frames = Math.round(seconds * hz);
    const accepted: Float64Array[] = [];
    const out = new Float64Array(7);
    const checks: {
      replanValue?: number;
      replanRate?: number;
      absorbValue?: number;
      absorbRate?: number;
    } = {};
    for (let k = 1; k <= frames; k++) {
      const time = k * dt;
      if (events.replanAt && Math.abs(time - dt - events.replanAt.time) < dt / 2) {
        const before = route.command(raw, s.driver, new Float64Array(7));
        const rate = Array.from({ length: 7 }, (_, i) =>
          quintic(route.d0[i], route.v0[i], route.dGoal[i], route.duration, route.elapsed, 1),
        );
        route.request('goal', 0.4);
        route.plan(s.driver, s.context, events.replanAt.goal, raw, NO_FINGERS, NO_FINGERS);
        const after = route.command(raw, s.driver, new Float64Array(7));
        checks.replanValue = Math.max(...after.map((x, i) => Math.abs(x - before[i])));
        checks.replanRate = Math.max(...rate.map((v, i) => Math.abs(v - route.v0[i])));
      }
      route.advance(dt);
      route.command(raw, s.driver, out);
      if (events.absorbAt && Math.abs(time - events.absorbAt.time) < dt / 2) {
        const rate = Array.from({ length: 7 }, (_, i) =>
          quintic(route.d0[i], route.v0[i], route.dGoal[i], route.duration, route.elapsed, 1),
        );
        for (let i = 1; i < 7; i++) out[i] += events.absorbAt.offset;
        route.absorb(raw, out, s.driver);
        const after = route.command(raw, s.driver, new Float64Array(7));
        checks.absorbValue = Math.max(...after.map((x, i) => Math.abs(x - out[i])));
        checks.absorbRate = Math.max(...rate.map((v, i) => Math.abs(v - route.v0[i])));
      }
      route.accept(out, raw, dt);
      accepted.push(out.slice());
    }
    return { route, accepted, checks, dt };
  }

  /** Largest change of finite-difference velocity across frame `k`. */
  function velocityJump(accepted: Float64Array[], dt: number, k: number): number {
    let worst = 0;
    for (let i = 0; i < 7; i++) {
      const before = (accepted[k - 1][i] - accepted[k - 2][i]) / dt;
      const after = (accepted[k][i] - accepted[k - 1][i]) / dt;
      worst = Math.max(worst, Math.abs(after - before));
    }
    return worst;
  }

  it('samples the same correction at 20, 60 and 120 Hz', () => {
    const s = scene();
    const samples = [20, 60, 120].map((hz) => {
      const { accepted } = track(s, hz, 0.6);
      const stride = hz / 20;
      return accepted.filter((_, k) => (k + 1) % stride === 0);
    });
    expect(samples[0].length).toBe(12);
    for (const other of samples.slice(1)) {
      expect(other.length).toBe(samples[0].length);
      for (let k = 0; k < other.length; k++) {
        for (let i = 0; i < 7; i++) expect(other[k][i]).toBeCloseTo(samples[0][k][i], 9);
      }
    }
    // Something moved: the correction is not trivially zero.
    expect(Math.abs(samples[0][11][4] - samples[0][0][4])).toBeGreaterThan(0.01);
  });

  it('keeps the command C1 across a replan and an absorb', () => {
    const s = scene();
    const raw = sideways();
    const next = overRolled(s.driver, raw, -0.3);
    next[1] = 0.3 * Math.PI;
    const jumps = [120, 240].map((hz) => {
      const { checks, accepted, dt } = track(s, hz, 0.5, {
        replanAt: { time: 0.15, goal: next },
        absorbAt: { time: 0.3, offset: 0.002 },
      });
      expect(checks.replanValue).toBeLessThan(1e-12);
      expect(checks.replanRate).toBeLessThan(1e-12);
      expect(checks.absorbValue).toBeLessThan(1e-12);
      expect(checks.absorbRate).toBeLessThan(1e-12);
      const replan = Math.round(0.15 * hz);
      const absorb = Math.round(0.3 * hz);
      return {
        replan: velocityJump(accepted, dt, replan),
        // The repaired frame steps by the offset; the next one resumes the old rate.
        absorb: Math.abs(
          (accepted[absorb][4] - accepted[absorb - 1][4]) / dt -
            (accepted[absorb - 2][4] - accepted[absorb - 3][4]) / dt,
        ),
      };
    });
    // A velocity seam would not shrink with the frame time.
    expect(jumps[1].replan).toBeLessThan(0.7 * jumps[0].replan + 1e-9);
    expect(jumps[1].absorb).toBeLessThan(0.7 * jumps[0].absorb + 1e-9);
  });

  it('weights the plane correction away at the pole', () => {
    const s = scene();
    const goal = sideways();
    goal[1] = 0.25 * Math.PI;
    const route = new ArmRoute(TAIL);
    route.reset(goal);
    route.request('goal', 0);
    route.plan(s.driver, s.context, goal, goal, NO_FINGERS, NO_FINGERS);
    route.dGoal[0] = 0.4;
    const out = new Float64Array(7);
    const raw = goal.slice();

    raw[1] = 0;
    expect(route.command(raw, s.driver, out)[0]).toBe(raw[0]);

    raw[1] = 0.6 * Math.PI;
    expect(route.command(raw, s.driver, out)[0]).toBeCloseTo(raw[0] + 0.4, 12);

    // Halfway in sine between the pole and the goal's elevation, half the correction.
    const ceiling = elevationCeiling(goal[0], s.driver.calibration.joints.shoulder.elevation).max;
    const goalTheta = 0.25 * ceiling;
    raw[1] = (Math.asin(0.5 * Math.sin(goalTheta)) / ceiling) * Math.PI;
    expect(route.command(raw, s.driver, out)[0]).toBeCloseTo(raw[0] + 0.2, 9);
  });

  it('stops from the accepted jet and holds once at rest', () => {
    const s = scene();
    const { route, dt } = track(s, 60, 0.1);
    route.advance(dt);
    route.beginStop();
    expect(route.stopping).toBe(true);
    const out = new Float64Array(7);
    let last = route.tailSample(new Float64Array(7));
    const steps = Math.ceil(TAIL / dt) + 3;
    for (let k = 0; k < steps; k++) {
      route.advance(dt);
      route.tailSample(out);
      if (k >= steps - 2) {
        for (let i = 0; i < 7; i++) expect(out[i]).toBe(last[i]);
      }
      last = out.slice();
    }
  });
});
