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

describe('buildFramings', () => {
  it('opens out from the face to the upper body', () => {
    // `full` is left out: it is measured from the model's own lower bound, and
    // the synthetic avatar is a rig with a few meshes on it rather than a body
    // with legs — so on this one, and only on this one, it is not the widest.
    const { framings: f } = framings();
    expect(f.face.height).toBeLessThan(f.bust.height);
    expect(f.bust.height).toBeLessThan(f.upper.height);
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
