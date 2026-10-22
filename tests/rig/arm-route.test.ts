import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { forwardArm, makeArmForwardResult } from '@/engine/rig/arm-configuration';
import { LIMIT_SLEW } from '@/engine/rig/arm-driver';
import { type ArmPathClearance, configurationFromQ } from '@/engine/rig/arm-path';
import {
  ArmRoute,
  armStepWithinSlew,
  clampToBox,
  MAX_VALIDATION_SAMPLES,
  residualCarry,
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

describe('arm route slew', () => {
  const dt = 1 / 60;
  function poseOf(s: Scene, q: Float64Array) {
    return forwardArm(
      configurationFromQ(q, { ...s.driver.acceptedConfiguration }),
      s.driver.calibration,
      s.context,
      makeArmForwardResult(),
    );
  }

  it('shortens a long multi-axis step to just inside the allowance, along the step', () => {
    const s = scene();
    const from = sideways();
    const route = new ArmRoute(TAIL);
    route.reset(from);
    const accepted = poseOf(s, from);
    const target = from.slice();
    target[0] += 0.6;
    target[2] += 0.5;
    target[3] += 0.7;
    target[4] += 0.4;
    const k = armStepWithinSlew(from, accepted, target, poseOf(s, target), dt);
    // One 1/k scale lands over: the bone angles are not linear in q.
    const once = from.map((value, i) => value + (target[i] - value) / k);
    expect(armStepWithinSlew(from, accepted, once, poseOf(s, once), dt)).toBeGreaterThan(1);

    const command = target.slice();
    expect(route.limitSlew(command, accepted, s.driver, s.context, dt)).toBe(true);
    const ratio = armStepWithinSlew(from, accepted, command, poseOf(s, command), dt);
    expect(ratio).toBeLessThanOrEqual(1);
    expect(ratio).toBeGreaterThanOrEqual(0.98);
    const share = (command[3] - from[3]) / (target[3] - from[3]);
    for (let i = 0; i < 7; i++) {
      expect(command[i] - from[i]).toBeCloseTo((target[i] - from[i]) * share, 12);
    }
  });

  it('leaves a step within the allowance alone', () => {
    const s = scene();
    const from = sideways();
    const route = new ArmRoute(TAIL);
    route.reset(from);
    const command = from.slice();
    command[3] += 0.5 * LIMIT_SLEW * dt;
    const before = Array.from(command);
    expect(route.limitSlew(command, poseOf(s, from), s.driver, s.context, dt)).toBe(false);
    expect(Array.from(command)).toEqual(before);
  });
});

/** Point the driver's request at `q`, as the body's composed request would for its raw q. */
function requestAt(s: Scene, q: Float64Array): void {
  s.driver.requestForConfiguration(
    configurationFromQ(q, { ...s.driver.acceptedConfiguration }),
    s.context,
    NO_FINGERS,
    NO_FINGERS,
  );
}

describe('arm route goal', () => {
  it('takes an admissible raw q on the chain for one settled step and one check', () => {
    const s = scene();
    const raw = sideways();
    requestAt(s, raw);
    const route = new ArmRoute(TAIL);
    route.reset(raw);
    const batches = route.track(s.driver, s.context, raw, NO_FINGERS, NO_FINGERS, 1 / 60);
    expect(batches).toBe(2);
    expect(route.solved).toBe(false);
    expect(route.projected).toBe(false);
    expect(Array.from(route.goalQ)).toEqual(Array.from(raw));
  });

  it('solves a raw q past the joint range into it', () => {
    const s = scene();
    const raw = overRolled(s.driver, sideways(), 0.2);
    requestAt(s, raw);
    const route = new ArmRoute(TAIL);
    route.reset(sideways());
    route.track(s.driver, s.context, raw, NO_FINGERS, NO_FINGERS, 1 / 60);
    expect(route.solved).toBe(true);
    expect(route.projected).toBe(true);
    expect(route.goalQ[4]).toBeLessThanOrEqual(
      s.driver.calibration.joints.elbow.dofs.rotation.max[1] + 1e-12,
    );
    expect(validates(s, route.goalQ)).toBe(true);
  });

  it('solves a hand inside the face to a feasible pose', () => {
    const s = scene();
    const inFace = faceOnlyPose(s);
    expect(inFace, 'no grid pose puts only fingers inside the face').not.toBeNull();
    if (!inFace) return;
    expect(validates(s, inFace)).toBe(false);
    requestAt(s, inFace);
    const route = new ArmRoute(TAIL);
    route.reset(s.driver.acceptedQ);
    route.track(s.driver, s.context, inFace, NO_FINGERS, NO_FINGERS, 1 / 60);
    expect(route.solved).toBe(true);
    expect(route.projected).toBe(true);
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
  it('eases the residual carry from its jet to rest over the duration', () => {
    for (const [from, rate, T] of [
      [0.3, 0, 0.4],
      [-0.2, 3, 0.12],
      [0.05, -1, 0.9],
    ]) {
      expect(residualCarry(from, rate, T, 0, 0)).toBeCloseTo(from, 12);
      expect(residualCarry(from, rate, T, 0, 1)).toBeCloseTo(rate, 12);
      expect(residualCarry(from, rate, T, T * (1 - 1e-12), 0)).toBeCloseTo(0, 9);
      expect(residualCarry(from, rate, T, T * (1 - 1e-12), 1)).toBeCloseTo(0, 9);
      expect(residualCarry(from, rate, T, 2 * T, 0)).toBe(0);
      const t = 0.37 * T;
      const h = 1e-6;
      const slope =
        (residualCarry(from, rate, T, t + h, 0) - residualCarry(from, rate, T, t - h, 0)) / (2 * h);
      expect(residualCarry(from, rate, T, t, 1)).toBeCloseTo(slope, 5);
    }
  });

  /** Accept every command toward a raw q that moved off the accepted one in a single step. */
  function run(s: Scene, hz: number, seconds: number, lead = 0.3, jump = 0.2) {
    const from = sideways();
    const raw = from.slice();
    raw[3] += jump;
    raw[2] -= jump / 2;
    const route = new ArmRoute(TAIL);
    route.reset(from);
    route.retime(lead);
    const dt = 1 / hz;
    const commands: Float64Array[] = [];
    for (let k = 0; k < Math.round(seconds * hz); k++) {
      requestAt(s, raw);
      s.driver.accept(route.qAcc, s.context, NO_FINGERS, NO_FINGERS);
      route.track(s.driver, s.context, raw, NO_FINGERS, NO_FINGERS, dt);
      const out = route.command(s.driver, new Float64Array(7));
      route.accept(out, dt);
      commands.push(out);
    }
    return { route, from, raw, commands, dt };
  }

  it('carries the last command into a goal that jumped, and eases it out over the lead', () => {
    const s = scene();
    const lead = 0.3;
    const { from, raw, commands, dt } = run(s, 60, 0.5, lead);
    // The first frame is one carry step from where the arm was, not at the goal.
    expect(Math.abs(commands[0][3] - from[3])).toBeLessThan(0.01);
    expect(Math.abs(commands[0][3] - raw[3])).toBeGreaterThan(0.15);
    // The lead later the carry is spent.
    const done = commands[Math.ceil(lead / dt)];
    for (let i = 0; i < 7; i++) expect(done[i]).toBeCloseTo(raw[i], 12);
  });

  it('samples the same carry at 20, 60 and 120 Hz', () => {
    const s = scene();
    const samples = [20, 60, 120].map((hz) => {
      // Small enough to be one frame's step even at 120 Hz, so every rate has the same goal.
      const { commands } = run(s, hz, 0.3, 0.3, 0.05);
      return commands.filter((_, k) => (k + 1) % (hz / 20) === 0);
    });
    expect(samples[0].length).toBe(6);
    for (const other of samples.slice(1)) {
      for (let k = 0; k < other.length; k++) {
        for (let i = 0; i < 7; i++) expect(other[k][i]).toBeCloseTo(samples[0][k][i], 12);
      }
    }
    // Something was carried: the first sample is still well short of the last.
    expect(Math.abs(samples[0][0][3] - samples[0][5][3])).toBeGreaterThan(0.01);
  });

  it('carries on from an absorbed pose', () => {
    const s = scene();
    const { route } = run(s, 60, 0.1);
    const committed = route.command(s.driver, new Float64Array(7));
    for (let i = 1; i < 7; i++) committed[i] -= 0.002;
    route.absorb(committed);
    const after = route.command(s.driver, new Float64Array(7));
    for (let i = 0; i < 7; i++) expect(after[i]).toBeCloseTo(committed[i], 12);
  });

  it('stops from the accepted jet one frame on', () => {
    const s = scene();
    const { route, dt } = run(s, 60, 0.1);
    route.beginStop(dt);
    expect(route.stopping).toBe(true);
    const out = route.tailSample(new Float64Array(7));
    for (let i = 0; i < 7; i++) {
      expect(out[i]).toBe(stopTail(route.qAcc[i], route.vAcc[i], route.aAcc[i], TAIL, dt, 0));
    }
  });
});

describe('arm route recovery', () => {
  /**
   * A hand brought in to the chest with the forearm, wrist flexion and
   * deviation all on their stops, as a heart held in front of it leaves them.
   */
  function pinned(s: Scene): Float64Array {
    const joints = s.driver.calibration.joints;
    return Float64Array.from([
      1.556,
      0.299,
      -0.181,
      1.655,
      joints.elbow.dofs.rotation.max[1],
      joints.wrist.dofs.flexion.max[0],
      joints.wrist.dofs.deviation.max[0],
    ]);
  }

  it('reaches an admissible raw q at rest when no plan step leaves the goal', () => {
    const s = scene();
    const from = pinned(s);
    const rest = Float64Array.from([0.436, 0.336, -0.841, 0.177, 0.512, 0.049, -0.001]);
    expect(validates(s, from)).toBe(true);
    expect(validates(s, rest)).toBe(true);
    // On a real mesh the solver's step can fail from a clear start on the
    // stops: the plan reports blocked and leaves q where it started.
    const plan = s.driver.planFrom.bind(s.driver);
    vi.spyOn(s.driver, 'planFrom').mockImplementation((start, ...rest) => {
      const out = plan(start, ...rest);
      out.status = 'blocked';
      out.q.set(start);
      return out;
    });
    const route = new ArmRoute(TAIL);
    route.reset(from);
    const dt = 1 / 60;
    let reached = -1;
    for (let k = 0; k < 60 && reached < 0; k++) {
      requestAt(s, rest);
      s.driver.accept(route.qAcc, s.context, NO_FINGERS, NO_FINGERS);
      route.track(s.driver, s.context, rest, NO_FINGERS, NO_FINGERS, dt);
      route.accept(route.command(s.driver, new Float64Array(7)), dt);
      let gap = 0;
      for (let i = 0; i < 7; i++) gap = Math.max(gap, Math.abs(route.goalQ[i] - rest[i]));
      if (gap < 1e-9) reached = k;
    }
    // One box step per frame at the slew limit covers the widest DOF.
    let widest = 0;
    for (let i = 0; i < 7; i++) widest = Math.max(widest, Math.abs(rest[i] - from[i]));
    expect(reached).toBeGreaterThanOrEqual(0);
    expect(reached).toBeLessThanOrEqual(Math.ceil(widest / (LIMIT_SLEW * dt)));
  });
});
