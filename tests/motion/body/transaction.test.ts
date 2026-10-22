import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { fingerCurl, thumbOpposition } from '@/engine/anatomy';
import { Body } from '@/engine/motion/body';
import { BASE_FINGERS, BASE_PALM, BASE_POSE } from '@/engine/motion/gestures/base';
import { CUTE } from '@/engine/motion/gestures/cute';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import {
  type ArmConfiguration,
  configurationOfDirections,
  forwardArm,
} from '@/engine/rig/arm-configuration';
import type { ArmPathPlanOutput } from '@/engine/rig/arm-path';
import { composeFingerRotation } from '@/engine/rig/hands';
import type { ArmSlot, FingerName, GestureDef, Profile, Side } from '@/engine/types';
import { buildRig } from '../../helpers/scene';
import { DT, harness } from './harness';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

function canonical(
  direction: THREE.Vector3,
  h: ReturnType<typeof harness>,
  side: 'L' | 'R',
): THREE.Vector3 {
  return new THREE.Vector3(
    direction.dot(h.rig.anat.right) * (side === 'R' ? 1 : -1),
    direction.dot(h.rig.anat.up),
    direction.dot(h.rig.anat.fwd),
  ).normalize();
}

function quaternionComponentDelta(a: THREE.Quaternion, b: THREE.Quaternion): number {
  const sign = a.dot(b) < 0 ? -1 : 1;
  return Math.max(
    Math.abs(a.x - sign * b.x),
    Math.abs(a.y - sign * b.y),
    Math.abs(a.z - sign * b.z),
    Math.abs(a.w - sign * b.w),
  );
}

function standingWorldDirection(
  rig: Rig,
  profile: Profile,
  side: Side,
  slot: Exclude<ArmSlot, 'shoulder'>,
): THREE.Vector3 {
  const override = profile.avatar.armRest?.[slot];
  const direction = override ? new THREE.Vector3(...override).normalize() : BASE_POSE[slot].clone();
  return rig.anat.right
    .clone()
    .multiplyScalar(direction.x * (side === 'R' ? 1 : -1))
    .addScaledVector(rig.anat.up, direction.y)
    .addScaledVector(rig.anat.fwd, direction.z)
    .normalize();
}

function worldDirection(rig: Rig, side: Side, direction: THREE.Vector3): THREE.Vector3 {
  return rig.anat.right
    .clone()
    .multiplyScalar(direction.x * (side === 'R' ? 1 : -1))
    .addScaledVector(rig.anat.up, direction.y)
    .addScaledVector(rig.anat.fwd, direction.z)
    .normalize();
}

