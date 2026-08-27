import { describe, expect, it } from 'vitest';
import type { MouthViseme } from '@/engine/face';
import { Mouth, scaleTrack, textToVisemes } from '@/engine/face';
import type { VisemeName } from '@/engine/types';

/**
 * Mouth layer.
 *
 * The defaults are the module's own: one mora is 0.135 s, one sentence pause is
 * 0.22 s. Everything below is expressed against those two rather than against
 * the products, so a retimed mora moves the expectations with it.
 */
const MORA = 0.135;
const PAUSE = 0.22;

/** Every vowel a track may carry, in the order the fallback path cycles them. */
const VOWELS: VisemeName[] = ['a', 'i', 'u', 'e', 'o'];

const vowels = (text: string): VisemeName[] => textToVisemes(text).events.map((e) => e.v);

/** Run the mouth for `seconds`, calling `onFrame` after every step. */
function drive(mouth: Mouth, seconds: number, dt: number, onFrame?: (m: Mouth) => void): void {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    mouth.update(dt);
    onFrame?.(mouth);
  }
}

const total = (mouth: Mouth): number =>
  (Object.keys(mouth.weights) as MouthViseme[]).reduce((s, v) => s + mouth.weights[v], 0);

describe('textToVisemes / kana to vowel', () => {
  it.each([
    ['あ', 'a'],
    ['い', 'i'],
    ['う', 'u'],
    ['え', 'e'],
    ['お', 'o'],
    ['か', 'a'],
    ['き', 'i'],
    ['さ', 'a'],
    ['す', 'u'],
    ['た', 'a'],
    ['つ', 'u'],
    ['な', 'a'],
    ['ぬ', 'u'],
    ['は', 'a'],
    ['へ', 'e'],
    ['ま', 'a'],
    ['も', 'o'],
    ['や', 'a'],
    ['ゆ', 'u'],
    ['よ', 'o'],
    ['ら', 'a'],
    ['れ', 'e'],
    ['わ', 'a'],
    ['を', 'o'],
  ] as const)('%s reads as vowel %s', (kana, expected) => {
    expect(vowels(kana)).toEqual([expected]);
  });

  it.each([
    ['が', 'a'],
    ['ぎ', 'i'],
    ['ぐ', 'u'],
    ['げ', 'e'],
    ['ご', 'o'],
    ['ざ', 'a'],
    ['じ', 'i'],
    ['ず', 'u'],
    ['だ', 'a'],
    ['ぢ', 'i'],
    ['づ', 'u'],
    ['ば', 'a'],
    ['び', 'i'],
    ['ぶ', 'u'],
    ['べ', 'e'],
    ['ぼ', 'o'],
  ] as const)('dakuten %s keeps the base row vowel %s', (kana, expected) => {
    expect(vowels(kana)).toEqual([expected]);
  });

  it.each([
    ['ぱ', 'a'],
    ['ぴ', 'i'],
    ['ぷ', 'u'],
    ['ぺ', 'e'],
    ['ぽ', 'o'],
  ] as const)('handakuten %s keeps the base row vowel %s', (kana, expected) => {
    expect(vowels(kana)).toEqual([expected]);
  });

  it('drives ん as its own shape rather than as a vowel', () => {
    expect(vowels('ん')).toEqual(['n']);
  });

  it('gives ん a shorter hold than a full mora', () => {
    const [nn] = textToVisemes('ん').events;
    expect(nn.dur).toBeCloseTo(MORA * 0.8, 12);
    expect(nn.dur).toBeLessThan(MORA);
  });
});

describe('textToVisemes / katakana normalisation', () => {
  it('maps the katakana vowels onto the hiragana ones', () => {
    expect(vowels('アイウエオ')).toEqual(['a', 'i', 'u', 'e', 'o']);
  });

  it.each([
    ['カ', 'a'],
    ['シ', 'i'],
    ['ヅ', 'u'],
    ['ポ', 'o'],
    ['ン', 'n'],
  ] as const)('%s normalises to the same reading as its hiragana', (kana, expected) => {
    expect(vowels(kana)).toEqual([expected]);
  });

  it('produces an identical track for katakana and hiragana of the same line', () => {
    expect(textToVisemes('コンニチハ')).toEqual(textToVisemes('こんにちは'));
  });
});

