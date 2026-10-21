import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Rig, solveFingerAxes } from '@/engine/rig';
import {
  captureHandGeometry,
  makeHandGeometrySample,
  sampleHandGeometry,
} from '@/engine/rig/hand-geometry';
import { Hands } from '@/engine/rig/hands';
import type { FingerName, FingerSpec, Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];
const SIDES: readonly Side[] = ['L', 'R'];
const CURLS: ReadonlyArray<{ name: string; curl: FingerSpec; spread?: FingerSpec }> = [
  { name: 'open', curl: {} },
  {
    name: 'fist',
    curl: { thumb: 0.8, index: 1, middle: 1, ring: 1, little: 1 },
  },
  { name: 'point', curl: { thumb: 0.25, index: 0, middle: 0.8, ring: 0.8, little: 0.8 } },
  {
    name: 'peace',
    curl: { thumb: 0.3, index: 0, middle: 0, ring: 0.85, little: 0.85 },
    spread: { index: 0.12, middle: -0.08 },
  },
];

function identity(point: { finger: FingerName; jointIndex: number; tip: boolean }): string {
  return `${point.finger}.${point.jointIndex}.${point.tip ? 'tip' : 'joint'}`;
}

function metricHandPoint(
  point: THREE.Vector3,
  hand: THREE.Bone,
  metricScale: number,
): THREE.Vector3 {
  return point.clone().applyMatrix4(hand.matrixWorld.clone().invert()).multiplyScalar(metricScale);
}

function liveGeometry(
  profile: ReturnType<typeof buildProfile>,
  side: Side,
  metricScale: number,
): Map<string, THREE.Vector3> {
  const hand = profile.bones[`hand.${side}`];
  if (!hand) throw new Error(`missing hand.${side}`);
  const points = new Map<string, THREE.Vector3>();
  for (const finger of FINGERS) {
    const chain = profile.fingerBones[`${finger}.${side}`];
    if (!chain) continue;
    for (let jointIndex = 0; jointIndex < chain.length; jointIndex++) {
      const world = chain[jointIndex].getWorldPosition(new THREE.Vector3());
      points.set(
        identity({ finger, jointIndex, tip: false }),
        metricHandPoint(world, hand, metricScale),
      );
    }
    if (chain.length < 2) continue;
    const previous = chain[chain.length - 2].getWorldPosition(new THREE.Vector3());
    const last = chain[chain.length - 1].getWorldPosition(new THREE.Vector3());
    const tip = last.clone().addScaledVector(last.clone().sub(previous), 0.75);
    points.set(
      identity({ finger, jointIndex: chain.length - 1, tip: true }),
      metricHandPoint(tip, hand, metricScale),
    );
  }
  return points;
}

function boneSnapshot(root: THREE.Object3D): string[] {
  const snapshot: string[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Bone)) return;
    snapshot.push(
      [
        object.name,
        ...object.position.toArray(),
        ...object.quaternion.toArray(),
        ...object.scale.toArray(),
      ].join(','),
    );
  });
  return snapshot;
}

