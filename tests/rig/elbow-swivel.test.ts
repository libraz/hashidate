import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { mkReachScratch } from '@/engine/motion/resolve';
import { buildProfile } from '@/engine/profile';
import { Rig, reachRef } from '@/engine/rig';
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
  return { rig, shoulder, ahead, across };
}

/** Run one slot for `seconds` at `hz` from an elbow offset from its answer; the angle still to close. */
function trackFor(hz: number, seconds: number, interleave: boolean): number {
  const { rig, shoulder, ahead, across } = setup();
  const anat = rig.anat;
  const slot = mkReachScratch();
  const other = mkReachScratch();
  rig.solveReachNatural('R', ahead, null, slot.R);
  const answer = slot.R.swivelDir.clone();
  // Push the remembered elbow 0.8 rad round its circle, about the reach line
  // expressed in the body frame the memory is kept in.
  const n = ahead.clone().sub(shoulder).normalize();
  const axis = new THREE.Vector3(n.dot(anat.right), n.dot(anat.up), n.dot(anat.fwd));
  slot.R.swivelDir.applyAxisAngle(axis, 0.8);
  rig.dt = 1 / hz;
  for (let i = 0; i < Math.round(seconds * hz); i++) {
    if (interleave) rig.solveReachNatural('R', across, null, other.R);
    rig.solveReachNatural('R', ahead, null, slot.R);
  }
  return slot.R.swivelDir.angleTo(answer);
}

describe('elbow swivel tracking', () => {
  it('settles a fresh slot at its answer outright', () => {
    const { rig, ahead } = setup();
    const a = mkReachScratch();
    const b = mkReachScratch();
    rig.solveReachNatural('R', ahead, null, a.R);
    rig.solveReachNatural('R', ahead, null, b.R);
    expect(a.R.swivelDir.length()).toBeCloseTo(1, 12);
    expect(b.R.swivelDir.angleTo(a.R.swivelDir)).toBeLessThan(1e-12);
    expect(b.R.upperArm.angleTo(a.R.upperArm)).toBeLessThan(1e-12);
  });

  it('covers the same ground in the same time at any frame rate', () => {
    const at60 = trackFor(60, 1 / 12, false);
    const at144 = trackFor(144, 1 / 12, false);
    expect(at60).toBeGreaterThan(0.05);
    expect(at60).toBeLessThan(0.8);
    expect(at144).toBeCloseTo(at60, 6);
  });

  it('is not pulled by another slot solving the same arm', () => {
    expect(trackFor(60, 0.1, true)).toBeCloseTo(trackFor(60, 0.1, false), 12);
  });

  it('keeps the elbow where it was when the reach reference switches between frames', () => {
    // The zero of the swivel angle is forward projected off the reach line,
    // and up once the reach runs close enough to forward. Two targets a degree
    // apart sit either side of that switch; what the slot remembers between
    // them must mean the same elbow in both frames.
    const { rig } = setup();
    const anat = rig.anat;
    const upper = rig.p.bones['upperArm.R'];
    if (!upper) throw new Error('synthetic rig has no upper arm');
    const shoulder = upper.getWorldPosition(new THREE.Vector3());
    const span = (rig.p.limb['upper.R'] ?? 0) + (rig.p.limb['lower.R'] ?? 0);
    const bearing = (ahead: number) => {
      const rest = Math.sqrt(1 - ahead * ahead);
      return new THREE.Vector3()
        .addScaledVector(anat.fwd, ahead)
        .addScaledVector(anat.up, -0.4 * rest)
        .addScaledVector(anat.right, -Math.sqrt(1 - 0.16) * rest);
    };
    const before = shoulder.clone().addScaledVector(bearing(0.86), 0.7 * span);
    const after = shoulder.clone().addScaledVector(bearing(0.88), 0.7 * span);
    const refBefore = reachRef(anat, bearing(0.86), new THREE.Vector3());
    const refAfter = reachRef(anat, bearing(0.88), new THREE.Vector3());
    expect(refBefore.angleTo(refAfter)).toBeGreaterThan(1);

    const slot = mkReachScratch();
    rig.dt = 1 / 60;
    for (let i = 0; i < 30; i++) rig.solveReachNatural('R', before, null, slot.R);
    const held = slot.R.upperArm.clone();
    rig.solveReachNatural('R', after, null, slot.R);
    expect(slot.R.upperArm.angleTo(held)).toBeLessThan(0.05);
  });
});
