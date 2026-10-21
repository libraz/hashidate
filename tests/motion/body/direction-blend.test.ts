import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Body } from '@/engine/motion/body';
import { BASE_PALM } from '@/engine/motion/gestures';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { ArmSlot, GestureDef } from '@/engine/types';
import { buildRig } from '../../helpers/scene';

type Arms = Record<ArmSlot, THREE.Vector3>;
interface Observation {
  _rest: Arms;
  _fading: unknown[];
  _armBlend: Record<'L' | 'R', Arms>;
  _armEnv: Record<ArmSlot, { entrance: number; exit: number }>;
  _palm: Record<
    'L' | 'R',
    { step(target: THREE.Vector3, dt: number, rate: number): THREE.Vector3 }
  >;
}

function fixture() {
  const scene = buildRig();
  const profile = buildProfile(scene.root, scene.descriptor);
  const rig = new Rig(profile);
  rig.limitsEnabled = false;
  const body = new Body(rig, profile, { random: () => 0.5 });
  body.breathDepth = 0;
  body.idleAmount = 0;
  body.weightShift = 0;
  body.gazeAmount = 0;
  body.lookAt = 0;
  const observed = body as unknown as Observation;
  const palm = new THREE.Vector3();
  const follower = observed._palm.R;
  const original = follower.step;
  follower.step = function (target, dt, rate) {
    palm.copy(target);
    return original.call(this, target, dt, rate);
  };
  const hand = profile.bones['hand.R'];
  if (!hand) throw new Error('missing hand');
  const restHand = hand.getWorldPosition(new THREE.Vector3());
  return {
    body,
    rig,
    observed,
    palm,
    hand,
    restHand,
    step() {
      rig.reset();
      body.update(1 / 60);
    },
  };
}

/** Independent rotation oracle; fixtures stay away from the ambiguous opposed case. */
function arc(from: THREE.Vector3, to: THREE.Vector3, share: number) {
  const axis = new THREE.Vector3().crossVectors(from, to).normalize();
  return from
    .clone()
    .applyAxisAngle(axis, Math.acos(THREE.MathUtils.clamp(from.dot(to), -1, 1)) * share);
}
const definition = (
  upperArm: THREE.Vector3,
  lowerArm: THREE.Vector3,
  hand: THREE.Vector3,
  palm: THREE.Vector3,
): GestureDef => ({
  label: { en: 'Wide directions', ja: '広い向き' },
  group: 'pose',
  lead: 1,
  hold: 2,
  sustain: true,
  build: () => ({ arms: { R: { upperArm, lowerArm, hand, palm } } }),
});

function targets(rest: Arms, magnitude = 1) {
  const axis = new THREE.Vector3()
    .crossVectors(rest.upperArm, new THREE.Vector3(0, 0, 1))
    .normalize();
  const upper = rest.upperArm.clone().applyAxisAngle(axis, (140 * Math.PI) / 180);
  const lower = rest.lowerArm.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
  const hand = rest.hand
    .clone()
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.6)
    .multiplyScalar(magnitude);
  const palmAxis = new THREE.Vector3()
    .crossVectors(BASE_PALM, new THREE.Vector3(0, 1, 0))
    .normalize();
  const palm = BASE_PALM.clone()
    .applyAxisAngle(palmAxis, (140 * Math.PI) / 180)
    .multiplyScalar(magnitude);
  return { upper, lower, hand, palm };
}

