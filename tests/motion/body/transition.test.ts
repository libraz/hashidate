import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JointReading, Side } from '@/engine/types';
import { DT, type Harness, harness } from './harness';

/**
 * What an arm passes through between two poses.
 *
 * Both ends of a switch can be comfortable and the way between them not: a
 * blend that turns the forearm about the humerus winds the palm onto a stop, and
 * an arc between two points on the head can run through it. Each case here is a
 * pair whose path did that while its ends were fine.
 */

/** Hold `from`, switch to `to`, and hand back the readings of `side` on each frame after. */
function across(from: string, to: string, side: Side, frames = 60): JointReading[][] {
  const h = harness();
  const step = (x: Harness) => {
    x.rig.reset();
    x.body.update(DT);
  };
  step(h);
  h.body.play(from);
  for (let i = 0; i < 180; i++) step(h);
  h.body.play(to);
  const out: JointReading[][] = [];
  for (let i = 0; i < frames; i++) {
    step(h);
    out.push(h.rig.measure(side) ?? []);
  }
  return out;
}

const reading = (frame: JointReading[], id: string) => frame.find((r) => r.id === id);

describe('the path between two poses', () => {
  beforeEach(() => {
    // One-handed poses pick their hand at random; these are written for the right.
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the cheek for a wave without folding the elbow or winding the forearm onto a stop', () => {
    for (const frame of across('cheekPoints', 'wave', 'R')) {
      for (const id of ['elbow', 'forearm', 'wristFlex']) {
        expect(reading(frame, id)?.zone, id).not.toBe('limit');
      }
    }
  });

  it('never turns the forearm faster than a limb can, leaving the ear for a cheer', () => {
    const roll = across('whisper', 'bravo', 'R').map((f) => reading(f, 'forearm')?.deg ?? 0);
    const steps = roll.slice(1).map((r, i) => Math.abs(r - roll[i]));
    // The limiter's own slew, fourteen radians a second, plus rounding.
    expect(Math.max(...steps)).toBeLessThan((14 * DT * 180) / Math.PI + 0.5);
  });

  it('brings a hand from the mouth to behind the ear round the face rather than through it', () => {
    const depth = across('cover', 'listen', 'R').map((f) => reading(f, 'torso')?.deg ?? 0);
    expect(Math.max(...depth)).toBeLessThan(15);
  });
});
