import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TORSO_SAMPLES } from '@/engine/anatomy/joints';
import { Body } from '@/engine/motion/body';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { configurationFromQ } from '@/engine/rig/arm-path';
import type { ArmFrameSideCommit } from '@/engine/rig/rig';
import type { GestureDef } from '@/engine/types';
import { buildRig } from '../../helpers/scene';
import { harness, wristOf } from './harness';

/**
 * What one frame's arm commit may cost.
 *
 * Every context retry starts its bridge from an empty sample count, so a
 * travel that keeps failing pays for seven bridges in one frame. The ceiling
 * holds whatever the validation answers; past it the frame keeps the pose it
 * already accepted.
 */

interface Work {
  contextRetries: number;
  bridgeSamples: number;
}

const work = (body: unknown): Work => (body as { _armFrameWork: Work })._armFrameWork;

/** The right hand flung across the chest to the far shoulder. */
const ACROSS: GestureDef = {
  label: { en: 'Across', ja: '横切る' },
  group: 'pose',
  lead: 0,
  hold: 2,
  sustain: true,
  build: () => ({
    arms: {
      R: {
        upperArm: new THREE.Vector3(-0.3, -0.2, 0.93).normalize(),
        lowerArm: new THREE.Vector3(-0.95, 0.1, 0.2).normalize(),
        hand: new THREE.Vector3(-0.95, 0.1, 0.2).normalize(),
      },
    },
  }),
};

describe('arm commit budget', () => {
  it('bounds the bridge work of a fast cross-body travel that never validates', () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      h.rig.reset();
      h.body.update(1 / 60);
    }
    // Reject every attempt on the segment ending at the endpoint. This checks
    // the frame ceiling through repeated speed backtracks and context retries;
    // it does not require refinement to spend a full bridge first.
    const internals = h.body as unknown as {
      _bridgeFailure: string;
      armBridgeStepWithinBudget: (from: { s: number }, to: { s: number }) => boolean;
    };
    internals.armBridgeStepWithinBudget = (_from, to) => {
      if (to.s < 1) return true;
      internals._bridgeFailure = 'speed';
      return false;
    };
    h.body.playDef(ACROSS, 'across');
    let worst = 0;
    for (let i = 0; i < 12; i++) {
      h.rig.reset();
      h.body.update(1 / 8);
      worst = Math.max(worst, work(h.body).bridgeSamples);
      const wrist = wristOf(h.profile, 'R');
      expect(Number.isFinite(wrist.x + wrist.y + wrist.z)).toBe(true);
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(192);
  });

  it('leaves an ordinary cross-body travel inside the ceiling and moving', () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      h.rig.reset();
      h.body.update(1 / 60);
    }
    const start = wristOf(h.profile, 'R');
    h.body.playDef(ACROSS, 'across');
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      h.rig.reset();
      h.body.update(1 / 60);
      worst = Math.max(worst, work(h.body).bridgeSamples);
    }
    expect(worst).toBeLessThanOrEqual(192);
    expect(wristOf(h.profile, 'R').distanceTo(start)).toBeGreaterThan(0.1);
  });

  it('keeps mirrored idle weight shift moving within the frame bridge budget', () => {
    const scene = buildRig();
    for (const [name, bone] of scene.bones) {
      if (/_L$/.test(name) || /_R$/.test(name)) bone.position.x *= -1;
    }
    scene.root.updateMatrixWorld(true);
    const profile = buildProfile(scene.root, scene.descriptor);
    const rig = new Rig(profile);
    const body = new Body(rig, profile);
    body.breathDepth = 0;
    body.idleAmount = 0;
    body.gazeAmount = 0;
    body.weightShift = 1;
    const hips = profile.bones.hips;
    const chest = profile.bones.chest ?? profile.bones.spine;
    const frame = profile.body;
    if (!(hips && chest && frame)) throw new Error('missing mirrored body fixture');
    expect(frame.right.x).toBeLessThan(-0.99);
    const rest = hips.getWorldPosition(new THREE.Vector3());
    rig.reset();
    body.update(0.5);
    const delta = hips.getWorldPosition(new THREE.Vector3()).sub(rest);
    const hipsRight = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(hips.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
    const semanticRight = frame.right
      .clone()
      .applyMatrix3(new THREE.Matrix3().setFromMatrix4(chest.matrixWorld))
      .normalize();
    expect(work(body).bridgeSamples).toBeGreaterThan(0);
    expect(work(body).bridgeSamples).toBeLessThanOrEqual(192);
    expect(delta.dot(hipsRight)).toBeGreaterThan(1e-4);
    expect(delta.dot(semanticRight)).toBeLessThan(-1e-4);
  });
});

