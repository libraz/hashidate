import { type PerformanceId, performanceDef } from './performance';

/**
 * The idle autopilot's choices: what to perform next, which of the avatar's own
 * faces to put up, and when.
 *
 * Stands in for the orchestrator. In production the LLM decides what the
 * character feels and does; this picks plausible values on a timer so the idle
 * can be watched for minutes at a stretch. Several of the problems in this
 * layer — a face that never resets, motion that locks into a rhythm — only show
 * up when it is left running.
 *
 * The control server runs it, once, and sends every renderer the same choice:
 * the preview, the stage and a capture each drawing their own would each show a
 * different idle. The renderer only plays what it is sent. Pure on purpose, so
 * the server can import it without importing a renderer.
 */

/**
 * How long the queue has to stay empty before the idle takes over. Short enough
 * not to look dead between turns, long enough that the autopilot does not barge
 * in during the pause in a two-part answer.
 */
export const IDLE_AFTER = 1.6;

/**
 * What the autopilot draws from, weighted by repetition rather than by a number:
 * the rows show the weighting, which a table of probabilities does not.
 *
 * Performances rather than moods and gestures picked separately. Choosing the
 * two independently is what produced the tell this replaced — a character whose
 * face and hands were reliably about different things, waving cheerfully while
 * looking thoughtful, because nothing ever related the two choices.
 *
 * Mostly quiet, on purpose. An idle stream is a character standing there being
 * in some mood, punctuated by something; the `mood` rows are that standing, and
 * they outnumber everything else three to one. Poses are in the pool and sulking
 * and startlement are not — a held pose is fine because the next pick releases
 * it, whereas a character who is periodically furious at nothing is not.
 *
 * `calm` is absent for a third reason. A mood the autopilot holds for the better
 * part of ten seconds is what the character looks like between turns, and a
 * settled, half-lidded face held that long reads as drowsy rather than as
 * composed — the standing rows have to leave the character awake. Its weight
 * went to `blank` and `wonder`, so the amount of standing is unchanged and only
 * what is being felt while standing moved. `bashful` fidgets with its hands, so
 * it is punctuation rather than standing, and its standing weight went to `blank`. `sleepy` stays: a yawn that arrives
 * and passes is a punctuation mark, which is the row it sits in.
 *
 * This is also the idle movement pool. It names built-in performances only;
 * motions loaded from `show/motions/` are absent here and can run only when a
 * caller names them through the gesture command.
 */
// biome-ignore format: the repetition is the weighting, and the rows show it
export const AUTO_ACTS: readonly PerformanceId[] = [
  'blank', 'blank', 'blank', 'blank', 'blank', 'blank',
  'wonder', 'wonder', 'wonder',
  'blank', 'gloomy',
  'agree', 'agree', 'curious', 'curious', 'ponder', 'dunno', 'interested',
  'giggle', 'peace', 'applause',
  'shy', 'catPaw', 'sparkle', 'secret', 'sleepy', 'refresh', 'bouncy', 'plead',
  'polite', 'bored', 'guarded', 'nice', 'love', 'listening', 'bashful',
];

/**
 * One autopilot draw from the pool, weighted by its repetition.
 *
 * A gesture shared by two rows (`sparkle`) is one gesture, so repeats are
 * judged by gesture rather than by row. Rows with no gesture are never excluded.
 * After something has just ended (`settle`) the character stands in a mood
 * before moving again, so only rows with no gesture are eligible.
 */
export function chooseAutoAct(
  pool: readonly PerformanceId[],
  recentGestures: readonly string[],
  settle: boolean,
  random: () => number,
): PerformanceId {
  const rows = pool.filter((id) => {
    const gesture = performanceDef(id)?.gesture;
    if (!gesture) return true;
    return !(settle || recentGestures.includes(gesture));
  });
  return rows[Math.floor(random() * rows.length)];
}

/**
 * One choice. `face` is a draw in [0, 1) the renderer maps onto the avatar's
 * idle faces, or null to take the idle face down.
 */
export type IdleChoice = { act: PerformanceId } | { face: number | null };

/**
 * The autopilot's clocks and memory. Both clocks run only while it is engaged,
 * and each engagement starts with a standing row.
 */
export class Autopilot {
  readonly #random: () => number;
  #actTimer = 4;
  #faceTimer = 0;
  /** Gestures of the last two picks, newest first. */
  #recentGestures: string[] = [];
  /** Set when the autopilot starts, so its first pick is a standing one. */
  #settle = false;
  #engaged = false;

  constructor(random: () => number = Math.random) {
    this.#random = random;
  }

  /** Advance by `dt` seconds; answers the choices that fell due, in order. */
  advance(dt: number, engaged: boolean): IdleChoice[] {
    if (!engaged) {
      this.#engaged = false;
      return [];
    }
    if (!this.#engaged) {
      this.#engaged = true;
      this.#settle = true;
    }
    const out: IdleChoice[] = [];
    this.#actTimer -= dt;
    if (this.#actTimer <= 0) {
      // One channel, one pick: a performance decides face and body at once, so
      // whatever the character does, they are plausibly feeling it.
      const act = chooseAutoAct(AUTO_ACTS, this.#recentGestures, this.#settle, this.#random);
      this.#settle = false;
      const gesture = performanceDef(act)?.gesture;
      if (gesture) this.#recentGestures = [gesture, ...this.#recentGestures].slice(0, 2);
      out.push({ act });
      // Long enough that a pose is a pose rather than a flicker, uneven enough
      // that the rotation does not become a beat the viewer can count along with.
      this.#actTimer = 5.5 + this.#random() * 7;
    }
    // The avatar's own extra vocabulary, on a second and slower channel. It only
    // puts a face on top of what the body is doing, so it cannot disagree with it.
    this.#faceTimer -= dt;
    if (this.#faceTimer <= 0) {
      if (this.#random() < 0.45) {
        out.push({ face: this.#random() });
        this.#faceTimer = 3.5 + this.#random() * 3;
      } else {
        out.push({ face: null });
        this.#faceTimer = 7 + this.#random() * 8;
      }
    }
    return out;
  }

  /**
   * Hold off the next idle face after a reset, or it repoints as soon as idle
   * resumes and the reset never becomes visible.
   */
  holdFace(): void {
    this.#faceTimer = 3 + this.#random() * 3;
  }
}
