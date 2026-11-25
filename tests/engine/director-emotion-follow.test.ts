import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { buildRig } from '../helpers/scene';

const DT = 1 / 60;

function make(): Director {
  const rig = buildRig();
  return new Director(buildProfile(rig.root, rig.descriptor), undefined, { random: () => 0.5 });
}

describe('Director / emotion follower', () => {
  it('starts slower than a first-order ease on the first frame', () => {
    const director = make();
    director.setEmotion({ joy: 1 });
    director.update(DT);
    const first = director.emotion.joy ?? 0;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1 - Math.exp(-DT * director.emotionRate));
  });

  it('converges on its target', () => {
    const director = make();
    director.setEmotion({ joy: 1 });
    for (let i = 0; i < 600; i++) director.update(DT);
    expect(director.emotion.joy ?? 0).toBeCloseTo(1, 3);
  });

  it('never goes negative when the target reverses mid-rise', () => {
    const director = make();
    director.setEmotion({ joy: 1 });
    for (let i = 0; i < 20; i++) director.update(DT);
    director.setEmotion({ neutral: 1 });
    for (let i = 0; i < 600; i++) {
      director.update(DT);
      for (const v of Object.values(director.emotion)) expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(director.emotion.joy).toBeUndefined();
  });

  it('keeps idle and baseline in step across the auto toggle', () => {
    const director = make();
    director.setEmotion({ joy: 1 });
    for (let i = 0; i < 30; i++) director.update(DT);
    const before = director.emotion.joy ?? 0;
    director.auto = true;
    director.update(DT);
    const idle = director.effectiveEmotion.joy ?? 0;
    expect(Math.abs(idle - before)).toBeLessThan(0.05);
    director.auto = false;
    director.update(DT);
    expect(Math.abs((director.emotion.joy ?? 0) - idle)).toBeLessThan(0.05);
  });
});
