import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JOINTS } from '@/engine/anatomy';
import { Body } from '@/engine/motion/body';
import { GESTURES } from '@/engine/motion/gestures';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type {
  BoneSlot,
  FingerName,
  GestureDef,
  GestureVariation,
  Profile,
  Side,
} from '@/engine/types';
import { buildRig } from '../helpers/scene';

/**
 * How a gesture gets from where the arm is to where the pose is.
 *
 * Measured at the wrist, because that is what a viewer watches and because it
 * is the one place the whole chain of decisions shows up: the envelope, the
 * follower, the link stagger and the reach path all end in where the hand is
 * this frame and how fast it is going. Nothing here asserts a pose — the poses
 * are the gesture table's and are not this layer's to change.
 */

const DT = 1 / 60;

interface Harness {
  body: Body;
  profile: Profile;
  rig: Rig;
}

function harness(): Harness {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const body = new Body(rig, profile);
  // Nothing here is testing the idle, and a breath riding on top of the
  // trajectory shows up as noise in every speed measurement below.
  body.breathDepth = 0;
  body.idleAmount = 0;
  body.weightShift = 0;
  body.gazeAmount = 0;
  return { body, profile, rig };
}

const wristOf = (profile: Profile, side: Side): THREE.Vector3 => {
  const hand = profile.bones[`hand.${side}`];
  if (!hand) throw new Error('synthetic rig has no hand bone');
  hand.updateWorldMatrix(true, false);
  return hand.getWorldPosition(new THREE.Vector3());
};

/**
 * Play one gesture and hand back the wrist's speed on each frame of it, in
 * metres per second.
 */
function speeds(h: Harness, id: string, frames: number, side: Side = 'R'): number[] {
  h.rig.reset();
  h.body.update(DT);
  h.body.play(id);
  let previous = wristOf(h.profile, side);
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    h.rig.reset();
    h.body.update(DT);
    const now = wristOf(h.profile, side);
    out.push(previous.distanceTo(now) / DT);
    previous = now;
  }
  return out;
}

/** A gesture that puts the hand somewhere far from where it is standing. */
const FAR = 'wave';

describe('gesture entrance', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('sets out from rest', () => {
    const s = speeds(h, FAR, 60);
    expect(s[0]).toBeLessThan(Math.max(...s) * 0.35);
  });

  it('arrives at its pose instead of creeping into it', () => {
    // A lag closes a fixed fraction of what remains each frame, and therefore
    // never closes it. There used to be two of them in series here — the blend
    // chasing the envelope and the limb chasing the blend — and a gesture went
    // on visibly settling into itself long after it was over.
    //
    // The wrist has to be where it is going by the time the entrance is, with
    // only the terminal correction left to run.
    h.rig.reset();
    h.body.update(DT);
    h.body.play('chin');
    const lead = h.body.gesture?.lead ?? 0;
    const track: THREE.Vector3[] = [];
    for (let i = 0; i < 120; i++) {
      h.rig.reset();
      h.body.update(DT);
      track.push(wristOf(h.profile, 'R'));
    }
    const end = track.at(-1);
    if (!end) throw new Error('no frames');
    const far = Math.max(...track.map((p) => p.distanceTo(end)));
    const settled = track.findIndex((p) => p.distanceTo(end) < far * 0.05);
    expect(settled).toBeGreaterThan(0);
    expect(settled * DT).toBeLessThan(lead);
  });

  it('carries the movement in the middle and lands with the hand slowing', () => {
    const s = speeds(h, FAR, 45);
    const peak = s.indexOf(Math.max(...s));
    expect(peak).toBeGreaterThan(3);
    // Slowing into the pose, not stopping dead in it.
    const tail = s.slice(peak + 1);
    expect(tail.at(-1)).toBeLessThan(s[peak] * 0.5);
  });

  it('starts the shoulder before the hand', () => {
    // Proximo-distal sequencing. Compared as *fractions* of each link's own
    // travel, since the hand covers far more ground than the shoulder and would
    // win an absolute comparison whatever the ordering.
    const shoulder = h.profile.bones['upperArm.R'];
    const hand = h.profile.bones['hand.R'];
    if (!(shoulder && hand)) throw new Error('synthetic rig is missing an arm');

    const at = (bone: THREE.Bone) => {
      bone.updateWorldMatrix(true, false);
      return bone.getWorldQuaternion(new THREE.Quaternion());
    };

    h.rig.reset();
    h.body.update(DT);
    const s0 = at(shoulder);
    const h0 = at(hand);
    h.body.play(FAR);

    const turned: Array<[number, number]> = [];
    for (let i = 0; i < 60; i++) {
      h.rig.reset();
      h.body.update(DT);
      turned.push([s0.angleTo(at(shoulder)), h0.angleTo(at(hand))]);
    }
    const total = turned.at(-1);
    if (!total) throw new Error('no frames');
    const crosses = (which: 0 | 1) => turned.findIndex((t) => t[which] > total[which] * 0.15);

    expect(crosses(0)).toBeLessThan(crosses(1));
  });
});

