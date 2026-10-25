import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINGER_WIDTH, JOINTS } from '@/engine/anatomy';
import type { JointReading, Side } from '@/engine/types';
import { DT, fingerDepth, type Harness, harness } from './harness';

/**
 * What an arm passes through between two poses.
 *
 * Both ends of a switch can be comfortable and the way between them not: a
 * blend that turns the forearm about the humerus winds the palm onto a stop, and
 * an arc between two points on the head can run through it. Each case here is a
 * pair whose path did that while its ends were fine.
 */

/** Hold `from`, switch to `to`, and hand back what `read` sees on each frame after. */
function across<T = JointReading[]>(
  from: string,
  to: string,
  side: Side,
  frames = 60,
  read: (h: Harness) => T = (h) => (h.rig.measure(side) ?? []) as T,
): T[] {
  const h = harness();
  const step = (x: Harness) => {
    x.rig.reset();
    x.body.update(DT);
  };
  step(h);
  h.body.play(from);
  for (let i = 0; i < 180; i++) step(h);
  h.body.play(to);
  const out: T[] = [];
  for (let i = 0; i < frames; i++) {
    step(h);
    out.push(read(h));
  }
  return out;
}

const reading = (frame: JointReading[], id: string) => frame.find((r) => r.id === id);

/** Signed wrist deviation from the actual hand, forearm, and finger-bone directions. */
function actualWristDeviation(h: Harness): number {
  const lower = h.profile.bones['lowerArm.R'];
  const hand = h.profile.bones['hand.R'];
  const middle = h.profile.fingerBones['middle.R']?.[0];
  const index = h.profile.fingerBones['index.R']?.[0];
  const little = h.profile.fingerBones['little.R']?.[0];
  if (!(lower && hand && middle && index && little))
    throw new Error('synthetic rig is missing wrist-oracle bones');

  const unit = (vector: THREE.Vector3, label: string): THREE.Vector3 => {
    const lengthSq = vector.lengthSq();
    if (
      !([vector.x, vector.y, vector.z].every(Number.isFinite) && Number.isFinite(lengthSq)) ||
      lengthSq <= 1e-12
    ) {
      throw new Error(`wrist oracle has degenerate ${label}`);
    }
    return vector.normalize();
  };
  const world = (bone: THREE.Object3D): THREE.Vector3 => {
    bone.updateWorldMatrix(true, false);
    return bone.getWorldPosition(new THREE.Vector3());
  };
  const lowerToHand = unit(world(hand).sub(world(lower)), 'forearm direction');
  const handToMiddle = unit(world(middle).sub(world(hand)), 'middle finger direction');
  const across = world(index).sub(world(little));
  const palmNormal = unit(handToMiddle.clone().cross(across), 'palm normal');
  const radial = unit(palmNormal.clone().cross(lowerToHand), 'wrist radial direction');
  if (radial.dot(across) < 0) radial.negate();

  const cosine = THREE.MathUtils.clamp(lowerToHand.dot(handToMiddle), -1, 1);
  const tangent = handToMiddle.clone().addScaledVector(lowerToHand, -cosine);
  const sine = tangent.length();
  const angle = Math.atan2(sine, cosine);
  const deviation = sine === 0 ? 0 : angle * tangent.normalize().dot(radial);
  if (!Number.isFinite(deviation)) throw new Error('wrist oracle produced a non-finite deviation');
  return deviation;
}

