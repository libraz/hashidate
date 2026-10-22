import { describe, expect, it } from 'vitest';
import { Attitude } from '@/engine/motion/attitude';
import type { Rig } from '@/engine/rig';
import type { SpineOffsets, SpineSlot, Vec3Tuple } from '@/engine/types';

/**
 * A held spine offset, followed at the pace of the face.
 *
 * Read off a stand-in rig that only records what `addOffset` was given, since
 * the attitude's whole contract is the numbers it adds per slot per frame.
 */

const DT = 1 / 60;
const SLOTS: SpineSlot[] = ['hips', 'spine', 'chest', 'neck', 'head'];
const HELD: SpineOffsets = { head: [0.2, 0.1, 0.14], neck: [0.1, 0, 0.06] };

type Frame = Partial<Record<SpineSlot, Vec3Tuple>>;

function drive(a: Attitude): { step: () => Frame } {
  return {
    step: () => {
      const out: Frame = {};
      const rig = {
        addOffset: (slot: SpineSlot, x: number, y: number, z: number) => {
          const o = out[slot] ?? [0, 0, 0];
          out[slot] = [o[0] + x, o[1] + y, o[2] + z];
        },
      } as unknown as Rig;
      a.apply(rig, DT);
      return out;
    },
  };
}

const run = (d: ReturnType<typeof drive>, seconds: number): Frame => {
  let last: Frame = {};
  for (let i = 0; i < Math.round(seconds / DT); i++) last = d.step();
  return last;
};

describe('Attitude', () => {
  it('reaches a set target within about 0.7 s', () => {
    const a = new Attitude();
    const d = drive(a);
    a.set(HELD, 1);
    const f = run(d, 0.7);
    expect(f.head?.[0]).toBeGreaterThan(0.2 * 0.9);
    const settled = run(d, 4);
    expect(settled.head?.[0]).toBeCloseTo(0.2, 3);
    expect(settled.neck?.[2]).toBeCloseTo(0.06, 3);
  });

  it('never steps: a frame moves a slot by a small share of the target', () => {
    const a = new Attitude();
    const d = drive(a);
    a.set(HELD, 1);
    let prev = 0;
    for (let i = 0; i < 240; i++) {
      const v = d.step().head?.[0] ?? 0;
      expect(Math.abs(v - prev)).toBeLessThan(0.2 * 0.06);
      prev = v;
    }
  });

  it('mirrors yaw and roll and leaves pitch alone', () => {
    const a = new Attitude();
    const d = drive(a);
    a.set({ head: [0.2, 0.1, 0.14] }, -1);
    const f = run(d, 5);
    expect(f.head?.[0]).toBeCloseTo(0.2, 3);
    expect(f.head?.[1]).toBeCloseTo(-0.1, 3);
    expect(f.head?.[2]).toBeCloseTo(-0.14, 3);
  });

  it('eases back to nothing on null and then adds nothing', () => {
    const a = new Attitude();
    const d = drive(a);
    a.set(HELD, 1);
    run(d, 4);
    a.set(null, 1);
    expect(a.target).toBeNull();
    const mid = run(d, 0.2);
    expect(mid.head?.[0]).toBeGreaterThan(0);
    run(d, 8);
    expect(d.step()).toEqual({});
  });

  it('passes continuously from one attitude to another', () => {
    const a = new Attitude();
    const d = drive(a);
    a.set({ head: [0.2, 0, 0] }, 1);
    run(d, 4);
    a.set({ head: [-0.04, 0, 0.14] }, 1);
    let prev: Vec3Tuple = [0.2, 0, 0];
    for (let i = 0; i < 240; i++) {
      const v = d.step().head ?? [0, 0, 0];
      for (let k = 0; k < 3; k++) expect(Math.abs(v[k] - prev[k])).toBeLessThan(0.24 * 0.06);
      prev = v;
    }
    expect(prev[2]).toBeCloseTo(0.14, 3);
  });

  it('adds only the slots it holds', () => {
    const a = new Attitude();
    const d = drive(a);
    a.set({ chest: [0.07, 0, 0] }, 1);
    const f = run(d, 4);
    expect(Object.keys(f)).toEqual(['chest']);
    expect(SLOTS).toContain('chest');
  });
});
