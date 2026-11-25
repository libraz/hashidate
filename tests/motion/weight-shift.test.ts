import { describe, expect, it } from 'vitest';
import { DWELL_MIN, DWELL_SPAN, WeightShift } from '@/engine/motion/weight-shift';

const DT = 1 / 60;

/** A small deterministic stream, so the run is the same on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Run {
  values: number[];
  dwells: number[];
  /** Seconds each transfer spends between 10 % and 90 % of its swing. */
  crossings: number[];
  /** Per-frame speed at the frames a transfer starts or lands. */
  edgeSpeeds: number[];
}

function run(seconds: number, random: () => number): Run {
  const shift = new WeightShift();
  const values: number[] = [];
  const dwells: number[] = [];
  const crossings: number[] = [];
  const edgeSpeeds: number[] = [];
  let phase = shift.phase;
  let dwellStart = 0;
  let from = 0;
  let to = 0;
  let t10: number | null = null;
  let crossed = false;
  let previous = 0;
  for (let i = 1; i * DT <= seconds; i++) {
    const t = i * DT;
    const v = shift.step(DT, random);
    values.push(v);
    if (shift.phase !== phase) {
      edgeSpeeds.push(Math.abs(v - previous) / DT);
      if (shift.phase === 'transfer') {
        // The first dwell starts at the clock's zero; every later one at a landing.
        dwells.push(t - shift.timer - dwellStart);
        from = shift.from;
        to = shift.to;
        t10 = null;
        crossed = false;
      } else {
        dwellStart = t - shift.timer;
      }
      phase = shift.phase;
    }
    if (shift.phase === 'transfer' && Math.abs(to - from) === 2) {
      const x = (v - from) / (to - from);
      if (t10 === null && x >= 0.1) t10 = t;
      if (t10 !== null && !crossed && x >= 0.9) {
        crossings.push(t - t10);
        crossed = true;
      }
    }
    previous = v;
  }
  return { values, dwells, crossings, edgeSpeeds };
}

describe('WeightShift', () => {
  it('starts centred and dwells before the first transfer', () => {
    const shift = new WeightShift();
    expect(shift.value).toBe(0);
    expect(shift.phase).toBe('dwell');
    for (let i = 0; i < Math.floor(DWELL_MIN / DT) - 1; i++) {
      expect(shift.step(DT, () => 0.5)).toBe(0);
    }
  });

  it('dwells for drawn, unequal lengths inside the dwell range over a long run', () => {
    const { dwells } = run(600, mulberry32(7));
    expect(dwells.length).toBeGreaterThan(20);
    const distinct = new Set(dwells.map((d) => d.toFixed(3)));
    expect(distinct.size).toBeGreaterThan(1);
    for (const d of dwells) {
      expect(d).toBeGreaterThanOrEqual(DWELL_MIN - 1e-9);
      expect(d).toBeLessThanOrEqual(DWELL_MIN + DWELL_SPAN + 1e-9);
    }
  });

  it('crosses 10 to 90 percent of a swing at the tuned speed', () => {
    const { crossings } = run(600, mulberry32(7));
    expect(crossings.length).toBeGreaterThan(20);
    for (const c of crossings) {
      expect(c).toBeGreaterThanOrEqual(2.9 - DT);
      expect(c).toBeLessThanOrEqual(3.7);
    }
  });

  it('leaves and lands at rest', () => {
    const { edgeSpeeds } = run(600, mulberry32(7));
    expect(edgeSpeeds.length).toBeGreaterThan(40);
    // A swing of 2 at the transfer's mean speed would be about 0.3 per second.
    for (const s of edgeSpeeds) expect(s).toBeLessThan(0.01);
  });

  it('stays inside the ±1 swing', () => {
    const { values } = run(600, mulberry32(7));
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...values)).toBe(1);
    expect(Math.min(...values)).toBe(-1);
  });
});
