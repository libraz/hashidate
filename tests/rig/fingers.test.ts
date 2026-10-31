import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { JOINTS } from '@/engine/anatomy';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
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
const FOUR_FINGERS: readonly FingerName[] = ['index', 'middle', 'ring', 'little'];
const THUMB_TILT = (20 * Math.PI) / 180;

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

/** Nearly horizontal palm normals expose world-up sign guesses after a root turn. */
function buildNearHorizontalHands(
  rotation: THREE.Quaternion,
  missingMiddle?: Side,
): { profile: Profile; rig: Rig } {
  const built = buildRig();
  for (const side of SIDES) {
    const hand = need(built.bones.get(`Hand_${side}`), `Hand_${side}`);
    hand.quaternion.setFromEuler(new THREE.Euler(Math.PI / 2 - 0.01, 0, side === 'L' ? 0.7 : -0.7));
  }
  built.root.quaternion.copy(rotation);
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  if (missingMiddle) delete profile.fingerBones[`middle.${missingMiddle}`];
  return { profile, rig: new Rig(profile) };
}

/**
 * Arms hanging just past vertical with the palms facing the thighs, so each
 * palm tips slightly upward and nothing about world up says which side it is.
 */
function buildPalmsInHands(): { profile: Profile; rig: Rig } {
  const built = buildRig();
  for (const side of SIDES) {
    const upper = need(built.bones.get(`UpperArm_${side}`), `UpperArm_${side}`);
    upper.quaternion.setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      side === 'L' ? Math.PI / 2 + 0.1 : -Math.PI / 2 - 0.1,
    );
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

  it.each([
    ['root roll', new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.6))],
    ['root yaw and tilt', new THREE.Quaternion().setFromEuler(new THREE.Euler(0.9, 0.7, -0.5))],
  ] as const)('keeps near-horizontal bind palms in the body frame after %s', (_, rotation) => {
    const baseline = buildNearHorizontalHands(new THREE.Quaternion());
    const rotated = buildNearHorizontalHands(rotation);
    rotated.rig.anat.update();
    const palms = SIDES.map((side) => palmWorld(rotated.profile, rotated.rig, side));
    for (const [i, side] of SIDES.entries()) {
      const expected = palmWorld(baseline.profile, baseline.rig, side).applyQuaternion(rotation);
      expect.soft(palms[i].distanceTo(expected), `${side} rotation covariance`).toBeLessThan(EXACT);
      expect.soft(palms[i].dot(rotated.rig.anat.up), `${side} downward sign`).toBeLessThan(0);
      expect(Math.abs(expected.dot(rotated.rig.anat.up))).toBeLessThan(0.01);
      expect(Math.abs(expected.dot(rotated.rig.anat.right))).toBeGreaterThan(0.6);
    }
    const mirrored = palms[0]
      .clone()
      .addScaledVector(rotated.rig.anat.right, -2 * palms[0].dot(rotated.rig.anat.right));
    expect.soft(palms[1].distanceTo(mirrored)).toBeLessThan(EXACT);
  });

  it.each(SIDES)(
    'uses body up for the remaining palm when %s middle geometry is missing',
    (missing) => {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.6));
      const { profile, rig } = buildNearHorizontalHands(rotation, missing);
      const remaining = missing === 'L' ? 'R' : 'L';
      rig.anat.update();
      expect(rig.palmLocal[missing]).toBeUndefined();
      expect(rig.anat.radialSign[missing]).toBe(1);
      expect(palmWorld(profile, rig, remaining).dot(rig.anat.up)).toBeLessThan(0);
    },
  );

  it('reads each palm from the hand, not from which way is up', () => {
    const { profile, rig } = buildPalmsInHands();
    rig.anat.update();
    for (const side of SIDES) {
      const upper = need(profile.bones[`upperArm.${side}`], `upperArm.${side}`);
      // Down in the unrotated bind, carried round with the arm.
      const expected = new THREE.Vector3(0, -1, 0).applyQuaternion(
        upper.getWorldQuaternion(new THREE.Quaternion()),
      );
      const inward = rig.anat.right.clone().multiplyScalar(side === 'L' ? 1 : -1);
      const palm = palmWorld(profile, rig, side);
      expect.soft(expected.dot(rig.anat.up), `${side} palm tips up`).toBeGreaterThan(0.05);
      expect.soft(palm.distanceTo(expected), `${side} palm`).toBeLessThan(EXACT);
      expect.soft(palm.dot(inward), `${side} faces the body`).toBeGreaterThan(0.99);
    }
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
      for (const finger of FOUR_FINGERS) {
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

  describe('thumb', () => {
    /** Palm-plane direction from the index base to the little base. */
    function towardLittleOf(profile: Profile, palm: THREE.Vector3, side: Side): THREE.Vector3 {
      const wp = (bone: THREE.Bone) => bone.getWorldPosition(new THREE.Vector3());
      const index = need(profile.fingerBones[`index.${side}`], `index.${side}`)[0];
      const little = need(profile.fingerBones[`little.${side}`], `little.${side}`)[0];
      const v = wp(little).sub(wp(index));
      return v.addScaledVector(palm, -v.dot(palm)).normalize();
    }

    it('curls toward the little finger rather than lifting off the palm, mirrored on both hands', () => {
      const { profile, rig } = buildHands();
      const across: Record<Side, number> = { L: 0, R: 0 };
      const lift: Record<Side, number> = { L: 0, R: 0 };

      for (const side of SIDES) {
        const palm = palmWorld(profile, rig, side);
        const littleWard = towardLittleOf(profile, palm, side);
        const chain = need(profile.fingerBones[`thumb.${side}`], `thumb.${side}`);
        const tip = chain[chain.length - 1];

        rig.reset();
        profile.root.updateMatrixWorld(true);
        const before = tip.getWorldPosition(new THREE.Vector3());
        rig.curlFinger('thumb', side, 1);
        profile.root.updateMatrixWorld(true);
        const moved = tip.getWorldPosition(new THREE.Vector3()).sub(before);

        across[side] = moved.dot(littleWard);
        lift[side] = moved.dot(palm);
        expect(across[side], `${side} thumb across`).toBeGreaterThan(Math.abs(lift[side]));
      }
      expect(across.L).toBeCloseTo(across.R, 9);
      expect(lift.L).toBeCloseTo(lift.R, 9);
    });

    it('hinges every bone about the palm normal tilted toward the finger fold', () => {
      const { profile, rig } = buildHands();

      for (const side of SIDES) {
        const palm = palmWorld(profile, rig, side);
        const littleWard = towardLittleOf(profile, palm, side);
        const chain = need(profile.fingerBones[`thumb.${side}`], `thumb.${side}`);
        // The synthetic tip bone has no child, so its direction is the +y fallback,
        // parallel to the palm normal and carrying no fold.
        for (const [i, bone] of chain.slice(0, -1).entries()) {
          const boneQ = bone.getWorldQuaternion(new THREE.Quaternion());
          const n = palm.clone().applyQuaternion(boneQ.clone().invert());
          const dir = need(profile.restDir[`thumb.${side}.${i}`], `thumb.${side}.${i} dir`);
          // The finger hinge: turning about it lifts the tip toward the palm.
          const fold = new THREE.Vector3().crossVectors(dir, n).normalize();
          const axis = need(rig.fingerAxis.get(bone), `thumb.${side}.${i} axis`);

          expect(axis.dot(fold), `${side} bone ${i} fold`).toBeCloseTo(Math.sin(THUMB_TILT), 9);
          // Which way the normal component points is settled by the sweep toward
          // the little finger; the tilt toward the fold is fixed.
          const sweep = new THREE.Vector3()
            .crossVectors(axis, dir)
            .applyQuaternion(boneQ)
            .dot(littleWard);
          expect(sweep, `${side} bone ${i} sweep`).toBeGreaterThan(0);
          expect(Math.abs(axis.dot(n)), `${side} bone ${i} normal`).toBeCloseTo(
            Math.cos(THUMB_TILT),
            9,
          );
        }
      }
    });

    it('splays positive spread toward the palm, at the carpometacarpal bone only', () => {
      const { profile, rig } = buildHands();

      for (const side of SIDES) {
        const palm = palmWorld(profile, rig, side);
        const chain = need(profile.fingerBones[`thumb.${side}`], `thumb.${side}`);
        const tip = chain[chain.length - 1];

        rig.reset();
        profile.root.updateMatrixWorld(true);
        const before = tip.getWorldPosition(new THREE.Vector3());
        rig.curlHand(side, {}, { thumb: 0.3 });
        profile.root.updateMatrixWorld(true);
        const moved = tip.getWorldPosition(new THREE.Vector3()).sub(before);

        expect(moved.dot(palm), `${side} thumb splay toward palm`).toBeGreaterThan(1e-3);
        expect(turnedBy(rig, chain[0])).toBeCloseTo(0.3, 9);
        for (const bone of chain.slice(1)) expect(turnedBy(rig, bone)).toBeLessThan(EXACT);
      }
      rig.reset();
    });
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
    // At the start of the opposition ramp (`THUMB_OPPOSITION_CURL`, `anatomy/joints.rs`), where
    // the distal hinge has not turned yet.
    const curl = 0.4;
    const want = [dofs.proximal, dofs.intermediate, dofs.distal].map((d) => d.free[1] * curl);

    rig.curlFinger('thumb', 'L', curl);
    const got = thumb.map((bone) => turnedBy(rig, bone));
    for (let i = 0; i < got.length; i++) {
      expect(Math.abs(got[i] - want[i]), `thumb segment ${i}`).toBeLessThan(EXACT);
    }
    expect(want[0]).not.toBeCloseTo(JOINTS.finger.dofs.proximal.free[1] * curl, 3);
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

  it('keeps the splay it records on the legacy path, so a re-seed does not move the finger', () => {
    const { profile, rig } = buildHands();
    const knuckle = need(profile.fingerBones['index.R'], 'index.R')[0];
    rig.limitsEnabled = false;

    rig.curlHand('R', { index: 0.8 });
    const unsplayed = knuckle.quaternion.clone();
    rig.curlHand('R', { index: 0.8 }, { index: 0.3 });
    const splayed = knuckle.quaternion.clone();
    // Positive control: the splay is visible on this knuckle.
    expect(splayed.angleTo(unsplayed)).toBeGreaterThan(1e-3);

    rig.curlHand('R', { index: 0.4 }, { index: 0.3 });
    rig.curlFinger('index', 'R', 0.8);
    expect(knuckle.quaternion.angleTo(splayed)).toBeLessThan(EXACT);
    const recorded = rig.armStateForBodyInitialization('R');
    expect(recorded.curls.index).toBe(0.8);
    expect(recorded.spread.index).toBe(0.3);

    // Re-enabling re-seeds the constrained arm from the record.
    rig.limitsEnabled = true;
    expect(knuckle.quaternion.angleTo(splayed)).toBeLessThan(1e-6);
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

it('keeps finger axes and curled bones invariant under helper sibling ordering', () => {
  const hands = [undefined, 'before', 'after'].map((fingerHelpers) => {
    const built = buildRig({ fingerHelpers: fingerHelpers as 'before' | 'after' | undefined });
    const profile = buildProfile(built.root, built.descriptor);
    const rig = new Rig(profile);
    for (const side of SIDES)
      rig.curlHand(side, { thumb: 0.7, index: 0.6 }, { thumb: 0.2, index: -0.1 });
    built.root.updateMatrixWorld(true);
    return { profile, rig };
  });
  for (const side of SIDES) {
    for (const finger of ['thumb', 'index'] as const) {
      const baseline = need(hands[0].profile.fingerBones[`${finger}.${side}`], 'baseline');
      for (const actual of hands.slice(1)) {
        const chain = need(actual.profile.fingerBones[`${finger}.${side}`], 'actual');
        for (let i = 0; i < chain.length; i++) {
          expect
            .soft(actual.rig.fingerAxis.get(chain[i])?.toArray())
            .toEqual(hands[0].rig.fingerAxis.get(baseline[i])?.toArray());
          expect
            .soft(actual.rig.fingerSplayAxis.get(chain[i])?.toArray())
            .toEqual(hands[0].rig.fingerSplayAxis.get(baseline[i])?.toArray());
          expect.soft(chain[i].quaternion.toArray()).toEqual(baseline[i].quaternion.toArray());
          expect.soft(chain[i].matrixWorld.elements).toEqual(baseline[i].matrixWorld.elements);
        }
      }
    }
  }
});
