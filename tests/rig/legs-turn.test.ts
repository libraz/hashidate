import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { BoneSlot, Profile, Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

const SIDES = ['L', 'R'] as const;
const TURNS = [Math.PI / 2, Math.PI, -Math.PI / 2];
const UP = new THREE.Vector3(0, 1, 0);
const LEG_SLOTS: readonly BoneSlot[] = [
  'hips',
  'upperLeg.L',
  'lowerLeg.L',
  'foot.L',
  'upperLeg.R',
  'lowerLeg.R',
  'foot.R',
];

function bone(profile: Profile, slot: BoneSlot): THREE.Bone {
  const value = profile.bones[slot];
  if (!value) throw new Error(`synthetic rig has no ${slot}`);
  return value;
}

function world(profile: Profile, slot: BoneSlot): THREE.Vector3 {
  profile.root.updateMatrixWorld(true);
  return bone(profile, slot).getWorldPosition(new THREE.Vector3());
}

function worldQ(profile: Profile, slot: BoneSlot): THREE.Quaternion {
  profile.root.updateMatrixWorld(true);
  return bone(profile, slot).getWorldQuaternion(new THREE.Quaternion());
}

function setup(armatureScale = 1, rebase = false) {
  const built = buildRig({ legs: true, armatureScale });
  if (rebase) {
    const rest = new Map<THREE.Bone, THREE.Matrix4>();
    for (const b of built.bones.values()) rest.set(b, b.matrixWorld.clone());
    built.root.rotation.z = Math.PI / 2;
    built.root.updateMatrixWorld(true);
    const depth = (b: THREE.Object3D) => {
      let n = 0;
      for (let o: THREE.Object3D | null = b; o?.parent; o = o.parent) n++;
      return n;
    };
    for (const b of [...built.bones.values()].sort((x, y) => depth(x) - depth(y))) {
      const m = rest.get(b);
      if (!(b.parent && m)) continue;
      b.parent.matrixWorld
        .clone()
        .invert()
        .multiply(m)
        .decompose(b.position, b.quaternion, b.scale);
      b.updateMatrixWorld(true);
    }
    built.root.updateMatrixWorld(true);
  }
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  return { profile, rig };
}

/** `point` turned by `turn` about the world-up line through `pivot`. */
function turned(point: THREE.Vector3, pivot: THREE.Vector3, turn: number): THREE.Vector3 {
  const offset = point.clone().sub(pivot).applyAxisAngle(UP, turn);
  return pivot.clone().add(offset);
}

function kneeBend(profile: Profile, side: Side): number {
  const hip = world(profile, `upperLeg.${side}`);
  const knee = world(profile, `lowerLeg.${side}`);
  const ankle = world(profile, `foot.${side}`);
  return knee.clone().sub(hip).angleTo(ankle.sub(knee));
}

function dump(profile: Profile): number[] {
  return LEG_SLOTS.flatMap((slot) => [
    ...world(profile, slot).toArray(),
    ...bone(profile, slot).quaternion.toArray(),
    ...bone(profile, slot).position.toArray(),
  ]);
}

const PARENTS = [
  { label: 'a plain armature', scale: 1, rebase: false },
  { label: 'a centimetre armature', scale: 0.01, rebase: false },
  { label: 'a rebased, turned parent', scale: 1, rebase: true },
];

describe.each(PARENTS)('plantLegs with a turn under $label', ({ scale, rebase }) => {
  it.each(TURNS)('lands the rest pose rotated by %f about the stance centre', (turn) => {
    const { profile, rig } = setup(scale, rebase);
    const rest = LEG_SLOTS.map((slot) => world(profile, slot));
    const restQ = LEG_SLOTS.map((slot) => worldQ(profile, slot));
    const bend = SIDES.map((side) => kneeBend(profile, side));
    const pivot = world(profile, 'foot.L').add(world(profile, 'foot.R')).multiplyScalar(0.5);

    rig.plantLegs(0, turn);

    const yaw = new THREE.Quaternion().setFromAxisAngle(UP, turn);
    LEG_SLOTS.forEach((slot, i) => {
      const expected = turned(rest[i], pivot, turn);
      expect(world(profile, slot).distanceTo(expected)).toBeLessThan(1e-9);
      const expectedQ = yaw.clone().multiply(restQ[i]);
      expect(worldQ(profile, slot).angleTo(expectedQ)).toBeLessThan(1e-7);
    });
    SIDES.forEach((side, i) => {
      expect(kneeBend(profile, side)).toBeCloseTo(bend[i], 9);
    });
  });

  it('keeps the feet where a plain plant puts them when the turn is zero', () => {
    const a = setup(scale, rebase);
    const b = setup(scale, rebase);
    a.rig.plantLegs(0.03);
    b.rig.plantLegs(0.03, 0);
    expect(dump(b.profile)).toEqual(dump(a.profile));
  });

  it('plants the same feet at a height whatever the turn', () => {
    const { profile, rig } = setup(scale, rebase);
    const pivot = world(profile, 'foot.L').add(world(profile, 'foot.R')).multiplyScalar(0.5);
    const rest = SIDES.map((side) => world(profile, `foot.${side}`));
    rig.plantLegs(0.04, Math.PI / 2);
    SIDES.forEach((side, i) => {
      const expected = turned(rest[i], pivot, Math.PI / 2).add(UP.clone().multiplyScalar(0.04));
      expect(world(profile, `foot.${side}`).distanceTo(expected)).toBeLessThan(1e-9);
    });
  });
});

describe('a turn is rebuilt from the snapshot, never stacked on itself', () => {
  it('re-applies the proposed turn to the pre-turn pelvis', () => {
    const { profile, rig } = setup();
    const turn = Math.PI / 2;
    rig.captureProposedBodyContext(0, turn);
    rig.applyBodyContext(1, 1);
    const once = worldQ(profile, 'hips').clone();
    // The commit captures again once the pelvis is already turned.
    rig.captureProposedBodyContext(0, turn);
    rig.applyBodyContext(1, 1);
    expect(worldQ(profile, 'hips').angleTo(once)).toBeLessThan(1e-9);
  });
});

describe('a turn without standing legs', () => {
  it.each([false, true])('yaws the hips about their own vertical (rebased %s)', (rebase) => {
    const built = buildRig({ legs: false });
    if (rebase) built.root.rotation.z = Math.PI / 2;
    built.root.updateMatrixWorld(true);
    const profile = buildProfile(built.root, built.descriptor);
    const rig = new Rig(profile);
    const before = world(profile, 'hips');
    const beforeQ = worldQ(profile, 'hips');
    rig.plantLegs(0, Math.PI / 2);
    expect(world(profile, 'hips').distanceTo(before)).toBeLessThan(1e-9);
    const expected = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2).multiply(beforeQ);
    expect(worldQ(profile, 'hips').angleTo(expected)).toBeLessThan(1e-7);
  });
});
