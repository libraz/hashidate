/**
 * A planned admissibility correction for one constrained arm.
 *
 * The follower pipeline still decides where an arm goes, and the analytic
 * inverse turns that into an unconstrained q every frame. This route adds a
 * correction δ(t) in q-space, planned once by projecting the goal with the
 * non-temporal solver and then sampled in closed form: a quintic from the
 * correction's current value and rate to the goal's correction at rest. When a
 * frame cannot be validated, a quartic tail brings the accepted jet to rest.
 *
 * Every curve is a function of elapsed seconds, never integrated per frame, so
 * the same route sampled at any frame rate passes through the same values.
 * All arrays are in the solver's q order, relative to the upper arm's parent.
 */

import type * as THREE from 'three';
import { type ElevationCeiling, elevationCeiling } from '../anatomy/strain';
import type { FingerSpec } from '../types';
import type { ArmCalibration, ArmConfiguration, ArmForwardContext } from './arm-configuration';
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

/** Change below which a projected goal counts as the requested one. */
const PROJECTION_EPSILON = 1e-6;
/** Shoulder elevation below which the plane angle carries no pose. */
const POLE_ELEVATION = 1e-3;
/** Floor on the goal's elevation sine when weighting the plane correction. */
const POLE_SINE = 1e-6;

export type ArmRouteKind = 'goal' | 'live';
export type ArmRoutePending = 'none' | ArmRouteKind;

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
 * One derivative of the quintic from (d0, v0, 0) at t = 0 to (d1, 0, 0) at
 * `duration`, held at d1 afterwards.
 */
