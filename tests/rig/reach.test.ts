import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { JOINTS } from '@/engine/anatomy';
import { buildProfile } from '@/engine/profile';
import type { ReachLinks } from '@/engine/rig';
import { poleAngle, Rig, reachRef, solveReach } from '@/engine/rig';
import type { Profile, Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

/**
 * Two-link reach geometry.
 *
 * The one thing this solver exists to do is put the wrist on a point, so most of
 * what is pinned here is walked out of the returned directions —
 * `shoulder + upperArm*La + lowerArm*Lf` — rather than read off an intermediate.
 */

/**
 * The solve is closed form, so a wrist that is asked for and granted lands on
 * its target to floating-point precision. Anything looser would fail to notice
 * an arm that solved to the wrong branch.
 */
const EXACT = 1e-9;

/** Directions leave `normalize`, so nothing wider than accumulated rounding. */
const UNIT = 1e-12;

/** Two solves of the same request differ only by rounding; a real change is orders larger. */
const STABLE = 1e-9;

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

/** A rig with its world matrices current and the body frame refreshed. */
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

const links = (): ReachLinks => ({
  upperArm: new THREE.Vector3(),
  lowerArm: new THREE.Vector3(),
});

/** Where the chain actually puts the wrist, walked from the shoulder. */
const wristOf = (arm: Arm, out: ReachLinks): THREE.Vector3 =>
  arm.shoulder
    .clone()
    .addScaledVector(out.upperArm, arm.upperLen)
    .addScaledVector(out.lowerArm, arm.foreLen);

/** Where the chain puts the elbow. */
const elbowOf = (arm: Arm, out: ReachLinks): THREE.Vector3 =>
  arm.shoulder.clone().addScaledVector(out.upperArm, arm.upperLen);

/** The angle the anatomy layer would read as elbow flexion: 0 straight, pi folded. */
const elbowFlexion = (out: ReachLinks): number =>
  Math.acos(THREE.MathUtils.clamp(out.upperArm.dot(out.lowerArm), -1, 1));

const solve = (arm: Arm, target: THREE.Vector3, angle: number, out: ReachLinks) =>
  solveReach(arm.profile, arm.rig.joints, arm.rig.anat, arm.side, target, angle, out);

describe('solveReach', () => {
  it('puts the wrist on a target inside the annulus', () => {
    const arm = buildArm();
    const out = links();
    // Forward, down and slightly inboard of the shoulder: comfortably between
    // the near and far bounds on either arm.
    const target = arm.shoulder.clone().add(new THREE.Vector3(-0.05, -0.05, -0.2));

    expect(solve(arm, target, 0, out)).toBe(out);
    expect(wristOf(arm, out).distanceTo(target)).toBeLessThan(EXACT);
  });

  it('holds the wrist on target across the whole reachable range of distances', () => {
    const arm = buildArm();
    const out = links();
    const bearing = new THREE.Vector3(-0.3, -0.7, -0.6).normalize();

    for (const distance of [0.1, 0.15, 0.2, 0.25, 0.3, 0.315]) {
      const target = arm.shoulder.clone().addScaledVector(bearing, distance);
      expect(solve(arm, target, 0.4, out)).not.toBeNull();
      expect(wristOf(arm, out).distanceTo(target)).toBeLessThan(EXACT);
    }
  });

  it('returns unit directions for both links', () => {
    const arm = buildArm();
    const out = links();
    const target = arm.shoulder.clone().add(new THREE.Vector3(-0.05, -0.1, -0.18));

    for (const angle of [-2.2, -0.7, 0, 0.9, 2.8]) {
      solve(arm, target, angle, out);
      expect(out.upperArm.length()).toBeCloseTo(1, 12);
      expect(out.lowerArm.length()).toBeCloseTo(1, 12);
      expect(Math.abs(out.upperArm.length() - 1)).toBeLessThan(UNIT);
      expect(Math.abs(out.lowerArm.length() - 1)).toBeLessThan(UNIT);
    }
  });

  it('points at a target beyond its reach and falls short rather than failing', () => {
    const arm = buildArm();
    const out = links();
    const bearing = new THREE.Vector3(0, -0.2, -1).normalize();
    const target = arm.shoulder.clone().addScaledVector(bearing, 1);

    expect(solve(arm, target, 0, out)).toBe(out);
    const wrist = wristOf(arm, out);
    const span = arm.upperLen + arm.foreLen;
    // Inside the annulus it was clamped into...
    expect(wrist.distanceTo(arm.shoulder)).toBeLessThanOrEqual(span);
    // ...but as far out along it as the arm goes.
    expect(wrist.distanceTo(arm.shoulder)).toBeGreaterThan(span * 0.99);
    // Still aimed at what it could not touch.
    expect(wrist.clone().sub(arm.shoulder).angleTo(bearing)).toBeLessThan(0.05);
    expect(wrist.distanceTo(target)).toBeGreaterThan(0.5);
  });

  it('bounds the near side by the elbow flexion limit and not by |La - Lf|', () => {
    const arm = buildArm();
    const out = links();
    const bearing = new THREE.Vector3(0, 0, -1);
    // 0.03 is outside the geometric near bound |La - Lf| = 0.02, so a solver
    // clamping on the figure alone would grant this target exactly. The elbow's
    // 150 degree stop puts the real near bound at roughly 0.085, so it must not
    // be granted.
    const geometric = Math.abs(arm.upperLen - arm.foreLen);
    const target = arm.shoulder.clone().addScaledVector(bearing, 0.03);
    expect(0.03).toBeGreaterThan(geometric);

    expect(solve(arm, target, 0, out)).toBe(out);
    expect(wristOf(arm, out).distanceTo(target)).toBeGreaterThan(1e-3);
  });

  // The contract the source states: a target nearer than 150 degrees of flexion
  // allows stops short along the same bearing, so the joint clamp downstream
  // never has to take back what the solver granted.
  //
  // This holds only because the forearm closes onto the *clamped* point. Aiming
  // it at the raw request instead leaves the upper arm stopping short while the
  // forearm does not, which folds the elbow back past the bound the clamp above
  // has just established.
  it('keeps a very near target inside the elbow flexion stop', () => {
    const arm = buildArm();
    const out = links();
    const target = arm.shoulder.clone().add(new THREE.Vector3(0, 0, -0.03));

    solve(arm, target, 0, out);
    expect(elbowFlexion(out)).toBeLessThanOrEqual(JOINTS.elbow.dofs.flexion.max[1]);
  });

  // The other half of the same contract: stopping short happens *along the same
  // bearing*, so the hand reads as an arm that cannot quite reach rather than as
  // one that has swung off to the side.
  it('stops a very near target short along the same bearing', () => {
    const arm = buildArm();
    const out = links();
    const bearing = new THREE.Vector3(0, 0, -1);
    const target = arm.shoulder.clone().addScaledVector(bearing, 0.03);

    solve(arm, target, 0, out);
    const wrist = wristOf(arm, out);
    expect(wrist.clone().sub(arm.shoulder).angleTo(bearing)).toBeLessThan(0.02);
    expect(wrist.distanceTo(arm.shoulder)).toBeGreaterThan(0.03);
  });

  it('grants a target sitting exactly on the flexion-derived near bound', () => {
    const arm = buildArm();
    const out = links();
    const flexMax = JOINTS.elbow.dofs.flexion.max[1];
    const fold = Math.cos(Math.PI - flexMax);
    const near =
      Math.sqrt(
        arm.upperLen * arm.upperLen +
          arm.foreLen * arm.foreLen -
          2 * arm.upperLen * arm.foreLen * fold,
      ) * 1.001;
    const target = arm.shoulder.clone().add(new THREE.Vector3(0, 0, -near));

    solve(arm, target, 0, out);
    expect(wristOf(arm, out).distanceTo(target)).toBeLessThan(1e-4);
    expect(elbowFlexion(out)).toBeLessThanOrEqual(flexMax);
  });

  it('moves the elbow around the reach line while the wrist stays put', () => {
    const arm = buildArm();
    const out = links();
    const target = arm.shoulder.clone().add(new THREE.Vector3(-0.06, -0.08, -0.19));
    const elbows: THREE.Vector3[] = [];

    for (const angle of [-2.5, -1.2, 0, 1.2, 2.5]) {
      expect(solve(arm, target, angle, out)).not.toBeNull();
      expect(wristOf(arm, out).distanceTo(target)).toBeLessThan(EXACT);
      elbows.push(elbowOf(arm, out));
    }

    // Every elbow sits on one circle about the shoulder, at a distinct place on it.
    for (const elbow of elbows) {
      expect(elbow.distanceTo(arm.shoulder)).toBeCloseTo(arm.upperLen, 9);
    }
    for (let i = 0; i < elbows.length; i++) {
      for (let j = i + 1; j < elbows.length; j++) {
        expect(elbows[i].distanceTo(elbows[j])).toBeGreaterThan(0.01);
      }
    }
  });

  it('refuses a target sitting on the shoulder itself', () => {
    const arm = buildArm();
    expect(solve(arm, arm.shoulder.clone(), 0, links())).toBeNull();
  });

  it('refuses an arm the profile has no segment lengths for', () => {
    const arm = buildArm();
    arm.profile.limb['upper.R'] = 0;
    const target = arm.shoulder.clone().add(new THREE.Vector3(0, -0.1, -0.2));
    expect(solve(arm, target, 0, links())).toBeNull();
  });
});

describe('reachRef', () => {
  it('returns a unit reference perpendicular to the reach line', () => {
    const arm = buildArm();
    const perp = new THREE.Vector3();

    for (const n of [
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-0.4, -0.6, -0.7).normalize(),
    ]) {
      reachRef(arm.rig.anat, n, perp);
      expect(Math.abs(perp.length() - 1)).toBeLessThan(UNIT);
      expect(Math.abs(perp.dot(n))).toBeLessThan(UNIT);
    }
  });

  it('falls back off forward when the reach itself runs forward', () => {
    const arm = buildArm();
    const anat = arm.rig.anat;
    const perp = new THREE.Vector3();

    // Away from forward, forward is the reference.
    reachRef(anat, anat.up.clone().negate(), perp);
    expect(perp.dot(anat.fwd)).toBeGreaterThan(0.99);

    // Along it, forward says nothing, so up takes over — and is still perpendicular.
    reachRef(anat, anat.fwd.clone(), perp);
    expect(Math.abs(perp.dot(anat.fwd))).toBeLessThan(UNIT);
    expect(Math.abs(perp.dot(anat.up))).toBeGreaterThan(0.99);
  });
});

