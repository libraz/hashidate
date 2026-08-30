import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JOINTS } from '@/engine/anatomy';
import { Body } from '@/engine/motion/body';
import { compileMotion } from '@/engine/motion/custom';
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
  Vec3Tuple,
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

interface PointCapture {
  point: THREE.Vector3;
  palm: THREE.Vector3;
}

function harness(yaw = 0): Harness {
  const built = buildRig();
  built.root.rotation.y = yaw;
  built.root.updateMatrixWorld(true);
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

/** A posed segment expressed in the body's canonical frame. */
function canonicalDirection(
  h: Harness,
  side: Side,
  parentName: string,
  childName: string,
): THREE.Vector3 {
  const parent = h.profile.bones[parentName as BoneSlot];
  const child = h.profile.bones[childName as BoneSlot];
  if (!(parent && child)) throw new Error(`synthetic rig is missing ${parentName}/${childName}`);
  parent.updateWorldMatrix(true, false);
  child.updateWorldMatrix(true, false);
  const world = child
    .getWorldPosition(new THREE.Vector3())
    .sub(parent.getWorldPosition(new THREE.Vector3()))
    .normalize();
  h.rig.anat.update();
  return new THREE.Vector3(
    world.dot(h.rig.anat.right) * (side === 'R' ? 1 : -1),
    world.dot(h.rig.anat.up),
    world.dot(h.rig.anat.fwd),
  );
}

function canonicalHandDirection(h: Harness, side: Side): THREE.Vector3 {
  const hand = h.profile.bones[`hand.${side}`];
  const middle = h.profile.fingerBones[`middle.${side}`]?.[0];
  if (!(hand && middle)) throw new Error(`synthetic rig is missing hand.${side}/middle.${side}`);
  hand.updateWorldMatrix(true, false);
  middle.updateWorldMatrix(true, false);
  const world = middle
    .getWorldPosition(new THREE.Vector3())
    .sub(hand.getWorldPosition(new THREE.Vector3()))
    .normalize();
  h.rig.anat.update();
  return new THREE.Vector3(
    world.dot(h.rig.anat.right) * (side === 'R' ? 1 : -1),
    world.dot(h.rig.anat.up),
    world.dot(h.rig.anat.fwd),
  );
}

function settleGesture(h: Harness, id: string, frames = 120): void {
  h.rig.reset();
  h.body.update(DT);
  h.body.play(id);
  for (let i = 0; i < frames; i++) {
    h.rig.reset();
    h.body.update(DT);
  }
}

function twistGesture(twist: number): GestureDef {
  return {
    label: { en: 'Twist', ja: 'ひねり' },
    group: 'pose',
    sustain: true,
    lead: 0.1,
    hold: 1,
    build: () => ({
      arms: {
        L: {
          upperArm: new THREE.Vector3(0.44, -0.74, 0.42).normalize(),
          lowerArm: new THREE.Vector3(0.3, -0.12, 0.92).normalize(),
          hand: new THREE.Vector3(0.24, -0.02, 0.95).normalize(),
          twist,
        },
        R: {
          upperArm: new THREE.Vector3(0.44, -0.74, 0.42).normalize(),
          lowerArm: new THREE.Vector3(0.3, -0.12, 0.92).normalize(),
          hand: new THREE.Vector3(0.24, -0.02, 0.95).normalize(),
          twist,
        },
      },
    }),
  };
}

function spreadGesture(spread: number): GestureDef {
  return {
    label: { en: 'Finger spread', ja: '指の開き' },
    group: 'pose',
    sustain: true,
    lead: 0.2,
    hold: 1,
    build: () => ({
      fingerSpread: {
        R: { index: spread, middle: -spread },
      },
    }),
  };
}

function handOrientation(h: Harness, side: Side): { axis: THREE.Vector3; palm: THREE.Vector3 } {
  const hand = h.profile.bones[`hand.${side}`];
  const palmLocal = h.rig.palmLocal[side];
  if (!(hand && palmLocal)) throw new Error(`synthetic rig is missing hand.${side}`);
  hand.updateWorldMatrix(true, false);
  const q = hand.getWorldQuaternion(new THREE.Quaternion());
  return {
    axis: h.profile.restDir[`hand.${side}`].clone().applyQuaternion(q).normalize(),
    palm: palmLocal.clone().applyQuaternion(q).normalize(),
  };
}

function signedRoll(from: THREE.Vector3, to: THREE.Vector3, axis: THREE.Vector3): number {
  const a = from.clone().addScaledVector(axis, -from.dot(axis)).normalize();
  const b = to.clone().addScaledVector(axis, -to.dot(axis)).normalize();
  return Math.atan2(axis.dot(a.clone().cross(b)), a.dot(b));
}

function copyDirection(value: THREE.Vector3 | Vec3Tuple | null | undefined): THREE.Vector3 | null {
  if (!value) return null;
  return Array.isArray(value) ? new THREE.Vector3(value[0], value[1], value[2]) : value.clone();
}

function captureOf(seen: Record<Side, PointCapture | null>, side: Side): PointCapture | null {
  return seen[side];
}

function harnessWithoutBodyFrame(): Harness {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  profile.body = null;
  const rig = new Rig(profile);
  const body = new Body(rig, profile);
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

  it('crossfades finger spread from zero and returns to zero on release', () => {
    const chain = h.profile.fingerBones['index.R'];
    if (!chain?.[0]) throw new Error('synthetic rig has no index.R proximal bone');
    const orientation = () => chain[0].quaternion.clone();

    h.rig.reset();
    h.body.update(DT);
    const baseline = orientation();
    h.body.playDef(spreadGesture(0.55), 'spread');

    const entrance: number[] = [];
    let previous = baseline;
    let maxStep = 0;
    for (let i = 0; i < 90; i++) {
      h.rig.reset();
      h.body.update(DT);
      const current = orientation();
      entrance.push(baseline.angleTo(current));
      maxStep = Math.max(maxStep, previous.angleTo(current));
      previous = current;
    }
    const peak = Math.max(...entrance);
    expect(peak).toBeGreaterThan(0.02);
    expect(entrance[0]).toBeLessThan(peak * 0.5);
    expect(maxStep).toBeLessThan(peak * 0.5);

    // Switching between two poses that ask for the same fan may close slightly
    // while the outgoing envelope yields to the incoming one, but it must not
    // open wider than either settled endpoint. Adding the two weights made it
    // open about 18% wider even though neither pose asked it to do so.
    h.body.playDef(spreadGesture(0.55), 'spread-again');
    const transition: number[] = [];
    for (let i = 0; i < 90; i++) {
      h.rig.reset();
      h.body.update(DT);
      transition.push(baseline.angleTo(orientation()));
    }
    const beforeSwitch = entrance.at(-1);
    const afterSwitch = transition.at(-1);
    if (beforeSwitch === undefined || afterSwitch === undefined) {
      throw new Error('spread transition has no frames');
    }
    expect(Math.max(...transition)).toBeLessThanOrEqual(Math.max(beforeSwitch, afterSwitch) * 1.01);

    h.body.stopGesture();
    let releaseStep = 0;
    previous = orientation();
    for (let i = 0; i < 300; i++) {
      h.rig.reset();
      h.body.update(DT);
      const current = orientation();
      if (i === 0) releaseStep = previous.angleTo(current);
      previous = current;
    }
    expect(releaseStep).toBeLessThan(peak * 0.5);
    expect(baseline.angleTo(previous)).toBeLessThan(1e-4);
  });
});

