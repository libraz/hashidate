import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Side } from '@/engine/types';
import { canonicalDirection, DT, type Harness, harness, wristOf } from './harness';

/**
 * Where the elbow goes on the way into a reach.
 *
 * A reach fixes the wrist and leaves the elbow a circle to sit on, and the
 * three ways that choice used to go wrong all showed up as the same thing: the
 * limiter taking back, in one frame, what the solver had asked for. Measured at
 * the wrist and at the links, with the limiter on and off, because the request
 * and the pose that survives it are both part of the claim.
 */

/**
 * Peak wrist acceleration a clean entrance reaches, with room. The entrances
 * that never touch a stop peak at 22 to 26 m/s²; the limiter's seams start at
 * 50 and run past 200.
 */
const SEAM = 40;

/** The fastest the movement itself turns an upper arm, in rad/s; the slew cap is 14. */
const LINK_SPEED = 12;

/**
 * Reaches that state a pole, and whose hand comes well inside the shoulder
 * line. `think`, `whisper` and `cover` state the hand against the face, and on
 * the synthetic head the wrist itself lands inside the ring: lifting it out is
 * what the limiter still does on their arrival, at 42 to 88 m/s², and is not
 * this file's claim.
 */
const POLE_REACHES = [
  'cuteSalute',
  'cheekPoke',
  'cheekPoints',
  'cheekPeace',
  'yawn',
  'blowKiss',
  'flowerPose',
  'peekaboo',
  'faceFrame',
];

/**
 * The pole reaches whose hand stops short of the face. The rest press the
 * hand into it, and lifting it out of the head moves the wrist a centimetre
 * or three.
 */
const CLEAR_OF_THE_FACE = [
  'cuteSalute',
  'cheekPoke',
  'cheekPoints',
  'cheekPeace',
  'blowKiss',
  'faceFrame',
];

/**
 * Reaches whose authored hold asks for more forearm roll than the joint has.
 * They arrive at that pose projected onto the joint range, not at the free one.
 * faceFrame's wrist alone is reachable in range, but with its hand and palm
 * weighed equally the in-range optimum holds the wrist 2.27 cm off.
 */
const PROJECTED = ['cuteSalute', 'faceFrame'];

const SIDES: Side[] = ['L', 'R'];

/** Compare limiter-on and -off entrances with the same nominal gesture variation. */
const NOMINAL = { random: () => 0.5 };

interface Run {
  /** Peak wrist acceleration over either hand, m/s². */
  acceleration: number;
  /** Peak angular speed of either upper arm, rad/s. */
  upperArm: number;
  /** Peak angular speed of either forearm, rad/s. */
  forearm: number;
  /** The lead hand's wrist, shoulder-relative in the body frame, every frame. */
  wrist: THREE.Vector3[];
}

/** Play a gesture's entrance from rest and measure it. */
function entrance(id: string, side: Side, limits: boolean, frames = 90): Run {
  const h = harness(0, NOMINAL);
  h.rig.limitsEnabled = limits;
  h.rig.reset();
  h.body.update(DT);
  h.body.play(id, side);
  const prev: Record<
    Side,
    { u: THREE.Vector3; l: THREE.Vector3; w: THREE.Vector3; v: THREE.Vector3 } | null
  > = {
    L: null,
    R: null,
  };
  const run: Run = { acceleration: 0, upperArm: 0, forearm: 0, wrist: [] };
  for (let i = 0; i < frames; i++) {
    h.rig.reset();
    h.body.update(DT);
    for (const s of SIDES) {
      const u = canonicalDirection(h, s, `upperArm.${s}`, `lowerArm.${s}`);
      const l = canonicalDirection(h, s, `lowerArm.${s}`, `hand.${s}`);
      const w = wristOf(h.profile, s);
      const p = prev[s];
      const v = p ? w.clone().sub(p.w).divideScalar(DT) : new THREE.Vector3();
      // The first frames carry the rest pose settling, not the gesture.
      if (p && i > 2) {
        run.acceleration = Math.max(run.acceleration, v.distanceTo(p.v) / DT);
        run.upperArm = Math.max(run.upperArm, u.angleTo(p.u) / DT);
        run.forearm = Math.max(run.forearm, l.angleTo(p.l) / DT);
      }
      prev[s] = { u, l, w, v };
    }
    run.wrist.push(shoulderRelative(h, side));
  }
  return run;
}

