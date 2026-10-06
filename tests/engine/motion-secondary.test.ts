import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { Mouth } from '@/engine/face';
import { clearMotions, loadMotions } from '@/engine/motion';
import { PERFORMANCE_IDS } from '@/engine/performance';
import { buildProfile } from '@/engine/profile';
import { must } from '../helpers/must';
import { addBoneChain, buildRig } from '../helpers/scene';

const DT = 1 / 60;

function fixture(scale: number) {
  const rig = buildRig({ legs: true, armatureScale: scale });
  const chains = [
    { parent: 'Head', root: 'Hair', joints: 3 },
    { parent: 'UpperChest', root: 'Breast_L', joints: 1 },
    { parent: 'UpperChest', root: 'Breast_R', joints: 1 },
    { parent: 'Hips', root: 'Skirt', joints: 3 },
    { parent: 'Hand_L', root: 'Cuff_L', joints: 2 },
    { parent: 'Hand_R', root: 'Cuff_R', joints: 2 },
  ];
  for (const chain of chains) addBoneChain(rig, chain);
  const descriptor = {
    ...rig.descriptor,
    sway: {
      groups: chains.map(({ root }) => ({
        id: root,
        roots: [root],
        stiffness: 1.2,
        drag: 0.5,
        gravity: 0.08,
      })),
    },
  };
  const director = new Director(buildProfile(rig.root, descriptor));
  director.auto = false;
  director.blinkEnabled = false;
  director.update(DT);
  return { rig, director };
}

afterEach(() => clearMotions());

/** Observe the drawn chain, after the same world update the renderer performs. */
function checkChains(director: Director): void {
  director.p.root.updateMatrixWorld(true);
  const base = new THREE.Vector3();
  const tail = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  for (const group of director.spring.groups) {
    for (const joint of group.joints) {
      joint.bone.getWorldPosition(base);
      joint.bone.getWorldQuaternion(rotation);
      tail.copy(joint.axis).applyQuaternion(rotation).multiplyScalar(joint.length).add(base);
      expect(tail.distanceTo(joint.cur), `${group.id}/${joint.bone.name} drawn tail`).toBeLessThan(
        1e-6,
      );
      expect(
        [...joint.cur.toArray(), ...joint.prev.toArray(), ...joint.bone.quaternion.toArray()].every(
          Number.isFinite,
        ),
      ).toBe(true);
    }
  }
}

function exercise(director: Director, start: () => void): void {
  const reference = new Mouth();
  const face = must(director.p.faceMeshes[0], 'face');
  const initial = director.spring.groups.map((group) => group.joints[0].cur.clone());
  const moved = initial.map(() => 0);
  start();
  director.speak('あいうえおかきくけこさしすせそ', undefined, 2);
  reference.schedule(must(director.mouth.track, 'track'));
  let peak = 0;
  for (let frame = 0; frame < 150; frame++) {
    // A silent interval, followed by an interrupt and another line during the
    // outgoing motion. The face must still follow the mouth's own envelope.
    const amplitude = frame >= 30 && frame < 55 ? 0 : 1;
    director.mouth.setAmplitude(amplitude);
    reference.setAmplitude(amplitude);
    if (frame === 70) director.perform('hello', 'R');
    if (frame === 90) {
      director.mouth.stop();
      reference.stop();
      director.perform(null);
      director.body.stopGesture();
    }
    if (frame === 110) {
      director.speak('うえおあい', undefined, 1);
      reference.schedule(must(director.mouth.track, 'second track'));
    }
    reference.update(DT);
    director.update(DT);
    checkChains(director);
    for (const [v, value] of Object.entries(reference.weights)) {
      const shape = must(director.p.viseme[v as keyof typeof reference.weights], 'viseme');
      const index = must(face.morphTargetDictionary?.[shape], 'viseme index');
      const actual = must(face.morphTargetInfluences?.[index], 'viseme weight');
      // Director deliberately omits values below its existing write threshold.
      expect(actual).toBeCloseTo(value >= 0.005 ? value : 0, 12);
      peak = Math.max(peak, actual);
    }
    for (const [i, group] of director.spring.groups.entries()) {
      moved[i] = Math.max(moved[i], group.joints[0].cur.distanceTo(initial[i]));
    }
    if (frame === 54) expect(director.mouth.openness).toBeLessThan(0.001);
  }
  expect(peak).toBeGreaterThan(0.5);
  for (const distance of moved) expect(distance).toBeGreaterThan(1e-5);
}

describe.each([1, 0.01])('speech and secondary motion at armature scale %s', (scale) => {
  it.each(PERFORMANCE_IDS)('%s keeps hair, chest, skirt and cuffs attached during speech', (id) => {
    const { director } = fixture(scale);
    exercise(director, () => director.perform(id, 'L'));
  });

  it('keeps loaded keyframes on the same speech and secondary path', () => {
    loadMotions([
      {
        id: 'reviewMotion',
        label: { en: 'Review', ja: '確認' },
        group: 'dance',
        lead: 0.2,
        hold: 1,
        frames: [
          { at: 0, spine: { head: [0, 0, 0], chest: [0, 0, 0] } },
          {
            at: 1,
            spine: { head: [0.2, 0.3, 0], chest: [0.1, 0, 0.2] },
            arms: { R: { upperArm: [0.4, 0.7, 0.2] } },
          },
        ],
      },
    ]);
    const { director } = fixture(scale);
    exercise(director, () => director.gesture('reviewMotion'));
  });
});
