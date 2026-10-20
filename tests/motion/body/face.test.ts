import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINGER_WIDTH } from '@/engine/anatomy';
import { DT, fingerDepth, harness } from './harness';

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
});
