import { describe, expect, it } from 'vitest';
import type { Shot } from '@/protocol';
import { dragShot, wheelFactor, wheelScale, wheelShot } from '@/viewer/shot-gesture';

/**
 * The pointer turned into a shot.
 *
 * The figures are the orbit controls' own: a drag the height of the picture
 * turns the camera 0.4 of a circle, so over 300 px, 50 px is 24 degrees.
 */

const shot = (yaw: number, pitch: number): Required<Shot> => ({
  frame: 'bust',
  yaw,
  pitch,
  zoom: 1,
});

describe('dragShot', () => {
  // Pairwise over start yaw (near either wrap), start pitch (near either
  // limit), both drag directions and a zero-height picture.
  it.each([
    [-170, 80, 50, 50, 300, 166, 85],
    [0, 0, -50, 0, 300, 24, 0],
    [170, -80, 0, 0, 0, 170, -80],
    [170, 0, -50, 50, 0, 170, 0],
    [0, -80, 0, 50, 300, 0, -56],
    [0, 80, 50, -50, 0, 0, 80],
    [170, -80, 50, -50, 300, 146, -85],
    [-170, 0, 0, -50, 300, -170, -24],
    [-170, -80, -50, 0, 0, -170, -80],
    [170, 80, -50, -50, 300, -166, 56],
    [-170, 80, 0, 0, 300, -170, 80],
    [-170, 0, 50, 0, 300, 166, 0],
  ])(
    'from yaw %d pitch %d, drag %d,%d over %dpx → yaw %d pitch %d',
    (yaw, pitch, dx, dy, h, wy, wp) => {
      const moved = dragShot(shot(yaw, pitch), dx, dy, h);
      expect(moved.yaw).toBeCloseTo(wy, 9);
      expect(moved.pitch).toBeCloseTo(wp, 9);
      expect(moved.frame).toBe('bust');
      expect(moved.zoom).toBe(1);
    },
  );
});

describe('wheelShot', () => {
  it('comes in on wheel up and goes out on wheel down, by the orbit controls step', () => {
    const step = 0.95 ** 0.5;
    expect(wheelShot(shot(0, 0), -100).zoom).toBeCloseTo(1 / step, 12);
    expect(wheelShot(shot(0, 0), 100).zoom).toBeCloseTo(step, 12);
    expect(wheelShot(shot(0, 0), 0).zoom).toBe(1);
  });

  it('stops where the wire does', () => {
    expect(wheelShot({ ...shot(0, 0), zoom: 4 }, -1000).zoom).toBe(4);
    expect(wheelShot({ ...shot(0, 0), zoom: 0.25 }, 1000).zoom).toBe(0.25);
  });
});

describe('wheelFactor', () => {
  it('is above 1 on wheel up, below 1 on wheel down, and 1 without a delta', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
  });

  it('agrees with wheelShot', () => {
    for (const d of [-300, -100, -3, 3, 100, 300]) {
      const zoom = d < 0 ? 1 / wheelScale(d) : 1 * wheelScale(d);
      expect(wheelShot(shot(0, 0), d).zoom).toBe(zoom);
    }
    expect(wheelShot({ ...shot(0, 0), zoom: 2 }, -100).zoom).toBe(2 / wheelScale(-100));
    expect(wheelShot({ ...shot(0, 0), zoom: 2 }, 100).zoom).toBe(2 * wheelScale(100));
  });
});
