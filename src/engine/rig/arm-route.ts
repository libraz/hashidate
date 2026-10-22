/**
 * Per-frame goal tracking for one constrained arm.
 *
 * Each frame the goal is one bounded solver step continuing its own chain
 * toward the frame's request, or the raw q where that is the same branch. The
 * command is the goal plus a residual carry: where what is shown and the goal
 * part — a gesture starts or ends, a recovery lands elsewhere, a stop tail
 * ends — the gap is carried with its rate and eased out over the lead, as the
 * spine's carry is.
 * When a frame cannot be validated, a quartic tail brings the accepted jet to rest.
 *
 * All arrays are in the solver's q order, relative to the upper arm's parent.
 */

import type * as THREE from 'three';
import type { FingerSpec } from '../types';
import {
  type ArmConfiguration,
  type ArmForwardContext,
  forwardArm,
  makeArmForwardResult,
} from './arm-configuration';
import { type ArmDriver, LIMIT_SLEW } from './arm-driver';
import { type ArmPathBounds, configurationFromQ } from './arm-path';

const DOFS = 7;

/**
 * Seconds between locked validations of a frame's arm motion. Sets collision
 * coverage per second rather than per frame, so a slow frame is checked as
 * densely along its path as two fast ones.
 */
export const VALIDATION_INTERVAL = 1 / 60;

/**
 * Most validations one frame may spend, reached below 20 fps. Past it a frame is
 * too long to cover anyway, and the cap keeps a stall from compounding.
 */
export const MAX_VALIDATION_SAMPLES = 4;

/** Wrist flexion and deviation in q order, which the slew check rate-limits directly. */
export const SLEW_WRIST_DOFS = [5, 6] as const;

/**
 * Share of the slew allowance a slowed step settles for, and the evaluations
 * its search may spend. The last 2% is not visible; listen into cover needed
 * at most four evaluations.
 */
const SLEW_FILL = 0.98;
const SLEW_SEARCH = 6;

/**
 * One derivative of the residual carry: a cubic Hermite from `from` at rate
 * `rate` to rest at zero over `duration`, as the spine's carry eases a cut
 * rate out. Zero once the duration has passed.
 */
export function residualCarry(
  from: number,
  rate: number,
  duration: number,
  time: number,
  order: 0 | 1,
): number {
  if (!(duration > 0) || time >= duration) return 0;
  const s = Math.max(0, time) / duration;
  if (order === 0) {
    return from * (1 + 2 * s) * (1 - s) * (1 - s) + rate * s * (1 - s) * (1 - s) * duration;
  }
  return (from * 6 * s * (s - 1)) / duration + rate * (1 - s) * (1 - 3 * s);
}

/** The bone rotations the slew check compares; an `ArmForwardResult` provides them. */
export interface ArmSlewPose {
  readonly upperLocal: THREE.Quaternion;
  readonly lowerLocal: THREE.Quaternion;
  readonly handLocal: THREE.Quaternion;
}

/** Plane difference taken the short way round; every other DOF is a plain difference. */
function difference(a: Float64Array, b: Float64Array, i: number): number {
  const d = a[i] - b[i];
  return i === 0 ? Math.atan2(Math.sin(d), Math.cos(d)) : d;
}

/**
 * One derivative of the quartic that brings the jet (x0, v0, a0) to rest with
 * zero velocity and acceleration at `h`, held afterwards.
 */
export function stopTail(
  x0: number,
  v0: number,
  a0: number,
  h: number,
  t: number,
  order: 0 | 1 | 2,
): number {
  if (!(h > 0)) return order === 0 ? x0 : 0;
  if (t >= h && order !== 0) return 0;
  const s = Math.min(Math.max(0, t), h);
  const b3 = -(v0 / (h * h) + (2 * a0) / (3 * h));
  const b4 = v0 / (2 * h * h * h) + a0 / (4 * h * h);
  if (order === 0) return x0 + s * (v0 + s * (0.5 * a0 + s * (b3 + s * b4)));
  if (order === 1) return v0 + s * (a0 + s * (3 * b3 + s * 4 * b4));
  return a0 + s * (6 * b3 + s * 12 * b4);
}

