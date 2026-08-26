import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import type { ArmSolution, PointRequest } from '@/engine/rig';
import { Rig } from '@/engine/rig';
import type { FingerName, Profile, Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

/**
 * Fingertip back-solve.
 *
 * The request is a bearing in the body's own frame and the answer is a chain
 * that ends at the wrist, so the two things worth pinning are that the bearing
 * is read in the frame it claims and that the hand's own length is taken out of
 * the target before the two-link solve sees it.
 */

/** The chain is placed by a closed-form solve, so the wrist lands to rounding. */
const EXACT = 1e-9;

/**
 * How far the elbow may drift while a pose is merely held, as a fraction of the
 * upper arm. The search damps toward its answer, so a settled pose should be
 * still; the failure this guards against swung the elbow through tens of degrees.
 */
const HELD_DRIFT = 0.02;

interface Arm {
  profile: Profile;
  rig: Rig;
  side: Side;
  shoulder: THREE.Vector3;
  upperLen: number;
  foreLen: number;
}

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`synthetic rig has no ${what}`);
  return value;
}

function buildArm(side: Side = 'R'): Arm {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  rig.anat.update();
  const bone = need(profile.bones[`upperArm.${side}`], `upperArm.${side}`);
  bone.updateWorldMatrix(true, false);
  return {
    profile,
    rig,
    side,
    shoulder: bone.getWorldPosition(new THREE.Vector3()),
    upperLen: need(profile.limb[`upper.${side}`], `upper.${side}`),
    foreLen: need(profile.limb[`lower.${side}`], `lower.${side}`),
  };
}

const solution = (): ArmSolution => ({
  upperArm: new THREE.Vector3(),
  lowerArm: new THREE.Vector3(),
  hand: new THREE.Vector3(),
  palm: new THREE.Vector3(),
  tip: new THREE.Vector3(),
  twist: 0,
});

const wristOf = (arm: Arm, out: ArmSolution): THREE.Vector3 =>
  arm.shoulder
    .clone()
    .addScaledVector(out.upperArm, arm.upperLen)
    .addScaledVector(out.lowerArm, arm.foreLen);

const elbowOf = (arm: Arm, out: ArmSolution): THREE.Vector3 =>
  arm.shoulder.clone().addScaledVector(out.upperArm, arm.upperLen);

const solve = (arm: Arm, spec: PointRequest, out: ArmSolution) =>
  arm.rig.solvePoint(arm.side, spec, out);

describe('solvePoint bearing', () => {
  it('reads the bearing in the body frame, not in world axes', () => {
    const arm = buildArm();
    const anat = arm.rig.anat;
    const out = solution();

    for (const [azimuth, elevation] of [
      [0, 0],
      [0.7, 0],
      [-0.7, 0],
      [0, 0.6],
      [0, -0.6],
      [0.5, 0.4],
    ]) {
      expect(solve(arm, { azimuth, elevation, extent: 0.8 }, out)).toBe(out);
      const want = anat.fwd
        .clone()
        .multiplyScalar(Math.cos(elevation) * Math.cos(azimuth))
        .addScaledVector(anat.right, Math.cos(elevation) * Math.sin(azimuth))
        .addScaledVector(anat.up, Math.sin(elevation))
        .normalize();
      const got = out.tip.clone().sub(arm.shoulder).normalize();
      expect(got.distanceTo(want)).toBeLessThan(EXACT);
    }
  });

  it('sends azimuth 0 forward, positive azimuth to the character right, positive elevation up', () => {
    const arm = buildArm();
    const anat = arm.rig.anat;
    const out = solution();

    // Ground the frame in the skeleton: the character's left hand is the side
    // `right` must point away from.
    const leftHand = need(arm.profile.bones['hand.L'], 'hand.L').getWorldPosition(
      new THREE.Vector3(),
    );
    const rightHand = need(arm.profile.bones['hand.R'], 'hand.R').getWorldPosition(
      new THREE.Vector3(),
    );
    expect(rightHand.clone().sub(leftHand).normalize().dot(anat.right)).toBeGreaterThan(0.99);

    const bearing = (spec: PointRequest) => {
      solve(arm, spec, out);
      return out.tip.clone().sub(arm.shoulder).normalize();
    };

    expect(bearing({ azimuth: 0, elevation: 0, extent: 0.8 }).dot(anat.fwd)).toBeGreaterThan(0.999);
    expect(bearing({ azimuth: 0.9, elevation: 0, extent: 0.8 }).dot(anat.right)).toBeGreaterThan(
      0.5,
    );
    expect(bearing({ azimuth: -0.9, elevation: 0, extent: 0.8 }).dot(anat.right)).toBeLessThan(
      -0.5,
    );
    expect(bearing({ azimuth: 0, elevation: 0.9, extent: 0.8 }).dot(anat.up)).toBeGreaterThan(0.5);
    expect(bearing({ azimuth: 0, elevation: -0.9, extent: 0.8 }).dot(anat.up)).toBeLessThan(-0.5);
  });

  it('places the fingertip at the requested extent of the full reach', () => {
    const arm = buildArm();
    const out = solution();
    const tipLen = need(arm.profile.limb[`tip.${arm.side}.index`], 'tip length');
    const reach = arm.upperLen + arm.foreLen + tipLen;

    for (const extent of [0.4, 0.6, 0.8, 1]) {
      solve(arm, { azimuth: 0.2, elevation: 0.1, extent }, out);
      expect(out.tip.distanceTo(arm.shoulder)).toBeCloseTo(reach * extent, 9);
    }
  });
});

