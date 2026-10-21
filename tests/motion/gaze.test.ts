import { describe, expect, it } from 'vitest';
import { AVERT_MIN, END_RETURN, Gaze, HOLD_MEAN, type SpeechGaze } from '@/engine/motion/gaze';
import { smoothstep } from '@/engine/motion/idle';

/** 32-bit linear congruential generator, so every run is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Counts draws, and hands out queued values before falling back to the generator. */
class Rng {
  draws = 0;
  readonly queue: number[] = [];
  private readonly base: () => number;

  constructor(base: () => number) {
    this.base = base;
  }

  readonly next = (): number => {
    this.draws++;
    return this.queue.shift() ?? this.base();
  };
}

/**
 * The wander as it was before speech reached it, copied verbatim with the
 * generator injected. The speech-aware gaze has to match it wherever no
 * speech-driven state is in flight.
 */
class ReferenceGaze {
  ox = 0;
  oy = 0;
  sx = 0;
  sy = 0;
  saccade = 0;
  private vx = 0;
  private vy = 0;
  private tx = 0;
  private ty = 0;
  private fx = 0;
  private fy = 0;
  private sacT = 1;
  private sacDur = 0.05;
  private timer = 1.2;
  private readonly random: () => number;

  constructor(random: () => number) {
    this.random = random;
  }

  update(dt: number): void {
    this.saccade = 0;
    this.timer -= dt;
    if (this.timer <= 0) {
      const back = this.random() < 0.45;
      const nx = back ? 0 : (this.random() - 0.5) * 0.42;
      const ny = back ? 0 : (this.random() - 0.5) * 0.22;
      const amp = Math.hypot(nx - this.ox, ny - this.oy);
      this.saccade = amp;
      this.tx = nx;
      this.ty = ny;
      this.fx = this.ox;
      this.fy = this.oy;
      this.sacT = 0;
      this.sacDur = 0.026 + amp * 0.24;
      this.timer = 0.9 + this.random() * 2.8;
    }

    if (this.sacT < 1) {
      this.sacT = Math.min(1, this.sacT + dt / this.sacDur);
      const e = smoothstep(this.sacT);
      this.ox = this.fx + (this.tx - this.fx) * e;
      this.oy = this.fy + (this.ty - this.fy) * e;
    }

    const mag = Math.hypot(this.ox, this.oy);
    const follow = mag > 0.05 ? (mag - 0.05) / mag : 0;
    const tx = this.ox * follow;
    const ty = this.oy * follow;
    [this.sx, this.vx] = headStep(this.sx - tx, this.vx, dt);
    [this.sy, this.vy] = headStep(this.sy - ty, this.vy, dt);
    this.sx += tx;
    this.sy += ty;
  }
}

/**
 * The head settle in closed form, poles read off the explicit step at 3.4 rad/s
 * and damping 0.72 that it was tuned with at 50 Hz. See `gaze-head.test.ts`.
 */
function headStep(y: number, v: number, dt: number): [number, number] {
  const tuned = 1 / 50;
  const h = 3.4 * tuned;
  const det = 1 - 2 * 0.72 * h;
  const decay = -Math.log(det) / (2 * tuned);
  const freq = Math.acos((2 - h * h - 2 * 0.72 * h) / (2 * Math.sqrt(det))) / tuned;
  const e = Math.exp(-decay * dt);
  const c = Math.cos(freq * dt);
  const s = Math.sin(freq * dt);
  const b = (v + decay * y) / freq;
  return [e * (y * c + b * s), e * ((freq * b - decay * y) * c - (decay * b + freq * y) * s)];
}

interface Frame {
  ox: number;
  oy: number;
  sx: number;
  sy: number;
  saccade: number;
  draws: number;
}

const QUIET: SpeechGaze = { speaking: false, remaining: 0, opens: false, closes: false };

const speaking = (remaining: number, opens: boolean, closes: boolean): SpeechGaze => ({
  speaking: true,
  remaining,
  opens,
  closes,
});

/** A gaze on a counted, seeded generator, stepped one frame at a time. */
function subject(seed: number, dt: number, base: () => number = lcg(seed)) {
  const rng = new Rng(base);
  const gaze = new Gaze({ random: rng.next });
  let i = 0;
  const step = (speech?: SpeechGaze): Frame => {
    i++;
    gaze.update(dt, i * dt, speech);
    return {
      ox: gaze.offset.x,
      oy: gaze.offset.y,
      sx: gaze.settled.x,
      sy: gaze.settled.y,
      saccade: gaze.saccade,
      draws: rng.draws,
    };
  };
  return { rng, step };
}