describe('pure hand geometry', () => {
  it.each([1, 0.01])('matches the actual Hands curl at armature scale %s', (scale) => {
    const built = buildRig({ armatureScale: scale });
    built.root.rotation.y = 0.7;
    built.root.updateMatrixWorld(true);
    const profile = buildProfile(built.root, built.descriptor);
    const rig = new Rig(profile);
    const axes = solveFingerAxes(profile);
    const hands = new Hands(profile, rig.joints, (bone) => rig.rest.get(bone) ?? bone.quaternion);

    for (const side of SIDES) {
      const hand = profile.bones[`hand.${side}`];
      if (!hand) throw new Error(`missing hand.${side}`);
      const metricScale = hand.getWorldScale(new THREE.Vector3()).x;
      const beforeCapture = boneSnapshot(profile.root);
      const calibration = captureHandGeometry(
        profile,
        side,
        rig.rest,
        axes,
        rig.joints,
        metricScale,
      );
      expect(boneSnapshot(profile.root), `${side} bones after capture`).toEqual(beforeCapture);
      const sample = makeHandGeometrySample(calibration);
      const vectors = sample.points.map(({ position }) => position);
      let firstOpen: THREE.Vector3[] | undefined;

      for (const { name, curl, spread = {} } of CURLS) {
        hands.curlHand(side, curl, spread);
        profile.root.updateMatrixWorld(true);
        const before = boneSnapshot(profile.root);
        sampleHandGeometry(calibration, curl, spread, sample);
        expect(boneSnapshot(profile.root), `${side} bones after pure ${name} sample`).toEqual(
          before,
        );
        sample.points.forEach((point, index) => {
          expect(point.position).toBe(vectors[index]);
        });

        const actual = liveGeometry(profile, side, metricScale);
        expect(sample.points.map(identity)).toEqual([...actual.keys()]);
        for (const point of sample.points) {
          expect(
            point.position.distanceTo(actual.get(identity(point)) as THREE.Vector3),
            `${side} ${name} ${identity(point)}`,
          ).toBeLessThan(1e-9);
        }

        if (name === 'open') firstOpen = sample.points.map(({ position }) => position.clone());
        if (name === 'peace') {
          sampleHandGeometry(calibration, {}, {}, sample);
          expect(sample.points.map(({ position }) => position.toArray())).toEqual(
            firstOpen?.map((position) => position.toArray()),
          );
        }
      }
    }
  });

  it('uses copied hierarchy and calibrated thumb axes after live bones change', () => {
    const built = buildRig({
      armatureScale: 0.01,
      fingerGeometry: {
        thumb: {
          rootOffset: [0.018, 0.004, 0.024],
          segmentOffsets: [
            [0, 0, 0],
            [-0.008, 0.006, -0.012],
            [0.006, -0.004, 0.009],
          ],
        },
      },
    });
    const thumbProximal = built.bones.get('ThumbProximal_R');
    const thumbIntermediate = built.bones.get('ThumbIntermediate_R');
    if (!(thumbProximal && thumbIntermediate)) throw new Error('missing synthetic thumb bones');
    const helper = new THREE.Object3D();
    helper.position.set(0.003, -0.004, 0.002);
    helper.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.2);
    helper.scale.set(1.1, 0.9, 1.05);
    thumbProximal.add(helper);
    helper.add(thumbIntermediate);
    built.root.rotation.y = 0.7;
    built.root.updateMatrixWorld(true);
    const profile = buildProfile(built.root, built.descriptor);
    const rig = new Rig(profile);
    const axes = solveFingerAxes(profile);
    const hand = profile.bones['hand.R'];
    if (!hand) throw new Error('missing hand.R');
    const metricScale = hand.getWorldScale(new THREE.Vector3()).x;
    const hands = new Hands(profile, rig.joints, (bone) => rig.rest.get(bone) ?? bone.quaternion);
    const calibration = captureHandGeometry(profile, 'R', rig.rest, axes, rig.joints, metricScale);
    const sample = makeHandGeometrySample(calibration);

    hands.curlHand('R', { thumb: 0 }, {});
    profile.root.updateMatrixWorld(true);
    sampleHandGeometry(calibration, { thumb: 0 }, {}, sample);
    const openActual = liveGeometry(profile, 'R', metricScale);
    for (const point of sample.points) {
      expect(
        point.position.distanceTo(openActual.get(identity(point)) as THREE.Vector3),
      ).toBeLessThan(1e-9);
    }

    sampleHandGeometry(calibration, { thumb: 0 }, {}, sample);
    const open = sample.points.map(({ position }) => position.clone());
    sampleHandGeometry(calibration, { thumb: 0.8 }, {}, sample);
    const closed = sample.points.map(({ position }) => position.clone());
    hands.curlHand('R', { thumb: 0.8 }, {});
    profile.root.updateMatrixWorld(true);
    const closedActual = liveGeometry(profile, 'R', metricScale);
    for (const point of sample.points) {
      expect(
        point.position.distanceTo(closedActual.get(identity(point)) as THREE.Vector3),
      ).toBeLessThan(1e-9);
    }
    const thumbChain = profile.fingerBones['thumb.R'];
    expect(thumbChain).toBeDefined();
    expect(axes.axes.get(thumbChain?.[0] as THREE.Bone)?.length()).toBeGreaterThan(0.99);
    expect(
      closed[0].distanceTo(open[0]) + closed[1].distanceTo(open[1]) + closed[2].distanceTo(open[2]),
    ).toBeGreaterThan(1e-3);

    const before = boneSnapshot(profile.root);
    for (const chain of Object.values(profile.fingerBones)) {
      for (const bone of chain ?? []) {
        bone.position.x += 0.2;
        bone.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.1);
        bone.scale.set(1.2, 0.8, 1.1);
      }
    }
    const changedLiveBones = boneSnapshot(profile.root);
    expect(changedLiveBones).not.toEqual(before);

    sampleHandGeometry(calibration, { thumb: 0.8 }, {}, sample);
    expect(sample.points.map(({ position }) => position.toArray())).toEqual(
      closed.map((position) => position.toArray()),
    );
    expect(boneSnapshot(profile.root)).toEqual(changedLiveBones);
    sampleHandGeometry(calibration, { thumb: 0 }, {}, sample);
    expect(sample.points.map(({ position }) => position.toArray())).toEqual(
      open.map((position) => position.toArray()),
    );
  });

  it('omits missing finger chains without shifting the remaining identities', () => {
    const built = buildRig();
    const profile = buildProfile(built.root, built.descriptor);
    const rig = new Rig(profile);
    const axes = solveFingerAxes(profile);
    delete profile.fingerBones['ring.R'];
    const hand = profile.bones['hand.R'];
    if (!hand) throw new Error('missing hand.R');

    const calibration = captureHandGeometry(
      profile,
      'R',
      rig.rest,
      axes,
      rig.joints,
      hand.getWorldScale(new THREE.Vector3()).x,
    );
    const sample = makeHandGeometrySample(calibration);
    sampleHandGeometry(calibration, {}, {}, sample);

    expect(sample.points.some(({ finger }) => finger === 'ring')).toBe(false);
    expect(sample.points.some(({ finger }) => finger === 'middle')).toBe(true);
    expect(sample.points.filter(({ finger }) => finger === 'middle').map(identity)).toEqual([
      'middle.0.joint',
      'middle.1.joint',
      'middle.2.joint',
      'middle.2.tip',
    ]);
  });
});
