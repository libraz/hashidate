import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ArmAnatomy } from '@/engine/anatomy/arm';
import { HAND_CONTACT, TORSO_ARM_START, TORSO_SAMPLES } from '@/engine/anatomy/joints';
import { surfaceOf } from '@/engine/anatomy/volume';
import type { BodyClearance, BodyVolumeFrame } from '@/engine/anatomy/volumes';
import { BodyVolumes, makeBodyVolumeFrame } from '@/engine/anatomy/volumes';
import { buildProfile } from '@/engine/profile';
import { buildRig } from '../helpers/scene';

function frame(): BodyVolumeFrame {
  return makeBodyVolumeFrame();
}

function rows(): BodyClearance[] {
  return (['torso', 'head'] as const).map((surface) => ({
    surface,
    valid: false,
    distance: Number.POSITIVE_INFINITY,
    normal: new THREE.Vector3(),
  }));
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`synthetic rig has no ${label}`);
  return value;
}

function buildSubject(yaw = 0, scale = 1) {
  const built = buildRig();
  built.root.rotation.y = yaw;
  built.root.scale.multiplyScalar(scale);
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  const anatomy = new ArmAnatomy(profile);
  expect(anatomy.update()).toBe(true);
  const chest = required(profile.bones.chest ?? profile.bones.spine ?? profile.bones.hips, 'chest');
  const volumes = new BodyVolumes(profile, profile.body, anatomy.up, anatomy.right, anatomy.fwd);
  volumes.update(chest);
  return { built, profile, anatomy, volumes, chest };
}

function read(
  anatomy: ArmAnatomy,
  frameSnapshot: BodyVolumeFrame,
  point: THREE.Vector3,
): BodyClearance[] {
  const out = rows();
  return anatomy.sampleVolumeClearances(frameSnapshot, point, out).map((entry) => ({
    ...entry,
    normal: entry.normal.clone(),
  }));
}

function vectorValues(v: THREE.Vector3): number[] {
  return [v.x, v.y, v.z];
}

function proxyPoints(
  S: THREE.Vector3,
  u: THREE.Vector3,
  l: THREE.Vector3,
  h: THREE.Vector3,
  La: number,
  Lf: number,
  Lh: number,
): Array<{ segment: 'upper' | 'forearm' | 'hand'; point: THREE.Vector3 }> {
  const points: Array<{ segment: 'upper' | 'forearm' | 'hand'; point: THREE.Vector3 }> = [];
  const span = La * (1 - TORSO_ARM_START);
  for (let i = 0; i <= TORSO_SAMPLES; i++) {
    points.push({
      segment: 'upper',
      point: S.clone().addScaledVector(u, La * TORSO_ARM_START + (span * i) / TORSO_SAMPLES),
    });
  }
  const E = S.clone().addScaledVector(u, La);
  for (let i = 1; i <= TORSO_SAMPLES; i++) {
    points.push({
      segment: 'forearm',
      point: E.clone().addScaledVector(l, (Lf * i) / TORSO_SAMPLES),
    });
  }
  const W = E.clone().addScaledVector(l, Lf);
  for (let i = 1; i <= TORSO_SAMPLES; i++) {
    points.push({ segment: 'hand', point: W.clone().addScaledVector(h, (Lh * i) / TORSO_SAMPLES) });
  }
  return points;
}