export function quintic(
  d0: number,
  v0: number,
  d1: number,
  duration: number,
  t: number,
  order: 0 | 1 | 2,
): number {
  if (!(duration > 0) || t >= duration) return order === 0 ? d1 : 0;
  const s = Math.max(0, t);
  const T = duration;
  const D = d1 - d0;
  const c3 = (10 * D - 6 * v0 * T) / (T * T * T);
  const c4 = (-15 * D + 8 * v0 * T) / (T * T * T * T);
  const c5 = (6 * D - 3 * v0 * T) / (T * T * T * T * T);
  if (order === 0) return d0 + s * (v0 + s * s * (c3 + s * (c4 + s * c5)));
  if (order === 1) return v0 + s * s * (3 * c3 + s * (4 * c4 + s * 5 * c5));
  return s * (6 * c3 + s * (12 * c4 + s * 20 * c5));
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

/** Correction route for one arm; owned by the body, one per side. */
export class ArmRoute {
  /** Correction at the route's start, its rate there, and its value at the goal. */
  readonly d0 = new Float64Array(DOFS);
  readonly v0 = new Float64Array(DOFS);
  readonly dGoal = new Float64Array(DOFS);
  /** Unconstrained goal and its admissible projection, goalRaw + dGoal. */
  readonly goalRaw = new Float64Array(DOFS);
  readonly goalQ = new Float64Array(DOFS);
  /** Last accepted unconstrained q. */
  readonly rawPrev = new Float64Array(DOFS);
  /** Accepted jet. */
  readonly qAcc = new Float64Array(DOFS);
  readonly vAcc = new Float64Array(DOFS);
  readonly aAcc = new Float64Array(DOFS);
  /** Jet the stop tail starts from. */
  readonly tail0 = new Float64Array(DOFS);
  readonly tailV = new Float64Array(DOFS);
  readonly tailA = new Float64Array(DOFS);
  /** Raw q's rate over the last accepted frame. */
  private readonly rawVelocity = new Float64Array(DOFS);

  private _elapsed = 0;
  private _duration = 0;
  private _projected = false;
  private _stuck = false;
  private _stopping = false;
  private _pending: ArmRoutePending = 'none';
  private pendingDuration = 0;
  private hasRawPrev = false;
  private tailT = 0;
  private lastStep = 0;
  private goalSine = 1;
  private readonly ceiling: ElevationCeiling = { free: 0, max: 0 };
  private readonly configuration: ArmConfiguration = {
    shoulderPlane: 0,
    shoulderLift: 0,
    humeralRotation: 0,
    elbowFlex: 0,
    forearmRoll: 0,
    wristFlex: 0,
    wristDev: 0,
  };
  private readonly boxed = new Float64Array(DOFS);
  private readonly restored = new Float64Array(DOFS);

  /** @param leadFloor Shortest correction and stop-tail length, in seconds. */
  constructor(private readonly leadFloor: number) {}

  get pending(): ArmRoutePending {
    return this._pending;
  }

  get projected(): boolean {
    return this._projected;
  }

  /** The last plan could not restore its goal and holds the accepted pose. */
  get stuck(): boolean {
    return this._stuck;
  }

  get stopping(): boolean {
    return this._stopping;
  }

  get elapsed(): number {
    return this._elapsed;
  }

  get duration(): number {
    return this._duration;
  }

  /** Forget the route: `q` is accepted and at rest, with no correction. A pending request survives. */
  reset(q: Float64Array): void {
    this.qAcc.set(q);
    this.vAcc.fill(0);
    this.aAcc.fill(0);
    this.rawVelocity.fill(0);
    this.d0.fill(0);
    this.v0.fill(0);
    this.dGoal.fill(0);
    this.goalRaw.set(q);
    this.goalQ.set(q);
    this.goalSine = 1;
    this._elapsed = 0;
    this._duration = 0;
    this._projected = false;
    this._stuck = false;
    this._stopping = false;
    this.hasRawPrev = false;
    this.tailT = 0;
    this.lastStep = 0;
  }

  /** Ask for a plan over `duration` seconds, run by the next `plan` call. */
  request(kind: ArmRouteKind, duration: number): void {
    this._pending = kind;
    this.pendingDuration = duration;
  }

  /**
   * Project the goal onto the admissible set and start a correction toward it
   * from the current one. Returns the environment batches spent.
   */
  plan(
    driver: ArmDriver,
    context: ArmForwardContext,
    rawGoal: Float64Array,
    rawNow: Float64Array,
    curls: FingerSpec,
    spread: FingerSpec,
  ): number {
    this._pending = 'none';
    const calibration = driver.calibration;

    // The new correction starts from the current one at the last accepted frame.
    const reference = this.hasRawPrev ? this.rawPrev : rawNow;
    let before = 1;
    if (this._stopping) {
      for (let i = 0; i < DOFS; i++) {
        this.d0[i] = difference(this.qAcc, reference, i);
        this.v0[i] = this.vAcc[i] - this.rawVelocity[i];
      }
    } else {
      before = this.planeWeight(reference, calibration);
      for (let i = 0; i < DOFS; i++) {
        const d = this.correction(i, 0);
        const v = this.correction(i, 1);
        this.d0[i] = d;
        this.v0[i] = v;
      }
    }

    const boxed = clampToBox(rawGoal, driver.fillBounds(rawGoal, 0, false), this.boxed);
    driver.requestForConfiguration(
      configurationFromQ(boxed, this.configuration),
      context,
      curls,
      spread,
    );
    const valid = driver.validateLockedPose(boxed, context, curls, spread);
    let batches = driver.bridgeOutput.environmentBatches;
    let unchanged = valid;
    for (let i = 0; i < DOFS && unchanged; i++) unchanged = boxed[i] === rawGoal[i];

    let goal: Float64Array = rawGoal;
    this._stuck = false;
    if (!unchanged) {
      driver.requestForConfiguration(
        configurationFromQ(rawGoal, this.configuration),
        context,
        curls,
        spread,
      );
      const restored = driver.restoreEndpointFrom(boxed, context, 0, false);
      batches += driver.output.environmentBatches;
      if (restored) {
        this.restored.set(driver.output.q);
        const planned = driver.planFrom(this.restored, context, 0, false);
        batches += planned.environmentBatches;
        goal = planned.status !== 'blocked' ? planned.q : this.restored;
      } else {
        goal = this.qAcc;
        this._stuck = true;
      }
    }

    const elevation = this.elevation(rawGoal, calibration);
    this.goalSine = Math.max(Math.sin(elevation), POLE_SINE);
    let projected = false;
    for (let i = 0; i < DOFS; i++) {
      this.dGoal[i] = difference(goal, rawGoal, i);
      if (Math.abs(this.dGoal[i]) > PROJECTION_EPSILON) projected = true;
    }
    if (elevation < POLE_ELEVATION) this.dGoal[0] = 0;
    for (let i = 0; i < DOFS; i++) this.goalQ[i] = rawGoal[i] + this.dGoal[i];
    this.goalRaw.set(rawGoal);
    this._projected = projected;

    // The applied plane term is weighted; keep it continuous under the new goal's weight.
    const after = this.planeWeight(reference, calibration);
    this.d0[0] = this.unweighted(this.d0[0] * before, after, this.d0[0]);
    this.v0[0] = this.unweighted(this.v0[0] * before, after, this.v0[0]);
    this._duration = this.pendingDuration;
    this._elapsed = 0;
    this._stopping = false;
    return batches;
  }

  /** Move the route's clock on by one frame. */
  advance(dt: number): void {
    const step = Math.max(0, dt);
    this._elapsed += step;
    if (this._stopping) this.tailT += step;
    this.lastStep = step;
  }

  /** Commanded q: the raw pose plus the correction, inside the joint box. */
  command(rawNow: Float64Array, driver: ArmDriver, out: Float64Array): Float64Array {
    const weight = this.planeWeight(rawNow, driver.calibration);
    for (let i = 0; i < DOFS; i++) out[i] = rawNow[i] + this.correction(i, 0);
    out[0] = rawNow[0] + weight * this.correction(0, 0);
    return clampToBox(out, driver.fillBounds(this.qAcc, 0, false), out);
  }

  /**
   * Restart the correction from a committed pose that differs from the
   * command, keeping its rate and its goal.
   */
  absorb(rawNow: Float64Array, committed: Float64Array, driver: ArmDriver): void {
    const weight = this.planeWeight(rawNow, driver.calibration);
    const remaining = Math.max(0, this._duration - this._elapsed);
    const plane = this.correction(0, 0);
    for (let i = 0; i < DOFS; i++) {
      this.v0[i] = this.correction(i, 1);
      this.d0[i] = difference(committed, rawNow, i);
    }
    this.d0[0] = this.unweighted(this.d0[0], weight, plane);
    this._duration = Math.max(remaining, this.leadFloor);
    this._elapsed = 0;
  }

  /** Bring the accepted jet to rest over the lead floor, starting from the last accepted frame. */
  beginStop(): void {
    this.tail0.set(this.qAcc);
    this.tailV.set(this.vAcc);
    this.tailA.set(this.aAcc);
    this.tailT = this.lastStep;
    this._stopping = true;
  }

  /** The stop tail at the current time. */
  tailSample(out: Float64Array): Float64Array {
    for (let i = 0; i < DOFS; i++) {
      out[i] = stopTail(this.tail0[i], this.tailV[i], this.tailA[i], this.leadFloor, this.tailT, 0);
    }
    return out;
  }

  /** Record the committed q and the raw q it was commanded from. */
  accept(q: Float64Array, raw: Float64Array, dt: number): void {
    if (dt > 0) {
      for (let i = 0; i < DOFS; i++) {
        const v = difference(q, this.qAcc, i) / dt;
        this.aAcc[i] = (v - this.vAcc[i]) / dt;
        this.vAcc[i] = v;
        this.rawVelocity[i] = this.hasRawPrev ? difference(raw, this.rawPrev, i) / dt : 0;
      }
    }
    this.qAcc.set(q);
    this.rawPrev.set(raw);
    this.hasRawPrev = true;
  }

  /** One derivative of the unweighted correction at the current time. */
  private correction(i: number, order: 0 | 1): number {
    return quintic(this.d0[i], this.v0[i], this.dGoal[i], this._duration, this._elapsed, order);
  }

  /** Divide out the plane weight; near the pole the applied term carries nothing. */
  private unweighted(applied: number, weight: number, fallback: number): number {
    return weight > POLE_SINE ? applied / weight : fallback;
  }

  private elevation(q: Float64Array, calibration: ArmCalibration): number {
    const ceiling = elevationCeiling(q[0], calibration.joints.shoulder.elevation, this.ceiling);
    return (q[1] / Math.PI) * ceiling.max;
  }

  /** The plane angle means less as the arm nears the pole, and so does its correction. */
  private planeWeight(q: Float64Array, calibration: ArmCalibration): number {
    return Math.min(1, Math.max(0, Math.sin(this.elevation(q, calibration))) / this.goalSine);
  }
}
