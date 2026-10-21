import type * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINGER_WIDTH, JOINTS } from '@/engine/anatomy';
import type { JointReading, Side } from '@/engine/types';
import { fingerDepth, type Harness, harness, wristOf } from './harness';

interface PathSpec {
  from: string;
  to: string;
  side: Side;
  fps: number;
  yaw: number;
  seed: number;
  idleFrames: number;
  fromFrames?: number;
  fromLeadExtra?: number;
  toFrames: number;
  /** Let one-sided gestures use their normal random side selection. */
  randomSide?: boolean;
}

interface FinalFrame {
  wrist: ReturnType<typeof wristOf>;
  armLocal: readonly [THREE.Quaternion, THREE.Quaternion, THREE.Quaternion];
  joints: JointReading[];
  depth: number;
}

interface Violation {
  frame: number;
  id: string;
  value: number;
  range: readonly [number, number];
  excess: number;
}

const HARD_BOUNDS: Record<string, readonly [number, number]> = {
  rotation: JOINTS.shoulder.dofs.rotation.max,
  elbow: JOINTS.elbow.dofs.flexion.max,
  forearm: JOINTS.elbow.dofs.rotation.max,
  wristFlex: JOINTS.wrist.dofs.flexion.max,
  wristDev: JOINTS.wrist.dofs.deviation.max,
};

/** The selected hand and arm after the whole update, including finger correction. */
function finalFrame(h: Harness, side: Side): FinalFrame {
  const upper = h.profile.bones[`upperArm.${side}`];
  const lower = h.profile.bones[`lowerArm.${side}`];
  const hand = h.profile.bones[`hand.${side}`];
  if (!(upper && lower && hand)) throw new Error(`synthetic rig is missing ${side} arm bones`);
  const armLocal: FinalFrame['armLocal'] = [
    upper.quaternion.clone(),
    lower.quaternion.clone(),
    hand.quaternion.clone(),
  ];
  const joints = h.rig.measure(side);
  if (!joints) throw new Error(`synthetic rig cannot measure ${side} arm`);
  return {
    wrist: wristOf(h.profile, side),
    armLocal,
    joints,
    depth: fingerDepth(h, side),
  };
}

function reading(frame: FinalFrame, id: string): JointReading {
  const row = frame.joints.find((value) => value.id === id);
  if (!row) throw new Error(`final arm measurement has no ${id}`);
  return row;
}

/** Hard stops come from the joint table; a reading at the stop is still valid. */
function hardRange(row: JointReading): readonly [number, number] | null {
  if (row.id === 'elevation') return row.range;
  const range = HARD_BOUNDS[row.id];
  return range ? [(range[0] * 180) / Math.PI, (range[1] * 180) / Math.PI] : null;
}

