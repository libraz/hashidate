import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GestureDef, Side } from '@/engine/types';
import { DT, type Harness, harness } from './harness';

/**
 * How a gesture leaves.
 *
 * The spine offsets a gesture writes go to the rig with no follower behind
 * them, so whatever weight a gesture has is what the torso shows that frame.
 * These pin that a gesture already on screen only ever fades — on a switch, on
 * a switch arriving in the same instant as another, and on a release — and
 * that the clavicle turn a reach asks for arrives and leaves with it.
 */

/** A held pose that leans the chest and states nothing else. */
const lean = (pitch: number, lead = 0.2, sustain = true): GestureDef => ({
  label: { en: 'Lean', ja: '傾き' },
  group: 'pose',
  lead,
  hold: 2,
  ...(sustain ? { sustain: true as const } : {}),
  build: () => ({ spine: { chest: [pitch, 0, 0] } }),
});

/** A pose with nothing for the torso, so any chest motion is the outgoing gesture's. */
const still: GestureDef = {
  label: { en: 'Still', ja: '静止' },
  group: 'pose',
  lead: 0.2,
  hold: 2,
  sustain: true,
  build: () => ({}),
};

function step(h: Harness): void {
  h.rig.reset();
  h.body.update(DT);
}

/** Angle of a bone's local rotation away from identity, radians. */
function chestAngle(h: Harness): number {
  const chest = h.profile.bones.chest;
  if (!chest) throw new Error('synthetic rig has no chest');
  const rest = h.rig.rest.get(chest);
  return chest.quaternion.angleTo(rest ?? new THREE.Quaternion());
}

function track(h: Harness, frames: number, read: (h: Harness) => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    step(h);
    out.push(read(h));
  }
  return out;
}

const steps = (xs: number[]): number[] => xs.slice(1).map((x, i) => Math.abs(x - xs[i]));

describe('gesture slot handoff', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    h.body.lookAt = 0;
  });

  it('keeps a gesture at full weight when two more start in the same instant', () => {
    h.body.playDef(lean(0.3), 'lean');
    const settled = track(h, 90, chestAngle).at(-1) ?? 0;
    expect(settled).toBeGreaterThan(0.25);

    h.body.playDef(still, 'a');
    h.body.playDef(still, 'b');
    const after = [settled, ...track(h, 60, chestAngle)];
    // The fade, not a cut: the first frame keeps most of the lean, and every
    // frame gives up no more than the outgoing decay allows.
    expect(after[1]).toBeGreaterThan(settled * 0.85);
    expect(Math.max(...steps(after))).toBeLessThan(settled * 0.12);
    for (let i = 1; i < after.length; i++)
      expect(after[i]).toBeLessThanOrEqual(after[i - 1] + 1e-9);
  });

  it('keeps a fading gesture when a third starts during its fade', () => {
    h.body.playDef(lean(0.3), 'lean');
    const settled = track(h, 90, chestAngle).at(-1) ?? 0;
    h.body.playDef(still, 'a');
    const mid = track(h, 4, chestAngle);
    h.body.playDef(still, 'b');
    const after = [mid.at(-1) ?? 0, ...track(h, 30, chestAngle)];
    expect(after[1]).toBeGreaterThan((mid.at(-1) ?? 0) * 0.85);
    expect(Math.max(...steps([settled, ...mid, ...after.slice(1)]))).toBeLessThan(settled * 0.12);
  });

  it('never raises a gesture released during its entrance', () => {
    h.body.playDef(lean(0.3, 0.6), 'lean');
    const before = track(h, 5, chestAngle);
    const last = before.at(-1) ?? 0;
    expect(last).toBeLessThan(0.1);
    h.body.stopGesture();
    const after = [last, ...track(h, 40, chestAngle)];
    for (let i = 1; i < after.length; i++)
      expect(after[i]).toBeLessThanOrEqual(after[i - 1] + 1e-9);
  });

  it('never raises a gesture released during its hold, and fades it no faster than its own exit', () => {
    // The same gesture left to finish on its own, for the exit it was written with.
    const natural = harness();
    natural.body.lookAt = 0;
    natural.body.playDef(lean(0.3, 0.2, false), 'lean');
    const own = Math.max(...steps(track(natural, 200, chestAngle)));

    h.body.playDef(lean(0.3, 0.2, false), 'lean');
    const before = track(h, 40, chestAngle);
    const last = before.at(-1) ?? 0;
    h.body.stopGesture();
    expect(h.body.gesture?.released).toBe(true);
    const after = [last, ...track(h, 60, chestAngle)];
    for (let i = 1; i < after.length; i++)
      expect(after[i]).toBeLessThanOrEqual(after[i - 1] + 1e-9);
    expect(Math.max(...steps(after))).toBeLessThanOrEqual(own + 1e-9);
    expect(after.at(-1)).toBeLessThan(last * 0.05);
  });
});