/**
 * Which hand a one-handed gesture acts with.
 *
 * Measured at the two wrists rather than off the variation the layer stored,
 * because the variation is only a request: what a caller pinned has to be the
 * arm that actually moves, and every step between the two — the mirror, the
 * pose lookup, the per-side follower — is where that could quietly stop being
 * true.
 */
describe('the acting hand', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  /** A gesture the table poses on one arm and leaves the other out of. */
  const ONE_HANDED = 'peace';

  /** How far each wrist travelled over a run of frames, in metres. */
  function travel(id: string, side?: Side): Record<Side, number> {
    h.rig.reset();
    h.body.update(DT);
    h.body.play(id, side);
    const previous: Record<Side, THREE.Vector3> = {
      L: wristOf(h.profile, 'L'),
      R: wristOf(h.profile, 'R'),
    };
    const out: Record<Side, number> = { L: 0, R: 0 };
    for (let i = 0; i < 60; i++) {
      h.rig.reset();
      h.body.update(DT);
      for (const s of ['L', 'R'] as const) {
        const now = wristOf(h.profile, s);
        out[s] += previous[s].distanceTo(now);
        previous[s] = now;
      }
    }
    return out;
  }

  it('is the one the caller named', () => {
    // The draw is rigged to the *other* hand each time round, so a `side` that
    // was accepted and then dropped fails here rather than passing half of the
    // time on the roll it would have made anyway.
    const random = vi.spyOn(Math, 'random');
    for (const side of ['L', 'R'] as const) {
      random.mockReturnValue(side === 'L' ? 0.9 : 0.1);
      h = harness();
      const moved = travel(ONE_HANDED, side);
      const other = side === 'L' ? 'R' : 'L';
      expect(moved[side]).toBeGreaterThan(moved[other] * 4);
    }
    random.mockRestore();
  });

  it('is drawn afresh when the caller names none', () => {
    const seen = new Set<number>();
    const random = vi.spyOn(Math, 'random');
    // Low and high across the whole draw. Only the third call decides the side;
    // the rate, scale and speed around it take the same roll and stay in range.
    for (const roll of [0.1, 0.9]) {
      random.mockReturnValue(roll);
      h = harness();
      h.body.play(ONE_HANDED);
      seen.add(h.body.gesture?.v.side ?? 0);
    }
    random.mockRestore();
    expect(seen).toEqual(new Set([-1, 1]));
  });

  it('leaves a loaded motion to state its own hands', () => {
    // `compileMotion` never reads `v.side`, so pinning one may not move the
    // pose. A file that keyframed the right arm keeps the right arm.
    const def = compileMotion({
      id: 'salute',
      label: { en: 'Salute', ja: '敬礼' },
      group: 'greeting',
      lead: 0.2,
      hold: 0.6,
      frames: [
        { at: 0, arms: { R: { upperArm: [0, -1, 0], lowerArm: [0, -1, 0] } } },
        { at: 0.8, arms: { R: { upperArm: [0.3, 0.4, 0.6], lowerArm: [0.2, 0.8, 0.3] } } },
      ],
    });
    for (const side of ['L', 'R'] as const) {
      const pose = def.build(0.8, { rate: 1, scale: 1, side: side === 'R' ? 1 : -1 });
      expect(pose.arms?.R).toBeDefined();
      expect(pose.arms?.L).toBeUndefined();
    }
  });
});

