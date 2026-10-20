import type { VisemeTrack } from '../face/lipsync';
import { minJerk } from './timing';

/**
 * Phrase-final nods.
 *
 * In Japanese conversation the head nods at the last syllable of a strong
 * phrase boundary rather than on pitch accents (Ishi 2007), so the nod is a
 * discrete event laid on top of the continuous speaking sway rather than a
 * replacement for it. Where a boundary is comes from the text's punctuation;
 * how strong it is comes from the audio, because only a measured pause tells a
 * comma that was breathed from one that was run through.
 *
 * Two halves: `planHeadBeats` decides once per line which boundaries nod, and
 * `HeadBeats` plays the plan against the line's clock. A nod that has started
 * runs on its own clock to the end, so a cut, an interrupt or a clock that
 * jumps never re-seeks one mid-flight and never puts a step in the head.
 */

/** A planned nod: `t` is the downward peak in seconds, `amp` its pitch in rad, positive down. */
export interface HeadBeat {
  t: number;
  amp: number;
}

export interface BeatPlanOptions {
  /** The take's normalised envelope at a time in the line. Without it every comma is weak. */
  level?: (seconds: number) => number;
  /** Nothing is queued behind the line, so its end hands the turn over. Defaults to true. */
  closes?: boolean;
  /** Injectable only so a test can draw the plan deterministically. */
  random?: () => number;
}

// Nod rate at a strong boundary inside a turn (Ishi 2007, turn-keep).
const P_KEEP = 0.57;
// Nod rate at the end of a turn that hands the floor over (Ishi 2007, turn-give).
const P_GIVE = 0.37;
// Nod rate at a question, wherever it falls (Ishi 2007, dialogue act q).
const P_QUESTION = 0.36;

// Envelope level counted as silence: about -22 dB from the take's reference, under breath
// noise and over a decaying vowel (estimate).
const SILENCE_LEVEL = 0.08;
// Shortest silence that separates two inter-pausal units (Koiso 1998).
const IPU_PAUSE = 0.2;
// How far a synthesised pause may sit before or after where the text puts its punctuation
// (estimate).
const SCAN_BEFORE = 0.05;
const SCAN_AFTER = 0.15;
// Envelope frame, matching the 100 Hz envelope the take is measured at.
const SCAN_STEP = 0.01;

// Peak pitch of a nod in rad. No measured figure in degrees exists to start from, so it is set
// by eye and still wants a look at the render.
export const NOD_PITCH = 0.06;
// Closest two planned peaks may sit, so one 0.55 s nod never overlaps the next.
const MIN_SPACING = 0.6;
// How long past its start a nod first seen late may still begin: its peak then stays inside the
// ±0.15 s a boundary's position is uncertain by anyway. Set by eye, still wants a render check.
export const LATE_START = 0.1;

// Nod shape after Graf 2002: a small upward preparation, the drop onto the peak, a slower return.
const NOD_PREP = 0.1;
const NOD_PREP_DEPTH = 0.25;
const NOD_DROP = 0.15;
const NOD_RETURN = 0.3;
/** Seconds from a nod's start to its peak. */
export const NOD_LEAD = NOD_PREP + NOD_DROP;
/** Seconds from a nod's start to its end. */
export const NOD_LENGTH = NOD_LEAD + NOD_RETURN;

/**
 * A nod's pitch `u` seconds after it starts. Exactly zero outside
 * `[0, NOD_LENGTH)`; each segment is minimum-jerk, so every seam meets with
 * zero velocity and zero acceleration.
 */
export function nodShape(u: number, amp: number): number {
  if (u <= 0 || u >= NOD_LENGTH) return 0;
  if (u < NOD_PREP) return -NOD_PREP_DEPTH * amp * minJerk(u / NOD_PREP);
  if (u < NOD_LEAD) {
    const x = minJerk((u - NOD_PREP) / NOD_DROP);
    return -NOD_PREP_DEPTH * amp + (1 + NOD_PREP_DEPTH) * amp * x;
  }
  return amp * (1 - minJerk((u - NOD_LEAD) / NOD_RETURN));
}

/** Whether an inter-pausal silence starts within the scan window around `t`. */
function pauseAt(level: (seconds: number) => number, t: number, duration: number): boolean {
  const first = Math.round(-SCAN_BEFORE / SCAN_STEP);
  const last = Math.round(SCAN_AFTER / SCAN_STEP);
  const samples = Math.round(IPU_PAUSE / SCAN_STEP);
  for (let k = first; k <= last; k++) {
    let silent = true;
    for (let i = 0; i <= samples && silent; i++) {
      const s = t + (k + i) * SCAN_STEP;
      // Past the end of the take is silence, whatever the envelope reports there.
      silent = s >= duration || level(s) < SILENCE_LEVEL;
    }
    if (silent) return true;
  }
  return false;
}

