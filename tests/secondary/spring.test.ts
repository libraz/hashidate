import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Spring } from '@/engine/secondary';
import type { AvatarDescriptor, ColliderSpec, SwayGroupSpec } from '@/engine/types';
import { addBoneChain, buildRig, type SyntheticRig } from '../helpers/scene';

const STEP = 1 / 60;

interface ChainSpec {
  parent: string;
  root: string;
  joints?: number;
}

interface SpringFixture {
  rig: SyntheticRig;
  spring: Spring;
}

function makeSpring(
  groups: SwayGroupSpec[],
  chains: ChainSpec[],
  colliders: Record<string, ColliderSpec[]> = {},
): SpringFixture {
  const rig = buildRig();
  for (const chain of chains) addBoneChain(rig, chain);
  const descriptor: AvatarDescriptor = {
    ...rig.descriptor,
    sway: { groups, colliders },
  };
  const profile = buildProfile(rig.root, descriptor);
  return { rig, spring: new Spring(profile, descriptor) };
}

function snapshot(spring: Spring) {
  return spring.groups.flatMap((g) =>
    g.joints.map((j) => ({
      cur: j.cur.clone(),
      prev: j.prev.clone(),
      quaternion: j.bone.quaternion.clone(),
    })),
  );
}

function expectSameSnapshot(
  actual: ReturnType<typeof snapshot>,
  expected: ReturnType<typeof snapshot>,
) {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < actual.length; i++) {
    expect(actual[i].cur.distanceTo(expected[i].cur)).toBeLessThan(1e-6);
    expect(actual[i].prev.distanceTo(expected[i].prev)).toBeLessThan(1e-6);
    expect(actual[i].quaternion.angleTo(expected[i].quaternion)).toBeLessThan(1e-6);
  }
}

function expectFinite(spring: Spring): void {
  for (const group of spring.groups) {
    for (const joint of group.joints) {
      const values = [
        ...joint.cur.toArray(),
        ...joint.prev.toArray(),
        ...joint.bone.quaternion.toArray(),
        ...joint.drive.toArray(),
      ];
      expect(values.every((value) => Number.isFinite(value))).toBe(true);
    }
  }
}

function speed(spring: Spring): number {
  return spring.groups
    .flatMap((g) => g.joints)
    .reduce((total, joint) => total + joint.cur.distanceTo(joint.prev), 0);
}