/** Scheduler controls only; physical geometry is covered separately below. */
function certificateControl() {
  const h = harness();
  const left = h.rig.armDriver('L');
  const right = h.rig.armDriver('R');
  if (!(left && right)) throw new Error('missing native arm drivers');
  const resolution = Math.min(left.sweepResolution, right.sweepResolution);
  interface Sample {
    s: number;
    side: Record<
      'L' | 'R',
      {
        q: Float64Array;
        upperLocal: THREE.Quaternion;
        lowerLocal: THREE.Quaternion;
        handLocal: THREE.Quaternion;
        points: THREE.Vector3[];
        torsoLocal: THREE.Vector3[];
        headLocal: THREE.Vector3[];
        hasTorso: boolean;
        hasHead: boolean;
      }
    >;
  }
  const body = h.body as unknown as {
    _bridgeSampleCount: number;
    _armFrameWork: Work;
    _bridgeFailure: string;
    validateArmBridge(alpha: number, dt: number): boolean;
    sampleArmBridge(s: number): Sample;
    restoreArmBridgeContext(alpha: number): boolean;
  };
  let position = (s: number) => 6 * resolution * s;
  let restoreResult = true;
  let throws = false;
  let restorations = 0;
  body.sampleArmBridge = (s) => {
    if (throws) throw new Error('sample failure');
    expect(body._bridgeSampleCount).toBeLessThan(96);
    expect(body._armFrameWork.bridgeSamples).toBeLessThan(192);
    body._bridgeSampleCount++;
    body._armFrameWork.bridgeSamples++;
    const side = () => ({
      q: new Float64Array(7),
      upperLocal: new THREE.Quaternion(),
      lowerLocal: new THREE.Quaternion(),
      handLocal: new THREE.Quaternion(),
      points: [new THREE.Vector3(position(s), 0, 0)],
      torsoLocal: [],
      headLocal: [],
      hasTorso: false,
      hasHead: false,
    });
    return { s, side: { L: side(), R: side() } };
  };
  body.restoreArmBridgeContext = () => {
    restorations++;
    return restoreResult;
  };
  return {
    body,
    resolution,
    validate: () => body.validateArmBridge(1, 0.5),
    reset: (context = 0, frame = 0) => {
      body._bridgeSampleCount = context;
      body._armFrameWork.bridgeSamples = frame;
    },
    position: (fn: (s: number) => number) => {
      position = fn;
    },
    restore: (value: boolean) => {
      restoreResult = value;
    },
    throwSample: () => {
      throws = true;
    },
    restorations: () => restorations,
  };
}