describe('reach entrance', () => {
  /**
   * Every hand in the table that is sent to a point on the body or the face,
   * as `[gesture, side]`. The side matters: a gesture may reach with one hand
   * and pose the other from directions.
   */
  const reaches: Array<[string, Side]> = Object.entries(GESTURES).flatMap(
    ([id, def]: [string, GestureDef]) => {
      const pose = def.build(0, { rate: 1, scale: 1, side: 1 });
      return (['L', 'R'] as Side[])
        .filter((side) => !!pose.reach?.[side])
        .map((side): [string, Side] => [id, side]);
    },
  );

  /**
   * Run one reach through its entrance and report the elbow flexion in degrees:
   * the worst the arm passed through on the way, and where it ended up.
   *
   * Held open, so what is measured is the approach and not the release, and
   * with the playback's hand choice pinned — several of these gestures pick a
   * side at random, which would otherwise measure a still arm half the time.
   */
  function flexion(id: string, side: Side): { worst: number; settled: number } {
    const h = harness();
    h.rig.reset();
    h.body.update(DT);
    const base: GestureDef = (GESTURES as Record<string, GestureDef>)[id];
    h.body.playDef(
      { ...base, sustain: true, build: (t, v) => base.build(t, { ...v, side: 1 }) },
      id,
    );
    const lead = h.body.gesture?.lead ?? 0;
    const bone = (name: BoneSlot) => {
      const b = h.profile.bones[name];
      if (!b) throw new Error(`synthetic rig has no ${name}`);
      b.updateWorldMatrix(true, false);
      return b.getWorldPosition(new THREE.Vector3());
    };

    let worst = 0;
    let settled = 0;
    for (let i = 0; i < Math.ceil(lead / DT); i++) {
      h.rig.reset();
      h.body.update(DT);
      const shoulder = bone(`upperArm.${side}`);
      const elbow = bone(`lowerArm.${side}`);
      const wrist = bone(`hand.${side}`);
      const flex = elbow.clone().sub(shoulder).angleTo(wrist.clone().sub(elbow));
      settled = (flex * 180) / Math.PI;
      worst = Math.max(worst, settled);
    }
    return { worst, settled };
  }

  /** The elbow's own stop, in degrees. See `anatomy/joints.ts`. */
  const ELBOW_STOP = ((JOINTS.elbow.dofs.flexion.max[1] ?? Math.PI) * 180) / Math.PI;

  it('has reaching hands to measure', () => {
    expect(reaches.length).toBeGreaterThan(8);
    expect(ELBOW_STOP).toBeCloseTo(150, 6);
  });

  it('never folds an elbow past its stop', () => {
    // The defect this is guarding is a path one: blending four link directions
    // toward a solved pose does not keep the chain closed on anything in
    // between, so the wrist wanders off the path and the elbow takes up the
    // difference — on the face-touching gestures the hand dived to within four
    // centimetres of its own shoulder and the forearm folded flat before coming
    // back out to the anchor. Swinging the target about the shoulder instead
    // keeps every intermediate pose one an arm can hold.
    //
    // Exhaustive, with no exempt list: a pose that cannot be reached inside the
    // elbow's stop on this figure is not a pose this table carries. Two once
    // were — a hand on the crown and one at the temple — and both were removed
    // rather than tolerated, because what put them out of range was the reach
    // itself and nothing about the solver was going to bring them back in.
    const measured = reaches.map(([id, side]) => [`${id}.${side}`, flexion(id, side)] as const);
    const over = measured.filter(([, f]) => f.worst > ELBOW_STOP).map(([name]) => name);
    expect(over.sort()).toEqual([]);

    // And the check is not vacuous: several of these poses put the hand on the
    // face, which needs most of the elbow's range to arrive at at all. If none
    // of them settled deep, the bound above would be measuring nothing.
    expect(measured.filter(([, f]) => f.settled > ELBOW_STOP * 0.75).length).toBeGreaterThan(0);
  });

  it('passes through no more fold than the pose it is going to needs', () => {
    // Stronger than the stop, and the property that says the path is sane: an
    // arm on its way somewhere should not fold further than it will end up
    // folded. Some margin, because the terminal correction overshoots slightly
    // and a gesture may bob while it settles.
    const worse = reaches
      .map(([id, side]) => [`${id}.${side}`, flexion(id, side)] as const)
      .filter(([, f]) => f.worst > Math.max(f.settled * 1.15, f.settled + 12))
      .map(([name]) => name);
    expect(worse.sort()).toEqual([]);
  });
});

