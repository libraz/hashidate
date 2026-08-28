import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fingerCurl, JOINTS } from '@/engine/anatomy';
import { buildProfile } from '@/engine/profile';
import { Rig, solveFingerAxes } from '@/engine/rig';
import type { FingerName, Profile, Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

/**
 * Finger hinge axes and curl.
 *
 * The axes are derived once from the rest pose, so everything here is a
 * statement about what the derivation reads out of the bind — which way a
 * finger bends, and which side of the hand the palm is on.
 */

/** Axes leave `normalize`, and the curl angles come straight from the table. */
const EXACT = 1e-9;

const SIDES: readonly Side[] = ['L', 'R'];
const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`synthetic rig has no ${what}`);
  return value;
}

function buildHands(): { profile: Profile; rig: Rig } {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  return { profile, rig: new Rig(profile) };
}

/**
 * A bind pose with the wrists rolled in mirror image, so the palm normals carry
 * a lateral component and the mirror test is not satisfied by a vector that
 * happens to be straight down the midline plane.
 */
function buildRolledHands(): { profile: Profile; rig: Rig } {
  const built = buildRig();
  for (const side of SIDES) {
    const hand = need(built.bones.get(`Hand_${side}`), `Hand_${side}`);
    hand.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), side === 'L' ? 0.5 : -0.5);
  }
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  return { profile, rig: new Rig(profile) };
}

/** The palm normal in world space, for a hand that has not been posed. */
function palmWorld(profile: Profile, rig: Rig, side: Side): THREE.Vector3 {
  const hand = need(profile.bones[`hand.${side}`], `hand.${side}`);
  const local = need(rig.palmLocal[side], `palmLocal.${side}`);
  return local.clone().applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion())).normalize();
}

/** How far a bone has been turned away from the rest orientation the rig captured. */
function turnedBy(rig: Rig, bone: THREE.Bone): number {
  const rest = need(rig.rest.get(bone), 'rest orientation');
  return rest.clone().invert().multiply(bone.quaternion).angleTo(new THREE.Quaternion());
}