describe('textToVisemes / timing glyphs', () => {
  it('advances time on っ without emitting an event', () => {
    const track = textToVisemes('あっあ');
    expect(vowels('あっあ')).toEqual(['a', 'a']);
    expect(track.events[1].t).toBeCloseTo(MORA + MORA * 0.6, 12);
  });

  it('lets っ hold for less than a full mora', () => {
    const gap = textToVisemes('あっあ').duration - textToVisemes('ああ').duration;
    expect(gap).toBeCloseTo(MORA * 0.6, 12);
    expect(gap).toBeLessThan(MORA);
  });

  it('extends the previous event on ー instead of adding one', () => {
    const track = textToVisemes('あー');
    expect(track.events).toHaveLength(1);
    expect(track.events[0].dur).toBeCloseTo(MORA + MORA * 0.8, 12);
    expect(track.duration).toBeCloseTo(MORA + MORA * 0.8, 12);
  });

  it('stacks repeated ー onto the same event', () => {
    const track = textToVisemes('あーー');
    expect(track.events).toHaveLength(1);
    expect(track.events[0].dur).toBeCloseTo(MORA + MORA * 1.6, 12);
  });

  it('drops a leading ー entirely, advancing neither the track nor the clock', () => {
    expect(textToVisemes('ーあ')).toEqual(textToVisemes('あ'));
  });

  it('glides a small kana onto the previous mora rather than adding one', () => {
    const track = textToVisemes('きゃ');
    expect(track.events).toHaveLength(1);
    expect(track.events[0].v).toBe('a');
    expect(track.duration).toBeCloseTo(MORA, 12);
  });

  it.each([
    ['しゅ', 'u'],
    ['しょ', 'o'],
    ['てぁ', 'a'],
    ['てぃ', 'i'],
    ['とぅ', 'u'],
    ['しぇ', 'e'],
    ['ちぇ', 'e'],
    ['ふぉ', 'o'],
  ] as const)('%s collapses to a single mora reading %s', (text, expected) => {
    expect(vowels(text)).toEqual([expected]);
  });

  it('emits a small kana as its own mora when nothing precedes it', () => {
    const track = textToVisemes('ゃ');
    expect(track.events).toHaveLength(1);
    expect(track.events[0].v).toBe('a');
  });

  it.each([
    ['、', PAUSE * 0.7],
    [',', PAUSE * 0.7],
    ['。', PAUSE],
    ['.', PAUSE],
    ['!', PAUSE],
    ['?', PAUSE],
    ['！', PAUSE],
    ['？', PAUSE],
    ['\n', PAUSE],
    [' ', MORA * 0.4],
  ] as const)('%j emits nothing and advances the clock by its own pause', (glyph, expected) => {
    const track = textToVisemes(`あ${glyph}あ`);
    expect(track.events).toHaveLength(2);
    expect(track.events[1].t - (track.events[0].t + track.events[0].dur)).toBeCloseTo(expected, 12);
  });

  it('holds a sentence break longer than a comma', () => {
    expect(textToVisemes('あ。').duration).toBeGreaterThan(textToVisemes('あ、').duration);
  });
});

describe('textToVisemes / glyphs with no reading', () => {
  it('still moves the mouth for an unknown glyph', () => {
    const track = textToVisemes('k');
    expect(track.events).toHaveLength(1);
    expect(track.events[0].dur).toBeCloseTo(MORA, 12);
  });

  it.each([
    ['一', 2],
    ['漢', 2],
    ['々', 2],
    ['k', 1],
    ['z', 1],
    ['@', 1],
  ] as const)('%s gets %i beat(s)', (glyph, beats) => {
    expect(textToVisemes(glyph).events).toHaveLength(beats);
  });

  it('cycles the guessed vowels so consecutive unknowns do not repeat one shape', () => {
    expect(vowels('kkkkkk')).toEqual([...VOWELS, 'a']);
  });

  it('reads a latin vowel as that vowel rather than as an unknown glyph', () => {
    expect(vowels('aiueo')).toEqual(VOWELS);
    expect(vowels('AIUEO')).toEqual(VOWELS);
  });
});

