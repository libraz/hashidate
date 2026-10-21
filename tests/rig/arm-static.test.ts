import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Body } from '@/engine/motion/body';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { ArmSlot, FingerName, Profile } from '@/engine/types';
import { buildRig } from '../helpers/scene';

function makeRig(): { profile: Profile; rig: Rig } {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  return { profile, rig: new Rig(profile) };
}

function armQuaternions(profile: Profile): number[][] {
  return (['L', 'R'] as const).flatMap((side) =>
    (['shoulder', 'upperArm', 'lowerArm', 'hand'] as const).flatMap((slot) => {
      const bone = profile.bones[`${slot}.${side}`];
      return bone ? [bone.quaternion.toArray()] : [];
    }),
  );
}

function fingerQuaternions(profile: Profile): number[][] {
  return (['L', 'R'] as const).flatMap((side) =>
    (['thumb', 'index', 'middle', 'ring', 'little'] as const).flatMap(
      (finger) =>
        profile.fingerBones[`${finger}.${side}`]?.map((bone) => bone.quaternion.toArray()) ?? [],
    ),
  );
}

const dirs = (upperArm: [number, number, number]): Record<ArmSlot, [number, number, number]> => ({
  shoulder: [0.34, -0.83, 0.44],
  upperArm,
  lowerArm: [0.08, -0.36, 0.93],
  hand: [0.1, -0.2, 0.97],
});