/** The same, on the copied algorithm. */
function reference(seed: number, dt: number) {
  const rng = new Rng(lcg(seed));
  const gaze = new ReferenceGaze(rng.next);
  return (): Frame => {
    gaze.update(dt);
    return {
      ox: gaze.ox,
      oy: gaze.oy,
      sx: gaze.sx,
      sy: gaze.sy,
      saccade: gaze.saccade,
      draws: rng.draws,
    };
  };
}

/** Seed-dependent idle lead-in, so the rising edge meets the wander mid-flight. */
const warmFrames = (seed: number, dt: number): number => Math.round((1 + (seed % 10) * 0.13) / dt);

/** Plays one line of `duration` seconds, `remaining` counting down per frame. */
function playLine(
  step: (s?: SpeechGaze) => Frame,
  dt: number,
  duration: number,
  opens: boolean,
  closes: boolean,
): Frame[] {
  const frames: Frame[] = [];
  const n = Math.round(duration / dt);
  for (let k = 0; k < n; k++) frames.push(step(speaking(duration - k * dt, opens, closes)));
  return frames;
}

const mag = (f: Frame): number => Math.hypot(f.ox, f.oy);
const atCamera = (f: Frame): boolean => f.ox === 0 && f.oy === 0;
const DTS = [1 / 60, 1 / 50];

describe('gaze without speech-driven state matches the plain wander', () => {
  const scripts: Array<[string, (i: number) => SpeechGaze | undefined]> = [
    ['speech omitted', () => undefined],
    ['speaking: false', () => ({ speaking: false, remaining: 0, opens: true, closes: true })],
    [
      'opens and closes false, speaking toggled',
      (i) => ({
        speaking: Math.floor(i / 37) % 2 === 1,
        remaining: 5,
        opens: false,
        closes: false,
      }),
    ],
  ];
  for (const [name, script] of scripts) {
    it(`frame for frame over 30 s: ${name}`, () => {
      for (const dt of DTS) {
        for (const seed of [1, 2, 3, 4, 5]) {
          const { step } = subject(seed, dt);
          const ref = reference(seed, dt);
          const n = Math.round(30 / dt);
          const actual: Frame[] = [];
          const expected: Frame[] = [];
          for (let i = 0; i < n; i++) {
            actual.push(step(script(i)));
            expected.push(ref());
          }
          expect(actual).toEqual(expected);
        }
      }
    });
  }
});

