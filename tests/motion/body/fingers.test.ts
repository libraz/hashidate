import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIST, OPEN_HAND, POINT_HAND, SOFT_HAND, THUMB_UP } from '@/engine/motion/gestures/hands';
import type { FingerName, GestureDef } from '@/engine/types';
import { DT, type Harness, harness } from './harness';
import { observeAcceptedHands } from './observe-accepted';

/**
 * The hand a pose authors is a shape, not a freeze: slack fingers drift while
 * held and trail the hand when it moves, and fingers held straight or closed on
 * purpose do neither.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

/** Record the right hand's curls, one entry per frame. */
const record = (h: Harness): Record<FingerName, number>[] => {
  const seen: Record<FingerName, number>[] = [];
  observeAcceptedHands(h, (frame) => {
    seen.push(frame.R.curls);
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

/** A hand held forward with its palm turned toward `palm`, character space. */
const held = (fingers: Record<FingerName, number>, palm?: THREE.Vector3): GestureDef => ({
  label: { en: 'Hold', ja: '保持' },
  group: 'pose',
  lead: 0.3,
  hold: 10,
  sustain: true,
  build: () => ({
    fingers: { R: fingers },
    arms: {
      R: {
        upperArm: V(0.3, -0.9, 0.3),
        lowerArm: V(0.1, -0.2, 0.95),
        hand: V(0.1, -0.2, 0.95),
        palm,
      },
    },
  }),
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
    run(h, 240);
    const live = record(h);
    run(h, 360);
    expect(range(live.map((c) => c.index))).toBeGreaterThan(0.01);

    vi.restoreAllMocks();
    const still = harness();
    still.body.playDef(swung(SOFT_HAND, 0), 'pose', 'R');
    run(still, 240);
    const frozen = record(still);
    run(still, 360);
    expect(frozen.length).toBeGreaterThan(0);
    // Not zero: the lag and the wrist still answer the arm's last creep into the pose.
    expect(range(frozen.map((c) => c.index))).toBeLessThan(1e-3);
  });

  it('opens a slack hand on the inhale and lets it close on the exhale', () => {
    h.body.breathDepth = 1;
    h.body.playDef(held(SOFT_HAND), 'pose', 'R');
    run(h, 240);
    const seen = record(h);
    const breath: number[] = [];
    for (let i = 0; i < 600; i++) {
      h.rig.reset();
      h.body.update(DT);
      breath.push(h.body.breath);
    }
    const curl = seen.map((c) => c.middle);
    expect(range(curl)).toBeGreaterThan(0.015);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const mc = mean(curl);
    const mb = mean(breath);
    let cov = 0;
    let vc = 0;
    let vb = 0;
    for (let i = 0; i < curl.length; i++) {
      cov += (curl[i] - mc) * (breath[i] - mb);
      vc += (curl[i] - mc) ** 2;
      vb += (breath[i] - mb) ** 2;
    }
    expect(cov / Math.sqrt(vc * vb)).toBeLessThan(-0.8);
  });

  it('trails a moving hand and settles back onto the shape it holds still', () => {
    h.body.playDef(swung(SOFT_HAND, 1.5), 'pose', 'R');
    const seen = record(h);
    run(h, 90);
    const moving = seen.slice(30, 90).map((c) => c.middle);
    run(h, 180);
    expect(range(moving)).toBeGreaterThan(0.03);

    vi.restoreAllMocks();
    const still = harness();
    still.body.playDef(swung(SOFT_HAND, 0), 'pose', 'R');
    const ref = record(still);
    run(still, 270);
    const last = seen[seen.length - 1];
    const want = ref[ref.length - 1];
    for (const f of Object.keys(SOFT_HAND) as FingerName[]) {
      expect(last[f]).toBeCloseTo(want[f], 4);
    }
  });

  it('lets a slack hand fall open palm up and close palm down', () => {
    const settle = (palm: THREE.Vector3) => {
      const k = harness();
      k.body.playDef(held(SOFT_HAND, palm), 'pose', 'R');
      const seen = record(k);
      run(k, 150);
      vi.restoreAllMocks();
      return seen[seen.length - 1].middle;
    };
    expect(settle(V(0, 1, 0))).toBeLessThan(settle(V(0, -1, 0)) - 0.03);
  });

  it('closes a hand from the index to the little finger, not all at once', () => {
    h.body.playDef(held(OPEN_HAND), 'pose', 'R');
    run(h, 120);
    const seen = record(h);
    h.body.playDef(held(FIST), 'pose', 'R');
    run(h, 90);
    const progress = (c: Record<FingerName, number>, f: FingerName) =>
      (c[f] - OPEN_HAND[f]) / (FIST[f] - OPEN_HAND[f]);
    const lead = Math.max(...seen.map((c) => progress(c, 'index') - progress(c, 'little')));
    expect(lead).toBeGreaterThan(0.05);
    const last = seen[seen.length - 1];
    expect(Math.abs(progress(last, 'index') - progress(last, 'little'))).toBeLessThan(0.02);
  });

  it('curls slack fingers as the wrist bends back, opens them as it bends in, then holds the shape', () => {
    const bent = (hand: THREE.Vector3): GestureDef => ({
      label: { en: 'Bend', ja: '曲げ' },
      group: 'pose',
      lead: 0.3,
      hold: 10,
      sustain: true,
      build: (t) => ({
        fingers: { R: SOFT_HAND },
        arms: {
          R: {
            upperArm: V(0.3, -0.9, 0.3),
            lowerArm: V(0.1, -0.2, 0.95),
            hand: t > 2 ? hand : V(0.1, -0.2, 0.95),
            palm: V(0, -1, 0),
          },
        },
      }),
    });
    // How far the middle finger sits from where it settles, mid-bend and late.
    const bend = (hand: THREE.Vector3) => {
      const k = harness();
      k.body.playDef(bent(hand), 'pose', 'R');
      const seen = record(k);
      run(k, 480);
      vi.restoreAllMocks();
      const end = seen[seen.length - 1].middle;
      return { mid: seen[170].middle - end, late: seen[420].middle - end };
    };
    // Palm down: up is back, down is toward the palm.
    const back = bend(V(0.1, 0.5, 0.85));
    const palmward = bend(V(0.1, -0.8, 0.55));
    expect(back.mid).toBeGreaterThan(0.02);
    expect(palmward.mid).toBeLessThan(-0.01);
    expect(Math.abs(back.late)).toBeLessThan(1e-3);
    expect(Math.abs(palmward.late)).toBeLessThan(1e-3);
  });

  it('keeps a finger closed through a switch between two shapes that close it', () => {
    h.body.playDef(held(FIST), 'pose', 'R');
    run(h, 120);
    const seen = record(h);
    h.body.playDef(held(THUMB_UP), 'pose', 'R');
    run(h, 120);
    const lo = Math.min(FIST.little, THUMB_UP.little);
    expect(lo - Math.min(...seen.map((c) => c.little))).toBeLessThan(0.01);
    expect(seen[seen.length - 1].thumb).toBeCloseTo(THUMB_UP.thumb, 2);
  });

  it('lifts the middle finger part way with an index straightening alone, then lets it go', () => {
    h.body.playDef(held(FIST), 'pose', 'R');
    run(h, 120);
    const seen = record(h);
    h.body.playDef(held(POINT_HAND), 'pose', 'R');
    run(h, 180);
    const lift = POINT_HAND.middle - Math.min(...seen.map((c) => c.middle));
    expect(lift).toBeGreaterThan(0.025);
    const last = seen[seen.length - 1];
    expect(Math.abs(last.middle - POINT_HAND.middle)).toBeLessThan(2e-3);
    expect(Math.abs(last.index - POINT_HAND.index)).toBeLessThan(2e-3);
  });

  it('fans the fingers after a hand swung across the palm', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const spreads: number[] = [];
    observeAcceptedHands(h, (frame) => {
      spreads.push(frame.R.spread.middle);
    });
    h.body.play('wave', 'R');
    run(h, 150);
    expect(range(spreads.slice(60))).toBeGreaterThan(0.02);
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
    expect(seen.length).toBeGreaterThan(0);
    for (const f of Object.keys(shape) as FingerName[]) {
      for (const c of seen) expect(Math.abs(c[f] - shape[f])).toBeLessThan(1e-3);
    }
  });
});