describe('static constrained arm operations', () => {
  it('restores the actual clavicle and accepted driver state when an aim request is invalid', () => {
    const { profile, rig } = makeRig();
    const driver = rig.armDriver('R');
    expect(driver).not.toBeNull();
    if (!driver) return;
    const beforeBones = armQuaternions(profile);
    const beforeQ = Array.from(driver.acceptedQ);
    const beforeConfiguration = { ...driver.acceptedConfiguration };
    const beforeRoll = driver.requestRollHistory;
    const beforeRevision = rig.externalArmRevision;

    expect(rig.aimArm('R', dirs([Number.NaN, 0.2, 0.9]))).toBe(false);

    expect(armQuaternions(profile)).toEqual(beforeBones);
    expect(Array.from(driver.acceptedQ)).toEqual(beforeQ);
    expect(driver.acceptedConfiguration).toEqual(beforeConfiguration);
    expect(driver.requestRollHistory).toBe(beforeRoll);
    expect(rig.externalArmRevision).toBe(beforeRevision);
  });

  it('does not partially re-enable when the second arm cannot be seeded', () => {
    const { profile, rig } = makeRig();
    const drivers = (['L', 'R'] as const).map((side) => {
      const driver = rig.armDriver(side);
      if (!driver) throw new Error(`missing ${side} arm driver`);
      return driver;
    });

    rig.limitsEnabled = false;
    rig.aimArm('L', dirs([-0.42, -0.79, 0.44]));
    const beforeBones = armQuaternions(profile);
    const beforeQs = drivers.map((driver) => Array.from(driver.acceptedQ));
    const beforeRevision = rig.externalArmRevision;
    const beforeStates = (['L', 'R'] as const).map((side) => ({
      directions: structuredClone(rig.acceptedArmState(side).directions),
      palm: [...rig.acceptedArmState(side).palm],
      curls: { ...rig.acceptedArmState(side).curls },
      spread: { ...rig.acceptedArmState(side).spread },
    }));

    // The left arm preflights first and mutates its driver's temporary seed.
    // The right context then fails, exercising rollback after partial staging.
    if (!profile.limb) throw new Error('synthetic rig has no limb measurements');
    profile.limb['upper.R'] = 0;
    expect(() => {
      rig.limitsEnabled = true;
    }).toThrow('Could not restore a feasible arm pose; anatomical limits remain disabled.');

    expect(rig.limitsEnabled).toBe(false);
    expect(armQuaternions(profile)).toEqual(beforeBones);
    expect(drivers.map((driver) => Array.from(driver.acceptedQ))).toEqual(beforeQs);
    expect(rig.externalArmRevision).toBe(beforeRevision);
    expect(
      (['L', 'R'] as const).map((side) => ({
        directions: structuredClone(rig.acceptedArmState(side).directions),
        palm: [...rig.acceptedArmState(side).palm],
        curls: { ...rig.acceptedArmState(side).curls },
        spread: { ...rig.acceptedArmState(side).spread },
      })),
    ).toEqual(beforeStates);
  });

  it('re-enables from the displayed pose and publishes one revision on success', () => {
    const { profile, rig } = makeRig();
    const driver = rig.armDriver('R');
    expect(driver).not.toBeNull();
    if (!driver) return;

    rig.limitsEnabled = false;
    rig.aimArm('R', dirs([0.38, -0.79, 0.48]));
    const revisionBeforeReenable = rig.externalArmRevision;
    const displayedHand = profile.bones['hand.R'];
    expect(displayedHand).toBeTruthy();
    if (!displayedHand) return;

    rig.limitsEnabled = true;

    expect(rig.limitsEnabled).toBe(true);
    expect(rig.externalArmRevision).toBe(revisionBeforeReenable + 1);
    expect(driver.acceptedQ.every(Number.isFinite)).toBe(true);
    displayedHand.updateWorldMatrix(true, false);
    const actualWorld = displayedHand.getWorldQuaternion(new THREE.Quaternion());
    expect(actualWorld.angleTo(driver.acceptedForward.handWorld)).toBeLessThan(1e-8);
    expect(driver.output.maxViolation).toBeLessThanOrEqual(2e-10);
  });

  it('refreshes a translated, rotated ancestor and rejects an equal-length shear', () => {
    const { profile, rig } = makeRig();
    const driver = rig.armDriver('R');
    expect(driver).not.toBeNull();
    if (!driver) return;
    const beforeQ = Array.from(driver.acceptedQ);
    const beforeRevision = rig.externalArmRevision;

    const ancestor = new THREE.Group();
    ancestor.position.set(0.2, -0.1, 0.07);
    ancestor.rotation.y = 0.41;
    ancestor.add(profile.root);
    // Leave matrixWorld stale: the support check must refresh the external chain.
    expect(rig.beginBodyArmFrame()).toBe(true);

    // The first two columns both have unit length, but their dot product is 0.1.
    // A scale-only check would accept this shear and the calibrated FK would not.
    ancestor.matrixAutoUpdate = false;
    ancestor.matrix.set(0.9949874371, 0, 0, 0, 0.1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    ancestor.matrixWorldNeedsUpdate = true;
    expect(rig.beginBodyArmFrame()).toBe(false);

    rig.limitsEnabled = false;
    expect(() => {
      rig.limitsEnabled = true;
    }).not.toThrow();
    expect(rig.limitsEnabled).toBe(true);
    expect(Array.from(driver.acceptedQ)).toEqual(beforeQ);
    expect(rig.externalArmRevision).toBe(beforeRevision);

    const legacyAim = vi.spyOn(rig, 'aimArmLegacy');
    rig.aimArm('R', dirs([0.38, -0.79, 0.48]));
    expect(legacyAim).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['nonuniform scale', (root: THREE.Object3D) => root.scale.set(1, 1.1, 1)],
    ['reflection', (root: THREE.Object3D) => root.scale.set(-1, 1, 1)],
  ])('uses the legacy frame for %s', (_name, transform) => {
    const { profile, rig } = makeRig();
    transform(profile.root);
    expect(rig.beginBodyArmFrame()).toBe(false);
    expect(rig.limitsEnabled).toBe(true);
  });

  it('does not replace an official static pose or hand shape when Body is constructed', () => {
    const { profile, rig } = makeRig();
    const curls: Record<FingerName, number> = {
      thumb: 0.2,
      index: 0.3,
      middle: 0.4,
      ring: 0.5,
      little: 0.6,
    };
    expect(rig.aimArm('R', dirs([0.38, -0.79, 0.48]))).toBe(true);
    expect(rig.curlHand('R', curls)).toBe(true);
    const revision = rig.externalArmRevision;
    const beforeArms = armQuaternions(profile);
    const beforeFingers = fingerQuaternions(profile);
    const accepted = (['L', 'R'] as const).map((side) => ({
      directions: structuredClone(rig.acceptedArmState(side).directions),
      palm: [...rig.acceptedArmState(side).palm],
      curls: { ...rig.acceptedArmState(side).curls },
      spread: { ...rig.acceptedArmState(side).spread },
    }));

    new Body(rig, profile);

    expect(rig.externalArmRevision).toBe(revision);
    expect(armQuaternions(profile)).toEqual(beforeArms);
    expect(fingerQuaternions(profile)).toEqual(beforeFingers);
    expect(
      (['L', 'R'] as const).map((side) => ({
        directions: structuredClone(rig.acceptedArmState(side).directions),
        palm: [...rig.acceptedArmState(side).palm],
        curls: { ...rig.acceptedArmState(side).curls },
        spread: { ...rig.acceptedArmState(side).spread },
      })),
    ).toEqual(accepted);
  });

  it('consumes the standing bootstrap claim and rolls back both shoulders after second-side preflight failure', () => {
    const { profile, rig } = makeRig();
    const beforeArms = armQuaternions(profile);
    const beforeFingers = fingerQuaternions(profile);
    const beforeQs = (['L', 'R'] as const).map((side) => {
      const driver = rig.armDriver(side);
      if (!driver) throw new Error(`missing ${side} arm driver`);
      return Array.from(driver.acceptedQ);
    });
    const beforeRevision = rig.externalArmRevision;
    if (!profile.limb) throw new Error('synthetic rig has no limb measurements');
    const rightLength = profile.limb['upper.R'];
    profile.limb['upper.R'] = 0;

    new Body(rig, profile);

    expect(armQuaternions(profile)).toEqual(beforeArms);
    expect(fingerQuaternions(profile)).toEqual(beforeFingers);
    expect(
      (['L', 'R'] as const).map((side) => {
        const driver = rig.armDriver(side);
        if (!driver) throw new Error(`missing ${side} arm driver`);
        return Array.from(driver.acceptedQ);
      }),
    ).toEqual(beforeQs);
    expect(rig.externalArmRevision).toBe(beforeRevision);

    profile.limb['upper.R'] = rightLength;
    new Body(rig, profile);

    expect(armQuaternions(profile)).toEqual(beforeArms);
    expect(fingerQuaternions(profile)).toEqual(beforeFingers);
    expect(rig.externalArmRevision).toBe(beforeRevision);
  });

  it.each([
    [
      'limits disabled',
      (rig: Rig, _profile: Profile) => {
        rig.limitsEnabled = false;
      },
    ],
    [
      'unsupported live scale',
      (_rig: Rig, profile: Profile) => {
        profile.root.scale.set(1.1, 1, 1);
      },
    ],
  ])('preserves the current pose when the first Body is constructed with %s', (_name, prepare) => {
    const { profile, rig } = makeRig();
    prepare(rig, profile);
    const beforeArms = armQuaternions(profile);
    const beforeFingers = fingerQuaternions(profile);
    const revision = rig.externalArmRevision;

    new Body(rig, profile);

    expect(armQuaternions(profile)).toEqual(beforeArms);
    expect(fingerQuaternions(profile)).toEqual(beforeFingers);
    expect(rig.externalArmRevision).toBe(revision);
  });
});
