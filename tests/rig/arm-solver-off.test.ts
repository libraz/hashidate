import { describe, expect, it } from 'vitest';
import { JOINTS } from '@/engine/anatomy';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { buildRig } from '../helpers/scene';

function profileOf() {
  const built = buildRig();
  return buildProfile(built.root, built.descriptor);
}

describe('why the constrained arm solver is off', () => {
  it('reports nothing when both drivers build', () => {
    const rig = new Rig(profileOf());
    expect(rig.armDriver('L')).not.toBeNull();
    expect(rig.armDriver('R')).not.toBeNull();
    expect(rig.armSolverOff).toEqual([]);
  });

  it('names each side and the calibration that refused it', () => {
    const profile = profileOf();
    const anatomy = structuredClone(JOINTS);
    anatomy.wrist.dofs.flexion.max = [-1.3, 1.3];
    anatomy.wrist.dofs.deviation.max = [-0.9, 0.9];
    profile.anatomy = anatomy;
    const rig = new Rig(profile);
    expect(rig.armDriver('L')).toBeNull();
    expect(rig.armDriver('R')).toBeNull();
    expect(rig.armSolverOff).toHaveLength(2);
    expect(rig.armSolverOff[0]).toMatch(/^L: .*90 degree/);
    expect(rig.armSolverOff[1]).toMatch(/^R: .*90 degree/);
  });
});
