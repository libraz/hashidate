import { describe, expect, it } from 'vitest';
import type { VisemeBreak, VisemeEvent, VisemeTrack } from '@/engine/face';
import { textToVisemes } from '@/engine/face';
import type { BeatPlanOptions, HeadBeat } from '@/engine/motion';
import {
  HeadBeats,
  LATE_START,
  NOD_LEAD,
  NOD_LENGTH,
  NOD_PITCH,
  nodShape,
  planHeadBeats,
} from '@/engine/motion';

/**
 * Phrase-final nods: which boundaries nod and how often, and how a plan plays.
 *
 * The rates are the published ones, so they are checked as rates over many
 * seeds rather than as particular draws. The playback is checked against what
 * the head may never do — step — under every way the line clock can misbehave.
 */

/**
 * Linear congruential generator. The seed goes through a golden-ratio multiply
 * first: consecutive raw seeds would otherwise give first draws that sweep a
 * narrow band in order rather than covering the interval.
 */
function lcg(seed: number): () => number {
  let s = Math.imul(seed, 0x9e3779b1) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Wraps a generator and counts what is drawn from it. */
function counting(random: () => number): { random: () => number; n: number } {
  const c = {
    n: 0,
    random: () => {
      c.n++;
      return random();
    },
  };
  return c;
}

/** Hands back a fixed script of draws, then a constant. */
function scripted(values: number[], rest = 0.5): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : rest);
}

const constant = (v: number) => () => v;

/** One mora every 0.1 s across `[0, end)`, with the given breaks. */
function line(breaks: VisemeBreak[], end = 3): VisemeTrack {
  const events: VisemeEvent[] = [];
  for (let i = 0; i * 0.1 < end - 1e-9; i++) events.push({ v: 'a', t: i * 0.1, dur: 0.1 });
  return { events, breaks, duration: end };
}

/** Envelope with 0.25 s of silence starting at `t` and full level everywhere else. */
const pauseAfter =
  (t: number) =>
  (s: number): number =>
    s >= t && s < t + 0.25 ? 0 : 1;

const loud = (): number => 1;

const SEEDS = 1000;

/** Share of seeds whose plan nods at `at`. */
function rate(track: VisemeTrack, at: number, opts: Omit<BeatPlanOptions, 'random'> = {}): number {
  let n = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    if (planHeadBeats(track, { ...opts, random: lcg(seed) }).some((b) => b.t === at)) n++;
  }
  return n / SEEDS;
}