describe('atomic arm frame transaction', () => {
  it('starts at the default standing pose before the first body update', () => {
    const built = buildRig();
    const profile = buildProfile(built.root, built.descriptor);
    const rig = new Rig(profile);
    const initialWrists = (['L', 'R'] as const).map((side) => {
      const hand = profile.bones[`hand.${side}`];
      if (!hand) throw new Error(`missing ${side} hand`);
      hand.updateWorldMatrix(true, false);
      return hand.getWorldPosition(new THREE.Vector3());
    });
    const initialRevision = rig.externalArmRevision;

    new Body(rig, profile);
    rig.anat.update();

    for (const [index, side] of (['L', 'R'] as const).entries()) {
      const driver = rig.armDriver(side);
      const handBone = profile.bones[`hand.${side}`];
      const upperBone = profile.bones[`upperArm.${side}`];
      const lowerBone = profile.bones[`lowerArm.${side}`];
      const palmLocal = rig.palmLocal[side];
      if (!(driver && handBone && upperBone && lowerBone && palmLocal)) {
        throw new Error(`missing ${side} arm frame`);
      }
      const upper = standingWorldDirection(rig, profile, side, 'upperArm');
      const lower = standingWorldDirection(rig, profile, side, 'lowerArm');
      const hand = standingWorldDirection(rig, profile, side, 'hand');
      const palmCharacter = BASE_PALM.clone();
      palmCharacter.x *= side === 'R' ? 1 : -1;
      const palm = rig.anat.right
        .clone()
        .multiplyScalar(palmCharacter.x)
        .addScaledVector(rig.anat.up, palmCharacter.y)
        .addScaledVector(rig.anat.fwd, palmCharacter.z);
      palm.addScaledVector(hand, -palm.dot(hand)).normalize();

      for (const bone of [upperBone, lowerBone, handBone]) {
        bone.updateWorldMatrix(true, false);
      }
      const upperWorld = upperBone.getWorldQuaternion(new THREE.Quaternion());
      const lowerWorld = lowerBone.getWorldQuaternion(new THREE.Quaternion());
      const handWorld = handBone.getWorldQuaternion(new THREE.Quaternion());
      expect(quaternionComponentDelta(upperWorld, driver.acceptedForward.upperWorld)).toBeLessThan(
        1e-8,
      );
      expect(quaternionComponentDelta(lowerWorld, driver.acceptedForward.lowerWorld)).toBeLessThan(
        1e-8,
      );
      expect(quaternionComponentDelta(handWorld, driver.acceptedForward.handWorld)).toBeLessThan(
        1e-8,
      );
      const actualUpper = profile.restDir[`upperArm.${side}`]
        .clone()
        .applyQuaternion(upperWorld)
        .normalize();
      const actualLower = profile.restDir[`lowerArm.${side}`]
        .clone()
        .applyQuaternion(lowerWorld)
        .normalize();
      const actualHand = profile.restDir[`hand.${side}`]
        .clone()
        .applyQuaternion(handWorld)
        .normalize();
      const actualPalm = palmLocal.clone().applyQuaternion(handWorld).normalize();

      expect(driver.acceptedForward.u.angleTo(upper)).toBeLessThan(1e-7);
      expect(driver.acceptedForward.l.angleTo(lower)).toBeLessThan(1e-7);
      expect(driver.acceptedForward.h.angleTo(hand)).toBeLessThan(1e-7);
      expect(driver.acceptedForward.palm.angleTo(palm)).toBeLessThan(1e-7);
      expect(actualUpper.angleTo(upper)).toBeLessThan(1e-7);
      expect(actualLower.angleTo(lower)).toBeLessThan(1e-7);
      expect(actualHand.angleTo(hand)).toBeLessThan(1e-7);
      expect(actualPalm.angleTo(palm)).toBeLessThan(1e-7);
      expect(actualUpper.angleTo(driver.acceptedForward.u)).toBeLessThan(1e-7);
      expect(actualLower.angleTo(driver.acceptedForward.l)).toBeLessThan(1e-7);
      expect(actualHand.angleTo(driver.acceptedForward.h)).toBeLessThan(1e-7);
      expect(actualPalm.angleTo(driver.acceptedForward.palm)).toBeLessThan(1e-7);

      const actualElbow = lowerBone.getWorldPosition(new THREE.Vector3());
      const actualWrist = handBone.getWorldPosition(new THREE.Vector3());
      expect(actualElbow.distanceTo(driver.acceptedForward.elbow)).toBeLessThan(1e-7);
      expect(actualWrist.distanceTo(driver.acceptedForward.wrist)).toBeLessThan(1e-7);

      expect(driver.acceptedCurls).toEqual(BASE_FINGERS);
      expect(
        initialWrists[index].distanceTo(handBone.getWorldPosition(new THREE.Vector3())),
      ).toBeGreaterThan(0.1);

      for (const finger of ['thumb', 'index', 'middle', 'ring', 'little'] as const) {
        const chain = profile.fingerBones[`${finger}.${side}`];
        if (!chain) throw new Error(`missing ${finger}.${side} finger chain`);
        const joints = finger === 'thumb' ? rig.joints.thumb : rig.joints.finger;
        for (const [jointIndex, bone] of chain.entries()) {
          const rest = rig.rest.get(bone);
          const axis = rig.fingerAxis.get(bone);
          if (!(rest && axis)) throw new Error(`missing ${finger}.${side} finger calibration`);
          const expected = rest
            .clone()
            .multiply(
              new THREE.Quaternion().setFromAxisAngle(
                axis,
                fingerCurl(joints, jointIndex, BASE_FINGERS[finger]),
              ),
            );
          expect(quaternionComponentDelta(bone.quaternion, expected)).toBeLessThan(1e-8);
        }
      }
    }
    expect(rig.externalArmRevision).toBe(initialRevision);
  });

  it.each([1 / 60, 1 / 20])('reaches the ordinary standing pose at dt=%s', (dt) => {
    const h = harness();
    h.rig.anat.update();
    const awayPlans: Partial<
      Record<
        Side,
        {
          output: ArmPathPlanOutput;
          context: NonNullable<ReturnType<Rig['armForwardContext']>>;
          curls: Record<FingerName, number>;
          spread: Record<FingerName, number>;
        }
      >
    > = {};
    for (const side of ['L', 'R'] as const) {
      const driver = h.rig.armDriver(side);
      const context = h.rig.armForwardContext(side);
      if (!(driver && context)) throw new Error(`missing ${side} bootstrap geometry`);
      const goal: ArmConfiguration = {
        ...driver.acceptedConfiguration,
        shoulderPlane: -0.4,
        shoulderLift: 0.9,
        humeralRotation: 0.2,
        elbowFlex: 1.4,
        forearmRoll: 0,
        wristFlex: 0.1,
        wristDev: 0.05,
      };
      const q = new Float64Array(7);
      driver.configurationToQ(goal, q);
      const curls = { ...driver.acceptedCurls };
      const spread = { ...driver.acceptedSpread };
      const request = driver.requestForConfiguration(goal, context, curls, spread);
      driver.captureVolumeFrame();
      expect(
        driver.solver.restoreEndpoint(
          request,
          q,
          context,
          { lower: q, upper: q },
          driver.environment,
          driver.bridgeOutput,
        ),
        `${side} away FK pose must be independently feasible`,
      ).toBe(true);
      awayPlans[side] = {
        output: driver.bridgeOutput,
        context,
        curls,
        spread,
      };
    }
    const left = awayPlans.L;
    const right = awayPlans.R;
    expect(left && right).toBeTruthy();
    if (!(left && right)) return;
    expect(h.rig.commitArmFrame({ L: left, R: right }, 0)).toBe(true);
    h.body = new Body(h.rig, h.profile);
    h.body.breathDepth = 0;
    h.body.idleAmount = 0;
    h.body.weightShift = 0;
    h.body.gazeAmount = 0;
    const initialWrists = (['L', 'R'] as const).map((side) => {
      const hand = h.profile.bones[`hand.${side}`];
      if (!hand) throw new Error(`missing ${side} hand`);
      hand.updateWorldMatrix(true, false);
      return hand.getWorldPosition(new THREE.Vector3());
    });
    for (let frame = 0; frame < Math.ceil(3 / dt); frame++) {
      if (frame > 0) h.rig.reset();
      h.body.update(dt);
    }
    for (const [index, side] of (['L', 'R'] as const).entries()) {
      const driver = h.rig.armDriver(side);
      const context = h.rig.armForwardContext(side);
      const handBone = h.profile.bones[`hand.${side}`];
      const palmLocal = h.rig.palmLocal[side];
      if (!(driver && context && handBone && palmLocal)) throw new Error('missing arm geometry');
      // Construct the standing target from the public pose and current body
      // frame, independently of the driver's followed request or accepted FK.
      const world = (direction: THREE.Vector3) => worldDirection(h.rig, side, direction);
      const direction = (slot: 'upperArm' | 'lowerArm' | 'hand') => {
        const override = h.profile.avatar.armRest?.[slot];
        return world(override ? new THREE.Vector3(...override).normalize() : BASE_POSE[slot]);
      };
      const upper = direction('upperArm');
      const lower = direction('lowerArm');
      const hand = direction('hand');
      const palm = world(BASE_PALM);
      palm.addScaledVector(hand, -palm.dot(hand)).normalize();
      const elbow = context.shoulder.clone().addScaledVector(upper, context.upperLength);
      const wrist = elbow.clone().addScaledVector(lower, context.lowerLength);
      const goal = { ...driver.acceptedConfiguration };
      expect(
        configurationOfDirections(
          { upperArm: upper, lowerArm: lower, hand },
          palm,
          driver.calibration,
          context,
          null,
          goal,
        ),
      ).toBe(true);
      const goalQ = new Float64Array([
        goal.shoulderPlane,
        goal.shoulderLift * Math.PI,
        goal.humeralRotation,
        goal.elbowFlex,
        goal.forearmRoll,
        goal.wristFlex,
        goal.wristDev,
      ]);
      driver.captureVolumeFrame();
      expect(
        driver.solver.restoreEndpoint(
          { wrist, hand, palm, elbow, curls: driver.acceptedCurls, spread: driver.acceptedSpread },
          goalQ,
          context,
          { lower: goalQ, upper: goalQ },
          driver.environment,
          driver.bridgeOutput,
        ),
      ).toBe(true);
      handBone.updateWorldMatrix(true, false);
      const actualWrist = handBone.getWorldPosition(new THREE.Vector3());
      const actualRotation = handBone.getWorldQuaternion(new THREE.Quaternion());
      const actualHand = h.profile.restDir[`hand.${side}`].clone().applyQuaternion(actualRotation);
      const actualPalm = palmLocal.clone().applyQuaternion(actualRotation);
      const handLength = h.profile.limb?.[`tip.${side}.middle`];
      if (!(handLength && handLength > 0)) throw new Error('missing hand length');
      const dw = actualWrist.sub(wrist);
      const dh = dw.clone().addScaledVector(actualHand.sub(hand), handLength);
      const dp = dw.clone().addScaledVector(actualPalm.sub(palm), handLength);
      const residual = Math.sqrt(dw.lengthSq() + dh.lengthSq() + dp.lengthSq());
      const tolerance =
        (context.upperLength + context.lowerLength + handLength) *
        Math.sqrt(1e-12 + Number.EPSILON ** (2 / 3));
      expect(
        initialWrists[index].distanceTo(wrist),
        `${side} away stance wrist should be over 10 cm from standing; got ${initialWrists[index].distanceTo(wrist)}`,
      ).toBeGreaterThan(0.1);
      expect(residual).toBeLessThanOrEqual(tolerance);
    }
  });

  it('builds once, commits both accepted hand snapshots, and bypasses legacy post-aim repair', () => {
    const h = harness();
    let builds = 0;
    const def: GestureDef = {
      label: { en: 'Paired pose', ja: '両腕ポーズ' },
      group: 'pose',
      lead: 0.1,
      hold: 1,
      sustain: true,
      build: () => {
        builds++;
        return {
          arms: {
            L: {
              upperArm: V(-0.3, -0.85, 0.4),
              lowerArm: V(-0.2, -0.3, 0.93),
              hand: V(-0.15, -0.2, 0.97),
            },
            R: {
              upperArm: V(0.3, -0.85, 0.4),
              lowerArm: V(0.2, -0.3, 0.93),
              hand: V(0.15, -0.2, 0.97),
            },
          },
        };
      },
    };
    h.body.playDef(def, 'paired-pose');
    builds = 0;

    const legacyAim = vi.spyOn(h.rig, 'aimArm');
    const legacyCurl = vi.spyOn(h.rig, 'curlHand');
    h.rig.reset();
    h.body.update(DT);

    expect(builds).toBe(1);
    expect(legacyAim).not.toHaveBeenCalled();
    expect(legacyCurl).not.toHaveBeenCalled();
    for (const side of ['L', 'R'] as const) {
      const pose = h.rig.lastAcceptedHandPose(side);
      expect(pose).not.toBeNull();
      expect(pose?.palm.length()).toBeCloseTo(1, 6);
      expect(pose?.forearm.length()).toBeCloseTo(1, 6);
      const middle = h.profile.fingerBones[`middle.${side}`]?.[0];
      const index = h.profile.fingerBones[`index.${side}`]?.[0];
      const little = h.profile.fingerBones[`little.${side}`]?.[0];
      expect(middle && pose).toBeTruthy();
      expect(index && pose?.index).toBeTruthy();
      expect(little && pose?.little).toBeTruthy();
      if (!(middle && index && little && pose?.index && pose.little && pose)) continue;
      expect(middle.getWorldPosition(new THREE.Vector3()).distanceTo(pose.knuckle)).toBeCloseTo(
        0,
        8,
      );
      expect(index.getWorldPosition(new THREE.Vector3()).distanceTo(pose.index)).toBeCloseTo(0, 8);
      expect(little.getWorldPosition(new THREE.Vector3()).distanceTo(pose.little)).toBeCloseTo(
        0,
        8,
      );
    }
  });

  it('re-enables from the closed fist Body rendered with arm limits disabled', () => {
    const h = harness();
    const fingers: Record<FingerName, number> = {
      thumb: 0.7,
      index: 0.92,
      middle: 0.94,
      ring: 0.95,
      little: 0.96,
    };
    h.rig.limitsEnabled = false;
    const revisionBeforeBody = h.rig.externalArmRevision;
    const whisper = CUTE.whisper;
    const def: GestureDef = {
      ...whisper,
      hold: 5,
      sustain: true,
      build: (t, v) => ({
        ...whisper.build(t, v),
        fingers: { R: fingers },
      }),
    };
    h.body.playDef(def, 'closed-fist', 'R');
    for (let frame = 0; frame < 60; frame++) {
      h.rig.reset();
      h.body.update(DT);
    }
    expect(h.rig.externalArmRevision).toBe(revisionBeforeBody);

    const fingerBones = (['thumb', 'index', 'middle', 'ring', 'little'] as const).flatMap(
      (finger) => h.profile.fingerBones[`${finger}.R`] ?? [],
    );
    const beforeFingerQs = fingerBones.map((bone) => bone.quaternion.toArray());
    expect(
      Math.min(...Object.values(fingers)),
      'the fixture should still be visibly closed before re-enabling limits',
    ).toBeGreaterThan(0.5);

    h.rig.limitsEnabled = true;

    expect(h.rig.limitsEnabled).toBe(true);
    expect(fingerBones.map((bone) => bone.quaternion.toArray())).toEqual(beforeFingerQs);
    const driver = h.rig.armDriver('R');
    expect(driver).not.toBeNull();
    if (!driver) return;
    expect(driver.acceptedCurls).toEqual(h.rig.acceptedArmState('R').curls);
    expect(driver.acceptedSpread).toEqual(h.rig.acceptedArmState('R').spread);
    expect(
      (['thumb', 'index', 'middle', 'ring', 'little'] as const).some(
        (finger) => Math.abs(driver.acceptedCurls[finger] - fingers[finger]) > 1e-4,
      ),
      'clearFingers should adjust the closed fist before the constrained re-seed',
    ).toBe(true);
    for (const finger of ['thumb', 'index', 'middle', 'ring', 'little'] as const) {
      expect(driver.acceptedCurls[finger]).toBeGreaterThan(0.5);
      const chain = h.profile.fingerBones[`${finger}.R`];
      if (!chain) continue;
      const joints = finger === 'thumb' ? h.rig.joints.thumb : h.rig.joints.finger;
      for (let i = 0; i < chain.length; i++) {
        const rest = h.rig.rest.get(chain[i]);
        const axis = h.rig.fingerAxis.get(chain[i]);
        expect(rest && axis).toBeTruthy();
        if (!(rest && axis)) continue;
        // The bone carries the accepted spread as well as the accepted curl: the
        // finger-life lag fans a knuckle a few milliradians, which is second
        // order in the composed angle but not in the rotation itself.
        const turned = finger === 'thumb' && i === 2;
        const expectedFor = (turn: number) =>
          composeFingerRotation(
            new THREE.Quaternion(),
            rest,
            axis,
            fingerCurl(joints, i, driver.acceptedCurls[finger]),
            i === 0 ? h.rig.fingerSplayAxis.get(chain[i]) : undefined,
            i === 0 ? driver.acceptedSpread[finger] : 0,
            turned ? h.profile.restDir['thumb.R.2'] : undefined,
            turn,
            new THREE.Quaternion(),
          );
        // Component distance, as for the arm below: `angleTo` floors at several e-8.
        const q = chain[i].quaternion;
        const distance = (expected: THREE.Quaternion) => {
          const sign = q.dot(expected) < 0 ? -1 : 1;
          return Math.max(
            Math.abs(q.x - sign * expected.x),
            Math.abs(q.y - sign * expected.y),
            Math.abs(q.z - sign * expected.z),
            Math.abs(q.w - sign * expected.w),
          );
        };
        // The turn's direction is settled per hand at construction; either is a valid pose here.
        const turn = turned ? thumbOpposition(driver.acceptedCurls.thumb) : 0;
        expect(Math.min(distance(expectedFor(turn)), distance(expectedFor(-turn)))).toBeLessThan(
          1e-10,
        );
      }
    }
    const handBone = h.profile.bones['hand.R'];
    const forearmBone = h.profile.bones['lowerArm.R'];
    const upperBone = h.profile.bones['upperArm.R'];
    expect(handBone && forearmBone && upperBone).toBeTruthy();
    if (!(handBone && forearmBone && upperBone)) return;
    let maxAcceptedQuaternionDelta = 0;
    for (const [bone, accepted] of [
      [upperBone, driver.acceptedForward.upperWorld],
      [forearmBone, driver.acceptedForward.lowerWorld],
      [handBone, driver.acceptedForward.handWorld],
    ] as const) {
      bone.updateWorldMatrix(true, false);
      const actual = bone.getWorldQuaternion(new THREE.Quaternion());
      const sign = actual.dot(accepted) < 0 ? -1 : 1;
      maxAcceptedQuaternionDelta = Math.max(
        maxAcceptedQuaternionDelta,
        Math.abs(actual.x - sign * accepted.x),
        Math.abs(actual.y - sign * accepted.y),
        Math.abs(actual.z - sign * accepted.z),
        Math.abs(actual.w - sign * accepted.w),
      );
    }
    // Component distance avoids acos's several-e-8 radian floor near identical rotations.
    expect(maxAcceptedQuaternionDelta).toBeLessThan(1e-10);
  });

  it('does not bootstrap a second Body over a used Rig at revision zero', () => {
    const h = harness();
    const hand = h.profile.bones['hand.R'];
    if (!hand) throw new Error('missing right hand');
    hand.updateWorldMatrix(true, false);
    const standingWrist = hand.getWorldPosition(new THREE.Vector3());
    h.body.playDef(CUTE.whisper, 'first-body-gesture', 'R');
    for (let frame = 0; frame < 30; frame++) {
      h.rig.reset();
      h.body.update(DT);
    }
    expect(h.rig.externalArmRevision).toBe(0);

    hand.updateWorldMatrix(true, false);
    const wristBefore = hand.getWorldPosition(new THREE.Vector3());
    expect(wristBefore.distanceTo(standingWrist)).toBeGreaterThan(0.02);
    const armBefore = (['L', 'R'] as const).flatMap((side) =>
      (['shoulder', 'upperArm', 'lowerArm', 'hand'] as const).map((slot) => {
        const bone = h.profile.bones[`${slot}.${side}`];
        return bone?.quaternion.toArray() ?? null;
      }),
    );

    new Body(h.rig, h.profile);

    expect(h.rig.externalArmRevision).toBe(0);
    expect(
      (['L', 'R'] as const).flatMap((side) =>
        (['shoulder', 'upperArm', 'lowerArm', 'hand'] as const).map((slot) => {
          const bone = h.profile.bones[`${slot}.${side}`];
          return bone?.quaternion.toArray() ?? null;
        }),
      ),
    ).toEqual(armBefore);
    hand.updateWorldMatrix(true, false);
    expect(hand.getWorldPosition(new THREE.Vector3()).distanceTo(wristBefore)).toBe(0);
  });

  it('uses the legacy pair through live rescale, then reseeds once when the captured metric returns', () => {
    const h = harness();
    const drivers = (['L', 'R'] as const).map((side) => {
      const driver = h.rig.armDriver(side);
      if (!driver) throw new Error(`missing ${side} arm driver`);
      return driver;
    });
    const initialRevision = h.rig.externalArmRevision;
    const initialDriverQs = drivers.map((driver) => Array.from(driver.acceptedQ));
    const initialAccepted = (['L', 'R'] as const).map((side) => ({
      directions: structuredClone(h.rig.acceptedArmState(side).directions),
      palm: [...h.rig.acceptedArmState(side).palm],
      curls: { ...h.rig.acceptedArmState(side).curls },
      spread: { ...h.rig.acceptedArmState(side).spread },
    }));
    const legacyAim = vi.spyOn(h.rig, 'aimArmLegacy');
    const rootScale = h.profile.root.scale.clone();

    h.profile.root.position.set(0.13, -0.04, 0.07);
    h.profile.root.rotation.y = 0.37;
    expect(h.rig.beginBodyArmFrame()).toBe(true);

    h.profile.root.scale.copy(rootScale).multiplyScalar(1.2);
    expect(h.rig.beginBodyArmFrame()).toBe(false);
    h.rig.limitsEnabled = false;
    expect(() => {
      h.rig.limitsEnabled = true;
    }).not.toThrow();
    expect(h.rig.limitsEnabled).toBe(true);
    expect(drivers.map((driver) => Array.from(driver.acceptedQ))).toEqual(initialDriverQs);
    expect(
      (['L', 'R'] as const).map((side) => ({
        directions: structuredClone(h.rig.acceptedArmState(side).directions),
        palm: [...h.rig.acceptedArmState(side).palm],
        curls: { ...h.rig.acceptedArmState(side).curls },
        spread: { ...h.rig.acceptedArmState(side).spread },
      })),
    ).toEqual(initialAccepted);
    expect(h.rig.externalArmRevision).toBe(initialRevision);

    h.rig.reset();
    h.body.update(DT);
    expect(legacyAim).toHaveBeenCalledTimes(2);
    expect(h.rig.externalArmRevision).toBe(initialRevision);

    h.profile.root.scale.copy(rootScale);
    expect(h.rig.beginBodyArmFrame()).toBe(false);
    h.rig.reset();
    h.body.update(DT);
    expect(legacyAim).toHaveBeenCalledTimes(4);
    expect(h.rig.externalArmRevision).toBe(initialRevision + 1);

    for (const side of ['L', 'R'] as const) {
      const driver = h.rig.armDriver(side);
      if (!driver) throw new Error(`missing ${side} arm driver after re-entry`);
      for (const [slot, expected] of [
        ['upperArm', driver.acceptedForward.upperWorld],
        ['lowerArm', driver.acceptedForward.lowerWorld],
        ['hand', driver.acceptedForward.handWorld],
      ] as const) {
        const bone = h.profile.bones[`${slot}.${side}`];
        expect(bone).toBeTruthy();
        if (!bone) continue;
        bone.updateWorldMatrix(true, false);
        expect(
          quaternionComponentDelta(bone.getWorldQuaternion(new THREE.Quaternion()), expected),
        ).toBeLessThan(1e-10);
      }
    }

    h.rig.reset();
    h.body.update(DT);
    expect(legacyAim).toHaveBeenCalledTimes(4);
    expect(h.rig.externalArmRevision).toBe(initialRevision + 1);
  });

  it.each([1 / 60, 1 / 20])('converges to a feasible diagonal held FK goal at dt=%s', (dt) => {
    const h = harness();
    h.rig.reset();
    h.body.update(DT);

    const side = 'R' as const;
    const driver = h.rig.armDriver(side);
    const context = h.rig.armForwardContext(side);
    expect(driver && context).toBeTruthy();
    if (!(driver && context)) return;

    const goal: ArmConfiguration = {
      ...driver.acceptedConfiguration,
      shoulderPlane: driver.acceptedConfiguration.shoulderPlane + 0.12,
      shoulderLift: Math.min(0.8, driver.acceptedConfiguration.shoulderLift + 0.12),
      wristFlex: driver.acceptedConfiguration.wristFlex + 0.08,
      wristDev: driver.acceptedConfiguration.wristDev - 0.08,
    };
    const goalQ = new Float64Array([
      goal.shoulderPlane,
      goal.shoulderLift * Math.PI,
      goal.humeralRotation,
      goal.elbowFlex,
      goal.forearmRoll,
      goal.wristFlex,
      goal.wristDev,
    ]);
    const target = forwardArm(goal, driver.calibration, context, driver.targetForward);
    const upper = canonical(target.u, h, side);
    const lower = canonical(target.l, h, side);
    const hand = canonical(target.h, h, side);
    const palm = canonical(target.palm, h, side);
    const curls = { ...driver.acceptedCurls };
    const spread = { ...driver.acceptedSpread };

    driver.captureVolumeFrame();
    driver.composeRequest(
      context,
      target.u,
      target.l,
      target.h,
      target.palm,
      1,
      0,
      curls,
      spread,
      false,
    );
    const staticGoal = driver.planFrom(goalQ, context, 0, false);
    expect(staticGoal.status).toBe('settled');
    expect(staticGoal.maxViolation).toBe(0);

    const startWrist = h.profile.bones[`hand.${side}`]?.getWorldPosition(new THREE.Vector3());
    expect(startWrist).toBeTruthy();
    if (!startWrist) return;

    const def: GestureDef = {
      label: { en: 'Known FK goal', ja: '既知のFK目標' },
      group: 'pose',
      lead: 0.1,
      hold: 1,
      sustain: true,
      build: () => ({
        arms: {
          [side]: {
            upperArm: upper.clone(),
            lowerArm: lower.clone(),
            hand: hand.clone(),
            palm: palm.clone(),
          },
        },
        fingers: { [side]: curls },
        fingerSpread: { [side]: spread },
      }),
    };
    h.body.playDef(def, 'known-fk-goal');
    for (let frame = 0; frame < Math.ceil(3.0 / dt); frame++) {
      h.rig.reset();
      h.body.update(dt);
    }

    const handBone = h.profile.bones[`hand.${side}`];
    expect(handBone).toBeTruthy();
    if (!handBone) return;
    handBone.updateWorldMatrix(true, false);
    const actualWrist = handBone.getWorldPosition(new THREE.Vector3());
    const handWorld = handBone.getWorldQuaternion(new THREE.Quaternion());
    const actualHand = h.profile.restDir[`hand.${side}`]
      .clone()
      .applyQuaternion(handWorld)
      .normalize();
    const palmLocal = h.rig.palmLocal[side];
    expect(palmLocal).toBeTruthy();
    if (!palmLocal) return;
    const actualPalm = palmLocal.clone().applyQuaternion(handWorld).normalize();
    const finalContext = h.rig.armForwardContext(side);
    expect(finalContext).not.toBeNull();
    if (!finalContext) return;

    const worldFromCharacter = (direction: THREE.Vector3): THREE.Vector3 => {
      const lateral = side === 'R' ? direction.x : -direction.x;
      return finalContext.right
        .clone()
        .multiplyScalar(lateral)
        .addScaledVector(finalContext.up, direction.y)
        .addScaledVector(finalContext.forward, direction.z)
        .normalize();
    };
    const finalUpper = worldFromCharacter(upper);
    const finalLower = worldFromCharacter(lower);
    const desiredHand = worldFromCharacter(hand);
    const desiredPalm = worldFromCharacter(palm);
    const expectedElbow = finalContext.shoulder
      .clone()
      .addScaledVector(finalUpper, finalContext.upperLength);
    const expectedWrist = expectedElbow
      .clone()
      .addScaledVector(finalLower, finalContext.lowerLength);

    const finalGoalConfiguration: ArmConfiguration = { ...goal };
    const inverseValid = configurationOfDirections(
      { upperArm: finalUpper, lowerArm: finalLower, hand: desiredHand },
      desiredPalm,
      driver.calibration,
      finalContext,
      goal,
      finalGoalConfiguration,
    );
    const finalGoalQ = new Float64Array([
      finalGoalConfiguration.shoulderPlane,
      finalGoalConfiguration.shoulderLift * Math.PI,
      finalGoalConfiguration.humeralRotation,
      finalGoalConfiguration.elbowFlex,
      finalGoalConfiguration.forearmRoll,
      finalGoalConfiguration.wristFlex,
      finalGoalConfiguration.wristDev,
    ]);
    const targetRequest = {
      wrist: expectedWrist,
      hand: desiredHand,
      palm: desiredPalm,
      curls,
      spread,
      elbow: expectedElbow,
    };
    driver.captureVolumeFrame();
    const goalFeasible =
      inverseValid &&
      driver.solver.restoreEndpoint(
        targetRequest,
        finalGoalQ,
        finalContext,
        { lower: finalGoalQ, upper: finalGoalQ },
        driver.environment,
        driver.output,
      );
    const acceptedFeasible = driver.solver.restoreEndpoint(
      targetRequest,
      driver.acceptedQ,
      finalContext,
      { lower: driver.acceptedQ, upper: driver.acceptedQ },
      driver.environment,
      driver.bridgeOutput,
    );

    const handLength = h.profile.limb?.[`tip.${side}.middle`];
    expect(handLength).toBeGreaterThan(0);
    if (!(handLength && handLength > 0)) return;
    const deltaWrist = actualWrist.clone().sub(expectedWrist);
    const deltaHand = actualHand.clone().sub(desiredHand);
    const deltaPalm = actualPalm.clone().sub(desiredPalm);
    const wristHand = deltaWrist.clone().addScaledVector(deltaHand, handLength);
    const wristPalm = deltaWrist.clone().addScaledVector(deltaPalm, handLength);
    const residual = Math.sqrt(deltaWrist.lengthSq() + wristHand.lengthSq() + wristPalm.lengthSq());
    const span = finalContext.upperLength + finalContext.lowerLength + handLength;
    const residualTolerance = span * Math.sqrt(1e-12 + Number.EPSILON ** (2 / 3));
    const orientationTolerance = Math.max(
      1e-5,
      2 * Math.asin(Math.min(1, residualTolerance / (Math.sqrt(2) * handLength))),
    );

    expect(inverseValid).toBe(true);
    expect(goalFeasible).toBe(true);
    expect(driver.output.maxViolation).toBeLessThanOrEqual(2e-10);
    expect(driver.output.positionError).toBeLessThan(1e-6);
    expect(acceptedFeasible).toBe(true);
    expect(driver.bridgeOutput.maxViolation).toBeLessThanOrEqual(2e-10);
    expect(startWrist.distanceTo(expectedWrist)).toBeGreaterThan(0.01);
    expect(deltaWrist.length()).toBeLessThanOrEqual(residualTolerance);
    expect(residual).toBeLessThanOrEqual(residualTolerance);
    expect(actualHand.angleTo(desiredHand)).toBeLessThanOrEqual(orientationTolerance);
    expect(actualPalm.angleTo(desiredPalm)).toBeLessThanOrEqual(orientationTolerance);
  });
});
