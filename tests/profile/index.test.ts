import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { JOINTS } from '@/engine/anatomy';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { buildRig } from '../helpers/scene';

function footDriftAfterPelvisDrop(profile: ReturnType<typeof buildProfile>, rig: Rig): number {
  const hips = profile.bones.hips;
  const foot = profile.bones['foot.L'];
  if (!(hips && foot)) throw new Error('synthetic rig lacks standing legs');
  const before = foot.getWorldPosition(new THREE.Vector3());
  hips.position.y -= 0.02;
  rig.plantLegs(0);
  return foot.getWorldPosition(new THREE.Vector3()).distanceTo(before);
}

describe('descriptor anatomy through profile construction', () => {
  it.each(['curlFinger', 'curlHand'] as const)(
    'uses custom anatomy through %s and opts out of humanoid grounding',
    (method) => {
      const scene = buildRig({ legs: true });
      const anatomy = structuredClone(JOINTS);
      anatomy.finger.dofs.proximal.free[1] *= 0.5;
      const profile = buildProfile(scene.root, { ...scene.descriptor, anatomy });
      const rig = new Rig(profile);
      const finger = profile.fingerBones['index.L']?.[0];
      if (!finger) throw new Error('synthetic rig lacks index finger');
      const rest = finger.quaternion.clone();
      if (method === 'curlFinger') rig.curlFinger('index', 'L', 1);
      else rig.curlHand('L', { index: 1 });
      expect(finger.quaternion.angleTo(rest)).toBeCloseTo(anatomy.finger.dofs.proximal.free[1], 10);
      expect(profile.anatomy).toBe(anatomy);
      expect(footDriftAfterPelvisDrop(profile, rig)).toBeCloseTo(0.02, 10);
    },
  );

  it('retains the human joint table and standing legs without an override', () => {
    const scene = buildRig({ legs: true });
    const profile = buildProfile(scene.root, scene.descriptor);
    const rig = new Rig(profile);
    const finger = profile.fingerBones['index.L']?.[0];
    if (!finger) throw new Error('synthetic rig lacks index finger');
    const rest = finger.quaternion.clone();
    rig.curlFinger('index', 'L', 1);
    expect(finger.quaternion.angleTo(rest)).toBeCloseTo(JOINTS.finger.dofs.proximal.free[1], 10);
    expect(footDriftAfterPelvisDrop(profile, rig)).toBeLessThan(1e-8);
  });
});