describe('bridge certificate boundaries', () => {
  it.each([
    {
      context: 87,
      frame: 183,
      valid: true,
      finalContext: 96,
      finalFrame: 192,
      failure: 'geometry',
    },
    { context: 0, frame: 184, valid: false, finalContext: 5, finalFrame: 189, failure: 'budget' },
    { context: 88, frame: 0, valid: false, finalContext: 93, finalFrame: 5, failure: 'geometry' },
  ])('respects exact remaining certificate capacity with %j', (expected) => {
    const h = certificateControl();
    h.reset(expected.context, expected.frame);
    expect(h.validate()).toBe(expected.valid);
    expect(h.body._bridgeSampleCount).toBe(expected.finalContext);
    expect(h.body._armFrameWork.bridgeSamples).toBe(expected.finalFrame);
    if (!expected.valid) expect(h.body._bridgeFailure).toBe(expected.failure);
    expect(h.restorations()).toBe(1);
    // A rejected pending frontier must not leak into a later validation.
    h.reset();
    h.position(() => 0);
    expect(h.validate()).toBe(true);
    expect(h.body._bridgeSampleCount).toBe(5);
  });

  it('accepts a complete depth-eight certificate and rejects an unresolved one', () => {
    const h = certificateControl();
    h.position((s) => 2 * h.resolution * Math.max(0, 1 - 512 * s));
    expect(h.validate()).toBe(true);
    h.reset();
    h.position((s) => (s === 0 ? 2 * h.resolution : 0));
    expect(h.validate()).toBe(false);
    expect(h.body._bridgeFailure).toBe('geometry');
  });

  it('rejects non-finite measured travel', () => {
    const h = certificateControl();
    h.position(() => Number.NaN);
    expect(h.validate()).toBe(false);
    expect(h.body._bridgeFailure).toBe('geometry');
    expect(h.restorations()).toBe(1);
  });

  it('requires restoration even for a complete certificate and restores after sample errors', () => {
    const h = certificateControl();
    h.position(() => 0);
    h.restore(false);
    expect(h.validate()).toBe(false);
    expect(h.body._bridgeFailure).toBe('geometry');
    expect(h.restorations()).toBe(1);
    h.reset();
    h.throwSample();
    expect(() => h.validate()).toThrow('sample failure');
    expect(h.restorations()).toBe(2);
  });
});