describe('pointing with a finger other than the index', () => {
  const FINGERS: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];
  const V: GestureVariation = { rate: 1, scale: 1, side: 1 };

  /** The pose the aim gesture builds, which is what the rest of the layer reads. */
  const aimed = (h: Harness, finger: FingerName) => {
    h.body.point('R', { azimuth: 30, elevation: 10, extent: 0.85, finger });
    const g = h.body.gesture;
    if (!g) throw new Error('point built no gesture');
    return g.def.build(0, V);
  };

  it('shapes the hand for the finger it was asked to point with', () => {
    // The defect: the aim used the index-pointing shape whatever finger was
    // named, so asking for the little finger solved for a fingertip folded into
    // the palm — the arm travelled to put that knuckle on the target and the
    // finger the viewer saw extended was still the index. Every choice in the
    // panel looked identical, which is how it went unnoticed.
    const h = harness();
    for (const finger of FINGERS) {
      const pose = aimed(h, finger);
      expect(pose.point?.R?.finger).toBe(finger);
      expect(pose.fingers?.R?.[finger]).toBeLessThan(0.1);
    }
  });

  it('closes the fingers it is not pointing with, so only one is out', () => {
    const h = harness();
    for (const finger of FINGERS) {
      const shape = aimed(h, finger).fingers?.R;
      if (!shape) throw new Error('point posed no hand');
      const straight = FINGERS.filter((f) => (shape[f] ?? 1) < 0.2);
      expect(straight).toEqual([finger]);
    }
  });

  it('moves the arm when the finger changes and nothing else does', () => {
    // Why the shape has to match: the solver takes the finger's length from the
    // profile's limb table, which is measured once from the rest pose, so it
    // places the arm on the assumption that the named finger is *straight*.
    // Shaping the hand for a different one makes that assumption false — the
    // arm sits where a straight little finger would reach the target from,
    // while the little finger is folded into the palm and the index sticks out
    // at a place nothing aimed.
    //
    // Only that the arm moves at all, and not by how much: the wrist shift is
    // not the difference in the two fingers' lengths, because a longer finger
    // also puts the *target* further out along the same bearing and the two
    // largely cancel. What is left is under a millimetre on this fixture.
    //
    // Pinned, because playback varies its own speed and the elbow search
    // carries the last frame's answer forward, so two aims settle a couple of
    // centimetres apart on their own — an order of magnitude more than this.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const wristFor = (finger: FingerName): THREE.Vector3 => {
        const h = harness();
        h.rig.reset();
        h.body.update(DT);
        h.body.point('R', { azimuth: 30, elevation: 10, extent: 0.85, finger });
        for (let i = 0; i < 90; i++) {
          h.rig.reset();
          h.body.update(DT);
        }
        return wristOf(h.profile, 'R');
      };
      const index = wristFor('index');
      expect(index.distanceTo(wristFor('index'))).toBe(0);
      expect(index.distanceTo(wristFor('little'))).toBeGreaterThan(1e-4);
      expect(index.distanceTo(wristFor('thumb'))).toBeGreaterThan(1e-4);
    } finally {
      random.mockRestore();
    }
  });
});
