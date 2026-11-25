import { describe, expect, it } from 'vitest';
import {
  BEAT_FALL,
  BEAT_LIFT,
  BEAT_RISE,
  BEAT_SIDE,
  SpeechBeats,
} from '@/engine/motion/speech-beats';
import { minJerk } from '@/engine/motion/timing';

const DT = 1 / 60;

describe('SpeechBeats', () => {
  it('rests at zero until triggered', () => {
    const beats = new SpeechBeats();
    for (let i = 0; i < 60; i++) expect(beats.step(DT)).toBe(0);
  });

  it('rises to one over the rise, falls back over the fall, then rests', () => {
    const beats = new SpeechBeats();
    beats.trigger();
    let t = 0;
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      t += DT;
      const v = beats.step(DT);
      const expected =
        t < BEAT_RISE
          ? minJerk(t / BEAT_RISE)
          : t < BEAT_RISE + BEAT_FALL
            ? 1 - minJerk((t - BEAT_RISE) / BEAT_FALL)
            : 0;
      expect(v).toBeCloseTo(expected, 12);
      peak = Math.max(peak, v);
    }
    expect(peak).toBeGreaterThan(0.99);
    expect(beats.value).toBe(0);
  });

  it('retriggers from the current value without a jump', () => {
    const beats = new SpeechBeats();
    beats.trigger();
    // Into the fall, where a restart from zero would drop the arm.
    for (let i = 0; i < 18; i++) beats.step(DT);
    const before = beats.value;
    expect(before).toBeGreaterThan(0.3);
    beats.trigger();
    const after = beats.step(DT);
    expect(Math.abs(after - before)).toBeLessThan(0.05);
    expect(after).toBeGreaterThanOrEqual(before);
    // And it still climbs to the top and comes home.
    let peak = after;
    for (let i = 0; i < 60; i++) peak = Math.max(peak, beats.step(DT));
    expect(peak).toBeGreaterThan(0.99);
    expect(beats.value).toBe(0);
  });

  it('a retrigger at the same instant leaves the value where it was', () => {
    const beats = new SpeechBeats();
    beats.trigger();
    for (let i = 0; i < 5; i++) beats.step(DT);
    const before = beats.value;
    beats.trigger();
    expect(beats.step(0)).toBe(before);
  });

  it('lifts only the forearm and hand, the right more than the left', () => {
    const beats = new SpeechBeats();
    beats.trigger();
    for (let i = 0; i < 9; i++) beats.step(DT);
    const v = beats.value;
    expect(v).toBeGreaterThan(0);
    expect(beats.angle('R', 'shoulder')).toBe(0);
    expect(beats.angle('L', 'upperArm')).toBe(0);
    expect(beats.angle('R', 'lowerArm')).toBeCloseTo(v * BEAT_LIFT.lowerArm, 15);
    expect(beats.angle('R', 'hand')).toBeCloseTo(v * BEAT_LIFT.hand, 15);
    expect(beats.angle('L', 'hand')).toBeCloseTo(v * BEAT_LIFT.hand * BEAT_SIDE.L, 15);
    expect(BEAT_SIDE.R).toBe(1);
    expect(beats.angle('L', 'lowerArm')).toBeLessThan(beats.angle('R', 'lowerArm'));
  });
});
