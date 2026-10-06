import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DROOP_RATE } from '@/engine/face/blink';
import { Body } from '@/engine/motion/body';
import { ScalarFollower } from '@/engine/motion/follow';
import { breathCurve, INHALE, settle } from '@/engine/motion/idle';
import { IdlePosture, type PostureInput } from '@/engine/motion/posture';
import { minJerk } from '@/engine/motion/timing';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { buildRig } from '../helpers/scene';

const DT_CASES = [1 / 60, 1 / 30, 0.05];
const BREATH_DEPTH = 0.8;
/** The step speech used to put into depth in one frame. */
const DEPTH_STEP = 0.3 * BREATH_DEPTH;
/** Largest per-frame depth change allowed across a speaking edge. */
const DEPTH_FRAME_BOUND = 0.15 * DEPTH_STEP;
/** Long enough for the depth follower to land within 1e-9 of its target. */
const SETTLE_SECONDS = 8;

function postureHarness(breathDepth = BREATH_DEPTH) {
  const scene = buildRig({ armatureScale: 0.01 });
  const profile = buildProfile(scene.root, scene.descriptor);
  const rig = new Rig(profile);
  const posture = new IdlePosture();
  const hips = profile.bones.hips;
  if (!hips?.parent) throw new Error('test profile is missing the hips parent');
  profile.root.updateMatrixWorld(true);
  const parentLinear = new THREE.Matrix3().setFromMatrix4(hips.parent.matrixWorld).invert();
  const hipsRight = new THREE.Vector3(1, 0, 0).applyMatrix3(parentLinear);
  const hipsUp = new THREE.Vector3(0, 1, 0).applyMatrix3(parentLinear);
  const input: PostureInput = {
    t: 0,
    speaking: false,
    speechEnergy: 0,
    breathPeriod: 4.2,
    breathDepth,
    weightShift: 0,
    idleAmount: 0,
    hipsRest: hips.position.clone(),
    hipsRight,
    hipsUp,
    jumpHeight: 0.2,
    rise: 0,
    load: 0,
  };

  const step = (dt: number, speaking: boolean) => {
    input.t += dt;
    input.speaking = speaking;
    rig.reset();
    const terms = posture.apply(rig, profile, dt, input);
    rig.commitSpine();
    hips.updateMatrix();
    return {
      ...terms,
      breath: posture.breath,
      hipsY: hips.position.y,
      spineQ: profile.bones.spine?.quaternion.clone(),
      chestQ: profile.bones.chest?.quaternion.clone(),
      neckQ: profile.bones.neck?.quaternion.clone(),
    };
  };

  return { input, posture, profile, rig, step };
}

function expectedTerms(phase: number, depth: number, speaking: boolean) {
  const breath = breathCurve(phase);
  return {
    br: (breath - 0.5) * 2,
    d: depth * (speaking ? 0.7 : 1),
    breath,
  };
}

function phaseStep(phase: number, t: number, dt: number, breathPeriod: number, speaking: boolean) {
  const period = breathPeriod * (speaking ? 1.5 : 1) * (1 + 0.11 * Math.sin(t * 0.077 + 1.4));
  return (phase + dt / period) % 1;
}

function quietBody(scene: ReturnType<typeof buildRig>, withoutBodyFrame = false) {
  scene.root.updateMatrixWorld(true);
  const profile = buildProfile(scene.root, scene.descriptor);
  if (withoutBodyFrame) profile.body = null;
  const rig = new Rig(profile);
  const body = new Body(rig, profile);
  body.breathDepth = 0;
  body.idleAmount = 0;
  body.weightShift = 0;
  body.gazeAmount = 0;
  return { body, profile, rig };
}

function worldHips(profile: ReturnType<typeof buildProfile>): THREE.Vector3 {
  const hips = profile.bones.hips;
  if (!hips) throw new Error('synthetic rig has no hips');
  hips.updateWorldMatrix(true, false);
  return hips.getWorldPosition(new THREE.Vector3());
}

