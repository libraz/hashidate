import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GESTURES } from '@/engine/motion/gestures';
import { V } from '@/engine/motion/gestures/base';
import { FIST, OPEN_HAND } from '@/engine/motion/gestures/hands';
import type { Pose } from '@/engine/types';

/**
 * The janken throws as authored: a small swing, a wind-up, and a downswing
 * that is the throw. Pure over `build`, sampled in held time.
 */

const JAN = 0.42;
const LIFT = 0.22;
const THROW = 0.3;
const FORM = 0.25;
const SHAPES = ['rock', 'scissors', 'paper'] as const;
const MID_FORE_Y = 0.45;
const MID_UPPER = V(0.36, -0.78, 0.3).normalize();

const at = (id: (typeof SHAPES)[number], h: number, scale = 1, rate = 1): Pose =>
  GESTURES[id].build(0.34 + h, { rate, scale, side: 1 }, { entrance: 1, held: h });

const arm = (p: Pose) => {
  const a = p.arms?.R;
  if (!(a?.upperArm && a.lowerArm)) throw new Error('janken drives the right arm');
  return { upperArm: a.upperArm, lowerArm: a.lowerArm, palm: a.palm };
};
const index = (p: Pose): number => {
  const c = p.fingers?.R?.index;
  if (c === undefined) throw new Error('janken drives the right index');
  return c;
};
const deg = (a: THREE.Vector3, b: THREE.Vector3): number =>
  (Math.acos(Math.min(1, Math.max(-1, a.dot(b)))) * 180) / Math.PI;
const range = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let h = from; h <= to + 1e-9; h += 0.01) out.push(h);
  return out;
};

describe('janken timeline', () => {
  it('winds up higher than the first swing dips, and swings the upper arm', () => {
    const all = range(0, JAN + LIFT + THROW + 0.3);
    const top = Math.max(...range(JAN, JAN + LIFT).map((h) => arm(at('paper', h)).lowerArm.y));
    const dip = Math.min(...range(0, JAN).map((h) => arm(at('paper', h)).lowerArm.y));
    expect(top).toBeGreaterThanOrEqual(
      Math.max(...all.map((h) => arm(at('paper', h)).lowerArm.y)) - 1e-9,
    );
    expect(top - MID_FORE_Y).toBeGreaterThan(MID_FORE_Y - dip);

    const bottom = arm(at('paper', JAN / 2)).upperArm;
    const raised = arm(at('paper', JAN + LIFT)).upperArm;
    expect(deg(bottom, MID_UPPER)).toBeGreaterThanOrEqual(5);
    expect(deg(raised, MID_UPPER)).toBeGreaterThanOrEqual(12);
    expect(deg(raised, bottom)).toBeGreaterThanOrEqual(12);
  });

  it.each([0.9, 1, 1.1])('forms the fingers during the second downswing at scale %f', (scale) => {
    const start = JAN + LIFT;
    for (const h of range(0, start + FORM * THROW)) {
      expect(index(at('paper', h, scale))).toBeCloseTo(FIST.curl.index, 9);
    }
    const mid = index(at('paper', start + 0.6 * THROW, scale));
    expect(mid).toBeLessThan(FIST.curl.index);
    expect(mid).toBeGreaterThan(OPEN_HAND.curl.index);
    for (const h of [start + THROW, start + THROW + 0.5]) {
      expect(index(at('paper', h, scale))).toBeCloseTo(OPEN_HAND.curl.index, 9);
    }
  });

  it('runs the whole schedule at the gesture rate', () => {
    expect(index(at('paper', 0.5 * (JAN + LIFT + THROW), 1, 2))).toBeCloseTo(
      OPEN_HAND.curl.index,
      9,
    );
    expect(index(at('paper', 0.5 * (JAN + LIFT + THROW) - 0.05, 1, 2))).toBeGreaterThan(
      OPEN_HAND.curl.index + 1e-3,
    );
  });
});

describe('janken palms', () => {
  it.each(SHAPES)('%s faces down at the hold and through the pumps', (id) => {
    for (const h of range(JAN + LIFT + THROW, JAN + LIFT + THROW + 0.5)) {
      const palm = arm(at(id, h)).palm;
      if (!palm) throw new Error('palm is authored');
      expect(palm.y).toBeLessThanOrEqual(-0.93);
      expect(Math.abs(palm.x)).toBeLessThanOrEqual(0.25);
    }
    for (const h of range(0, JAN + LIFT - 0.01)) {
      const palm = arm(at(id, h)).palm;
      if (!palm) throw new Error('palm is authored');
      expect(palm.y).toBeLessThanOrEqual(-0.85);
    }
  });
});
