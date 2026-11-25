import { describe, expect, it } from 'vitest';
import type { VisemeTrack } from '@/engine/face';
import { retimeTrack, scaleTrack, textToVisemes } from '@/engine/face';

/** An envelope that is silent exactly on the given `[from, to)` spans and loud elsewhere. */
const envelope =
  (silent: Array<[number, number]>) =>
  (s: number): number =>
    silent.some(([a, b]) => s >= a - 1e-9 && s < b - 1e-9) ? 0 : 1;

/** Three phrases and two commas: breaks at 0.405 s and 0.964 s, 1.523 s long. */
const track: VisemeTrack = textToVisemes('あいう、えおか、きくけ');

/** The first event after break `i`. */
const firstAfter = (t: VisemeTrack, i: number) => t.events.filter((e) => e.t > t.breaks[i].t)[0];

describe('retimeTrack', () => {
  const seconds = track.duration * 1.5;

  it('starts the first mora after each break where its silence ends', () => {
    const k = seconds / track.duration;
    // Silences placed near the stretched breaks, with their own lengths.
    const s0 = track.breaks[0].t * k;
    const s1 = track.breaks[1].t * k + 0.1;
    const level = envelope([
      [s0, s0 + 0.3],
      [s1, s1 + 0.4],
    ]);
    const out = retimeTrack(track, seconds, level);
    expect(out.duration).toBe(seconds);
    // Silence ends sit on the 10 ms sample grid.
    const grid = (x: number) => Math.ceil(x / 0.01 - 1e-9) * 0.01;
    expect(firstAfter(out, 0).t).toBeCloseTo(grid(s0 + 0.3), 9);
    expect(firstAfter(out, 1).t).toBeCloseTo(grid(s1 + 0.4), 9);
    expect(out).not.toEqual(scaleTrack(track, seconds));
  });

  it('matches scaleTrack when a silence has no break to pair with', () => {
    // Stretched span midpoints are 0.72 s and 1.56 s; the second silence is more than the tolerance from both.
    const level = envelope([
      [0.65, 0.95],
      [1.0, 1.3],
    ]);
    expect(retimeTrack(track, seconds, level)).toEqual(scaleTrack(track, seconds));
  });

  it('matches scaleTrack without a level', () => {
    expect(retimeTrack(track, seconds)).toEqual(scaleTrack(track, seconds));
  });

  it('matches scaleTrack when the take has no silence', () => {
    expect(retimeTrack(track, seconds, () => 1)).toEqual(scaleTrack(track, seconds));
  });

  it('matches scaleTrack when the pairing would run backwards', () => {
    // Both silences sit nearest the second break; the first takes it and the other has nothing after.
    const level = envelope([
      [1.3, 1.5],
      [1.7, 1.9],
    ]);
    expect(retimeTrack(track, seconds, level)).toEqual(scaleTrack(track, seconds));
  });

  it('matches scaleTrack for an empty track', () => {
    const empty = textToVisemes('、、');
    expect(retimeTrack(empty, 2, () => 0)).toEqual(scaleTrack(empty, 2));
  });
});
