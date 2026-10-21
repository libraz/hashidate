import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { forwardArm, makeArmForwardResult } from '@/engine/rig/arm-configuration';
import type { ArmDriver } from '@/engine/rig/arm-driver';
import { buildRig } from '../helpers/scene';

function rigged(): { rig: Rig; arm: ArmDriver } {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const arm = rig.armDriver('R');
  if (!arm) throw new Error('synthetic rig has no constrained right arm');
  return { rig, arm };
}

describe('arm driver request composition', () => {
  it('reads the arm channels as directions, whatever their length', () => {
    const { rig, arm } = rigged();
    rig.anat.update();
    const context = rig.armForwardContext('R');
    if (!context) throw new Error('synthetic rig has no right arm context');
    const pose = forwardArm(
      { ...arm.acceptedConfiguration, elbowFlex: 0.9, wristFlex: 0.3 },
      arm.calibration,
      context,
      makeArmForwardResult(),
    );
    const request = arm.composeRequest(
      context,
      pose.u,
      pose.l,
      pose.h,
      pose.palm,
      1,
      0,
      {},
      {},
      false,
    );
    const unit = {
      wrist: request.wrist.clone(),
      elbow: request.elbow?.clone() ?? new THREE.Vector3(Number.NaN),
      hand: request.hand.clone(),
      palm: request.palm?.clone() ?? null,
    };
    const scaled = arm.composeRequest(
      context,
      pose.u.clone().multiplyScalar(1.7),
      pose.l.clone().multiplyScalar(0.6),
      pose.h.clone().multiplyScalar(2.3),
      pose.palm,
      1,
      0,
      {},
      {},
      false,
    );
    expect(scaled.wrist.distanceTo(unit.wrist)).toBeLessThan(1e-12);
    expect(scaled.elbow?.distanceTo(unit.elbow)).toBeLessThan(1e-12);
    expect(scaled.hand.distanceTo(unit.hand)).toBeLessThan(1e-12);
    expect(unit.palm).not.toBeNull();
    expect(scaled.palm?.distanceTo(unit.palm ?? new THREE.Vector3())).toBeLessThan(1e-9);
  });
});