describe('character-space arm directions', () => {
  it('keeps authored hand twist mirrored by its axial sign on neutral and turned rigs', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const settled = (yaw: number, twist: number, side: Side) => {
        const h = harness(yaw);
        h.rig.limitsEnabled = false;
        h.rig.reset();
        h.body.update(DT);
        h.body.playDef(twistGesture(twist), `twist.${twist}`);
        for (let i = 0; i < 120; i++) {
          h.rig.reset();
          h.body.update(DT);
        }
        return handOrientation(h, side);
      };

      const neutral = {
        L: settled(0, 0, 'L'),
        R: settled(0, 0, 'R'),
      };
      const neutralTwisted = {
        L: settled(0, 0.7, 'L'),
        R: settled(0, 0.7, 'R'),
      };
      const turned = settled(Math.PI / 2, 0.7, 'R');
      const leftRoll = signedRoll(neutral.L.palm, neutralTwisted.L.palm, neutral.L.axis);
      const rightRoll = signedRoll(neutral.R.palm, neutralTwisted.R.palm, neutral.R.axis);
      const turnedRoll = signedRoll(
        settled(Math.PI / 2, 0, 'R').palm,
        turned.palm,
        settled(Math.PI / 2, 0, 'R').axis,
      );

      // The authored hand twist is axial: its sign is opposite the lateral
      // character mirror, preserving the shipped L=+ / R=- roll convention.
      expect(leftRoll).toBeGreaterThan(0.2);
      expect(rightRoll).toBeLessThan(-0.2);
      expect(leftRoll + rightRoll).toBeCloseTo(0, 2);
      expect(turnedRoll).toBeCloseTo(rightRoll, 2);
    } finally {
      random.mockRestore();
    }
  });

  it('mirrors raw reach elbow angles semantically after a root turn', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const anglesAt = (yaw: number): Record<Side, number | undefined> => {
        const h = harness(yaw);
        const angles: Partial<Record<Side, number>> = {};
        const solveReach = vi
          .spyOn(h.rig, 'solveReach')
          .mockImplementation((side, _target, angle) => {
            angles[side] = angle;
            return null;
          });
        const def: GestureDef = {
          label: { en: 'Raw reach', ja: '到達' },
          group: 'pose',
          sustain: true,
          lead: 0.1,
          hold: 1,
          build: () => ({
            reach: {
              L: { at: 'mouth', elbow: 0.6 },
              R: { at: 'mouth', elbow: 0.6 },
            },
          }),
        };
        h.rig.reset();
        h.body.update(DT);
        h.body.playDef(def, `raw-reach.${yaw}`);
        solveReach.mockClear();
        angles.L = undefined;
        angles.R = undefined;
        h.rig.reset();
        h.body.update(DT);
        solveReach.mockRestore();
        return { L: angles.L, R: angles.R };
      };

      const neutral = anglesAt(0);
      const turned = anglesAt(Math.PI / 2);
      expect(neutral.L).toBeCloseTo(0.6, 10);
      expect(neutral.R).toBeCloseTo(-0.6, 10);
      expect(turned.L).toBeCloseTo(neutral.L ?? 0, 10);
      expect(turned.R).toBeCloseTo(neutral.R ?? 0, 10);
    } finally {
      random.mockRestore();
    }
  });

  it('keeps an absolute point direction unmirrored and normalized without a body frame', () => {
    const h = harnessWithoutBodyFrame();
    const seen: Record<Side, PointCapture | null> = {
      L: null,
      R: null,
    };
    const solvePoint = vi.spyOn(h.rig, 'solvePoint').mockImplementation((side, spec) => {
      const point = copyDirection(spec.point);
      const palm = copyDirection(spec.palm);
      if (point && palm) seen[side] = { point, palm };
      return null;
    });
    const value: [number, number, number] = [0.4, 0.2, 0.8];
    const palm: [number, number, number] = [-0.3, 0.6, -0.7];
    const def: GestureDef = {
      label: { en: 'Absolute point', ja: '絶対指示' },
      group: 'explain',
      sustain: true,
      lead: 0.1,
      hold: 1,
      build: () => ({
        point: {
          L: { point: value, palm, mirror: false },
          R: { point: value, palm, mirror: false },
        },
      }),
    };
    h.rig.reset();
    h.body.update(DT);
    h.body.playDef(def, 'absolute-point');
    solvePoint.mockClear();
    seen.L = null;
    seen.R = null;
    h.rig.reset();
    h.body.update(DT);
    solvePoint.mockRestore();

    const left = captureOf(seen, 'L');
    const right = captureOf(seen, 'R');
    if (!(left && right)) throw new Error('absolute point did not reach the solver');
    expect(left.point.distanceTo(right.point)).toBeLessThan(1e-12);
    expect(left.palm.distanceTo(right.palm)).toBeLessThan(1e-12);
    expect(left.point.length()).toBeCloseTo(1, 12);
    expect(left.palm.length()).toBeCloseTo(1, 12);
  });

  it('mirrors explicit point and palm directions for a normal semantic pose', () => {
    const h = harness();
    const seen: Record<Side, PointCapture | null> = {
      L: null,
      R: null,
    };
    const solvePoint = vi.spyOn(h.rig, 'solvePoint').mockImplementation((side, spec) => {
      const point = copyDirection(spec.point);
      const palm = copyDirection(spec.palm);
      if (point && palm) seen[side] = { point, palm };
      return null;
    });
    const point: [number, number, number] = [0.4, 0.2, 0.8];
    const palm: [number, number, number] = [-0.3, 0.6, -0.7];
    const def: GestureDef = {
      label: { en: 'Mirrored point', ja: '左右指示' },
      group: 'explain',
      sustain: true,
      lead: 0.1,
      hold: 1,
      build: () => ({
        point: {
          L: { point, palm },
          R: { point, palm },
        },
      }),
    };
    h.rig.reset();
    h.body.update(DT);
    h.body.playDef(def, 'mirrored-point');
    solvePoint.mockClear();
    seen.L = null;
    seen.R = null;
    h.rig.reset();
    h.body.update(DT);
    solvePoint.mockRestore();

    const left = captureOf(seen, 'L');
    const right = captureOf(seen, 'R');
    if (!(left && right)) throw new Error('mirrored point did not reach the solver');
    h.rig.anat.update();
    for (const key of ['point', 'palm'] as const) {
      expect(left[key].dot(h.rig.anat.right)).toBeCloseTo(-right[key].dot(h.rig.anat.right), 12);
      expect(left[key].dot(h.rig.anat.up)).toBeCloseTo(right[key].dot(h.rig.anat.up), 12);
      expect(left[key].dot(h.rig.anat.fwd)).toBeCloseTo(right[key].dot(h.rig.anat.fwd), 12);
    }
  });

  it('keeps a direct gesture unchanged in the live body frame when the root turns', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const poses = [0, Math.PI / 2, Math.PI].map((yaw) => {
        const h = harness(yaw);
        settleGesture(h, 'present');
        return [
          canonicalDirection(h, 'R', 'upperArm.R', 'lowerArm.R'),
          canonicalDirection(h, 'R', 'lowerArm.R', 'hand.R'),
          canonicalHandDirection(h, 'R'),
        ];
      });

      for (const pose of poses.slice(1)) {
        for (let i = 0; i < pose.length; i++) {
          expect(pose[i].distanceTo(poses[0][i])).toBeLessThan(1e-8);
        }
      }
    } finally {
      random.mockRestore();
    }
  });

  it('mirrors both arms in the canonical outward frame', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const h = harness(Math.PI / 2);
      settleGesture(h, 'present');
      for (const [parent, child] of [
        ['upperArm', 'lowerArm'],
        ['lowerArm', 'hand'],
      ]) {
        const left = canonicalDirection(h, 'L', `${parent}.L`, `${child}.L`);
        const right = canonicalDirection(h, 'R', `${parent}.R`, `${child}.R`);
        expect(left.distanceTo(right)).toBeLessThan(1e-8);
      }
      expect(
        canonicalHandDirection(h, 'L').distanceTo(canonicalHandDirection(h, 'R')),
      ).toBeLessThan(1e-8);
    } finally {
      random.mockRestore();
    }
  });

  it('keeps a direct-to-reach transition on the same canonical path after a root turn', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const transition = (yaw: number): THREE.Vector3[][] => {
        const h = harness(yaw);
        settleGesture(h, 'present');
        h.body.play('catPaw');
        const samples: THREE.Vector3[][] = [];
        for (let i = 0; i < 20; i++) {
          h.rig.reset();
          h.body.update(DT);
          samples.push([
            canonicalDirection(h, 'R', 'upperArm.R', 'lowerArm.R'),
            canonicalDirection(h, 'R', 'lowerArm.R', 'hand.R'),
            canonicalHandDirection(h, 'R'),
          ]);
        }
        return samples;
      };

      const straight = transition(0);
      const turned = transition(Math.PI / 2);
      for (let frame = 0; frame < straight.length; frame++) {
        for (let slot = 0; slot < straight[frame].length; slot++) {
          expect(straight[frame][slot].distanceTo(turned[frame][slot])).toBeLessThan(1e-8);
        }
      }
    } finally {
      random.mockRestore();
    }
  });

  it('does not mutate a shared authored direction while resolving several frames', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const h = harness(Math.PI / 2);
      const shared = new THREE.Vector3(0.42, -0.78, 0.46).normalize();
      const pose = { arms: { L: { upperArm: shared }, R: { upperArm: shared } } };
      const before = shared.clone();
      h.rig.reset();
      h.body.update(DT);
      h.body.playDef(
        {
          label: { en: 'shared', ja: '共有' },
          group: 'pose',
          lead: 0.1,
          hold: 1,
          build: () => pose,
        },
        'shared',
      );
      for (let i = 0; i < 90; i++) {
        h.rig.reset();
        h.body.update(DT);
      }
      expect(shared.distanceTo(before)).toBeLessThan(1e-12);
    } finally {
      random.mockRestore();
    }
  });

  it('turns the promise ulnar edge toward live body forward', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const edgeForward = (yaw: number, side: Side): number => {
        const h = harness(yaw);
        const base = GESTURES.promise;
        const sign = side === 'R' ? 1 : -1;
        const def: GestureDef = {
          ...base,
          build: (t, v) => base.build(t, { ...v, side: sign }),
        };
        h.rig.reset();
        h.body.update(DT);
        h.body.playDef(def, `promise.${side}.${yaw}`);
        for (let i = 0; i < 180; i++) {
          h.rig.reset();
          h.body.update(DT);
        }

        const index = h.profile.fingerBones[`index.${side}`]?.[0];
        const little = h.profile.fingerBones[`little.${side}`]?.[0];
        if (!(index && little)) throw new Error(`synthetic rig has no ${side} promise fingers`);
        h.profile.root.updateMatrixWorld(true);
        const edge = little
          .getWorldPosition(new THREE.Vector3())
          .sub(index.getWorldPosition(new THREE.Vector3()))
          .normalize();
        h.rig.anat.update();
        return edge.dot(h.rig.anat.fwd);
      };

      for (const yaw of [0, 0.6, -0.6]) {
        for (const side of ['L', 'R'] as const) {
          expect(edgeForward(yaw, side), `promise ${side} yaw ${yaw}`).toBeGreaterThan(0.25);
        }
      }
    } finally {
      random.mockRestore();
    }
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
