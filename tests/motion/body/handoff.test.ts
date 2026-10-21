import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GestureDef, Side } from '@/engine/types';
import { DT, type Harness, harness } from './harness';
import { observeAcceptedHands } from './observe-accepted';

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
    // frame stays within the minimum-jerk maximum slope (15/8) over its lead.
    expect(after[1]).toBeGreaterThan(settled * 0.85);
    expect(Math.max(...steps(after))).toBeLessThan(settled * (15 / 8) * (DT / still.lead) + 1e-9);
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
    expect(Math.max(...steps([settled, ...mid, ...after.slice(1)]))).toBeLessThan(
      settled * (15 / 8) * (DT / still.lead) + 1e-9,
    );
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
    observeAcceptedHands(h, (frame) => {
      curls.push(Object.values(frame.R.curls));
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
    expect(curls.length).toBeGreaterThan(0);
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

describe('spine switch envelope', () => {
  const headPose = (pitch: number, lead = 0.2): GestureDef => ({
    ...lean(pitch, lead),
    build: () => ({ spine: { head: [pitch, 0, 0] } }),
  });
  const isolated = () => {
    const h = harness();
    h.rig.limitsEnabled = false;
    h.body.lookAt = 0;
    return h;
  };
  const headAngle = (h: Harness) => {
    const head = h.profile.bones.head;
    if (!head) throw new Error('synthetic rig has no head');
    return head.quaternion.angleTo(h.rig.rest.get(head) ?? new THREE.Quaternion());
  };
  const held = (pitch: number) => {
    const h = isolated();
    h.body.playDef(headPose(pitch), 'first');
    track(h, 30, headAngle);
    expect(headAngle(h)).toBeCloseTo(pitch, 10);
    return h;
  };

  it.each([0.1, 0.2])(
    'never dips below either held pose when switching from %s to 0.2',
    (pitch) => {
      const h = held(pitch);
      h.body.playDef(headPose(0.2), 'second');
      const seen = track(h, 30, headAngle);
      for (const angle of seen) {
        expect(angle).toBeGreaterThanOrEqual(pitch - 1e-10);
        expect(angle).toBeLessThanOrEqual(0.2 + 1e-10);
      }
      expect(seen.at(-1)).toBeCloseTo(0.2, 10);
    },
  );

  it.each(['switch', 'stop'] as const)(
    'starts a held %s with a cubic-sized increment',
    (action) => {
      const firstIncrement = (dt: number) => {
        const h = held(0.2);
        if (action === 'switch') h.body.playDef(headPose(0.1), 'second');
        else h.body.stopGesture();
        h.rig.reset();
        h.body.update(dt);
        return 0.2 - headAngle(h);
      };
      const small = firstIncrement(0.001);
      const large = firstIncrement(0.002);
      expect(small).toBeGreaterThan(0);
      // A zero-velocity, zero-acceleration endpoint starts cubically; an
      // exponential decay instead doubles when the first timestep doubles.
      expect(large / small).toBeGreaterThan(7.5);
      expect(large / small).toBeLessThan(8.1);
    },
  );

  it.each([0, 3])('preserves equal poses through a nested switch after %s frames', (frames) => {
    const h = held(0.2);
    h.body.playDef(headPose(0.2), 'second');
    track(h, frames, headAngle);
    h.body.playDef(headPose(0.2), 'third');
    for (const angle of track(h, 30, headAngle)) expect(angle).toBeCloseTo(0.2, 10);
  });

  it('keeps phrase nods suppressed while outgoing and incoming head ownership sum to one', () => {
    const h = held(0.2);
    h.body.speechNod = 0.05;
    h.body.playDef(headPose(0.2), 'second');
    for (const angle of track(h, 30, headAngle)) expect(angle).toBeCloseTo(0.2, 10);
  });

  it('accepts a zero lead without a non-finite spine rotation, entering over the floor', () => {
    const h = held(0.2);
    h.body.playDef(headPose(0.1, 0), 'instant');
    const seen = track(h, 30, headAngle);
    for (const angle of seen) {
      expect(Number.isFinite(angle)).toBe(true);
      expect(angle).toBeGreaterThanOrEqual(0.1 - 1e-10);
      expect(angle).toBeLessThanOrEqual(0.2 + 1e-10);
    }
    expect(seen[0]).toBeGreaterThan(0.1 + 1e-3);
    expect(seen.at(-1)).toBeCloseTo(0.1, 10);
  });

  it('advances an outgoing pose once per frame and retires it after stopping during a long switch', () => {
    const h = isolated();
    const times: number[] = [];
    const heldTimes: number[] = [];
    const def = headPose(0.2);
    def.build = (t, _v, phase) => {
      times.push(t);
      heldTimes.push(phase?.held ?? -1);
      return { spine: { head: [0.2, 0, 0] } };
    };
    h.body.playDef(def, 'counted');
    track(h, 30, headAngle);
    const speed = h.body.gesture?.speed ?? 0;
    expect(speed).toBeGreaterThan(0);
    h.body.playDef(headPose(0.2, 1.2), 'long');
    times.length = 0;
    heldTimes.length = 0;
    track(h, 3, headAngle);
    h.body.stopGesture();
    // The arm lifetime ends before this long spine fade. Its pose clock must
    // still advance once per frame while the spine remains visible.
    track(h, 57, headAngle);
    expect(times).toHaveLength(60);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeCloseTo(DT * speed, 12);
      expect(heldTimes[i] - heldTimes[i - 1]).toBeCloseTo(DT * speed, 12);
    }
    track(h, 120, headAngle);
    expect(headAngle(h)).toBeLessThan(1e-7);
    const retiredCount = times.length;
    track(h, 30, headAngle);
    expect(times).toHaveLength(retiredCount);
    expect(h.body.gesture).toBeNull();
  });

  const advanceBy = (h: Harness, dt: number) => {
    h.rig.reset();
    h.body.update(dt);
    return headAngle(h);
  };

  it('keeps a natural exit deadline when stopped after that exit has started', () => {
    const h = isolated();
    const def = { ...headPose(0.2), sustain: undefined, hold: 0.1 };
    h.body.playDef(def, 'natural');
    advanceBy(h, 0.4);
    expect(headAngle(h)).toBeGreaterThan(0);
    h.body.stopGesture();
    advanceBy(h, 0.16);
    expect(headAngle(h)).toBeLessThan(1e-7);
  });

  const relative = (h: Harness) => {
    const head = h.profile.bones.head;
    if (!head) throw new Error('synthetic rig has no head');
    const rest = h.rig.rest.get(head) ?? new THREE.Quaternion();
    return rest.clone().invert().multiply(head.quaternion);
  };
  let positive: THREE.Vector3 | undefined;
  /** Head pitch, signed by the way a positive authored pitch turns it. */
  const headPitch = (h: Harness) => {
    if (!positive) {
      const q = relative(held(0.2));
      positive = new THREE.Vector3(q.x, q.y, q.z).normalize();
    }
    const q = relative(h);
    return Math.sign(new THREE.Vector3(q.x, q.y, q.z).dot(positive)) * headAngle(h);
  };
  const velocities = (xs: number[]) => xs.slice(1).map((x, i) => (x - xs[i]) / DT);
  /** Largest frame-to-frame velocity change: what a smooth curve already moves by in one step. */
  const accel = (vs: number[]) => Math.max(...vs.slice(1).map((v, i) => Math.abs(v - vs[i])));
  /**
   * The velocity change across the interruption at `at` against the steps
   * either side of it. A one-sided difference differs by acceleration times
   * the frame step, so a carried velocity stays inside it and a jump does not.
   */
  const continuity = (xs: number[], at: number) => {
    const v = velocities(xs);
    const step = Math.abs(v[at] - v[at - 1]);
    const around = Math.max(accel(v.slice(1, at)), accel(v.slice(at, at + 10)));
    return { v, step, around };
  };

  it('keeps the velocity a release already had toward rest', () => {
    const h = held(0.2);
    h.body.playDef(headPose(-0.1, 0.6), 'back');
    // Stopped at the entrance's inflection, where its weight moves fastest.
    const half = Math.round((h.body.gesture?.lead ?? 0) / 2 / DT);
    const before = [headPitch(h), ...track(h, half, headPitch)];
    h.body.stopGesture();
    const after = track(h, 120, headPitch);
    const at = before.length - 1;
    const { v, step, around } = continuity([...before, ...after], at);
    expect(before.at(-1)).toBeGreaterThan(0);
    expect(v[at - 1]).toBeLessThan(0);
    expect(step).toBeLessThanOrEqual(1.5 * around);
    expect(Math.abs(after.at(-1) ?? 1)).toBeLessThan(1e-7);
  });

  it('never carries a release away from rest, even with a switch still settling', () => {
    const h = isolated();
    h.body.playDef(headPose(0.2, 0.6), 'out');
    track(h, 10, headPitch);
    h.body.playDef(headPose(0.2, 0.6), 'again');
    const before = track(h, 3, headPitch);
    h.body.stopGesture();
    const after = [before.at(-1) ?? 0, ...track(h, 90, headPitch)];
    for (let i = 1; i < after.length; i++) {
      expect(after[i]).toBeLessThanOrEqual(after[i - 1] + 1e-9);
      expect(after[i]).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(after.at(-1)).toBeLessThan(1e-7);
  });

  it.each([0.1, -0.1])(
    'switches mid-entrance to %s with position and velocity continuous',
    (pitch) => {
      const h = isolated();
      h.body.playDef(headPose(0.2, 0.6), 'out');
      const before = track(h, 12, headPitch);
      h.body.playDef(headPose(pitch, 0.6), 'next');
      const after = track(h, 90, headPitch);
      const at = before.length - 1;
      const { v, step, around } = continuity([...before, ...after], at);
      expect(v[at - 1]).toBeGreaterThan(0.1);
      expect(step).toBeLessThanOrEqual(1.5 * around);
      expect(after.at(-1)).toBeCloseTo(pitch, 10);
    },
  );

  it('stays within the authored poses under a hundred switches at ten a second', () => {
    const h = isolated();
    const pitches = [0.2, -0.2, 0.05, -0.15];
    for (let i = 0; i < 100; i++) {
      h.body.playDef(headPose(pitches[i % 4], i % 3 ? 0.2 : 0.6), `rapid-${i}`);
      for (const p of track(h, 6, headPitch)) {
        expect(p).toBeGreaterThanOrEqual(-0.2 - 1e-9);
        expect(p).toBeLessThanOrEqual(0.2 + 1e-9);
      }
    }
    h.body.stopGesture();
    track(h, 120, headPitch);
    expect(headAngle(h)).toBeLessThan(1e-7);
  });
});
