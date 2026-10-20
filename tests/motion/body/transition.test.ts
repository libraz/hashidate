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

  it('clears the fingers by no more turn of the hand than a wrist deviates comfortably', () => {
    const { free } = JOINTS.wrist.dofs.deviation;
    const h = harness();
    const hand = h.profile.bones['hand.R'];
    if (!hand) throw new Error('rig incomplete');
    const curl = h.rig.curlHand.bind(h.rig);
    const before = new THREE.Quaternion();
    let worst = 0;
    h.rig.curlHand = (side, spec, spread) => {
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
    const upper = h.profile.bones['upperArm.R'];
    const lower = h.profile.bones['lowerArm.R'];
    const hand = h.profile.bones['hand.R'];
    const chest = h.profile.bones.chest ?? h.profile.bones.spine;
    if (!(upper && lower && hand && chest && h.profile.body)) throw new Error('rig incomplete');
    const wp = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3());
    // The front of the arm at rest, carried in the bone: the way an elbow folds.
    h.profile.root?.updateMatrixWorld(true);
    const q0 = upper.getWorldQuaternion(new THREE.Quaternion());
    const along0 = wp(lower).sub(wp(upper)).normalize();
    const front = h.profile.body.forward
      .clone()
      .applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion()));
    front.addScaledVector(along0, -front.dot(along0)).normalize().applyQuaternion(q0.invert());

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