describe('IdlePosture speech breath bridge', () => {
  it('keeps the applied breath terms and torso pose continuous at a zero-dt speaking edge', () => {
    const h = postureHarness();
    let last = h.step(0, false);
    for (let i = 0; i < 420; i++) last = h.step(1 / 60, false);

    const onset = h.step(0, true);
    expect(onset.br).toBeCloseTo(last.br, 12);
    expect(onset.d).toBeCloseTo(last.d, 12);
    expect(onset.breath).toBeCloseTo(last.breath, 12);
    expect(onset.hipsY).toBeCloseTo(last.hipsY, 12);
    for (const slot of ['spineQ', 'chestQ', 'neckQ'] as const) {
      const next = onset[slot];
      const previous = last[slot];
      expect(next).toBeDefined();
      expect(previous).toBeDefined();
      expect(next?.x).toBeCloseTo(previous?.x ?? 0, 14);
      expect(next?.y).toBeCloseTo(previous?.y ?? 0, 14);
      expect(next?.z).toBeCloseTo(previous?.z ?? 0, 14);
      expect(next?.w).toBeCloseTo(previous?.w ?? 1, 14);
    }
  });

  it.each(DT_CASES)('preserves the exact never-speaking path at dt=%s', (dt) => {
    const h = postureHarness();
    let phase = 0;
    for (let i = 0; i < 180; i++) {
      const t = h.input.t + dt;
      phase = phaseStep(phase, t, dt, h.input.breathPeriod, false);
      const actual = h.step(dt, false);
      const expected = expectedTerms(phase, BREATH_DEPTH, false);
      expect(actual.br).toBe(expected.br);
      expect(actual.d).toBe(expected.d);
      expect(actual.breath).toBe(expected.breath);
    }
  });

  it.each(DT_CASES)('keeps disabled breath depth at zero during speech bridges at dt=%s', (dt) => {
    const h = postureHarness(0);
    let last = h.step(0, false);
    for (let i = 0; i < 90; i++) last = h.step(dt, false);

    const onset = h.step(0, true);
    expect(onset.br).toBeCloseTo(last.br, 12);
    expect(onset.d).toBe(0);
    expect(onset.hipsY).toBeCloseTo(last.hipsY, 12);
    for (let i = 0; i < 3; i++) expect(h.step(dt, true).d).toBe(0);
    for (let i = 0; i < 4; i++) expect(h.step(dt, false).d).toBe(0);
  });

  it.each(DT_CASES)(
    'rebases short and repeated speech with bounded depth change, then settles on the legacy targets at dt=%s',
    (dt) => {
      const h = postureHarness();
      let phase = 0;
      for (let i = 0; i < 90; i++) {
        const t = h.input.t + dt;
        phase = phaseStep(phase, t, dt, h.input.breathPeriod, false);
        h.step(dt, false);
      }

      const beforeOnset = h.step(0, false);
      const firstOnset = h.step(0, true);
      expect(firstOnset.br).toBeCloseTo(beforeOnset.br, 12);
      expect(firstOnset.d).toBeCloseTo(beforeOnset.d, 12);
      phase = 0.04;

      let lastD = firstOnset.d;
      for (let i = 0; i < 3; i++) {
        const t = h.input.t + dt;
        phase = phaseStep(phase, t, dt, h.input.breathPeriod, true);
        const frame = h.step(dt, true);
        expect(Number.isFinite(frame.br)).toBe(true);
        expect(Number.isFinite(frame.d)).toBe(true);
        expect(frame.br).toBeGreaterThanOrEqual(-1);
        expect(frame.br).toBeLessThanOrEqual(1);
        expect(Math.abs(frame.d - lastD)).toBeLessThan(DEPTH_FRAME_BOUND);
        lastD = frame.d;
      }

      const beforeFall = h.step(0, true);
      const firstFall = h.step(0, false);
      expect(firstFall.br).toBeCloseTo(beforeFall.br, 12);
      expect(firstFall.d).toBeCloseTo(beforeFall.d, 12);

      const afterFallT = h.input.t + dt;
      phase = phaseStep(phase, afterFallT, dt, h.input.breathPeriod, false);
      const afterFall = h.step(dt, false);
      expect(Number.isFinite(afterFall.br)).toBe(true);
      expect(Number.isFinite(afterFall.d)).toBe(true);
      expect(Math.abs(afterFall.d - firstFall.d)).toBeLessThan(DEPTH_FRAME_BOUND);

      const beforeRepeatedOnset = h.step(0, false);
      const repeatedOnset = h.step(0, true);
      expect(repeatedOnset.br).toBeCloseTo(beforeRepeatedOnset.br, 12);
      expect(repeatedOnset.d).toBeCloseTo(beforeRepeatedOnset.d, 12);
      phase = 0.04;
      lastD = repeatedOnset.d;

      let reachedPeak = false;
      for (let i = 0; i < 300; i++) {
        const t = h.input.t + dt;
        phase = phaseStep(phase, t, dt, h.input.breathPeriod, true);
        const frame = h.step(dt, true);
        expect(Number.isFinite(frame.br)).toBe(true);
        expect(frame.br).toBeGreaterThanOrEqual(-1);
        expect(frame.br).toBeLessThanOrEqual(1);
        expect(Math.abs(frame.d - lastD)).toBeLessThan(DEPTH_FRAME_BOUND);
        lastD = frame.d;
        if (phase >= INHALE) {
          const exact = expectedTerms(phase, BREATH_DEPTH, true);
          expect(frame.br).toBe(exact.br);
          expect(frame.breath).toBe(exact.breath);
          reachedPeak = true;
          break;
        }
      }
      expect(reachedPeak).toBe(true);

      // Held speech settles on the shallower legacy depth.
      for (let elapsed = 0; elapsed < SETTLE_SECONDS; elapsed += dt) {
        const t = h.input.t + dt;
        phase = phaseStep(phase, t, dt, h.input.breathPeriod, true);
        lastD = h.step(dt, true).d;
      }
      expect(lastD).toBeCloseTo(expectedTerms(phase, BREATH_DEPTH, true).d, 9);

      // Once the bridge has ended, an ordinary fall keeps the direct breath curve
      // and moves depth back toward the idle target a bounded amount per frame.
      const t = h.input.t + dt;
      phase = phaseStep(phase, t, dt, h.input.breathPeriod, false);
      const afterOrdinaryFall = h.step(dt, false);
      const exactIdle = expectedTerms(phase, BREATH_DEPTH, false);
      expect(afterOrdinaryFall.br).toBe(exactIdle.br);
      expect(afterOrdinaryFall.breath).toBe(exactIdle.breath);
      expect(Math.abs(afterOrdinaryFall.d - lastD)).toBeLessThan(DEPTH_FRAME_BOUND);
      lastD = afterOrdinaryFall.d;

      for (let elapsed = 0; elapsed < SETTLE_SECONDS; elapsed += dt) {
        const tIdle = h.input.t + dt;
        phase = phaseStep(phase, tIdle, dt, h.input.breathPeriod, false);
        const frame = h.step(dt, false);
        expect(Math.abs(frame.d - lastD)).toBeLessThan(DEPTH_FRAME_BOUND);
        lastD = frame.d;
      }
      const settledIdle = expectedTerms(phase, BREATH_DEPTH, false);
      expect(lastD).toBeCloseTo(settledIdle.d, 9);
    },
  );

  it('exposes the applied curve through Body.breath at speech onset', () => {
    const scene = buildRig({ armatureScale: 0.01 });
    const profile = buildProfile(scene.root, scene.descriptor);
    const rig = new Rig(profile);
    const body = new Body(rig, profile);
    body.breathDepth = BREATH_DEPTH;
    body.idleAmount = 0;
    body.weightShift = 0;
    body.gazeAmount = 0;
    for (let i = 0; i < 420; i++) {
      rig.reset();
      body.update(1 / 60);
    }

    const before = body.breath;
    body.speaking = true;
    rig.reset();
    body.update(0);
    expect(body.breath).toBeCloseTo(before, 12);
  });

  it('uses the existing minimum-jerk curve during the active bridge', () => {
    const h = postureHarness();
    for (let i = 0; i < 80; i++) h.step(1 / 60, false);
    const from = h.step(0, false);
    h.step(0, true);

    const dt = 0.05;
    const t = h.input.t + dt;
    const period = h.input.breathPeriod * 1.5 * (1 + 0.11 * Math.sin(t * 0.077 + 1.4));
    const phase = 0.04 + dt / period;
    const target = expectedTerms(phase, BREATH_DEPTH, true);
    const followedD = new ScalarFollower(from.d).step(target.d, dt, DROOP_RATE);
    const w = minJerk((phase - 0.04) / (INHALE - 0.04));
    const expectedBr = from.br + (target.br - from.br) * w;
    const expectedD = from.d + (followedD - from.d) * w;
    const actual = h.step(dt, true);

    expect(actual.br).toBeCloseTo(expectedBr, 12);
    expect(actual.d).toBeCloseTo(expectedD, 12);
    expect(actual.breath).toBeCloseTo((expectedBr + 1) / 2, 12);
    expect(breathCurve(INHALE)).toBe(1);
  });
});