describe('girdle across a reach switch', () => {
  /** The clavicle's world rotation, as a quaternion snapshot. */
  const clavicle = (h: Harness, side: Side): THREE.Quaternion => {
    const bone = h.profile.bones[`shoulder.${side}`];
    if (!bone) throw new Error('synthetic rig has no clavicle');
    bone.updateWorldMatrix(true, false);
    return bone.getWorldQuaternion(new THREE.Quaternion());
  };

  it('turns the clavicle in and out with the reach rather than on the switch frame', () => {
    const h = harness();
    h.body.lookAt = 0;
    step(h);
    const rest = clavicle(h, 'R');
    h.body.play('chin', 'R');
    const seen: THREE.Quaternion[] = [];
    for (let i = 0; i < 90; i++) {
      step(h);
      seen.push(clavicle(h, 'R'));
    }
    const held = seen.at(-1) ?? rest;
    // The reach really does move the girdle, or this pins nothing.
    expect(held.angleTo(rest)).toBeGreaterThan(0.02);
    h.body.playDef(still, 'still');
    for (let i = 0; i < 60; i++) {
      step(h);
      seen.push(clavicle(h, 'R'));
    }
    const per = seen.slice(1).map((q, i) => q.angleTo(seen[i]));
    // Bounded by the arm follower, far inside a girdle-sized step.
    expect(Math.max(...per)).toBeLessThan(0.05);
  });
});

describe('variation scale', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Settle a held pose with every per-playback draw pinned to `r`. */
  const settleWith = (r: number, def: GestureDef) => {
    vi.spyOn(Math, 'random').mockReturnValue(r);
    const h = harness();
    const curls: number[][] = [];
    const curl = h.rig.curlHand.bind(h.rig);
    vi.spyOn(h.rig, 'curlHand').mockImplementation((side, spec, spread) => {
      if (side === 'R') curls.push(Object.values(spec).map(Number));
      curl(side, spec, spread);
    });
    h.body.playDef(def, 'pose', 'R');
    for (let i = 0; i < 120; i++) step(h);
    vi.restoreAllMocks();
    return { h, curls };
  };

  const fist: GestureDef = {
    label: { en: 'Fist', ja: '握り' },
    group: 'pose',
    lead: 0.2,
    hold: 2,
    sustain: true,
    build: () => ({
      fingers: { R: { thumb: 1, index: 1, middle: 1, ring: 1, little: 1 } },
      arms: { R: { upperArm: new THREE.Vector3(0.44, -0.74, 0.42).normalize() } },
    }),
  };

  it('never curls a finger past what the pose authored', () => {
    const { curls } = settleWith(0.999, fist);
    expect(Math.max(...curls.flat())).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('reaches the same held pose whatever amplitude the playback drew', () => {
    const small = settleWith(0.001, fist).h;
    const large = settleWith(0.999, fist).h;
    const upper = (h: Harness) => {
      const b = h.profile.bones['upperArm.R'];
      if (!b) throw new Error('synthetic rig has no upper arm');
      b.updateWorldMatrix(true, false);
      return b.getWorldQuaternion(new THREE.Quaternion());
    };
    expect(upper(small).angleTo(upper(large))).toBeLessThan(1e-6);
  });
});