describe('bridge certificate physical geometry', () => {
  it('rejects a real hand-proxy obstruction hidden between the coarse knots', () => {
    const h = harness();
    const left = h.rig.armDriver('L');
    const right = h.rig.armDriver('R');
    if (!(left && right)) throw new Error('missing native arm drivers');
    h.rig.captureProposedBodyContext(0);
    const internals = h.body as unknown as {
      _frameCommit: Partial<Record<'L' | 'R', ArmFrameSideCommit>>;
      _bridgeSampleCount: number;
      _armFrameWork: Work;
      _bridgeFailure: string;
      validateArmBridge(alpha: number, dt: number): boolean;
    };
    let enabled = false;
    const center = new THREE.Vector3();
    let radius = 0;
    const pointIndex = 2 * TORSO_SAMPLES + 1;
    for (const side of ['L', 'R'] as const) {
      const driver = side === 'L' ? left : right;
      driver.environment.sample = (points, rows) => {
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          row.key = `sphere.${side}.${index}`;
          row.pointIndex = pointIndex;
          row.valid = false;
          row.distance = 0;
          row.normal.set(1, 0, 0);
        }
        const row = rows[0];
        if (!(enabled && side === 'R' && row)) return;
        row.valid = true;
        row.normal.copy(points[pointIndex].position).sub(center);
        const distance = row.normal.length();
        row.distance = distance - radius;
        if (distance > 0) row.normal.multiplyScalar(1 / distance);
        else row.normal.set(1, 0, 0);
      };
      const context = h.rig.armForwardContext(side);
      if (!context) throw new Error('missing native context');
      const endpoint = driver.acceptedQ.slice();
      if (side === 'R') endpoint[1] += 0.08;
      const configuration = configurationFromQ(endpoint, { ...driver.acceptedConfiguration });
      driver.requestForConfiguration(
        configuration,
        context,
        driver.acceptedCurls,
        driver.acceptedSpread,
      );
      expect(
        driver.validateLockedPose(
          endpoint,
          context,
          driver.acceptedCurls,
          driver.acceptedSpread,
          driver.output,
        ),
      ).toBe(true);
      internals._frameCommit[side] = {
        output: driver.output,
        context,
        curls: driver.acceptedCurls,
        spread: driver.acceptedSpread,
      };
    }
    const start = right.acceptedQ.slice();
    const endpoint = right.output.q.slice();
    const context = h.rig.armForwardContext('R');
    if (!context) throw new Error('missing right context');
    const fixed = (s: number) => {
      const q = start.map((value, index) => value + (endpoint[index] - value) * s);
      const valid = right.validateLockedPose(q, context, right.acceptedCurls, right.acceptedSpread);
      return {
        valid,
        point: right.bridgeOutput.points[pointIndex].position.clone(),
        violation: right.bridgeOutput.maxViolation,
      };
    };
    center.copy(fixed(0.125).point);
    const coarse = [0, 0.25, 0.5, 0.75, 1].map((s) => fixed(s));
    expect(coarse.every((sample) => sample.valid)).toBe(true);
    radius = Math.min(...coarse.map((sample) => sample.point.distanceTo(center))) / 2;
    expect(
      radius,
      `sphere radius ${radius}, sweep resolution ${right.sweepResolution}`,
    ).toBeGreaterThan(right.sweepResolution);
    expect(coarse[0].point.distanceTo(coarse[4].point)).toBeGreaterThan(right.sweepResolution);
    const accepted = [left, right].map((driver) => ({
      q: Array.from(driver.acceptedQ),
      curls: { ...driver.acceptedCurls },
      spread: { ...driver.acceptedSpread },
    }));
    const bodyBefore = JSON.stringify(
      (h.rig as unknown as { _acceptedBodyPose: unknown })._acceptedBodyPose,
    );
    internals._bridgeSampleCount = 0;
    internals._armFrameWork.bridgeSamples = 0;
    expect(internals.validateArmBridge(1, 0.5)).toBe(true);
    expect(internals._bridgeSampleCount).toBeGreaterThan(5);
    enabled = true;
    for (const s of [0, 0.25, 0.5, 0.75, 1]) {
      const sample = fixed(s);
      expect(sample.point.distanceTo(center) - radius).toBeGreaterThan(0);
      expect(sample.valid).toBe(true);
    }
    const hidden = fixed(0.125);
    expect(hidden.valid).toBe(false);
    expect(hidden.violation).toBeGreaterThan(0);
    internals._bridgeSampleCount = 0;
    internals._armFrameWork.bridgeSamples = 0;
    expect(internals.validateArmBridge(1, 0.5)).toBe(false);
    expect(internals._bridgeFailure).toBe('geometry');
    expect(internals._bridgeSampleCount).toBeLessThanOrEqual(96);
    expect(internals._armFrameWork.bridgeSamples).toBeLessThanOrEqual(192);
    expect(
      [left, right].map((driver) => ({
        q: Array.from(driver.acceptedQ),
        curls: { ...driver.acceptedCurls },
        spread: { ...driver.acceptedSpread },
      })),
    ).toEqual(accepted);
    expect(
      JSON.stringify((h.rig as unknown as { _acceptedBodyPose: unknown })._acceptedBodyPose),
    ).toBe(bodyBefore);
    const hips = h.profile.bones.hips;
    const proposed = (h.rig as unknown as { _proposedBodyPose: { hipsPosition: THREE.Vector3 } })
      ._proposedBodyPose;
    if (!hips) throw new Error('missing hips');
    expect(hips.position.distanceTo(proposed.hipsPosition)).toBeLessThan(1e-12);
  });
});

