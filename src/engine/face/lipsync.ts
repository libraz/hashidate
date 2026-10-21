/**
 * Mouth layer.
 *
 * Text goes in, a timed viseme track comes out, and `schedule()` will take a
 * track from anywhere. The estimate this file builds is the fallback; when
 * there is speech, the track is stretched to the length the audio turned out
 * to be, the clock is the audio's own, and the travel is scaled by its
 * envelope — three separate corrections, and none of them is a rewrite.
 *
 * Why a stretch is the right correction and not a patch: `mora` and `pause`
 * below are only ever used to work out *proportions*. Normalise the whole
 * track to a measured length and the constants cancel — which is what makes
 * the estimate survive a voice that speaks faster than the one it was written
 * against, and a voice retrained tomorrow that speaks faster again. What does
 * not cancel is their ratio, which is about the shape of a sentence rather
 * than its speed: a voice that leans harder on its commas shifts where the
 * middle of the line falls, and that is a per-voice measurement rather than
 * something this file can know.
 */

import type { VisemeName } from '../types';

/** The visemes the mouth actually drives. `sil` is the absence of all of them. */
export type MouthViseme = Exclude<VisemeName, 'sil'>;

/** Per-viseme mouth weights, 0..1. */
export type MouthWeights = Record<MouthViseme, number>;

/** One mora's worth of mouth shape: which viseme, when it starts, how long it holds. */
export interface VisemeEvent {
  v: VisemeName;
  t: number;
  dur: number;
  /** Set on the lips-shut lead-in of a bilabial mora; always an `n` followed by its vowel. */
  closure?: true;
}

/** A phrase boundary the text marks: when the punctuation is reached, and how strong it is. */
export interface VisemeBreak {
  t: number;
  kind: 'minor' | 'major' | 'question';
}

/** A whole line's worth of events and phrase breaks, plus the estimated time to speak it. */
export interface VisemeTrack {
  events: VisemeEvent[];
  breaks: VisemeBreak[];
  duration: number;
}

/** Mora and pause lengths in seconds. Overridden once TTS supplies real timings. */
export interface VisemeOptions {
  mora?: number;
  pause?: number;
}

// Kana -> vowel. Small kana and the sokuon are handled separately.
const KANA_VOWEL: Record<string, VisemeName> = {
  あ: 'a',
  い: 'i',
  う: 'u',
  ゔ: 'u',
  え: 'e',
  お: 'o',
  か: 'a',
  き: 'i',
  く: 'u',
  け: 'e',
  こ: 'o',
  さ: 'a',
  し: 'i',
  す: 'u',
  せ: 'e',
  そ: 'o',
  た: 'a',
  ち: 'i',
  つ: 'u',
  て: 'e',
  と: 'o',
  な: 'a',
  に: 'i',
  ぬ: 'u',
  ね: 'e',
  の: 'o',
  は: 'a',
  ひ: 'i',
  ふ: 'u',
  へ: 'e',
  ほ: 'o',
  ま: 'a',
  み: 'i',
  む: 'u',
  め: 'e',
  も: 'o',
  や: 'a',
  ゆ: 'u',
  よ: 'o',
  ら: 'a',
  り: 'i',
  る: 'u',
  れ: 'e',
  ろ: 'o',
  わ: 'a',
  を: 'o',
  ん: 'n',
  が: 'a',
  ぎ: 'i',
  ぐ: 'u',
  げ: 'e',
  ご: 'o',
  ざ: 'a',
  じ: 'i',
  ず: 'u',
  ぜ: 'e',
  ぞ: 'o',
  だ: 'a',
  ぢ: 'i',
  づ: 'u',
  で: 'e',
  ど: 'o',
  ば: 'a',
  び: 'i',
  ぶ: 'u',
  べ: 'e',
  ぼ: 'o',
  ぱ: 'a',
  ぴ: 'i',
  ぷ: 'u',
  ぺ: 'e',
  ぽ: 'o',
  ぁ: 'a',
  ぃ: 'i',
  ぅ: 'u',
  ぇ: 'e',
  ぉ: 'o',
  ゃ: 'a',
  ゅ: 'u',
  ょ: 'o',
};

/** Morae that start with the lips pressed together: ま, ば and ぱ rows. */
const BILABIAL = /[まみむめもばびぶべぼぱぴぷぺぽ]/;

/** How long the lips stay shut before a bilabial mora, in seconds. Taken out of that mora's own hold. */
const CLOSURE = 0.05;

/** Largest gap, in seconds, at which two events still count as back to back. */
const ADJACENT = 0.01;

const VOWEL_OPEN: Record<VisemeName, number> = {
  a: 1.0,
  i: 0.35,
  u: 0.4,
  e: 0.65,
  o: 0.8,
  n: 0.12,
  sil: 0,
};

const toHiragana = (s: string): string =>
  s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/** Split text into timed viseme events. Returns [{ v, t, dur }]. */
