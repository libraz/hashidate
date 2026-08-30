import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Spring, Tail } from '@/engine/secondary';
import type { AvatarDescriptor, Profile, SwayGroupSpec } from '@/engine/types';
import { addBoneChain, buildRig, type SyntheticRig } from '../helpers/scene';

const STEP = 1 / 60;

interface TailFixture {
  rig: SyntheticRig;
  profile: Profile;
  descriptor: AvatarDescriptor;
  spring: Spring;
  tail: Tail;
}

function makeFixture(options: { passive?: boolean; driven?: boolean } = {}): TailFixture {
  const passive = options.passive ?? true;
  const driven = options.driven ?? true;
  const rig = buildRig();
  if (passive) addBoneChain(rig, { parent: 'Head', root: 'Hair', joints: 3 });
  if (driven) {
    addBoneChain(rig, {
      parent: 'Hips',
      root: 'Tail',
      joints: 4,
      rootOffset: [0, -0.025, 0.06],
      segmentOffset: [0, -0.09, 0.025],
    });
  }

  const groups: SwayGroupSpec[] = [];
  if (passive) groups.push({ id: 'hair', stiffness: 1.2, drag: 0.55, roots: ['Hair'] });
  if (driven) groups.push({ id: 'tail', stiffness: 0.9, drag: 0.48, roots: ['Tail'] });
  const descriptor: AvatarDescriptor = {
    ...rig.descriptor,
    sway: { groups },
    ...(driven ? { drive: { tail: { group: 'tail', swing: 0.45, lift: 0.3 } } } : {}),
  };
  const profile = buildProfile(rig.root, descriptor);
  const spring = new Spring(profile, descriptor);
  const tail = new Tail(profile, descriptor, spring);
  return { rig, profile, descriptor, spring, tail };
}

function bodyUp(profile: Profile): THREE.Vector3 {
  const chest = profile.bones.chest ?? profile.bones.spine ?? profile.bones.hips;
  if (!(profile.body && chest)) throw new Error('synthetic profile has no body frame');
  return profile.body.up
    .clone()
    .applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion()))
    .normalize();
}

function parentQuaternion(joint: TailFixture['tail']['joints'][number]): THREE.Quaternion {
  return joint.parent.getWorldQuaternion(new THREE.Quaternion());
}

function expectFinite(fixture: TailFixture): void {
  for (const joint of fixture.spring.groups.flatMap((group) => group.joints)) {
    const values = [
      ...joint.cur.toArray(),
      ...joint.prev.toArray(),
      ...joint.bone.quaternion.toArray(),
      ...joint.drive.toArray(),
    ];
    expect(values.every((value) => Number.isFinite(value))).toBe(true);
  }
  for (const axis of [fixture.tail.swingAxis, fixture.tail.liftAxis]) {
    expect(axis.length()).toBeCloseTo(1, 12);
    expect(axis.toArray().every((value) => Number.isFinite(value))).toBe(true);
  }
}

