import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Body } from '@/engine/motion/body';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { ArmTwists } from '@/engine/rig/arm-twists';
import type { ArmFrameSideCommit } from '@/engine/rig/rig';
import type { ArmSlot, Profile, Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

const dirs = (side: Side): Record<ArmSlot, [number, number, number]> => {
  const sign = side === 'L' ? -1 : 1;
  return {
    shoulder: [sign, 0, 0],
    upperArm: [sign, 0, 0],
    lowerArm: [sign, 0, 0],
    hand: [sign, 0, 0],
  };
};
type NoHelperMetadata = 'absent' | 'empty' | 'unsupported';

function fixture(helpers = true, scale = 1, enabled = true, metadata?: NoHelperMetadata) {
  const built = buildRig({ armTwistHelpers: helpers ? 'twist' : undefined, armatureScale: scale });
  const profile = buildProfile(built.root, built.descriptor);
  if (!enabled || metadata === 'absent') delete profile.armTwists;
  if (metadata === 'empty') profile.armTwists = {};
  if (metadata === 'unsupported') {
    const primary = profile.bones['upperArm.L'];
    const next = profile.bones['lowerArm.L'];
    const helper = profile.bones['eye.L'];
    if (!(primary && next && helper)) throw new Error('missing unsupported binding fixture');
    profile.armTwists = { 'upperArm.L': { primary, next, helper } };
  }
  return { profile, rig: new Rig(profile) };
}
function canonical(profile: Profile, rig: Rig) {
  profile.root.updateMatrixWorld(true);
  const bones = [...Object.values(profile.bones), ...Object.values(profile.fingerBones).flat()];
  return {
    bones: bones.map((b) => [
      b.position.toArray(),
      b.quaternion.toArray(),
      b.scale.toArray(),
      b.matrix.elements.slice(),
      b.matrixWorld.elements.slice(),
    ]),
    arms: (['L', 'R'] as const).map((side) => ({
      accepted: structuredClone(rig.acceptedArmState(side)),
      driver: structuredClone(rig.armDriver(side)?.captureAcceptedState()),
      fingerShape: rig.fingerShape(side).map((v) => v.toArray()),
      measure: rig.measure(side),
    })),
    revision: rig.externalArmRevision,
  };
}
function noHelperTrace(scale: number, constrained: boolean, metadata: NoHelperMetadata) {
  const h = fixture(false, scale, true, metadata);
  const frames: unknown[] = [canonical(h.profile, h.rig)];
  h.rig.limitsEnabled = constrained;
  const body = new Body(h.rig, h.profile, { random: () => 0.5 });
  frames.push(canonical(h.profile, h.rig));
  for (let i = 0; i < 3; i++) {
    body.update(1 / 60);
    frames.push(canonical(h.profile, h.rig));
  }
  h.rig.aimArm(
    'R',
    {
      ...dirs('R'),
      upperArm: [0.4, -0.8, 0.4],
      lowerArm: [0.1, -0.4, 0.9],
      hand: [0.1, -0.2, 0.97],
    },
    0.3,
  );
  h.rig.curlHand('R', { index: 0.4, middle: 0.6 }, { index: 0.2 });
  frames.push(canonical(h.profile, h.rig));
  if (constrained) h.rig.aimArm('R', { ...dirs('R'), upperArm: [Number.NaN, 0, 0] });
  frames.push(canonical(h.profile, h.rig));
  const driver = h.rig.armDriver('R');
  if (driver) {
    frames.push(h.rig.stageArmForward('R', driver.acceptedForward, {}, {}));
    frames.push(canonical(h.profile, h.rig));
  }
  const hips = h.profile.bones.hips;
  if (constrained && hips) {
    hips.position.y += 0.02 / scale;
    h.rig.plantLegs(0.02);
    h.rig.captureProposedBodyContext(0.02);
    frames.push(h.rig.commitArmTransport(0.02));
    frames.push(canonical(h.profile, h.rig));
  }
  h.rig.reset();
  frames.push(canonical(h.profile, h.rig));
  h.rig.limitsEnabled = false;
  h.rig.aimArmLegacy('L', dirs('L'), 0.4);
  h.rig.curlHandLegacy('L', { middle: 0.6 });
  h.rig.finishLegacyBodyFrame(0);
  frames.push(canonical(h.profile, h.rig));
  h.rig.limitsEnabled = true;
  frames.push(canonical(h.profile, h.rig));
  return frames;
}

afterEach(() => vi.restoreAllMocks());

describe('arm twist lifecycle integration', () => {
  it.each([
    [1, false],
    [1, true],
    [0.01, false],
    [0.01, true],
  ] as const)(
    'preserves exact no-helper traces across metadata states at scale %s, constrained=%s',
    (scale, constrained) => {
      const absent = noHelperTrace(scale, constrained, 'absent');
      expect(noHelperTrace(scale, constrained, 'empty')).toEqual(absent);
      expect(noHelperTrace(scale, constrained, 'unsupported')).toEqual(absent);
    },
  );

  it.each(['L', 'R'] as const)('stages actual legacy roll after the final wrist on %s', (side) => {
    const h = fixture();
    h.rig.limitsEnabled = false;
    const upper = h.profile.armTwists?.[`upperArm.${side}`];
    const lower = h.profile.armTwists?.[`lowerArm.${side}`];
    if (!(upper && lower)) throw new Error('missing bindings');
    const upperRest = upper.helper.quaternion.clone();
    const lowerRest = lower.helper.quaternion.clone();
    const angle = THREE.MathUtils.degToRad(80);
    const axis = h.profile.restDir[`lowerArm.${side}`];
    const palm = h.rig.palmLocal[side]?.clone().applyAxisAngle(axis, angle);
    if (!palm) throw new Error('missing palm');
    h.rig.aimArmLegacy(side, dirs(side), 0, palm.toArray());
    const expectedUpper = new THREE.Quaternion()
      .setFromAxisAngle(axis, angle * 0.3)
      .multiply(upperRest);
    const expectedLower = new THREE.Quaternion()
      .setFromAxisAngle(axis, angle * 0.2)
      .multiply(lowerRest);
    expect(upper.helper.quaternion.angleTo(expectedUpper)).toBeLessThan(1e-7);
    expect(lower.helper.quaternion.angleTo(expectedLower)).toBeLessThan(1e-7);
    const main = lower.primary.quaternion;
    expect(main.angleTo(new THREE.Quaternion().setFromAxisAngle(axis, angle * 0.6))).toBeLessThan(
      1e-7,
    );
    h.rig.finishLegacyBodyFrame(0);
    h.rig.reset();
    expect(upper.helper.quaternion.toArray()).toEqual(upperRest.toArray());
    expect(lower.helper.quaternion.toArray()).toEqual(lowerRest.toArray());
  });

  it.each([false, true])(
    'keeps primary/finger transforms and FK identical with constrained=%s',
    (constrained) => {
      const actual = fixture(true, 1, true);
      const control = fixture(true, 1, false);
      const bodies = [actual, control].map((h) => {
        h.rig.limitsEnabled = constrained;
        return new Body(h.rig, h.profile, { random: () => 0.5 });
      });
      for (let frame = 0; frame < 3; frame++) {
        for (const body of bodies) body.update(1 / 60);
        expect(canonical(actual.profile, actual.rig)).toEqual(
          canonical(control.profile, control.rig),
        );
      }
      for (const h of [actual, control]) {
        h.rig.aimArm('R', { ...dirs('R'), lowerArm: [0.8, -0.2, 0.4], hand: [0.6, 0.1, 0.7] }, 0.8);
        h.rig.curlHand('R', { index: 0.8, little: 0.2 });
      }
      expect(canonical(actual.profile, actual.rig)).toEqual(
        canonical(control.profile, control.rig),
      );
    },
  );
  it('accepts bootstrap/static/paired success but never accepts staging or rejected static requests', () => {
    const h = fixture();
    const accept = vi.spyOn(ArmTwists.prototype, 'accept');
    new Body(h.rig, h.profile, { random: () => 0.5 });
    expect(accept.mock.calls).toEqual([['L'], ['R']]);
    accept.mockClear();
    const driver = h.rig.armDriver('R');
    if (!driver) throw new Error('missing driver');
    expect(h.rig.stageArmForward('R', driver.acceptedForward, {}, {})).toBe(true);
    expect(accept).not.toHaveBeenCalled();
    h.rig.aimArm('R', { ...dirs('R'), upperArm: [Number.NaN, 0, 0] });
    expect(accept).not.toHaveBeenCalled();
    h.rig.curlHand('R', { index: 0.2 });
    expect(accept.mock.calls).toEqual([['R']]);
    accept.mockClear();
    const plans: Partial<Record<Side, ArmFrameSideCommit>> = {};
    for (const side of ['L', 'R'] as const) {
      const d = h.rig.armDriver(side);
      const context = h.rig.armForwardContext(side);
      if (!(d && context)) throw new Error('missing context');
      plans[side] = {
        output: { ...d.output, q: d.acceptedQ, forward: d.acceptedForward },
        context,
        curls: d.acceptedCurls,
        spread: d.acceptedSpread,
      };
    }
    const left = plans.L;
    const right = plans.R;
    if (!(left && right)) throw new Error('missing plans');
    expect(h.rig.commitArmFrame({ L: left, R: right }, 0)).toBe(true);
    expect(accept.mock.calls).toEqual([['L'], ['R']]);
    accept.mockClear();
    delete h.profile.bones['hand.R'];
    expect(h.rig.commitArmFrame({ L: left, R: right }, 0)).toBe(false);
    expect(accept).not.toHaveBeenCalled();
  });

  it('does not accept failed bootstrap or limit re-entry preflight', () => {
    const h = fixture();
    const accept = vi.spyOn(ArmTwists.prototype, 'accept');
    if (!h.profile.limb) throw new Error('missing limb');
    h.profile.limb['upper.R'] = 0;
    new Body(h.rig, h.profile);
    expect(accept).not.toHaveBeenCalled();
    h.rig.limitsEnabled = false;
    expect(() => {
      h.rig.limitsEnabled = true;
    }).toThrow();
    expect(accept).not.toHaveBeenCalled();
    // A completed legacy frame is accepted even if constrained re-seeding cannot succeed.
    h.rig.finishLegacyBodyFrame(0);
    expect(accept.mock.calls).toEqual([['L'], ['R']]);
  });

  it.each([0.02, -0.02])('stages signed transport %s without accepting helper history', (lift) => {
    const h = fixture();
    new Body(h.rig, h.profile, { random: () => 0.5 });
    const accept = vi.spyOn(ArmTwists.prototype, 'accept');
    const stage = vi.spyOn(ArmTwists.prototype, 'stage');
    const binding = h.profile.armTwists?.['lowerArm.R'];
    const hips = h.profile.bones.hips;
    const driver = h.rig.armDriver('R');
    if (!(binding && hips && driver)) throw new Error('missing transport fixture');
    const before = binding.helper.getWorldPosition(new THREE.Vector3());
    const q = Array.from(driver.acceptedQ);
    hips.position.y += lift;
    h.rig.plantLegs(lift);
    h.rig.captureProposedBodyContext(lift);
    expect(h.rig.commitArmTransport(lift)).toBe(true);
    expect(accept).not.toHaveBeenCalled();
    expect(stage.mock.calls).toEqual([['L'], ['R']]);
    expect(Array.from(driver.acceptedQ)).toEqual(q);
    const after = binding.helper.getWorldPosition(new THREE.Vector3());
    expect(after.distanceTo(before.add(new THREE.Vector3(0, lift, 0)))).toBeLessThan(1e-10);
    stage.mockClear();
    expect(h.rig.commitArmTransport(lift)).toBe(false);
    expect(stage).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it('stages finger clearance and accepts external legacy writes before capture can fail', () => {
    const h = fixture();
    h.rig.limitsEnabled = false;
    const stage = vi.spyOn(ArmTwists.prototype, 'stage');
    const accept = vi.spyOn(ArmTwists.prototype, 'accept');
    h.rig.curlHandLegacy('R', { index: 0.9 });
    expect(stage.mock.calls).toEqual([['R']]);
    expect(accept).not.toHaveBeenCalled();
    delete h.profile.bones['upperArm.R'];
    h.rig.curlHand('R', { index: 0.5 });
    expect(accept.mock.calls).toEqual([['R']]);
    accept.mockClear();
    h.rig.finishLegacyBodyFrame(0);
    expect(accept.mock.calls).toEqual([['L'], ['R']]);
  });
  it('updates the helper after real face clearance rotates the legacy wrist', () => {
    const h = fixture();
    h.rig.limitsEnabled = false;
    const body = new Body(h.rig, h.profile, { random: () => 0.5 });
    const binding = h.profile.armTwists?.['lowerArm.R'];
    if (!binding) throw new Error('missing helper');
    const rest = binding.helper.quaternion.clone();
    const axis = h.profile.restDir['lowerArm.R'];
    const original = h.rig.curlHandLegacy.bind(h.rig);
    let corrected = 0;
    vi.spyOn(h.rig, 'curlHandLegacy').mockImplementation((side, curls, spread) => {
      const before = binding.next.quaternion.clone();
      original(side, curls, spread);
      if (side !== 'R' || before.angleTo(binding.next.quaternion) < 1e-7) return;
      corrected++;
      const q = binding.next.quaternion;
      const residual = 2 * Math.atan2(q.x * axis.x + q.y * axis.y + q.z * axis.z, q.w);
      const expected = new THREE.Quaternion().setFromAxisAngle(axis, residual / 2).multiply(rest);
      expect(binding.helper.quaternion.angleTo(expected)).toBeLessThan(1e-7);
    });
    body.play('cover', 'R');
    for (let frame = 0; frame < 90; frame++) {
      h.rig.reset();
      body.update(1 / 60);
    }
    expect(corrected).toBeGreaterThan(0);
  });
});
