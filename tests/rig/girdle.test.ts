import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { Vec3Tuple } from '@/engine/types';
import { buildRig } from '../helpers/scene';

/** The sternoclavicular travel `rig.ts` bounds the girdle turn by. */
const GIRDLE_ROM = 0.38;

describe('girdle room', () => {
  it('bounds the summed turn by the girdle travel however many reaches ask', () => {
    const built = buildRig();
    const profile = buildProfile(built.root, built.descriptor);
    const rig = new Rig(profile);
    rig.anat.update();
    const clav = profile.bones['shoulder.R'];
    const upper = profile.bones['upperArm.R'];
    if (!(clav && upper)) throw new Error('synthetic rig has no right girdle');
    upper.updateWorldMatrix(true, false);
    clav.updateWorldMatrix(true, false);
    const S = upper.getWorldPosition(new THREE.Vector3());
    const C = clav.getWorldPosition(new THREE.Vector3());
    const aim = S.clone().sub(C).normalize();
    // A hand folded in against the face: more than the girdle can give.
    const target = S.clone().add(rig.anat.fwd.clone().multiplyScalar(0.04));

    const dir: Vec3Tuple = [aim.x, aim.y, aim.z];
    const turn = new THREE.Vector3();
    rig.girdleRoom('R', target, dir, 1, turn);
    const one = turn.length();
    expect(one).toBeGreaterThan(0);
    rig.girdleRoom('R', target, dir, 1, turn);
    expect(turn.length()).toBeGreaterThan(GIRDLE_ROM);

    rig.turnGirdle(dir, turn);
    const turned = new THREE.Vector3(...dir);
    expect(turned.angleTo(aim)).toBeLessThanOrEqual(GIRDLE_ROM + 1e-9);
    expect(turned.angleTo(aim)).toBeGreaterThan(0);
  });
});
