import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { Body } from '@/engine/motion/body';
import { HOPS } from '@/engine/motion/jump';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { buildRig } from '../../helpers/scene';

function fixture() {
  const built = buildRig({ legs: true, armatureScale: 0.01 });
  built.root.position.set(0.2, 0, -0.3);
  built.root.rotation.y = 0.3;
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const body = new Body(rig, profile, { random: () => 0.5 });
  body.gazeAmount = 0;
  body.idleAmount = 0;
  body.breathDepth = 0;
  body.weightShift = 0;
  return { profile, rig, body };
}

function snapshot(h: ReturnType<typeof fixture>) {
  const matrices: number[][] = [];
  h.profile.root.traverse((object) => {
    matrices.push(
      object.position.toArray(),
      object.quaternion.toArray(),
      object.scale.toArray(),
      object.matrix.elements.slice(),
      object.matrixWorld.elements.slice(),
    );
    if (object instanceof THREE.SkinnedMesh)
      matrices.push(object.bindMatrix.elements.slice(), object.bindMatrixInverse.elements.slice());
  });
  return {
    matrices,
    arms: (['L', 'R'] as const).map((side) => ({
      accepted: h.rig.armDriver(side)?.captureAcceptedState(),
      sensed: structuredClone(h.rig.lastAcceptedHandPose(side)),
      controls: structuredClone(h.rig.acceptedArmState(side)),
    })),
  };
}

afterEach(() => vi.restoreAllMocks());

it('reduces full scene traversals without changing played frames or accepted histories', () => {
  const actual = fixture();
  const reference = fixture();
  const method =
    Reflect.get(actual.rig, 'armForwardContextFromUpdatedBody') ?? actual.rig.armForwardContext;
  let fastReads = 0;
  Reflect.set(actual.rig, 'armForwardContextFromUpdatedBody', (side: 'L' | 'R') => {
    fastReads++;
    return Reflect.apply(method, actual.rig, [side]);
  });
  // Recreate precisely the old eager traversal boundaries; no solver result,
  // random draw, collision row, or acceptance decision is replaced.
  const plant = reference.rig.plantLegs.bind(reference.rig);
  reference.rig.plantLegs = (rise) => {
    reference.profile.root.updateMatrixWorld(true);
    plant(rise);
  };
  Reflect.set(
    reference.rig,
    'armForwardContextFromUpdatedBody',
    reference.rig.armForwardContext.bind(reference.rig),
  );
  const actualRefresh = vi.spyOn(actual.profile.root, 'updateMatrixWorld');
  const referenceRefresh = vi.spyOn(reference.profile.root, 'updateMatrixWorld');
  const initial = snapshot(actual);
  for (const h of [actual, reference]) {
    h.body.play('catPaw', 'L');
    h.body.hop(HOPS.hop);
  }
  for (let frame = 0; frame < 12; frame++) {
    for (const h of [actual, reference]) {
      h.rig.reset();
      h.body.update(1 / 30);
    }
    expect(snapshot(actual)).toEqual(snapshot(reference));
  }
  expect(snapshot(actual)).not.toEqual(initial);
  expect(fastReads).toBeGreaterThan(0);
  expect(actualRefresh.mock.calls.length).toBeGreaterThan(0);
  expect(actualRefresh.mock.calls.length).toBeLessThan(referenceRefresh.mock.calls.length);
});

it('reuses the completed body refresh for both native arm readers in every candidate', () => {
  const h = fixture();
  const refresh = vi.spyOn(h.profile.root, 'updateMatrixWorld');
  const apply = h.rig.applyBodyContext.bind(h.rig);
  let candidateStart = 0;
  let candidates = 0;
  h.rig.applyBodyContext = (alpha, transport = alpha) => {
    candidateStart = refresh.mock.calls.length;
    candidates++;
    return apply(alpha, transport);
  };
  const captures: Record<'L' | 'R', number[]> = { L: [], R: [] };
  for (const side of ['L', 'R'] as const) {
    const driver = h.rig.armDriver(side);
    if (!driver) throw new Error('missing native driver');
    const capture = driver.captureVolumeFrame.bind(driver);
    driver.captureVolumeFrame = () => {
      captures[side].push(refresh.mock.calls.length - candidateStart);
      capture();
    };
  }
  h.body.playDef(
    {
      label: { en: 'Spine motion', ja: '背骨の動き' },
      group: 'pose',
      lead: 0.2,
      hold: 1,
      build: () => ({ spine: { chest: [0.04, 0, 0] } }),
    },
    'spine',
  );
  h.rig.reset();
  h.body.update(1 / 30);
  expect(h.body.blend).toBeGreaterThan(0);
  expect(candidates).toBeGreaterThan(0);
  for (const side of ['L', 'R'] as const) {
    expect(captures[side].length).toBeGreaterThan(0);
    expect(new Set(captures[side])).toEqual(new Set([1]));
  }
});
