import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Body } from '@/engine/motion/body';
import { HOPS, planJump, sampleJump } from '@/engine/motion/jump';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { BoneSlot } from '@/engine/types';
import { buildRig } from '../../helpers/scene';

function fixture(scale = 1) {
  const built = buildRig({ legs: true, armatureScale: scale });
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const body = new Body(rig, profile, { random: () => 0.5 });
  body.idleAmount = 0;
  body.gazeAmount = 0;
  body.breathDepth = 0;
  body.weightShift = 0;
  const position = (slot: BoneSlot) => {
    const bone = profile.bones[slot];
    if (!bone) throw new Error(`missing ${slot}`);
    bone.updateWorldMatrix(true, false);
    return bone.getWorldPosition(new THREE.Vector3());
  };
  const step = (dt: number) => {
    rig.reset();
    body.update(dt);
  };
  return { profile, rig, body, position, step };
}

// Reflection permits running this regression against the original one-argument
// method before transport becomes a separate interpolation coordinate.
function apply(rig: Rig, alpha: number, transport: number): number {
  return Reflect.apply(rig.applyBodyContext, rig, [alpha, transport]) as number;
}

afterEach(() => vi.restoreAllMocks());

describe('airborne transport and body articulation', () => {
  it('keeps a normally played hop on its authored trajectory with the body never held back', () => {
    const h = fixture();
    const dt = 1 / 30;
    h.step(dt);
    const anchors = [h.position('foot.L'), h.position('foot.R')];
    const samples = vi.spyOn(h.rig, 'applyBodyContext');
    h.body.play('catPaw', 'L');
    h.body.hop(HOPS.hop);
    const arc = planJump(HOPS.hop.height, h.body.gravity, HOPS.hop.count);
    let airborne = false;
    for (let frame = 1; frame <= 12; frame++) {
      h.step(dt);
      const rise = Math.max(0, sampleJump(arc, frame * dt).rise);
      airborne ||= rise > 0;
      for (const [index, side] of (['L', 'R'] as const).entries()) {
        const expected = anchors[index].clone().add(new THREE.Vector3(0, rise, 0));
        expect(h.position(`foot.${side}`).distanceTo(expected)).toBeLessThan(1e-7);
      }
    }
    expect(airborne).toBe(true);
    // The arms give way to the body: it is applied as followed, or not at all.
    expect(samples.mock.calls.length).toBeGreaterThan(0);
    expect(samples.mock.calls.every(([alpha]) => alpha === 0 || alpha === 1)).toBe(true);
  });

  it.each([1, 0.01])('separates world-up lift from articulation with parent scale %s', (scale) => {
    const h = fixture(scale);
    const hips = h.profile.bones.hips;
    if (!hips) throw new Error('missing hips');
    const before = h.position('hips');
    const feet = [h.position('foot.L'), h.position('foot.R')];
    const lift = 0.06;
    hips.position.y += lift / scale;
    h.rig.plantLegs(lift);
    h.rig.captureProposedBodyContext(lift);
    for (let step = 0; step <= 20; step++) {
      const progress = step / 20;
      expect(apply(h.rig, 0, progress)).toBeCloseTo(lift * progress, 12);
      expect(
        h.position('hips').distanceTo(before.clone().add(new THREE.Vector3(0, lift * progress, 0))),
      ).toBeLessThan(1e-7);
      for (const [index, side] of (['L', 'R'] as const).entries()) {
        expect(
          h
            .position(`foot.${side}`)
            .distanceTo(feet[index].clone().add(new THREE.Vector3(0, lift * progress, 0))),
        ).toBeLessThan(1e-7);
      }
    }
  });

  it.each([0.06, -0.03])(
    'commits signed transport %s with unchanged accepted joints and self-clearances',
    (lift) => {
      const h = fixture();
      h.step(1 / 60);
      const hips = h.profile.bones.hips;
      if (!hips) throw new Error('missing hips');
      const saved = (['L', 'R'] as const).map((side) => {
        const driver = h.rig.armDriver(side);
        const context = h.rig.armForwardContext(side);
        const sense = h.rig.lastAcceptedHandPose(side);
        if (!(driver && context && sense)) throw new Error('missing accepted arm');
        driver.captureVolumeFrame();
        expect(
          driver.validateLockedPose(
            driver.acceptedQ,
            context,
            driver.acceptedCurls,
            driver.acceptedSpread,
          ),
        ).toBe(true);
        return {
          side,
          driver,
          q: Array.from(driver.acceptedQ),
          curls: { ...driver.acceptedCurls },
          spread: { ...driver.acceptedSpread },
          wrist: driver.acceptedForward.wrist.clone(),
          knuckle: sense.knuckle.clone(),
          clearances: driver.bridgeOutput.clearances.map((row) => ({
            valid: row.valid,
            distance: row.distance,
          })),
        };
      });
      hips.position.y += lift;
      h.rig.plantLegs(lift);
      h.rig.captureProposedBodyContext(lift);
      for (let step = 0; step <= 20; step++) {
        apply(h.rig, 0, step / 20);
        for (const { side, driver, q, curls, spread, clearances } of saved) {
          const context = h.rig.armForwardContext(side);
          if (!context) throw new Error('missing arm context');
          driver.captureVolumeFrame();
          expect(driver.validateLockedPose(new Float64Array(q), context, curls, spread)).toBe(true);
          for (const [index, row] of driver.bridgeOutput.clearances.entries()) {
            expect(row.valid).toBe(clearances[index].valid);
            if (row.valid) expect(row.distance).toBeCloseTo(clearances[index].distance, 10);
          }
        }
      }
      const commit = Reflect.get(h.rig, 'commitArmTransport');
      expect(typeof commit).toBe('function');
      expect(Reflect.apply(commit, h.rig, [lift])).toBe(true);
      for (const { side, driver, q, curls, spread, wrist, knuckle } of saved) {
        expect(Array.from(driver.acceptedQ)).toEqual(q);
        expect(driver.acceptedCurls).toEqual(curls);
        expect(driver.acceptedSpread).toEqual(spread);
        const delta = new THREE.Vector3(0, lift, 0);
        expect(driver.acceptedForward.wrist.distanceTo(wrist.clone().add(delta))).toBeLessThan(
          1e-10,
        );
        expect(h.position(`hand.${side}`).distanceTo(driver.acceptedForward.wrist)).toBeLessThan(
          1e-10,
        );
        expect(
          h.rig.lastAcceptedHandPose(side)?.knuckle.distanceTo(knuckle.clone().add(delta)),
        ).toBeLessThan(1e-10);
        expect(h.rig.acceptedArmState(side).curls).toEqual(curls);
      }
      expect(Reflect.apply(commit, h.rig, [lift])).toBe(false);
      // The accepted body snapshot now owns the transported frame as well.
      apply(h.rig, 0, 0);
      for (const { side, wrist } of saved) {
        expect(
          h.position(`hand.${side}`).distanceTo(wrist.clone().add(new THREE.Vector3(0, lift, 0))),
        ).toBeLessThan(1e-10);
      }
      hips.position.y -= lift;
      h.rig.plantLegs(0);
      h.rig.captureProposedBodyContext(0);
      expect(Reflect.apply(commit, h.rig, [0])).toBe(true);
      for (const { side, wrist } of saved)
        expect(h.position(`hand.${side}`).distanceTo(wrist)).toBeLessThan(1e-10);
    },
  );

  it.each(['environment', 'sample', 'rowCount', 'sampleEnvironment'])(
    'rejects transport with a replaced native %s',
    (field) => {
      const h = fixture();
      const hips = h.profile.bones.hips;
      const driver = h.rig.armDriver('L');
      if (!(hips && driver)) throw new Error('missing rig');
      hips.position.y += 0.04;
      h.rig.plantLegs(0.04);
      h.rig.captureProposedBodyContext(0.04);
      if (field === 'environment') Reflect.set(driver, field, { ...driver.environment });
      else if (field === 'sample')
        driver.environment.sample = driver.environment.sample.bind(driver.environment);
      else if (field === 'rowCount')
        Reflect.set(driver.environment, field, driver.environment.rowCount + 1);
      else driver.sampleEnvironment = driver.sampleEnvironment.bind(driver);
      const before = h.position('hips');
      const q = Array.from(driver.acceptedQ);
      const commit = Reflect.get(h.rig, 'commitArmTransport');
      expect(typeof commit).toBe('function');
      expect(Reflect.apply(commit, h.rig, [0.04])).toBe(false);
      expect(h.position('hips').distanceTo(before)).toBe(0);
      expect(Array.from(driver.acceptedQ)).toEqual(q);
    },
  );

  it.each(['detached head', 'finger below leg', 'failed leg solve'])(
    'rejects signed transport with %s before accepted history changes',
    (problem) => {
      const h = fixture();
      const hips = h.profile.bones.hips;
      const driver = h.rig.armDriver('L');
      if (!(hips && driver)) throw new Error('missing rig');
      const q = Array.from(driver.acceptedQ);
      const wrist = driver.acceptedForward.wrist.clone();
      hips.position.y += 0.03;
      h.rig.plantLegs(0.03);
      h.rig.captureProposedBodyContext(0.03);
      if (problem === 'detached head') {
        const head = h.profile.bones.head;
        if (!head) throw new Error('missing head');
        h.profile.root.attach(head);
      } else if (problem === 'finger below leg') {
        const finger = h.profile.fingerBones['middle.L']?.[0];
        const foot = h.profile.bones['foot.L'];
        if (!(finger && foot)) throw new Error('missing finger or foot');
        foot.attach(finger);
      } else {
        const thigh = h.profile.bones['upperLeg.L'];
        if (!thigh) throw new Error('missing thigh');
        // The lateral offset exceeds the leg's reach at every possible pelvis
        // height. This exercises the real supported solver's failure result.
        thigh.position.x += 10;
      }
      const commit = Reflect.get(h.rig, 'commitArmTransport');
      expect(Reflect.apply(commit, h.rig, [0.03])).toBe(false);
      expect(Array.from(driver.acceptedQ)).toEqual(q);
      expect(driver.acceptedForward.wrist.distanceTo(wrist)).toBe(0);
    },
  );

  it('reconstructs the same pre-plant candidate after repeated capture and retries', () => {
    const h = fixture();
    const hips = h.profile.bones.hips;
    if (!hips) throw new Error('missing hips');
    hips.position.x += 0.03;
    hips.position.y -= 0.03;
    h.rig.plantLegs(0);
    h.rig.captureProposedBodyContext(0);
    apply(h.rig, 1, 1);
    const expected = h.position('hips');
    for (let repeat = 0; repeat < 5; repeat++) {
      h.rig.captureProposedBodyContext(0);
      apply(h.rig, 0.5, 1);
      apply(h.rig, 1, 1);
      expect(h.position('hips').distanceTo(expected)).toBeLessThan(1e-12);
    }
  });
});

it('returns to the resting knee bend at the end of a normally played hop at 30 fps', () => {
  const errors: number[] = [];
  for (const spec of Object.values(HOPS)) {
    const h = fixture();
    const dt = 1 / 30;
    const knee = () => {
      const hip = h.position('upperLeg.L');
      const kneePosition = h.position('lowerLeg.L');
      const ankle = h.position('foot.L');
      return kneePosition.sub(hip).angleTo(ankle.sub(h.position('lowerLeg.L')));
    };
    h.step(dt);
    const rest = knee();
    h.body.play('catPaw', 'L');
    h.body.hop(spec);
    const arc = planJump(spec.height, h.body.gravity, spec.count);
    for (let frame = 1; frame <= 120; frame++) {
      h.step(dt);
      if (!sampleJump(arc, frame * dt).done) continue;
      errors.push(Math.abs(knee() - rest));
      break;
    }
  }
  expect(errors).toHaveLength(Object.keys(HOPS).length);
  expect(Math.max(...errors)).toBeLessThan(1e-7);
});