describe('the path between two poses', () => {
  beforeEach(() => {
    // One-handed poses pick their hand at random; these are written for the right.
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the cheek for a wave without folding the elbow or winding the forearm onto a stop', () => {
    for (const frame of across('cheekPoints', 'wave', 'R')) {
      for (const id of ['elbow', 'forearm', 'wristFlex']) {
        expect(reading(frame, id)?.zone, id).not.toBe('limit');
      }
    }
  });

  it('never turns the forearm faster than a limb can, leaving the ear for a cheer', () => {
    const roll = across('whisper', 'bravo', 'R').map((f) => reading(f, 'forearm')?.deg ?? 0);
    const steps = roll.slice(1).map((r, i) => Math.abs(r - roll[i]));
    // The limiter's own slew, fourteen radians a second, plus rounding.
    expect(Math.max(...steps)).toBeLessThan((14 * DT * 180) / Math.PI + 0.5);
  });

  it('brings a hand from the mouth to behind the ear round the face rather than through it', () => {
    const depth = across('cover', 'listen', 'R').map((f) => reading(f, 'torso')?.deg ?? 0);
    expect(Math.max(...depth)).toBeLessThan(15);
  });

  it('keeps the fingers out of the face while the hand turns from the ear to the mouth', () => {
    const half = 0.5 * FINGER_WIDTH * (harness().profile.limb?.['pitch.R'] ?? 0);
    const depth = across('listen', 'cover', 'R', 60, (h) => fingerDepth(h, 'R'));
    // Unturned, the fingers swept through the cheek more than a finger deep.
    expect(half).toBeGreaterThan(0);
    expect(Math.max(...depth)).toBeLessThan(half);
  });

  it('keeps the legacy clearance correction below the comfortable wrist deviation', () => {
    const { free } = JOINTS.wrist.dofs.deviation;
    const h = harness();
    h.rig.limitsEnabled = false;
    const hand = h.profile.bones['hand.R'];
    if (!hand) throw new Error('rig incomplete');
    const curl = h.rig.curlHandLegacy.bind(h.rig);
    const before = new THREE.Quaternion();
    let worst = 0;
    h.rig.curlHandLegacy = (side, spec, spread) => {
      before.copy(hand.quaternion);
      curl(side, spec, spread);
      if (side === 'R') worst = Math.max(worst, before.angleTo(hand.quaternion));
    };
    const step = () => {
      h.rig.reset();
      h.body.update(DT);
    };
    step();
    h.body.play('listen');
    for (let i = 0; i < 180; i++) step();
    h.body.play('cover');
    for (let i = 0; i < 60; i++) step();
    expect(worst).toBeGreaterThan(1e-3);
    expect(worst).toBeLessThanOrEqual(free[1] - free[0] + 1e-6);
  });

  it('clears the fingers by no more turn of the hand than a wrist deviates comfortably', () => {
    const h = harness();
    h.rig.limitsEnabled = true;
    expect(h.rig.limitsEnabled).toBe(true);
    expect(h.rig.armDriver('R')).not.toBeNull();
    const hand = h.profile.bones['hand.R'];
    if (!hand) throw new Error('rig incomplete');

    const step = () => {
      h.rig.reset();
      h.body.update(DT);
    };
    step();
    h.body.play('listen');
    for (let i = 0; i < 180; i++) step();
    const [minimumDeviation, maximumDeviation] = h.rig.joints.wrist.dofs.deviation.free;
    // The listen hold itself sits inside the comfortable deviation band.
    const listenDeviation = actualWristDeviation(h);
    expect(listenDeviation).toBeGreaterThanOrEqual(minimumDeviation - 1e-6);
    expect(listenDeviation).toBeLessThanOrEqual(maximumDeviation + 1e-6);

    hand.updateWorldMatrix(true, false);
    const heldWorldOrientation = hand.getWorldQuaternion(new THREE.Quaternion());
    const clearance = h.rig.fingerClearance('R');
    expect(clearance).toBeGreaterThan(0);
    const transitionCommits = vi.spyOn(h.rig, 'commitArmFrame');
    let greatestHandTurn = 0;

    h.body.play('cover');
    const deviations: number[] = [];
    for (let i = 0; i < 60; i++) {
      step();
      const deviation = actualWristDeviation(h);
      expect(Number.isFinite(deviation)).toBe(true);
      deviations.push(deviation);
      expect(fingerDepth(h, 'R')).toBeLessThan(clearance);

      hand.updateWorldMatrix(true, false);
      const currentWorldOrientation = hand.getWorldQuaternion(new THREE.Quaternion());
      greatestHandTurn = Math.max(
        greatestHandTurn,
        heldWorldOrientation.angleTo(currentWorldOrientation),
      );
    }
    expect(
      transitionCommits.mock.results.some(
        (result) => result.type === 'return' && result.value === true,
      ),
    ).toBe(true);
    expect(greatestHandTurn).toBeGreaterThan(1e-3);

    for (let i = 0; i < 120; i++) step();
    const goal = actualWristDeviation(h);
    // The clearance turn is part of the solved wrist, so the path may not turn it
    // past both the comfortable band and where the hold itself needs it (cover's
    // palm needs the ulnar stop). With the hold on that stop the lower bound is the
    // stop itself, so here it is the radial side that binds.
    for (const deviation of deviations) {
      expect(deviation).toBeGreaterThanOrEqual(Math.min(minimumDeviation, goal) - 1e-6);
      expect(deviation).toBeLessThanOrEqual(Math.max(maximumDeviation, goal) + 1e-6);
    }
  });
});

describe('the humerus under a bent elbow', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns with the arm so the elbow folds about its own hinge', () => {
    const h = harness();
    // Constructing the body poses the arms; the front is read off the bind pose.
    h.rig.reset();
    h.profile.root?.updateMatrixWorld(true);
    const upper = h.profile.bones['upperArm.R'];
    const lower = h.profile.bones['lowerArm.R'];
    const hand = h.profile.bones['hand.R'];
    const chest = h.profile.bones.chest ?? h.profile.bones.spine;
    if (!(upper && lower && hand && chest && h.profile.body)) throw new Error('rig incomplete');
    const wp = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3());
    // The front of the arm at rest, carried in the bone: the way an elbow folds.
    const q0 = upper.getWorldQuaternion(new THREE.Quaternion());
    const along0 = wp(lower).sub(wp(upper)).normalize();
    const front = h.profile.body.forward
      .clone()
      .applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion()));
    front.addScaledVector(along0, -front.dot(along0));
    expect([front.x, front.y, front.z].every(Number.isFinite)).toBe(true);
    expect(front.length()).toBeGreaterThan(1e-6);
    front.normalize().applyQuaternion(q0.invert());

    const off: number[] = [];
    for (const g of ['listen', 'pointUp', 'sparkle', 'stretch', 'bothPeace']) {
      h.rig.reset();
      h.body.update(DT);
      h.body.play(g);
      for (let i = 0; i < 180; i++) {
        h.rig.reset();
        h.body.update(DT);
      }
      h.profile.root?.updateMatrixWorld(true);
      const u = wp(lower).sub(wp(upper)).normalize();
      const l = wp(hand).sub(wp(lower)).normalize();
      if (Math.acos(u.dot(l)) < 0.8) continue;
      const fold = l.addScaledVector(u, -l.dot(u)).normalize();
      const now = front.clone().applyQuaternion(upper.getWorldQuaternion(new THREE.Quaternion()));
      now.addScaledVector(u, -now.dot(u)).normalize();
      off.push((Math.acos(THREE.MathUtils.clamp(now.dot(fold), -1, 1)) * 180) / Math.PI);
    }
    expect(off.length).toBeGreaterThan(2);
    expect(Math.max(...off)).toBeLessThan(5);
  });
});
