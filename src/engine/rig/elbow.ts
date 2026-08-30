import * as THREE from 'three';
import type { ArmAnatomy } from '../anatomy';
import type { Profile, Side } from '../types';
import { poleAngle, type ReachLinks } from './reach';

/**
 * Where the elbow goes.
 *
 * Once a wrist position is fixed the elbow can still sit anywhere on a circle
 * around the shoulder-to-wrist line, and geometry has no opinion about where.
 * This is the part that turns a position into a pose, and it is the one place
 * in the rig that searches rather than solves.
 *
 * Every number here was arrived at by watching two avatars reach for things.
 */

/**
 * Elbow positions tried when solving a fingertip target.
 *
 * The elbow sits somewhere on a circle around the shoulder-to-wrist line, and
 * nothing about the fingertip says where. Sampling the circle and scoring each
 * position is what turns "put the fingertip here" into a pose an arm would
 * actually adopt — it is the whole of the back-solve, and the reason the anatomy
 * model needs a cost rather than a pass/fail limit.
 *
 * 24 samples puts them 15 degrees apart, which is finer than the cost surface
 * varies; the parabolic refinement afterwards costs one more evaluation and
 * removes the residual stepping.
 */
const SWIVEL_SAMPLES = 24;

/** How far the elbow moves toward its answer each frame. See `search`. */
const SWIVEL_TRACK = 0.25;

/**
 * How close the elbow has to get before it is simply put there, in radians.
 *
 * Tracking a fraction of the remaining distance each frame approaches the
 * answer and never reaches it, so a pose merely being held keeps creeping for
 * as long as it is held. That did not show while the hysteresis below was in
 * force, because staying put was itself the winning answer and the distance to
 * close was zero; with the elbow predicted from the target instead, the
 * remainder is real and has to be given somewhere to stop.
 *
 * A tenth of a degree. Small enough that closing it in one frame cannot be
 * seen, and it buys the property that matters more: the same target now yields
 * exactly the same elbow, so a pose looks the same however it was arrived at.
 */
const SWIVEL_SETTLE = 0.002;

/**
 * The prior is not always available: it lands on the reach line, and says
 * nothing there, whenever the hand is roughly where a hanging elbow would be —
 * an arm at rest by the side is exactly that case. The elbow circle is a
 * pinhead there and the choice does not matter, so what is wanted is only that
 * it does not jump about; the continuity weight is enough on its own.
 */
const SWIVEL_INERTIA = 0.05;

/**
 * Where a person's elbow goes for a given hand position, and how hard the
 * search is held to it.
 *
 * The strain search above answers "which elbow is most comfortable", and that
 * is not the question. An arm's posture is very nearly a function of where the
 * hand is — put your hand somewhere twice and the elbow arrives in the same
 * place both times, whatever route it took — and comfort is not what picks it.
 * The two shallow minima most targets have really are close to equally
 * comfortable, so scoring comfort alone leaves the choice underdetermined, and
 * everything that used to sit here — a continuity weight, a hysteresis margin,
 * a preference for staying put — existed to break a tie that comfort was never
 * going to break. Those are memory, and memory is exactly what an arm posture
 * does not have: they are also why a held pose could sit at one elbow and the
 * same pose reached from the other side sit at the other.
 *
 * So the search gets a prior instead: a predicted elbow position, from the hand
 * position alone, added to the cost as a penalty for departing from it. It
 * decides which of the two minima is in play; strain still does the fine work
 * within it, so every number the anatomy model was tuned to still applies.
 *
 * Being a function of the target and nothing else, the prior cannot flip-flop:
 * a target that is being held still predicts the same elbow every frame.
 *
 * The pole is stated in body spans from the shoulder, in the anatomy frame,
 * with the lateral axis pointing away from the midline on either side. It rides
 * three facts:
 *
 *  - the elbow hangs *below* the shoulder, and rises with the hand at roughly
 *    half the hand's own rate — the elevation regression
 *  - it swings outward as the hand rises, and further outward as the hand
 *    crosses toward the midline. Bringing a hand to the far cheek with the
 *    elbow tucked against the ribs is not a pose an arm can hold
 *  - it sits slightly behind the shoulder at rest and comes forward as the hand
 *    reaches forward, but much less far
 *
 * Only a prior, so these are the shape of the answer rather than the answer.
 */