describe('IdlePosture world-space hips translation', () => {
  it('keeps the tuned weight-shift phase when semantic right opposes hips local X', () => {
    const scene = buildRig();
    for (const [name, bone] of scene.bones) {
      if (/_L$/.test(name) || /_R$/.test(name)) bone.position.x *= -1;
    }
    const h = quietBody(scene);
    const hips = h.profile.bones.hips;
    const chest = h.profile.bones.chest ?? h.profile.bones.spine;
    const bodyFrame = h.profile.body;
    if (!hips) throw new Error('synthetic rig has no hips');
    if (!(chest && bodyFrame)) throw new Error('synthetic rig has no body frame');
    const parent = hips.parent;
    if (!parent) throw new Error('synthetic rig has no hips parent');
    expect(bodyFrame.right.x).toBeLessThan(-0.99);

    const rest = worldHips(h.profile);
    h.body.weightShift = 1;
    h.rig.reset();
    h.body.update(0.5);
    const delta = worldHips(h.profile).sub(rest);
    const hipsRight = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(hips.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
    const anatomicalRight = bodyFrame.right
      .clone()
      .applyMatrix3(new THREE.Matrix3().setFromMatrix4(chest.matrixWorld))
      .normalize();

    // The mirrored fixture makes semantic right point world -X while the
    // authored hips translation still points world +X. The rest-axis gauge
    // keeps the existing phase and the counter-lean that accompanies it.
    expect(delta.dot(hipsRight)).toBeGreaterThan(1e-4);
    expect(delta.dot(anatomicalRight)).toBeLessThan(-1e-4);
    const parentLinear = new THREE.Matrix3().setFromMatrix4(parent.matrixWorld);
    expect(
      h.body.hipsRight.clone().applyMatrix3(parentLinear).normalize().dot(hipsRight),
    ).toBeGreaterThan(0.999);
  });

  it('keeps breath translation vertical in world space under a rotated non-uniform parent', () => {
    const scene = buildRig();
    scene.root.rotation.z = Math.PI / 2;
    scene.root.scale.set(0.01, 0.02, 0.03);
    const h = quietBody(scene);
    h.body.breathDepth = 1;
    const rest = worldHips(h.profile);
    h.rig.reset();
    h.body.update(0.5);
    const delta = worldHips(h.profile).sub(rest);
    const br = (h.body.breath - 0.5) * 2;
    expect(delta.dot(new THREE.Vector3(0, 1, 0))).toBeCloseTo(0.0035 * br, 12);
    expect(delta.x).toBeCloseTo(0, 12);
    expect(delta.z).toBeCloseTo(0, 12);
  });

  it('uses world up for the no-body-frame fallback while retaining local-X sway', () => {
    const scene = buildRig();
    scene.root.rotation.z = Math.PI / 2;
    scene.root.scale.set(0.01, 0.02, 0.03);
    scene.root.updateMatrixWorld(true);
    const h = quietBody(scene, true);
    const hips = h.profile.bones.hips;
    if (!hips?.parent) throw new Error('synthetic rig has no hips parent');
    const parentLinear = new THREE.Matrix3().setFromMatrix4(hips.parent.matrixWorld);
    const localXWorld = new THREE.Vector3(1, 0, 0).applyMatrix3(parentLinear).normalize();
    const rest = worldHips(h.profile);
    h.body.weightShift = 1;
    h.rig.reset();
    h.body.update(0.5);
    const delta = worldHips(h.profile).sub(rest);

    expect(delta.length()).toBeCloseTo(0.012 * settle(Math.sin(0.5 * 0.31)), 12);
    expect(delta.clone().normalize().dot(localXWorld)).toBeCloseTo(1, 12);
    const worldUpFromFallback = h.body.hipsUp.clone().applyMatrix3(parentLinear).normalize();
    expect(worldUpFromFallback.dot(new THREE.Vector3(0, 1, 0))).toBeCloseTo(1, 12);
  });
});
