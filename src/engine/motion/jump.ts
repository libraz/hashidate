/**
 * The hop, as a pure function of the time since it started.
 *
 * No skeleton and no state: `planJump` turns the two physical figures into the
 * arc's durations once, and `sampleJump` reads the hips off it. The body layer
 * holds the elapsed time and writes the result into the rig.
 *
 * `HOPS` at the foot of the file is the vocabulary the rest of the runtime uses
 * — one hop, a bounce, a leap — so that nothing above the motion layer has to
 * name a height in metres to ask for a jump.
 */

/**
 * Countermovement, seconds — the dip taken before pushing off.
 *
 * Stated rather than derived. Everything else in the hop falls out of the two
 * physical figures (see `planJump`), but how long a character spends loading
 * for a jump is a choice about the performance and not a consequence of
 * gravity: the same hop can be taken briskly or reluctantly.
 */
export const CROUCH_T = 0.22;

/** Rising out of the landing dip back to standing, seconds. Same reasoning. */
export const RECOVER_T = 0.2;

/**
 * How far the hips may drop, metres.
 *
 * The rig has no legs — `profile/bones.ts` resolves the spine, the arms and the
 * fingers, and nothing below the hips — so a dip is the hips translating down
 * with the feet still attached, and past a couple of centimetres the feet go
 * through the floor. In a bust framing that is invisible and the cap is only
 * there to keep the full-body view honest.
 */
export const MAX_CROUCH = 0.05;

/** One run's arc: gravity, take-off speed, dip depth, and the phase durations. */
export interface JumpArc {
  g: number;
  v0: number;
  dip: number;
  /** How many hops the run is. Every one of them uses the durations below. */
  count: number;
  push: number;
  flight: number;
  brake: number;
}

/**
 * A small hop.
 *
 * Not a gesture. Gestures pose the arms and the spine and are composed with
 * one another; this translates the whole skeleton, runs alongside whatever the
 * arms are doing, and exists mainly so the secondary motion can be *seen*.
 * Breathing moves the chest a few millimetres, which is enough to keep hair
 * and a chest alive but not enough to tell a well-tuned chain from a badly
 * tuned one. A landing settles that in one frame.
 *
 * ## Two numbers, and the rest is arithmetic
 *
 * Given the apex height `h` and gravity `g`, take-off speed is `√(2gh)` and
 * the airborne time is `2v₀/g`. Nothing else has to be chosen, and nothing
 * else *may* be chosen without the arc going wrong somewhere — a hang time
 * picked by eye against a height picked by eye is how a jump ends up reading
 * as an elevator.
 *
 * Mass does not appear, here or anywhere below. It cancels out of free flight,
 * and the two places it would otherwise matter — how hard the legs push and
 * how the ground gives — are not modelled: there are no legs in this rig, and
 * the sway layer has no masses either, since its stiffness and drag are
 * per-step ratios with the mass already folded into the authored figures.
 *
 * ## The phases are joined by velocity, not by eye
 *
 * Each phase starts at the position and speed the previous one ended at, so
 * there is no step in velocity anywhere in the hop. That matters more than
 * usual here: a spring solver reads its parent's motion as a difference
 * between frames, so a discontinuity in the *velocity* of the hips is an
 * impulse the chains would report as a snap — and it would be a snap the
 * animation invented rather than one the jump earned.
 *
 * | phase | duration | ends at |
 * |---|---|---|
 * | crouch | `CROUCH_T` | dip depth, at rest |
 * | push | `2·dip/v₀` (constant acceleration) | ground, at `v₀` |
 * | flight | `2v₀/g` | ground, at `−v₀` |
 * | absorb | `dip·π/2v₀` | dip depth, at rest |
 * | recover | `RECOVER_T` | standing, at rest |
 *
 * The absorb phase is short because the dip it has to stop inside is capped
 * by a rig with no knees, and stopping a metre per second inside two
 * centimetres is a stiff landing. That is honest rather than unfortunate: the
 * character really has nothing to absorb with, and the stiffness is exactly
 * what makes the landing legible in the chains.
 *
 * ## A run of hops is one crouch and one recover
 *
 * `count` repeats the middle three phases and nothing else, because **absorb
 * already ends where crouch ends** — at dip depth, at rest. The landing dip of
 * one hop *is* the loading crouch of the next, so a bounce needs no new phase
 * and no join by eye: the velocity is continuous across the repeat for the same
 * reason it is continuous everywhere else here.
 *
 * That is also why a run has no gap parameter. Standing up between hops and
 * loading again is a different action — three jumps rather than a bounce — and
 * it is spelled by asking for three runs of one, not by padding this arc.
 */
