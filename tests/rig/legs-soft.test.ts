import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { BoneSlot, Profile } from '@/engine/types';
import { buildRig } from '../helpers/scene';

const SIDES = ['L', 'R'] as const;
const SLOTS: readonly BoneSlot[] = [
  'hips',
  'upperLeg.L',
  'lowerLeg.L',
  'foot.L',
  'upperLeg.R',
  'lowerLeg.R',
  'foot.R',
];
const ROUND_OFF = 1e-10;

function bone(profile: Profile, slot: BoneSlot): THREE.Bone {
  const value = profile.bones[slot];
  if (!value) throw new Error(`synthetic rig has no ${slot}`);
  return value;
}

function position(profile: Profile, slot: BoneSlot): THREE.Vector3 {
  return bone(profile, slot).getWorldPosition(new THREE.Vector3());
}

function setup() {
  const built = buildRig({ legs: true });
  const profile = buildProfile(built.root, built.descriptor);
  const hips = bone(profile, 'hips');
  const anchors = SIDES.map((side) => position(profile, `foot.${side}`));
  const upper = position(profile, 'upperLeg.L').distanceTo(position(profile, 'lowerLeg.L'));
  const lower = position(profile, 'lowerLeg.L').distanceTo(anchors[0]);
  const span = position(profile, 'upperLeg.L').distanceTo(anchors[0]);
  return { profile, hips, anchors, upper, lower, span };
}

function snapshot(profile: Profile): number[] {
  return SLOTS.flatMap((slot) => [
    ...position(profile, slot).toArray(),
    ...bone(profile, slot).quaternion.toArray(),
  ]);
}

function expectSame(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(Math.abs(value - expected[index])).toBeLessThan(ROUND_OFF);
  });
}

function expectAnchors(h: ReturnType<typeof setup>): void {
  SIDES.forEach((side, index) => {
    expect(position(h.profile, `foot.${side}`).distanceTo(h.anchors[index])).toBeLessThan(
      ROUND_OFF,
    );
  });
}

describe('GroundedLegs rest-preserving soft reach', () => {
  it('reconstructs uncorrected Rig contexts through alpha-zero and repeated retries without drift', () => {
    const h = setup();
    const rig = new Rig(h.profile);
    const rest = snapshot(h.profile);
    const gap = h.upper + h.lower - h.span;
    h.hips.position.y += gap * 0.5;
    const raw = h.hips.position.clone();
    rig.plantLegs(0);
    expect(raw.y - h.hips.position.y).toBeGreaterThan(gap * 0.05);
    rig.captureProposedBodyContext(0);
    rig.applyBodyContext(1);
    const expected = snapshot(h.profile);
    for (let repeat = 0; repeat < 6; repeat++) {
      rig.captureProposedBodyContext(0);
      rig.applyBodyContext(0);
      expectSame(snapshot(h.profile), rest);
      rig.applyBodyContext(0.5);
      rig.applyBodyContext(1);
      expectSame(snapshot(h.profile), expected);
      expectAnchors(h);
    }
  });
});
