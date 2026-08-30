import * as THREE from 'three';
import { Body } from '@/engine/motion/body';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { BoneSlot, GestureDef, Profile, Side, Vec3Tuple } from '@/engine/types';
import { buildRig } from '../../helpers/scene';

/**
 * How a gesture gets from where the arm is to where the pose is.
 *
 * Measured at the wrist, because that is what a viewer watches and because it
 * is the one place the whole chain of decisions shows up: the envelope, the
 * follower, the link stagger and the reach path all end in where the hand is
 * this frame and how fast it is going. Nothing here asserts a pose — the poses
 * are the gesture table's and are not this layer's to change.
 */

export const DT = 1 / 60;

export interface Harness {
  body: Body;
  profile: Profile;
  rig: Rig;
}

export interface PointCapture {
  point: THREE.Vector3;
  palm: THREE.Vector3;
}

export function harness(yaw = 0): Harness {
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
export function canonicalDirection(
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

export function canonicalHandDirection(h: Harness, side: Side): THREE.Vector3 {
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

export function settleGesture(h: Harness, id: string, frames = 120): void {
  h.rig.reset();
  h.body.update(DT);
  h.body.play(id);
  for (let i = 0; i < frames; i++) {
    h.rig.reset();
    h.body.update(DT);
  }
}

export function twistGesture(twist: number): GestureDef {
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

export function spreadGesture(spread: number): GestureDef {
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

export function handOrientation(
  h: Harness,
  side: Side,
): { axis: THREE.Vector3; palm: THREE.Vector3 } {
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

export function signedRoll(from: THREE.Vector3, to: THREE.Vector3, axis: THREE.Vector3): number {
  const a = from.clone().addScaledVector(axis, -from.dot(axis)).normalize();
  const b = to.clone().addScaledVector(axis, -to.dot(axis)).normalize();
  return Math.atan2(axis.dot(a.clone().cross(b)), a.dot(b));
}

export function copyDirection(
  value: THREE.Vector3 | Vec3Tuple | null | undefined,
): THREE.Vector3 | null {
  if (!value) return null;
  return Array.isArray(value) ? new THREE.Vector3(value[0], value[1], value[2]) : value.clone();
}

export function captureOf(
  seen: Record<Side, PointCapture | null>,
  side: Side,
): PointCapture | null {
  return seen[side];
}

export function harnessWithoutBodyFrame(): Harness {
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

export const wristOf = (profile: Profile, side: Side): THREE.Vector3 => {
  const hand = profile.bones[`hand.${side}`];
  if (!hand) throw new Error('synthetic rig has no hand bone');
  hand.updateWorldMatrix(true, false);
  return hand.getWorldPosition(new THREE.Vector3());
};

/**
 * Play one gesture and hand back the wrist's speed on each frame of it, in
 * metres per second.
 */
export function speeds(h: Harness, id: string, frames: number, side: Side = 'R'): number[] {
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
export const FAR = 'wave';