export function planJump(height: number, gravity: number, count = 1): JumpArc {
  const g = Math.max(0.5, gravity);
  const h = Math.max(0.005, height);
  const v0 = Math.sqrt(2 * g * h);
  const dip = Math.min(h * 0.55, MAX_CROUCH);
  return {
    g,
    v0,
    dip,
    count: Math.max(1, Math.floor(count)),
    push: (2 * dip) / v0,
    flight: (2 * v0) / g,
    brake: (dip * Math.PI) / (2 * v0),
  };
}

/** Hips above rest in metres, and how compressed the body is, 0..1. */
export function sampleJump(
  arc: JumpArc,
  elapsed: number,
): { rise: number; load: number; done: boolean } {
  let t = elapsed;
  let rise = 0;

  // Skip whole hops before falling through the phases, so the chain below only
  // ever describes one of them. `count - 1` is a floor rather than a bound
  // check: past the last absorb the remainder falls out of the chain into the
  // recover, which is where the run actually ends.
  const cycle = arc.push + arc.flight + arc.brake;
  if (t > CROUCH_T) {
    t -= Math.min(arc.count - 1, Math.floor((t - CROUCH_T) / cycle)) * cycle;
  }

  // The chain below subtracts each phase's duration as it falls through, so `t`
  // is always measured from the start of whichever phase matched. Written any
  // other way it becomes five running sums that have to agree with each other,
  // and the whole point of the arc is that the phases are joined exactly.
  // biome-ignore-start lint/suspicious/noAssignInExpressions: see above

  // Sinking: eased at both ends, so it neither starts nor arrives with a jolt.
  if (t < CROUCH_T) {
    rise = -arc.dip * (1 - Math.cos(Math.PI * (t / CROUCH_T))) * 0.5;
  } else if ((t -= CROUCH_T) < arc.push) {
    // Pushing off. Constant acceleration is what makes the duration fall out
    // of the depth rather than being another number to pick: covering `dip`
    // from rest and arriving at `v₀` can only take `2·dip/v₀`.
    rise = -arc.dip + 0.5 * (arc.v0 / arc.push) * t * t;
  } else if ((t -= arc.push) < arc.flight) {
    rise = arc.v0 * t - 0.5 * arc.g * t * t;
  } else if ((t -= arc.flight) < arc.brake) {
    // Landing. A quarter sine takes the touchdown speed to rest without a
    // corner at either end; its length is set by the speed it has to kill and
    // the depth it is allowed to use.
    rise = -arc.dip * Math.sin(Math.PI * 0.5 * (t / arc.brake));
  } else if ((t -= arc.brake) < RECOVER_T) {
    rise = -arc.dip * (1 + Math.cos(Math.PI * (t / RECOVER_T))) * 0.5;
  } else {
    return { rise: 0, load: 0, done: true };
  }
  // biome-ignore-end lint/suspicious/noAssignInExpressions: see above

  return { rise, load: rise < 0 ? Math.min(1, -rise / arc.dip) : 0, done: false };
}

/** One run of hops, as everything above the motion layer asks for it. */
export interface HopSpec {
  /** Apex height, metres. */
  height: number;
  /** How many hops the run is. */
  count: number;
}

export interface HopDef extends HopSpec {
  label: string;
}

/**
 * The hop vocabulary.
 *
 * Three entries and not a slider, for the same reason the gesture table is a
 * table: what a caller wants to say is "bounce", and a height in metres is a
 * tuning figure that happens to produce one. The cadence is not stated at all —
 * it falls out of the height through the arc, so a bounce is quick because it is
 * small and a leap hangs because it is tall.
 */
export const HOPS = {
  hop: { label: 'ぴょん', height: 0.07, count: 1 },
  // Three, small and quick, with no standing up in between: this is the shape
  // of being pleased about something, and it lives or dies on the cadence.
  // Landing straight into the next crouch puts it near 3.5 Hz on its own.
  bounce: { label: 'ぴょんぴょん', height: 0.045, count: 3 },
  leap: { label: 'おおきく跳ぶ', height: 0.16, count: 1 },
} satisfies Record<string, HopDef>;

export type HopId = keyof typeof HOPS;

/** The hop ids, in table order. */
export const HOP_IDS = Object.keys(HOPS) as HopId[];