describe('solveFingerAxes', () => {
  it('gives every finger bone a unit axis', () => {
    const { profile, rig } = buildHands();
    let bones = 0;

    for (const side of SIDES) {
      for (const finger of FINGERS) {
        const chain = need(profile.fingerBones[`${finger}.${side}`], `${finger}.${side}`);
        expect(chain.length).toBeGreaterThan(0);
        for (const bone of chain) {
          const axis = rig.fingerAxis.get(bone);
          expect(axis, `${finger}.${side} axis`).toBeDefined();
          expect(Math.abs((axis as THREE.Vector3).length() - 1)).toBeLessThan(EXACT);
          bones++;
        }
      }
    }
    expect(rig.fingerAxis.size).toBe(bones);
  });

  it('derives the same axes standalone as the rig holds', () => {
    const { profile, rig } = buildHands();
    const standalone = solveFingerAxes(profile);

    expect(standalone.axes.size).toBe(rig.fingerAxis.size);
    for (const [bone, axis] of standalone.axes) {
      expect(need(rig.fingerAxis.get(bone), 'axis').distanceTo(axis)).toBeLessThan(EXACT);
    }
    expect(standalone.splayAxes.size).toBe(rig.fingerSplayAxis.size);
    for (const [bone, axis] of standalone.splayAxes) {
      expect(need(rig.fingerSplayAxis.get(bone), 'splay axis').distanceTo(axis)).toBeLessThan(
        EXACT,
      );
    }
  });

  it('mirrors the two palms about the midline instead of deciding each alone', () => {
    const { profile, rig } = buildHands();
    const left = palmWorld(profile, rig, 'L');
    const right = palmWorld(profile, rig, 'R');
    // The character's own right, so "mirrored" is stated against the body and
    // not against a world axis.
    rig.anat.update();
    const across = rig.anat.right;

    const lateral = (v: THREE.Vector3) => v.dot(across);
    const inPlane = (v: THREE.Vector3) => v.clone().addScaledVector(across, -v.dot(across));

    // Mirroring negates the component across the midline and leaves the rest.
    expect(lateral(right)).toBeCloseTo(-lateral(left), 9);
    expect(inPlane(right).distanceTo(inPlane(left))).toBeLessThan(EXACT);
    // Not 180 degrees apart, which is what deciding the sign per hand produced.
    expect(right.dot(left)).toBeGreaterThan(0);
  });

  it('mirrors them on a bind whose wrists are rolled, where the sign matters', () => {
    const { profile, rig } = buildRolledHands();
    const left = palmWorld(profile, rig, 'L');
    const right = palmWorld(profile, rig, 'R');
    rig.anat.update();
    const across = rig.anat.right;

    // The lateral component is real here, so a hand whose sign was guessed the
    // other way could not pass by symmetry.
    expect(Math.abs(left.dot(across))).toBeGreaterThan(0.3);
    expect(right.dot(across)).toBeCloseTo(-left.dot(across), 9);

    const inPlane = (v: THREE.Vector3) => v.clone().addScaledVector(across, -v.dot(across));
    expect(inPlane(right).distanceTo(inPlane(left))).toBeLessThan(EXACT);
    // Bind poses hang the palms down, and both of them do.
    expect(left.dot(rig.anat.up)).toBeLessThan(0);
    expect(right.dot(rig.anat.up)).toBeLessThan(0);
  });

  it('derives splay axes for proximal bones only', () => {
    const { profile, rig } = buildHands();
    let proximal = 0;

    for (const side of SIDES) {
      for (const finger of FINGERS) {
        const chain = need(profile.fingerBones[`${finger}.${side}`], `${finger}.${side}`);
        const axis = rig.fingerSplayAxis.get(chain[0]);
        expect(axis, `${finger}.${side} splay axis`).toBeDefined();
        expect(Math.abs((axis as THREE.Vector3).length() - 1)).toBeLessThan(EXACT);
        proximal++;
        for (const bone of chain.slice(1)) {
          expect(rig.fingerSplayAxis.has(bone), `${finger}.${side} distal splay`).toBe(false);
        }
      }
    }
    expect(rig.fingerSplayAxis.size).toBe(proximal);
  });
});

