import * as THREE from 'three';
import { type ArmAnatomy, contactCost } from '../anatomy';
import type { Profile, Side } from '../types';
import { type ArmSolution, type ReachLinks, reachRef, swivelOf } from './reach';

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
/** `SWIVEL_TRACK` as a per-second rate at the 60 Hz it was set at, so tracking depends on time rather than call count. */
const SWIVEL_RATE = -60 * Math.log(1 - SWIVEL_TRACK);

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
  /** Solve the two-link reach at one trial elbow angle, in a frame already refreshed. */
  solveReach(
    side: Side,
    targetWorld: THREE.Vector3,
    angle: number,
    out: ReachLinks,
    framed: boolean,
  ): unknown;
  /** Hand the anatomy model this arm's origin and segment lengths. */
  armContext(side: Side): boolean;
  /** Seconds the current frame covers. */
  dt(): number;
}

export class ElbowSearch {
  // Scratch for the reach line and the elbow prior. Held apart from the
  // solver's own, which is live across the whole of a fingertip solve while
  // these are computed inside it.
  private readonly _lineS = new THREE.Vector3();
  private readonly _lineN = new THREE.Vector3();
  private readonly _priorPole = new THREE.Vector3();
  private readonly _swivelW = new THREE.Vector3();
  private readonly _swivelRef = new THREE.Vector3();
  private readonly _swivelBi = new THREE.Vector3();
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
   * `pole` is a world point the elbow is drawn toward, as the gesture table
   * states one. It replaces the predicted elbow as the prior, and it silences
   * every strain term but the body: an authored pole was placed by eye against
   * a render, and the inside of the chest is the one thing a render does not
   * show. Solved at the pole outright, a hand brought inside the shoulder line
   * had its elbow in the chest and left the limiter to lift it out, part by
   * part and a frame at a time; scored on strain as well, the search moved
   * elbows the author had placed — the hand behind the ear by a forearm's
   * length — because the stop the pole leans on reads as a cost.
   *
   * `out` carries the slot's own elbow state in `swivelDir`, so two slots
   * solving one side in a frame do not pull a shared elbow between them. Zero,
   * the answer is taken outright, which is what a probe solve wants.
   *
   * Returns the strain of the pose solved — the anatomy cost alone, prior
   * excluded — or null if the target cannot be solved at all.
   */
  search(
    side: Side,
    wristTarget: THREE.Vector3,
    handDir: THREE.Vector3 | null,
    palmN: THREE.Vector3 | null,
    out: ArmSolution,
    pole: THREE.Vector3 | null = null,
  ): number | null {
    const cand = this._cand;
    this.ctx.armContext(side);
    // Once per search: every candidate is solved in the same body frame.
    const framed = this.anat.update();
    const line = framed && this.line(side, wristTarget);
    const prev = line ? this.remembered(out, framed) : undefined;
    // Computed before the sweep, not inside it: the prior is a function of the
    // target, and the target does not change while the circle is being sampled.
    const poleA =
      pole && line
        ? swivelOf(this.anat, this._lineN, this._swivelW.copy(pole).sub(this._lineS), framed)
        : null;
    // A pole on the reach line says nothing, and the frame is searched as a
    // pose with no pole; the slot's elbow memory carries it across either way.
    // Holding the pole's rule there instead, with no strain scored, hung the
    // forearm bent backward until the pole came off the line and flipped it.
    const authored = poleA !== null;
    const prior = authored ? poleA : line ? this.predict(side, framed) : null;
    const score = (angle: number): number => {
      if (!this.ctx.solveReach(side, wristTarget, angle, cand, framed)) {
        return Number.POSITIVE_INFINITY;
      }
      this.anat.measure(side, cand.upperArm, cand.lowerArm, handDir ?? cand.lowerArm, palmN, 0);
      const strain = authored ? contactCost(this.anat.m) : this.anat.cost();
      if (prior !== null) {
        // Cosine rather than a squared difference so the penalty wraps with the
        // circle: the angle is periodic, and a difference of just under a turn
        // is a small move and must not be charged as a large one.
        return strain + ELBOW_PRIOR * (1 - Math.cos(angle - prior));
      }
      // Continuity, so a target drifting between two equally comfortable elbow
      // positions does not flip between them.
      const d = angle - (prev ?? 0);
      return strain + SWIVEL_INERTIA * (1 - Math.cos(d));
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

    let bestA = prev ?? 0;
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
    let settled = bestA;
    if (prev !== undefined) {
      let d = bestA - prev;
      d = Math.atan2(Math.sin(d), Math.cos(d)); // the short way round
      const k = 1 - Math.exp(-SWIVEL_RATE * this.ctx.dt());
      if (Math.abs(d) >= SWIVEL_SETTLE) settled = prev + d * k;
    }

    if (!this.ctx.solveReach(side, wristTarget, settled, out, framed)) return null;
    if (line) this.remember(out, settled, framed);
    // Reported at the elbow the arm was given and without the prior, which
    // steers the choice but is no part of what the pose costs.
    this.anat.measure(side, out.upperArm, out.lowerArm, handDir ?? out.lowerArm, palmN, 0);
    return authored ? contactCost(this.anat.m) : this.anat.cost();
  }

  /**
   * The reach line for this solve — shoulder in `_lineS`, unit bearing in
   * `_lineN` — or false where the rig has no arm to draw it from. The caller
   * has already refreshed the body frame.
   */
  private line(side: Side, wristTarget: THREE.Vector3): boolean {
    const upper = this.p.bones?.[`upperArm.${side}`];
    if (!upper) return false;
    upper.updateWorldMatrix(true, false);
    const S = upper.getWorldPosition(this._lineS);
    const n = this._lineN.copy(wristTarget).sub(S);
    if (n.lengthSq() < 1e-10) return false;
    n.normalize();
    return true;
  }

  /** The slot's remembered elbow as an angle on this frame's circle, if it has one. */
  private remembered(out: ArmSolution, framed: boolean): number | undefined {
    const d = out.swivelDir;
    if (d.lengthSq() === 0) return undefined;
    const anat = this.anat;
    const w = this._swivelW
      .copy(anat.right)
      .multiplyScalar(d.x)
      .addScaledVector(anat.up, d.y)
      .addScaledVector(anat.fwd, d.z);
    return swivelOf(anat, this._lineN, w, framed) ?? undefined;
  }

  /** Record the elbow's standoff direction at `angle`, in the body frame. */
  private remember(out: ArmSolution, angle: number, framed: boolean): void {
    const anat = this.anat;
    const n = this._lineN;
    const ref = reachRef(anat, n, this._swivelRef, framed);
    const bi = this._swivelBi.copy(n).cross(ref);
    const w = this._swivelW
      .copy(ref)
      .multiplyScalar(Math.cos(angle))
      .addScaledVector(bi, Math.sin(angle));
    out.swivelDir.set(w.dot(anat.right), w.dot(anat.up), w.dot(anat.fwd));
  }

  /**
   * Where the elbow belongs for a wrist on the current reach line, as an angle
   * on the elbow circle. Null on a rig whose body frame the profile could not
   * resolve, and where the predicted pole lands on the reach line and therefore
   * says nothing — see `swivelOf`.
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
  private predict(side: Side, framed: boolean): number | null {
    const span = this.p.body?.span;
    const anat = this.anat;
    if (!span) return null;
    const u = this._lineN;

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

    // The pole as an offset from the shoulder, which is all `swivelOf` needs.
    this._priorPole
      .set(0, 0, 0)
      .addScaledVector(anat.right, po * s * span)
      .addScaledVector(anat.up, pu * span)
      .addScaledVector(anat.fwd, pf * span);

    return swivelOf(anat, u, this._priorPole, framed);
  }
}
