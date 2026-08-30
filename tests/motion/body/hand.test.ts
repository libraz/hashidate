import type * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileMotion } from '@/engine/motion/custom';
import type { FingerName, GestureVariation, Side } from '@/engine/types';
import { DT, type Harness, harness, wristOf } from './harness';

/**
 * Which hand acts, and which finger it acts with.
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