describe('poleAngle', () => {
  it('round-trips: solving with the angle puts the elbow on the pole side', () => {
    const arm = buildArm();
    const out = links();
    const target = arm.shoulder.clone().add(new THREE.Vector3(-0.05, -0.05, -0.2));
    const reach = target.clone().sub(arm.shoulder).normalize();

    // Poles all round the reach line, each well off it.
    for (const offset of [
      new THREE.Vector3(0.3, -0.3, 0),
      new THREE.Vector3(-0.25, -0.2, 0.1),
      new THREE.Vector3(0.1, 0.3, 0.05),
      new THREE.Vector3(0, -0.35, -0.05),
    ]) {
      const pole = arm.shoulder.clone().add(offset);
      const angle = poleAngle(arm.profile, arm.rig.anat, arm.side, target, pole);
      expect(angle).not.toBeNull();

      expect(solve(arm, target, angle as number, out)).not.toBeNull();
      const fromLine = (p: THREE.Vector3) => {
        const v = p.clone().sub(arm.shoulder);
        return v.addScaledVector(reach, -v.dot(reach)).normalize();
      };
      // Same side of the reach line, and in fact the same bearing about it.
      expect(fromLine(elbowOf(arm, out)).dot(fromLine(pole))).toBeGreaterThan(1 - EXACT);
      // The wrist is unaffected by where the pole put the elbow.
      expect(wristOf(arm, out).distanceTo(target)).toBeLessThan(EXACT);
    }
  });

  it('returns null for a pole sitting on the reach line', () => {
    const arm = buildArm();
    const target = arm.shoulder.clone().add(new THREE.Vector3(-0.05, -0.05, -0.2));
    const reach = target.clone().sub(arm.shoulder).normalize();
    const pole = arm.shoulder.clone().addScaledVector(reach, 0.2);

    expect(poleAngle(arm.profile, arm.rig.anat, arm.side, target, pole)).toBeNull();
  });

  it('returns null for a near-parallel pole whose residue is still long', () => {
    const arm = buildArm();
    const target = arm.shoulder.clone().add(new THREE.Vector3(-0.05, -0.05, -0.2));
    const reach = target.clone().sub(arm.shoulder).normalize();
    const side = new THREE.Vector3(0, 1, 0);
    side.addScaledVector(reach, -side.dot(reach)).normalize();

    // A metre down the reach line and 0.1 off it: the residue is 0.1 long, which
    // is three times the whole arm and would pass any bare length test, but the
    // sine of the angle is 0.0995 and the direction it implies is noise.
    const pole = arm.shoulder.clone().addScaledVector(reach, 1).addScaledVector(side, 0.1);
    const residue = pole.clone().sub(arm.shoulder);
    residue.addScaledVector(reach, -residue.dot(reach));
    expect(residue.length()).toBeGreaterThan(arm.upperLen / 2);

    expect(poleAngle(arm.profile, arm.rig.anat, arm.side, target, pole)).toBeNull();
  });

  it('accepts the same offset once it is far enough off the line to mean something', () => {
    const arm = buildArm();
    const target = arm.shoulder.clone().add(new THREE.Vector3(-0.05, -0.05, -0.2));
    const reach = target.clone().sub(arm.shoulder).normalize();
    const side = new THREE.Vector3(0, 1, 0);
    side.addScaledVector(reach, -side.dot(reach)).normalize();

    // sin 0.25 is the gate; 0.5 off a 1.0 run is a sine of 0.447.
    const pole = arm.shoulder.clone().addScaledVector(reach, 1).addScaledVector(side, 0.5);
    expect(poleAngle(arm.profile, arm.rig.anat, arm.side, target, pole)).not.toBeNull();
  });

  it('returns null for a pole sitting on the shoulder', () => {
    const arm = buildArm();
    const target = arm.shoulder.clone().add(new THREE.Vector3(-0.05, -0.05, -0.2));
    expect(poleAngle(arm.profile, arm.rig.anat, arm.side, target, arm.shoulder.clone())).toBeNull();
  });

  it('does not share scratch with the solve it feeds', () => {
    const arm = buildArm();
    const target = arm.shoulder.clone().add(new THREE.Vector3(-0.05, -0.05, -0.2));
    const pole = arm.shoulder.clone().add(new THREE.Vector3(0.3, -0.3, 0));
    const out = links();

    const first = poleAngle(arm.profile, arm.rig.anat, arm.side, target, pole);
    solve(arm, target, first as number, out);
    const again = poleAngle(arm.profile, arm.rig.anat, arm.side, target, pole);

    expect(Math.abs((again as number) - (first as number))).toBeLessThan(STABLE);
  });
});