it('fully certifies a smaller arm step after native release capacity exhaustion', () => {
  const make = () => {
    const scene = buildRig();
    const profile = buildProfile(scene.root, scene.descriptor);
    const rig = new Rig(profile);
    const body = new Body(rig, profile, { random: () => 0.5 });
    body.breathDepth = 1;
    body.weightShift = 1;
    body.idleAmount = 0;
    body.gazeAmount = 0;
    return { profile, rig, body };
  };
  const h = make();
  const idle = make();
  const step = () => {
    h.rig.reset();
    h.body.update(1 / 20);
    idle.rig.reset();
    idle.body.update(1 / 20);
  };
  step();
  h.body.play('sparkle', 'L');
  for (let i = 0; i < 24; i++) step();
  h.body.play('beg', 'L');
  for (let i = 0; i < 24; i++) step();
  h.body.stopGesture();
  const sides = ['L', 'R'] as const;
  const drivers = sides.map((side) => {
    const driver = h.rig.armDriver(side);
    if (!driver) throw new Error(`missing ${side} arm driver`);
    return driver;
  });
  let before = drivers.map((d) => Array.from(d.acceptedQ));
  let wristsBefore = sides.map((side) => wristOf(h.profile, side));
  const body = h.body as unknown as {
    _bridgeSampleCount: number;
    _bridgeCapacityScope?: 'context' | 'frame' | null;
    _fullArmQ: Record<'L' | 'R', Float64Array>;
    evaluateArmCandidate(alpha: number, beta: number): boolean;
    validateArmBridge(alpha: number, dt: number): boolean;
  };
  let beta = 1;
  let validation = false;
  let committed = false;
  let expected: number[][] = [];
  const slotsByAlpha = new Map<number, number>();
  let capacityAlpha: number | null = null;
  let capacityCandidate = false;
  const evaluate = body.evaluateArmCandidate;
  body.evaluateArmCandidate = function (alpha, candidate) {
    capacityCandidate = capacityAlpha === alpha && candidate < beta;
    capacityAlpha = null;
    beta = candidate;
    slotsByAlpha.set(alpha, (slotsByAlpha.get(alpha) ?? 0) + 1);
    return evaluate.call(this, alpha, candidate);
  };
  const validate = body.validateArmBridge;
  body.validateArmBridge = function (alpha, dt) {
    if (this._bridgeSampleCount === 0) {
      beta = 1;
      capacityCandidate = false;
      slotsByAlpha.set(alpha, (slotsByAlpha.get(alpha) ?? 0) + 1);
    }
    const result = validate.call(this, alpha, dt);
    expect(this._bridgeSampleCount).toBeLessThanOrEqual(96);
    capacityAlpha = !result && this._bridgeCapacityScope != null ? alpha : null;
    if (result && beta < 1 && capacityCandidate) {
      validation = true;
      expected = sides.map((side, index) =>
        Array.from(
          this._fullArmQ[side],
          (full, i) => before[index][i] + beta * (full - before[index][i]),
        ),
      );
    }
    return result;
  };
  const commit = h.rig.commitArmFrame;
  h.rig.commitArmFrame = function (...args) {
    const result = commit.apply(this, args);
    if (result && validation) committed = true;
    return result;
  };
  let witnessed = false;
  for (let frame = 0; frame < 7; frame++) {
    before = drivers.map((d) => Array.from(d.acceptedQ));
    wristsBefore = sides.map((side) => wristOf(h.profile, side));
    beta = 1;
    validation = false;
    committed = false;
    slotsByAlpha.clear();
    capacityAlpha = null;
    capacityCandidate = false;
    step();
    for (const slots of slotsByAlpha.values()) expect(slots).toBeLessThanOrEqual(6);
    expect(work(h.body).bridgeSamples).toBeLessThanOrEqual(192);
    if (!committed) continue;
    expect(validation).toBe(true);
    expect(drivers.map((d) => Array.from(d.acceptedQ))).toEqual(expected);
    const resolution = Math.min(...drivers.map((d) => d.sweepResolution));
    expect(
      sides.some((side, index) => {
        const after = wristOf(h.profile, side);
        const target = wristOf(idle.profile, side);
        return (
          after.distanceTo(wristsBefore[index]) > resolution &&
          after.distanceTo(target) < wristsBefore[index].distanceTo(target)
        );
      }),
    ).toBe(true);
    witnessed = true;
  }
  expect(witnessed).toBe(true);
});