export function textToVisemes(
  text: string,
  { mora = 0.135, pause = 0.22 }: VisemeOptions = {},
): VisemeTrack {
  const src = toHiragana(text);
  const out: VisemeEvent[] = [];
  const breaks: VisemeBreak[] = [];
  let t = 0;
  // Event count when the last break was placed; punctuation with nothing spoken since folds.
  let breakMark = 0;

  const markBreak = (kind: VisemeBreak['kind']): void => {
    if (out.length > breakMark) {
      breaks.push({ t, kind });
      breakMark = out.length;
    } else if (kind === 'question' && breaks.length) {
      breaks[breaks.length - 1].kind = 'question';
    }
  };

  for (const ch of src) {
    if (ch === 'っ') {
      t += mora * 0.6;
      continue;
    }
    if (ch === 'ー') {
      if (out.length) {
        out[out.length - 1].dur += mora * 0.8;
        t += mora * 0.8;
      }
      continue;
    }
    if (/[、,]/.test(ch)) {
      markBreak('minor');
      t += pause * 0.7;
      continue;
    }
    if (/[。.!?！？\n…⋯—–]/.test(ch)) {
      markBreak(/[?？]/.test(ch) ? 'question' : 'major');
      t += pause;
      continue;
    }
    // Quotation marks and brackets frame the words; they are not spoken morae.
    if (/[\p{Ps}\p{Pe}\p{Pi}\p{Pf}"']/u.test(ch)) continue;
    if (/\s/.test(ch)) {
      t += mora * 0.4;
      continue;
    }

    const v: VisemeName | null =
      KANA_VOWEL[ch] ?? (/[aiueo]/i.test(ch) ? (ch.toLowerCase() as VisemeName) : null);
    if (!v) {
      // Unknown glyph: keep the mouth moving anyway. A kanji is not one mora —
      // most read as two, some as three — so one gets two mouth movements while
      // a latin letter gets one. The vowels themselves are a guess.
      //
      // This is why `duration` is an estimate and not a contract: without a
      // reading it cannot be made exact, and once TTS supplies real timings
      // this path stops being used for anything but silent preview.
      const beats = /[々一-鿿豈-﫿]/.test(ch) ? 2 : 1;
      for (let k = 0; k < beats; k++) {
        out.push({ v: 'aiueo'[out.length % 5] as VisemeName, t, dur: mora });
        t += mora;
      }
      continue;
    }
    // Small kana glide onto the previous mora instead of adding one.
    if (/[ゃゅょぁぃぅぇぉ]/.test(ch) && out.length) {
      out[out.length - 1].v = v;
      continue;
    }
    const dur = mora * (v === 'n' ? 0.8 : 1);
    // `n` is the lips-shut shape. A ん before a bilabial already supplies it.
    const closed = BILABIAL.test(ch) && out[out.length - 1]?.v !== 'n';
    if (closed) {
      const shut = Math.min(CLOSURE, dur * 0.4);
      out.push({ v: 'n', t, dur: shut, closure: true });
      out.push({ v, t: t + shut, dur: dur - shut });
    } else {
      out.push({ v, t, dur });
    }
    t += dur;
  }
  return { events: out, breaks, duration: t };
}

/**
 * Stretch a track to a measured length, keeping its shape.
 *
 * One factor over the whole line rather than a per-mora correction, because a
 * single number is all the audio gives back: the take is one waveform and
 * nothing in it says where the third mora ended. So this fixes the ends
 * exactly and the middle approximately, and the approximation is the
 * estimate's own idea of how a sentence is distributed.
 *
 * That is worth more than it sounds. The error it leaves is proportional and
 * bounded by the line, where the error it removes accumulated down the queue —
 * a mouth that finishes early on every turn is a mouth that is visibly not
 * saying the words.
 */
export function scaleTrack(track: VisemeTrack, seconds: number): VisemeTrack {
  // A line with no morae in it — punctuation, or nothing at all — has no shape
  // to stretch. It gets the measured length and an empty track, which is a
  // mouth that stays shut for exactly as long as the audio lasts.
  if (!(track.duration > 0 && seconds > 0)) return { events: [], breaks: [], duration: seconds };
  const k = seconds / track.duration;
  const events = track.events.map((ev) => ({ ...ev, t: ev.t * k, dur: ev.dur * k }));
  // A fast take would squeeze a closure below what reads as lips meeting. Hold
  // it at CLOSURE, taken out of its own vowel, but never past half the mora.
  for (let i = 0; i < events.length - 1; i++) {
    const shut = events[i];
    if (!shut.closure) continue;
    const vowel = events[i + 1];
    const end = vowel.t + vowel.dur;
    shut.dur = Math.max(shut.dur, Math.min(CLOSURE, (end - shut.t) * 0.5));
    vowel.t = shut.t + shut.dur;
    vowel.dur = end - vowel.t;
  }
  return {
    events,
    breaks: track.breaks.map((b) => ({ t: b.t * k, kind: b.kind })),
    duration: seconds,
  };
}

export class Mouth {
  track: VisemeTrack | null;
  time: number;
  weights: MouthWeights;
  openness: number;
  busy: number;
  amplitude: number;
  /** Per-frame target, reused. `sil` is carried so a track may name it; only the six driven shapes are read. */
  readonly #target: Record<VisemeName, number> = { a: 0, i: 0, u: 0, e: 0, o: 0, n: 0, sil: 0 };
  /** Smoothed spoken shapes, before the closure gate is applied. */
  readonly #state: MouthWeights = { a: 0, i: 0, u: 0, e: 0, o: 0, n: 0 };
  /** How shut a bilabial closure holds the lips, 0..1. */
  #closure = 0;

  constructor() {
    this.track = null;
    this.time = 0;
    this.weights = { a: 0, i: 0, u: 0, e: 0, o: 0, n: 0 };
    this.openness = 0;
    this.busy = 0;
    this.amplitude = 1;
  }

  /**
   * Start on a finished track, whatever built it.
   *
   * The seam the whole layer is arranged around: an estimate from `text`, that
   * estimate stretched to a measured take, or one day a track aligned mora by
   * mora against the audio. All three arrive here and nothing below this line
   * can tell which it got.
   */
  schedule(track: VisemeTrack): number {
    this.track = track;
    this.time = 0;
    return track.duration;
  }

  speak(text: string, opts?: VisemeOptions): number {
    return this.schedule(textToVisemes(text, opts));
  }

  stop(): void {
    this.track = null;
  }

  /**
   * Put the track's clock where the audio actually is.
   *
   * Frames drop and audio does not. Left to accumulate `dt`, the mouth drifts
   * against the take by however much the renderer stalled, and it drifts one
   * way — a frame is never delivered early. Cues ride this same clock, so they
   * are corrected by the same call.
   *
   * `update` still adds the frame's own `dt` on top, which puts the mouth where
   * the audio will be when the frame is *shown* rather than where it was when
   * the frame was built. That is the wanted half-frame, not an off-by-one.
   */
  sync(seconds: number): void {
    this.time = seconds;
  }

  /** External audio envelope, 0..1. Scales mouth travel when driving from TTS. */
  setAmplitude(a: number): void {
    this.amplitude = a;
  }

  get speaking(): boolean {
    return !!this.track && this.time <= this.track.duration + 0.2;
  }

  update(dt: number): void {
    const target = this.#target;
    for (const v in target) target[v as VisemeName] = 0;
    let closure = 0;

    if (this.track) {
      this.time += dt;
      const PRE = 0.045;
      const POST = 0.055;
      const events = this.track.events;
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        // Back-to-back events of one shape would max-merge into a held vowel.
        // Dropping the lead-in and the tail between them lets the target dip.
        const prev = events[i - 1];
        const next = events[i + 1];
        const pre =
          prev && prev.v === ev.v && Math.abs(prev.t + prev.dur - ev.t) < ADJACENT ? 0 : PRE;
        const post =
          next && next.v === ev.v && Math.abs(ev.t + ev.dur - next.t) < ADJACENT ? 0 : POST;
        const rel = this.time - ev.t;
        if (rel < -pre || rel > ev.dur + post) continue;
        // Attack into the mora, release out of it; overlapping events blend.
        const a = Math.min(1, Math.max(0, (rel + pre) / 0.06));
        const r = Math.min(1, Math.max(0, (ev.dur + post - rel) / 0.075));
        if (ev.closure) closure = Math.max(closure, Math.min(a, r));
        else target[ev.v] = Math.max(target[ev.v] ?? 0, Math.min(a, r));
      }
      // Adjacent morae overlap during the crossfade. Two vowel shapes at full
      // strength distort the mouth, so keep their total within one shape.
      let sum = 0;
      for (const v in target) sum += target[v as VisemeName];
      if (sum > 1) for (const v in target) target[v as VisemeName] /= sum;
      if (this.time > this.track.duration + 0.25) this.track = null;
    }

    // Smooth toward the target so consonant boundaries do not pop.
    const k = 1 - Math.exp(-dt * 26);
    // A closure shuts the lips over whatever is still fading in or out, rather
    // than sharing the mouth with it: sharing left a mid-closure mouth half open.
    // It rides the track's own ramps unsmoothed; the decay only covers a stop().
    this.#closure = Math.max(closure, this.#closure * (1 - k));
    const open = 1 - this.#closure;
    let openness = 0;
    for (const key in this.#state) {
      const v = key as MouthViseme;
      const t = (target[v] ?? 0) * this.amplitude;
      this.#state[v] += (t - this.#state[v]) * k;
      this.weights[v] = this.#state[v] * open;
      openness = Math.max(openness, this.weights[v] * (VOWEL_OPEN[v] ?? 0.5));
    }
    this.weights.n = Math.max(this.weights.n, this.#closure * this.amplitude);
    this.openness = openness;
    this.busy += ((this.speaking ? 1 : 0) - this.busy) * (1 - Math.exp(-dt * 8));
  }
}
