import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOFT_HAND } from '@/engine/motion/gestures/hands';
import type { FingerName, GestureDef } from '@/engine/types';
import { DT, type Harness, harness } from './harness';

/**
 * The hand a pose authors is a shape, not a freeze: slack fingers drift while
 * held and trail the hand when it moves, and fingers held straight or closed on
 * purpose do neither.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

/** Record the right hand's curls, one entry per frame. */
const record = (h: Harness): Record<FingerName, number>[] => {
  const seen: Record<FingerName, number>[] = [];
  const curl = h.rig.curlHand.bind(h.rig);
  vi.spyOn(h.rig, 'curlHand').mockImplementation((side, spec, spread) => {
    if (side === 'R') seen.push({ ...(spec as Record<FingerName, number>) });
    curl(side, spec, spread);
  });
  return seen;
};

const run = (h: Harness, frames: number) => {
  for (let i = 0; i < frames; i++) {
    h.rig.reset();
    h.body.update(DT);
  }
};

const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

/** A forearm swung forward and back for `swing` seconds, then held still. */
const swung = (fingers: Record<FingerName, number>, swing: number): GestureDef => ({
  label: { en: 'Swing', ja: '振り' },
  group: 'pose',
  lead: 0.3,
  hold: 10,
  sustain: true,
  build: (t) => {
    const s = t < swing ? Math.sin(t * 9) : 0;
    return {
      fingers: { R: fingers },
      arms: {
        R: {
          upperArm: V(0.3, -0.9, 0.3),
          lowerArm: V(0.1, -0.2 + 0.5 * s, 0.95),
          hand: V(0.1, -0.2 + 0.6 * s, 0.95),
        },
      },
    };
  },
});

describe('finger life', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drifts a slack hand held still, and only while idle is on', () => {
    h.body.idleAmount = 1;
    h.body.playDef(swung(SOFT_HAND, 0), 'pose', 'R');
    run(h, 60);
    const live = record(h);
    run(h, 360);
    expect(range(live.map((c) => c.index))).toBeGreaterThan(0.01);

    vi.restoreAllMocks();
    const still = harness();
    still.body.playDef(swung(SOFT_HAND, 0), 'pose', 'R');
    run(still, 60);
    const frozen = record(still);
    run(still, 360);
    // Not zero: the lag still answers the arm's last creep into the pose.
    expect(range(frozen.map((c) => c.index))).toBeLessThan(1e-3);
  });

  it('trails a moving hand and settles back onto the authored shape', () => {
    h.body.playDef(swung(SOFT_HAND, 1.5), 'pose', 'R');
    const seen = record(h);
    run(h, 90);
    const moving = seen.slice(30, 90).map((c) => c.middle);
    run(h, 180);
    expect(range(moving)).toBeGreaterThan(0.03);
    const last = seen[seen.length - 1];
    for (const f of Object.keys(SOFT_HAND) as FingerName[]) {
      expect(last[f]).toBeCloseTo(SOFT_HAND[f], 4);
    }
  });

  it('leaves a finger held straight or closed on purpose where it was put', () => {
    const shape: Record<FingerName, number> = {
      thumb: 0,
      index: 0,
      middle: 1,
      ring: 1,
      little: 1,
    };
    h.body.idleAmount = 1;
    h.body.playDef(swung(shape, 10), 'pose', 'R');
    run(h, 60);
    const seen = record(h);
    run(h, 120);
    for (const f of Object.keys(shape) as FingerName[]) {
      for (const c of seen) expect(Math.abs(c[f] - shape[f])).toBeLessThan(1e-3);
    }
  });
});
