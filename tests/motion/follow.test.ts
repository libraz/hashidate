import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DirFollower, OMEGA_PER_RATE, ScalarFollower } from '@/engine/motion/follow';

/**
 * The filters every channel of the body layer chases its target with.
 *
 * Both orders remove a step, which is what the follower is for; the difference
 * is the shape of the response, and the shape is the reason the second-order
 * path exists. So the tests here are about *how* the value gets there — where
 * the speed is highest, whether it arrives, whether it stays on the sphere —
 * rather than about where it ends up, which both agree on.
 */

const DT = 1 / 60;
const RATE = 13;

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

/** Run a follower to convergence and hand back the angle to target each frame. */
const trace = (from: THREE.Vector3, to: THREE.Vector3, frames: number): number[] => {
  const f = new DirFollower(from);
  return Array.from({ length: frames }, () => f.step(to, DT, RATE).angleTo(to));
};

/** What a first-order follow at the same rate would have closed in one frame. */
const firstOrderStep = (from: THREE.Vector3, to: THREE.Vector3): number => {
  const angle = from.angleTo(to);
  return angle - angle * Math.exp(-DT * RATE);
};

describe('DirFollower', () => {
  it('leaves at rest instead of at full speed', () => {
    // The whole complaint about a first-order follow in one number: its fastest
    // frame is the first one, which is the opposite of how a limb sets out.
    // Raising the order means the response has to accelerate before it travels.
    //
    // Measured across a small turn, where the chord a first-order lerp would
    // run along is short enough to stand in for the arc. Over a wide one the
    // two are not measuring the same thing.
    const from = V(0.3, -0.94, 0.14);
    const to = V(0.45, -0.85, 0.28);
    const start = from.angleTo(to);
    expect(start - trace(from, to, 1)[0]).toBeLessThan(firstOrderStep(from, to) * 0.5);
  });

  it('peaks in the middle of the movement, not at the start', () => {
    const angles = [V(0.3, -0.94, 0.14).angleTo(V(0.6, 0.5, 0.2))].concat(
      trace(V(0.3, -0.94, 0.14), V(0.6, 0.5, 0.2), 60),
    );
    const speeds = angles.slice(1).map((a, i) => angles[i] - a);
    const peak = speeds.indexOf(Math.max(...speeds));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(speeds.length / 2);
  });

  it('is over when a follow at the same rate constant would be', () => {
    // The rate figures the body layer passes were measured in first-order
    // terms — see OMEGA_PER_RATE. Only the shape of the approach changed, not
    // how long a gesture takes.
    const from = V(0.3, -0.94, 0.14);
    const to = V(0.6, 0.5, 0.2);
    const start = from.angleTo(to);
    const reach90 = trace(from, to, 200).findIndex((a) => a < start * 0.1);
    expect(reach90).toBeGreaterThan(0);
    expect(Math.abs(reach90 - Math.LN10 / RATE / DT)).toBeLessThanOrEqual(2);
  });

  it('does not overshoot the target it is chasing', () => {
    // Critically damped, so the approach is one-sided. Ringing here would show
    // as a limb wobbling onto every pose.
    const from = V(0.3, -0.94, 0.14);
    const to = V(0.6, 0.5, 0.2);
    const start = from.angleTo(to);
    for (const a of trace(from, to, 300)) expect(a).toBeLessThan(start * 1.02);
    expect(trace(from, to, 300).at(-1)).toBeLessThan(1e-3);
  });

  it('stays on the unit sphere', () => {
    const f = new DirFollower(V(0.3, -0.94, 0.14));
    const to = V(-0.7, 0.4, 0.6);
    for (let i = 0; i < 200; i++) {
      f.step(to, DT, RATE);
      expect(f.dir.length()).toBeCloseTo(1, 12);
    }
  });

  it('turns the short way round rather than through the chord', () => {
    // Filtering the three components and renormalising pulls toward the chord,
    // so a wide turn cuts the corner. A rotation-vector step follows the arc:
    // the angle to target falls monotonically and never gains ground sideways.
    const from = V(1, 0, 0);
    const to = V(-0.2, 0.98, 0);
    const f = new DirFollower(from);
    for (let i = 0; i < 120; i++) {
      f.step(to, DT, RATE);
      // The rotation is in the plane the two directions span, so nothing may
      // appear on the axis normal to it.
      expect(Math.abs(f.dir.z)).toBeLessThan(1e-9);
    }
  });

  it('gets off an exactly opposed target instead of parking on it', () => {
    // Every axis is a shortest rotation there, so the error is degenerate and
    // an unguarded solver leaves the direction on the far side for good.
    const from = V(0, 1, 0);
    const f = new DirFollower(from);
    const to = V(0, -1, 0);
    for (let i = 0; i < 300; i++) f.step(to, DT, RATE);
    expect(f.dir.angleTo(to)).toBeLessThan(0.05);
  });

  it('survives a frame that arrives late', () => {
    // A tab returning from the background hands the loop a very long dt. An
    // explicit integrator at this rate diverges on the first one.
    const f = new DirFollower(V(0.3, -0.94, 0.14));
    const to = V(0.6, 0.5, 0.2);
    for (const dt of [2, 0.5, 1 / 60, 1 / 60, 1 / 60]) f.step(to, dt, RATE);
    expect(Number.isFinite(f.dir.x)).toBe(true);
    expect(f.dir.length()).toBeCloseTo(1, 12);
    expect(f.dir.angleTo(to)).toBeLessThan(0.2);
  });

  it('re-seeds without carrying its old motion', () => {
    const f = new DirFollower(V(0, 1, 0));
    const to = V(1, 0, 0);
    for (let i = 0; i < 5; i++) f.step(to, DT, RATE);
    f.reset(V(0, 0, 1));
    expect(f.dir.z).toBeCloseTo(1, 12);
    const moved = f.step(V(0, 0, 1), DT, RATE);
    expect(moved.angleTo(V(0, 0, 1))).toBeLessThan(1e-9);
  });
});

describe('ScalarFollower', () => {
  it('leaves at rest and arrives', () => {
    const f = new ScalarFollower(0);
    const first = f.step(1, DT, RATE);
    expect(first).toBeLessThan(1 - Math.exp(-DT * RATE));
    for (let i = 0; i < 200; i++) f.step(1, DT, RATE);
    expect(f.value).toBeCloseTo(1, 6);
  });

  it('does not run past its target', () => {
    // A curl weight that overshoots is a finger bending backwards, and a
    // constraint weight that overshoots goes negative.
    const f = new ScalarFollower(0);
    for (let i = 0; i < 400; i++) expect(f.step(1, DT, RATE)).toBeLessThanOrEqual(1.001);
  });

  it('survives a frame that arrives late', () => {
    const f = new ScalarFollower(0);
    for (const dt of [3, 0.4, DT, DT]) f.step(1, dt, RATE);
    expect(Number.isFinite(f.value)).toBe(true);
    expect(f.value).toBeGreaterThan(0.5);
    expect(f.value).toBeLessThan(1.001);
  });
});

describe('OMEGA_PER_RATE', () => {
  it('equates the two orders on time to 90 percent', () => {
    // Stated as a derivation rather than a tuned figure, so it is worth
    // pinning that it is the derivation and not a number near it.
    expect(OMEGA_PER_RATE).toBeCloseTo(3.89 / Math.LN10, 12);
    const w = RATE * OMEGA_PER_RATE;
    // Continuous step response of a critically damped second-order system.
    const at = (t: number) => 1 - (1 + w * t) * Math.exp(-w * t);
    expect(at(Math.LN10 / RATE)).toBeCloseTo(0.9, 2);
  });
});