describe('textToVisemes / duration', () => {
  it('reports the end of the timeline, not the sum of the holds', () => {
    const track = textToVisemes('こんにちは');
    const end = Math.max(...track.events.map((e) => e.t + e.dur));
    expect(track.duration).toBeCloseTo(end, 12);
  });

  it('runs past the last event when the line ends on a pause', () => {
    const track = textToVisemes('あ。');
    const end = track.events[0].t + track.events[0].dur;
    expect(track.duration).toBeCloseTo(end + PAUSE, 12);
    expect(track.duration).toBeGreaterThan(end);
  });

  it('lays events end to end with no gap between plain morae', () => {
    const track = textToVisemes('あいうえお');
    for (let i = 1; i < track.events.length; i++) {
      const prev = track.events[i - 1];
      expect(track.events[i].t).toBeCloseTo(prev.t + prev.dur, 12);
    }
  });

  it('is an estimate: an unread kanji is timed by its beat count, not by its reading', () => {
    // 「東京」 is four morae and 「京都」 is three, but neither reading is known
    // here, so both come out as two beats each.
    expect(textToVisemes('東京').duration).toBeCloseTo(4 * MORA, 12);
    expect(textToVisemes('東京').duration).toBeCloseTo(textToVisemes('京都').duration, 12);
  });

  it('scales with the supplied mora and pause rather than with the defaults', () => {
    const track = textToVisemes('あ、あ', { mora: 0.2, pause: 0.5 });
    expect(track.duration).toBeCloseTo(0.2 + 0.5 * 0.7 + 0.2, 12);
  });

  it('returns an empty track for empty text', () => {
    expect(textToVisemes('')).toEqual({ events: [], duration: 0 });
  });

  it('returns no events for a line that is only punctuation, but still takes time', () => {
    const track = textToVisemes('、。');
    expect(track.events).toEqual([]);
    expect(track.duration).toBeCloseTo(PAUSE * 0.7 + PAUSE, 12);
  });
});

