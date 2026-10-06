import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Body } from '@/engine/motion/body';
import { breathCurve, INHALE } from '@/engine/motion/idle';
import { IdlePosture, type PostureInput } from '@/engine/motion/posture';
import { minJerk } from '@/engine/motion/timing';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { buildRig } from '../helpers/scene';

const DT_CASES = [1 / 60, 1 / 30, 0.05];
const BREATH_DEPTH = 0.8;

function postureHarness(breathDepth = BREATH_DEPTH) {
  const scene = buildRig({ armatureScale: 0.01 });
  const profile = buildProfile(scene.root, scene.descriptor);
  const rig = new Rig(profile);
  const posture = new IdlePosture();
  const hips = profile.bones.hips;
  if (!hips?.parent) throw new Error('test profile is missing the hips parent');
  profile.root.updateMatrixWorld(true);
  const hipsUnit = 1 / hips.parent.getWorldScale(new THREE.Vector3()).x;
  const input: PostureInput = {
    t: 0,
    speaking: false,
    speechEnergy: 0,
    breathPeriod: 4.2,
    breathDepth,
    weightShift: 0,
    idleAmount: 0,
    hipsRest: hips.position.clone(),
    hipsUnit,
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
    'rebases short and repeated speech, then returns to the exact legacy target at dt=%s',
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

      for (let i = 0; i < 3; i++) {
        const t = h.input.t + dt;
        phase = phaseStep(phase, t, dt, h.input.breathPeriod, true);
        const frame = h.step(dt, true);
        expect(Number.isFinite(frame.br)).toBe(true);
        expect(Number.isFinite(frame.d)).toBe(true);
        expect(frame.br).toBeGreaterThanOrEqual(-1);
        expect(frame.br).toBeLessThanOrEqual(1);
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

      const beforeRepeatedOnset = h.step(0, false);
      const repeatedOnset = h.step(0, true);
      expect(repeatedOnset.br).toBeCloseTo(beforeRepeatedOnset.br, 12);
      expect(repeatedOnset.d).toBeCloseTo(beforeRepeatedOnset.d, 12);
      phase = 0.04;

      let reachedPeak = false;
      for (let i = 0; i < 300; i++) {
        const t = h.input.t + dt;
        phase = phaseStep(phase, t, dt, h.input.breathPeriod, true);
        const frame = h.step(dt, true);
        expect(Number.isFinite(frame.br)).toBe(true);
        expect(frame.br).toBeGreaterThanOrEqual(-1);
        expect(frame.br).toBeLessThanOrEqual(1);
        if (phase >= INHALE) {
          const exact = expectedTerms(phase, BREATH_DEPTH, true);
          expect(frame.br).toBe(exact.br);
          expect(frame.d).toBe(exact.d);
          expect(frame.breath).toBe(exact.breath);
          reachedPeak = true;
          break;
        }
      }
      expect(reachedPeak).toBe(true);

      // Once the bridge has ended, an ordinary fall remains the old direct target.
      const t = h.input.t + dt;
      phase = phaseStep(phase, t, dt, h.input.breathPeriod, false);
      const afterOrdinaryFall = h.step(dt, false);
      const exactIdle = expectedTerms(phase, BREATH_DEPTH, false);
      expect(afterOrdinaryFall.br).toBe(exactIdle.br);
      expect(afterOrdinaryFall.d).toBe(exactIdle.d);
      expect(afterOrdinaryFall.breath).toBe(exactIdle.breath);
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
    const w = minJerk((phase - 0.04) / (INHALE - 0.04));
    const expectedBr = from.br + (target.br - from.br) * w;
    const expectedD = from.d + (target.d - from.d) * w;
    const actual = h.step(dt, true);

    expect(actual.br).toBeCloseTo(expectedBr, 12);
    expect(actual.d).toBeCloseTo(expectedD, 12);
    expect(actual.breath).toBeCloseTo((expectedBr + 1) / 2, 12);
    expect(breathCurve(INHALE)).toBe(1);
  });
});
