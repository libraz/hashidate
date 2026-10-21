import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import {
  configurationOfDirections,
  forwardArm,
  makeArmForwardResult,
} from '@/engine/rig/arm-configuration';
import {
  FINGER_TIP_EXTENSION,
  makeHandGeometrySample,
  sampleHandGeometry,
} from '@/engine/rig/hand-geometry';
import type { Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

const EXACT = 1e-8;

function scenario(side: Side, flex: number, deviation: number) {
  const built = buildRig({ armatureScale: side === 'L' ? 1 : 0.01 });
  built.root.rotation.y = deviation < 0 ? 0.7 : 0;
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const driver = rig.armDriver(side);
  const context = rig.armForwardContext(side);
  if (!(driver && context)) throw new Error(`missing ${side} arm driver`);
  const configuration = {
    shoulderPlane: 0.41,
    shoulderLift: 0.72,
    humeralRotation: 0.38,
    elbowFlex: 1.1,
    forearmRoll: 0,
    wristFlex: flex,
    wristDev: deviation,
  };
  const forward = forwardArm(configuration, driver.calibration, context, makeArmForwardResult());
  return { profile, rig, driver, context, configuration, forward };
}

describe('arm request palm transport', () => {
  it.each([
    ['L', Math.PI / 6],
    ['R', Math.PI / 6],
    ['L', -Math.PI / 6],
    ['R', -Math.PI / 6],
  ] as const)('shares the mixed-wrist FK reference for %s with deviation %s', (side, deviation) => {
    const { driver, context, forward, configuration } = scenario(side, Math.PI / 3, deviation);
    driver.requestRollHistory = 0;
    const compose = (target: THREE.Vector3 | null, weight: number, twist: number) => {
      const request = driver.composeRequest(
        context,
        forward.u,
        forward.l,
        forward.h,
        target,
        weight,
        twist,
        {},
        {},
        false,
      );
      if (!request.palm) throw new Error('mixed wrist request lost its palm');
      return request.palm.clone();
    };

    // A partial weight must not pull an already canonical palm toward a second convention.
    expect.soft(compose(forward.palm, 0.5, 0).distanceTo(forward.palm)).toBeLessThan(EXACT);
    const twist = 0.4;
    const weight = 0.25;
    const target = forward.palm.clone().applyAxisAngle(forward.h, twist);
    const expectedWeighted = forward.palm.clone().applyAxisAngle(forward.h, twist * weight);
    const weighted = compose(target, weight, 0);
    expect.soft(weighted.distanceTo(expectedWeighted)).toBeLessThan(EXACT);
    // Pose twist is defined about the hand axis; it is not anatomical forearmRoll.
    expect.soft(compose(null, 0, twist).distanceTo(target)).toBeLessThan(EXACT);
    expect(driver.requestRollHistory).toBe(0);

    const recovered = { ...configuration };
    expect(
      configurationOfDirections(
        { upperArm: forward.u, lowerArm: forward.l, hand: forward.h },
        weighted,
        driver.calibration,
        context,
        configuration,
        recovered,
      ),
    ).toBe(true);
    const rebuilt = forwardArm(recovered, driver.calibration, context, makeArmForwardResult());
    expect(rebuilt.h.distanceTo(forward.h)).toBeLessThan(EXACT);
    expect(rebuilt.palm.distanceTo(weighted)).toBeLessThan(EXACT);
  });

  it.each(['L', 'R'] as const)(
    'keeps the %s canonical endpoint, actual hand and fingers consistent',
    (side) => {
      const { profile, rig, driver, context, configuration, forward } = scenario(
        side,
        Math.PI / 3,
        -Math.PI / 6,
      );
      const curls = { thumb: 0.2, index: 0.4, middle: 0.6, ring: 0.3, little: 0.5 };
      const spread = { index: 0.2, ring: -0.1 };
      const request = driver.composeRequest(
        context,
        forward.u,
        forward.l,
        forward.h,
        forward.palm,
        0.5,
        0,
        curls,
        spread,
        false,
      );
      if (!request.palm) throw new Error('canonical endpoint lost its palm');
      const requestedPalm = request.palm.clone();
      expect.soft(requestedPalm.distanceTo(forward.palm)).toBeLessThan(EXACT);
      driver.captureVolumeFrame();
      const q = driver.configurationToQ(configuration, new Float64Array(7));
      expect(driver.validateLockedPose(q, context, curls, spread)).toBe(true);
      expect(rig.stageArmForward(side, forward, curls, spread)).toBe(true);
      const hand = profile.bones[`hand.${side}`];
      const localPalm = rig.palmLocal[side];
      if (!(hand && localPalm)) throw new Error(`missing ${side} hand frame`);
      const actualWorld = hand.getWorldQuaternion(new THREE.Quaternion());
      expect
        .soft(localPalm.clone().applyQuaternion(actualWorld).distanceTo(requestedPalm))
        .toBeLessThan(EXACT);
      expect(
        profile.restDir[`hand.${side}`].clone().applyQuaternion(actualWorld).distanceTo(forward.h),
      ).toBeLessThan(EXACT);
      expect(hand.getWorldPosition(new THREE.Vector3()).distanceTo(forward.wrist)).toBeLessThan(
        EXACT,
      );

      const geometry = sampleHandGeometry(
        driver.handGeometry,
        curls,
        spread,
        makeHandGeometrySample(driver.handGeometry),
      );
      expect(geometry.points.length).toBeGreaterThan(0);
      for (const point of geometry.points) {
        const chain = profile.fingerBones[`${point.finger}.${side}`];
        if (!chain) throw new Error(`missing ${point.finger}.${side}`);
        const actual = chain[point.jointIndex].getWorldPosition(new THREE.Vector3());
        if (point.tip) {
          const previous = chain[point.jointIndex - 1].getWorldPosition(new THREE.Vector3());
          actual.addScaledVector(actual.clone().sub(previous), FINGER_TIP_EXTENSION);
        }
        const predicted = point.position
          .clone()
          .applyQuaternion(forward.handWorld)
          .add(forward.wrist);
        expect(
          actual.distanceTo(predicted),
          `${point.finger}.${point.jointIndex}.${point.tip}`,
        ).toBeLessThan(EXACT);
      }
    },
  );

  it.each([
    ['straight', 0, 0],
    ['pure flexion', Math.PI / 3, 0],
    ['pure deviation', 0, Math.PI / 9],
    ['below inverse wrist threshold', 4e-5, -2e-5],
  ] as const)('retains the FK palm for a %s wrist', (_, flex, deviation) => {
    const { driver, context, forward } = scenario('R', flex, deviation);
    const request = driver.composeRequest(
      context,
      forward.u,
      forward.l,
      forward.h,
      forward.palm,
      0.5,
      0,
      {},
      {},
      false,
    );
    if (!request.palm) throw new Error('regular wrist request lost its palm');
    expect(request.palm.distanceTo(forward.palm)).toBeLessThan(EXACT);
    expect(request.hand.distanceTo(forward.h)).toBeLessThan(EXACT);
  });

  it.each(['opposite', 'right angle flexion', 'right angle deviation'] as const)(
    'keeps a finite request at an unsupported %s wrist without claiming endpoint feasibility',
    (kind) => {
      const { driver, context, forward } = scenario('R', 0, 0);
      const hand =
        kind === 'opposite'
          ? forward.l.clone().negate()
          : kind === 'right angle flexion'
            ? forward.palm.clone()
            : new THREE.Vector3().crossVectors(forward.palm, forward.l).normalize();
      const request = driver.composeRequest(
        context,
        forward.u,
        forward.l,
        hand,
        null,
        0,
        0.4,
        {},
        {},
        false,
      );
      expect(request.hand.toArray().every(Number.isFinite)).toBe(true);
      if (request.palm) {
        expect(request.palm.toArray().every(Number.isFinite)).toBe(true);
        expect(Math.abs(request.palm.length() - 1)).toBeLessThan(EXACT);
        expect(Math.abs(request.palm.dot(request.hand))).toBeLessThan(EXACT);
      }
    },
  );
});
