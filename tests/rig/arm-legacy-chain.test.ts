import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { ArmSlot, Profile, Vec3Tuple } from '@/engine/types';
import { buildRig, interposeBone } from '../helpers/scene';

const DIRS: Record<ArmSlot, Vec3Tuple> = {
  shoulder: [0.97, 0.18, 0.12],
  upperArm: [0.62, -0.58, 0.53],
  lowerArm: [0.08, -0.12, 0.99],
  hand: [0.2, 0.05, 0.98],
};

function legacyRig(interposed: boolean): { profile: Profile; rig: Rig } {
  const built = buildRig();
  if (interposed) {
    interposeBone(built, 'LowerArm_R', 'ElbowCarrier_R', [0.31, -0.42, 0.57]);
    interposeBone(built, 'Hand_R', 'WristCarrier_R', [-0.27, 0.36, 0.19], 0.4);
  }
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  rig.limitsEnabled = false;
  return { profile, rig };
}

function worldDirection(profile: Profile, slot: 'upperArm.R' | 'lowerArm.R' | 'hand.R') {
  const bone = profile.bones[slot];
  if (!bone) throw new Error(`synthetic rig has no ${slot}`);
  profile.root.updateMatrixWorld(true);
  return profile.restDir[slot]
    .clone()
    .applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()))
    .normalize();
}

describe('legacy arm chain', () => {
  it('aims every link through a carrier bone interposed in the chain', () => {
    const { profile, rig } = legacyRig(true);
    expect(profile.bones['lowerArm.R']?.parent?.name).toBe('ElbowCarrier_R');
    expect(profile.bones['hand.R']?.parent?.name).toBe('WristCarrier_R');

    rig.aimArmLegacy('R', DIRS);

    for (const [slot, want] of [
      ['upperArm.R', DIRS.upperArm],
      ['lowerArm.R', DIRS.lowerArm],
      ['hand.R', DIRS.hand],
    ] as const) {
      const target = new THREE.Vector3(...want).normalize();
      expect(worldDirection(profile, slot).angleTo(target)).toBeLessThan(1e-6);
    }
  });

  it('poses a direct chain exactly as before', () => {
    const { profile, rig } = legacyRig(false);
    rig.aimArmLegacy('R', DIRS, 0.3, [0.1, -0.9, 0.4], 0.8);
    const posed = (['shoulder.R', 'upperArm.R', 'lowerArm.R', 'hand.R'] as const).map((slot) =>
      profile.bones[slot]?.quaternion.toArray(),
    );
    expect(posed).toEqual(DIRECT_CHAIN);
  });
});

/** The direct-chain pose legacy aiming produces; carrier handling must not perturb it. */
const DIRECT_CHAIN: number[][] = [
  [0, -0.06073764267905947, 0.09110646401858921, 0.9939871985975576],
  [0.8750971991677953, -0.42201809309429394, 0.20025045706242162, 0.12651235337320635],
  [-0.3686596031308643, 0.3859315640306271, 0.17182780287242339, 0.8280230256848553],
  [-0.2741408299207991, 0.09769154370491118, -0.03585446588758928, 0.9560426899123289],
];