describe('solvePoint hand length', () => {
  it('lands the fingertip on the target and the wrist a fingertip back from it', () => {
    const arm = buildArm();
    const out = solution();
    const tipLen = need(arm.profile.limb[`tip.${arm.side}.index`], 'tip length');

    solve(arm, { azimuth: 0.25, elevation: 0.15, extent: 0.7 }, out);
    const wrist = wristOf(arm, out);

    // The hand is not ignored: the wrist sits a whole fingertip length short of
    // the point being indicated, along the direction the finger points.
    expect(out.tip.distanceTo(wrist)).toBeCloseTo(tipLen, 9);
    expect(out.tip.clone().sub(wrist).normalize().dot(out.hand)).toBeGreaterThan(1 - EXACT);
    // And that length is a real fraction of the forearm, not a rounding detail.
    expect(tipLen).toBeGreaterThan(arm.foreLen * 0.25);
  });

  it('leaves the finger pointing along the bearing unless told otherwise', () => {
    const arm = buildArm();
    const anat = arm.rig.anat;
    const out = solution();

    solve(arm, { azimuth: 0.3, elevation: 0.2, extent: 0.75 }, out);
    const want = anat.fwd
      .clone()
      .multiplyScalar(Math.cos(0.2) * Math.cos(0.3))
      .addScaledVector(anat.right, Math.cos(0.2) * Math.sin(0.3))
      .addScaledVector(anat.up, Math.sin(0.2))
      .normalize();
    expect(out.hand.distanceTo(want)).toBeLessThan(EXACT);

    // An explicit point direction overrides it, and the wrist backs off along
    // that direction instead. Held at half extent so the displaced wrist is
    // still inside the annulus and the solve is not clamped.
    const stated = new THREE.Vector3(0, -1, 0);
    solve(arm, { azimuth: 0.3, elevation: 0.2, extent: 0.5, point: stated }, out);
    expect(out.hand.distanceTo(stated)).toBeLessThan(EXACT);
    const tipLen = need(arm.profile.limb[`tip.${arm.side}.index`], 'tip length');
    const backedOff = out.tip.clone().addScaledVector(stated, -tipLen);
    expect(wristOf(arm, out).distanceTo(backedOff)).toBeLessThan(EXACT);
  });

  it('uses the named finger tip length, so a thumb and a middle finger differ', () => {
    const thumbArm = buildArm();
    const middleArm = buildArm();
    const thumb = solution();
    const middle = solution();
    const spec = { azimuth: 0.3, elevation: 0.2, extent: 0.7 };

    solve(thumbArm, { ...spec, finger: 'thumb' as FingerName }, thumb);
    solve(middleArm, { ...spec, finger: 'middle' as FingerName }, middle);

    const thumbLen = need(thumbArm.profile.limb['tip.R.thumb'], 'tip.R.thumb');
    const middleLen = need(middleArm.profile.limb['tip.R.middle'], 'tip.R.middle');
    expect(thumbLen).not.toBeCloseTo(middleLen, 4);

    expect(thumb.tip.distanceTo(wristOf(thumbArm, thumb))).toBeCloseTo(thumbLen, 9);
    expect(middle.tip.distanceTo(wristOf(middleArm, middle))).toBeCloseTo(middleLen, 9);
    // Same bearing, same extent, different wrist.
    expect(wristOf(thumbArm, thumb).distanceTo(wristOf(middleArm, middle))).toBeGreaterThan(1e-4);
  });

  it('falls back to the index finger for a finger the rig does not have', () => {
    const named = buildArm();
    const fallback = buildArm();
    const a = solution();
    const b = solution();
    delete fallback.profile.limb['tip.R.little'];
    const spec = { azimuth: 0.1, elevation: 0.1, extent: 0.7, finger: 'little' as FingerName };

    solve(named, { ...spec, finger: 'index' as FingerName }, a);
    solve(fallback, spec, b);
    expect(b.tip.distanceTo(a.tip)).toBeLessThan(EXACT);
  });
});