describe('curlFinger', () => {
  it('moves the fingertip toward the palm side, not away from it', () => {
    const { profile, rig } = buildHands();

    for (const side of SIDES) {
      const palm = palmWorld(profile, rig, side);
      for (const finger of FINGERS) {
        const chain = need(profile.fingerBones[`${finger}.${side}`], `${finger}.${side}`);
        const tip = chain[chain.length - 1];

        rig.reset();
        profile.root.updateMatrixWorld(true);
        const before = tip.getWorldPosition(new THREE.Vector3());

        rig.curlFinger(finger, side, 0.8);
        profile.root.updateMatrixWorld(true);
        const after = tip.getWorldPosition(new THREE.Vector3());

        const moved = after.clone().sub(before);
        expect(moved.length(), `${finger}.${side} moved`).toBeGreaterThan(1e-3);
        expect(moved.dot(palm), `${finger}.${side} toward palm`).toBeGreaterThan(0);
      }
    }
    rig.reset();
  });

  it('leaves every bone at its rest orientation at curl 0', () => {
    const { profile, rig } = buildHands();

    for (const side of SIDES) {
      for (const finger of FINGERS) {
        rig.curlFinger(finger, side, 0);
        const chain = need(profile.fingerBones[`${finger}.${side}`], `${finger}.${side}`);
        for (const bone of chain) {
          expect(turnedBy(rig, bone)).toBeLessThan(EXACT);
        }
      }
    }
  });

  it('reaches the top of each joint free band at curl 1, and the segments differ', () => {
    const { profile, rig } = buildHands();
    const chain = need(profile.fingerBones['index.L'], 'index.L');
    const dofs = JOINTS.finger.dofs;
    const want = [dofs.proximal.free[1], dofs.intermediate.free[1], dofs.distal.free[1]];

    rig.curlFinger('index', 'L', 1);
    const got = chain.map((bone) => turnedBy(rig, bone));

    expect(got.length).toBe(3);
    for (let i = 0; i < got.length; i++) {
      expect(Math.abs(got[i] - want[i]), `segment ${i}`).toBeLessThan(EXACT);
    }
    // Not one number spread across three segments by a taper: the knuckle, the
    // middle joint and the tip each travel their own range.
    expect(Math.abs(got[0] - got[1])).toBeGreaterThan(0.1);
    expect(Math.abs(got[1] - got[2])).toBeGreaterThan(0.1);
    expect(Math.abs(got[0] - got[2])).toBeGreaterThan(0.1);
  });

  it('gives a thumb its own table rather than the finger one', () => {
    const { profile, rig } = buildHands();
    const thumb = need(profile.fingerBones['thumb.L'], 'thumb.L');
    const dofs = JOINTS.thumb.dofs;
    const want = [dofs.proximal.free[1], dofs.intermediate.free[1], dofs.distal.free[1]];

    rig.curlFinger('thumb', 'L', 1);
    const got = thumb.map((bone) => turnedBy(rig, bone));
    for (let i = 0; i < got.length; i++) {
      expect(Math.abs(got[i] - want[i]), `thumb segment ${i}`).toBeLessThan(EXACT);
    }
    expect(want[0]).not.toBeCloseTo(JOINTS.finger.dofs.proximal.free[1], 3);
  });

  it('bounds the strained band above 1 at each joint hard stop', () => {
    const { profile, rig } = buildHands();
    const chain = need(profile.fingerBones['index.L'], 'index.L');
    const dofs = JOINTS.finger.dofs;
    const stops = [dofs.proximal.max[1], dofs.intermediate.max[1], dofs.distal.max[1]];

    rig.curlFinger('index', 'L', 1);
    const atOne = chain.map((bone) => turnedBy(rig, bone));
    rig.curlFinger('index', 'L', 5);
    const beyond = chain.map((bone) => turnedBy(rig, bone));

    for (let i = 0; i < stops.length; i++) {
      expect(Math.abs(beyond[i] - stops[i]), `segment ${i} stop`).toBeLessThan(EXACT);
      // The strained band is above the free one and is reachable, not free.
      expect(beyond[i]).toBeGreaterThan(atOne[i]);
    }
  });

  it('hyperextends only the joints the table gives hyperextension to', () => {
    const { profile, rig } = buildHands();
    const chain = need(profile.fingerBones['index.L'], 'index.L');
    const dofs = JOINTS.finger.dofs;

    rig.curlFinger('index', 'L', -5);
    const got = chain.map((bone) => turnedBy(rig, bone));

    // The knuckle and the tip go back; the middle joint has no floor below zero.
    expect(Math.abs(got[0] - Math.abs(dofs.proximal.max[0]))).toBeLessThan(EXACT);
    expect(got[1]).toBeLessThan(EXACT);
    expect(Math.abs(got[2] - Math.abs(dofs.distal.max[0]))).toBeLessThan(EXACT);
    expect(dofs.intermediate.max[0]).toBe(0);
  });

  it('does nothing for a finger the rig does not have', () => {
    const { profile, rig } = buildHands();
    delete profile.fingerBones['ring.R'];
    expect(() => rig.curlFinger('ring', 'R', 1)).not.toThrow();
  });
});