/** Clamp each q component into the bounds; `out` may alias `q`. */
export function clampToBox(
  q: Float64Array,
  bounds: ArmPathBounds,
  out: Float64Array,
): Float64Array {
  for (let i = 0; i < DOFS; i++) {
    out[i] = Math.min(bounds.upper[i], Math.max(bounds.lower[i], q[i]));
  }
  return out;
}

/** Locked validations for one frame of `dt` seconds. */
export function validationSamples(dt: number): number {
  return Math.min(MAX_VALIDATION_SAMPLES, Math.max(1, Math.ceil(dt / VALIDATION_INTERVAL - 1e-9)));
}

/**
 * How many times over the slew allowance one step travels: the wrist DOFs
 * directly, the three bones as local rotation angles. At most 1 is within.
 */
export function armStepWithinSlew(
  fromQ: Float64Array,
  from: ArmSlewPose,
  toQ: Float64Array,
  to: ArmSlewPose,
  dt: number,
): number {
  const allowance = LIMIT_SLEW * Math.max(0, dt) + Math.sqrt(Number.EPSILON);
  let step = 0;
  for (const dof of SLEW_WRIST_DOFS) step = Math.max(step, Math.abs(toQ[dof] - fromQ[dof]));
  step = Math.max(
    step,
    from.upperLocal.angleTo(to.upperLocal),
    from.lowerLocal.angleTo(to.lowerLocal),
    from.handLocal.angleTo(to.handLocal),
  );
  return step / allowance;
}

/** Goal tracker for one arm; owned by the body, one per side. */
export class ArmRoute {
  /** Where the solver put this frame's request. */
  readonly goalQ = new Float64Array(DOFS);
  /** Accepted jet. */
  readonly qAcc = new Float64Array(DOFS);
  readonly vAcc = new Float64Array(DOFS);
  readonly aAcc = new Float64Array(DOFS);
  /** Jet the stop tail starts from. */
  readonly tail0 = new Float64Array(DOFS);
  readonly tailV = new Float64Array(DOFS);
  readonly tailA = new Float64Array(DOFS);
  /** The residual carry's start and rate there. */
  readonly carryFrom = new Float64Array(DOFS);
  readonly carryRate = new Float64Array(DOFS);
  /** The goal's rate over the last accepted frame, away from discontinuities. */
  private readonly goalVelocity = new Float64Array(DOFS);
  private readonly goalPrev = new Float64Array(DOFS);

  private carryTime = 0;
  private carryDuration: number;
  /** A discontinuity is due: the next track restarts the carry from the accepted jet. */
  private recarry = false;
  private hasGoalPrev = false;
  private _projected = false;
  private _solved = false;
  private _stopping = false;
  private tailT = 0;
  private readonly configuration: ArmConfiguration = {
    shoulderPlane: 0,
    shoulderLift: 0,
    humeralRotation: 0,
    elbowFlex: 0,
    forearmRoll: 0,
    wristFlex: 0,
    wristDev: 0,
  };
  private readonly step = new Float64Array(DOFS);
  private readonly forward = makeArmForwardResult();
  private readonly goalForward = makeArmForwardResult();

  /** @param leadFloor Shortest carry and stop-tail length, in seconds. */
  constructor(private readonly leadFloor: number) {
    this.carryDuration = leadFloor;
  }

  /** The solver moved this frame's goal off the raw q. */
  get projected(): boolean {
    return this._projected;
  }

  /** This frame's goal came from a solver call rather than the raw q itself. */
  get solved(): boolean {
    return this._solved;
  }

  get stopping(): boolean {
    return this._stopping;
  }

  /** Forget the route: `q` is accepted and at rest, with nothing carried. */
  reset(q: Float64Array): void {
    this.qAcc.set(q);
    this.vAcc.fill(0);
    this.aAcc.fill(0);
    this.goalQ.set(q);
    this.carryFrom.fill(0);
    this.carryRate.fill(0);
    this.goalVelocity.fill(0);
    this.carryTime = 0;
    this.recarry = false;
    this.hasGoalPrev = false;
    this._projected = false;
    this._solved = false;
    this._stopping = false;
    this.tailT = 0;
  }

  /**
   * A gesture started, began its exit or ended: carry whatever the goal does
   * next out over `seconds`.
   */
  retime(seconds: number): void {
    this.carryDuration = Math.max(seconds, this.leadFloor);
    this.recarry = true;
  }