const ELBOW_PRIOR = 2.0;
const ELBOW_POLE_OUT = 0.3;
const ELBOW_POLE_OUT_RISE = 0.34;
const ELBOW_POLE_OUT_CROSS = 0.24;
const ELBOW_POLE_UP = -0.92;
const ELBOW_POLE_UP_RISE = 0.55;
const ELBOW_POLE_FWD = -0.08;
const ELBOW_POLE_FWD_REACH = 0.3;

/** What the search needs from the rig around it. */
export interface ElbowContext {
  /** Solve the two-link reach at one trial elbow angle. */
  solveReach(side: Side, targetWorld: THREE.Vector3, angle: number, out: ReachLinks): unknown;
  /** Hand the anatomy model this arm's origin and segment lengths. */
  armContext(side: Side): boolean;
}

export class ElbowSearch {
  // Where each elbow sat last frame, so the fingertip search has somewhere to
  // prefer. Seeded slightly outward, which is where a hanging elbow is.
  private readonly _swivel: Record<Side, number> = { L: 0, R: 0 };

  // Scratch for the elbow prior. Held apart from the solver's own, which is
  // live across the whole of a fingertip solve while the prior is computed
  // inside it.
  private readonly _priorPole = new THREE.Vector3();
  private readonly _priorDir = new THREE.Vector3();
  private readonly _cand: ReachLinks = {
    upperArm: new THREE.Vector3(),
    lowerArm: new THREE.Vector3(),
  } as ReachLinks;

  constructor(
    private readonly p: Profile,
    private readonly anat: ArmAnatomy,
    private readonly ctx: ElbowContext,
  ) {}

  /**
   * Find where the elbow belongs on its circle, and solve there.
   *
   * Every position on that circle is sampled and scored, and the cheapest wins.
   * The score is the anatomy model's strain, plus a penalty for departing from
   * where a person would have put it — see `ELBOW_PRIOR` for why strain alone
   * cannot decide.
   *
   * `handDir` is the direction the hand will point, needed to score the wrist;
   * pass null and the wrist is left out of the scoring, which is the right
   * thing when the hand's direction is not decided until the elbow is.
   * `palmN` likewise: null means the palm is free to roll.
   *
   * Returns the winning cost, or null if the target cannot be solved at all.
   */
  search(
    side: Side,
    wristTarget: THREE.Vector3,
    handDir: THREE.Vector3 | null,
    palmN: THREE.Vector3 | null,
    out: ReachLinks,
  ): number | null {
    const cand = this._cand;
    this.ctx.armContext(side);
    // Computed before the sweep, not inside it: the prior is a function of the
    // target, and the target does not change while the circle is being sampled.
    const prior = this.predict(side, wristTarget);
    const score = (angle: number): number => {
      if (!this.ctx.solveReach(side, wristTarget, angle, cand)) return Number.POSITIVE_INFINITY;
      this.anat.measure(side, cand.upperArm, cand.lowerArm, handDir ?? cand.lowerArm, palmN, 0);
      if (prior !== null) {
        // Cosine rather than a squared difference so the penalty wraps with the
        // circle: the angle is periodic, and a difference of just under a turn
        // is a small move and must not be charged as a large one.
        return this.anat.cost() + ELBOW_PRIOR * (1 - Math.cos(angle - prior));
      }
      // Continuity, so a target drifting between two equally comfortable elbow
      // positions does not flip between them.
      const d = angle - this._swivel[side];
      return this.anat.cost() + SWIVEL_INERTIA * (1 - Math.cos(d));
    };

    const step = (Math.PI * 2) / SWIVEL_SAMPLES;
    // Parabolic refinement through a winner and its neighbours. One extra
    // evaluation each side, and it removes the 15-degree stepping that is
    // otherwise visible as the elbow ratcheting when a target sweeps across.
    const refine = (a0: number, c0: number): number => {
      const cl = score(a0 - step);
      const cr = score(a0 + step);
      const denom = cl - 2 * c0 + cr;
      if (Number.isFinite(cl) && Number.isFinite(cr) && Math.abs(denom) > 1e-9) {
        const shift = (0.5 * (cl - cr)) / denom;
        if (Math.abs(shift) < 1) return a0 + shift * step;
      }
      return a0;
    };

    let bestA = this._swivel[side];
    let bestC = Number.POSITIVE_INFINITY;
    for (let i = 0; i < SWIVEL_SAMPLES; i++) {
      const a = -Math.PI + i * step;
      const c = score(a);
      if (c < bestC) {
        bestC = c;
        bestA = a;
      }
    }
    if (!Number.isFinite(bestC)) return null;
    bestA = refine(bestA, bestC);

    const prev = this._swivel[side];

    // Track toward the answer instead of jumping to it.
    //
    // Where the target is close to the shoulder the elbow circle is wide, and
    // the map from swivel angle to shoulder elevation gets steep — on the
    // hand-to-chin poses six degrees of swivel is fifty of elevation. The cost
    // surface there is not smooth enough for the parabolic step to land in the
    // same place twice, so the refinement alternated between two angles a few
    // degrees apart and the arm swung through a wide arc every frame while the
    // pose was merely being held.
    //
    // Damping costs a few frames of lag on a genuine move, which the direction
    // blend was going to smooth anyway.
    //
    // This smooths a value; it does not choose one. What is being tracked toward
    // is a function of the target alone, so the elbow still ends up in the same
    // place whatever route it took there — which is the property the prior
    // exists for, and the reason the stickiness that used to sit here is gone.
    let d = bestA - prev;
    d = Math.atan2(Math.sin(d), Math.cos(d)); // the short way round
    const settled = Math.abs(d) < SWIVEL_SETTLE ? bestA : prev + d * SWIVEL_TRACK;

    if (!this.ctx.solveReach(side, wristTarget, settled, out)) return null;
    this._swivel[side] = settled;
    return bestC;
  }

