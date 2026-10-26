import { expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import type { GestureDef } from '@/engine/types';
import { buildRig } from '../helpers/scene';

it('passes the Director random source through to Body gesture playback', () => {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  const director = new Director(profile, profile.avatar, { random: () => 0.25 });
  director.rig.limitsEnabled = false;
  const gesture: GestureDef = {
    label: { en: 'Small spine movement', ja: '小さな背骨の動き' },
    group: 'pose',
    lead: 0.2,
    hold: 1,
    build: () => ({ spine: { chest: [0.03, 0, 0] } }),
  };
  director.body.playDef(gesture, 'small');
  expect(director.body.gesture?.v).toEqual({
    rate: 0.92 + 0.25 * 0.16,
    scale: 0.9 + 0.25 * 0.2,
    side: -1,
  });
  expect(director.body.gesture?.speed).toBe(0.93 + 0.25 * 0.14);
});

it('plans head beats from the Director random source', () => {
  const lcg = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const run = (random: () => number): number[] => {
    const built = buildRig();
    const profile = buildProfile(built.root, built.descriptor);
    const director = new Director(profile, profile.avatar, { random });
    // At the measured rates, so this seed's line is sure to nod at all.
    director.nodRate = 1;
    director.speak('はい、そうです、ね、それで、まあ、いい、でしょう、うん、はい、そう。');
    const nods: number[] = [];
    for (let i = 0; i < 400; i++) {
      director.update(1 / 60);
      nods.push(director.body.speechNod);
    }
    return nods;
  };
  const a = run(lcg(7));
  expect(a.some((n) => n !== 0)).toBe(true);
  expect(run(lcg(7))).toEqual(a);
});
