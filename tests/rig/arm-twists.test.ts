import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { ArmTwists } from '@/engine/rig/arm-twists';
import { buildRig } from '../helpers/scene';

function fixture(family: 'twist' | 'rotate' = 'twist', scale = 1) {
  const built = buildRig({ armTwistHelpers: family, armatureScale: scale });
  const profile = buildProfile(built.root, built.descriptor);
  const controller = ArmTwists.create(profile);
  if (!controller) throw new Error('missing helper controller');
  const binding = profile.armTwists?.['lowerArm.R'];
  if (!binding) throw new Error('missing binding');
  const rest = binding.helper.quaternion.clone();
  const nextRest = binding.next.quaternion.clone();
  const axis = profile.restDir['lowerArm.R'].clone().normalize();
  const pose = (degrees: number) => {
    binding.next.quaternion
      .copy(nextRest)
      .premultiply(
        new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees)),
      );
  };
  const expected = (degrees: number) =>
    new THREE.Quaternion()
      .setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees / 2))
      .multiply(rest);
  return { built, profile, controller, binding, rest, nextRest, axis, pose, expected };
}

function closeQuaternion(actual: THREE.Quaternion, expected: THREE.Quaternion) {
  for (let i = 0; i < 4; i++) expect(actual.toArray()[i]).toBeCloseTo(expected.toArray()[i], 12);
}