describe('Body direction blending', () => {
  it('composes wide arm and palm entrances along their angular share', () => {
    const h = fixture();
    const t = targets(h.observed._rest);
    h.body.playDef(definition(t.upper, t.lower, t.hand, t.palm), 'wide');
    let checked = 0;
    let largestArmError = 0;
    let largestPalmError = 0;
    for (let frame = 0; frame < 50; frame++) {
      h.step();
      const upper = h.observed._armEnv.upperArm;
      const hand = h.observed._armEnv.hand;
      const armShare = upper.entrance * upper.exit;
      const palmShare = hand.entrance * hand.exit;
      if (armShare > 0.1 && armShare < 0.9 && palmShare > 0.1 && palmShare < 0.9) {
        checked++;
        largestArmError = Math.max(
          largestArmError,
          h.observed._armBlend.R.upperArm.distanceTo(
            arc(h.observed._rest.upperArm, t.upper, armShare),
          ),
        );
        largestPalmError = Math.max(
          largestPalmError,
          h.palm.distanceTo(arc(BASE_PALM, t.palm, palmShare)),
        );
      }
    }
    expect(checked).toBeGreaterThan(5);
    expect(h.hand.getWorldPosition(new THREE.Vector3()).distanceTo(h.restHand)).toBeGreaterThan(
      0.01,
    );
    expect(largestArmError).toBeLessThan(1e-10);
    expect(largestPalmError).toBeLessThan(1e-10);
  });

  it('ignores positive direction magnitudes while carrying the hand with its rotated parent', () => {
    const unit = fixture();
    const scaled = fixture();
    for (const [h, magnitude] of [
      [unit, 1],
      [scaled, 4],
    ] as const) {
      const t = targets(h.observed._rest, magnitude);
      h.body.playDef(definition(t.upper, t.lower, t.hand, t.palm), 'scaled');
    }
    let largestHandError = 0;
    let largestPalmError = 0;
    let parentRotation = 0;
    for (let frame = 0; frame < 50; frame++) {
      unit.step();
      scaled.step();
      largestHandError = Math.max(
        largestHandError,
        unit.observed._armBlend.R.hand.distanceTo(scaled.observed._armBlend.R.hand),
      );
      largestPalmError = Math.max(largestPalmError, unit.palm.distanceTo(scaled.palm));
      parentRotation = Math.max(
        parentRotation,
        unit.observed._armBlend.R.lowerArm.angleTo(unit.observed._rest.lowerArm),
      );
    }
    expect(parentRotation).toBeGreaterThan(0.2);
    expect(
      unit.hand.getWorldPosition(new THREE.Vector3()).distanceTo(unit.restHand),
    ).toBeGreaterThan(0.01);
    expect(largestHandError).toBeLessThan(1e-10);
    expect(largestPalmError).toBeLessThan(1e-10);
  });

  it('keeps scaled parent directions equivalent through incoming and outgoing handoff carry', () => {
    const unit = fixture();
    const scaled = fixture();
    const authored: Array<{ vectors: THREE.Vector3[]; before: number[][] }> = [];
    const play = (turn: number) => {
      for (const [h, magnitude] of [
        [unit, 1],
        [scaled, 4],
      ] as const) {
        const t = targets(h.observed._rest, magnitude);
        t.upper.multiplyScalar(magnitude);
        t.lower.multiplyScalar(magnitude);
        const vectors = [t.upper, t.lower, t.hand, t.palm];
        for (const vector of vectors) vector.applyAxisAngle(new THREE.Vector3(0, 1, 0), turn);
        authored.push({ vectors, before: vectors.map((vector) => vector.toArray()) });
        h.body.playDef(definition(t.upper, t.lower, t.hand, t.palm), `parent.${turn}`);
      }
    };
    const error = [0, 0];
    let outgoingFrames = 0;
    play(0);
    for (let phase = 0; phase < 2; phase++) {
      if (phase === 1) play(0.4);
      for (let frame = 0; frame < 40; frame++) {
        unit.step();
        scaled.step();
        if (phase === 1 && unit.observed._fading.length > 0 && scaled.observed._fading.length > 0)
          outgoingFrames++;
        for (const slot of ['upperArm', 'lowerArm', 'hand'] as const) {
          error[phase] = Math.max(
            error[phase],
            unit.observed._armBlend.R[slot].distanceTo(scaled.observed._armBlend.R[slot]),
          );
        }
      }
    }
    expect(outgoingFrames).toBeGreaterThan(5);
    expect(
      unit.hand.getWorldPosition(new THREE.Vector3()).distanceTo(unit.restHand),
    ).toBeGreaterThan(0.01);
    for (const input of authored)
      expect(input.vectors.map((vector) => vector.toArray())).toEqual(input.before);
    expect(error[0], 'incoming parent carry').toBeLessThan(1e-10);
    expect(error[1], 'outgoing parent carry').toBeLessThan(1e-10);
  });
});
