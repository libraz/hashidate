import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { mkReachScratch } from '@/engine/motion/resolve';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { buildRig } from '../helpers/scene';

/**
 * Elbow tracking state.
 *
 * Each gesture slot carries its own elbow, and tracking runs on elapsed time,
 * so neither a second slot solving the same arm nor a faster display changes
 * where one slot's elbow is after a given time.
 */

function setup() {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  rig.anat.update();
  const upper = profile.bones['upperArm.R'];
  if (!upper) throw new Error('synthetic rig has no upper arm');
  upper.updateWorldMatrix(true, false);
  const shoulder = upper.getWorldPosition(new THREE.Vector3());
  const span = (profile.limb['upper.R'] ?? 0) + (profile.limb['lower.R'] ?? 0);
  // In front of the chest and up, where the elbow circle is wide.
  const ahead = shoulder.clone().add(new THREE.Vector3(-0.2, 0.25, 0.6).multiplyScalar(span));
  const across = shoulder.clone().add(new THREE.Vector3(-0.6, -0.1, 0.4).multiplyScalar(span));
  return { rig, ahead, across };
}

/** Run one slot for `seconds` at `hz` from an elbow offset from its answer. */
function trackFor(hz: number, seconds: number, interleave: boolean): number {
  const { rig, ahead, across } = setup();
  const slot = mkReachScratch();
  const other = mkReachScratch();
  rig.solveReachNatural('R', ahead, null, slot.R);
  const answer = slot.R.swivel ?? 0;
  slot.R.swivel = answer + 0.8;
  rig.dt = 1 / hz;
  for (let i = 0; i < Math.round(seconds * hz); i++) {
    if (interleave) rig.solveReachNatural('R', across, null, other.R);
    rig.solveReachNatural('R', ahead, null, slot.R);
  }
  return (slot.R.swivel ?? 0) - answer;
}

describe('elbow swivel tracking', () => {
  it('settles a fresh slot at its answer outright', () => {
    const { rig, ahead } = setup();
    const a = mkReachScratch();
    const b = mkReachScratch();
    rig.solveReachNatural('R', ahead, null, a.R);
    rig.solveReachNatural('R', ahead, null, b.R);
    expect(a.R.swivel).toBeDefined();
    expect(b.R.swivel).toBeCloseTo(a.R.swivel ?? Number.NaN, 12);
  });

  it('covers the same ground in the same time at any frame rate', () => {
    const at60 = trackFor(60, 1 / 12, false);
    const at144 = trackFor(144, 1 / 12, false);
    expect(Math.abs(at60)).toBeGreaterThan(0.05);
    expect(at144).toBeCloseTo(at60, 6);
  });

  it('is not pulled by another slot solving the same arm', () => {
    expect(trackFor(60, 0.1, true)).toBeCloseTo(trackFor(60, 0.1, false), 12);
  });
});