/** The wrist from the shoulder, in the body frame with x pointing outward. */
function shoulderRelative(h: Harness, side: Side): THREE.Vector3 {
  const upper = h.profile.bones[`upperArm.${side}`];
  if (!upper) throw new Error('synthetic rig has no upper arm');
  upper.updateWorldMatrix(true, false);
  return bodyFrame(
    h,
    side,
    wristOf(h.profile, side).sub(upper.getWorldPosition(new THREE.Vector3())),
  );
}

/** A world offset in the body frame with x pointing outward. */
function bodyFrame(h: Harness, side: Side, d: THREE.Vector3): THREE.Vector3 {
  h.rig.anat.update();
  const anat = h.rig.anat;
  return new THREE.Vector3(
    d.dot(anat.right) * (side === 'R' ? 1 : -1),
    d.dot(anat.up),
    d.dot(anat.fwd),
  );
}

describe('a reach with a pole', () => {
  it.each(SIDES)('enters without the limiter lifting the arm out of the chest (%s)', (side) => {
    const over: string[] = [];
    for (const id of POLE_REACHES) {
      const run = entrance(id, side, true);
      if (run.acceleration > SEAM) over.push(`${id}: ${run.acceleration.toFixed(0)} m/s²`);
    }
    expect(over).toEqual([]);
  });

  it.each(SIDES)('holds the hand where the limiter would also put it (%s)', (side) => {
    // The solved pose has to be one the body allows: where the clamp has to
    // move the arm, the hand ends up somewhere other than its anchor.
    const off: string[] = [];
    for (const id of CLEAR_OF_THE_FACE.filter((g) => !PROJECTED.includes(g))) {
      const limited = entrance(id, side, true).wrist.at(-1);
      const free = entrance(id, side, false).wrist.at(-1);
      if (!(limited && free)) throw new Error('no frames');
      const gap = limited.distanceTo(free);
      if (gap > 0.01) off.push(`${id}: ${(gap * 100).toFixed(1)} cm`);
    }
    expect(off).toEqual([]);
  });
});

describe('a reach without a pole', () => {
  it.each(SIDES)('brings both hands to the sternum without swinging an upper arm (%s)', (side) => {
    // The elbow search keeps where it left the elbow between frames. That
    // memory has to survive the reach reference changing underneath it, or the
    // arm swings to wherever the old number means in the new frame.
    const free = entrance('beg', side, false);
    expect(free.upperArm).toBeLessThan(LINK_SPEED);
    expect(entrance('beg', side, true).acceleration).toBeLessThan(SEAM);
  });
});

describe('a reach behind the shoulder', () => {
  it.each(SIDES)('comes up the side rather than round the back (%s)', (side) => {
    // The hand goes from the hip to behind the ear. The shortest arc between
    // those two bearings passes behind the body, where no shoulder can carry a
    // bent arm; the wrist must never be further behind the shoulder than it is
    // at either end of the move.
    const run = entrance('listen', side, false, 120);
    const first = run.wrist[0];
    const last = run.wrist.at(-1);
    if (!(first && last)) throw new Error('no frames');
    const floor = Math.min(first.z, last.z) - 0.01;
    const behind = Math.min(...run.wrist.map((w) => w.z));
    expect(behind).toBeGreaterThan(floor);
    // The move itself is quick — a short lead over a long arc — so the claim is
    // that the limiter adds nothing to it, where it used to flip the forearm.
    const limited = entrance('listen', side, true, 120).acceleration;
    expect(limited).toBeLessThan(run.acceleration * 1.25);
  });
});
