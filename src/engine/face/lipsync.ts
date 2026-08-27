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
}

/** A whole line's worth of events, plus the estimated time to speak it. */
export interface VisemeTrack {
  events: VisemeEvent[];
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
  let t = 0;

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
      t += pause * 0.7;
      continue;
    }
    if (/[。.!?！？\n]/.test(ch)) {
      t += pause;
      continue;
    }
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
    out.push({ v, t, dur: mora * (v === 'n' ? 0.8 : 1) });
    t += mora * (v === 'n' ? 0.8 : 1);
  }
  return { events: out, duration: t };
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
  if (!(track.duration > 0 && seconds > 0)) return { events: [], duration: seconds };
  const k = seconds / track.duration;
  return {
    events: track.events.map((ev) => ({ v: ev.v, t: ev.t * k, dur: ev.dur * k })),
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
    // `sil` is carried so a track may name it; only the six driven shapes are read.
    const target: Record<VisemeName, number> = { a: 0, i: 0, u: 0, e: 0, o: 0, n: 0, sil: 0 };

    if (this.track) {
      this.time += dt;
      const PRE = 0.045;
      const POST = 0.055;
      for (const ev of this.track.events) {
        const rel = this.time - ev.t;
        if (rel < -PRE || rel > ev.dur + POST) continue;
        // Attack into the mora, release out of it; overlapping events blend.
        const a = Math.min(1, Math.max(0, (rel + PRE) / 0.06));
        const r = Math.min(1, Math.max(0, (ev.dur + POST - rel) / 0.075));
        target[ev.v] = Math.max(target[ev.v] ?? 0, Math.min(a, r));
      }
      // Adjacent morae overlap during the crossfade. Two vowel shapes at full
      // strength distort the mouth, so keep their total within one shape.
      const sum = Object.values(target).reduce((s, v) => s + v, 0);
      if (sum > 1) for (const k of Object.keys(target) as VisemeName[]) target[k] /= sum;
      if (this.time > this.track.duration + 0.25) this.track = null;
    }

    // Smooth toward the target so consonant boundaries do not pop.
    const k = 1 - Math.exp(-dt * 26);
    let open = 0;
    for (const v of Object.keys(this.weights) as MouthViseme[]) {
      const t = (target[v] ?? 0) * this.amplitude;
      this.weights[v] += (t - this.weights[v]) * k;
      open = Math.max(open, this.weights[v] * (VOWEL_OPEN[v] ?? 0.5));
    }
    this.openness = open;
    this.busy += ((this.speaking ? 1 : 0) - this.busy) * (1 - Math.exp(-dt * 8));
  }
}