describe('optional arm twist deformation', () => {
  it.each([
    ['twist', 1],
    ['rotate', 0.01],
  ] as const)(
    'preserves nonidentity helper bind and primary transforms for %s at %s',
    (family, scale) => {
      const h = fixture(family, scale);
      h.pose(80);
      const before = [h.binding.primary, h.binding.next].map((b) => b.quaternion.toArray());
      h.controller.stage('R');
      closeQuaternion(h.binding.helper.quaternion, h.expected(80));
      expect([h.binding.primary, h.binding.next].map((b) => b.quaternion.toArray())).toEqual(
        before,
      );
      for (let i = 0; i < 5; i++) {
        h.controller.reset();
        expect(h.binding.helper.quaternion.toArray()).toEqual(h.rest.toArray());
        h.controller.stage('R');
        closeQuaternion(h.binding.helper.quaternion, h.expected(80));
      }
    },
  );

  it('never drives a helper selected as a canonical eye while retaining other bindings', () => {
    const built = buildRig({ armTwistHelpers: 'twist' });
    built.descriptor.bones = { 'eye.L': ['UpperArm_twist_L'] };
    const profile = buildProfile(built.root, built.descriptor);
    const alias = profile.armTwists?.['upperArm.L'];
    const lower = profile.armTwists?.['lowerArm.L'];
    if (!(alias && lower)) throw new Error('missing bindings');
    expect(profile.bones['eye.L']).toBe(alias.helper);
    const eyeRest = alias.helper.quaternion.clone();
    const lowerRest = lower.helper.quaternion.clone();
    const controller = ArmTwists.create(profile);
    if (!controller) throw new Error('other helper bindings must remain available');
    alias.next.quaternion.setFromAxisAngle(profile.restDir['upperArm.L'], 0.8);
    lower.next.quaternion.setFromAxisAngle(profile.restDir['lowerArm.L'], 0.6);
    controller.stage('L');
    controller.accept('L');
    expect(alias.helper.quaternion.toArray()).toEqual(eyeRest.toArray());
    closeQuaternion(
      lower.helper.quaternion,
      new THREE.Quaternion()
        .setFromAxisAngle(profile.restDir['lowerArm.L'], 0.3)
        .multiply(lowerRest),
    );
    alias.helper.rotation.y += 0.2;
    const externallyPosedEye = alias.helper.quaternion.toArray();
    controller.reset();
    expect(alias.helper.quaternion.toArray()).toEqual(externallyPosedEye);
    expect(lower.helper.quaternion.toArray()).toEqual(lowerRest.toArray());
  });

  it('does no matrix work when the optional bindings are absent or empty', () => {
    const built = buildRig();
    const p = buildProfile(built.root, built.descriptor);
    const update = vi.spyOn(THREE.Object3D.prototype, 'updateWorldMatrix');
    const read = vi.spyOn(THREE.Object3D.prototype, 'getWorldQuaternion');
    try {
      delete p.armTwists;
      expect(ArmTwists.create(p)).toBeNull();
      p.armTwists = {};
      expect(ArmTwists.create(p)).toBeNull();
      expect(update).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      update.mockRestore();
      read.mockRestore();
    }
  });

  it('unwraps only from committed frames and retains history across reset and rejected trials', () => {
    const h = fixture();
    h.pose(170);
    h.controller.accept('R');
    h.pose(-170);
    h.controller.stage('R');
    closeQuaternion(h.binding.helper.quaternion, h.expected(190));
    h.pose(-10);
    h.controller.stage('R');
    h.controller.reset();
    h.pose(-170);
    h.controller.accept('R');
    closeQuaternion(h.binding.helper.quaternion, h.expected(190));
    h.pose(-150);
    h.controller.accept('R');
    closeQuaternion(h.binding.helper.quaternion, h.expected(210));
  });

  it('does not let a rejected trial select the next angular branch', () => {
    const trial = fixture();
    const control = fixture();
    trial.pose(179);
    trial.controller.stage('R');
    trial.pose(-179);
    trial.controller.stage('R');
    control.pose(-179);
    control.controller.stage('R');
    closeQuaternion(trial.binding.helper.quaternion, control.binding.helper.quaternion);
    closeQuaternion(trial.binding.helper.quaternion, trial.expected(-179));
  });

  it('holds the last accepted axial angle at the swing-twist pole', () => {
    const h = fixture();
    h.pose(80);
    h.controller.accept('R');
    const perpendicular = new THREE.Vector3(0, 1, 0).cross(h.axis).normalize();
    h.binding.next.quaternion.setFromAxisAngle(perpendicular, Math.PI).multiply(h.nextRest);
    h.controller.accept('R');
    closeQuaternion(h.binding.helper.quaternion, h.expected(80));
    h.pose(100);
    h.controller.stage('R');
    closeQuaternion(h.binding.helper.quaternion, h.expected(100));
  });

  it.each(['reparent', 'nonleaf', 'next moved', 'alias'])(
    'never writes a helper after topology becomes unsafe: %s',
    (change) => {
      const h = fixture();
      h.pose(80);
      h.controller.accept('R');
      if (change === 'reparent') h.built.root.add(h.binding.helper);
      if (change === 'nonleaf') h.binding.helper.add(new THREE.Bone());
      if (change === 'next moved') h.built.root.add(h.binding.next);
      if (change === 'alias') h.binding.helper = h.binding.next;
      const helper = h.binding.helper;
      const before = helper.quaternion.toArray();
      h.controller.reset();
      h.controller.stage('R');
      h.controller.accept('R');
      expect(helper.quaternion.toArray()).toEqual(before);
    },
  );

  it.each(['nonfinite', 'reflection', 'nonconformal', 'shear'])(
    'restores rest without advancing history for an invalid live frame: %s',
    (change) => {
      const h = fixture();
      h.pose(170);
      h.controller.accept('R');
      const primary = h.binding.primary;
      const position = primary.position.clone();
      if (change === 'nonfinite') primary.position.x = Number.NaN;
      if (change === 'reflection') primary.scale.x = -1;
      if (change === 'nonconformal') primary.scale.x = 2;
      if (change === 'shear') {
        primary.updateMatrix();
        primary.matrixAutoUpdate = false;
        primary.matrix.elements[4] += 0.2;
      }
      h.pose(-10);
      h.controller.accept('R');
      expect(h.binding.helper.quaternion.toArray()).toEqual(h.rest.toArray());
      primary.position.copy(position);
      primary.scale.setScalar(1);
      primary.matrixAutoUpdate = true;
      h.pose(-170);
      h.controller.stage('R');
      closeQuaternion(h.binding.helper.quaternion, h.expected(190));
    },
  );

  it('extracts the actual mixed-wrist residual relative to nonidentity adjacent bind', () => {
    const built = buildRig({ armTwistHelpers: 'rotate' });
    const profile = buildProfile(built.root, built.descriptor);
    const binding = profile.armTwists?.['lowerArm.L'];
    if (!binding) throw new Error('missing binding');
    binding.primary.rotation.set(0.2, -0.3, 0.15);
    binding.next.rotation.set(-0.13, 0.24, 0.19);
    const nextRest = binding.next.quaternion.clone();
    const rest = binding.helper.quaternion.clone();
    const axis = profile.restDir['lowerArm.L'].clone().normalize();
    const controller = ArmTwists.create(profile);
    if (!controller) throw new Error('missing controller');
    const swingAxis = new THREE.Vector3(0, 1, 0).cross(axis).normalize();
    const residual = new THREE.Quaternion()
      .setFromAxisAngle(swingAxis, 0.7)
      .multiply(new THREE.Quaternion().setFromAxisAngle(axis, 1.1));
    binding.next.quaternion.copy(residual).multiply(nextRest);
    controller.stage('L');
    closeQuaternion(
      binding.helper.quaternion,
      new THREE.Quaternion().setFromAxisAngle(axis, 0.55).multiply(rest),
    );
    binding.next.quaternion.set(
      ...(binding.next.quaternion.toArray().map((v) => -v) as [number, number, number, number]),
    );
    controller.stage('L');
    closeQuaternion(
      binding.helper.quaternion,
      new THREE.Quaternion().setFromAxisAngle(axis, 0.55).multiply(rest),
    );
  });

  it('does not calibrate an initially invalid frame from a subsequent posed frame', () => {
    const built = buildRig({ armTwistHelpers: 'twist' });
    const profile = buildProfile(built.root, built.descriptor);
    built.root.scale.x = -1;
    expect(ArmTwists.create(profile)).toBeNull();
  });

  it('improves a real weighted skinned point while preserving the canonical joint', () => {
    const h = fixture();
    const helper = h.binding.helper;
    const point = new THREE.Vector3().setFromMatrixPosition(helper.matrixWorld);
    point.y += 0.05;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(point.toArray(), 3));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 1, 0, 0], 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([0.5, 0.5, 0, 0], 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    h.built.root.add(mesh);
    const skeleton = new THREE.Skeleton([h.binding.next, helper]);
    mesh.bind(skeleton);
    const radial = () => {
      h.built.root.updateMatrixWorld(true);
      skeleton.update();
      const p = mesh.applyBoneTransform(0, point.clone());
      const origin = helper.getWorldPosition(new THREE.Vector3());
      const axis = h.axis
        .clone()
        .applyQuaternion(h.binding.primary.getWorldQuaternion(new THREE.Quaternion()));
      return p.sub(origin).addScaledVector(axis, -p.dot(axis)).length();
    };
    const restRadius = radial();
    h.pose(80);
    const before = radial();
    const joint = h.binding.next.quaternion.toArray();
    h.controller.stage('R');
    const after = radial();
    expect(before / restRadius).toBeCloseTo(Math.cos(THREE.MathUtils.degToRad(40)), 10);
    expect(after / restRadius).toBeCloseTo(Math.cos(THREE.MathUtils.degToRad(20)), 10);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(restRadius);
    expect(h.binding.next.quaternion.toArray()).toEqual(joint);
  });
});
