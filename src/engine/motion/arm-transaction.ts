import * as THREE from 'three';
import {
  type ArmConfiguration,
  type ArmForwardContext,
  forwardArm,
  makeArmForwardResult,
} from '../rig/arm-configuration';
import type { ArmDriver } from '../rig/arm-driver';
import { type ArmPathPlanOutput, configurationFromQ } from '../rig/arm-path';
import { ArmRoute, clampToBox, validationSamples } from '../rig/arm-route';
import { mkFingerSpread } from '../rig/hands';
import type { Rig } from '../rig/rig';
import type { ArmSlot, FingerName, FingerSpec, Side, Vec3Tuple } from '../types';
import { FINGER_NAMES } from '../types';
import type { ScalarFollower } from './follow';
import { type CharacterFrame, sideMirror } from './frame';
import type { ArmResolver } from './resolve';

const SIDES: readonly Side[] = ['L', 'R'];

/** What one frame's constrained arm commit spent. */
interface ArmFrameWork {
  /** Frames whose goal is the solver's step rather than the raw q. */
  plans: number;
  /** Locked pose checks, holds included. */
  validations: number;
  /** Commands whose endpoint was pushed clear and committed. */
  repairs: number;
  /** Arms brought to rest on the stop tail. */
  stopTails: number;
  /** Arms that kept their accepted pose because neither validated. */
  holds: number;
  solverCalls: number;
  solverIterations: number;
  environmentBatches: number;
}

/** One side of the frame handed to `Rig.commitArmFrame`, refilled rather than rebuilt. */
interface ArmCommit {
  output: ArmPathPlanOutput;
  context: ArmForwardContext;
  curls: FingerSpec;
  spread: FingerSpec;
}

/** The followed arm state the transaction reads, owned by `Body`. */
interface ArmFollowed {
  _armDirs: Record<Side, Record<ArmSlot, Vec3Tuple>>;
  _palmOut: Record<Side, Vec3Tuple>;
  _palmW: Record<Side, ScalarFollower>;
  _twist: Record<Side, ScalarFollower>;
  _fingerSpec: Record<Side, Record<FingerName, number>>;
  _fingerSpreadSpec: Record<Side, Record<FingerName, number>>;
}

/**
 * The constrained arm commit of one frame: forms each arm's command from the
 * followed directions, validates it at fixed density, recovers an arm whose
 * command fails, and commits both arms to the rig against the body as followed.
 * Owns the per-side routes and the scratch the commit refills each frame.
 */
export class ArmTransaction {
  private readonly _armDirs: ArmFollowed['_armDirs'];
  private readonly _palmOut: ArmFollowed['_palmOut'];
  private readonly _palmW: ArmFollowed['_palmW'];
  private readonly _twist: ArmFollowed['_twist'];
  private readonly _fingerSpec: ArmFollowed['_fingerSpec'];
  private readonly _fingerSpreadSpec: ArmFollowed['_fingerSpreadSpec'];
  private readonly _armWorldVec: Record<
    Side,
    Record<'upperArm' | 'lowerArm' | 'hand', THREE.Vector3>
  > = {
    L: { upperArm: new THREE.Vector3(), lowerArm: new THREE.Vector3(), hand: new THREE.Vector3() },
    R: { upperArm: new THREE.Vector3(), lowerArm: new THREE.Vector3(), hand: new THREE.Vector3() },
  };
  private readonly _palmWorldVector: Record<Side, THREE.Vector3> = {
    L: new THREE.Vector3(),
    R: new THREE.Vector3(),
  };
  private readonly _armFrameWork: ArmFrameWork = {
    plans: 0,
    validations: 0,
    repairs: 0,
    stopTails: 0,
    holds: 0,
    solverCalls: 0,
    solverIterations: 0,
    environmentBatches: 0,
  };
  /** Each constrained arm's tracked goal and residual carry. */
  private readonly _routes: Record<Side, ArmRoute>;
  /** This frame's unconstrained q and the commanded q, per side. */
  private readonly _rawQ: Record<Side, Float64Array> = {
    L: new Float64Array(7),
    R: new Float64Array(7),
  };
  private readonly _commandQ: Record<Side, Float64Array> = {
    L: new Float64Array(7),
    R: new Float64Array(7),
  };
  /** Whether a side's command is already formed this frame; the clasp leader's is, early. */
  private readonly _commanded: Record<Side, boolean> = { L: false, R: false };
  private readonly _sampleQ = new Float64Array(7);
  private readonly _sampleCurls = mkFingerSpread();
  private readonly _sampleSpread = mkFingerSpread();
  private readonly _commandConfiguration: ArmConfiguration = {
    shoulderPlane: 0,
    shoulderLift: 0,
    humeralRotation: 0,
    elbowFlex: 0,
    forearmRoll: 0,
    wristFlex: 0,
    wristDev: 0,
  };
  private readonly _commandForward = makeArmForwardResult();
  private readonly _commit: Record<Side, ArmCommit | null> = { L: null, R: null };
  private readonly _acceptedTuple: Record<
    Side,
    Record<'upperArm' | 'lowerArm' | 'hand', Vec3Tuple>
  > = {
    L: { upperArm: [0, 0, 0], lowerArm: [0, 0, 0], hand: [0, 0, 0] },
    R: { upperArm: [0, 0, 0], lowerArm: [0, 0, 0], hand: [0, 0, 0] },
  };

