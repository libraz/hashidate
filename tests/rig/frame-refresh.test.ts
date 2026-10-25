import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Body } from '@/engine/motion/body';
import { HOPS } from '@/engine/motion/jump';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { SkeletonRefresh } from '@/engine/rig/skeleton';
import type { Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

const FRAMES = 16;

function fixture(legs: boolean) {
  const built = buildRig({ legs, armatureScale: 0.01 });
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

type Fixture = ReturnType<typeof fixture>;

/** Raw state only: a world-position getter would refresh a stale matrix away. */
function matrices(root: THREE.Object3D): number[][] {
  const out: number[][] = [];
  root.traverse((object) => {
    out.push(
      object.position.toArray(),
      object.quaternion.toArray(),
      object.matrix.elements.slice(),
      object.matrixWorld.elements.slice(),
    );
  });
  return out;
}

function histories(h: Fixture) {
  return (['L', 'R'] as const).map((side) => ({
    accepted: h.rig.armDriver(side)?.captureAcceptedState(),
    sensed: structuredClone(h.rig.lastAcceptedHandPose(side)),
    controls: structuredClone(h.rig.acceptedArmState(side)),
  }));
}

/** Refresh the whole scene around every write the rig used to refresh after. */
function eager(h: Fixture): void {
  const root = h.profile.root;
  const apply = h.rig.applyBodyContext.bind(h.rig);
  h.rig.applyBodyContext = (alpha, transport = alpha) => {
    const rise = apply(alpha, transport);
    root.updateMatrixWorld(true);
    return rise;
  };
  const hands = Reflect.get(h.rig, 'hands');
  const curl = hands.curlHand.bind(hands);
  hands.curlHand = (side: Side, spec: object, spread: object) => {
    curl(side, spec, spread);
    root.updateMatrixWorld(true);
  };
  const capture = Reflect.get(h.rig, 'captureHandPose');
  Reflect.set(h.rig, 'captureHandPose', (side: Side) => {
    root.updateMatrixWorld(true);
    return Reflect.apply(capture, h.rig, [side, true]);
  });
}

function start(h: Fixture): void {
  h.body.play('catPaw', 'L');
  h.body.hop(HOPS.hop);
}

afterEach(() => vi.restoreAllMocks());

describe('per-frame scene refresh', () => {
  it.each([true, false])('leaves every matrix as an eager refresh would, legs=%s', (legs) => {
    const actual = fixture(legs);
    const reference = fixture(legs);
    eager(reference);
    const initial = matrices(actual.profile.root);
    for (const h of [actual, reference]) start(h);
    for (let frame = 0; frame < FRAMES; frame++) {
      for (const h of [actual, reference]) {
        h.rig.reset();
        h.body.update(1 / 30);
      }
      const played = matrices(actual.profile.root);
      expect(played).toEqual(matrices(reference.profile.root));
      expect(histories(actual)).toEqual(histories(reference));
      // Nothing the frame wrote was left with a stale world matrix.
      actual.profile.root.updateMatrixWorld(true);
      expect(matrices(actual.profile.root)).toEqual(played);
    }
    expect(matrices(actual.profile.root)).not.toEqual(initial);
  });

  it.each([true, false])('commits both arms with one scene pass, legs=%s', (legs) => {
    const h = fixture(legs);
    const reference = fixture(legs);
    eager(reference);
    for (const f of [h, reference]) start(f);
    const passes = vi.spyOn(h.profile.root, 'updateMatrixWorld');
    const eagerPasses = vi.spyOn(reference.profile.root, 'updateMatrixWorld');
    const commit = h.rig.commitArmFrame.bind(h.rig);
    const perCommit: number[] = [];
    h.rig.commitArmFrame = (plans, rise) => {
      const before = passes.mock.calls.length;
      const committed = commit(plans, rise);
      if (committed) perCommit.push(passes.mock.calls.length - before);
      return committed;
    };
    for (let frame = 0; frame < FRAMES; frame++) {
      for (const f of [h, reference]) {
        f.rig.reset();
        f.body.update(1 / 30);
      }
    }
    expect(perCommit.length).toBeGreaterThan(0);
    expect(new Set(perCommit)).toEqual(new Set([1]));
    expect(passes.mock.calls.length).toBeLessThan(eagerPasses.mock.calls.length);
  });
});

/** Every node's raw matrices, skinned bind inverses included. */
function scene(root: THREE.Object3D): number[][] {
  const out: number[][] = [];
  root.traverse((object) => {
    out.push(object.matrix.elements.slice(), object.matrixWorld.elements.slice());
    if (object instanceof THREE.SkinnedMesh) out.push(object.bindMatrixInverse.elements.slice());
  });
  return out;
}

/** Move a mesh beside the skeleton from inside the left arm's evaluation. */
function customEvaluator(h: Fixture): void {
  const driver = h.rig.armDriver('L');
  let mesh: THREE.Object3D | undefined;
  h.profile.root.traverse((object) => {
    if (!mesh && object instanceof THREE.SkinnedMesh) mesh = object;
  });
  if (!(driver && mesh)) throw new Error('missing evaluator or mesh');
  const moved = mesh;
  const original = driver.environment.sample;
  driver.environment.sample = (points, rows) => {
    moved.position.x += 1e-4;
    original(points, rows);
  };
}

describe('skeleton refresh after the frame plant', () => {
  it.each([false, true])(
    'plays every frame as full passes would, custom evaluator=%s',
    (custom) => {
      const actual = fixture(true);
      const reference = fixture(true);
      const skeleton = Reflect.get(actual.rig, 'skeleton') as SkeletonRefresh;
      const skeletonPasses = vi.spyOn(skeleton, 'run');
      const full = Reflect.get(reference.rig, 'skeleton') as SkeletonRefresh;
      full.run = () => reference.profile.root.updateMatrixWorld(true);
      for (const h of [actual, reference]) {
        if (custom) customEvaluator(h);
        start(h);
      }
      for (let frame = 0; frame < FRAMES; frame++) {
        for (const h of [actual, reference]) {
          // Moved between frames, as a viewer places the avatar: the plant's full pass catches it.
          h.profile.root.rotation.y += 0.05;
          h.profile.root.position.x += 0.01;
          h.rig.reset();
          h.body.update(1 / 30);
        }
        expect(scene(actual.profile.root)).toEqual(scene(reference.profile.root));
        expect(histories(actual)).toEqual(histories(reference));
      }
      if (custom) expect(skeletonPasses).not.toHaveBeenCalled();
      else expect(skeletonPasses.mock.calls.length).toBeGreaterThanOrEqual(2 * FRAMES);
    },
  );
});
