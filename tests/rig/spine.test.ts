import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { type OffsetSlot, SpineOffsets } from '@/engine/rig/spine';
import { buildRig } from '../helpers/scene';

const SLOTS: readonly OffsetSlot[] = ['hips', 'spine', 'chest', 'neck', 'head', 'eye.L', 'eye.R'];

const OFFSETS = [
  { x: 0.17, y: 0, z: 0 },
  { x: 0, y: -0.21, z: 0 },
  { x: 0, y: 0, z: 0.13 },
  { x: 0.11, y: -0.16, z: 0.19 },
];

const REBASE: Record<OffsetSlot, THREE.Quaternion> = {
  hips: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.23, 0, 0, 'XYZ')),
  spine: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -0.19, 0, 'XYZ')),
  chest: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.27, 'XYZ')),
  neck: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.17, -0.12, 0.14, 'XYZ')),
  head: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0.15, -0.11, 'XYZ')),
  'eye.L': new THREE.Quaternion().setFromEuler(new THREE.Euler(0.14, 0.08, -0.18, 'XYZ')),
  'eye.R': new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.16, 0.1, 0.12, 'XYZ')),
};

interface MarkerSet {
  points: THREE.Object3D[];
}

type MarkerPositions = Map<OffsetSlot, THREE.Vector3[]>;

interface SpineCase {
  profile: ReturnType<typeof buildProfile>;
  spine: SpineOffsets;
  rest: Map<THREE.Bone, THREE.Quaternion>;
  markers: Map<OffsetSlot, MarkerSet>;
  restPositions: MarkerPositions;
}

interface RootOptions {
  transformed: boolean;
}

function required<T>(value: T | undefined, what: string): T {
  if (!value) throw new Error(`synthetic rig has no ${what}`);
  return value;
}

function rebase(bone: THREE.Bone, rotation: THREE.Quaternion): void {
  const inverse = rotation.clone().invert();
  bone.quaternion.multiply(rotation);
  for (const child of bone.children) {
    child.position.applyQuaternion(inverse);
    child.quaternion.premultiply(inverse);
  }
}

function snapshot(markers: Map<OffsetSlot, MarkerSet>): MarkerPositions {
  const out = new Map<OffsetSlot, THREE.Vector3[]>();
  for (const [slot, { points }] of markers) {
    out.set(
      slot,
      points.map((point) => point.getWorldPosition(new THREE.Vector3())),
    );
  }
  return out;
}

function makeCase(rebased: boolean, options: RootOptions = { transformed: false }): SpineCase {
  const built = buildRig();
  if (options.transformed) {
    built.root.position.set(0.37, -0.24, 0.19);
    built.root.rotation.set(0.11, -0.29, 0.17, 'XYZ');
    built.root.scale.set(0.8, 1.2, 1.1);
    built.root.updateMatrixWorld(true);
  }
  const profile = buildProfile(built.root, built.descriptor);
  const markers = new Map<OffsetSlot, MarkerSet>();

  for (const slot of SLOTS) {
    const bone = required(profile.bones[slot], slot);
    const first = new THREE.Object3D();
    first.position.set(0.031, 0.017, 0.011);
    const second = new THREE.Object3D();
    second.position.set(-0.014, 0.026, 0.037);
    bone.add(first, second);
    markers.set(slot, { points: [first, second] });
  }

  built.root.updateMatrixWorld(true);
  if (rebased) {
    // Rebase the complete chain in parent order. The head and eyes make the
    // multi-level case observable instead of comparing only an isolated bone.
    for (const slot of SLOTS) rebase(required(profile.bones[slot], slot), REBASE[slot]);
  }
  built.root.updateMatrixWorld(true);

  const rest = new Map<THREE.Bone, THREE.Quaternion>();
  for (const bone of Object.values(profile.bones)) {
    if (bone) rest.set(bone, bone.quaternion.clone());
  }
  return {
    profile,
    spine: new SpineOffsets(profile),
    rest,
    markers,
    restPositions: snapshot(markers),
  };
}

function restore(scene: SpineCase): void {
  for (const [bone, rest] of scene.rest) bone.quaternion.copy(rest);
  scene.profile.root.updateMatrixWorld(true);
}

type OffsetValue = (typeof OFFSETS)[number];

function poseOffsets(scene: SpineCase, offsets: Partial<Record<OffsetSlot, OffsetValue>>) {
  restore(scene);
  scene.spine.clear();
  for (const [slot, offset] of Object.entries(offsets) as [OffsetSlot, OffsetValue][]) {
    scene.spine.add(slot, offset.x, offset.y, offset.z);
  }
  scene.spine.commit(scene.profile, (bone) => required(scene.rest.get(bone), bone.name));
  scene.profile.root.updateMatrixWorld(true);
  return snapshot(scene.markers);
}

function pose(scene: SpineCase, slot: OffsetSlot, offset: OffsetValue) {
  return poseOffsets(scene, { [slot]: offset });
}