describe('Mouth', () => {
  it('returns the track duration from speak', () => {
    const mouth = new Mouth();
    expect(mouth.speak('こんにちは')).toBeCloseTo(textToVisemes('こんにちは').duration, 12);
  });

  it('reports nothing spoken before the first line', () => {
    const mouth = new Mouth();
    expect(mouth.speaking).toBe(false);
    expect(total(mouth)).toBe(0);
  });

  it('stays speaking through the tail past the last mora', () => {
    const mouth = new Mouth();
    const dur = mouth.speak('あい');
    drive(mouth, dur + 0.15, 1 / 120);
    expect(mouth.time).toBeGreaterThan(dur);
    expect(mouth.speaking).toBe(true);
  });

  it('stops speaking once the tail runs out', () => {
    const mouth = new Mouth();
    const dur = mouth.speak('あい');
    drive(mouth, dur + 0.3, 1 / 120);
    expect(mouth.speaking).toBe(false);
    expect(mouth.track).toBeNull();
  });

  it('smooths toward the target instead of stepping onto it', () => {
    const dt = 1 / 60;
    const mouth = new Mouth();
    mouth.speak('あ');
    mouth.update(dt);
    // One frame of an exponential approach with a 26 s^-1 rate constant.
    expect(mouth.weights.a).toBeCloseTo(1 - Math.exp(-dt * 26), 12);
    expect(mouth.weights.a).toBeLessThan(1);
    expect(mouth.weights.a).toBeGreaterThan(0);
  });

  it('reaches most of the way into a held mora within a few frames', () => {
    const dt = 1 / 60;
    const mouth = new Mouth();
    mouth.speak('あー');
    drive(mouth, 0.12, dt);
    expect(mouth.weights.a).toBeGreaterThan(0.9);
  });

  it('keeps the total mouth shape within one shape across the crossfade', () => {
    const dt = 1 / 240;
    const mouth = new Mouth();
    const dur = mouth.speak('あいうえお');
    let peak = 0;
    let overlaps = 0;
    drive(mouth, dur + 0.3, dt, (m) => {
      peak = Math.max(peak, total(m));
      const open = (Object.keys(m.weights) as MouthViseme[]).filter((v) => m.weights[v] > 0.15);
      if (open.length > 1) overlaps++;
    });
    // Morae really do overlap here, so the cap is doing work rather than never
    // being reached.
    expect(overlaps).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(1 + 1e-12);
    expect(peak).toBeGreaterThan(0.9);
  });

  it('opens the mouth further on あ than on い at the same weight', () => {
    const dt = 1 / 240;
    const peak = (text: string): number => {
      const mouth = new Mouth();
      const dur = mouth.speak(text);
      let out = 0;
      drive(mouth, dur + 0.2, dt, (m) => {
        out = Math.max(out, m.openness);
      });
      return out;
    };
    expect(peak('い') / peak('あ')).toBeCloseTo(0.35, 6);
  });

  it('eases busy up rather than latching it', () => {
    const dt = 1 / 60;
    const mouth = new Mouth();
    mouth.speak('あいうえお');
    mouth.update(dt);
    expect(mouth.busy).toBeCloseTo(1 - Math.exp(-dt * 8), 12);
    const first = mouth.busy;
    mouth.update(dt);
    expect(mouth.busy).toBeGreaterThan(first);
    expect(mouth.busy).toBeLessThan(1);
  });

  it('eases busy back down after the line ends', () => {
    const dt = 1 / 60;
    const mouth = new Mouth();
    const dur = mouth.speak('あいうえお');
    drive(mouth, dur, dt);
    const speakingBusy = mouth.busy;
    expect(speakingBusy).toBeGreaterThan(0.8);
    drive(mouth, 0.4, dt);
    expect(mouth.busy).toBeLessThan(speakingBusy);
    expect(mouth.busy).toBeGreaterThan(0);
    drive(mouth, 2, dt);
    expect(mouth.busy).toBeLessThan(0.01);
  });

  it('clears the track on stop and closes the mouth', () => {
    const dt = 1 / 120;
    const mouth = new Mouth();
    mouth.speak('あいうえお');
    drive(mouth, 0.2, dt);
    expect(total(mouth)).toBeGreaterThan(0.5);
    mouth.stop();
    expect(mouth.track).toBeNull();
    expect(mouth.speaking).toBe(false);
    drive(mouth, 0.5, dt);
    expect(total(mouth)).toBeLessThan(1e-4);
  });

  it('restarts the clock on a second speak', () => {
    const dt = 1 / 120;
    const mouth = new Mouth();
    mouth.speak('あいうえお');
    drive(mouth, 0.3, dt);
    expect(mouth.time).toBeGreaterThan(0.25);
    mouth.speak('かきくけこ');
    expect(mouth.time).toBe(0);
    expect(mouth.speaking).toBe(true);
  });

  it('scales mouth travel by the amplitude, linearly', () => {
    const dt = 1 / 240;
    const peak = (amplitude: number): number => {
      const mouth = new Mouth();
      mouth.setAmplitude(amplitude);
      const dur = mouth.speak('あいうえお');
      let out = 0;
      drive(mouth, dur + 0.2, dt, (m) => {
        out = Math.max(out, total(m));
      });
      return out;
    };
    const full = peak(1);
    expect(peak(0.5)).toBeCloseTo(full * 0.5, 10);
    expect(peak(0.25)).toBeCloseTo(full * 0.25, 10);
  });

  it('holds the mouth shut at zero amplitude while still counting as speaking', () => {
    const dt = 1 / 120;
    const mouth = new Mouth();
    mouth.setAmplitude(0);
    mouth.speak('あいうえお');
    drive(mouth, 0.3, dt);
    expect(total(mouth)).toBe(0);
    expect(mouth.openness).toBe(0);
    expect(mouth.speaking).toBe(true);
  });

  it('leaves the mouth closed when updated with no track', () => {
    const mouth = new Mouth();
    drive(mouth, 1, 1 / 60);
    expect(total(mouth)).toBe(0);
    expect(mouth.busy).toBe(0);
  });
});

