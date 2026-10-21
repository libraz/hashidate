import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ArmAnatomy, elevationCeiling, JOINTS } from '@/engine/anatomy';
import { humeralReference, lateralReference } from '@/engine/anatomy/arm-frame';
import { buildProfile } from '@/engine/profile';
import { Rig, solveFingerAxes } from '@/engine/rig';
import {
  type ArmCalibration,
  type ArmCalibrationInput,
  type ArmConfiguration,
  type ArmForwardResult,
  boundArmConfiguration,
  captureArmCalibration,
  configurationOfDirections,
  forwardArm,
  makeArmForwardResult,
} from '@/engine/rig/arm-configuration';
import type { JointTable, Profile, Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

const EXACT = 1e-8;
const SIDES: readonly Side[] = ['L', 'R'];

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`synthetic rig has no ${what}`);
  return value;
}

const boneQuaternions = (profile: Profile) =>
  Object.values(profile.bones).flatMap((bone) => (bone ? [bone.quaternion.toArray()] : []));

function calibrationInput(profile: Profile, anatomy: ArmAnatomy, side: Side): ArmCalibrationInput {
  const upper = need(profile.bones[`upperArm.${side}`], `upperArm.${side}`);
  const lower = need(profile.bones[`lowerArm.${side}`], `lowerArm.${side}`);
  const hand = need(profile.bones[`hand.${side}`], `hand.${side}`);
  const chest = need(profile.bones.chest, 'chest');
  const upperWorld = upper.getWorldQuaternion(new THREE.Quaternion());
  const along = need(profile.restDir[`upperArm.${side}`], 'upper rest axis')
    .clone()
    .applyQuaternion(upperWorld);
  const front = need(profile.body, 'body frame')
    .forward.clone()
    .applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion()));
  front
    .addScaledVector(along, -front.dot(along))
    .normalize()
    .applyQuaternion(upperWorld.clone().invert());

  const palm = need(solveFingerAxes(profile).palmLocal[side], `${side} palm local`);
  return {
    upper: {
      axis: need(profile.restDir[`upperArm.${side}`], 'upper rest axis'),
      front,
      rest: upper.quaternion,
    },
    lower: {
      axis: need(profile.restDir[`lowerArm.${side}`], 'lower rest axis'),
      rest: lower.quaternion,
    },
    hand: {
      axis: need(profile.restDir[`hand.${side}`], 'hand rest axis'),
      palm,
      rest: hand.quaternion,
    },
    radialSign: anatomy.radialSign[side],
    joints: profile.anatomy ?? JOINTS,
  };
}

function calibration(profile: Profile, anatomy: ArmAnatomy, side: Side): ArmCalibration {
  return captureArmCalibration(calibrationInput(profile, anatomy, side));
}

function emptyConfiguration(): ArmConfiguration {
  return {
    shoulderPlane: 0,
    shoulderLift: 0,
    humeralRotation: 0,
    elbowFlex: 0,
    forearmRoll: 0,
    wristFlex: 0,
    wristDev: 0,
  };
}

function directionsOf(result: ArmForwardResult) {
  return { upperArm: result.u, lowerArm: result.l, hand: result.h };
}

function customJoints(): Profile['anatomy'] {
  return {
    ...JOINTS,
    shoulder: {
      ...JOINTS.shoulder,
      elevation: [
        [-180, 30, 60],
        [0, 30, 60],
        [180, 30, 60],
      ],
    },
  };
}

function invalidWristJoints(): JointTable {
  return {
    ...JOINTS,
    wrist: {
      ...JOINTS.wrist,
      dofs: {
        ...JOINTS.wrist.dofs,
        flexion: {
          ...JOINTS.wrist.dofs.flexion,
          max: [-Math.PI / 2, Math.PI / 2],
        },
        deviation: {
          ...JOINTS.wrist.dofs.deviation,
          max: [0, 0],
        },
      },
    },
  };
}