function expectSameMarkers(standard: MarkerPositions, rebased: MarkerPositions): void {
  for (const slot of SLOTS) {
    const expected = required(standard.get(slot), 'standard markers');
    const got = required(rebased.get(slot), 'rebased markers');
    for (let i = 0; i < expected.length; i++) {
      const expectedPoint = required(expected[i], 'standard marker');
      const gotPoint = required(got[i], 'rebased marker');
      expect(gotPoint.distanceTo(expectedPoint)).toBeLessThan(1e-9);
    }
  }
}

describe('spine offsets', () => {
  it('keeps every standard slot equal to restLocal * EulerXYZ', () => {
    const scene = makeCase(false);
    for (const slot of SLOTS) {
      const bone = required(scene.profile.bones[slot], slot);
      const rest = required(scene.rest.get(bone), `${slot} rest`);
      for (const offset of OFFSETS) {
        restore(scene);
        scene.spine.clear();
        scene.spine.add(slot, offset.x, offset.y, offset.z);
        scene.spine.commit(scene.profile, (current) =>
          required(scene.rest.get(current), current.name),
        );
        const expected = rest
          .clone()
          .multiply(
            new THREE.Quaternion().setFromEuler(new THREE.Euler(offset.x, offset.y, offset.z)),
          );
        expect(Math.abs(bone.quaternion.dot(expected))).toBeGreaterThan(1 - 1e-12);
      }
    }
  });

  it('preserves marker motion when every controlled bone uses different local axes', () => {
    const standard = makeCase(false);
    const rebased = makeCase(true);

    for (const slot of SLOTS) {
      const before = required(standard.restPositions.get(slot), 'standard rest markers');
      const after = required(rebased.restPositions.get(slot), 'rebased rest markers');
      for (let i = 0; i < before.length; i++) {
        const beforePoint = required(before[i], 'standard rest marker');
        const afterPoint = required(after[i], 'rebased rest marker');
        expect(afterPoint.distanceTo(beforePoint)).toBeLessThan(1e-10);
      }
    }

    for (const slot of SLOTS) {
      for (const offset of OFFSETS) {
        const posed = pose(standard, slot, offset);
        const portable = pose(rebased, slot, offset);
        let moved = false;
        expectSameMarkers(posed, portable);
        for (const comparedSlot of SLOTS) {
          const got = required(portable.get(comparedSlot), 'portable markers');
          const rest = required(rebased.restPositions.get(comparedSlot), 'rebased rest markers');
          for (let i = 0; i < got.length; i++) {
            const posedMarker = required(got[i], 'portable marker');
            const restPoint = required(rest[i], 'rebased rest marker');
            if (posedMarker.distanceTo(restPoint) > 1e-5) moved = true;
          }
        }
        expect(moved).toBe(true);
      }
    }
  });

  it('keeps simultaneous chest, neck, and head offsets portable', () => {
    const standard = makeCase(false);
    const rebased = makeCase(true);
    const offsets = {
      chest: { x: 0.08, y: -0.14, z: 0.05 },
      neck: { x: -0.11, y: 0.06, z: 0.13 },
      head: { x: 0.16, y: 0.09, z: -0.12 },
    } satisfies Partial<Record<OffsetSlot, OffsetValue>>;
    const expected = poseOffsets(standard, offsets);
    const got = poseOffsets(rebased, offsets);
    expectSameMarkers(expected, got);

    let moved = false;
    for (const slot of SLOTS) {
      const posed = required(got.get(slot), 'simultaneous posed markers');
      const rest = required(rebased.restPositions.get(slot), 'simultaneous rest markers');
      for (let i = 0; i < posed.length; i++) {
        if (
          required(posed[i], 'simultaneous marker').distanceTo(required(rest[i], 'rest marker')) >
          1e-5
        ) {
          moved = true;
        }
      }
    }
    expect(moved).toBe(true);
  });

  it('keeps the gauge portable under root yaw, translation, and nonuniform scale', () => {
    const standard = makeCase(false, { transformed: true });
    const rebased = makeCase(true, { transformed: true });
    for (const slot of SLOTS) {
      const expected = required(
        standard.restPositions.get(slot),
        'transformed standard rest markers',
      );
      const got = required(rebased.restPositions.get(slot), 'transformed rebased rest markers');
      for (let i = 0; i < expected.length; i++) {
        expect(
          required(got[i], 'transformed rest marker').distanceTo(
            required(expected[i], 'rest marker'),
          ),
        ).toBeLessThan(1e-10);
      }
    }

    const offsets = {
      hips: { x: 0.07, y: -0.05, z: 0.09 },
      chest: { x: -0.13, y: 0.08, z: 0.11 },
      head: { x: 0.12, y: -0.09, z: -0.07 },
      'eye.L': { x: -0.08, y: 0.1, z: 0.06 },
    } satisfies Partial<Record<OffsetSlot, OffsetValue>>;
    expectSameMarkers(poseOffsets(standard, offsets), poseOffsets(rebased, offsets));
  });
});