  /**
   * Where the elbow belongs for a wrist at `wristTarget`, as an angle on the
   * elbow circle. Null on a rig whose body frame or arm the profile could not
   * resolve, and where the predicted pole lands on the reach line and therefore
   * says nothing — see `poleAngle`.
   *
   * Predicted as a *point* and converted, rather than as an angle directly. The
   * angle is measured about the shoulder-to-wrist line, and that line swings
   * through most of a right angle between a hand at the hip and a hand at the
   * mouth, so a formula written in angles would be describing a different elbow
   * at every target. A point beside the ribs is the same place whatever the
   * hand is doing, which is the whole reason the gesture table states poles.
   *
   * See `ELBOW_PRIOR` for what the coefficients mean.
   */
  private predict(side: Side, wristTarget: THREE.Vector3): number | null {
    const span = this.p.body?.span;
    const upper = this.p.bones?.[`upperArm.${side}`];
    const anat = this.anat;
    if (!(span && upper && anat.update())) return null;

    upper.updateWorldMatrix(true, false);
    const S = upper.getWorldPosition(this._priorPole);
    const u = this._priorDir.copy(wristTarget).sub(S);
    if (u.lengthSq() < 1e-10) return null;
    u.normalize();

    // The hand's bearing from the shoulder, resolved in the body's own frame so
    // it survives the character leaning or turning. `s` mirrors the lateral
    // axis, so "outward" means away from the midline on either arm and one set
    // of coefficients serves both.
    const s = side === 'R' ? 1 : -1;
    const outward = u.dot(anat.right) * s;
    const up = u.dot(anat.up);
    const fwd = u.dot(anat.fwd);

    const po =
      ELBOW_POLE_OUT +
      ELBOW_POLE_OUT_RISE * Math.max(0, up) +
      ELBOW_POLE_OUT_CROSS * Math.max(0, -outward);
    const pu = ELBOW_POLE_UP + ELBOW_POLE_UP_RISE * up;
    const pf = ELBOW_POLE_FWD + ELBOW_POLE_FWD_REACH * Math.max(0, fwd);

    // `S` is `_priorPole`, which becomes the pole itself from here.
    this._priorPole
      .addScaledVector(anat.right, po * s * span)
      .addScaledVector(anat.up, pu * span)
      .addScaledVector(anat.fwd, pf * span);

    return poleAngle(this.p, anat, side, wristTarget, this._priorPole);
  }
}