describe('planHeadBeats', () => {
  it('nods at a strong boundary inside the line at the turn-keep rate', () => {
    expect(Math.abs(rate(line([{ t: 1, kind: 'major' }]), 1) - 0.57)).toBeLessThan(0.05);
    const strongMinor = rate(line([{ t: 1, kind: 'minor' }]), 1, { level: pauseAfter(1) });
    expect(Math.abs(strongMinor - 0.57)).toBeLessThan(0.05);
  });

  it('nods at the end of a line at turn-give when it closes the run, turn-keep if not', () => {
    const end = line([{ t: 3, kind: 'major' }]);
    expect(Math.abs(rate(end, 3, { closes: true }) - 0.37)).toBeLessThan(0.05);
    expect(Math.abs(rate(end, 3, { closes: false }) - 0.57)).toBeLessThan(0.05);
  });

  it('nods at a question at the question rate, inside the line or at its end', () => {
    expect(Math.abs(rate(line([{ t: 1, kind: 'question' }]), 1) - 0.36)).toBeLessThan(0.05);
    expect(Math.abs(rate(line([{ t: 3, kind: 'question' }]), 3) - 0.36)).toBeLessThan(0.05);
  });

  it('treats an omitted closes as closing', () => {
    const end = line([{ t: 3, kind: 'major' }]);
    for (let seed = 1; seed <= 50; seed++) {
      expect(planHeadBeats(end, { random: lcg(seed) })).toEqual(
        planHeadBeats(end, { closes: true, random: lcg(seed) }),
      );
    }
  });

  it('never nods at a weak boundary, and draws nothing for one', () => {
    const minor = line([{ t: 1, kind: 'minor' }]);
    for (let seed = 1; seed <= SEEDS; seed++) {
      expect(planHeadBeats(minor, { random: lcg(seed) }).some((b) => b.t === 1)).toBe(false);
      expect(planHeadBeats(minor, { level: loud, random: lcg(seed) }).some((b) => b.t === 1)).toBe(
        false,
      );
    }
    // Only the line's end draws: a roll and an amplitude.
    const c = counting(constant(0));
    planHeadBeats(minor, { level: loud, random: c.random });
    expect(c.n).toBe(2);
  });

  it('tells a strong comma from a weak one by the measured pause after it', () => {
    const minor = line([{ t: 1, kind: 'minor' }]);
    const at1 = (level: (s: number) => number) =>
      planHeadBeats(minor, { level, random: constant(0) }).some((b) => b.t === 1);
    expect(at1(pauseAfter(1))).toBe(true);
    expect(at1(loud)).toBe(false);
  });

  it('does not plan a boundary whose peak would come before 0.25 s', () => {
    const c = counting(constant(0));
    const beats = planHeadBeats(line([{ t: 0.2, kind: 'major' }]), { random: c.random });
    expect(beats.some((b) => b.t === 0.2)).toBe(false);
    // The early boundary draws nothing; the line's end draws its two.
    expect(beats).toHaveLength(1);
    expect(c.n).toBe(2);
  });

  it('puts each planned peak exactly on its boundary', () => {
    const beats = planHeadBeats(
      line([
        { t: 1, kind: 'major' },
        { t: 3, kind: 'question' },
      ]),
      { random: constant(0) },
    );
    expect(beats.map((b) => b.t)).toEqual([1, 3]);
  });

  it('adds a major boundary at the end of the last event when the text does not close', () => {
    const track = line([]);
    const last = track.events[track.events.length - 1];
    const beats = planHeadBeats(track, { random: constant(0) });
    expect(beats.map((b) => b.t)).toEqual([last.t + last.dur]);
  });

  it('plans nothing for a line with no events', () => {
    const c = counting(constant(0));
    expect(planHeadBeats({ events: [], breaks: [], duration: 2 }, { random: c.random })).toEqual(
      [],
    );
    expect(c.n).toBe(0);
  });

  it('skips a boundary two morae after a planned nod without drawing for it', () => {
    const track = textToVisemes('あいうえお。かき。くけこさしすせそたち。');
    const [b0, b1, b2] = track.breaks;
    expect(b1.t - b0.t).toBeLessThan(0.6);
    expect(b2.t - b0.t).toBeGreaterThanOrEqual(0.6);

    const c = counting(constant(0));
    const beats = planHeadBeats(track, { random: c.random });
    expect(beats.map((b) => b.t)).toEqual([b0.t, b2.t]);
    expect(c.n).toBe(4);

    for (let seed = 1; seed <= SEEDS; seed++) {
      const plan = planHeadBeats(track, { random: lcg(seed) });
      if (plan.some((b) => b.t === b0.t)) expect(plan.some((b) => b.t === b1.t)).toBe(false);
    }
  });

  it('draws as the consumption table says: 0 skipped or weak, 1 miss, 2 nod', () => {
    // Too early, weak, strong mid-line, then the end the plan adds.
    const track = line([
      { t: 0.1, kind: 'major' },
      { t: 1, kind: 'minor' },
      { t: 1.8, kind: 'major' },
    ]);
    const opts = { level: loud };

    const miss = counting(constant(0.99));
    expect(planHeadBeats(track, { ...opts, random: miss.random })).toEqual([]);
    expect(miss.n).toBe(2);

    const hit = counting(constant(0));
    expect(planHeadBeats(track, { ...opts, random: hit.random })).toHaveLength(2);
    expect(hit.n).toBe(4);

    const mixed = counting(scripted([0, 0.5, 0.99]));
    const beats = planHeadBeats(track, { ...opts, random: mixed.random });
    expect(beats).toEqual([{ t: 1.8, amp: NOD_PITCH }]);
    expect(mixed.n).toBe(3);
  });

  it('keeps every amplitude within ±20% of the nominal pitch', () => {
    const track = line([{ t: 1, kind: 'major' }]);
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const b of planHeadBeats(track, { random: lcg(seed) })) {
        expect(b.amp).toBeGreaterThanOrEqual(NOD_PITCH * 0.8);
        expect(b.amp).toBeLessThanOrEqual(NOD_PITCH * 1.2);
      }
    }
  });

  it('scales every boundary rate by `rate` and spends no draw where it is zero', () => {
    const track = line([{ t: 1, kind: 'major' }]);
    expect(rate(track, 1, { rate: 0.5 })).toBeCloseTo(rate(track, 1) * 0.5, 1);

    const c = counting(constant(0));
    expect(planHeadBeats(track, { rate: 0, random: c.random })).toEqual([]);
    expect(c.n).toBe(0);
  });

  it('scales every amplitude by `depth`', () => {
    const track = line([{ t: 1, kind: 'major' }]);
    const beats = planHeadBeats(track, { depth: 0.5, random: constant(0) });
    expect(beats.length).toBeGreaterThan(0);
    for (const b of beats) expect(b.amp).toBeCloseTo(NOD_PITCH * 0.8 * 0.5);
  });
});