  constructor(
    private readonly rig: Rig,
    private readonly axes: CharacterFrame,
    private readonly _arm: ArmResolver,
    output: ArmFollowed,
    leadFloor: number,
  ) {
    this._armDirs = output._armDirs;
    this._palmOut = output._palmOut;
    this._palmW = output._palmW;
    this._twist = output._twist;
    this._fingerSpec = output._fingerSpec;
    this._fingerSpreadSpec = output._fingerSpreadSpec;
    this._routes = { L: new ArmRoute(leadFloor), R: new ArmRoute(leadFloor) };
  }

  /** Clear the work counters at the start of a frame. */
  beginFrame(): void {
    this._armFrameWork.plans = 0;
    this._armFrameWork.validations = 0;
    this._armFrameWork.repairs = 0;
    this._armFrameWork.stopTails = 0;
    this._armFrameWork.holds = 0;
    this._armFrameWork.solverCalls = 0;
    this._armFrameWork.solverIterations = 0;
    this._armFrameWork.environmentBatches = 0;
  }

  private recordArmSolve(output: { iterations: number; environmentBatches: number }): void {
    this._armFrameWork.solverCalls++;
    this._armFrameWork.solverIterations += output.iterations;
    this._armFrameWork.environmentBatches += output.environmentBatches;
  }

  /**
   * Form and stage the clasp leader's command ahead of the commit, which still
   * validates it.
   */
  stageClaspLeader(side: Side, dt: number, frameReady: boolean): void {
    const rig = this.rig;
    const driver = rig.armDriver(side);
    if (!driver) return;
    const context = rig.armForwardContext(side);
    if (context) {
      // The follower's clasp reads the leader's hand off the rig, so the
      // leader's command is formed now and staged; the commit validates it.
      driver.captureVolumeFrame();
      this.commandArm(side, driver, context, dt, frameReady);
      const forward = forwardArm(
        configurationFromQ(this._commandQ[side], this._commandConfiguration),
        driver.calibration,
        context,
        this._commandForward,
      );
      rig.stageArmForward(side, forward, this._fingerSpec[side], this._fingerSpreadSpec[side]);
    }
  }

  /** Give every route the same entrance length. */
  retime(seconds: number): void {
    for (const side of SIDES) this._routes[side].retime(seconds);
  }

  /** Restart a side's route from a pose set from outside. */
  resetRoute(side: Side, q: Float64Array): void {
    this._routes[side].reset(q);
  }

  /**
   * Form one arm's command for this frame: the route's goal for the request
   * the followed directions make, plus its residual carry, slowed to the slew
   * allowance.
   */
  private commandArm(
    side: Side,
    driver: ArmDriver,
    context: ArmForwardContext,
    dt: number,
    frameReady: boolean,
  ): void {
    const route = this._routes[side];
    const mirror = sideMirror(side);
    const axial = this.axes.axialMirror(side, frameReady);
    const raw = this._rawQ[side];
    const directions = this._armDirs[side];
    const world = this._armWorldVec[side];
    const upper = this.axes
      .toWorld(world.upperArm, directions.upperArm, side, mirror, frameReady)
      .normalize();
    const lower = this.axes
      .toWorld(world.lowerArm, directions.lowerArm, side, mirror, frameReady)
      .normalize();
    const hand = this.axes
      .toWorld(world.hand, directions.hand, side, mirror, frameReady)
      .normalize();
    const palm = this.axes
      .toWorld(this._palmWorldVector[side], this._palmOut[side], side, mirror, frameReady)
      .normalize();
    const request = driver.composeRequest(
      context,
      upper,
      lower,
      hand,
      palm,
      Math.max(0, this._palmW[side].value),
      this._twist[side].value * axial,
      this._fingerSpec[side],
      this._fingerSpreadSpec[side],
    );
    if (driver.configurationFromPose(context, upper, lower, hand, request.palm)) {
      raw.set(driver.targetQ);
    } else {
      raw.set(route.qAcc);
    }

    this._armFrameWork.environmentBatches += route.track(
      driver,
      context,
      raw,
      this._fingerSpec[side],
      this._fingerSpreadSpec[side],
      dt,
    );
    if (route.solved) this._armFrameWork.plans++;
    const command = route.command(driver, this._commandQ[side]);
    // A command past the slew allowance is a seam, not a movement: take the
    // allowed share of the step and carry on from there.
    if (route.limitSlew(command, driver.acceptedForward, driver, context, dt)) {
      route.absorb(command);
    }
    this._commanded[side] = true;
  }

