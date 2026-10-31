import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Body } from '@/engine/motion/body';
import { BASE_PALM, BASE_POSE } from '@/engine/motion/gestures/base';
import { CUTE } from '@/engine/motion/gestures/cute';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { ArmSlot, FingerName, GestureDef, Profile, Side } from '@/engine/types';
import { buildRig } from '../../helpers/scene';
import { DT, harness } from './harness';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

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

      expect(actualUpper.angleTo(upper)).toBeLessThan(1e-7);
      expect(actualLower.angleTo(lower)).toBeLessThan(1e-7);
      expect(actualHand.angleTo(hand)).toBeLessThan(1e-7);
      expect(actualPalm.angleTo(palm)).toBeLessThan(1e-7);
      expect(
        initialWrists[index].distanceTo(handBone.getWorldPosition(new THREE.Vector3())),
      ).toBeGreaterThan(0.1);
    }
    expect(rig.externalArmRevision).toBe(initialRevision);
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
    expect(h.rig.armDriver('R')).not.toBeNull();
    const accepted = h.rig.acceptedArmState('R');
    expect(
      (['thumb', 'index', 'middle', 'ring', 'little'] as const).some(
        (finger) => Math.abs(accepted.curls[finger] - fingers[finger]) > 1e-4,
      ),
      'clearFingers should adjust the closed fist before the constrained re-seed',
    ).toBe(true);
    for (const finger of ['thumb', 'index', 'middle', 'ring', 'little'] as const) {
      expect(accepted.curls[finger]).toBeGreaterThan(0.5);
    }
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

    h.rig.reset();
    h.body.update(DT);
    expect(legacyAim).toHaveBeenCalledTimes(4);
    expect(h.rig.externalArmRevision).toBe(initialRevision + 1);
  });
});