/**
 * Decide which of a line's phrase boundaries nod, and how far.
 *
 * A boundary with no event starting at or after it ends the line; a line whose
 * text has no closing punctuation gets a major boundary at the end of its last
 * event. Draws are spent only where a nod is possible: none for a boundary
 * skipped or weak, one for a strong boundary that does not nod, two (the roll,
 * then the amplitude) for one that does. That keeps the plan stable when a rule
 * upstream of the roll changes.
 */
export function planHeadBeats(track: VisemeTrack, opts: BeatPlanOptions = {}): HeadBeat[] {
  const { level, closes = true, random = Math.random } = opts;
  const { events } = track;
  if (!events.length) return [];
  const endsLine = (t: number): boolean => !events.some((ev) => ev.t >= t);

  const bounds = track.breaks.slice();
  if (!bounds.some((b) => endsLine(b.t))) {
    const last = events[events.length - 1];
    bounds.push({ t: last.t + last.dur, kind: 'major' });
  }

  const beats: HeadBeat[] = [];
  let lastPeak = Number.NEGATIVE_INFINITY;
  for (const b of bounds) {
    // A nod peaking this early would have had to start before the line did.
    if (b.t < NOD_LEAD) continue;
    if (b.t - lastPeak < MIN_SPACING) continue;

    let p: number;
    if (b.kind === 'question') p = P_QUESTION;
    else if (endsLine(b.t)) p = closes ? P_GIVE : P_KEEP;
    else if (b.kind === 'major') p = P_KEEP;
    else p = level && pauseAt(level, b.t, track.duration) ? P_KEEP : 0;
    if (p === 0) continue;

    if (random() >= p) continue;
    // ±20% around the nominal pitch, so consecutive nods are not copies of each other.
    beats.push({ t: b.t, amp: NOD_PITCH * (0.8 + 0.4 * random()) });
    lastPeak = b.t;
  }
  return beats;
}

/**
 * Plays a nod plan against the line's clock.
 *
 * The line clock only places nods that have not started. Once one starts it
 * runs on its own clock from zero — the frame it starts on evaluates to zero —
 * so nothing that moves the line clock can move a nod already in the head.
 * Overlapping nods add. `update` allocates nothing.
 */
export class HeadBeats {
  private _plan: readonly HeadBeat[] = [];
  /** Index of the first plan entry not yet started or dropped. */
  private _next = 0;
  private _line = 0;
  // Active nods as parallel arrays, reused across frames; only `_count` entries are live.
  private readonly _amp: number[] = [];
  private readonly _clock: number[] = [];
  private _count = 0;

  /**
   * Drop what was pending under `cut`'s rule, then queue `beats` (in time order) against a line
   * clock at zero.
   */
  start(beats: readonly HeadBeat[]): void {
    this.cut();
    this._plan = beats;
    this._next = 0;
    this._line = 0;
  }

  /** Drop every nod not yet started. Those in flight finish on their own clocks. */
  cut(): void {
    this._next = this._plan.length;
  }

  /** Put the line clock where the line actually is. */
  sync(seconds: number): void {
    this._line = seconds;
  }

  /** Evaluate this frame's pitch in rad, positive down, then advance by `dt`. */
  update(dt: number): number {
    const plan = this._plan;
    while (this._next < plan.length) {
      const beat = plan[this._next];
      const late = this._line - (beat.t - NOD_LEAD);
      if (late < 0) break;
      this._next++;
      if (late <= LATE_START) this._activate(beat.amp);
    }

    let pitch = 0;
    for (let i = 0; i < this._count; i++) pitch += nodShape(this._clock[i], this._amp[i]);

    this._line += dt;
    for (let i = 0; i < this._count; ) {
      this._clock[i] += dt;
      if (this._clock[i] < NOD_LENGTH) {
        i++;
        continue;
      }
      // Finished: move the last live entry into its slot.
      const j = --this._count;
      this._clock[i] = this._clock[j];
      this._amp[i] = this._amp[j];
    }
    return pitch;
  }

  private _activate(amp: number): void {
    const i = this._count++;
    // Grows only when more nods overlap than ever have before; steady state reuses the slots.
    if (i === this._amp.length) {
      this._amp.push(amp);
      this._clock.push(0);
    } else {
      this._amp[i] = amp;
      this._clock[i] = 0;
    }
  }
}
