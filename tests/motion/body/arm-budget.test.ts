import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { gestureEntries } from '@/engine/motion';
import { Body } from '@/engine/motion/body';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { GestureDef, Profile } from '@/engine/types';
import { buildRig } from '../../helpers/scene';
import { harness, wristOf } from './harness';

/**
 * What one frame's arm commit may cost.
 *
 * An arm is checked a fixed number of times per second of motion, whatever the
 * frame rate, and its goal costs one bounded solver step a frame; the recovery
 * chain adds its repairs only when a command fails its check.
 */

interface Work {
  plans: number;
  validations: number;
  holds: number;
  environmentBatches: number;
}

const work = (body: unknown): Work =>
  (body as { _transaction: { _armFrameWork: Work } })._transaction._armFrameWork;

/** One solver call's own cap on environment batches (`rig/arm_path/plan.rs`). */
const SOLVER_CALL = 96;

/** Locked validations for one frame of `dt` seconds, as `rig/arm_route.rs` counts them. */
const validationSamples = (dt: number): number =>
  Math.min(4, Math.max(1, Math.ceil(dt / (1 / 60) - 1e-9)));

/**
 * The most one frame may spend, both arms: per arm the goal's solver step, the
 * raw check and the restore of a chain start that is not clear; the frame's
 * checks; then recovery — a restore, a plan from the accepted pose, and the
 * checks of that plan, the stop tail and the hold.
 */
const frameBound = (dt: number): number =>
  2 * (SOLVER_CALL + 1 + SOLVER_CALL + validationSamples(dt) + SOLVER_CALL + SOLVER_CALL + 3);

/** The right hand flung across the chest to the far shoulder. */
const ACROSS: GestureDef = {
  label: { en: 'Across', ja: '横切る' },
  group: 'pose',
  lead: 0,
  hold: 2,
  sustain: true,
  build: () => ({
    arms: {
      R: {
        upperArm: new THREE.Vector3(-0.3, -0.2, 0.93).normalize(),
        lowerArm: new THREE.Vector3(-0.95, 0.1, 0.2).normalize(),
        hand: new THREE.Vector3(-0.95, 0.1, 0.2).normalize(),
      },
    },
  }),
};

function chestOf(profile: Profile): THREE.Quaternion {
  const chest = profile.bones.chest ?? profile.bones.spine;
  if (!chest) throw new Error('synthetic rig has no chest');
  return chest.getWorldQuaternion(new THREE.Quaternion());
}

describe('arm commit budget', () => {
  it('checks each idle arm a fixed number of times per second', () => {
    const h = harness();
    h.body.breathDepth = 1;
    h.body.idleAmount = 1;
    h.body.weightShift = 1;
    for (const dt of [1 / 120, 1 / 60, 1 / 30, 1 / 20, 1 / 8]) {
      for (let i = 0; i < 6; i++) {
        h.rig.reset();
        h.body.update(dt);
        expect(work(h.body).holds).toBe(0);
        expect(work(h.body).validations).toBeLessThanOrEqual(2 * validationSamples(dt));
        expect(work(h.body).environmentBatches).toBeLessThanOrEqual(frameBound(dt));
      }
    }
  });

  it('keeps mirrored idle weight shift moving on a fixed number of checks', () => {
    const scene = buildRig();
    for (const [name, bone] of scene.bones) {
      if (/_L$/.test(name) || /_R$/.test(name)) bone.position.x *= -1;
    }
    scene.root.updateMatrixWorld(true);
    const profile = buildProfile(scene.root, scene.descriptor);
    const rig = new Rig(profile);
    const body = new Body(rig, profile);
    body.breathDepth = 0;
    body.idleAmount = 0;
    body.gazeAmount = 0;
    body.weightShift = 1;
    const hips = profile.bones.hips;
    const chest = profile.bones.chest ?? profile.bones.spine;
    const frame = profile.body;
    if (!(hips && chest && frame)) throw new Error('missing mirrored body fixture');
    expect(frame.right.x).toBeLessThan(-0.99);
    const rest = hips.getWorldPosition(new THREE.Vector3());
    rig.reset();
    body.update(0.5);
    const delta = hips.getWorldPosition(new THREE.Vector3()).sub(rest);
    const hipsRight = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(hips.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
    const semanticRight = frame.right
      .clone()
      .applyMatrix3(new THREE.Matrix3().setFromMatrix4(chest.matrixWorld))
      .normalize();
    expect(work(body).plans).toBeLessThanOrEqual(2);
    expect(work(body).environmentBatches).toBeLessThanOrEqual(frameBound(0.5));
    expect(work(body).validations).toBeGreaterThan(0);
    expect(work(body).validations).toBeLessThanOrEqual(2 * validationSamples(0.5));
    expect(delta.dot(hipsRight)).toBeGreaterThan(1e-4);
    expect(delta.dot(semanticRight)).toBeLessThan(-1e-4);
  });

  it('stays inside the frame bound through every gesture start', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = harness();
    for (let i = 0; i < 10; i++) {
      h.rig.reset();
      h.body.update(1 / 60);
    }
    for (const [id] of gestureEntries()) {
      h.body.play(id);
      for (let i = 0; i < 21; i++) {
        h.rig.reset();
        h.body.update(1 / 60);
        expect(work(h.body).plans, id).toBeLessThanOrEqual(2);
        expect(work(h.body).environmentBatches, id).toBeLessThanOrEqual(frameBound(1 / 60));
      }
    }
    vi.restoreAllMocks();
  });

  it('carries a fast cross-body travel without holding an arm or the chest', () => {
    const h = harness();
    const idle = harness();
    const step = () => {
      for (const run of [h, idle]) {
        run.rig.reset();
        run.body.update(1 / 60);
      }
    };
    for (let i = 0; i < 10; i++) step();
    const start = wristOf(h.profile, 'R');
    h.body.playDef(ACROSS, 'across');
    for (let i = 0; i < 90; i++) {
      step();
      expect(work(h.body).holds, `frame ${i}`).toBe(0);
      expect(chestOf(h.profile).angleTo(chestOf(idle.profile)), `frame ${i}`).toBeLessThan(1e-9);
    }
    expect(wristOf(h.profile, 'R').distanceTo(start)).toBeGreaterThan(0.1);
  });

  it('plays the whole gesture table at 60 Hz inside the frame bound without holding an arm', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const holds: string[] = [];
    const over: string[] = [];
    for (const [id, def] of gestureEntries()) {
      const h = harness();
      h.rig.reset();
      h.body.update(1 / 60);
      h.body.play(id);
      const frames = Math.ceil((def.lead + def.hold + 1.5) * 60);
      for (let i = 0; i < frames; i++) {
        if (i === Math.ceil((def.lead + def.hold) * 60)) h.body.stopGesture();
        h.rig.reset();
        h.body.update(1 / 60);
        if (work(h.body).holds > 0) holds.push(`${id}@${i}`);
        if (work(h.body).environmentBatches > frameBound(1 / 60)) over.push(`${id}@${i}`);
      }
    }
    vi.restoreAllMocks();
    expect(over).toEqual([]);
    expect(holds).toEqual([]);
  });
});
