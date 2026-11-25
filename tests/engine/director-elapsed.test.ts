import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import type { ArmDirections, GestureDef, Side } from '@/engine/types';
import { splitmix64 } from '../helpers/director-fixtures';
import { buildRig } from '../helpers/scene';

const DT = 1 / 60;
/** A frame that took three times its capped step. */
const LONG = 3 * DT;

interface Outgoing {
  g: { time: number };
  spineWeight: number;
  armW: Record<Side, Record<'hand', number>>;
}

interface BodyInternals {
  _fadeTime: number;
  _fading: Outgoing[];
  _spineFading: Outgoing[];
  _armEnv: Record<Side, Record<'hand', { entrance: number; exit: number }>>;
}

function make(random: () => number = splitmix64()): Director {
  const rig = buildRig();
  return new Director(buildProfile(rig.root, rig.descriptor), undefined, { random });
}

/** A held right-arm pose with a spine lean, so the switch hands over arm and spine weight both. */
function pose(lean: number): GestureDef {
  const arms: Partial<Record<Side, ArmDirections>> = {
    R: {
      upperArm: new THREE.Vector3(0.55, -0.7, 0.4).normalize(),
      lowerArm: new THREE.Vector3(0.25, -0.2, 0.95).normalize(),
      hand: new THREE.Vector3(0.1, -0.1, 0.98).normalize(),
      palm: new THREE.Vector3(0, 1, 0),
      twist: 0.3,
    },
  };
  return {
    label: { en: 'Held pose', ja: '保持' },
    group: 'pose',
    lead: 1,
    hold: 1,
    sustain: true,
    build: () => ({ arms, spine: { chest: [lean, 0, 0] } }),
  };
}

/** Every bone's rotation, flattened. */
const pose3 = (d: Director): number[] =>
  Object.values(d.p.bones).flatMap((b) => (b ? b.quaternion.toArray() : []));

describe('Director / elapsed', () => {
  it('leaves everything outside a turn on dt', () => {
    const a = make();
    const b = make();
    for (let i = 0; i < 240; i++) {
      a.update(DT);
      b.update(DT, { elapsed: LONG });
    }
    expect(b.body.t).toBe(a.body.t);
    expect(b.rig.dt).toBe(DT);
    expect(b.blink).toBe(a.blink);
    expect(b.emotion).toEqual(a.emotion);
    expect(pose3(b)).toEqual(pose3(a));
  });

  it('runs the gesture layer on elapsed and the rest of the body on dt', () => {
    const d = make();
    const seen = d.body as unknown as BodyInternals;
    d.body.playDef(pose(0.04), 'first');
    for (let i = 0; i < 10; i++) d.update(DT, { elapsed: LONG });
    expect(d.body.gesture?.time).toBeCloseTo(10 * LONG, 12);
    expect(d.body.t).toBeCloseTo(10 * DT, 12);
    expect(d.rig.dt).toBe(DT);

    // Fully in, then switched: the outgoing slot and the fade run on the same clock.
    for (let i = 0; i < 20; i++) d.update(DT, { elapsed: LONG });
    const before = d.body.gesture?.time ?? Number.NaN;
    d.body.playDef(pose(-0.04), 'second');
    for (let i = 1; i <= 4; i++) {
      d.update(DT, { elapsed: LONG });
      expect(d.body.gesture?.time).toBeCloseTo(i * LONG, 12);
      expect(seen._fadeTime).toBeCloseTo(i * LONG, 12);
      expect(seen._fading[0].g.time).toBeCloseTo(before + i * LONG, 12);
      const spine = seen._spineFading.reduce((sum, f) => sum + f.spineWeight, 0);
      expect(d.body.blend + spine).toBeCloseTo(1, 12);
      const env = seen._armEnv.R.hand;
      const arm = seen._fading.reduce((sum, f) => sum + f.armW.R.hand, 0);
      expect(Math.min(1, env.entrance * env.exit) + arm).toBeCloseTo(1, 12);
    }
  });

  it('runs an unsynced mouth and the nods on elapsed', () => {
    const line = 'はい、そうです、ね、それで、まあ、いい、でしょう、うん、はい、そう。';
    const run = (dt: number, elapsed: number): { time: number[]; nod: number[] } => {
      // A low constant draw nods at every boundary that may nod.
      const d = make(() => 0.05);
      d.nodRate = 1;
      d.speak(line);
      const time: number[] = [];
      const nod: number[] = [];
      for (let i = 0; i < 120; i++) {
        d.update(dt, { elapsed });
        time.push(d.mouth.time);
        nod.push(d.body.speechNod);
      }
      return { time, nod };
    };
    const real = run(0.05, 0.05);
    expect(real.nod.some((n) => n !== 0)).toBe(true);
    const capped = run(DT, 0.05);
    expect(capped.time).toEqual(real.time);
    expect(capped.nod).toEqual(real.nod);
  });
});
