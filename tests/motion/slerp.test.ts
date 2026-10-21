import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { compileMotion, type MotionDef } from '@/engine/motion';
import { slerpDir } from '@/engine/motion/follow';
import type { GestureVariation } from '@/engine/types';

/**
 * Between two directions along the arc rather than the chord.
 *
 * Blending components and renormalising is the same thing below a right angle
 * and visibly not past one: at 160 degrees the chord's midpoint sweeps about
 * two and a half times faster than its ends, and at 180 it flips in one frame.
 */

const D = Math.PI / 180;
const bearing = (deg: number) => new THREE.Vector3(0, Math.cos(deg * D), Math.sin(deg * D));

describe('slerpDir', () => {
  it('turns at a constant rate across a wide spread', () => {
    const from = bearing(0);
    const to = bearing(160);
    for (const e of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const at = slerpDir(new THREE.Vector3(), from, to, e);
      expect(at.length()).toBeCloseTo(1, 12);
      expect(at.angleTo(from) / D).toBeCloseTo(160 * e, 9);
    }
  });

  it('crosses an exactly opposed pair on a fixed great circle, continuously', () => {
    const from = new THREE.Vector3(1, 0, 0);
    const to = new THREE.Vector3(-1, 0, 0);
    let previous = from.clone();
    const mid = slerpDir(new THREE.Vector3(), from, to, 0.5);
    expect(mid.length()).toBeCloseTo(1, 12);
    expect(mid.dot(from)).toBeCloseTo(0, 12);
    expect(slerpDir(new THREE.Vector3(), from, to, 0.5).distanceTo(mid)).toBe(0);
    for (let i = 1; i <= 20; i++) {
      const at = slerpDir(new THREE.Vector3(), from, to, i / 20);
      expect(at.angleTo(previous)).toBeCloseTo(Math.PI / 20, 9);
      previous = at;
    }
    expect(previous.distanceTo(to)).toBeLessThan(1e-9);
  });

  it('may write into its first input', () => {
    const from = bearing(0);
    const to = bearing(90);
    slerpDir(from, from, to, 0.5);
    expect(from.angleTo(bearing(0)) / D).toBeCloseTo(45, 9);
  });
});

describe('keyframed directions', () => {
  const PLAIN: GestureVariation = { rate: 1, scale: 1, side: 1 };
  const wide = (deg: number): MotionDef => ({
    id: 'wide',
    label: { en: 'Wide', ja: '大きく' },
    group: 'pose',
    lead: 0.2,
    hold: 1,
    frames: [
      { at: 0, arms: { R: { hand: bearing(0).toArray() } } },
      { at: 1, arms: { R: { hand: bearing(deg).toArray() } } },
    ],
  });

  it('sweeps a wide pair at the rate the keyframes imply', () => {
    const built = compileMotion(wide(160));
    for (const t of [0.25, 0.5, 0.75]) {
      const hand = built.build(t, PLAIN).arms?.R?.hand;
      expect(hand?.angleTo(bearing(0)) ?? Number.NaN).toBeCloseTo(160 * t * D, 9);
    }
  });
});
