import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINGER_WIDTH } from '@/engine/anatomy';
import { DT, fingerDepth, handOrientation, harness } from './harness';

/**
 * Where a hand that touches the face puts its fingers.
 *
 * A reach lands the palm on its anchor, and the fingers past it go as far as
 * the avatar's fingers are long. The synthetic face is a plain ellipse, and a
 * hand placed by the anchors alone ran into it on most of these, further than
 * a turn of the hand could take back.
 */

const TOUCHING = ['think', 'chin', 'cheekPoke', 'cheekPeace', 'cheekPoints', 'cover', 'cuteSalute'];

describe('a hand held to the face', () => {
  beforeEach(() => {
    // One-handed poses pick their hand at random; these are written for the right.
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(TOUCHING)('keeps the fingers of %s out of the skin', (id) => {
    const h = harness();
    const half = 0.5 * FINGER_WIDTH * (h.profile.limb?.['pitch.R'] ?? 0);
    const step = () => {
      h.rig.reset();
      h.body.update(DT);
    };
    step();
    h.body.play(id);
    for (let i = 0; i < 180; i++) step();
    expect(half).toBeGreaterThan(0);
    expect(fingerDepth(h, 'R')).toBeLessThan(half);
  });

  it('holds the cover hand and palm steady from 20 through 120 Hz', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const poses = new Map<number, ReturnType<typeof handOrientation>>();
    const stopRows = new Map<number, string[]>();

    for (const fps of [20, 30, 60, 120]) {
      const h = harness();
      const dt = 1 / fps;
      const step = () => {
        h.rig.reset();
        h.body.update(dt);
      };

      // Settle the idle before starting the gesture, then read the same two
      // seconds into its hold at every refresh rate.
      for (let i = 0; i < fps / 2; i++) step();
      h.body.play('cover', 'R');
      for (let i = 0; i < fps * 2; i++) step();

      poses.set(fps, handOrientation(h, 'R'));
      stopRows.set(
        fps,
        (h.rig.measure('R') ?? []).filter((row) => row.zone === 'limit').map((row) => row.id),
      );
    }

    const reference = poses.get(120);
    if (!reference) throw new Error('120 Hz cover capture is missing');
    for (const [fps, pose] of poses) {
      const handDegrees = (pose.axis.angleTo(reference.axis) * 180) / Math.PI;
      const palmDegrees = (pose.palm.angleTo(reference.palm) * 180) / Math.PI;
      expect
        .soft(handDegrees, `${fps} Hz hand differs by ${handDegrees.toFixed(3)}°`)
        .toBeLessThan(2);
      expect
        .soft(palmDegrees, `${fps} Hz palm differs by ${palmDegrees.toFixed(3)}°`)
        .toBeLessThan(2);
      expect.soft(stopRows.get(fps), `${fps} Hz joint stops`).toEqual([]);
    }
  });
});
