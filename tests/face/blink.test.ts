import { describe, expect, it } from 'vitest';
import type { BlinkContext } from '@/engine/face';
import { BLINK_CLOSE, Blink, blinkCurve, MIN_BLINK_GAP } from '@/engine/face';

/**
 * mulberry32. Small, seeded and entirely in the test, so a run is reproducible
 * without pinning the engine to a particular generator.
 */
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

/** Hands back a fixed script of draws, then a constant. */
function scripted(values: number[], rest = 0.5): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : rest);
}

const IDLE: BlinkContext = { speaking: false, suppressed: false };
const SPEAKING: BlinkContext = { speaking: true, suppressed: false };
const SUPPRESSED: BlinkContext = { speaking: false, suppressed: true };

const DT = 1 / 120;

/** Step the machine, reporting every frame's weight. */
function run(blink: Blink, seconds: number, ctx: BlinkContext, dt = DT): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) out.push(blink.update(dt, ctx));
  return out;
}

/** How many blinks began during `seconds`, counted as entries into flight. */
function countBlinks(blink: Blink, seconds: number, ctx: BlinkContext, dt = DT): number {
  let count = 0;
  // A blink already in flight on entry counts, so a `trigger()` just before the
  // call is not missed.
  let wasClosing = false;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    blink.update(dt, ctx);
    if (blink.closing && !wasClosing) count++;
    wasClosing = blink.closing;
  }
  return count;
}

/** Advance past the minimum gap without letting the schedule fire on its own. */
function warm(blink: Blink, ctx: BlinkContext = IDLE): void {
  run(blink, MIN_BLINK_GAP + 0.05, ctx);
}