/** Peak speed of the segment of the nod shape that `u` falls in; zero outside the window. */
function vmax(u: number | undefined, amp: number): number {
  if (u === undefined || u < 0 || u >= NOD_LENGTH) return 0;
  if (u < 0.1) return (1.875 * 0.25 * amp) / 0.1;
  if (u < 0.25) return (1.875 * 1.25 * amp) / 0.15;
  return (1.875 * amp) / 0.3;
}

interface Live {
  amp: number;
  u: number;
}

/**
 * An independent account of which nods are in flight and how far along each
 * is, from the rules alone: the line clock places a pending nod, a started one
 * runs on its own clock from zero, a late one past `LATE_START` is dropped.
 */
class Model {
  private plan: readonly HeadBeat[] = [];
  private next = 0;
  private line = 0;
  private live: Live[] = [];

  start(beats: readonly HeadBeat[]): void {
    this.plan = beats;
    this.next = 0;
    this.line = 0;
  }

  cut(): void {
    this.next = this.plan.length;
  }

  sync(s: number): void {
    this.line = s;
  }

  get clock(): number {
    return this.line;
  }

  /** The nods as this frame evaluates them, each with its own clock. */
  frame(dt: number): Array<{ ref: Live; u: number }> {
    while (this.next < this.plan.length) {
      const b = this.plan[this.next];
      const late = this.line - (b.t - NOD_LEAD);
      if (late < 0) break;
      this.next++;
      if (late <= LATE_START) this.live.push({ amp: b.amp, u: 0 });
    }
    const seen = this.live.map((ref) => ({ ref, u: ref.u }));
    this.line += dt;
    for (const l of this.live) l.u += dt;
    this.live = this.live.filter((l) => l.u < NOD_LENGTH);
    return seen;
  }
}

interface Both {
  start(beats: readonly HeadBeat[]): void;
  cut(): void;
  sync(s: number): void;
  readonly clock: number;
}

/**
 * Drives a `HeadBeats` and the model side by side for `frames` frames and
 * checks every frame: the output is the model's nods summed, exactly zero with
 * none in flight, and the change from the last frame stays under the sum of
 * each nod's segment speed limit times `dt`.
 */
