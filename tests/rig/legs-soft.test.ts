import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { GroundedLegs } from '@/engine/rig/legs';
import type { BoneSlot, Profile, Side } from '@/engine/types';
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

function setup(scale = 1, straight = false) {
  const built = buildRig({ legs: true, armatureScale: scale });
  if (straight) {
    for (const side of SIDES) {
      const lower = built.bones.get(`LowerLeg_${side}`);
      const foot = built.bones.get(`Foot_${side}`);
      if (!(lower && foot)) throw new Error('missing synthetic leg');
      lower.position.z = 0;
      foot.position.z = 0;
    }
  }
  const profile = buildProfile(built.root, built.descriptor);
  const solver = GroundedLegs.create(profile, (value) => value.quaternion.clone());
  if (!solver) throw new Error('synthetic standing legs were not accepted');
  const hips = bone(profile, 'hips');
  const rest = hips.position.clone();
  const anchors = SIDES.map((side) => position(profile, `foot.${side}`));
  const upper = position(profile, 'upperLeg.L').distanceTo(position(profile, 'lowerLeg.L'));
  const lower = position(profile, 'lowerLeg.L').distanceTo(anchors[0]);
  const span = position(profile, 'upperLeg.L').distanceTo(anchors[0]);
  return { root: built.root, profile, solver, hips, rest, anchors, upper, lower, span, scale };
}

function angle(profile: Profile, side: Side): number {
  const hip = position(profile, `upperLeg.${side}`);
  const knee = position(profile, `lowerLeg.${side}`);
  const ankle = position(profile, `foot.${side}`);
  return knee.clone().sub(hip).angleTo(ankle.sub(knee));
}

function hardBend(upper: number, lower: number, distance: number): number {
  const reach = Math.min(distance, upper + lower);
  return (
    Math.PI -
    Math.acos(
      THREE.MathUtils.clamp(
        (upper * upper + lower * lower - reach * reach) / (2 * upper * lower),
        -1,
        1,
      ),
    )
  );
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
  it.each([1, 0.01])(
    'keeps the captured quiet rest fixed on first and repeated solves at scale %s',
    (scale) => {
      const h = setup(scale);
      const before = snapshot(h.profile);
      for (let repeat = 0; repeat < 6; repeat++) {
        expect(h.solver.apply(0)).toBe(true);
        expectSame(snapshot(h.profile), before);
        expect(h.hips.position.toArray()).toEqual(h.rest.toArray());
      }
    },
  );

  it.each([1, 0.01])(
    'bounds knee rate by the rest derivative while retaining both anchors at scale %s',
    (scale) => {
      const h = setup(scale);
      const maximum = h.upper + h.lower;
      const zone = Math.min(0.01 * maximum, maximum - h.span);
      const start = maximum - zone;
      // At the join the soft derivative equals the ordinary two-link derivative.
      // Its soft-branch value decreases as reach approaches full extension.
      const bound =
        (2 * start) /
        Math.sqrt((maximum * maximum - start * start) * (start * start - (h.upper - h.lower) ** 2));
      const step = zone / 20;
      let previous: number | undefined;
      let previousHard: number | undefined;
      let peak = 0;
      let hardPeak = 0;
      let correction = 0;
      for (let sample = -20; sample <= 80; sample++) {
        const offset = sample * step;
        h.hips.position.copy(h.rest);
        h.hips.position.y += offset / scale;
        h.root.updateMatrixWorld(true);
        const rawSpan = position(h.profile, 'upperLeg.L').distanceTo(h.anchors[0]);
        const rawY = h.hips.position.y;
        expect(h.solver.apply(0)).toBe(true);
        correction = Math.max(correction, (rawY - h.hips.position.y) * scale);
        expectAnchors(h);
        const current = angle(h.profile, 'L');
        const hard = hardBend(h.upper, h.lower, rawSpan);
        if (previous !== undefined && previousHard !== undefined) {
          peak = Math.max(peak, Math.abs(current - previous) / step);
          hardPeak = Math.max(hardPeak, Math.abs(hard - previousHard) / step);
        }
        previous = current;
        previousHard = hard;
      }
      expect(correction).toBeGreaterThan(zone);
      expect(peak).toBeLessThanOrEqual(bound + 1e-6);
      expect(hardPeak).toBeGreaterThan(bound * 3);
    },
  );

  it('applies a nonzero soft correction before hard reach and follows root placement', () => {
    const h = setup(0.01);
    const rootAnchors = h.anchors.map((anchor) => h.root.worldToLocal(anchor.clone()));
    h.root.position.set(0.4, -0.2, 0.7);
    h.root.rotation.y = 0.37;
    h.root.updateMatrixWorld(true);
    h.anchors = rootAnchors.map((anchor) => h.root.localToWorld(anchor));
    const gap = h.upper + h.lower - h.span;
    h.hips.position.y += (gap * 0.5) / h.scale;
    const raw = h.hips.position.clone();
    h.root.updateMatrixWorld(true);
    expect(position(h.profile, 'upperLeg.L').distanceTo(h.anchors[0])).toBeLessThan(
      h.upper + h.lower,
    );
    expect(h.solver.apply(0)).toBe(true);
    expect((raw.y - h.hips.position.y) * h.scale).toBeGreaterThan(gap * 0.05);
    expectAnchors(h);
  });

  it('keeps ordinary bent poses bit-identical to the unsoftened solve', () => {
    const solve = () => {
      const h = setup();
      h.hips.position.add(new THREE.Vector3(0.012, -0.035, 0.006));
      h.root.updateMatrixWorld(true);
      const raw = h.hips.position.clone();
      expect(h.solver.apply(0)).toBe(true);
      expect(h.hips.position.toArray()).toEqual(raw.toArray());
      expectAnchors(h);
      for (const side of SIDES) {
        const distance = position(h.profile, `upperLeg.${side}`).distanceTo(
          position(h.profile, `foot.${side}`),
        );
        expect(
          Math.abs(angle(h.profile, side) - hardBend(h.upper, h.lower, distance)),
        ).toBeLessThan(ROUND_OFF);
      }
      return snapshot(h.profile);
    };
    const softened = solve();
    const zone = Reflect.get(GroundedLegs, 'SOFT_REACH');
    Reflect.set(GroundedLegs, 'SOFT_REACH', 0);
    try {
      expect(solve()).toEqual(softened);
    } finally {
      if (zone === undefined) Reflect.deleteProperty(GroundedLegs, 'SOFT_REACH');
      else Reflect.set(GroundedLegs, 'SOFT_REACH', zone);
    }
  });

  it('keeps exactly straight rest finite and fixed with a hard fallback', () => {
    const h = setup(1, true);
    const before = snapshot(h.profile);
    expect(h.solver.apply(0)).toBe(true);
    expectSame(snapshot(h.profile), before);
    h.hips.position.y += 0.01;
    expect(h.solver.apply(0)).toBe(true);
    expect(snapshot(h.profile).every(Number.isFinite)).toBe(true);
    expectAnchors(h);
    expect(h.hips.position.distanceTo(h.rest)).toBeLessThan(ROUND_OFF);
  });

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