describe('Spring', () => {
  it('keeps a resting chain stable and finite, including a calibrated collider', () => {
    const { spring } = makeSpring(
      [
        {
          id: 'hair',
          stiffness: 1,
          drag: 0.4,
          colliders: ['head'],
          roots: ['Hair'],
        },
      ],
      [{ parent: 'Head', root: 'Hair', joints: 3 }],
      { head: [{ bone: 'Head', offset: [0, 0, 0], radius: 0.2 }] },
    );

    // The collider deliberately overlaps the bind pose. Calibration must keep
    // the artist's pose rather than throwing the chain out on its first frame.
    const group = spring.groups[0];
    expect(group).toBeDefined();
    expect(group.colliders).toHaveLength(1);

    spring.update(0);
    const seeded = snapshot(spring);
    for (let i = 0; i < 180; i++) spring.update(STEP);

    expectSameSnapshot(snapshot(spring), seeded);
    expectFinite(spring);
  });

  it('caps a long frame at four fixed steps instead of catching up unboundedly', () => {
    const build = () =>
      makeSpring(
        [{ id: 'hair', stiffness: 1.3, drag: 0.55, roots: ['Hair'] }],
        [{ parent: 'Head', root: 'Hair', joints: 3 }],
      );
    const capped = build();
    const reference = build();
    capped.spring.update(0);
    reference.spring.update(0);

    // Give the solver an actual response to integrate; a motionless rest pose
    // would also pass if the accumulator were accidentally ignored.
    capped.rig.bones.get('Head')?.rotateY(0.6);
    reference.rig.bones.get('Head')?.rotateY(0.6);
    capped.rig.root.updateMatrixWorld(true);
    reference.rig.root.updateMatrixWorld(true);

    capped.spring.update(10);
    reference.spring.update(STEP * 4);

    expect(capped.spring._acc).toBeCloseTo(0, 14);
    expectSameSnapshot(snapshot(capped.spring), snapshot(reference.spring));
    expectFinite(capped.spring);
  });

  it('makes seed and restore idempotent, including after a body teleport', () => {
    const { rig, spring } = makeSpring(
      [{ id: 'hair', stiffness: 1.1, drag: 0.5, roots: ['Hair'] }],
      [{ parent: 'Head', root: 'Hair', joints: 3 }],
    );
    spring.update(0);

    spring.reset();
    spring.update(0);
    const seededOnce = snapshot(spring);
    spring.reset();
    spring.update(0);
    const seededTwice = snapshot(spring);
    expectSameSnapshot(seededTwice, seededOnce);

    rig.bones.get('Head')?.rotateX(0.45);
    rig.root.updateMatrixWorld(true);
    for (let i = 0; i < 30; i++) spring.update(STEP);

    spring.enabled = false;
    spring.update(0);
    const restoredOnce = snapshot(spring);
    spring.update(0.8);
    const restoredTwice = snapshot(spring);
    expectSameSnapshot(restoredTwice, restoredOnce);
    for (const group of spring.groups) {
      for (const joint of group.joints) {
        expect(joint.bone.quaternion.angleTo(joint.rest)).toBeLessThan(1e-6);
      }
    }

    // Enabling after a large world-space move must seed the new pose rather
    // than carrying stale tail points across the teleport.
    rig.root.position.set(3, 0, -2);
    rig.bones.get('Head')?.rotateY(-0.35);
    rig.root.updateMatrixWorld(true);
    spring.enabled = true;
    spring.update(0);
    for (const joint of spring.groups.flatMap((group) => group.joints)) {
      expect(joint.cur.distanceTo(joint.prev)).toBeLessThan(1e-12);
    }
    expectFinite(spring);
  });

  it('lets independent side chains respond without contaminating one another', () => {
    const groups = [
      {
        id: 'sides',
        stiffness: 1.2,
        drag: 0.55,
        roots: ['LeftHair', 'RightHair'],
      },
    ];
    const baseline = makeSpring(groups, [
      { parent: 'Shoulder_L', root: 'LeftHair', joints: 3 },
      { parent: 'Shoulder_R', root: 'RightHair', joints: 3 },
    ]);
    const moved = makeSpring(groups, [
      { parent: 'Shoulder_L', root: 'LeftHair', joints: 3 },
      { parent: 'Shoulder_R', root: 'RightHair', joints: 3 },
    ]);
    baseline.spring.update(0);
    moved.spring.update(0);
    const leftBefore = moved.spring.groups[0].joints
      .filter((joint) => joint.bone.name.startsWith('LeftHair'))
      .map((joint) => joint.cur.clone());

    moved.rig.bones.get('Shoulder_L')?.rotateX(0.65);
    moved.rig.root.updateMatrixWorld(true);
    baseline.spring.update(STEP);
    moved.spring.update(STEP);

    const baselineRight = baseline.spring.groups[0].joints.filter((joint) =>
      joint.bone.name.startsWith('RightHair'),
    );
    const movedRight = moved.spring.groups[0].joints.filter((joint) =>
      joint.bone.name.startsWith('RightHair'),
    );
    expect(movedRight).toHaveLength(baselineRight.length);
    for (let i = 0; i < movedRight.length; i++) {
      expect(movedRight[i].cur.distanceTo(baselineRight[i].cur)).toBeLessThan(1e-6);
      expect(movedRight[i].bone.quaternion.angleTo(baselineRight[i].bone.quaternion)).toBeLessThan(
        1e-6,
      );
    }
    const leftAfter = moved.spring.groups[0].joints
      .filter((joint) => joint.bone.name.startsWith('LeftHair'))
      .map((joint) => joint.cur);
    expect(leftAfter.some((point, i) => point.distanceTo(leftBefore[i]) > 1e-6)).toBe(true);
    expectFinite(moved.spring);
  });

  it('responds to a moved parent and converges without stretching a link', () => {
    const { rig, spring } = makeSpring(
      [{ id: 'hair', stiffness: 1.4, drag: 0.6, roots: ['Hair'] }],
      [{ parent: 'Head', root: 'Hair', joints: 4 }],
    );
    spring.update(0);
    rig.bones.get('Head')?.rotateY(0.7);
    rig.root.updateMatrixWorld(true);

    spring.update(STEP);
    const firstSpeed = speed(spring);
    for (let i = 0; i < 240; i++) spring.update(STEP);
    const finalSpeed = speed(spring);

    expect(firstSpeed).toBeGreaterThan(0);
    expect(finalSpeed).toBeLessThan(firstSpeed);
    for (const joint of spring.groups.flatMap((group) => group.joints)) {
      const base = joint.bone.getWorldPosition(new THREE.Vector3());
      expect(joint.cur.distanceTo(base)).toBeCloseTo(joint.length, 9);
    }
    expectFinite(spring);
  });
});