  /**
   * Check the frame's motion from the accepted pose to the command at fixed
   * density in time, arm and fingers together. The last check lands in
   * `driver.output`, which is what the frame commits.
   */
  private validateCommand(
    side: Side,
    driver: ArmDriver,
    context: ArmForwardContext,
    dt: number,
  ): boolean {
    const command = this._commandQ[side];
    const accepted = this._routes[side].qAcc;
    const curls = this._fingerSpec[side];
    const spread = this._fingerSpreadSpec[side];
    const n = validationSamples(dt);
    for (let i = 1; i <= n; i++) {
      const last = i === n;
      let q = command;
      let c: FingerSpec = curls;
      let sp: FingerSpec = spread;
      if (!last) {
        const s = i / n;
        q = this._sampleQ;
        for (let j = 0; j < q.length; j++) {
          const d = command[j] - accepted[j];
          q[j] = accepted[j] + (j === 0 ? Math.atan2(Math.sin(d), Math.cos(d)) : d) * s;
        }
        for (const finger of FINGER_NAMES) {
          const fromCurl = driver.acceptedCurls[finger];
          const fromSpread = driver.acceptedSpread[finger];
          this._sampleCurls[finger] = fromCurl + ((curls[finger] ?? 0) - fromCurl) * s;
          this._sampleSpread[finger] = fromSpread + ((spread[finger] ?? 0) - fromSpread) * s;
        }
        c = this._sampleCurls;
        sp = this._sampleSpread;
      }
      if (!this.validateArmPose(driver, context, q, c, sp, last)) return false;
    }
    return true;
  }

  /** One locked check of `q`, recorded in the frame's work. */
  private validateArmPose(
    driver: ArmDriver,
    context: ArmForwardContext,
    q: Float64Array,
    curls: FingerSpec,
    spread: FingerSpec,
    final: boolean,
  ): boolean {
    driver.requestForConfiguration(
      configurationFromQ(q, this._commandConfiguration),
      context,
      curls,
      spread,
    );
    const out = final ? driver.output : driver.bridgeOutput;
    const valid = driver.validateLockedPose(q, context, curls, spread, out);
    this._armFrameWork.validations++;
    this.recordArmSolve(out);
    return valid;
  }

  /**
   * An arm whose command did not validate. Repair the command's endpoint and
   * restart the correction from it; failing that, bring the accepted motion to
   * rest; failing that, hold the accepted pose. Leaves
   * the pose to commit in `driver.output`; false when even the hold fails.
   */
  private recoverArm(
    side: Side,
    driver: ArmDriver,
    context: ArmForwardContext,
    dt: number,
  ): boolean {
    const route = this._routes[side];
    const work = this._armFrameWork;
    const command = this._commandQ[side];
    const curls = this._fingerSpec[side];
    const spread = this._fingerSpreadSpec[side];
    driver.requestForConfiguration(
      configurationFromQ(command, this._commandConfiguration),
      context,
      curls,
      spread,
    );
    // A repair is a step like any other: one past the slew allowance is a seam.
    let repaired =
      driver.restoreEndpointFrom(command, context, dt, true) &&
      route.slewRatio(driver.output.q, driver.acceptedForward, driver, context, dt) <= 1;
    this.recordArmSolve(driver.output);
    if (!repaired) {
      // Pushing a point out of the face converges only linearly, since its
      // reported normal is not the distance's gradient; approached from the
      // accepted side instead, the same contact stays clear at every step.
      const planned = driver.planFrom(route.qAcc, context, dt, true);
      this.recordArmSolve(planned);
      if (planned.status !== 'blocked') {
        const q = this._sampleQ;
        q.set(planned.q);
        route.limitSlew(q, driver.acceptedForward, driver, context, dt);
        repaired = this.validateArmPose(driver, context, q, curls, spread, true);
      }
    }
    if (repaired) {
      work.repairs++;
      command.set(driver.output.q);
      route.absorb(command);
      this.armCommit(side, driver, context, curls, spread);
      return true;
    }

    route.beginStop(dt);
    const tail = clampToBox(
      route.tailSample(command),
      driver.fillBounds(route.qAcc, 0, false),
      command,
    );
    route.limitSlew(tail, driver.acceptedForward, driver, context, dt);
    if (this.validateArmPose(driver, context, tail, curls, spread, true)) {
      work.stopTails++;
      this.armCommit(side, driver, context, curls, spread);
      return true;
    }

    work.holds++;
    command.set(route.qAcc);
    route.absorb(command);
    if (
      !this.validateArmPose(
        driver,
        context,
        route.qAcc,
        driver.acceptedCurls,
        driver.acceptedSpread,
        true,
      )
    ) {
      return false;
    }
    this.armCommit(side, driver, context, driver.acceptedCurls, driver.acceptedSpread);
    return true;
  }

