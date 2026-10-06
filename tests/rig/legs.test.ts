import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { JOINTS } from '@/engine/anatomy';
import { buildProfile } from '@/engine/profile';
import { GroundedLegs } from '@/engine/rig/legs';
import type { BoneSlot, Profile, Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

const SIDES: readonly Side[] = ['L', 'R'];
const CORE: readonly BoneSlot[] = [
  'upperLeg.L',
  'lowerLeg.L',
  'foot.L',
  'upperLeg.R',
  'lowerLeg.R',
  'foot.R',
];
const CLOSE = 1e-8;

function bone(profile: Profile, slot: BoneSlot): THREE.Bone {
  const value = profile.bones[slot];
  if (!value) throw new Error(`synthetic rig has no ${slot}`);
  return value;
}

function restOf(profile: Profile): (value: THREE.Bone) => THREE.Quaternion {
  const rest = new Map(
    Object.values(profile.bones)
      .filter((value): value is THREE.Bone => value instanceof THREE.Bone)
      .map((value) => [value, value.quaternion.clone()]),
  );
  return (value) => rest.get(value)?.clone() ?? value.quaternion.clone();
}

function setup(options: { armatureScale?: number } = {}): {
  built: ReturnType<typeof buildRig>;
  profile: Profile;
  solver: GroundedLegs;
} {
  const built = buildRig({ legs: true, ...options });
  const profile = buildProfile(built.root, built.descriptor);
  const solver = GroundedLegs.create(profile, restOf(profile));
  if (!solver) throw new Error('synthetic standing legs were not accepted');
  return { built, profile, solver };
}

function worldPosition(profile: Profile, slot: BoneSlot): THREE.Vector3 {
  return bone(profile, slot).getWorldPosition(new THREE.Vector3());
}

function rootRelativeQuaternion(root: THREE.Object3D, value: THREE.Object3D): THREE.Quaternion {
  const matrix = root.matrixWorld.clone().invert().multiply(value.matrixWorld);
  const q = new THREE.Quaternion();
  matrix.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return q.normalize();
}

function kneeAngle(profile: Profile, side: Side): number {
  const hip = worldPosition(profile, `upperLeg.${side}`);
  const knee = worldPosition(profile, `lowerLeg.${side}`);
  const ankle = worldPosition(profile, `foot.${side}`);
  return Math.acos(
    THREE.MathUtils.clamp(
      knee.clone().sub(hip).normalize().dot(ankle.clone().sub(knee).normalize()),
      -1,
      1,
    ),
  );
}

describe('GroundedLegs', () => {
  it('opts out when legs are absent, partial, seated, degenerate, or custom-anatomy', () => {
    const noLegs = buildRig();
    expect(
      GroundedLegs.create(
        buildProfile(noLegs.root, noLegs.descriptor),
        () => new THREE.Quaternion(),
      ),
    ).toBeNull();

    const partial = buildRig({ legs: true });
    const partialFoot = partial.bones.get('Foot_R');
    if (partialFoot) partialFoot.name = 'MissingFoot_R';
    expect(
      GroundedLegs.create(
        buildProfile(partial.root, partial.descriptor),
        () => new THREE.Quaternion(),
      ),
    ).toBeNull();

    const seated = buildRig({ legs: true });
    for (const side of ['L', 'R'] as const) {
      // Knee forward, shin down: a seated leg keeps a downward ankle but its
      // hip-to-ankle span is too short for the standing classifier.
      seated.bones.get(`LowerLeg_${side}`)?.position.set(0, 0, 0.25);
      seated.bones.get(`Foot_${side}`)?.position.set(0, -0.24, 0);
    }
    seated.root.updateMatrixWorld(true);
    expect(
      GroundedLegs.create(
        buildProfile(seated.root, seated.descriptor),
        () => new THREE.Quaternion(),
      ),
    ).toBeNull();

    const degenerate = buildRig({ legs: true });
    degenerate.bones.get('LowerLeg_L')?.position.set(0, 0, 0);
    degenerate.root.updateMatrixWorld(true);
    expect(
      GroundedLegs.create(
        buildProfile(degenerate.root, degenerate.descriptor),
        () => new THREE.Quaternion(),
      ),
    ).toBeNull();

    const custom = buildRig({ legs: true });
    const customProfile = buildProfile(custom.root, { ...custom.descriptor, anatomy: JOINTS });
    expect(GroundedLegs.create(customProfile, () => new THREE.Quaternion())).toBeNull();

    const profileOverride = buildProfile(buildRig({ legs: true }).root);
    profileOverride.anatomy = JOINTS;
    expect(GroundedLegs.create(profileOverride, restOf(profileOverride))).toBeNull();

    const lying = buildRig({ legs: true });
    lying.root.rotation.z = Math.PI / 2;
    lying.root.updateMatrixWorld(true);
    const lyingProfile = buildProfile(lying.root, lying.descriptor);
    expect(GroundedLegs.create(lyingProfile, restOf(lyingProfile))).toBeNull();

    const anisotropic = buildRig({ legs: true });
    anisotropic.bones.get('LowerLeg_L')?.scale.set(1, 1.1, 1);
    anisotropic.root.updateMatrixWorld(true);
    const anisotropicProfile = buildProfile(anisotropic.root, anisotropic.descriptor);
    expect(GroundedLegs.create(anisotropicProfile, restOf(anisotropicProfile))).toBeNull();

    const floatRoundoff = buildRig({ legs: true });
    floatRoundoff.bones.get('LowerLeg_L')?.scale.set(1, 1 - 2 ** -24, 1 - 2 ** -24);
    floatRoundoff.root.updateMatrixWorld(true);
    const floatProfile = buildProfile(floatRoundoff.root, floatRoundoff.descriptor);
    const floatSolver = GroundedLegs.create(floatProfile, restOf(floatProfile));
    expect(floatSolver).not.toBeNull();
    const floatAnchor = worldPosition(floatProfile, 'foot.L');
    floatSolver?.apply(0);
    expect(worldPosition(floatProfile, 'foot.L').distanceTo(floatAnchor)).toBeLessThan(1e-7);

    const noToe = buildRig({ legs: true });
    for (const side of SIDES) {
      const toe = noToe.bones.get(`Toe_${side}`);
      if (toe) toe.name = `NoToe_${side}`;
    }
    const noToeProfile = buildProfile(noToe.root, noToe.descriptor);
    expect(GroundedLegs.create(noToeProfile, restOf(noToeProfile))).not.toBeNull();
  });

  it('opts out when a resolved core chain is not a direct supported topology', () => {
    const built = buildRig({ legs: true });
    const upper = built.bones.get('UpperLeg_L');
    const lower = built.bones.get('LowerLeg_L');
    if (!(upper && lower)) throw new Error('synthetic rig has no left leg');
    const helper = new THREE.Bone();
    helper.name = 'LegTwist';
    upper.add(helper);
    upper.remove(lower);
    helper.add(lower);
    built.root.updateMatrixWorld(true);
    const profile = buildProfile(built.root, built.descriptor);
    expect(GroundedLegs.create(profile, restOf(profile))).toBeNull();
  });

  it('keeps a quiet standing pose planted without accumulating drift', () => {
    const { built, profile, solver } = setup();
    const anchors = Object.fromEntries(
      SIDES.map((side) => [side, worldPosition(profile, `foot.${side}`)]),
    ) as Record<Side, THREE.Vector3>;
    const knees = Object.fromEntries(
      SIDES.map((side) => [side, worldPosition(profile, `lowerLeg.${side}`)]),
    ) as Record<Side, THREE.Vector3>;
    const transforms = new Map(
      CORE.map((slot) => {
        const value = bone(profile, slot);
        return [slot, { position: value.position.clone(), scale: value.scale.clone() }];
      }),
    );
    const toeRotations = Object.fromEntries(
      SIDES.map((side) => [side, bone(profile, `toe.${side}`).quaternion.clone()]),
    ) as Record<Side, THREE.Quaternion>;

    solver.apply(0);
    solver.apply(0);
    built.root.updateMatrixWorld(true);

    for (const side of SIDES) {
      expect(worldPosition(profile, `foot.${side}`).distanceTo(anchors[side])).toBeLessThan(CLOSE);
      expect(worldPosition(profile, `lowerLeg.${side}`).distanceTo(knees[side])).toBeLessThan(
        CLOSE,
      );
    }
    for (const slot of CORE) {
      const value = bone(profile, slot);
      const before = transforms.get(slot);
      if (!before) throw new Error(`missing snapshot for ${slot}`);
      expect(value.position.distanceTo(before.position)).toBe(0);
      expect(value.scale.distanceTo(before.scale)).toBe(0);
    }
    for (const side of SIDES) {
      expect(bone(profile, `toe.${side}`).quaternion.angleTo(toeRotations[side])).toBe(0);
    }
  });

  it('uses a stable anatomical pole for an exactly straight rest leg', () => {
    const built = buildRig({ legs: true });
    for (const side of SIDES) {
      const lower = built.bones.get(`LowerLeg_${side}`);
      const foot = built.bones.get(`Foot_${side}`);
      if (!(lower && foot)) throw new Error(`synthetic rig has no ${side} leg`);
      lower.position.set(0, -0.25, 0);
      foot.position.set(0, -0.24, 0);
    }
    const profile = buildProfile(built.root, built.descriptor);
    const solver = GroundedLegs.create(profile, restOf(profile));
    if (!solver) throw new Error('straight standing legs were not accepted');

    const root = built.root;
    root.position.set(0.17, -0.11, 0.29);
    root.rotation.y = 0.37;
    root.updateMatrixWorld(true);
    const anchors = Object.fromEntries(
      SIDES.map((side) => [side, worldPosition(profile, `foot.${side}`)]),
    ) as Record<Side, THREE.Vector3>;
    const hips = bone(profile, 'hips');
    hips.position.add(new THREE.Vector3(0.025, -0.04, 0.012));
    root.updateMatrixWorld(true);
    solver.apply(0);

    const chest = bone(profile, 'chest');
    const forward = (profile.body?.forward ?? new THREE.Vector3(0, 0, -1))
      .clone()
      .applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
    for (const side of SIDES) {
      const hip = worldPosition(profile, `upperLeg.${side}`);
      const knee = worldPosition(profile, `lowerLeg.${side}`);
      const ankle = worldPosition(profile, `foot.${side}`);
      expect(knee.clone().sub(hip).dot(forward)).toBeGreaterThan(1e-4);
      expect(ankle.distanceTo(anchors[side])).toBeLessThan(CLOSE);
    }

    const knees = Object.fromEntries(
      SIDES.map((side) => [side, worldPosition(profile, `lowerLeg.${side}`)]),
    ) as Record<Side, THREE.Vector3>;
    solver.apply(0);
    for (const side of SIDES) {
      expect(worldPosition(profile, `lowerLeg.${side}`).distanceTo(knees[side])).toBeLessThan(
        CLOSE,
      );
    }
  });

  it('bends a straight rest leg forward from the hips when the profile has no body frame', () => {
    const built = buildRig({ legs: true });
    for (const side of SIDES) {
      const lower = built.bones.get(`LowerLeg_${side}`);
      const foot = built.bones.get(`Foot_${side}`);
      if (!(lower && foot)) throw new Error(`synthetic rig has no ${side} leg`);
      lower.position.set(0, -0.25, 0);
      foot.position.set(0, -0.24, 0);
    }
    // Turned to face root +Z, so no fixed root axis can stand in for forward.
    const hipsBone = built.bones.get('Hips');
    if (!hipsBone) throw new Error('synthetic rig has no hips');
    hipsBone.rotation.y = Math.PI;
    built.root.updateMatrixWorld(true);
    const profile = buildProfile(built.root, built.descriptor);
    const chest = bone(profile, 'chest');
    const forward = (profile.body?.forward ?? new THREE.Vector3())
      .clone()
      .applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion()));
    expect(forward.z).toBeGreaterThan(0.99);
    profile.body = null;
    const solver = GroundedLegs.create(profile, restOf(profile));
    if (!solver) throw new Error('straight standing legs were not accepted');

    bone(profile, 'hips').position.y -= 0.04;
    built.root.updateMatrixWorld(true);
    solver.apply(0);

    for (const side of SIDES) {
      const hip = worldPosition(profile, `upperLeg.${side}`);
      const knee = worldPosition(profile, `lowerLeg.${side}`);
      expect(knee.sub(hip).dot(forward)).toBeGreaterThan(1e-4);
    }
  });

  it('keeps both ankles planted while a breath and weight shift bend the knees', () => {
    const { built, profile, solver } = setup();
    const anchors = Object.fromEntries(
      SIDES.map((side) => [side, worldPosition(profile, `foot.${side}`)]),
    ) as Record<Side, THREE.Vector3>;
    const restAngles = Object.fromEntries(
      SIDES.map((side) => [side, kneeAngle(profile, side)]),
    ) as Record<Side, number>;
    const hips = bone(profile, 'hips');
    hips.position.add(new THREE.Vector3(0.025, -0.045, 0.015));
    hips.rotation.z = 0.08;
    built.root.updateMatrixWorld(true);

    solver.apply(0);
    for (const side of SIDES) {
      expect(worldPosition(profile, `foot.${side}`).distanceTo(anchors[side])).toBeLessThan(CLOSE);
      expect(kneeAngle(profile, side)).toBeGreaterThan(restAngles[side] + 0.1);
    }
  });

  it('lifts both ankle targets by the current positive rise', () => {
    const { built, profile, solver } = setup();
    const anchors = Object.fromEntries(
      SIDES.map((side) => [side, worldPosition(profile, `foot.${side}`)]),
    ) as Record<Side, THREE.Vector3>;
    const lift = 0.05;
    bone(profile, 'hips').position.y += lift;
    built.root.updateMatrixWorld(true);

    solver.apply(lift);
    for (const side of SIDES) {
      const expected = anchors[side].clone().add(new THREE.Vector3(0, lift, 0));
      expect(worldPosition(profile, `foot.${side}`).distanceTo(expected)).toBeLessThan(CLOSE);
    }
  });

  it('follows root translation, rotation, and non-uniform scale in metric space', () => {
    const { built, profile, solver } = setup({ armatureScale: 0.01 });
    const root = built.root;
    const anchors = Object.fromEntries(
      SIDES.map((side) => [
        side,
        worldPosition(profile, `foot.${side}`).applyMatrix4(root.matrixWorld.clone().invert()),
      ]),
    ) as Record<Side, THREE.Vector3>;
    const footOrientation = Object.fromEntries(
      SIDES.map((side) => [side, rootRelativeQuaternion(root, bone(profile, `foot.${side}`))]),
    ) as Record<Side, THREE.Quaternion>;
    const transforms = new Map(
      CORE.map((slot) => {
        const value = bone(profile, slot);
        return [slot, { position: value.position.clone(), scale: value.scale.clone() }];
      }),
    );

    root.position.set(0.4, -0.2, 0.7);
    root.rotation.set(0.2, -0.3, 0.15);
    root.scale.set(0.013, 0.008, 0.011);
    root.updateMatrixWorld(true);
    solver.apply(0);

    for (const side of SIDES) {
      const expected = anchors[side].clone().applyMatrix4(root.matrixWorld);
      expect(worldPosition(profile, `foot.${side}`).distanceTo(expected)).toBeLessThan(CLOSE);
      expect(
        rootRelativeQuaternion(root, bone(profile, `foot.${side}`)).angleTo(footOrientation[side]),
      ).toBeLessThan(CLOSE);
    }
    for (const slot of CORE) {
      const value = bone(profile, slot);
      const before = transforms.get(slot);
      if (!before) throw new Error(`missing snapshot for ${slot}`);
      expect(value.position.distanceTo(before.position)).toBe(0);
      expect(value.scale.distanceTo(before.scale)).toBe(0);
    }
  });

  it('preserves foot orientation through a nested non-uniform metric frame', () => {
    const built = buildRig({ legs: true });
    const originalHips = built.bones.get('Hips');
    if (!originalHips) throw new Error('synthetic rig has no hips');
    const metric = new THREE.Group();
    metric.name = 'MetricFrame';
    const hipsPosition = originalHips.position.clone();
    built.root.remove(originalHips);
    metric.add(originalHips);
    originalHips.position.copy(hipsPosition);
    metric.scale.set(1.2, 0.8, 1.1);
    metric.rotation.set(0.08, -0.14, 0.05);
    built.root.add(metric);
    for (const side of SIDES) {
      const foot = built.bones.get(`Foot_${side}`);
      if (foot) foot.rotation.set(0.13, -0.19, 0.11);
    }
    built.root.updateMatrixWorld(true);
    const profile = buildProfile(built.root, built.descriptor);
    const solver = GroundedLegs.create(profile, restOf(profile));
    if (!solver) throw new Error('nested standing legs were not accepted');

    const root = built.root;
    const metricInverse = metric.matrixWorld.clone().invert();
    const rootInverse = root.matrixWorld.clone().invert();
    const rootAnchors = Object.fromEntries(
      SIDES.map((side) => [side, worldPosition(profile, `foot.${side}`).applyMatrix4(rootInverse)]),
    ) as Record<Side, THREE.Vector3>;
    const restMatrices = Object.fromEntries(
      SIDES.map((side) => [
        side,
        rootInverse.clone().multiply(bone(profile, `foot.${side}`).matrixWorld),
      ]),
    ) as Record<Side, THREE.Matrix4>;

    bone(profile, 'hips').position.y -= 0.02;
    root.updateMatrixWorld(true);
    solver.apply(0);

    for (const side of SIDES) {
      const foot = bone(profile, `foot.${side}`);
      const expectedAnchor = rootAnchors[side].clone().applyMatrix4(root.matrixWorld);
      expect(worldPosition(profile, `foot.${side}`).distanceTo(expectedAnchor)).toBeLessThan(CLOSE);

      const expectedMatrix = metricInverse
        .clone()
        .multiply(root.matrixWorld)
        .multiply(restMatrices[side]);
      const expectedQ = new THREE.Quaternion();
      expectedMatrix.decompose(new THREE.Vector3(), expectedQ, new THREE.Vector3());
      const actualMatrix = metricInverse.clone().multiply(foot.matrixWorld);
      const actualQ = new THREE.Quaternion();
      actualMatrix.decompose(new THREE.Vector3(), actualQ, new THREE.Vector3());
      expect(actualQ.angleTo(expectedQ)).toBeLessThan(CLOSE);
    }
  });

  it('leaves the author pose intact when the two legs have no common downward reach', () => {
    const { built, profile, solver } = setup();
    const hips = bone(profile, 'hips');
    hips.position.x = 0.5;
    built.root.updateMatrixWorld(true);
    const hipPosition = hips.position.clone();
    const rotations = new Map(CORE.map((slot) => [slot, bone(profile, slot).quaternion.clone()]));

    solver.apply(0);
    expect(hips.position.distanceTo(hipPosition)).toBe(0);
    for (const slot of CORE) {
      expect(
        bone(profile, slot).quaternion.angleTo(rotations.get(slot) ?? new THREE.Quaternion()),
      ).toBe(0);
    }
  });
});