describe('scaleTrack', () => {
  it('stretches a track onto a measured length, keeping its shape', () => {
    const estimate = textToVisemes('あいうえおかきくけこ');
    const scaled = scaleTrack(estimate, 3);

    expect(scaled.duration).toBe(3);
    expect(scaled.events).toHaveLength(estimate.events.length);
    // Every event moves by the same factor, so where a mora sits *within* the
    // line is exactly what the estimate said. That is the part being kept: the
    // stretch fixes the length, not the distribution.
    const k = 3 / estimate.duration;
    for (const [i, ev] of scaled.events.entries()) {
      expect(ev.v).toBe(estimate.events[i].v);
      expect(ev.t).toBeCloseTo(estimate.events[i].t * k, 12);
      expect(ev.dur).toBeCloseTo(estimate.events[i].dur * k, 12);
    }
  });

  it('is the identity when the measurement agrees with the estimate', () => {
    const estimate = textToVisemes('あいうえお');
    expect(scaleTrack(estimate, estimate.duration)).toEqual(estimate);
  });

  it('leaves the constants unable to matter, which is the point of doing it at all', () => {
    // The two tracks below disagree about how fast this voice speaks by a
    // factor of two. Normalised to the same measured length they are the same
    // track — which is what makes the estimate survive a voice retrained to
    // speak faster than the one these numbers were arrived at against.
    const slow = scaleTrack(textToVisemes('あいうえお', { mora: 0.2, pause: 0.33 }), 2);
    const fast = scaleTrack(textToVisemes('あいうえお', { mora: 0.1, pause: 0.165 }), 2);
    expect(slow).toEqual(fast);
  });

  it('keeps the shape across a line whose pauses do most of the work', () => {
    const estimate = textToVisemes('あ、い。う');
    const scaled = scaleTrack(estimate, 10);
    expect(scaled.duration).toBe(10);
    for (const [i, ev] of scaled.events.entries()) {
      expect(ev.t / 10).toBeCloseTo(estimate.events[i].t / estimate.duration, 12);
    }
  });

  it('yields a shut mouth for the length of audio that has no morae in it', () => {
    // Punctuation only. There is nothing to distribute, and the honest answer
    // is a mouth that stays closed for exactly as long as the take lasts rather
    // than one that invents a shape to fill it.
    expect(scaleTrack(textToVisemes('。。'), 1.5)).toEqual({ events: [], duration: 1.5 });
    expect(scaleTrack(textToVisemes(''), 2)).toEqual({ events: [], duration: 2 });
  });
});

describe('Mouth.schedule', () => {
  it('takes a track from anywhere and reports its length', () => {
    const mouth = new Mouth();
    const track = scaleTrack(textToVisemes('あいうえお'), 4);
    expect(mouth.schedule(track)).toBe(4);
    expect(mouth.track).toBe(track);
    expect(mouth.time).toBe(0);
  });

  it('is what speak() is built on, so both paths start the same way', () => {
    const a = new Mouth();
    const b = new Mouth();
    a.speak('あいうえお');
    b.schedule(textToVisemes('あいうえお'));
    expect(a.track).toEqual(b.track);
  });
});

describe('Mouth.sync', () => {
  it('puts the clock where it is told rather than where the frames added up to', () => {
    const mouth = new Mouth();
    mouth.speak('あいうえおかきくけこ');
    drive(mouth, 0.5, 1 / 60);
    expect(mouth.time).toBeGreaterThan(0.45);

    // A stalled renderer delivers frames late, and only late — so a mouth left
    // to accumulate `dt` can only run ahead of the audio. This is the
    // correction, and it goes backwards as often as forwards.
    mouth.sync(0.1);
    expect(mouth.time).toBe(0.1);
    mouth.update(1 / 60);
    expect(mouth.time).toBeCloseTo(0.1 + 1 / 60, 12);
  });

  it('can end the line by being told the audio is past it', () => {
    const mouth = new Mouth();
    const dur = mouth.speak('あいうえお');
    expect(mouth.speaking).toBe(true);
    mouth.sync(dur + 0.3);
    expect(mouth.speaking).toBe(false);
  });
});
