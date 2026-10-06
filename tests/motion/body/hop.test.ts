import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Body } from '@/engine/motion/body';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { buildRig } from '../../helpers/scene';
import { DT, type Harness, harness } from './harness';

/**
 * A hop asked for while one is in flight.
 *
 * The rise goes straight into the hips with nothing chasing it, so a request
 * that restarted the arc would drop the whole skeleton to rest in one frame.
 */

function hipsY(h: Harness): number {
  const hips = h.profile.bones.hips;
  if (!hips) throw new Error('synthetic rig has no hips');
  return hips.position.y;
}

function run(h: Harness, frames: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    h.rig.reset();
    h.body.update(DT);
    out.push(hipsY(h));
  }
  return out;
}

const maxStep = (xs: number[]): number =>
  Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i])));

function worldHips(h: Harness): THREE.Vector3 {
  const hips = h.profile.bones.hips;
  if (!hips) throw new Error('synthetic rig has no hips');
  hips.updateWorldMatrix(true, false);
  return hips.getWorldPosition(new THREE.Vector3());
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Rebase every direct child under a turned parent while keeping world anatomy. */
function rebaseChildrenAfterParentTurn(root: THREE.Object3D, bones: THREE.Bone[]): void {
  const restWorld = new Map<THREE.Bone, THREE.Matrix4>();
  for (const bone of bones) restWorld.set(bone, bone.matrixWorld.clone());

  root.rotation.z = Math.PI / 2;
  root.updateMatrixWorld(true);
  bones.sort((a, b) => {
    const depth = (bone: THREE.Bone) => {
      let n: THREE.Object3D | null = bone;
      let out = 0;
      while (n?.parent) {
        out++;
        n = n.parent;
      }
      return out;
    };
    return depth(a) - depth(b);
  });
  for (const bone of bones) {
    if (!bone.parent) continue;
    const world = restWorld.get(bone);
    if (!world) continue;
    const local = bone.parent.matrixWorld.clone().invert().multiply(world);
    local.decompose(bone.position, bone.quaternion, bone.scale);
    bone.updateMatrixWorld(true);
  }
  root.updateMatrixWorld(true);
}

function rebasedHopHarness(): Harness {
  const built = buildRig();
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  rebaseChildrenAfterParentTurn(built.root, [...built.bones.values()]);
  const rig = new Rig(profile);
  const body = new Body(rig, profile);
  const h = { body, profile, rig };
  body.breathDepth = 0;
  body.idleAmount = 0;
  body.weightShift = 0;
  body.gazeAmount = 0;
  return h;
}

function scaledHopHarness(): Harness {
  const built = buildRig();
  built.root.rotation.z = Math.PI / 2;
  built.root.scale.set(0.01, 0.02, 0.03);
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const body = new Body(rig, profile);
  body.breathDepth = 0;
  body.idleAmount = 0;
  body.weightShift = 0;
  body.gazeAmount = 0;
  return { body, profile, rig };
}

function slopedHopHarness(): Harness {
  const built = buildRig();
  const neck = built.bones.get('Neck');
  if (!neck) throw new Error('synthetic rig has no neck');
  neck.position.x = 0.04;
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const body = new Body(rig, profile);
  body.breathDepth = 0;
  body.idleAmount = 0;
  body.weightShift = 0;
  body.gazeAmount = 0;
  return { body, profile, rig };
}

function peakRise(h: Harness, up: THREE.Vector3): number {
  const rest = worldHips(h);
  h.body.hop({ height: 0.08 });
  let peak = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < 120; i++) {
    h.rig.reset();
    h.body.update(DT);
    const delta = worldHips(h).sub(rest);
    const rise = delta.dot(up);
    expect(delta.clone().addScaledVector(up, -rise).length()).toBeLessThan(1e-9);
    peak = Math.max(peak, rise);
  }
  return peak;
}

describe('hop retrigger', () => {
  it('keeps the hips continuous when a hop is asked for mid-flight', () => {
    const h = harness();
    const rest = run(h, 2).at(-1) ?? 0;
    h.body.hop({ height: 0.08 });
    const before = run(h, 30);
    // Airborne, so a restart would have somewhere to fall from.
    expect((before.at(-1) ?? 0) - rest).toBeGreaterThan(0.02);
    const alone = harness();
    run(alone, 2);
    alone.body.hop({ height: 0.08 });
    const single = maxStep([rest, ...run(alone, 120)]);
    h.body.hop({ height: 0.08 });
    const after = run(h, 180);
    const all = [rest, ...before, ...after];
    // No frame moves the hips further than the hop's own fastest frame does.
    expect(maxStep(all)).toBeLessThanOrEqual(single + 1e-9);
    // The second hop still happens: the hips leave rest again after landing.
    const landed = after.findIndex((y) => Math.abs(y - rest) < 1e-9);
    expect(landed).toBeGreaterThan(0);
    expect(Math.max(...after.slice(landed)) - rest).toBeGreaterThan(0.02);
  });

  it('drops a queued hop when the run is finished early', () => {
    const h = harness();
    run(h, 2);
    h.body.hop({ height: 0.08 });
    run(h, 10);
    h.body.hop({ height: 0.08 });
    h.body.finishHop();
    run(h, 180);
    expect(h.body.jumping).toBe(false);
  });
});

describe('hop world displacement', () => {
  it('keeps a hop at its metre height after rebasing direct children under a turned parent', () => {
    const h = rebasedHopHarness();
    expect(peakRise(h, WORLD_UP)).toBeCloseTo(0.08, 4);
  });

  it('keeps a hop at its metre height under a rotated non-uniform parent scale', () => {
    const h = scaledHopHarness();
    expect(peakRise(h, WORLD_UP)).toBeCloseTo(0.08, 4);
  });

  it('uses world gravity up when the rest trunk axis slopes', () => {
    const h = slopedHopHarness();
    const chest = h.profile.bones.chest;
    const body = h.profile.body;
    if (!(chest && body)) throw new Error('synthetic rig has no body frame');
    const trunkUp = body.up
      .clone()
      .applyMatrix3(new THREE.Matrix3().setFromMatrix4(chest.matrixWorld))
      .normalize();
    expect(Math.abs(trunkUp.dot(new THREE.Vector3(0, 1, 0)))).toBeLessThan(0.999);
    expect(peakRise(h, WORLD_UP)).toBeCloseTo(0.08, 4);
  });
});