  /**
   * Find this frame's goal for the request `driver` holds, whose analytic
   * inverse is `raw`. One bounded solver step continues the goal's own chain,
   * as the per-frame solve always has. The raw decomposition replaces it only
   * when that step is not still travelling and raw is within one frame's slew
   * of the chain: elsewhere it can be another branch of the same hand, and
   * switching to it is a jump. Returns the environment batches spent.
   */
  track(
    driver: ArmDriver,
    context: ArmForwardContext,
    raw: Float64Array,
    curls: FingerSpec,
    spread: FingerSpec,
    dt: number,
  ): number {
    const planned = driver.planFrom(this.goalQ, context, dt, true);
    let batches = planned.environmentBatches;
    const bounds = driver.fillBounds(raw, 0, false);
    let inBox = true;
    for (let i = 0; i < DOFS && inBox; i++) {
      inBox = raw[i] >= bounds.lower[i] && raw[i] <= bounds.upper[i];
    }
    let useRaw = planned.status !== 'progress' && inBox;
    if (useRaw) {
      forwardArm(
        configurationFromQ(this.goalQ, this.configuration),
        driver.calibration,
        context,
        this.goalForward,
      );
      forwardArm(
        configurationFromQ(raw, this.configuration),
        driver.calibration,
        context,
        this.forward,
      );
      useRaw = armStepWithinSlew(this.goalQ, this.goalForward, raw, this.forward, dt) <= 1;
    }
    if (useRaw) {
      useRaw = driver.validateLockedPose(raw, context, curls, spread);
      batches += driver.bridgeOutput.environmentBatches;
    }
    this._solved = !useRaw;
    if (useRaw) {
      this.goalQ.set(raw);
    } else if (planned.status === 'stationary') {
      // A chain stopped at a minimum of the box short of the request can be a
      // local one; an admissible raw is still reached one box step at a time.
      const stepped = inBox && this.stepTowardRaw(driver, context, raw, curls, spread, dt);
      if (inBox) batches += driver.bridgeOutput.environmentBatches;
      this.goalQ.set(stepped ? this.step : planned.q);
    } else if (planned.status !== 'blocked') {
      this.goalQ.set(planned.q);
    } else {
      // A blocked chain is not always a blocked arm: the solver's step can fail
      // from a corner of the joint box, and holding the goal there would hold
      // it for good. One box step toward an admissible raw keeps it reachable.
      const stepped = inBox && this.stepTowardRaw(driver, context, raw, curls, spread, dt);
      if (inBox) batches += driver.bridgeOutput.environmentBatches;
      if (stepped) {
        this.goalQ.set(this.step);
      } else if (driver.restoreEndpointFrom(this.goalQ, context, dt, true)) {
        // The chain's last goal is not clear in this frame: push it clear first.
        batches += driver.output.environmentBatches;
        this.goalQ.set(driver.output.q);
      } else {
        batches += driver.output.environmentBatches;
      }
    }
    let projected = false;
    for (let i = 0; i < DOFS && !projected; i++) projected = this.goalQ[i] !== raw[i];
    this._projected = projected;

    this.carryTime += Math.max(0, dt);
    if (this.recarry || this._stopping) {
      // The carry starts at the last accepted frame, from the accepted jet.
      for (let i = 0; i < DOFS; i++) {
        this.carryFrom[i] = difference(this.qAcc, this.goalQ, i);
        this.carryRate[i] = this.vAcc[i] - this.goalVelocity[i];
      }
      this.carryTime = Math.max(0, dt);
      this.recarry = false;
      this._stopping = false;
    }
    return batches;
  }

  /**
   * Move from the goal toward `raw` by at most one frame's slew per DOF, the
   * box a plan step searches, into `step`; true when that pose validates.
   */
  private stepTowardRaw(
    driver: ArmDriver,
    context: ArmForwardContext,
    raw: Float64Array,
    curls: FingerSpec,
    spread: FingerSpec,
    dt: number,
  ): boolean {
    const box = driver.fillBounds(this.goalQ, dt, true);
    for (let i = 0; i < DOFS; i++) {
      const target = this.goalQ[i] + difference(raw, this.goalQ, i);
      this.step[i] = Math.min(box.upper[i], Math.max(box.lower[i], target));
    }
    return driver.validateLockedPose(this.step, context, curls, spread);
  }

