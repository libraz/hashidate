import { describe, expect, it } from 'vitest';
import { GESTURES } from '@/engine/motion/gestures';
import { NOD_LEAD, NOD_LENGTH, nodShape } from '@/engine/motion/prosody';
import type { GestureDef, GestureVariation } from '@/engine/types';
import { DT, harness } from '../body/harness';

const variation: GestureVariation = { rate: 1, scale: 1, side: 1 };
const decay = 1.5;
const frequency = 7.6;

const headOffset = (t: number, rate = 1): number => {
  const pose = (GESTURES.nod as GestureDef).build(t, { ...variation, rate });
  return pose.spine?.head?.[0] ?? 0;
};

describe('explicit nod', () => {
  it.each([0.93, 1, 1.07])('makes one down-up nod at rate %s and then rests', (rate) => {
    const peakAt = Math.atan((frequency * rate) / decay) / (frequency * rate);
    const oldPeak = Math.exp(-decay * peakAt) * Math.sin(frequency * rate * peakAt);
    const normalizedPeak = headOffset(NOD_LEAD / rate, rate) / 0.15;

    // Match the original first downward peak while dropping its repeated cycles.
    expect(normalizedPeak).toBeCloseTo(oldPeak, 9);
    expect(headOffset((NOD_LEAD + 0.02) / rate, rate)).toBeLessThan(
      headOffset(NOD_LEAD / rate, rate),
    );
    expect(headOffset(0.05 / rate, rate)).toBeLessThan(0);
    expect(headOffset((NOD_LEAD + 0.15) / rate, rate)).toBeGreaterThan(0);
    expect(headOffset(NOD_LENGTH / rate, rate)).toBe(0);
    expect(headOffset(2 / rate, rate)).toBe(0);
  });

  it('keeps one explicit nod even when its runtime hold lasts three seconds', () => {
    const h = harness();
    const step = (): number => {
      h.rig.reset();
      h.body.update(DT);
      const gesture = h.body.gesture;
      if (!gesture) return 0;
      const pose = gesture.def.build(gesture.time * gesture.speed, gesture.v, gesture.phase);
      return pose.spine?.head?.[0] ?? 0;
    };

    step();
    h.body.play('nod');
    h.body.holdFor(3);
    const gesture = h.body.gesture;
    if (!gesture) throw new Error('nod did not start');
    const cutoff = NOD_LENGTH / (gesture.speed * gesture.v.rate);
    const values = Array.from({ length: 180 }, () => step());
    const peaks = values.flatMap((value, i) =>
      i > 0 &&
      i + 1 < values.length &&
      value > values[i - 1] &&
      value >= values[i + 1] &&
      value > 0.001
        ? [i * DT]
        : [],
    );

    expect(peaks).toHaveLength(1);
    expect(peaks[0]).toBeLessThan(cutoff);
    expect(values.slice(Math.ceil(cutoff / DT) + 1).every((value) => value === 0)).toBe(true);
    h.rig.dispose();
  });

  it('keeps the nod shape a finite single positive stroke with a small preparation', () => {
    const rate = 1;
    const samples = Array.from({ length: 121 }, (_, i) => nodShape(i / 120, 1));
    const peak = samples.indexOf(Math.max(...samples));
    expect(peak / 120).toBeCloseTo(NOD_LEAD, 2);
    expect(samples.slice(peak + 1).every((v) => v >= 0)).toBe(true);
    expect(samples.slice(0, 13).some((v) => v < 0)).toBe(true);
    expect(nodShape(NOD_LENGTH / rate, 1)).toBe(0);
  });
});