describe('curlHand', () => {
  it('drives each named finger and leaves the unnamed ones at rest', () => {
    const { profile, rig } = buildHands();
    rig.reset();
    rig.curlHand('R', { index: 1, middle: 0.5 });

    const turned = (finger: FingerName) =>
      need(profile.fingerBones[`${finger}.R`], `${finger}.R`).map((bone) => turnedBy(rig, bone));

    const index = turned('index');
    const middle = turned('middle');
    for (let i = 0; i < index.length; i++) {
      expect(index[i]).toBeGreaterThan(0.1);
      // Half the curl is half the angle, so the two hands' fingers are not
      // sharing one number.
      expect(Math.abs(middle[i] - index[i] * 0.5)).toBeLessThan(EXACT);
    }
    for (const finger of ['thumb', 'ring', 'little'] as FingerName[]) {
      for (const angle of turned(finger)) expect(angle).toBeLessThan(EXACT);
    }
  });

  it('leaves the other hand alone', () => {
    const { profile, rig } = buildHands();
    rig.reset();
    rig.curlHand('L', { thumb: 1, index: 1, middle: 1, ring: 1, little: 1 });

    for (const finger of FINGERS) {
      const left = need(profile.fingerBones[`${finger}.L`], `${finger}.L`);
      const right = need(profile.fingerBones[`${finger}.R`], `${finger}.R`);
      expect(left.some((bone) => turnedBy(rig, bone) > 0.1)).toBe(true);
      for (const bone of right) expect(turnedBy(rig, bone)).toBeLessThan(EXACT);
    }
  });

  it('fans a positive spread toward the little finger on both hands', () => {
    const { profile, rig } = buildHands();
    const displacement: Record<Side, number> = { L: 0, R: 0 };

    const segment = (finger: FingerName, side: Side): THREE.Vector3 => {
      const chain = need(profile.fingerBones[`${finger}.${side}`], `${finger}.${side}`);
      chain[0].updateWorldMatrix(true, false);
      chain[1].updateWorldMatrix(true, false);
      return chain[1]
        .getWorldPosition(new THREE.Vector3())
        .sub(chain[0].getWorldPosition(new THREE.Vector3()))
        .normalize();
    };

    for (const side of SIDES) {
      rig.reset();
      profile.root.updateMatrixWorld(true);
      const index = need(profile.fingerBones[`index.${side}`], `index.${side}`)[0];
      const little = need(profile.fingerBones[`little.${side}`], `little.${side}`)[0];
      const towardLittle = little
        .getWorldPosition(new THREE.Vector3())
        .sub(index.getWorldPosition(new THREE.Vector3()))
        .normalize();
      const before = segment('index', side);

      rig.curlHand(side, {}, { index: 0.4, little: 0.4 });
      profile.root.updateMatrixWorld(true);
      const after = segment('index', side);
      displacement[side] = after.clone().sub(before).dot(towardLittle);
      expect(displacement[side], `${side} positive spread`).toBeGreaterThan(0);
    }

    expect(displacement.L).toBeCloseTo(displacement.R, 9);
  });

  it('composes proximal splay before curl and leaves distal splay off', () => {
    const { profile, rig } = buildHands();
    const chain = need(profile.fingerBones['index.R'], 'index.R');
    const spread = 0.24;
    const curl = 0.55;
    rig.reset();
    rig.curlHand('R', { index: curl }, { index: spread });

    const splayAxis = need(rig.fingerSplayAxis.get(chain[0]), 'index.R splay axis');
    const curlAxis = need(rig.fingerAxis.get(chain[0]), 'index.R curl axis');
    const want = need(rig.rest.get(chain[0]), 'index.R rest')
      .clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(splayAxis, spread))
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(curlAxis, fingerCurl(rig.joints.finger, 0, curl)),
      );
    expect(chain[0].quaternion.angleTo(want)).toBeLessThan(1e-7);

    for (let i = 1; i < chain.length; i++) {
      const axis = need(rig.fingerAxis.get(chain[i]), `index.R curl axis ${i}`);
      const expected = need(rig.rest.get(chain[i]), `index.R rest ${i}`)
        .clone()
        .multiply(
          new THREE.Quaternion().setFromAxisAngle(axis, fingerCurl(rig.joints.finger, i, curl)),
        );
      expect(chain[i].quaternion.angleTo(expected), `index.R segment ${i}`).toBeLessThan(1e-7);
    }
  });

  it('keeps omitted and zero spread identical to curl-only', () => {
    const omitted = buildHands();
    const zero = buildHands();
    omitted.rig.curlHand('R', { index: 0.55 });
    zero.rig.curlHand('R', { index: 0.55 }, { index: 0 });

    const chain = need(omitted.profile.fingerBones['index.R'], 'index.R');
    const same = need(zero.profile.fingerBones['index.R'], 'index.R');
    for (let i = 0; i < chain.length; i++) {
      expect(chain[i].quaternion.angleTo(same[i].quaternion), `index.R segment ${i}`).toBeLessThan(
        1e-7,
      );
    }
  });
});
