import { describe, expect, it } from 'vitest';
import { Body } from '@/engine/motion/body';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { GestureDef, Side } from '@/engine/types';
import { buildRig } from '../../helpers/scene';

const gesture: GestureDef = {
  label: { en: 'Small spine movement', ja: '小さな背骨の動き' },
  group: 'pose',
  lead: 0.2,
  hold: 2,
  build: (t, v) => ({ spine: { chest: [0.03 * Math.sin(t * v.rate) * v.scale, 0, 0] } }),
};

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function fixture(random: () => number) {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  rig.limitsEnabled = false;
  // Reflect keeps the regression runnable against the original two-argument constructor.
  const body = Reflect.construct(Body, [rig, profile, { random }]) as Body;
  return { body, rig };
}

function snapshot(body: Body) {
  return {
    variation: body.gesture ? { ...body.gesture.v } : null,
    speed: body.gesture?.speed,
    gaze: body.gaze.toArray(),
    saccade: body.saccade,
  };
}

describe('Body random source', () => {
  it('replays independent bodies from the same seed despite global random draws', () => {
    const a = fixture(seeded(2));
    const b = fixture(seeded(2));
    const other = fixture(seeded(3));
    const traces = [[], [], []] as ReturnType<typeof snapshot>[][];
    for (const side of [undefined, 'L', 'R'] as const) {
      for (const h of [a, b, other]) h.body.playDef(gesture, 'small', side);
      for (let frame = 0; frame < 90; frame++) {
        for (const [index, h] of [a, b, other].entries()) {
          Math.random();
          h.rig.reset();
          h.body.update(1 / 60);
          traces[index].push(snapshot(h.body));
        }
      }
    }
    expect(traces[0]).toEqual(traces[1]);
    expect(traces[0]).not.toEqual(traces[2]);
    expect(traces[0].some((sample) => sample.gaze.some((value) => value !== 0))).toBe(true);
    expect(traces[0].some((sample) => sample.saccade > 0)).toBe(true);
  });

  it.each([undefined, 'L', 'R'] as (Side | undefined)[])(
    'consumes variation draws in order with side %s, then shares the source with gaze',
    (side) => {
      const values = side === undefined ? [0.1, 0.2, 0.8, 0.3] : [0.1, 0.2, 0.3];
      // Wander, yaw, pitch, and next fixation time follow the variation draws.
      values.push(0.9, 0.8, 0.7, 0.6);
      let draws = 0;
      const h = fixture(() => {
        const value = values[draws++];
        if (value === undefined) throw new Error('unexpected random draw');
        return value;
      });
      expect(draws).toBe(0);
      h.body.playDef(gesture, 'small', side);
      expect(draws).toBe(side === undefined ? 4 : 3);
      expect(h.body.gesture?.v).toEqual({
        rate: 0.92 + 0.1 * 0.16,
        scale: 0.9 + 0.2 * 0.2,
        side: side === 'L' ? -1 : 1,
      });
      expect(h.body.gesture?.speed).toBe(0.93 + 0.3 * 0.14);
      for (let frame = 0; frame < 90; frame++) {
        h.rig.reset();
        h.body.update(1 / 60);
      }
      expect(draws).toBe(values.length);
      expect(h.body.gaze.x).toBeCloseTo((0.8 - 0.5) * 0.42, 12);
      expect(h.body.gaze.y).toBeCloseTo((0.7 - 0.5) * 0.22, 12);
    },
  );
});
