import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dragShot,
  SHOT_INTERVAL,
  throttleShots,
  wheelShot,
  wrapYaw,
} from '@/panel/preview/shot-drag';
import type { Shot } from '@/protocol';

/**
 * The drag over the preview, now that the panel turns it into a shot itself.
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

describe('wrapYaw', () => {
  it('lands in (-180, 180]', () => {
    expect(wrapYaw(180)).toBe(180);
    expect(wrapYaw(-180)).toBe(180);
    expect(wrapYaw(190)).toBe(-170);
    expect(wrapYaw(-190)).toBe(170);
    expect(wrapYaw(720)).toBe(0);
  });
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

describe('throttleShots', () => {
  afterEach(() => vi.useRealTimers());

  it('sends the first at once, then at most one per interval, always ending on the last', () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const t = throttleShots(
      (s) => sent.push(s.yaw),
      () => Date.now(),
    );
    t.push(shot(1, 0));
    t.push(shot(2, 0));
    t.push(shot(3, 0));
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(SHOT_INTERVAL);
    expect(sent).toEqual([1, 3]);
    vi.advanceTimersByTime(SHOT_INTERVAL * 3);
    expect(sent).toEqual([1, 3]);
  });

  it('sends nothing after cancel', () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const t = throttleShots(
      (s) => sent.push(s.yaw),
      () => Date.now(),
    );
    t.push(shot(1, 0));
    t.push(shot(2, 0));
    t.cancel();
    vi.advanceTimersByTime(SHOT_INTERVAL * 2);
    expect(sent).toEqual([1]);
  });
});