describe('solvePoint strain', () => {
  it('reports a cost that rises for a bearing the arm has to strain into', () => {
    const ahead = buildArm();
    const across = buildArm();
    const overhead = buildArm();
    const easy = solution();
    const hard = solution();
    const high = solution();

    solve(ahead, { azimuth: 0, elevation: 0, extent: 0.7 }, easy);
    solve(across, { azimuth: -1.5, elevation: 0, extent: 0.7 }, hard);
    solve(overhead, { azimuth: 0, elevation: 1.4, extent: 0.95 }, high);

    for (const value of [easy.strain, hard.strain, high.strain]) {
      expect(value).toBeTypeOf('number');
      expect(Number.isFinite(value)).toBe(true);
    }
    // Straight ahead at a moderate extent is the cheap pose.
    expect(easy.strain as number).toBeLessThan(high.strain as number);
    // Reaching across the body drives the arm into the trunk, which outbids
    // every joint term.
    expect(hard.strain as number).toBeGreaterThan((easy.strain as number) * 10);
  });
});

describe('solvePoint output ownership', () => {
  it('copies palm and tip rather than aliasing the shared scratch', () => {
    const arm = buildArm();
    const first = solution();
    const second = solution();

    solve(arm, { azimuth: 0.4, elevation: 0.3, extent: 0.7 }, first);
    const heldPalm = first.palm.clone();
    const heldTip = first.tip.clone();
    const heldHand = first.hand.clone();

    // A second solve, for a different bearing, through a different `out`.
    solve(arm, { azimuth: -0.8, elevation: -0.4, extent: 0.95 }, second);

    expect(first.palm).not.toBe(second.palm);
    expect(first.tip).not.toBe(second.tip);
    expect(first.palm.distanceTo(heldPalm)).toBe(0);
    expect(first.tip.distanceTo(heldTip)).toBe(0);
    expect(first.hand.distanceTo(heldHand)).toBe(0);
    // The second answer really is a different pose, so the check above is not
    // passing because nothing moved.
    expect(second.tip.distanceTo(heldTip)).toBeGreaterThan(0.05);
  });

  it('keeps one arm answer intact while the other arm solves', () => {
    const built = buildRig();
    const profile = buildProfile(built.root, built.descriptor);
    const rig = new Rig(profile);
    const left = solution();
    const right = solution();

    rig.solvePoint('L', { azimuth: -0.5, elevation: 0.3, extent: 0.8 }, left);
    const heldTip = left.tip.clone();
    const heldPalm = left.palm.clone();

    rig.solvePoint('R', { azimuth: 0.5, elevation: -0.3, extent: 0.6 }, right);

    expect(left.tip.distanceTo(heldTip)).toBe(0);
    expect(left.palm.distanceTo(heldPalm)).toBe(0);
    expect(right.tip.distanceTo(heldTip)).toBeGreaterThan(0.05);
  });
});

describe('solvePoint elbow search', () => {
  it('holds the elbow still while a pose is merely held', () => {
    const arm = buildArm();
    const out = solution();
    const spec = { azimuth: 0.2, elevation: 0.35, extent: 0.75 };

    solve(arm, spec, out);
    solve(arm, spec, out);
    let previous = elbowOf(arm, out);
    for (let i = 0; i < 12; i++) {
      solve(arm, spec, out);
      const elbow = elbowOf(arm, out);
      expect(elbow.distanceTo(previous)).toBeLessThan(EXACT);
      previous = elbow;
    }
  });

  it('barely moves the elbow for a target nudged by a hair', () => {
    const arm = buildArm();
    const out = solution();
    const spec = { azimuth: 0.2, elevation: 0.35, extent: 0.75 };

    for (let i = 0; i < 4; i++) solve(arm, spec, out);
    const settled = elbowOf(arm, out);

    solve(arm, { ...spec, elevation: spec.elevation + 0.002 }, out);
    expect(elbowOf(arm, out).distanceTo(settled)).toBeLessThan(arm.upperLen * HELD_DRIFT);
  });

  it('still moves the elbow for a genuine change of intent', () => {
    const arm = buildArm();
    const out = solution();
    const spec = { azimuth: 0.2, elevation: 0.35, extent: 0.75 };

    for (let i = 0; i < 4; i++) solve(arm, spec, out);
    const settled = elbowOf(arm, out);

    solve(arm, { azimuth: -1.2, elevation: -0.6, extent: 0.9 }, out);
    expect(elbowOf(arm, out).distanceTo(settled)).toBeGreaterThan(arm.upperLen * 0.5);
  });
});

describe('solvePoint guards', () => {
  it('clamps extent into the band the arm can be asked for', () => {
    const arm = buildArm();
    const low = solution();
    const high = solution();
    const tipLen = need(arm.profile.limb[`tip.${arm.side}.index`], 'tip length');
    const reach = arm.upperLen + arm.foreLen + tipLen;

    solve(arm, { azimuth: 0, elevation: 0, extent: -3 }, low);
    solve(arm, { azimuth: 0, elevation: 0, extent: 4 }, high);
    expect(low.tip.distanceTo(arm.shoulder)).toBeCloseTo(reach * 0.1, 9);
    expect(high.tip.distanceTo(arm.shoulder)).toBeCloseTo(reach, 9);
  });

  it('refuses an arm the profile has no segment lengths for', () => {
    const arm = buildArm();
    arm.profile.limb['lower.R'] = 0;
    expect(solve(arm, { azimuth: 0, elevation: 0, extent: 0.7 }, solution())).toBeNull();
  });
});