describe('signed body volume clearances', () => {
  it.each([
    { yaw: 0, scale: 1 },
    { yaw: 0.7, scale: 1.3 },
  ])('agrees with the existing arm proxy loops at yaw $yaw and scale $scale', ({ yaw, scale }) => {
    const subject = buildSubject(yaw, scale);
    const { anatomy, profile } = subject;
    const snapshot = frame();
    anatomy.captureVolumeFrame(snapshot);
    const S = required(profile.bones['upperArm.L'], 'upperArm.L').getWorldPosition(
      new THREE.Vector3(),
    );
    const La = required(profile.limb['upper.L'], 'upper.L');
    const Lf = required(profile.limb['lower.L'], 'lower.L');
    const Lh = required(profile.limb['tip.L.middle'], 'tip.L.middle') * HAND_CONTACT;

    const directions = [
      anatomy.right.clone().addScaledVector(anatomy.up, -0.3).normalize(),
      anatomy.up.clone().negate(),
    ];
    let sawContact = false;
    let sawClear = false;

    for (const direction of directions) {
      const points = proxyPoints(S, direction, direction, direction, La, Lf, Lh);
      anatomy.setArm(S, La, Lf, Lh);
      anatomy.measure('L', direction, direction, direction, null);
      const legacyContact = anatomy.m.torso > 0;
      const measured = points.map(({ point }) => read(anatomy, snapshot, point));
      for (const [index, sample] of measured.entries()) {
        for (const entry of sample) {
          if (!entry.valid) continue;
          const pose = entry.surface === 'torso' ? snapshot.torso : snapshot.head;
          const bodyPose = required(pose, `${entry.surface} frame`);
          const radial = points[index].point
            .clone()
            .sub(bodyPose.O)
            .addScaledVector(
              bodyPose.up,
              -points[index].point.clone().sub(bodyPose.O).dot(bodyPose.up),
            );
          expect(entry.normal.length()).toBeCloseTo(1, 12);
          expect(entry.normal.dot(radial.normalize())).toBeCloseTo(1, 10);
        }
      }
      const signedContact = measured.some((sample) =>
        sample.some((entry) => entry.valid && entry.distance < 0),
      );

      expect(points.filter((sample) => sample.segment === 'upper')).toHaveLength(TORSO_SAMPLES + 1);
      expect(points.filter((sample) => sample.segment === 'forearm')).toHaveLength(TORSO_SAMPLES);
      expect(points.filter((sample) => sample.segment === 'hand')).toHaveLength(TORSO_SAMPLES);
      expect(signedContact).toBe(legacyContact);
      sawContact ||= legacyContact;
      sawClear ||= !legacyContact;
    }

    expect(sawContact).toBe(true);
    expect(sawClear).toBe(true);
  });

  it('keeps the existing one-percent torso contact boundary on both sides', () => {
    const { anatomy, volumes } = buildSubject();
    const snapshot = frame();
    anatomy.captureVolumeFrame(snapshot);
    const torsoFrame = required(snapshot.torso, 'torso frame');
    const torso = required(volumes.torso, 'torso volume');
    const h = (torso.top + torso.bottom) * 0.5;
    const R = surfaceOf(torso, h, 0);
    const radial = torsoFrame.right.clone();

    const atDepth = (depth: number) => {
      const point = torsoFrame.O.clone()
        .addScaledVector(torsoFrame.up, h)
        .addScaledVector(radial, R * (1 - depth));
      const measured = read(anatomy, snapshot, point).find((entry) => entry.surface === 'torso');
      expect(measured?.valid).toBe(true);
      anatomy.setArm(point.clone().addScaledVector(radial, -1e-8), 1e-8);
      anatomy.measure('L', radial, radial, radial, null);
      const legacy = anatomy.m.torso;
      return { distance: required(measured, 'torso clearance').distance, legacy };
    };

    const justInsideTolerance = atDepth(0.0101);
    const justOutsideTolerance = atDepth(0.0099);
    expect(justInsideTolerance.distance).toBeLessThan(0);
    expect(justInsideTolerance.legacy).toBeGreaterThan(0);
    expect(justOutsideTolerance.distance).toBeGreaterThan(0);
    expect(justOutsideTolerance.legacy).toBe(0);
    expect(atDepth(0.01).distance).toBeCloseTo(0, 7);
  });

  it('uses the captured frames after live bones move and leaves the query untouched', () => {
    const { anatomy, built, chest, profile, volumes } = buildSubject(0.4, 1.1);
    const snapshot = frame();
    anatomy.captureVolumeFrame(snapshot);
    const oldSnapshotValues = JSON.stringify({
      torso:
        snapshot.torso &&
        Object.fromEntries(Object.entries(snapshot.torso).map(([k, v]) => [k, vectorValues(v)])),
      head:
        snapshot.head &&
        Object.fromEntries(Object.entries(snapshot.head).map(([k, v]) => [k, vectorValues(v)])),
    });
    const headFrame = required(snapshot.head, 'head frame');
    const headPoint = headFrame.O.clone()
      .addScaledVector(headFrame.up, 0.015)
      .addScaledVector(headFrame.fwd, 0.12);
    const inputBefore = headPoint.clone();
    const before = read(anatomy, snapshot, headPoint);
    expect(before.find((entry) => entry.surface === 'head')?.valid).toBe(true);
    const torsoFrame = required(snapshot.torso, 'torso frame');
    const torsoVolume = required(volumes.torso, 'torso volume');
    const torsoHeight = (torsoVolume.top + torsoVolume.bottom) * 0.5;
    const torsoPoint = torsoFrame.O.clone()
      .addScaledVector(torsoFrame.up, torsoHeight)
      .addScaledVector(torsoFrame.right, 0.02);
    const torsoBefore = read(anatomy, snapshot, torsoPoint);
    expect(torsoBefore.find((entry) => entry.surface === 'torso')?.valid).toBe(true);
    const chestBefore = chest.position.clone();
    const head = required(profile.bones.head, 'head');
    const headBefore = head.position.clone();

    chest.position.x += 0.08;
    head.position.z += 0.1;
    built.root.updateMatrixWorld(true);
    expect(anatomy.update()).toBe(true);
    const movedChestPosition = chest.position.clone();
    const movedHeadPosition = head.position.clone();
    const movedChestQuaternion = chest.quaternion.clone();
    const movedHeadQuaternion = head.quaternion.clone();

    const afterOldFrame = read(anatomy, snapshot, headPoint);
    expect(afterOldFrame).toEqual(before);
    expect(read(anatomy, snapshot, torsoPoint)).toEqual(torsoBefore);
    expect(vectorValues(headPoint)).toEqual(vectorValues(inputBefore));
    expect(
      JSON.stringify({
        torso:
          snapshot.torso &&
          Object.fromEntries(Object.entries(snapshot.torso).map(([k, v]) => [k, vectorValues(v)])),
        head:
          snapshot.head &&
          Object.fromEntries(Object.entries(snapshot.head).map(([k, v]) => [k, vectorValues(v)])),
      }),
    ).toBe(oldSnapshotValues);
    expect(chest.position.x).not.toBe(chestBefore.x);
    expect(head.position.z).not.toBe(headBefore.z);
    expect(chest.position.toArray()).toEqual(movedChestPosition.toArray());
    expect(head.position.toArray()).toEqual(movedHeadPosition.toArray());
    expect(chest.quaternion.toArray()).toEqual(movedChestQuaternion.toArray());
    expect(head.quaternion.toArray()).toEqual(movedHeadQuaternion.toArray());

    const next = frame();
    anatomy.captureVolumeFrame(next);
    expect(required(next.head, 'updated head frame').O.distanceTo(headFrame.O)).toBeGreaterThan(
      0.05,
    );
    expect(
      read(anatomy, next, headPoint).find((entry) => entry.surface === 'head')?.distance,
    ).not.toBe(before.find((entry) => entry.surface === 'head')?.distance);
    expect(required(next.torso, 'updated torso frame').O.distanceTo(torsoFrame.O)).toBeGreaterThan(
      0.05,
    );
    expect(
      read(anatomy, next, torsoPoint).find((entry) => entry.surface === 'torso')?.distance,
    ).not.toBe(torsoBefore.find((entry) => entry.surface === 'torso')?.distance);
  });

  it('uses finite stable normals on the axis and neutral invalid rows outside a volume', () => {
    const { anatomy, volumes } = buildSubject();
    const snapshot = frame();
    anatomy.captureVolumeFrame(snapshot);
    const headFrame = required(snapshot.head, 'head frame');
    const headVolume = required(volumes.head, 'head volume');
    const headVolumePoint = headFrame.O.clone().addScaledVector(headFrame.up, 0.01);
    const axial = read(anatomy, snapshot, headVolumePoint);
    const head = required(
      axial.find((entry) => entry.surface === 'head'),
      'head clearance',
    );
    expect(head.valid).toBe(true);
    expect(Number.isFinite(head.distance)).toBe(true);
    expect(vectorValues(head.normal).every(Number.isFinite)).toBe(true);
    expect(head.normal.dot(headFrame.fwd)).toBeGreaterThan(0.999999);
    const outputRows = rows();
    const torsoRow = required(
      outputRows.find((entry) => entry.surface === 'torso'),
      'torso row',
    );
    const headOutputRow = required(
      outputRows.find((entry) => entry.surface === 'head'),
      'head row',
    );
    expect(anatomy.sampleVolumeClearances(snapshot, headVolumePoint, outputRows)).toBe(outputRows);
    expect(outputRows).toHaveLength(2);
    expect(outputRows[0]).toBe(torsoRow);
    expect(outputRows[1]).toBe(headOutputRow);

    const outside = headFrame.O.clone()
      .addScaledVector(headFrame.up, headVolume.top + 0.1)
      .addScaledVector(headFrame.fwd, 0.1);
    const out = rows();
    const headOutsideRow = required(
      out.find((entry) => entry.surface === 'head'),
      'head row',
    );
    headOutsideRow.valid = true;
    headOutsideRow.distance = 23;
    headOutsideRow.normal.set(1, 2, 3);
    anatomy.sampleVolumeClearances(snapshot, outside, out);
    expect(headOutsideRow.valid).toBe(false);
    expect(headOutsideRow.distance).toBe(Number.POSITIVE_INFINITY);
    expect(headOutsideRow.normal.toArray()).toEqual([0, 0, 0]);

    const torsoFrame = required(snapshot.torso, 'torso frame');
    const torsoVolume = required(volumes.torso, 'torso volume');
    const outsideTorso = torsoFrame.O.clone()
      .addScaledVector(torsoFrame.up, torsoVolume.top + 0.1)
      .addScaledVector(torsoFrame.fwd, 0.1);
    anatomy.sampleVolumeClearances(snapshot, outsideTorso, out);
    const torsoOutside = required(
      out.find((entry) => entry.surface === 'torso'),
      'torso row',
    );
    expect(torsoOutside.valid).toBe(false);
    expect(torsoOutside.distance).toBe(Number.POSITIVE_INFINITY);
    expect(torsoOutside.normal.toArray()).toEqual([0, 0, 0]);
  });

  it('marks an optional missing torso or head volume invalid without stale output', () => {
    const missingHeadRig = buildRig();
    const missingHeadProfile = buildProfile(missingHeadRig.root, missingHeadRig.descriptor);
    missingHeadProfile.root = new THREE.Group();
    const missingHeadAnatomy = new ArmAnatomy(missingHeadProfile);
    expect(missingHeadAnatomy.update()).toBe(true);
    const missingHeadFrame = frame();
    missingHeadAnatomy.captureVolumeFrame(missingHeadFrame);
    expect(missingHeadFrame.head).toBeNull();
    const missingHeadOut = rows();
    const missingHeadRow = required(
      missingHeadOut.find((entry) => entry.surface === 'head'),
      'missing head row',
    );
    missingHeadRow.valid = true;
    missingHeadRow.distance = 12;
    missingHeadRow.normal.set(2, 3, 4);
    missingHeadAnatomy.sampleVolumeClearances(
      missingHeadFrame,
      new THREE.Vector3(),
      missingHeadOut,
    );
    expect(missingHeadRow.valid).toBe(false);
    expect(missingHeadRow.distance).toBe(Number.POSITIVE_INFINITY);
    expect(missingHeadRow.normal.toArray()).toEqual([0, 0, 0]);

    const missingTorsoRig = buildRig();
    const missingTorsoProfile = buildProfile(missingTorsoRig.root, missingTorsoRig.descriptor);
    delete missingTorsoProfile.bones['upperArm.L'];
    delete missingTorsoProfile.bones['upperArm.R'];
    delete missingTorsoProfile.bones['shoulder.L'];
    delete missingTorsoProfile.bones['shoulder.R'];
    const missingTorsoAnatomy = new ArmAnatomy(missingTorsoProfile);
    expect(missingTorsoAnatomy.update()).toBe(true);
    const missingTorsoFrame = frame();
    missingTorsoAnatomy.captureVolumeFrame(missingTorsoFrame);
    expect(missingTorsoFrame.torso).toBeNull();
    const missingTorsoOut = rows();
    const missingTorsoRow = required(
      missingTorsoOut.find((entry) => entry.surface === 'torso'),
      'missing torso row',
    );
    missingTorsoRow.valid = true;
    missingTorsoRow.distance = 45;
    missingTorsoRow.normal.set(4, 5, 6);
    missingTorsoAnatomy.sampleVolumeClearances(
      missingTorsoFrame,
      new THREE.Vector3(),
      missingTorsoOut,
    );
    expect(missingTorsoRow.valid).toBe(false);
    expect(missingTorsoRow.distance).toBe(Number.POSITIVE_INFINITY);
    expect(missingTorsoRow.normal.toArray()).toEqual([0, 0, 0]);
  });
});