describe('gaze at the edges of a run', () => {
  it('opens an aversion within 0.15 s and holds it at |offset| >= 0.1', () => {
    for (const dt of DTS) {
      for (let seed = 1; seed <= 50; seed++) {
        const { rng, step } = subject(seed, dt);
        for (let k = warmFrames(seed, dt); k > 0; k--) step(QUIET);
        rng.queue.push(0); // the onset roll passes; direction and hold come from the seed
        const frames = playLine(step, dt, 6, true, false);
        expect(frames[0].saccade).toBeGreaterThan(0);
        const back = frames.findIndex((f, k) => k > 0 && f.saccade > 0);
        expect(back * dt).toBeGreaterThanOrEqual(AVERT_MIN - 1e-9);
        let held = back;
        while (held > 0 && mag(frames[held - 1]) >= 0.1) held--;
        expect(held * dt).toBeLessThanOrEqual(0.15);
      }
    }
  });

  it('holds (0,0) at the close of a run once 0.15 s have passed', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const dt = seed % 4 === 0 ? 1 / 50 : 1 / 60;
      const { step } = subject(seed, dt);
      for (let k = warmFrames(seed, dt); k > 0; k--) step(QUIET);
      const duration = 4 + (seed % 9) * 0.5;
      const n = Math.round(duration / dt);
      let pinnedAt = -1;
      for (let k = 0; k < n; k++) {
        const remaining = duration - k * dt;
        const f = step(speaking(remaining, true, true));
        if (remaining < END_RETURN && pinnedAt < 0) pinnedAt = k;
        if (pinnedAt >= 0 && (k - pinnedAt) * dt > 0.15) expect(atCamera(f)).toBe(true);
      }
      expect(pinnedAt).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not avert when the line continues a run', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const dt = 1 / 60;
      const { step } = subject(seed, dt);
      const ref = reference(seed, dt);
      for (let k = warmFrames(seed, dt); k > 0; k--) expect(step(QUIET)).toEqual(ref());
      const onsetFrames = Math.floor(0.15 / dt) + 1;
      for (let k = 0; k < onsetFrames; k++) {
        const f = step(speaking(6 - k * dt, false, false));
        expect(f).toEqual(ref());
        const aversion =
          (f.ox === 0 && Math.abs(f.oy) === 0.11) || (Math.abs(f.ox) === 0.21 && f.oy === 0);
        expect(aversion).toBe(false);
      }
    }
  });

  it('leaves the close of a line that does not end its run unpinned', () => {
    const dt = 1 / 60;
    let off = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const { step } = subject(seed, dt);
      for (let k = warmFrames(seed, dt); k > 0; k--) step(QUIET);
      const duration = END_RETURN + AVERT_MIN + 0.09;
      const n = Math.round(duration / dt);
      let seen = false;
      for (let k = 0; k < n; k++) {
        const remaining = duration - k * dt;
        const f = step(speaking(remaining, true, false));
        if (remaining < END_RETURN && !atCamera(f)) seen = true;
      }
      if (seen) off++;
    }
    expect(off).toBeGreaterThanOrEqual(150);
  });

  it('does not avert on a line too short to return in time', () => {
    for (const dt of DTS) {
      for (let seed = 1; seed <= 50; seed++) {
        const { step } = subject(seed, dt);
        const ref = reference(seed, dt);
        for (let k = warmFrames(seed, dt); k > 0; k--) expect(step(QUIET)).toEqual(ref());
        const duration = END_RETURN + AVERT_MIN - 0.11;
        const n = Math.round(duration / dt);
        for (let k = 0; k < n; k++) {
          expect(step(speaking(duration - k * dt, true, false))).toEqual(ref());
        }
      }
    }
  });

  it('returns within 0.2 s when speech stops mid-hold, then resumes the wander', () => {
    for (const dt of DTS) {
      for (let seed = 1; seed <= 20; seed++) {
        const { rng, step } = subject(seed, dt);
        for (let k = warmFrames(seed, dt); k > 0; k--) step(QUIET);
        // Roll passes, side, left, hold at the mean.
        rng.queue.push(0, 0.6, 0.3, 0, 0);
        // The first 0.6 s of a 5 s line: long enough to avert, stopped mid-hold.
        let last = step(speaking(5, true, false));
        for (let k = 1; k < Math.round(0.6 / dt); k++)
          last = step(speaking(5 - k * dt, true, false));
        expect(mag(last)).toBeCloseTo(0.21, 9);
        const drawsAtStop = rng.draws;
        const returnFrames = Math.floor(0.2 / dt);
        let returned = false;
        for (let k = 0; k < returnFrames; k++) if (atCamera(step(QUIET))) returned = true;
        expect(returned).toBe(true);
        let resumed = false;
        for (let k = Math.round(4 / dt); k > 0 && !resumed; k--) {
          if (step(QUIET).draws > drawsAtStop) resumed = true;
        }
        expect(resumed).toBe(true);
      }
    }
  });

  it('abandons a hold when the run closes during it', () => {
    for (const dt of DTS) {
      for (let seed = 1; seed <= 20; seed++) {
        const { rng, step } = subject(seed, dt);
        for (let k = warmFrames(seed, dt); k > 0; k--) step(QUIET);
        rng.queue.push(0, 0.6, 0.3, 0, 0);
        const duration = 3.2;
        const closeAt = Math.round(0.9 / dt);
        const n = Math.round(duration / dt);
        for (let k = 0; k < n; k++) {
          const elapsed = k * dt;
          const f = step(speaking(duration - elapsed, true, k >= closeAt));
          if (k === closeAt - 3) expect(mag(f)).toBeCloseTo(0.21, 9);
          // Back at the camera well before the hold's own end at HOLD_MEAN.
          if (k > closeAt && (k - closeAt) * dt > 0.15) expect(atCamera(f)).toBe(true);
        }
        expect(closeAt * dt + 0.15).toBeLessThan(HOLD_MEAN);
      }
    }
  });

  it('holds for the mean, finitely, when every draw is 0', () => {
    for (const dt of DTS) {
      const { step } = subject(0, dt, () => 0);
      const warm = Array.from({ length: Math.round(2 / dt) }, () => step(QUIET));
      const frames = playLine(step, dt, 6, true, false);
      for (const f of [...warm, ...frames]) {
        for (const v of Object.values(f)) expect(Number.isFinite(v)).toBe(true);
      }
      expect(frames[0].saccade).toBeGreaterThan(0);
      const back = frames.findIndex((f, k) => k > 0 && f.saccade > 0);
      expect(frames[back - 1].oy).toBeCloseTo(0.11, 9);
      expect(back * dt).toBeGreaterThanOrEqual(HOLD_MEAN - 1e-9);
      expect(back * dt).toBeLessThan(HOLD_MEAN + dt + 1e-9);
    }
  });
});