  /** Commanded q: the goal plus the carry, inside the joint box. */
  command(driver: ArmDriver, out: Float64Array): Float64Array {
    for (let i = 0; i < DOFS; i++) {
      out[i] =
        this.goalQ[i] +
        residualCarry(this.carryFrom[i], this.carryRate[i], this.carryDuration, this.carryTime, 0);
    }
    return clampToBox(out, driver.fillBounds(this.qAcc, 0, false), out);
  }
  /**
   * Shorten the step from the accepted pose to `command`, in place, to within
   * the slew allowance. Bone angles are not linear in q — rotations about
   * different axes partly cancel over a long step — so one 1/k scale lands
   * over; the share is searched instead (regula falsi, Illinois). Returns
   * whether the command was shortened.
   */
  limitSlew(
    command: Float64Array,
    accepted: ArmSlewPose,
    driver: ArmDriver,
    context: ArmForwardContext,
    dt: number,
  ): boolean {
    let k = this.slewRatio(command, accepted, driver, context, dt);
    if (k <= 1) return false;
    for (let i = 0; i < DOFS; i++) this.step[i] = difference(command, this.qAcc, i);
    let lo = 0;
    let kLo = 0;
    let hi = 1;
    let kHi = k;
    let retained = 0;
    for (let pass = 0; pass < SLEW_SEARCH; pass++) {
      const share = lo + ((1 - kLo) * (hi - lo)) / (kHi - kLo);
      for (let i = 0; i < DOFS; i++) command[i] = this.qAcc[i] + this.step[i] * share;
      k = this.slewRatio(command, accepted, driver, context, dt);
      if (k <= 1) {
        lo = share;
        kLo = k;
        if (k >= SLEW_FILL) break;
        if (retained < 0) kHi = 1 + (kHi - 1) / 2;
        retained = -1;
      } else {
        hi = share;
        kHi = k;
        if (retained > 0) kLo = 1 - (1 - kLo) / 2;
        retained = 1;
      }
    }
    for (let i = 0; i < DOFS; i++) command[i] = this.qAcc[i] + this.step[i] * lo;
    return true;
  }

  /**
   * The frame committed a pose other than the command: carry from it, at the
   * rate the carry had, so the next frame continues from what was shown.
   */
  absorb(committed: Float64Array): void {
    for (let i = 0; i < DOFS; i++) {
      const rate = residualCarry(
        this.carryFrom[i],
        this.carryRate[i],
        this.carryDuration,
        this.carryTime,
        1,
      );
      this.carryFrom[i] = difference(committed, this.goalQ, i);
      this.carryRate[i] = rate;
    }
    this.carryTime = 0;
  }

  /** Bring the accepted jet to rest over the lead floor, starting from the last accepted frame. */
  beginStop(dt: number): void {
    this.tail0.set(this.qAcc);
    this.tailV.set(this.vAcc);
    this.tailA.set(this.aAcc);
    this.tailT = Math.max(0, dt);
    this._stopping = true;
  }

  /** The stop tail at the current time. */
  tailSample(out: Float64Array): Float64Array {
    for (let i = 0; i < DOFS; i++) {
      out[i] = stopTail(this.tail0[i], this.tailV[i], this.tailA[i], this.leadFloor, this.tailT, 0);
    }
    return out;
  }

  /** Record the committed q, and the goal's own rate where it was continuous. */
  accept(q: Float64Array, dt: number): void {
    if (dt > 0) {
      for (let i = 0; i < DOFS; i++) {
        const v = difference(q, this.qAcc, i) / dt;
        this.aAcc[i] = (v - this.vAcc[i]) / dt;
        this.vAcc[i] = v;
        this.goalVelocity[i] = this.hasGoalPrev ? difference(this.goalQ, this.goalPrev, i) / dt : 0;
      }
    }
    this.qAcc.set(q);
    this.goalPrev.set(this.goalQ);
    this.hasGoalPrev = true;
  }

  /** How many times over the slew allowance the step from the accepted pose to `q` is. */
  slewRatio(
    q: Float64Array,
    accepted: ArmSlewPose,
    driver: ArmDriver,
    context: ArmForwardContext,
    dt: number,
  ): number {
    forwardArm(
      configurationFromQ(q, this.configuration),
      driver.calibration,
      context,
      this.forward,
    );
    return armStepWithinSlew(this.qAcc, accepted, q, this.forward, dt);
  }
}
