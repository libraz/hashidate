import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { buildFramings } from '@/viewer/scene/framing';
import { buildRig } from '../helpers/scene';

/**
 * The four camera framings, and the one width they carry.
 *
 * A framing says what is in shot vertically — that is the whole of what the
 * four of them are for, and the distance is derived from it. `halfWidth` is the
 * odd one out: it says nothing about the shot and exists so a *placement* can
 * put the character on the edge of the frame rather than putting the edge of a
 * mostly-empty picture there.
 */

const FOV = 28;

function framings() {
  const rig = buildRig({ arkit: false });
  return { rig, framings: buildFramings(rig.root, buildProfile(rig.root, rig.descriptor), FOV) };
}

function shortTorso() {
  const rig = buildRig({ arkit: false });
  const profile = buildProfile(rig.root, rig.descriptor);
  const spine = profile.bones.spine;
  const chest = profile.bones.chest;
  const chestParent = chest?.parent;
  if (!(spine && chest && chestParent instanceof THREE.Bone)) {
    throw new Error('synthetic rig has no trunk bones');
  }

  // Keep the purchased-model proportion that exposed the bug: chest and hips
  // are close enough that the old upper lower edge crossed the bust edge.
  spine.position.y = 0.01;
  chestParent.position.y = 0.01;
  chest.position.y = 0.01;
  rig.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(rig.root);
  const size = box.getSize(new THREE.Vector3());
  const chestY = chest.getWorldPosition(new THREE.Vector3()).y;
  const hips = profile.bones.hips;
  if (!hips) throw new Error('synthetic rig has no hips');
  const hipsY = hips.getWorldPosition(new THREE.Vector3()).y;
  return {
    rig,
    profile,
    size,
    chestY,
    hipsY,
    framings: buildFramings(rig.root, profile, FOV),
  };
}

describe('buildFramings', () => {
  it('opens out from the face to the upper body', () => {
    // `full` is left out: it is measured from the model's own lower bound, and
    // the synthetic avatar is a rig with a few meshes on it rather than a body
    // with legs — so on this one, and only on this one, it is not the widest.
    const { framings: f } = framings();
    expect(f.face.height).toBeLessThan(f.bust.height);
    expect(f.bust.height).toBeLessThan(f.upper.height);
  });

  it('keeps upper below bust for a short torso without changing the bust edge', () => {
    const { framings: f, size, chestY, hipsY } = shortTorso();
    const bustBottom = chestY - size.y * 0.17;
    const upperByHips = hipsY - size.y * 0.12;
    const minimum = bustBottom - size.y * 0.04;
    const oldUpperBottom = hipsY - size.y * 0.05;
    const bustTop = f.bust.target.y + f.bust.height / 2;
    const renderedBustBottom = f.bust.target.y - f.bust.height / 2;
    const upperTop = f.upper.target.y + f.upper.height / 2;
    const upperBottom = f.upper.target.y - f.upper.height / 2;

    // The short chest-to-hip interval is the case where the old lower edge was
    // above the bust edge, reversing the intended nesting. The 4% opening is
    // the measured minimum that keeps upper useful without moving bust.
    expect(oldUpperBottom).toBeGreaterThan(bustBottom);
    expect(upperByHips).toBeGreaterThan(minimum);
    expect(renderedBustBottom).toBeCloseTo(bustBottom, 12);
    expect(f.upper.height).toBeGreaterThan(f.bust.height);
    expect(upperBottom).toBeCloseTo(minimum, 12);
    expect(upperTop).toBeCloseTo(bustTop, 12);
  });

  it('stands the camera where that height fills the frame', () => {
    // The distance is derived from the two edges rather than chosen, which is
    // what keeps a shot meaning the same thing on avatars of different heights.
    const { framings: f } = framings();
    const tan = Math.tan((FOV * Math.PI) / 360);
    for (const framing of Object.values(f)) {
      expect(framing.position.distanceTo(framing.target)).toBeCloseTo(framing.height / 2 / tan, 6);
    }
  });

  it('measures the width from the elbows, not from the exported pose', () => {
    // The failure this pins. A model is exported in a T or an A pose and is
    // never shown in one, so the file's own bounds are close to a full arm span
    // — a figure wider than the shot itself, which came out as a placement that
    // did not move the character at all.
    const { rig, framings: f } = framings();
    const profile = buildProfile(rig.root, rig.descriptor);
    rig.root.updateMatrixWorld(true);
    const at = (slot: 'lowerArm.L' | 'lowerArm.R' | 'upperArm.L') =>
      profile.bones[slot]?.getWorldPosition(new THREE.Vector3()).x ?? 0;
    const elbows = Math.abs(at('lowerArm.L') - at('lowerArm.R')) / 2;

    expect(elbows).toBeGreaterThan(0);
    expect(f.bust.halfWidth).toBeCloseTo(elbows * 1.4, 6);
    // And wider than the shoulders, which is the measurement that put the
    // character's hair off the edge of the frame.
    expect(f.bust.halfWidth).toBeGreaterThan(Math.abs(at('upperArm.L')));
  });

  it('carries the same width at every framing', () => {
    // Erring wide costs a little of the hug; erring narrow puts a shoulder off
    // the edge of the frame. A face shot is the one that errs wide, and that is
    // the side to err on.
    const { framings: f } = framings();
    for (const framing of Object.values(f)) {
      expect(framing.halfWidth).toBe(f.bust.halfWidth);
    }
  });
});
