import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Body } from '@/engine/motion/body';
import { BASE_POSE } from '@/engine/motion/gestures';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { ArmSlot, Vec3Tuple } from '@/engine/types';
import { buildRig } from '../../helpers/scene';
import { canonicalDirection, DT, type Harness } from './harness';

/** A still body whose descriptor may override the resting arm directions. */
function restingHarness(armRest?: Partial<Record<ArmSlot, Vec3Tuple>>): Harness {
  const built = buildRig();
  const profile = buildProfile(built.root, { ...built.descriptor, armRest });
  const rig = new Rig(profile);
  rig.limitsEnabled = false;
  const body = new Body(rig, profile);
  body.breathDepth = 0;
  body.idleAmount = 0;
  body.weightShift = 0;
  body.gazeAmount = 0;
  for (let i = 0; i < 240; i++) {
    rig.reset();
    body.update(DT);
  }
  return { body, profile, rig };
}

describe('resting arm pose', () => {
  it('settles on the avatar override and keeps the standing pose elsewhere', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const open: Vec3Tuple = [0.55, -0.82, 0.14];
      const plain = restingHarness();
      const opened = restingHarness({ upperArm: open });
      const want = new THREE.Vector3(...open).normalize();
      for (const side of ['L', 'R'] as const) {
        const upper = canonicalDirection(opened, side, `upperArm.${side}`, `lowerArm.${side}`);
        expect(upper.dot(want)).toBeGreaterThan(0.995);
        const standing = canonicalDirection(plain, side, `upperArm.${side}`, `lowerArm.${side}`);
        expect(standing.dot(BASE_POSE.upperArm)).toBeGreaterThan(0.995);
        expect(upper.x).toBeGreaterThan(standing.x + 0.2);
      }
    } finally {
      random.mockRestore();
    }
  });
});