describe('Tail', () => {
  it('claims only the configured root and derives finite, orthogonal axes', () => {
    const fixture = makeFixture();
    const tailJoints = fixture.spring.groups.find((group) => group.id === 'tail')?.joints ?? [];
    expect(fixture.tail.active).toBe(true);
    expect(fixture.tail.missing).toEqual([]);
    expect(tailJoints[0].driven).toBe(true);
    expect(tailJoints.slice(1).every((joint) => !joint.driven)).toBe(true);
    expect(fixture.tail.swingAxis.dot(fixture.tail.liftAxis)).toBeCloseTo(0, 12);
    expectFinite(fixture);
  });

  it('raises and tucks the measured tail direction with emotion rather than naming a bone', () => {
    const fixture = makeFixture({ passive: false });
    fixture.spring.update(0);
    const base = fixture.tail.joints[0];
    const parentQ = parentQuaternion(base);
    const rest = base.restDir(parentQ, new THREE.Vector3());
    const up = bodyUp(fixture.profile);

    fixture.tail.update(0, { surprise: 1 });
    const raised = base.restDir(parentQ, new THREE.Vector3());
    fixture.tail.update(0, { sadness: 1 });
    const tucked = base.restDir(parentQ, new THREE.Vector3());

    // The sign is inferred from the body frame and the actual hanging
    // direction. Surprise must move upward; sadness is the negative control.
    expect(raised.dot(up)).toBeGreaterThan(rest.dot(up));
    expect(tucked.dot(up)).toBeLessThan(rest.dot(up));
    expectFinite(fixture);
  });

  it('normalises emotion weights and uses neutral for non-positive input', () => {
    const single = makeFixture({ passive: false });
    const scaled = makeFixture({ passive: false });
    const empty = makeFixture({ passive: false });
    const neutral = makeFixture({ passive: false });

    single.tail.update(0.17, { joy: 1 }, 0.3);
    scaled.tail.update(0.17, { joy: 2 }, 0.3);
    empty.tail.update(0.17, { joy: 0, anger: -2 }, 0.3);
    neutral.tail.update(0.17, {}, 0.3);

    expect(single.tail.joints[0].drive.angleTo(scaled.tail.joints[0].drive)).toBeLessThan(1e-12);
    expect(empty.tail.joints[0].drive.angleTo(neutral.tail.joints[0].drive)).toBeLessThan(1e-6);
    expectFinite(single);
    expectFinite(scaled);
    expectFinite(empty);
  });

  it('drives the base before passive links and lets the tip lag behind it', () => {
    const fixture = makeFixture({ passive: false });
    fixture.spring.update(0);
    const joints = fixture.spring.groups.find((group) => group.id === 'tail')?.joints ?? [];
    const [base, ...rest] = joints;
    const beforeBase = base.cur.clone();
    const beforeTip = rest[rest.length - 1].cur.clone();
    const identity = new THREE.Quaternion();

    fixture.tail.update(0.2, { joy: 1 });
    expect(base.drive.angleTo(identity)).toBeGreaterThan(1e-4);
    expect(rest.every((joint) => joint.drive.angleTo(identity) < 1e-12)).toBe(true);
    fixture.spring.update(STEP);

    const baseDelta = base.cur.distanceTo(beforeBase);
    const tipDelta = rest[rest.length - 1].cur.distanceTo(beforeTip);
    expect(baseDelta).toBeGreaterThan(tipDelta);
    expectFinite(fixture);
  });

  it('does not change passive integration when a separate tail root is driven', () => {
    const baseline = makeFixture({ passive: true, driven: false });
    const driven = makeFixture({ passive: true, driven: true });
    baseline.spring.update(0);
    driven.spring.update(0);

    baseline.rig.bones.get('Head')?.rotateY(0.55);
    driven.rig.bones.get('Head')?.rotateY(0.55);
    baseline.rig.root.updateMatrixWorld(true);
    driven.rig.root.updateMatrixWorld(true);
    driven.tail.update(0.2, { joy: 1 }, 0.4);
    for (let i = 0; i < 30; i++) {
      baseline.spring.update(STEP);
      driven.spring.update(STEP);
    }

    const baselineJoints = baseline.spring.groups[0].joints;
    const drivenJoints = driven.spring.groups.find((group) => group.id === 'hair')?.joints ?? [];
    expect(driven.tail.joints[0].driven).toBe(true);
    expect(drivenJoints).toHaveLength(baselineJoints.length);
    for (let i = 0; i < drivenJoints.length; i++) {
      expect(drivenJoints[i].cur.distanceTo(baselineJoints[i].cur)).toBeLessThan(1e-6);
      expect(
        drivenJoints[i].bone.quaternion.angleTo(baselineJoints[i].bone.quaternion),
      ).toBeLessThan(1e-6);
    }
    expectFinite(driven);
  });

  it('seeds once after a reset and a world-space teleport without carrying velocity', () => {
    const fixture = makeFixture({ passive: false });
    fixture.spring.update(0);
    fixture.tail.update(0.35, { joy: 1 });
    for (let i = 0; i < 40; i++) fixture.spring.update(STEP);

    fixture.rig.root.position.set(4, 0, -3);
    fixture.rig.bones.get('Hips')?.rotateZ(0.4);
    fixture.rig.root.updateMatrixWorld(true);
    fixture.spring.reset();
    fixture.spring.update(0);
    const joints = fixture.spring.groups.find((group) => group.id === 'tail')?.joints ?? [];
    const first = joints.map((joint) => ({
      cur: joint.cur.clone(),
      prev: joint.prev.clone(),
      quaternion: joint.bone.quaternion.clone(),
    }));

    for (const joint of joints) {
      expect(joint.cur.distanceTo(joint.prev)).toBeLessThan(1e-6);
    }
    fixture.spring.reset();
    fixture.spring.update(0);
    for (let i = 0; i < joints.length; i++) {
      const joint = joints[i];
      expect(joint.cur.distanceTo(first[i].cur)).toBeLessThan(1e-6);
      expect(joint.prev.distanceTo(first[i].prev)).toBeLessThan(1e-6);
      expect(joint.bone.quaternion.angleTo(first[i].quaternion)).toBeLessThan(1e-6);
    }
    expectFinite(fixture);
  });

  it('leaves the sway layer untouched when the requested drive group is absent', () => {
    const rig = buildRig();
    addBoneChain(rig, { parent: 'Hips', root: 'Tail', joints: 2 });
    const descriptor: AvatarDescriptor = {
      ...rig.descriptor,
      sway: { groups: [{ id: 'hair', roots: ['Tail'] }] },
      drive: { tail: { group: 'missing' } },
    };
    const profile = buildProfile(rig.root, descriptor);
    const spring = new Spring(profile, descriptor);
    const tail = new Tail(profile, descriptor, spring);

    expect(tail.active).toBe(false);
    expect(tail.missing).toEqual(['drive:missing']);
    expect(spring.drivenJoints).toHaveLength(0);
  });
});