  /** One side's commit record, pointing at this frame's output and context. */
  private armCommit(
    side: Side,
    driver: ArmDriver,
    context: ArmForwardContext,
    curls: FingerSpec,
    spread: FingerSpec,
  ): ArmCommit {
    let commit = this._commit[side];
    if (!commit) {
      commit = { output: driver.output, context, curls, spread };
      this._commit[side] = commit;
    }
    commit.output = driver.output;
    commit.context = context;
    commit.curls = curls;
    commit.spread = spread;
    return commit;
  }

  /**
   * Commit both arms against the body as followed: the torso is never held back
   * for an arm, the arm gives way. An arm whose command does not validate holds
   * its accepted pose in the new body.
   */
  commit(dt: number, hipsRise: number): void {
    const rig = this.rig;
    rig.captureProposedBodyContext(hipsRise);
    const rise = rig.applyBodyContext(1, 1);
    const frameReady = this.axes.ready();
    let feasible = true;
    for (const side of SIDES) {
      const driver = rig.armDriver(side);
      const context = rig.armForwardContextFromUpdatedBody(side);
      if (!(driver && context)) {
        feasible = false;
        break;
      }
      driver.captureVolumeFrame();
      if (!this._commanded[side]) this.commandArm(side, driver, context, dt, frameReady);
      if (this.validateCommand(side, driver, context, dt)) {
        this.armCommit(side, driver, context, this._fingerSpec[side], this._fingerSpreadSpec[side]);
        continue;
      }
      if (!this.recoverArm(side, driver, context, dt)) {
        feasible = false;
        break;
      }
    }
    const left = this._commit.L;
    const right = this._commit.R;
    let committed =
      feasible && !!(left && right) && rig.commitArmFrame({ L: left, R: right }, rise);

    if (committed) {
      const acceptedFrameReady = this.axes.ready();
      for (const side of SIDES) {
        const driver = rig.armDriver(side);
        if (!driver) continue;
        this._routes[side].accept(driver.acceptedQ, dt);
        const accepted = this._armWorldVec[side];
        this.axes.toCharacter(
          accepted.upperArm,
          driver.acceptedForward.u,
          side,
          acceptedFrameReady,
        );
        this.axes.toCharacter(
          accepted.lowerArm,
          driver.acceptedForward.l,
          side,
          acceptedFrameReady,
        );
        this.axes.toCharacter(accepted.hand, driver.acceptedForward.h, side, acceptedFrameReady);
        const tuple = this._acceptedTuple[side];
        tuple.upperArm[0] = accepted.upperArm.x;
        tuple.upperArm[1] = accepted.upperArm.y;
        tuple.upperArm[2] = accepted.upperArm.z;
        tuple.lowerArm[0] = accepted.lowerArm.x;
        tuple.lowerArm[1] = accepted.lowerArm.y;
        tuple.lowerArm[2] = accepted.lowerArm.z;
        tuple.hand[0] = accepted.hand.x;
        tuple.hand[1] = accepted.hand.y;
        tuple.hand[2] = accepted.hand.z;
        this._arm.note(side, tuple.upperArm, tuple.lowerArm, tuple.hand);
      }
    } else {
      // Neither arm moved; each route restarts from the pose it still holds.
      for (const side of SIDES) {
        const driver = rig.armDriver(side);
        if (!(driver && this._commanded[side])) continue;
        const route = this._routes[side];
        route.absorb(route.qAcc);
        route.accept(route.qAcc, dt);
      }
    }
    this._commanded.L = false;
    this._commanded.R = false;

    // A failed articulation must not hold back the common signed jump
    // translation. This is its own accepted result, not a validated arm frame.
    if (!committed) committed = rig.commitArmTransport(hipsRise);
    if (!committed) {
      rig.applyBodyContext(0, 0);
      for (const side of SIDES) {
        const driver = rig.armDriver(side);
        const context = rig.armForwardContextFromUpdatedBody(side);
        if (driver && context) {
          const acceptedForward = driver.refreshAcceptedForward(context);
          rig.stageArmForward(side, acceptedForward, driver.acceptedCurls, driver.acceptedSpread);
        }
      }
    }
  }
}