function wideRollJoints(): JointTable {
  return {
    ...JOINTS,
    elbow: {
      ...JOINTS.elbow,
      dofs: {
        ...JOINTS.elbow.dofs,
        rotation: {
          ...JOINTS.elbow.dofs.rotation,
          max: [-7, 7],
        },
      },
    },
  };
}

function scenario(
  side: Side,
  yaw: number,
  scale: number,
  oblique = false,
  joints?: Profile['anatomy'],
) {
  const fixture = buildRig({ armatureScale: scale });
  if (oblique) {
    for (const armSide of SIDES) {
      const sign = armSide === 'L' ? -1 : 1;
      need(fixture.bones.get(`UpperArm_${armSide}`), `UpperArm_${armSide}`).quaternion.setFromEuler(
        new THREE.Euler(0.17 * sign, -0.11 * sign, 0.23),
      );
      need(fixture.bones.get(`LowerArm_${armSide}`), `LowerArm_${armSide}`).quaternion.setFromEuler(
        new THREE.Euler(-0.13 * sign, 0.19, 0.16 * sign),
      );
      need(fixture.bones.get(`Hand_${armSide}`), `Hand_${armSide}`).quaternion.setFromEuler(
        new THREE.Euler(0.08, -0.21 * sign, 0.12 * sign),
      );
    }
  }
  fixture.root.rotation.y = yaw;
  fixture.root.updateMatrixWorld(true);
  const profile = buildProfile(fixture.root, fixture.descriptor);
  if (joints) profile.anatomy = joints;
  const anatomy = new ArmAnatomy(profile);
  expect(anatomy.update()).toBe(true);
  const upper = need(profile.bones[`upperArm.${side}`], `upperArm.${side}`);
  upper.updateWorldMatrix(true, false);
  const parent = need(upper.parent, 'upper parent');
  return {
    fixture,
    profile,
    anatomy,
    calibration: calibration(profile, anatomy, side),
    context: {
      side,
      shoulder: upper.getWorldPosition(new THREE.Vector3()),
      upperLength: need(profile.limb[`upper.${side}`], `upper length ${side}`),
      lowerLength: need(profile.limb[`lower.${side}`], `lower length ${side}`),
      up: anatomy.up.clone(),
      right: anatomy.right.clone(),
      forward: anatomy.fwd.clone(),
      upperParentWorld: parent.getWorldQuaternion(new THREE.Quaternion()),
    },
  };
}

const pose = {
  shoulderPlane: 0.41,
  shoulderLift: 0.72,
  humeralRotation: 0.38,
  elbowFlex: 1.1,
  forearmRoll: 0.52,
  wristFlex: 0.31,
  wristDev: -0.19,
};