function checkSwitch(spec: PathSpec): void {
  vi.spyOn(Math, 'random').mockReturnValue(spec.seed);
  const h = harness(spec.yaw);
  const dt = 1 / spec.fps;
  const step = () => {
    h.rig.reset();
    h.body.update(dt);
  };
  for (let i = 0; i < spec.idleFrames; i++) step();

  h.body.play(spec.from, spec.randomSide ? undefined : spec.side);
  const from = h.body.gesture;
  if (!from) throw new Error(`${spec.from} did not start`);
  const fromFrames = spec.fromFrames ?? Math.ceil((from.lead + (spec.fromLeadExtra ?? 0)) / dt);
  for (let i = 0; i < fromFrames; i++) step();

  const outgoingActive = h.body.gesture?.id === spec.from && h.body.blend === 1;
  const before = finalFrame(h, spec.side);
  const clearance = 0.5 * FINGER_WIDTH * (h.profile.limb?.[`pitch.${spec.side}`] ?? 0);
  if (!(clearance > 0)) throw new Error(`synthetic ${spec.side} hand has no finger clearance`);

  h.body.play(spec.to, spec.randomSide ? undefined : spec.side);
  let prior = before;
  let mostMoved = 0;
  let deepest = 0;
  let worstViolation: Violation | null = null;
  let worstWristStep = { id: '', frame: 0, degrees: 0 };
  let worstArmBoneStep = { id: '', frame: 0, degrees: 0 };
  const maxWristStepDegrees = (14 * dt * 180) / Math.PI + 0.5;

  for (let frameIndex = 1; frameIndex <= spec.toFrames; frameIndex++) {
    step();
    const current = finalFrame(h, spec.side);
    mostMoved = Math.max(mostMoved, before.wrist.distanceTo(current.wrist));
    deepest = Math.max(deepest, current.depth);

    for (const row of current.joints) {
      if (!row.measured) continue;
      const range = hardRange(row);
      if (!range) continue;
      const excess = Math.max(0, range[0] - row.deg, row.deg - range[1]);
      if (excess > (worstViolation?.excess ?? 0)) {
        worstViolation = { frame: frameIndex, id: row.id, value: row.deg, range, excess };
      }
    }

    for (const id of ['wristFlex', 'wristDev']) {
      const degrees = Math.abs(reading(current, id).deg - reading(prior, id).deg);
      if (degrees > worstWristStep.degrees) worstWristStep = { id, frame: frameIndex, degrees };
    }
    const upperDegrees = (prior.armLocal[0].angleTo(current.armLocal[0]) * 180) / Math.PI;
    if (upperDegrees > worstArmBoneStep.degrees)
      worstArmBoneStep = { id: 'upperArm', frame: frameIndex, degrees: upperDegrees };
    const lowerDegrees = (prior.armLocal[1].angleTo(current.armLocal[1]) * 180) / Math.PI;
    if (lowerDegrees > worstArmBoneStep.degrees)
      worstArmBoneStep = { id: 'lowerArm', frame: frameIndex, degrees: lowerDegrees };
    const handDegrees = (prior.armLocal[2].angleTo(current.armLocal[2]) * 180) / Math.PI;
    if (handDegrees > worstArmBoneStep.degrees)
      worstArmBoneStep = { id: 'hand', frame: frameIndex, degrees: handDegrees };
    prior = current;
  }

  const incoming = h.body.gesture;
  const incomingArrived =
    incoming?.id === spec.to && incoming.time >= incoming.lead && h.body.blend === 1;
  const label = `${spec.from} → ${spec.to} ${spec.side} ${spec.fps} Hz yaw ${spec.yaw}`;

  expect.soft(outgoingActive, `${label}: outgoing pose was not fully held`).toBe(true);
  expect.soft(incomingArrived, `${label}: incoming pose did not arrive`).toBe(true);
  expect
    .soft(mostMoved, `${label}: wrist moved only ${mostMoved.toFixed(4)} m`)
    .toBeGreaterThan(0.01);
  expect.soft(clearance, `${label}: synthetic clearance`).toBeGreaterThan(0);
  expect.soft(deepest, `${label}: deepest final finger point`).toBeLessThan(clearance);
  expect
    .soft(
      worstViolation?.excess ?? 0,
      worstViolation
        ? `${label}: frame ${worstViolation.frame} ${worstViolation.id}=${worstViolation.value.toFixed(3)}° outside [${worstViolation.range[0].toFixed(3)}, ${worstViolation.range[1].toFixed(3)}]°`
        : `${label}: final measured joints stay inside their hard stops`,
    )
    .toBeLessThanOrEqual(1e-4);
  expect
    .soft(
      worstWristStep.degrees,
      `${label}: frame ${worstWristStep.frame} ${worstWristStep.id} moved ${worstWristStep.degrees.toFixed(3)}°; allowance ${maxWristStepDegrees.toFixed(3)}°`,
    )
    .toBeLessThanOrEqual(maxWristStepDegrees);
  expect
    .soft(
      worstArmBoneStep.degrees,
      `${label}: no local arm bone rotated; final quaternions did not show the actual arm motion`,
    )
    .toBeGreaterThan(1e-3);
  expect
    .soft(
      worstArmBoneStep.degrees,
      `${label}: frame ${worstArmBoneStep.frame} ${worstArmBoneStep.id} rotated ${worstArmBoneStep.degrees.toFixed(3)}°; allowance ${maxWristStepDegrees.toFixed(3)}°`,
    )
    .toBeLessThanOrEqual(maxWristStepDegrees);
}

describe('final bones along face-touching gesture paths', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { side: 'L', yaw: 0, fps: 60 },
    { side: 'L', yaw: 0.7, fps: 30 },
    { side: 'R', yaw: 0, fps: 30 },
    { side: 'R', yaw: 0.7, fps: 60 },
  ] as const)(
    'keeps shrug→think within constraints for $side, yaw $yaw, $fps Hz',
    ({ side, yaw, fps }) => {
      checkSwitch({
        from: 'shrug',
        to: 'think',
        side,
        yaw,
        fps,
        seed: 0.5,
        idleFrames: Math.round(0.5 * fps),
        fromLeadExtra: 0.4,
        toFrames: Math.ceil(1.5 * fps),
      });
    },
  );

  it('keeps deny→cover within its final pose constraints', () => {
    checkSwitch({
      from: 'deny',
      to: 'cover',
      side: 'L',
      yaw: 0,
      fps: 60,
      seed: 0.5,
      idleFrames: 30,
      fromLeadExtra: 0.4,
      toFrames: 90,
    });
  });

  it('keeps listen→cover within its final pose constraints', () => {
    checkSwitch({
      from: 'listen',
      to: 'cover',
      side: 'R',
      yaw: 0,
      fps: 60,
      seed: 0.75,
      idleFrames: 1,
      fromFrames: 180,
      toFrames: 60,
      randomSide: true,
    });
  });
});