function drive(
  dt: number,
  frames: number,
  plan: HeadBeat[],
  hook: (frame: number, both: Both) => void = () => {},
): number[] {
  const beats = new HeadBeats();
  const model = new Model();
  const both: Both = {
    start: (b) => {
      beats.start(b);
      model.start(b);
    },
    cut: () => {
      beats.cut();
      model.cut();
    },
    sync: (s) => {
      beats.sync(s);
      model.sync(s);
    },
    get clock() {
      return model.clock;
    },
  };
  both.start(plan);

  const out: number[] = [];
  let prev: Array<{ ref: Live; u: number }> = [];
  let prevOut = 0;
  for (let f = 0; f < frames; f++) {
    hook(f, both);
    const value = beats.update(dt);
    const cur = model.frame(dt);

    if (cur.length === 0) expect(value).toBe(0);
    const expected = cur.reduce((s, n) => s + nodShape(n.u, n.ref.amp), 0);
    expect(Math.abs(value - expected)).toBeLessThan(1e-12);

    let bound = 0;
    for (const ref of new Set([...prev.map((n) => n.ref), ...cur.map((n) => n.ref)])) {
      const was = prev.find((n) => n.ref === ref)?.u;
      const is = cur.find((n) => n.ref === ref)?.u;
      bound += Math.max(vmax(was, ref.amp), vmax(is, ref.amp)) * dt;
    }
    expect(Math.abs(value - prevOut)).toBeLessThanOrEqual(bound + 1e-9);

    out.push(value);
    prev = cur;
    prevOut = value;
  }
  return out;
}

const PLAN: HeadBeat[] = [
  { t: 1, amp: 0.06 },
  { t: 1.7, amp: 0.05 },
  { t: 2.4, amp: 0.07 },
];

describe('HeadBeats', () => {
  for (const dt of [1 / 60, 1 / 50]) {
    it(`is zero outside each window and never outruns the shape at dt ${dt.toFixed(4)}`, () => {
      const out = drive(dt, Math.ceil(3.5 / dt), PLAN);
      expect(Math.max(...out)).toBeGreaterThan(0.04);
      expect(out[0]).toBe(0);
      expect(out[out.length - 1]).toBe(0);
    });

    it(`lets a nod in flight finish after cut() at dt ${dt.toFixed(4)}`, () => {
      let cutAt = -1;
      const out = drive(dt, Math.ceil(3.5 / dt), PLAN, (f, both) => {
        if (cutAt < 0 && both.clock >= 1) {
          both.cut();
          cutAt = f;
        }
      });
      expect(out[cutAt + 1]).not.toBe(0);
      // The two nods after the cut never play.
      expect(out.slice(Math.ceil(1.6 / dt)).every((v) => v === 0)).toBe(true);
    });

    it(`adds a new line's nods to one still in flight at dt ${dt.toFixed(4)}`, () => {
      let restarted = false;
      const out = drive(dt, Math.ceil(2 / dt), PLAN, (_f, both) => {
        if (!restarted && both.clock >= 1) {
          both.start([{ t: 0.3, amp: 0.06 }]);
          restarted = true;
        }
      });
      expect(restarted).toBe(true);
      expect(out.some((v) => v !== 0)).toBe(true);
    });

    it(`does not re-seek a nod when the line clock jumps 0.5 s at dt ${dt.toFixed(4)}`, () => {
      let jumped = false;
      drive(dt, Math.ceil(3.5 / dt), PLAN, (_f, both) => {
        if (!jumped && both.clock >= 0.9) {
          both.sync(both.clock + 0.5);
          jumped = true;
        }
      });
      expect(jumped).toBe(true);
    });
  }

  it('reaches the planned amplitude at the peak when started on time', () => {
    const beat = { t: 1, amp: 0.06 };
    const beats = new HeadBeats();
    beats.start([beat]);
    beats.sync(beat.t - 0.25);
    // The frame the nod starts on evaluates its own clock at zero.
    expect(beats.update(1 / 60)).toBe(0);
    for (let i = 1; i < 15; i++) beats.update(1 / 60);
    // Fifteen frames on, its own clock is at the peak.
    expect(Math.abs(beats.update(1 / 60) - beat.amp)).toBeLessThan(1e-9);
  });

  it('starts a nod first seen within LATE_START of its start and drops one seen later', () => {
    const beat = { t: 1, amp: 0.06 };
    const begin = beat.t - NOD_LEAD;

    const onTime = new HeadBeats();
    onTime.start([beat]);
    onTime.sync(begin + 0.09);
    expect(onTime.update(1 / 60)).toBe(0);
    expect(onTime.update(1 / 60)).not.toBe(0);

    const late = new HeadBeats();
    late.start([beat]);
    late.sync(begin + 0.11);
    for (let i = 0; i < 60; i++) expect(late.update(1 / 60)).toBe(0);
  });
});