describe('ArmConfiguration forward kinematics', () => {
  it.each([
    ['L', 0, 1, false],
    ['R', 0, 0.01, false],
    ['L', 0.7, 0.01, false],
    ['R', 0.7, 1, false],
    ['L', 0, 0.01, true],
    ['R', 0, 1, true],
    ['L', 0.7, 1, true],
    ['R', 0.7, 0.01, true],
  ] as const)(
    'round-trips anatomical DOFs for %s at yaw %s, scale %s and oblique bind %s',
    (side, yaw, scale, oblique) => {
      const h = scenario(side, yaw, scale, oblique);
      const bones = boneQuaternions(h.profile);
      const out = makeArmForwardResult();

      forwardArm(pose, h.calibration, h.context, out);

      expect(boneQuaternions(h.profile)).toEqual(bones);

      expect(out.u.length()).toBeCloseTo(1, 10);
      expect(out.l.length()).toBeCloseTo(1, 10);
      expect(out.h.length()).toBeCloseTo(1, 10);
      expect(Math.abs(out.palm.dot(out.h))).toBeLessThan(EXACT);
      expect(
        h.calibration.hand.palm
          .clone()
          .applyQuaternion(out.handWorld)
          .normalize()
          .distanceTo(out.palm),
      ).toBeLessThan(EXACT);
      expect(
        out.elbow.distanceTo(
          h.context.shoulder.clone().addScaledVector(out.u, h.context.upperLength),
        ),
      ).toBeLessThan(EXACT * Math.max(1, scale));
      expect(
        out.wrist.distanceTo(out.elbow.clone().addScaledVector(out.l, h.context.lowerLength)),
      ).toBeLessThan(EXACT * Math.max(1, scale));

      const upper = need(h.profile.bones[`upperArm.${side}`], `upperArm.${side}`);
      const lower = need(h.profile.bones[`lowerArm.${side}`], `lowerArm.${side}`);
      const hand = need(h.profile.bones[`hand.${side}`], `hand.${side}`);
      const rig = new Rig(h.profile);
      rig.foreRoll[side] = pose.forearmRoll;
      upper.quaternion.copy(out.upperLocal);
      lower.quaternion.copy(out.lowerLocal);
      hand.quaternion.copy(out.handLocal);
      h.profile.root.updateMatrixWorld(true);

      const rows = need(rig.measure(side), 'measured rows');
      const reading = (id: string) =>
        need(
          rows.find((row) => row.id === id),
          `reading ${id}`,
        ).deg;
      const deg = THREE.MathUtils.radToDeg;
      expect(reading('elevation')).toBeCloseTo(
        deg(pose.shoulderLift * elevationCeiling(pose.shoulderPlane).max),
        5,
      );
      expect(reading('plane')).toBeCloseTo(deg(pose.shoulderPlane), 5);
      expect(reading('rotation')).toBeCloseTo(deg(pose.humeralRotation), 5);
      expect(reading('elbow')).toBeCloseTo(deg(pose.elbowFlex), 5);
      expect(reading('forearm')).toBeCloseTo(deg(pose.forearmRoll), 5);
      expect(reading('wristFlex')).toBeCloseTo(deg(pose.wristFlex), 5);
      expect(reading('wristDev')).toBeCloseTo(deg(pose.wristDev), 5);
    },
  );

  it('captures rest axes, quaternions, palm frame and hard ranges by value', () => {
    const h = scenario('L', 0.7, 1, true, customJoints());
    const input = calibrationInput(h.profile, h.anatomy, 'L');
    const captured = captureArmCalibration(input);
    const upperAxis = captured.upper.axis.clone();
    const upperRest = captured.upper.rest.clone();
    const palm = captured.hand.palm.clone();
    const ceiling = captured.joints.shoulder.elevation[0]?.[2];

    input.upper.axis.negate();
    input.upper.rest.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.7);
    input.hand.palm.negate();
    if (input.joints.shoulder.elevation[0]) input.joints.shoulder.elevation[0][2] = 170;

    expect(captured.upper.axis).toEqual(upperAxis);
    expect(captured.upper.rest.angleTo(upperRest)).toBeLessThan(EXACT);
    expect(captured.hand.palm).toEqual(palm);
    expect(captured.joints.shoulder.elevation[0]?.[2]).toBe(ceiling);
  });

  it('rejects wrist hard ranges outside the exact inverse domain', () => {
    const h = scenario('L', 0, 1);
    const input = calibrationInput(h.profile, h.anatomy, 'L');

    expect(() => captureArmCalibration({ ...input, joints: invalidWristJoints() })).toThrow(
      'wrist hard ranges must stay inside a 90 degree combined bend',
    );
  });

  it('uses one avatar ceiling for forward placement, measurement, reporting and clamp', () => {
    const joints = customJoints();
    const h = scenario('R', 0.7, 0.01, true, joints);
    const out = makeArmForwardResult();
    forwardArm({ ...pose, shoulderPlane: 0, shoulderLift: 1 }, h.calibration, h.context, out);
    const angle = Math.acos(THREE.MathUtils.clamp(-out.u.dot(h.context.up), -1, 1));
    expect(angle).toBeCloseTo(THREE.MathUtils.degToRad(60), 10);

    const rig = new Rig(h.profile);
    rig.foreRoll.R = pose.forearmRoll;
    need(h.profile.bones['upperArm.R'], 'upperArm.R').quaternion.copy(out.upperLocal);
    need(h.profile.bones['lowerArm.R'], 'lowerArm.R').quaternion.copy(out.lowerLocal);
    need(h.profile.bones['hand.R'], 'hand.R').quaternion.copy(out.handLocal);
    h.profile.root.updateMatrixWorld(true);
    const elevationRow = need(
      need(rig.measure('R'), 'measured rows').find((row) => row.id === 'elevation'),
      'elevation row',
    );
    expect(elevationRow.deg).toBeCloseTo(60, 8);
    expect(elevationRow.range[1]).toBeCloseTo(60, 10);

    const u = h.context.up
      .clone()
      .multiplyScalar(-Math.cos(THREE.MathUtils.degToRad(80)))
      .addScaledVector(h.context.right, Math.sin(THREE.MathUtils.degToRad(80)));
    const l = u.clone();
    const hand = u.clone();
    h.anatomy.clamp('R', u, l, hand, null);
    const clamped = h.anatomy.measure('R', u, l, hand, null);
    expect(clamped.elevation).toBeCloseTo(THREE.MathUtils.degToRad(60), 10);
    expect(h.anatomy.report().find((row) => row.id === 'elevation')?.range[1]).toBeCloseTo(60, 10);
  });

  it('keeps arm frames and calibration inputs independent', () => {
    const h = scenario('R', 0.7, 1);
    const copy = makeArmForwardResult();
    const input = { ...pose };
    const shoulder = h.context.shoulder.clone();
    const calibrationBefore = h.calibration.upper.axis.clone();
    const bonesBefore = boneQuaternions(h.profile);

    forwardArm(input, h.calibration, h.context, copy);

    expect(input).toEqual(pose);
    expect(h.context.shoulder).toEqual(shoulder);
    expect(h.calibration.upper.axis).toEqual(calibrationBefore);
    expect(boneQuaternions(h.profile)).toEqual(bonesBefore);
    expect(Math.abs(copy.palm.dot(copy.h))).toBeLessThan(EXACT);
  });

  it('uses continuous scalar angles across the plane seam and humeral limits', () => {
    const h = scenario('L', 0.7, 0.01);
    const planeSamples = [-0.01, 0, 0.01].map((step) => {
      const out = makeArmForwardResult();
      forwardArm(
        {
          ...pose,
          shoulderPlane: Math.PI + step,
          humeralRotation: 0.35,
        },
        h.calibration,
        h.context,
        out,
      );
      return out;
    });

    expect(planeSamples[0]?.u.distanceTo(planeSamples[1]?.u ?? new THREE.Vector3())).toBeLessThan(
      0.02,
    );
    expect(planeSamples[1]?.u.distanceTo(planeSamples[2]?.u ?? new THREE.Vector3())).toBeLessThan(
      0.02,
    );

    const humeralStart = THREE.MathUtils.degToRad(-89);
    const humeralEnd = THREE.MathUtils.degToRad(89);
    let previous: THREE.Vector3 | undefined;
    for (let index = 0; index <= 180; index++) {
      const humeralRotation = humeralStart + ((humeralEnd - humeralStart) * index) / 180;
      const out = makeArmForwardResult();
      forwardArm({ ...pose, humeralRotation }, h.calibration, h.context, out);
      const measured = h.anatomy.measure('L', out.u, out.l, out.h, out.palm);
      expect(measured.rotation).toBeCloseTo(humeralRotation, 8);
      expect(Math.abs(measured.rotation)).toBeLessThanOrEqual(JOINTS.shoulder.dofs.rotation.max[1]);
      if (previous) expect(out.l.distanceTo(previous)).toBeLessThan(0.02);
      previous = out.l.clone();
    }
  });

  it('clamps each configured DOF to its existing hard range', () => {
    const h = scenario('R', 0, 1);
    const out = makeArmForwardResult();
    const request = {
      shoulderPlane: 0,
      shoulderLift: 1,
      humeralRotation: Math.PI,
      elbowFlex: Math.PI,
      forearmRoll: -Math.PI,
      wristFlex: Math.PI,
      wristDev: -Math.PI,
    };
    const bounded = emptyConfiguration();
    boundArmConfiguration(request, h.calibration, bounded);
    forwardArm(bounded, h.calibration, h.context, out);

    const upper = need(h.profile.bones['upperArm.R'], 'upperArm.R');
    const lower = need(h.profile.bones['lowerArm.R'], 'lowerArm.R');
    const hand = need(h.profile.bones['hand.R'], 'hand.R');
    const rig = new Rig(h.profile);
    rig.foreRoll.R = bounded.forearmRoll;
    upper.quaternion.copy(out.upperLocal);
    lower.quaternion.copy(out.lowerLocal);
    hand.quaternion.copy(out.handLocal);
    h.profile.root.updateMatrixWorld(true);

    const rows = need(rig.measure('R'), 'measured rows');
    const reading = (id: string) =>
      need(
        rows.find((row) => row.id === id),
        `reading ${id}`,
      ).deg;
    const deg = THREE.MathUtils.radToDeg;
    expect(reading('rotation')).toBeCloseTo(deg(JOINTS.shoulder.dofs.rotation.max[1]), 5);
    expect(reading('elbow')).toBeCloseTo(deg(JOINTS.elbow.dofs.flexion.max[1]), 5);
    expect(reading('forearm')).toBeCloseTo(deg(JOINTS.elbow.dofs.rotation.max[0]), 5);
    expect(reading('wristFlex')).toBeCloseTo(deg(JOINTS.wrist.dofs.flexion.max[1]), 5);
    expect(reading('wristDev')).toBeCloseTo(deg(JOINTS.wrist.dofs.deviation.max[0]), 5);
  });

  it('keeps raw forward requests exact and clips only through the explicit bounder', () => {
    const h = scenario('R', 0, 1);
    const request = {
      shoulderPlane: 0.4,
      shoulderLift: 1.1,
      humeralRotation: 2,
      elbowFlex: 2.8,
      forearmRoll: 0,
      wristFlex: 0,
      wristDev: 0,
    };
    const raw = makeArmForwardResult();
    const bounded = emptyConfiguration();
    const boundedForward = makeArmForwardResult();

    forwardArm(request, h.calibration, h.context, raw);
    boundArmConfiguration(request, h.calibration, bounded);
    forwardArm(bounded, h.calibration, h.context, boundedForward);

    expect(bounded.shoulderLift).toBe(1);
    expect(bounded.humeralRotation).toBe(JOINTS.shoulder.dofs.rotation.max[1]);
    expect(bounded.elbowFlex).toBe(JOINTS.elbow.dofs.flexion.max[1]);
    expect(raw.u.distanceTo(boundedForward.u)).toBeGreaterThan(0.1);
    expect(raw.l.distanceTo(boundedForward.l)).toBeGreaterThan(0.1);
  });

  it.each([
    ['L', 0, 1, false],
    ['R', 0, 0.01, false],
    ['L', 0.7, 0.01, false],
    ['R', 0.7, 1, false],
    ['L', 0, 0.01, true],
    ['R', 0, 1, true],
    ['L', 0.7, 1, true],
    ['R', 0.7, 0.01, true],
  ] as const)(
    'inverts and forwards arm directions for %s at yaw %s, scale %s and oblique bind %s',
    (side, yaw, scale, oblique) => {
      const h = scenario(side, yaw, scale, oblique);
      const source = makeArmForwardResult();
      forwardArm(pose, h.calibration, h.context, source);
      const recovered = emptyConfiguration();
      expect(
        configurationOfDirections(
          directionsOf(source),
          source.palm,
          h.calibration,
          h.context,
          null,
          recovered,
        ),
      ).toBe(true);

      for (const key of Object.keys(pose) as (keyof ArmConfiguration)[]) {
        expect(recovered[key]).toBeCloseTo(pose[key], 7);
      }

      const result = makeArmForwardResult();
      forwardArm(recovered, h.calibration, h.context, result);
      expect(result.u.distanceTo(source.u)).toBeLessThan(EXACT);
      expect(result.l.distanceTo(source.l)).toBeLessThan(EXACT);
      expect(result.h.distanceTo(source.h)).toBeLessThan(EXACT);
      expect(result.palm.distanceTo(source.palm)).toBeLessThan(EXACT);
    },
  );

  it('unwraps the shoulder plane near the previous value across its seam', () => {
    const h = scenario('L', 0.7, 1);
    const source = makeArmForwardResult();
    forwardArm({ ...pose, shoulderPlane: -Math.PI + 0.01 }, h.calibration, h.context, source);
    const recovered = emptyConfiguration();
    expect(
      configurationOfDirections(
        directionsOf(source),
        source.palm,
        h.calibration,
        h.context,
        { ...pose, shoulderPlane: Math.PI - 0.01 },
        recovered,
      ),
    ).toBe(true);
    expect(recovered.shoulderPlane).toBeCloseTo(Math.PI + 0.01, 7);
  });

  it('preserves prior pronation when the palm is genuinely unconstrained', () => {
    const h = scenario('R', 0.7, 1, true);
    const source = makeArmForwardResult();
    forwardArm(pose, h.calibration, h.context, source);
    const recovered = emptyConfiguration();
    const previous = { ...pose, forearmRoll: 0.73 };

    expect(
      configurationOfDirections(
        directionsOf(source),
        null,
        h.calibration,
        h.context,
        previous,
        recovered,
      ),
    ).toBe(true);
    expect(recovered.forearmRoll).toBe(previous.forearmRoll);
    const result = makeArmForwardResult();
    forwardArm(recovered, h.calibration, h.context, result);
    expect(result.h.distanceTo(source.h)).toBeLessThan(EXACT);
  });

  it('uses equivalent pronation only when it remains inside the physical range', () => {
    for (const allowMultipleTurns of [false, true]) {
      const h = scenario('R', 0, 1, false, allowMultipleTurns ? wideRollJoints() : undefined);
      const source = makeArmForwardResult();
      forwardArm({ ...pose, forearmRoll: 0.3 }, h.calibration, h.context, source);
      const recovered = emptyConfiguration();
      expect(
        configurationOfDirections(
          directionsOf(source),
          source.palm,
          h.calibration,
          h.context,
          { ...pose, forearmRoll: Math.PI * 2 + 0.3 },
          recovered,
        ),
      ).toBe(true);
      expect(recovered.forearmRoll).toBeCloseTo(allowMultipleTurns ? Math.PI * 2 + 0.3 : 0.3, 7);
    }
  });

  it('returns false for degenerate directions, palm projections and calibration frames', () => {
    const h = scenario('L', 0, 1);
    const source = makeArmForwardResult();
    forwardArm(pose, h.calibration, h.context, source);
    const output = emptyConfiguration();

    expect(
      configurationOfDirections(
        { ...directionsOf(source), upperArm: new THREE.Vector3() },
        source.palm,
        h.calibration,
        h.context,
        null,
        output,
      ),
    ).toBe(false);
    expect(
      configurationOfDirections(
        directionsOf(source),
        source.l,
        h.calibration,
        h.context,
        null,
        output,
      ),
    ).toBe(false);

    expect(
      configurationOfDirections(
        { ...directionsOf(source), hand: source.l.clone().negate() },
        source.palm,
        h.calibration,
        h.context,
        null,
        output,
      ),
    ).toBe(false);

    expect(
      configurationOfDirections(
        directionsOf(source),
        source.palm,
        h.calibration,
        { ...h.context, up: new THREE.Vector3() },
        null,
        output,
      ),
    ).toBe(false);

    h.calibration.upper.axis.set(0, 0, 0);
    expect(
      configurationOfDirections(
        directionsOf(source),
        source.palm,
        h.calibration,
        h.context,
        null,
        output,
      ),
    ).toBe(false);
  });

  it('retains out-of-range anatomical angles rather than clamping the inverse', () => {
    const h = scenario('R', 0.7, 1);
    const plane = Math.PI / 2;
    const elevation = 3.1;
    const lateral = h.context.right.clone();
    if (h.context.side === 'L') lateral.negate();
    const upperArm = h.context.up
      .clone()
      .multiplyScalar(-Math.cos(elevation))
      .addScaledVector(lateral, Math.sin(elevation) * Math.cos(plane))
      .addScaledVector(h.context.forward, Math.sin(elevation) * Math.sin(plane))
      .normalize();
    const ref = new THREE.Vector3();
    const perp = new THREE.Vector3();
    const bend = new THREE.Vector3();
    humeralReference(upperArm, h.context.up, h.context.forward, ref);
    lateralReference(upperArm, ref, h.context.up, h.context.forward, lateral, perp);
    bend.copy(ref).multiplyScalar(Math.cos(2)).addScaledVector(perp, Math.sin(2)).normalize();
    const lowerArm = upperArm
      .clone()
      .multiplyScalar(Math.cos(2.8))
      .addScaledVector(bend, Math.sin(2.8))
      .normalize();
    const palm = h.context.forward
      .clone()
      .addScaledVector(lowerArm, -h.context.forward.dot(lowerArm));
    if (palm.lengthSq() < 1e-10) {
      palm.copy(h.context.right).addScaledVector(lowerArm, -h.context.right.dot(lowerArm));
    }
    palm.normalize();
    const recovered = emptyConfiguration();

    expect(
      configurationOfDirections(
        { upperArm, lowerArm, hand: lowerArm },
        palm,
        h.calibration,
        h.context,
        null,
        recovered,
      ),
    ).toBe(true);
    expect(recovered.shoulderLift).toBeGreaterThan(1);
    expect(recovered.humeralRotation).toBeCloseTo(2, 7);
    expect(recovered.elbowFlex).toBeCloseTo(2.8, 7);
  });

  it('recovers wrist requests beyond hard stops without clipping them', () => {
    const h = scenario('R', 0.7, 1);
    const base = makeArmForwardResult();
    forwardArm({ ...pose, wristFlex: 0, wristDev: 0 }, h.calibration, h.context, base);
    const flex = 1.7;
    const deviation = 0.5;
    const angle = Math.hypot(flex, deviation);
    const radial = new THREE.Vector3()
      .crossVectors(base.palm, base.l)
      .multiplyScalar(h.calibration.radialSign)
      .normalize();
    const swing = base.palm
      .clone()
      .multiplyScalar(flex / angle)
      .addScaledVector(radial, deviation / angle);
    const hand = base.l
      .clone()
      .multiplyScalar(Math.cos(angle))
      .addScaledVector(swing, Math.sin(angle))
      .normalize();
    const palm = base.palm
      .clone()
      .multiplyScalar(Math.cos(angle))
      .addScaledVector(base.l, (-Math.sin(angle) * flex) / angle)
      .normalize();
    const recovered = emptyConfiguration();

    expect(
      configurationOfDirections(
        { upperArm: base.u, lowerArm: base.l, hand },
        palm,
        h.calibration,
        h.context,
        { ...pose, forearmRoll: pose.forearmRoll },
        recovered,
      ),
    ).toBe(true);
    expect(recovered.wristFlex).toBeCloseTo(flex, 7);
    expect(recovered.wristDev).toBeCloseTo(deviation, 7);
  });
});