describe('blinkCurve', () => {
  it('starts shut-free, reaches full closure at the close point and reopens', () => {
    expect(blinkCurve(0)).toBeCloseTo(0, 12);
    expect(blinkCurve(BLINK_CLOSE)).toBeCloseTo(1, 12);
    expect(blinkCurve(1)).toBeCloseTo(0, 10);
  });

  it('closes in under a third of the blink and spends the rest opening', () => {
    expect(BLINK_CLOSE).toBeLessThan(0.5);
    // Half-closed on the way down comes later than half-closed on the way up,
    // measured from their own phase — the pulse is not symmetric.
    const closingHalf = BLINK_CLOSE / 2;
    const openingHalf = BLINK_CLOSE + (1 - BLINK_CLOSE) / 2;
    expect(blinkCurve(closingHalf)).toBeGreaterThan(0.6);
    expect(blinkCurve(openingHalf)).toBeGreaterThan(0.6);
    expect(1 - BLINK_CLOSE).toBeGreaterThan(BLINK_CLOSE * 2);
  });

  it('rises monotonically into the close and falls monotonically out of it', () => {
    const at = (u: number) => blinkCurve(u);
    for (let i = 1; i <= 20; i++) {
      const prev = at(((i - 1) / 20) * BLINK_CLOSE);
      expect(at((i / 20) * BLINK_CLOSE)).toBeGreaterThan(prev);
    }
    for (let i = 1; i <= 20; i++) {
      const prev = at(BLINK_CLOSE + ((i - 1) / 20) * (1 - BLINK_CLOSE));
      expect(at(BLINK_CLOSE + (i / 20) * (1 - BLINK_CLOSE))).toBeLessThan(prev);
    }
  });

  it('stays within 0..1 across the whole blink', () => {
    for (let i = 0; i <= 100; i++) {
      const w = blinkCurve(i / 100);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });
});

describe('Blink / trigger and the minimum gap', () => {
  it('opens with the lids up and nothing in flight', () => {
    const blink = new Blink({ random: mulberry32(1) });
    expect(blink.weight).toBe(0);
    expect(blink.closing).toBe(false);
  });

  it('refuses to blink before the minimum gap has passed', () => {
    const blink = new Blink({ random: mulberry32(1) });
    blink.trigger();
    expect(blink.closing).toBe(false);
    run(blink, MIN_BLINK_GAP - 0.1, IDLE);
    blink.trigger();
    expect(blink.closing).toBe(false);
  });

  it('blinks on trigger once the gap has passed', () => {
    const blink = new Blink({ random: mulberry32(1) });
    warm(blink);
    blink.trigger();
    expect(blink.closing).toBe(true);
    expect(blink.update(DT, IDLE)).toBeGreaterThan(0);
  });

  it('ignores a trigger landing the frame after a blink completes', () => {
    const blink = new Blink({ random: mulberry32(1) });
    warm(blink);
    blink.trigger();
    // Run out the blink; it lasts 0.16-0.26 s.
    run(blink, 0.3, IDLE);
    expect(blink.closing).toBe(false);
    blink.trigger();
    expect(blink.closing).toBe(false);
    expect(run(blink, MIN_BLINK_GAP - 0.1, IDLE).every((w) => w === 0)).toBe(true);
  });

  it('accepts the trigger again once the gap has elapsed since the last blink', () => {
    const blink = new Blink({ random: mulberry32(1) });
    warm(blink);
    blink.trigger();
    run(blink, 0.3, IDLE);
    run(blink, MIN_BLINK_GAP + 0.05, IDLE);
    blink.trigger();
    expect(blink.closing).toBe(true);
  });

  it('does not restart a blink already in flight', () => {
    const blink = new Blink({ random: scripted([0, 0, 0.9]) });
    warm(blink);
    blink.trigger();
    run(blink, 0.05, IDLE);
    const mid = blink.weight;
    blink.trigger();
    expect(blink.weight).toBe(mid);
  });
});

describe('Blink / the pulse', () => {
  it('rises and falls within its own duration and lands back on zero', () => {
    // 0.16 s duration, depth 0.86: the short end of both ranges.
    const blink = new Blink({ random: scripted([0, 0, 0.9]) });
    warm(blink);
    blink.trigger();
    const weights = run(blink, 0.16, IDLE, 1 / 480);
    expect(Math.max(...weights)).toBeCloseTo(0.86, 2);
    expect(weights[weights.length - 1]).toBe(0);
    expect(blink.closing).toBe(false);
  });

  it('peaks in the closing third rather than halfway', () => {
    const blink = new Blink({ random: scripted([0, 0, 0.9]) });
    warm(blink);
    blink.trigger();
    const weights = run(blink, 0.16, IDLE, 1 / 480);
    const peak = weights.indexOf(Math.max(...weights));
    expect(peak / weights.length).toBeLessThan(0.4);
    expect(peak / weights.length).toBeGreaterThan(0.2);
  });

  it('varies duration and depth per blink within the stated bands', () => {
    const random = mulberry32(7);
    const depths: number[] = [];
    const lengths: number[] = [];
    for (let i = 0; i < 12; i++) {
      const blink = new Blink({ random });
      warm(blink);
      blink.trigger();
      let frames = 0;
      let peak = 0;
      while (blink.closing) {
        peak = Math.max(peak, blink.update(1 / 480, IDLE));
        frames++;
      }
      depths.push(peak);
      lengths.push(frames / 480);
    }
    for (const d of depths) {
      expect(d).toBeGreaterThan(0.85);
      expect(d).toBeLessThanOrEqual(1);
    }
    for (const l of lengths) {
      expect(l).toBeGreaterThan(0.15);
      expect(l).toBeLessThan(0.27);
    }
    expect(new Set(depths.map((d) => d.toFixed(4))).size).toBeGreaterThan(1);
    expect(new Set(lengths.map((l) => l.toFixed(4))).size).toBeGreaterThan(1);
  });

  it('never reports a weight outside 0..1 over a long run', () => {
    const blink = new Blink({ random: mulberry32(11) });
    for (const w of run(blink, 120, SPEAKING)) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('reports the same weight from update and from the getter', () => {
    const blink = new Blink({ random: mulberry32(3) });
    for (let i = 0; i < 2000; i++) expect(blink.update(DT, SPEAKING)).toBe(blink.weight);
  });
});

describe('Blink / double blinks', () => {
  it('fires the second of a pair when the draw calls for it', () => {
    // dur 0.16, depth 0.86, double draw 0.05 (< 0.12), delay 0.16.
    const blink = new Blink({ random: scripted([0, 0, 0.05, 0, 0, 0]) });
    warm(blink);
    blink.trigger();
    expect(countBlinks(blink, 0.6, IDLE, 1 / 480)).toBe(2);
  });

  it('draws the second blink shallower than the first', () => {
    const peaks: number[] = [];
    const blink = new Blink({ random: scripted([0, 0, 0.05, 0, 0, 0]) });
    warm(blink);
    blink.trigger();
    let wasClosing = true;
    let peak = 0;
    for (let i = 0; i < Math.round(0.6 * 480); i++) {
      const w = blink.update(1 / 480, IDLE);
      peak = Math.max(peak, w);
      if (wasClosing && !blink.closing) {
        peaks.push(peak);
        peak = 0;
      }
      wasClosing = blink.closing;
    }
    expect(peaks).toHaveLength(2);
    expect(peaks[1]).toBeCloseTo(peaks[0] * 0.8, 6);
  });

  it('puts the pair closer together than the minimum gap between separate blinks', () => {
    const blink = new Blink({ random: scripted([0, 0, 0.05, 0, 0, 0]) });
    warm(blink);
    blink.trigger();
    let gap = 0;
    let counting = false;
    for (let i = 0; i < Math.round(0.6 * 480); i++) {
      const closingBefore = blink.closing;
      blink.update(1 / 480, IDLE);
      if (closingBefore && !blink.closing) counting = true;
      else if (counting && !blink.closing) gap += 1 / 480;
      else if (counting && blink.closing) break;
    }
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(MIN_BLINK_GAP);
  });

  it('leaves no pending second blink when the draw does not call for it', () => {
    // Third draw 0.9 is above the 0.12 chance.
    const blink = new Blink({ random: scripted([0, 0, 0.9]) });
    warm(blink);
    blink.trigger();
    expect(countBlinks(blink, 0.6, IDLE, 1 / 480)).toBe(1);
    // The first blink is over and nothing followed it inside the gap.
    expect(blink.closing).toBe(false);
  });
});

describe('Blink / context', () => {
  it('holds the lids open while suppressed', () => {
    const blink = new Blink({ random: mulberry32(5) });
    expect(run(blink, 30, SUPPRESSED).every((w) => w === 0)).toBe(true);
    expect(blink.closing).toBe(false);
  });

  it('cancels a blink already in flight when suppression arrives', () => {
    const blink = new Blink({ random: mulberry32(5) });
    warm(blink);
    blink.trigger();
    run(blink, 0.04, IDLE);
    expect(blink.weight).toBeGreaterThan(0);
    expect(blink.update(DT, SUPPRESSED)).toBe(0);
    expect(blink.closing).toBe(false);
  });

  it('produces nothing at all while disabled', () => {
    const blink = new Blink({ random: mulberry32(5) });
    blink.enabled = false;
    expect(run(blink, 30, IDLE).every((w) => w === 0)).toBe(true);
    expect(blink.closing).toBe(false);
  });

  it('abandons a blink in flight when disabled mid-pulse', () => {
    const blink = new Blink({ random: mulberry32(5) });
    warm(blink);
    blink.trigger();
    run(blink, 0.04, IDLE);
    expect(blink.weight).toBeGreaterThan(0);
    blink.enabled = false;
    expect(blink.update(DT, IDLE)).toBe(0);
    expect(blink.closing).toBe(false);
  });

  it('blinks again after being re-enabled', () => {
    const blink = new Blink({ random: mulberry32(5) });
    blink.enabled = false;
    run(blink, 10, IDLE);
    blink.enabled = true;
    expect(countBlinks(blink, 30, IDLE)).toBeGreaterThan(0);
  });

  it('blinks more often while speaking than while listening, for every seed', () => {
    const seeds = [1, 2, 3, 4, 5, 6];
    let speakingTotal = 0;
    let listeningTotal = 0;
    for (const seed of seeds) {
      // Same seed on both sides, so the difference is the rate and not the draw.
      const speaking = countBlinks(new Blink({ random: mulberry32(seed) }), 60, SPEAKING);
      const listening = countBlinks(new Blink({ random: mulberry32(seed) }), 60, IDLE);
      expect(speaking).toBeGreaterThan(listening);
      speakingTotal += speaking;
      listeningTotal += listening;
    }
    // The two intervals differ by about half again, which the counts should show
    // rather than merely edging past each other.
    expect(speakingTotal / listeningTotal).toBeGreaterThan(1.2);
  });

  it.each([
    // Bounds come from the interval the machine draws from, plus the blink's own
    // length: speaking 2.0-5.0 s, listening 2.9-7.4 s.
    ['speaking', SPEAKING, 60 / (5.0 + 0.26), 60 / 2.0],
    ['listening', IDLE, 60 / (7.4 + 0.26), 60 / 2.9],
  ] as const)('keeps the %s rate inside its own interval over a minute', (_l, ctx, lo, hi) => {
    for (const seed of [1, 2, 3, 4]) {
      const n = countBlinks(new Blink({ random: mulberry32(seed) }), 60, ctx);
      expect(n).toBeGreaterThanOrEqual(Math.floor(lo));
      expect(n).toBeLessThanOrEqual(Math.ceil(hi));
    }
  });

  it('is reproducible for a given seed', () => {
    const a = run(new Blink({ random: mulberry32(9) }), 20, SPEAKING);
    const b = run(new Blink({ random: mulberry32(9) }), 20, SPEAKING);
    expect(a).toEqual(b);
  });

  it('holds the schedule while suppressed rather than dropping the backlog', () => {
    // Suppression neither advances nor resets the clock toward the next blink,
    // so the eyes are ready to blink as soon as it lifts.
    const blink = new Blink({ random: mulberry32(13) });
    run(blink, 10, IDLE);
    run(blink, 30, SUPPRESSED);
    expect(countBlinks(blink, 10, IDLE)).toBeGreaterThan(0);
  });
});

describe('Blink / droop', () => {
  it('holds the lids at the droop between blinks', () => {
    const blink = new Blink({ random: mulberry32(5) });
    blink.droop = 0.4;
    for (const w of run(blink, 20, IDLE)) expect(w).toBeGreaterThanOrEqual(0.4);
  });

  it('still blinks under a light droop, and closes past it', () => {
    // Heavy lids that blink, which is what drowsiness looks like before sleep.
    const blink = new Blink({ random: mulberry32(5) });
    blink.droop = 0.4;
    const weights = run(blink, 40, IDLE);
    expect(Math.max(...weights)).toBeGreaterThan(0.9);
    expect(Math.min(...weights)).toBe(0.4);
  });

  it('never lets a blink open the eyes further than the droop', () => {
    // The failure this guards is the ugly one: a heavy lid snapping wide open
    // to blink and settling back.
    const blink = new Blink({ random: mulberry32(7) });
    blink.droop = 0.75;
    warm(blink);
    blink.trigger();
    for (const w of run(blink, 2, IDLE)) expect(w).toBeGreaterThanOrEqual(0.75);
  });

  it('outranks suppression, which is the director guessing rather than being told', () => {
    const blink = new Blink({ random: mulberry32(5) });
    blink.droop = 0.9;
    expect(blink.update(DT, SUPPRESSED)).toBe(0.9);
  });

  it('does not outrank the layer being switched off', () => {
    const blink = new Blink({ random: mulberry32(5) });
    blink.droop = 1;
    blink.enabled = false;
    expect(blink.update(DT, IDLE)).toBe(0);
  });

  it('is clamped rather than trusted', () => {
    const blink = new Blink({ random: mulberry32(5) });
    blink.droop = 4;
    expect(blink.update(DT, IDLE)).toBe(1);
    blink.droop = -2;
    expect(blink.update(DT, IDLE)).toBe(0);
  });

  it('goes back to an ordinary rhythm when it is cleared', () => {
    const blink = new Blink({ random: mulberry32(5) });
    blink.droop = 0.6;
    run(blink, 10, IDLE);
    blink.droop = 0;
    const weights = run(blink, 20, IDLE);
    expect(Math.min(...weights)).toBe(0);
    expect(countBlinks(new Blink({ random: mulberry32(5) }), 30, IDLE)).toBeGreaterThan(0);
  });
});
