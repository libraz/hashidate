import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Body } from '@/engine/motion/body';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

function fixture(legs = true, scale = 1, transformed = false) {
  const built = buildRig({ legs, armatureScale: scale });
  if (transformed) {
    built.root.position.set(0.3, 0.2, -0.4);
    built.root.rotation.y = 0.4;
    built.root.scale.setScalar(1.1);
    const parent = new THREE.Group();
    parent.position.set(-0.1, 0.05, 0.2);
    parent.add(built.root);
    parent.updateMatrixWorld(true);
  }
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  new Body(rig, profile, { random: () => 0.5 });
  return { built, profile, rig };
}

function context(rig: Rig, side: Side) {
  const method = Reflect.get(rig, 'armForwardContextFromUpdatedBody');
  return typeof method === 'function'
    ? Reflect.apply(method, rig, [side])
    : rig.armForwardContext(side);
}

function matrices(root: THREE.Object3D) {
  const result: number[][] = [];
  // Read raw state: world-position getters would refresh away a stale matrix.
  root.traverse((object) => {
    result.push(
      object.position.toArray(),
      object.quaternion.toArray(),
      object.scale.toArray(),
      object.matrix.elements.slice(),
      object.matrixWorld.elements.slice(),
    );
    if (object instanceof THREE.SkinnedMesh)
      result.push(object.bindMatrix.elements.slice(), object.bindMatrixInverse.elements.slice());
  });
  return result;
}

function eagerReference(rig: Rig) {
  const plant = rig.plantLegs.bind(rig);
  rig.plantLegs = (rise) => {
    rig.p.root.updateMatrixWorld(true);
    plant(rise);
  };
}

afterEach(() => vi.restoreAllMocks());

describe('body context matrix refresh boundary', () => {
  it.each([true, false])('performs only the necessary full-root passes with legs=%s', (legs) => {
    const h = fixture(legs);
    h.rig.captureProposedBodyContext(0);
    const refresh = vi.spyOn(h.profile.root, 'updateMatrixWorld');
    h.rig.applyBodyContext(0.5, 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    refresh.mockClear();
    expect(context(h.rig, 'L')).not.toBeNull();
    expect(context(h.rig, 'R')).not.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    h.rig.armForwardContext('L');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    { legs: true, scale: 1, transformed: false },
    { legs: true, scale: 0.01, transformed: true },
    { legs: false, scale: 1, transformed: true },
    { legs: false, scale: 0.01, transformed: false },
  ])('matches eager raw matrices and accepted history for %j', ({ legs, scale, transformed }) => {
    const actual = fixture(legs, scale, transformed);
    const reference = fixture(legs, scale, transformed);
    eagerReference(reference.rig);
    for (const h of [actual, reference]) {
      const hips = h.profile.bones.hips;
      const chest = h.profile.bones.chest;
      if (!(hips && chest)) throw new Error('missing body bones');
      hips.position.y += 0.03 / scale;
      chest.rotation.x += 0.04;
      h.rig.plantLegs(0.03);
      h.rig.captureProposedBodyContext(0.03);
    }
    const before = matrices(actual.profile.root);
    for (const alpha of [0, 0.25, 0.75, 1, 0.5, 0]) {
      if (transformed) {
        for (const h of [actual, reference]) {
          h.profile.root.position.x += 0.01;
          const parent = h.profile.root.parent;
          if (parent) {
            parent.rotation.y += 0.03;
            parent.position.y += 0.005;
          }
        }
      }
      actual.rig.applyBodyContext(alpha, alpha);
      reference.rig.applyBodyContext(alpha, alpha);
      expect(matrices(actual.profile.root)).toEqual(matrices(reference.profile.root));
      for (const side of ['L', 'R'] as const) {
        expect(context(actual.rig, side)).toEqual(reference.rig.armForwardContext(side));
        expect(actual.rig.armDriver(side)?.captureAcceptedState()).toEqual(
          reference.rig.armDriver(side)?.captureAcceptedState(),
        );
      }
      expect(matrices(actual.profile.root)).toEqual(matrices(reference.profile.root));
    }
    expect(matrices(actual.profile.root)).not.toEqual(before);
  });

  it.each(['custom evaluator', 'missing hips', 'hips outside root', 'failed planting'])(
    'retains eager equivalence for %s',
    (scenario) => {
      const actual = fixture();
      const reference = fixture();
      eagerReference(reference.rig);
      for (const h of [actual, reference]) {
        h.rig.captureProposedBodyContext(0);
        if (scenario === 'custom evaluator') {
          const driver = h.rig.armDriver('L');
          if (!driver) throw new Error('missing driver');
          driver.environment.sample = driver.environment.sample.bind(driver.environment);
        } else if (scenario === 'missing hips') {
          delete h.profile.bones.hips;
        } else if (scenario === 'hips outside root') {
          const hips = h.profile.bones.hips;
          if (!hips) throw new Error('missing hips');
          new THREE.Group().attach(hips);
        } else {
          const thigh = h.profile.bones['upperLeg.L'];
          if (!thigh) throw new Error('missing thigh');
          thigh.position.x += 10;
        }
        h.rig.applyBodyContext(0.5, 1);
      }
      const refresh = vi.spyOn(actual.profile.root, 'updateMatrixWorld');
      expect(context(actual.rig, 'L')).toEqual(reference.rig.armForwardContext('L'));
      expect(matrices(actual.profile.root)).toEqual(matrices(reference.profile.root));
      if (scenario !== 'failed planting') expect(refresh).toHaveBeenCalledTimes(1);
    },
  );
});

it('refreshes a custom evaluator scene write before reading the other arm', () => {
  const h = fixture();
  const driver = h.rig.armDriver('L');
  const mesh = h.built.meshes.get('Face');
  if (!(driver && mesh)) throw new Error('missing evaluator or mesh');
  h.rig.captureProposedBodyContext(0);
  h.rig.applyBodyContext(0.5, 1);
  const original = driver.environment.sample;
  driver.environment.sample = (points, rows) => {
    mesh.position.x += 0.1;
    original(points, rows);
  };
  driver.environment.sample(driver.output.points, driver.output.clearances);
  const stale = mesh.matrixWorld.elements.slice();
  const refresh = vi.spyOn(h.profile.root, 'updateMatrixWorld');
  context(h.rig, 'R');
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(mesh.matrixWorld.elements).not.toEqual(stale);
  const updated = matrices(h.profile.root);
  h.rig.armForwardContext('R');
  expect(matrices(h.profile.root)).toEqual(updated);
  // The public entrypoint must remain eager after an unrelated caller's edit.
  mesh.position.z += 0.2;
  h.rig.armForwardContext('L');
  expect(matrices(h.profile.root)).not.toEqual(updated);
});
