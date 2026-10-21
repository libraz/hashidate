import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { EMOTIONS } from '@/engine/face';
import { buildProfile } from '@/engine/profile';
import { buildRig } from '../helpers/scene';

const DT = 1 / 60;

/**
 * The synthetic rig writes one uniform delta per shape, so every shape projects
 * onto both blinks. Zeroing the ones joy writes besides the squints leaves the
 * squints as the only lid travel, and makes it a ratio checkable by hand.
 */
function joyRig() {
  const deltas: Record<string, number> = {};
  for (const shape in EMOTIONS.joy) deltas[shape] = 0;
  Object.assign(deltas, {
    eyeBlinkLeft: 1e-2,
    eyeBlinkRight: 1e-2,
    eyeSquintLeft: 2e-3,
    eyeSquintRight: 2e-3,
    cheekSquintLeft: 1e-3,
    cheekSquintRight: 1e-3,
  });
  const rig = buildRig({ deltas });
  const profile = buildProfile(rig.root, rig.descriptor);
  const director = new Director(profile, undefined, { random: () => 0.5 });
  const weight = (id: string): number => {
    const target = profile.morphTargets.get(id)?.[0];
    return target?.mesh.morphTargetInfluences?.[target.index] ?? 0;
  };
  const step = (frames = 1): void => {
    for (let i = 0; i < frames; i++) director.update(DT);
  };
  /** Lid travel the squints hold: each eye's squint is 0.2 of a blink, each cheek's 0.1. */
  const squint = (): number =>
    (weight('eyeSquintLeft') + weight('eyeSquintRight')) * 0.2 +
    (weight('cheekSquintLeft') + weight('cheekSquintRight')) * 0.1;
  return { director, weight, step, squint };
}

describe('Director / blink headroom under an emotion', () => {
  it('leaves the blink only the lid travel the squints have not already used', () => {
    const { director, weight, step, squint } = joyRig();
    director.setEmotion({ joy: 1 });
    step(240);
    expect(squint()).toBeGreaterThan(0.2);

    director.triggerBlink();
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      step();
      const left = weight('eyeBlinkLeft');
      const room = 1 - squint();
      // Influences and deltas are Float32, so agreement is to single precision.
      if (director.blink > 0.001) expect(left).toBeCloseTo(director.blink * room, 6);
      peak = Math.max(peak, left + 1 - room);
    }
    // Squint plus blink never closes past one full blink's travel.
    expect(peak).toBeLessThanOrEqual(1 + 1e-6);
    // A blink drawn at 0.5 is 0.93 deep, so the stack lands just short of shut.
    expect(peak).toBeGreaterThan(0.94);
  });

  it('gives a neutral face the whole blink', () => {
    const { director, weight, step } = joyRig();
    step(60);
    director.triggerBlink();
    step();
    expect(director.blink).toBeGreaterThan(0);
    expect(weight('eyeBlinkLeft')).toBeCloseTo(director.blink, 10);
  });
});
