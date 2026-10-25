import * as THREE from 'three';
import { HAND_CONTACT, TORSO_ARM_START, TORSO_SAMPLES } from '../anatomy/joints';
import { elevationCeiling } from '../anatomy/strain';
import type { FingerSpec } from '../types';
import type {
  ArmCalibration,
  ArmConfiguration,
  ArmForwardContext,
  ArmForwardResult,
} from './arm-configuration';
import { configurationOfDirections, forwardArm, makeArmForwardResult } from './arm-configuration';
import { CONSTRAINT_EPSILON, makeQpScratch, type QpResult, solveDualActiveSet } from './arm-qp';
import {
  type HandGeometryCalibration,
  type HandGeometryPoint,
  makeHandGeometrySample,
  sampleHandGeometry,
} from './hand-geometry';

const DOFS = 7;
const LANDMARKS = 3;
const DIRECTION_COMPONENTS = 3;
const MAX_ITERATIONS = 6;
const MAX_LINE_SEARCHES = 6;
const MAX_SWEEP_DEPTH = 8;
const MAX_ENVIRONMENT_BATCHES = 96;
/**
 * Metres outside the surface a restore aims for. The face field's normal is not
 * its distance gradient, so aiming at exactly zero only approaches the surface.
 */
const RESTORE_MARGIN = 1e-6;
const DIFFERENCE_SCALE = Math.cbrt(Number.EPSILON);
const LEXICAL_EPSILON = Number.EPSILON ** (2 / 3);
const FULL_TURN = 2 * Math.PI;
const SETTLED_POSITION_FRACTION = 1e-6;
const SETTLED_ORIENTATION = 1e-5;
/**
 * Accepted moves that remove at most this fraction of the starting primary
 * error, on physical stops only, mean the plan has stopped at a box minimum.
 */
const STATIONARY_FRACTION = 1e-3;
const FRAME_TOLERANCE = 1e-4;
/**
 * Weight of squared wrist deviation past its comfortable band, in radians, beside
 * the elbow's squared miss. At 10 the pole still held fingerTouch at −20.1°; at
 * 100 every hold the band can reach lands between −19.8° and −19.0°.
 */
const DEVIATION_COMFORT_WEIGHT = 100;
/** How far inside the band the comfort term aims, so the pole cannot balance it on the edge. */
const DEVIATION_COMFORT_MARGIN = Math.PI / 180;

export type ArmPathPointKind = 'upper' | 'forearm' | 'hand' | 'finger';

/** Stable proxy point identity. Positions are overwritten on each evaluation. */
export interface ArmPathPoint {
  readonly id: string;
  readonly kind: ArmPathPointKind;
  readonly index: number;
  readonly finger?: HandGeometryPoint['finger'];
  readonly jointIndex?: number;
  readonly tip?: boolean;
  readonly position: THREE.Vector3;
}

/** One signed surface distance in metres, with an outward world-space normal. */
export interface ArmPathClearance {
  /** Stable across every sample; multiple surfaces may constrain one point. */
  key: string;
  pointIndex: number;
  /** Invalid optional surfaces retain their stable slot but add no constraint. */
  valid: boolean;
  distance: number;
  /** World-space distance gradient; radial tables need not have a unit gradient. */
  normal: THREE.Vector3;
}

/** Fixed-cardinality clearance query. Rows may be returned in any order. */
export interface ArmPathEnvironment {
  readonly rowCount: number;
  sample(points: readonly ArmPathPoint[], out: ArmPathClearance[]): void;
}

/** Target wrist is a point; hand and palm are world-space directions. */
export interface ArmPathRequest {
  readonly wrist: THREE.Vector3;
  readonly hand: THREE.Vector3;
  readonly palm: THREE.Vector3 | null;
  readonly curls: FingerSpec;
  readonly spread: FingerSpec;
  readonly elbow?: THREE.Vector3;
}

export interface ArmPathBounds {
  /** Absolute seven-component bounds in path coordinate order. */
  readonly lower: Float64Array;
  readonly upper: Float64Array;
}

/**
 * `stationary`: the exact QP step stopped improving the request at a residual,
 * a local minimum of the box rather than a failure to move.
 */
export type ArmPathStatus = 'progress' | 'settled' | 'stationary' | 'blocked';

/** Reusable answer buffer. `q` is exactly the raw configuration sent to FK. */
export interface ArmPathPlanOutput {
  readonly q: Float64Array;
  readonly configuration: ArmConfiguration;
  readonly forward: ArmForwardResult;
  readonly points: ArmPathPoint[];
  readonly clearances: ArmPathClearance[];
  status: ArmPathStatus;
  positionError: number;
  orientationError: number;
  secondaryError: number;
  maxViolation: number;
  iterations: number;
  environmentBatches: number;
}

interface PathState {
  readonly q: Float64Array;
  readonly configuration: ArmConfiguration;
  readonly forward: ArmForwardResult;
  readonly points: ArmPathPoint[];
  clearances: ArmPathClearance[];
  primaryError: number;
  secondaryError: number;
  positionError: number;
  orientationError: number;
  maxViolation: number;
  penetrationSquareSum: number;
}

interface ResolvedBounds {
  readonly lower: Float64Array;
  readonly upper: Float64Array;
  /** 1 where the supplied bound is narrower than the joint's physical one. */
  readonly lowerTemporal: Uint8Array;
  readonly upperTemporal: Uint8Array;
}

/** Encode one configuration in the solver's stable seven-value order. */
export function configurationToQ(configuration: ArmConfiguration, out: Float64Array): void {
  out[0] = configuration.shoulderPlane;
  out[1] = configuration.shoulderLift * Math.PI;
  out[2] = configuration.humeralRotation;
  out[3] = configuration.elbowFlex;
  out[4] = configuration.forearmRoll;
  out[5] = configuration.wristFlex;
  out[6] = configuration.wristDev;
}

/** Decode the solver's seven-value order back into a configuration. */
export function configurationFromQ(q: Float64Array, out: ArmConfiguration): ArmConfiguration {
  out.shoulderPlane = q[0];
  out.shoulderLift = q[1] / Math.PI;
  out.humeralRotation = q[2];
  out.elbowFlex = q[3];
  out.forearmRoll = q[4];
  out.wristFlex = q[5];
  out.wristDev = q[6];
  return out;
}

function emptyConfiguration(): ArmConfiguration {
  return {
    shoulderPlane: 0,
    shoulderLift: 0,
    humeralRotation: 0,
    elbowFlex: 0,
    forearmRoll: 0,
    wristFlex: 0,
    wristDev: 0,
  };
}

function point(
  id: string,
  kind: ArmPathPointKind,
  index: number,
  finger?: HandGeometryPoint['finger'],
  jointIndex?: number,
  tip?: boolean,
): ArmPathPoint {
  return {
    id,
    kind,
    index,
    ...(finger === undefined ? {} : { finger }),
    ...(jointIndex === undefined ? {} : { jointIndex }),
    ...(tip === undefined ? {} : { tip }),
    position: new THREE.Vector3(),
  };
}

function proxyPoints(hand: HandGeometryCalibration): ArmPathPoint[] {
  const out: ArmPathPoint[] = [];
  for (let i = 0; i <= TORSO_SAMPLES; i++) out.push(point(`upper.${i}`, 'upper', i));
  for (let i = 1; i <= TORSO_SAMPLES; i++) out.push(point(`forearm.${i}`, 'forearm', i));
  for (let i = 1; i <= TORSO_SAMPLES; i++) out.push(point(`hand.${i}`, 'hand', i));
  for (const finger of hand.points) {
    out.push(
      point(
        `finger.${finger.finger}.${finger.jointIndex}.${finger.tip ? 'tip' : 'joint'}`,
        'finger',
        out.length,
        finger.finger,
        finger.jointIndex,
        finger.tip,
      ),
    );
  }
  return out;
}

function makeState(template: readonly ArmPathPoint[]): PathState {
  return {
    q: new Float64Array(DOFS),
    configuration: emptyConfiguration(),
    forward: makeArmForwardResult(),
    points: template.map((p) => ({ ...p, position: new THREE.Vector3() })),
    clearances: [],
    primaryError: Number.POSITIVE_INFINITY,
    secondaryError: Number.POSITIVE_INFINITY,
    positionError: Number.POSITIVE_INFINITY,
    orientationError: Number.POSITIVE_INFINITY,
    maxViolation: Number.POSITIVE_INFINITY,
    penetrationSquareSum: Number.POSITIVE_INFINITY,
  };
}

function makeClearance(): ArmPathClearance {
  return {
    key: '',
    pointIndex: -1,
    valid: false,
    distance: Number.POSITIVE_INFINITY,
    normal: new THREE.Vector3(),
  };
}

function cloneRows(count: number): ArmPathClearance[] {
  return Array.from({ length: count }, makeClearance);
}

function finiteVector(value: THREE.Vector3 | null | undefined): value is THREE.Vector3 {
  return (
    !!value &&
    typeof value.lengthSq === 'function' &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

function finiteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function unitVector(value: THREE.Vector3 | null | undefined): value is THREE.Vector3 {
  return finiteVector(value) && Math.abs(value.lengthSq() - 1) < FRAME_TOLERANCE;
}

function unitQuaternion(value: THREE.Quaternion | null | undefined): value is THREE.Quaternion {
  return (
    !!value &&
    typeof value.lengthSq === 'function' &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z) &&
    Number.isFinite(value.w) &&
    Math.abs(value.lengthSq() - 1) < FRAME_TOLERANCE
  );
}

function validContext(context: ArmForwardContext | null | undefined): context is ArmForwardContext {
  if (
    !context ||
    (context.side !== 'L' && context.side !== 'R') ||
    !finiteVector(context.shoulder) ||
    !unitVector(context.up) ||
    !unitVector(context.right) ||
    !unitVector(context.forward) ||
    !unitQuaternion(context.upperParentWorld) ||
    !finiteNumber(context.upperLength) ||
    !finiteNumber(context.lowerLength) ||
    context.upperLength <= 0 ||
    context.lowerLength <= 0
  ) {
    return false;
  }
  return (
    Math.abs(context.up.dot(context.right)) < FRAME_TOLERANCE &&
    Math.abs(context.up.dot(context.forward)) < FRAME_TOLERANCE &&
    Math.abs(context.right.dot(context.forward)) < FRAME_TOLERANCE
  );
}

function validForward(forward: ArmForwardResult): boolean {
  return (
    unitVector(forward.u) &&
    unitVector(forward.l) &&
    unitVector(forward.h) &&
    unitVector(forward.palm) &&
    Math.abs(forward.h.dot(forward.palm)) < FRAME_TOLERANCE &&
    finiteVector(forward.elbow) &&
    finiteVector(forward.wrist) &&
    unitQuaternion(forward.upperWorld) &&
    unitQuaternion(forward.lowerWorld) &&
    unitQuaternion(forward.handWorld) &&
    unitQuaternion(forward.upperLocal) &&
    unitQuaternion(forward.lowerLocal) &&
    unitQuaternion(forward.handLocal)
  );
}

function finiteSpec(spec: FingerSpec): boolean {
  return (
    !!spec &&
    typeof spec === 'object' &&
    (spec.thumb === undefined || finiteNumber(spec.thumb)) &&
    (spec.index === undefined || finiteNumber(spec.index)) &&
    (spec.middle === undefined || finiteNumber(spec.middle)) &&
    (spec.ring === undefined || finiteNumber(spec.ring)) &&
    (spec.little === undefined || finiteNumber(spec.little))
  );
}

function createBounds(
  calibration: ArmCalibration,
  supplied: ArmPathBounds | null | undefined,
  out: ResolvedBounds,
): boolean {
  if (
    !(supplied?.lower && supplied.upper) ||
    supplied.lower.length !== DOFS ||
    supplied.upper.length !== DOFS
  ) {
    return false;
  }
  for (let i = 0; i < DOFS; i++) {
    if (!(finiteNumber(supplied.lower[i]) && finiteNumber(supplied.upper[i]))) return false;
    let physicalLower: number;
    let physicalUpper: number;
    switch (i) {
      case 0:
        physicalLower = Number.NEGATIVE_INFINITY;
        physicalUpper = Number.POSITIVE_INFINITY;
        break;
      case 1:
        physicalLower = 0;
        physicalUpper = Math.PI;
        break;
      case 2:
        physicalLower = calibration.joints.shoulder.dofs.rotation.max[0];
        physicalUpper = calibration.joints.shoulder.dofs.rotation.max[1];
        break;
      case 3:
        physicalLower = calibration.joints.elbow.dofs.flexion.max[0];
        physicalUpper = calibration.joints.elbow.dofs.flexion.max[1];
        break;
      case 4:
        physicalLower = calibration.joints.elbow.dofs.rotation.max[0];
        physicalUpper = calibration.joints.elbow.dofs.rotation.max[1];
        break;
      case 5:
        physicalLower = calibration.joints.wrist.dofs.flexion.max[0];
        physicalUpper = calibration.joints.wrist.dofs.flexion.max[1];
        break;
      default:
        physicalLower = calibration.joints.wrist.dofs.deviation.max[0];
        physicalUpper = calibration.joints.wrist.dofs.deviation.max[1];
    }
    if (!finiteNumber(physicalLower) && i !== 0) return false;
    if (!finiteNumber(physicalUpper) && i !== 0) return false;
    out.lower[i] = Math.max(supplied.lower[i], physicalLower);
    out.upper[i] = Math.min(supplied.upper[i], physicalUpper);
    out.lowerTemporal[i] = supplied.lower[i] > physicalLower ? 1 : 0;
    out.upperTemporal[i] = supplied.upper[i] < physicalUpper ? 1 : 0;
    if (out.lower[i] > out.upper[i]) return false;
  }
  return true;
}

/** Copy every landmark and frame of one forward result into another. */
export function copyForward(source: ArmForwardResult, target: ArmForwardResult): void {
  target.u.copy(source.u);
  target.l.copy(source.l);
  target.h.copy(source.h);
  target.palm.copy(source.palm);
  target.elbow.copy(source.elbow);
  target.wrist.copy(source.wrist);
  target.upperWorld.copy(source.upperWorld);
  target.lowerWorld.copy(source.lowerWorld);
  target.handWorld.copy(source.handWorld);
  target.upperLocal.copy(source.upperLocal);
  target.lowerLocal.copy(source.lowerLocal);
  target.handLocal.copy(source.handLocal);
}

function dotRow(matrix: Float64Array, row: number, vector: Float64Array, vectorOffset = 0): number {
  let result = 0;
  const start = row * DOFS;
  for (let i = 0; i < DOFS; i++) result += matrix[start + i] * vector[vectorOffset + i];
  return result;
}

/** A damped, box- and clearance-constrained numerical stepper over raw FK. */
export class ArmStepSolver {
  private readonly templatePoints: ArmPathPoint[];
  private readonly current: PathState;
  private readonly originalStart: PathState;
  private readonly certifiedCheckpoint: PathState;
  private readonly candidate: PathState;
  private readonly probePlus: PathState;
  private readonly probeMinus: PathState;
  private readonly quarterStates: PathState[];
  private readonly recursiveStates: PathState[];
  private readonly allStates: PathState[];
  private readonly clearanceStates: PathState[];
  private readonly preparedSweepFractions = new Float64Array(MAX_ENVIRONMENT_BATCHES);
  private preparedSweepCount = 0;
  private readonly reservedSweepFractions = new Float64Array(MAX_ENVIRONMENT_BATCHES);
  private reservedSweepCount = 0;
  private hasCertifiedProgress = false;
  private currentIsCertified = true;
  private readonly resolvedBounds: ResolvedBounds = {
    lower: new Float64Array(DOFS),
    upper: new Float64Array(DOFS),
    lowerTemporal: new Uint8Array(DOFS),
    upperTemporal: new Uint8Array(DOFS),
  };
  private readonly handSample: ReturnType<typeof makeHandGeometrySample>;
  private readonly localFingerPoints: THREE.Vector3[];
  private readonly targetWrist = new THREE.Vector3();
  private readonly targetHand = new THREE.Vector3();
  private readonly targetPalm = new THREE.Vector3();
  private readonly targetElbow = new THREE.Vector3();
  private readonly targetLandmarks = new Float64Array(LANDMARKS * DIRECTION_COMPONENTS);
  private readonly residual = new Float64Array(LANDMARKS * DIRECTION_COMPONENTS);
  private readonly poleGradient = new Float64Array(2);
  private poleRay = 0;
  private readonly jacobian = new Float64Array(LANDMARKS * DIRECTION_COMPONENTS * DOFS);
  private readonly elbowJacobian = new Float64Array(DIRECTION_COMPONENTS * DOFS);
  private readonly projectedElbowJacobian = new Float64Array(DIRECTION_COMPONENTS * DOFS);
  private readonly secondaryVector = new Float64Array(DOFS);
  private readonly comfortRow = new Float64Array(DOFS);
  private pointJacobian = new Float64Array(0);
  private readonly trialQ = new Float64Array(DOFS);
  private readonly normalMatrix = new Float64Array(DOFS * DOFS);
  private readonly hessian = new Float64Array(DOFS * DOFS);
  private readonly cholesky = new Float64Array(DOFS * DOFS);
  private readonly rightHand = new Float64Array(DOFS);
  private readonly solved = new Float64Array(DOFS);
  private readonly solveScratch = new Float64Array(DOFS);
  private readonly qpDelta = new Float64Array(DOFS);
  private readonly primaryDelta = new Float64Array(DOFS);
  private primaryBasisCount = 0;
  private primaryRankThreshold = 0;
  private readonly retractionNormal = new THREE.Vector3();
  private readonly retractionCenter = new THREE.Vector3();
  private readonly retractionElbow = new THREE.Vector3();
  private readonly retractionDirections = {
    upperArm: new THREE.Vector3(),
    lowerArm: new THREE.Vector3(),
    hand: new THREE.Vector3(),
  };
  private qpA = new Float64Array(0);
  private qpB = new Float64Array(0);
  private qpZ = new Float64Array(0);
  private qpLambda = new Float64Array(0);
  private readonly qpScratch = makeQpScratch();
  /** Why the last `makeConstrainedStep` returned; `'rejected'` is a false outside the kernel. */
  private lastQpResult: QpResult | 'rejected' = 'rejected';
  /** The last successful constrained step leaned on a temporal box row. */
  private lastStepTemporal = false;
  private readonly rowMap = new Map<string, number>();
  private readonly registeredKeys: string[] = [];
  private registeredPointIndices = new Int32Array(0);
  private readonly forcedDistance: number[] = [];
  private readonly forcedNormals: THREE.Vector3[] = [];
  private readonly forcedPoints: THREE.Vector3[] = [];
  private readonly forcedPointIndex: number[] = [];
  private readonly forcedRows: boolean[] = [];
  private readonly clearanceScratch = new THREE.Vector3();
  private queryRows: ArmPathClearance[] = [];
  private rowCount = -1;
  private qpCapacity = 0;
  private readonly handLength: number;
  private span = 0;
  private readonly resolution: number;
  private environmentBatches = 0;
  private keyContractReady = false;
  private newForcedRows = false;
  private requestHasPalm = false;
  private requestHasElbow = false;
  private roundoffTolerance = 0;
  private readonly rowBasis = new Float64Array(DOFS * DOFS);
  private mappedSeen = new Uint8Array(0);
  private readonly startQ = new Float64Array(DOFS);

  constructor(
    private readonly calibration: ArmCalibration,
    private readonly handGeometry: HandGeometryCalibration,
    measuredHandLength: number,
    sweepResolution: number,
  ) {
    if (!(measuredHandLength > 0 && finiteNumber(measuredHandLength))) {
      throw new Error('measured hand length must be finite and positive');
    }
    if (!(sweepResolution > 0 && finiteNumber(sweepResolution))) {
      throw new Error('sweep resolution must be finite and positive');
    }
    this.handLength = measuredHandLength;
    this.resolution = sweepResolution;
    this.templatePoints = proxyPoints(handGeometry);
    this.current = makeState(this.templatePoints);
    this.originalStart = makeState(this.templatePoints);
    this.certifiedCheckpoint = makeState(this.templatePoints);
    this.candidate = makeState(this.templatePoints);
    this.probePlus = makeState(this.templatePoints);
    this.probeMinus = makeState(this.templatePoints);
    this.quarterStates = Array.from({ length: 3 }, () => makeState(this.templatePoints));
    this.recursiveStates = Array.from({ length: MAX_SWEEP_DEPTH }, () =>
      makeState(this.templatePoints),
    );
    this.allStates = [
      this.current,
      this.originalStart,
      this.certifiedCheckpoint,
      this.candidate,
      this.probePlus,
      this.probeMinus,
      ...this.quarterStates,
      ...this.recursiveStates,
    ];
    this.clearanceStates = [
      this.current,
      this.originalStart,
      this.certifiedCheckpoint,
      this.candidate,
      this.quarterStates[0],
    ];
    this.handSample = makeHandGeometrySample(handGeometry);
    this.localFingerPoints = this.handSample.points.map(() => new THREE.Vector3());
  }

  /**
   * Plan one bounded move. The caller owns and commits the returned q; this
   * method has no pose history and never changes the request, bounds or context.
   */
  plan(
    request: ArmPathRequest,
    start: Float64Array,
    context: ArmForwardContext,
    bounds: ArmPathBounds,
    environment: ArmPathEnvironment,
    out: ArmPathPlanOutput,
  ): ArmPathPlanOutput {
    this.resetOutput(out);
    this.resetSearchScratch();
    if (
      !createBounds(this.calibration, bounds, this.resolvedBounds) ||
      start.length !== DOFS ||
      !environment ||
      environment.rowCount < 0 ||
      !Number.isInteger(environment.rowCount) ||
      out.clearances.length !== environment.rowCount ||
      out.points.length !== this.templatePoints.length ||
      !this.validRequest(request) ||
      !validContext(context)
    ) {
      out.status = 'blocked';
      this.copySafeStart(out, start);
      return out;
    }
    const resolved = this.resolvedBounds;
    if (this.rowCount !== environment.rowCount) this.prepareRows(environment.rowCount);
    this.span = context.upperLength + context.lowerLength + this.handLength;
    if (!finiteNumber(this.span) || this.span <= 0) {
      this.copySafeStart(out, start);
      return out;
    }
    this.roundoffTolerance = 64 * Number.EPSILON * Math.max(1, this.span);
    this.requestHasPalm = request.palm !== null;
    this.requestHasElbow = request.elbow !== undefined;
    this.targetWrist.copy(request.wrist);
    this.targetHand.copy(request.hand).normalize();
    this.targetPalm.set(0, 0, 0);
    if (request.palm) {
      this.targetPalm
        .copy(request.palm)
        .addScaledVector(this.targetHand, -request.palm.dot(this.targetHand));
      if (this.targetPalm.lengthSq() < 1e-12) {
        out.status = 'blocked';
        this.copySafeStart(out, start);
        return out;
      }
      this.targetPalm.normalize();
    }
    if (request.elbow) this.targetElbow.copy(request.elbow);
    this.startQ.set(start);
    sampleHandGeometry(this.handGeometry, request.curls, request.spread, this.handSample);
    for (let i = 0; i < this.handSample.points.length; i++) {
      this.localFingerPoints[i].copy(this.handSample.points[i].position);
    }
    for (let i = 0; i < DOFS; i++) {
      if (!finiteNumber(start[i]) || start[i] < resolved.lower[i] || start[i] > resolved.upper[i]) {
        out.status = 'blocked';
        this.copySafeStart(out, start);
        return out;
      }
      this.current.q[i] = start[i];
    }
    this.fillTargetLandmarks();
    if (!this.evaluateGeometry(this.current, context, resolved)) {
      out.status = 'blocked';
      this.copySafeStart(out, start);
      return out;
    }
    if (!this.sampleClearances(this.current, environment)) {
      out.status = 'blocked';
      this.copySafeStart(out, start);
      return out;
    }
    this.measureState(this.current);
    if (this.current.maxViolation > this.roundoffTolerance) {
      // A moving environment can push into a clear goal. Push it clear first;
      // like restoreEndpoint, the chord from the start to the cleared pose is
      // not swept, and the push neither counts as progress nor as iterations.
      this.copyState(this.current, this.originalStart);
      this.pushClear(context, resolved, environment);
      if (this.current.maxViolation > this.roundoffTolerance) {
        this.copyToOutput(this.originalStart, out, 'blocked');
        return out;
      }
    }
    this.copyState(this.current, this.originalStart);
    this.copyState(this.current, this.certifiedCheckpoint);

    if (this.isSettled(this.current)) {
      this.copyToOutput(this.current, out, 'settled');
      return out;
    }

    let dampingScale = 1;
    // Signals for the status: an accepted gauge move, a temporal row under an
    // accepted step, and whether the last iteration's exact QP step was spent.
    let gaugeAccepted = false;
    let temporalAccepted = false;
    let lastQpOptimal = false;
    let lastStepSpent = false;
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      out.iterations = iteration + 1;
      this.newForcedRows = false;
      lastQpOptimal = false;
      lastStepSpent = false;
      if (!this.linearize(this.current, context, resolved)) {
        if (
          !this.certifyCurrent(context, resolved, environment) &&
          this.newForcedRows &&
          iteration + 1 < MAX_ITERATIONS &&
          this.environmentBatches < MAX_ENVIRONMENT_BATCHES
        ) {
          dampingScale *= 10;
          continue;
        }
        break;
      }
      let acceptedThisIteration = false;
      let lineEvaluated = false;
      let lineOnlyBetter = true;
      let stepTemporal = false;
      let predictedDescent = Number.POSITIVE_INFINITY;
      let qpAttempts = 0;
      let lineCandidates = 0;
      let damping = this.initialDamping() * dampingScale;

      const primarySettled = this.isPrimarySettled(this.current);
      const polePlane = primarySettled
        ? undefined
        : this.poleGaugeProposal(this.current, context, resolved);
      if (polePlane !== undefined) {
        const line = lineCandidates++;
        this.trialQ.set(this.current.q);
        this.trialQ[0] = polePlane;
        this.candidate.q.set(this.trialQ);
        lineEvaluated = true;
        if (!this.evaluatePlanCandidate(context, resolved, environment, line)) {
          lineOnlyBetter = false;
        } else if (this.betterPoleGauge(this.candidate, this.current, this.poleRay)) {
          this.acceptPlanCandidate(environment);
          acceptedThisIteration = true;
          gaugeAccepted = true;
          dampingScale = 1;
        }
      }
      if (!acceptedThisIteration) {
        let primaryAvailable = primarySettled;
        this.primaryDelta.fill(0);
        while (
          !primaryAvailable &&
          qpAttempts < MAX_LINE_SEARCHES &&
          lineCandidates < MAX_LINE_SEARCHES &&
          this.environmentBatches < MAX_ENVIRONMENT_BATCHES
        ) {
          this.buildHessian(damping);
          qpAttempts++;
          if (!this.solveLinear(this.hessian, this.rightHand, this.solved)) {
            damping *= 10;
            continue;
          }
          const stepped = this.makeConstrainedStep(
            this.current,
            resolved,
            this.solved,
            this.current.clearances,
          );
          lastQpOptimal = this.lastQpResult === 'optimal';
          if (!stepped) {
            // Feasibility does not depend on damping, so a larger one cannot help.
            if (this.lastQpResult === 'infeasible') break;
            damping *= 10;
            continue;
          }
          this.primaryDelta.set(this.qpDelta);
          stepTemporal = this.lastStepTemporal;
          predictedDescent = this.predictedDescent(this.primaryDelta);
          primaryAvailable = true;
        }
        if (primaryAvailable) {
          let secondary = false;
          if (this.requestHasElbow && qpAttempts < MAX_LINE_SEARCHES) {
            qpAttempts++;
            secondary = this.makeSecondaryStep(this.current, resolved);
            // The elbow step rides on the primary one; its temporal rows bind the move too.
            if (secondary && this.lastStepTemporal) stepTemporal = true;
          }
          if (!secondary) this.qpDelta.set(this.primaryDelta);
          // A successful but tiny primary step can still permit useful elbow motion.
          if (this.stepNorm(this.qpDelta) >= 1e-10) {
            // A successful QP owns the remaining dyadic line sequence for this GN iteration.
            while (lineCandidates < MAX_LINE_SEARCHES) {
              const line = lineCandidates++;
              const alpha = 2 ** -line;
              lineEvaluated = true;
              if (
                !(
                  this.writeHierarchyCandidate(this.current, context, resolved, alpha, secondary) &&
                  this.evaluatePlanCandidate(context, resolved, environment, line)
                )
              ) {
                lineOnlyBetter = false;
                continue;
              }
              if (!this.better(this.candidate, this.current)) continue;
              this.acceptPlanCandidate(environment);
              acceptedThisIteration = true;
              if (stepTemporal) temporalAccepted = true;
              dampingScale = 1;
              break;
            }
          }
        }
      }

      // An exact step that is zero, or whose every line candidate lost only on
      // the objective with a model descent below the tolerance, is spent.
      lastStepSpent =
        lastQpOptimal &&
        !acceptedThisIteration &&
        (this.stepNorm(this.primaryDelta) < 1e-10 ||
          (lineEvaluated &&
            lineOnlyBetter &&
            predictedDescent <= this.lexicalTolerance(this.current.primaryError)));

      const stopping =
        this.isSettled(this.current) ||
        !(acceptedThisIteration || this.newForcedRows) ||
        iteration + 1 === MAX_ITERATIONS ||
        this.environmentBatches >= MAX_ENVIRONMENT_BATCHES;
      if (stopping) {
        if (
          !this.certifyCurrent(context, resolved, environment) &&
          this.newForcedRows &&
          iteration + 1 < MAX_ITERATIONS &&
          this.environmentBatches < MAX_ENVIRONMENT_BATCHES
        ) {
          dampingScale *= 10;
          continue;
        }
        break;
      }
      if (!acceptedThisIteration) dampingScale *= 10;
    }

    const accepted = this.hasCertifiedProgress;
    const negligible =
      this.originalStart.primaryError - this.current.primaryError <=
      STATIONARY_FRACTION * this.originalStart.primaryError;
    let status: ArmPathStatus;
    if (this.isPrimarySettled(this.current)) status = 'settled';
    else if (gaugeAccepted) status = 'progress';
    else if (lastQpOptimal && !accepted && lastStepSpent) status = 'stationary';
    else if (lastQpOptimal && accepted && negligible && !temporalAccepted) status = 'stationary';
    else if (accepted) status = 'progress';
    else status = 'blocked';
    this.copyToOutput(this.current, out, status);
    return out;
  }

  /**
   * Keep the first improving move fully certified, including swept-row feedback.
   * Later GN endpoints share one reserved original-start certificate instead of
   * paying for overlapping chords after every improvement. Geometry preflight
   * is query-free; a rejected endpoint must leave the current reservation intact.
   */
  private evaluatePlanCandidate(
    context: ArmForwardContext,
    bounds: ResolvedBounds,
    environment: ArmPathEnvironment,
    line: number,
  ): boolean {
    if (!this.evaluateGeometry(this.candidate, context, bounds)) return false;
    this.preparedSweepCount = 0;
    const speculative = this.hasCertifiedProgress && environment.rowCount > 0;
    const ceiling = speculative ? MAX_ENVIRONMENT_BATCHES : this.lineTrialQueryCeiling(line);
    const budget = ceiling - this.environmentBatches;
    if (environment.rowCount > 0) {
      if (this.minimumSweepBatches(this.originalStart, this.candidate) > budget) return false;
      if (!this.prepareSweep(this.originalStart, this.candidate, context, bounds, budget))
        return false;
      // The endpoint costs one query even if it is rejected. Preserve enough
      // queries to certify either the old current or this candidate afterwards.
      if (
        speculative &&
        this.environmentBatches + 1 + Math.max(this.reservedSweepCount, this.preparedSweepCount) >
          MAX_ENVIRONMENT_BATCHES
      )
        return false;
    }
    if (!this.sampleClearances(this.candidate, environment, ceiling)) return false;
    this.measureState(this.candidate);
    if (this.candidate.maxViolation > this.roundoffTolerance) {
      this.rememberFailedRows(this.candidate);
      return false;
    }
    return (
      speculative ||
      this.validatePreparedSweep(this.candidate, context, bounds, environment, ceiling)
    );
  }

  private acceptPlanCandidate(environment: ArmPathEnvironment): void {
    this.copyState(this.candidate, this.current);
    if (!this.hasCertifiedProgress || environment.rowCount === 0) {
      this.copyState(this.current, this.certifiedCheckpoint);
      this.hasCertifiedProgress = true;
      this.currentIsCertified = true;
      this.reservedSweepCount = 0;
    } else {
      // Even a zero-lift gauge move changes the q chord that will be emitted.
      // Its certificate cannot be inherited from equal endpoint FK alone.
      this.currentIsCertified = false;
      this.reservedSweepCount = this.preparedSweepCount;
      this.reservedSweepFractions.set(
        this.preparedSweepFractions.subarray(0, this.preparedSweepCount),
      );
    }
  }

  /** Certify before any exit; failed speculative work can only expose the checkpoint. */
  private certifyCurrent(
    context: ArmForwardContext,
    bounds: ResolvedBounds,
    environment: ArmPathEnvironment,
  ): boolean {
    if (this.currentIsCertified) return true;
    this.preparedSweepCount = this.reservedSweepCount;
    this.preparedSweepFractions.set(
      this.reservedSweepFractions.subarray(0, this.reservedSweepCount),
    );
    const certified = this.validatePreparedSweep(
      this.current,
      context,
      bounds,
      environment,
      MAX_ENVIRONMENT_BATCHES,
    );
    this.reservedSweepCount = 0;
    this.currentIsCertified = true;
    if (certified) this.copyState(this.current, this.certifiedCheckpoint);
    else this.copyState(this.certifiedCheckpoint, this.current);
    return certified;
  }

  /**
   * Restore only the requested endpoint after the context or finger shape changed.
   * The caller must certify any bridge from the previously committed pose.
   */
  restoreEndpoint(
    request: ArmPathRequest,
    start: Float64Array,
    context: ArmForwardContext,
    bounds: ArmPathBounds,
    environment: ArmPathEnvironment,
    out: ArmPathPlanOutput,
  ): boolean {
    this.resetOutput(out);
    this.resetSearchScratch();
    if (
      !createBounds(this.calibration, bounds, this.resolvedBounds) ||
      start.length !== DOFS ||
      !environment ||
      environment.rowCount < 0 ||
      !Number.isInteger(environment.rowCount) ||
      out.clearances.length !== environment.rowCount ||
      out.points.length !== this.templatePoints.length ||
      !this.validRequest(request) ||
      !validContext(context)
    ) {
      this.copySafeStart(out, start);
      return false;
    }

    const resolved = this.resolvedBounds;
    if (this.rowCount !== environment.rowCount) this.prepareRows(environment.rowCount);
    this.registeredPointIndices.fill(-1);
    this.span = context.upperLength + context.lowerLength + this.handLength;
    if (!finiteNumber(this.span) || this.span <= 0) {
      this.copySafeStart(out, start);
      return false;
    }
    this.roundoffTolerance = 64 * Number.EPSILON * Math.max(1, this.span);
    this.requestHasPalm = request.palm !== null;
    this.requestHasElbow = request.elbow !== undefined;
    this.targetWrist.copy(request.wrist);
    this.targetHand.copy(request.hand).normalize();
    this.targetPalm.set(0, 0, 0);
    if (request.palm) {
      this.targetPalm
        .copy(request.palm)
        .addScaledVector(this.targetHand, -request.palm.dot(this.targetHand));
      if (this.targetPalm.lengthSq() < 1e-12) {
        this.copySafeStart(out, start);
        return false;
      }
      this.targetPalm.normalize();
    }
    if (request.elbow) this.targetElbow.copy(request.elbow);
    this.startQ.set(start);
    sampleHandGeometry(this.handGeometry, request.curls, request.spread, this.handSample);
    for (let i = 0; i < this.handSample.points.length; i++) {
      this.localFingerPoints[i].copy(this.handSample.points[i].position);
    }
    for (let i = 0; i < DOFS; i++) {
      if (!finiteNumber(start[i]) || start[i] < resolved.lower[i] || start[i] > resolved.upper[i]) {
        this.copySafeStart(out, start);
        return false;
      }
      this.current.q[i] = start[i];
    }
    this.fillTargetLandmarks();
    if (
      !(
        this.evaluateGeometry(this.current, context, resolved) &&
        this.sampleClearances(this.current, environment)
      )
    ) {
      this.copySafeStart(out, start);
      out.environmentBatches = this.environmentBatches;
      return false;
    }
    this.measureState(this.current);
    if (this.current.maxViolation <= this.roundoffTolerance) {
      this.copyToOutput(this.current, out, this.isSettled(this.current) ? 'settled' : 'progress');
      return true;
    }
    const iterations = this.pushClear(context, resolved, environment);
    if (this.current.maxViolation <= this.roundoffTolerance) {
      this.copyToOutput(this.current, out, this.isSettled(this.current) ? 'settled' : 'progress');
      out.iterations = iterations;
      return true;
    }

    this.copySafeStart(out, start);
    out.status = 'blocked';
    out.positionError = Number.POSITIVE_INFINITY;
    out.orientationError = Number.POSITIVE_INFINITY;
    out.secondaryError = Number.POSITIVE_INFINITY;
    out.maxViolation = Number.POSITIVE_INFINITY;
    out.iterations = iterations;
    out.environmentBatches = this.environmentBatches;
    return false;
  }

  /**
   * Penetration-only GN on `current` until it is clear. Returns the iterations
   * used; the caller reads success off `current.maxViolation`.
   */
  private pushClear(
    context: ArmForwardContext,
    bounds: ResolvedBounds,
    environment: ArmPathEnvironment,
  ): number {
    let used = 0;
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      used = iteration + 1;
      if (!this.linearizePenetration(this.current, context, bounds)) break;
      let qpAttempts = 0;
      let lineCandidates = 0;
      let damping = this.initialDamping();
      let accepted = false;
      while (
        qpAttempts < MAX_LINE_SEARCHES &&
        lineCandidates < MAX_LINE_SEARCHES &&
        this.environmentBatches < MAX_ENVIRONMENT_BATCHES
      ) {
        this.buildHessian(damping);
        qpAttempts++;
        if (!this.solveLinear(this.hessian, this.rightHand, this.solved)) {
          damping *= 10;
          continue;
        }
        if (
          !this.makeConstrainedStep(
            this.current,
            bounds,
            this.solved,
            this.current.clearances,
            false,
          )
        ) {
          if (this.lastQpResult === 'infeasible') break;
          damping *= 10;
          continue;
        }
        if (this.stepNorm(this.qpDelta) < 1e-10) break;

        while (lineCandidates < MAX_LINE_SEARCHES) {
          const line = lineCandidates++;
          const alpha = 2 ** -line;
          if (!this.writeBoundedTrial(this.current.q, this.qpDelta, alpha, bounds)) continue;
          this.candidate.q.set(this.trialQ);
          if (!this.evaluateGeometry(this.candidate, context, bounds)) {
            continue;
          }
          if (!this.sampleClearances(this.candidate, environment)) break;
          this.measureState(this.candidate);
          if (!this.improvesPenetration(this.candidate, this.current)) continue;

          this.copyState(this.candidate, this.current);
          accepted = true;
          if (this.current.maxViolation <= this.roundoffTolerance) return used;
          break;
        }
        // A successful QP owns the remaining endpoint line sequence for this iteration.
        break;
      }
      if (!accepted) break;
    }
    return used;
  }

  private resetOutput(out: ArmPathPlanOutput): void {
    out.q.fill(0);
    configurationFromQ(out.q, out.configuration);
    out.forward.u.set(0, 0, 0);
    out.forward.l.set(0, 0, 0);
    out.forward.h.set(0, 0, 0);
    out.forward.palm.set(0, 0, 0);
    out.forward.elbow.set(0, 0, 0);
    out.forward.wrist.set(0, 0, 0);
    out.forward.upperWorld.identity();
    out.forward.lowerWorld.identity();
    out.forward.handWorld.identity();
    out.forward.upperLocal.identity();
    out.forward.lowerLocal.identity();
    out.forward.handLocal.identity();
    for (const pathPoint of out.points) pathPoint.position.set(0, 0, 0);
    for (const row of out.clearances) {
      row.key = '';
      row.pointIndex = -1;
      row.valid = false;
      row.distance = Number.POSITIVE_INFINITY;
      row.normal.set(0, 0, 0);
    }
    out.status = 'blocked';
    out.positionError = Number.POSITIVE_INFINITY;
    out.orientationError = Number.POSITIVE_INFINITY;
    out.secondaryError = Number.POSITIVE_INFINITY;
    out.maxViolation = Number.POSITIVE_INFINITY;
    out.iterations = 0;
    out.environmentBatches = 0;
  }

  private resetSearchScratch(): void {
    this.environmentBatches = 0;
    this.preparedSweepCount = 0;
    this.reservedSweepCount = 0;
    this.hasCertifiedProgress = false;
    this.currentIsCertified = true;
    this.keyContractReady = false;
    this.newForcedRows = false;
    this.rowMap.clear();
    this.registeredPointIndices.fill(-1);
    // Probes and the other sweep states only evaluate geometry; their rows stay neutral.
    for (const state of this.clearanceStates) {
      for (const row of state.clearances) {
        row.key = '';
        row.pointIndex = -1;
        row.valid = false;
        row.distance = Number.POSITIVE_INFINITY;
        row.normal.set(0, 0, 0);
      }
    }
    // Inactive payloads are never read; rememberFailedRows overwrites every field.
    this.forcedRows.fill(false);
  }

  private copySafeStart(out: ArmPathPlanOutput, start: Float64Array): void {
    if (start.length !== DOFS) return;
    for (let i = 0; i < DOFS; i++) if (!finiteNumber(start[i])) return;
    out.q.set(start);
    configurationFromQ(out.q, out.configuration);
  }

  private validRequest(request: ArmPathRequest): boolean {
    return (
      !!request &&
      finiteVector(request.wrist) &&
      finiteVector(request.hand) &&
      request.hand.lengthSq() > 1e-12 &&
      (request.palm === null || finiteVector(request.palm)) &&
      (request.elbow === undefined || finiteVector(request.elbow)) &&
      finiteSpec(request.curls) &&
      finiteSpec(request.spread)
    );
  }

  private prepareRows(count: number): void {
    this.rowCount = count;
    this.queryRows = cloneRows(count);
    for (const state of this.allStates) state.clearances = cloneRows(count);
    this.forcedDistance.length = count;
    this.forcedNormals.length = count;
    this.forcedPoints.length = count;
    this.forcedPointIndex.length = count;
    this.forcedRows.length = count;
    for (let i = 0; i < count; i++) {
      this.forcedDistance[i] = Number.POSITIVE_INFINITY;
      this.forcedNormals[i] = new THREE.Vector3();
      this.forcedPoints[i] = new THREE.Vector3();
      this.forcedPointIndex[i] = -1;
      this.forcedRows[i] = false;
    }
    const maxPoints = this.templatePoints.length;
    this.pointJacobian = new Float64Array(maxPoints * DIRECTION_COMPONENTS * DOFS);
    this.mappedSeen = new Uint8Array(count);
    this.registeredKeys.length = count;
    this.registeredPointIndices = new Int32Array(count);
    this.qpCapacity = count + 2 * DOFS;
    this.qpA = new Float64Array(this.qpCapacity * DOFS);
    this.qpB = new Float64Array(this.qpCapacity);
    this.qpZ = new Float64Array(this.qpCapacity * DOFS);
    this.qpLambda = new Float64Array(this.qpCapacity);
  }

  private withinBounds(q: Float64Array, bounds: ResolvedBounds): boolean {
    for (let i = 0; i < DOFS; i++) {
      if (!finiteNumber(q[i]) || q[i] < bounds.lower[i] || q[i] > bounds.upper[i]) return false;
    }
    return true;
  }

  private writeBoundedTrial(
    start: Float64Array,
    delta: Float64Array,
    alpha: number,
    bounds: ResolvedBounds,
  ): boolean {
    for (let dof = 0; dof < DOFS; dof++) {
      const raw = start[dof] + alpha * delta[dof];
      if (!finiteNumber(raw)) return false;
      const bounded = Math.max(bounds.lower[dof], Math.min(bounds.upper[dof], raw));
      if (Math.abs(bounded - raw) > CONSTRAINT_EPSILON) return false;
      this.trialQ[dof] = bounded;
    }
    return this.withinBounds(this.trialQ, bounds);
  }

  private fillTargetLandmarks(): void {
    const h = this.targetHand;
    this.targetLandmarks[0] = this.targetWrist.x;
    this.targetLandmarks[1] = this.targetWrist.y;
    this.targetLandmarks[2] = this.targetWrist.z;
    this.targetLandmarks[3] = this.targetWrist.x + this.handLength * h.x;
    this.targetLandmarks[4] = this.targetWrist.y + this.handLength * h.y;
    this.targetLandmarks[5] = this.targetWrist.z + this.handLength * h.z;
    if (this.requestHasPalm) {
      this.targetLandmarks[6] = this.targetWrist.x + this.handLength * this.targetPalm.x;
      this.targetLandmarks[7] = this.targetWrist.y + this.handLength * this.targetPalm.y;
      this.targetLandmarks[8] = this.targetWrist.z + this.handLength * this.targetPalm.z;
    }
  }

  private evaluateGeometry(
    state: PathState,
    context: ArmForwardContext,
    bounds: ResolvedBounds,
  ): boolean {
    if (!this.withinBounds(state.q, bounds)) return false;
    configurationFromQ(state.q, state.configuration);
    forwardArm(state.configuration, this.calibration, context, state.forward);
    if (!validForward(state.forward)) return false;
    const points = state.points;
    let cursor = 0;
    const span = context.upperLength * (1 - TORSO_ARM_START);
    for (let i = 0; i <= TORSO_SAMPLES; i++) {
      points[cursor++].position
        .copy(context.shoulder)
        .addScaledVector(
          state.forward.u,
          context.upperLength * TORSO_ARM_START + (span * i) / TORSO_SAMPLES,
        );
    }
    for (let i = 1; i <= TORSO_SAMPLES; i++) {
      points[cursor++].position
        .copy(state.forward.elbow)
        .addScaledVector(state.forward.l, (context.lowerLength * i) / TORSO_SAMPLES);
    }
    for (let i = 1; i <= TORSO_SAMPLES; i++) {
      points[cursor++].position
        .copy(state.forward.wrist)
        .addScaledVector(state.forward.h, (this.handLength * HAND_CONTACT * i) / TORSO_SAMPLES);
    }
    for (let i = 0; i < this.localFingerPoints.length; i++) {
      points[cursor++].position
        .copy(this.localFingerPoints[i])
        .applyQuaternion(state.forward.handWorld)
        .add(state.forward.wrist);
    }
    if (cursor !== points.length) return false;
    for (const pathPoint of points) if (!finiteVector(pathPoint.position)) return false;
    return true;
  }

  private sampleClearances(
    state: PathState,
    environment: ArmPathEnvironment,
    queryCeiling = MAX_ENVIRONMENT_BATCHES,
  ): boolean {
    if (environment.rowCount === 0) return true;
    if (this.environmentBatches >= Math.min(queryCeiling, MAX_ENVIRONMENT_BATCHES)) return false;
    for (const row of this.queryRows) {
      row.key = '';
      row.pointIndex = -1;
      row.valid = false;
      row.distance = Number.POSITIVE_INFINITY;
      row.normal.set(0, 0, 0);
    }
    environment.sample(state.points, this.queryRows);
    this.environmentBatches++;
    if (!this.keyContractReady) {
      // Register every key before validating row values, preserving rejection order.
      for (let i = 0; i < this.queryRows.length; i++) {
        const row = this.queryRows[i];
        if (
          !row.key ||
          row.pointIndex < 0 ||
          row.pointIndex >= state.points.length ||
          this.rowMap.has(row.key)
        ) {
          throw new Error('clearance rows need unique stable keys and valid point indices');
        }
        this.rowMap.set(row.key, i);
        this.registeredKeys[i] = row.key;
        this.registeredPointIndices[i] = row.pointIndex;
      }
      this.keyContractReady = true;
    }
    this.mappedSeen.fill(0);
    for (let slot = 0; slot < this.queryRows.length; slot++) {
      const row = this.queryRows[slot];
      const index = this.registeredKeys[slot] === row.key ? slot : this.rowMap.get(row.key);
      if (index === undefined || this.mappedSeen[index]) {
        throw new Error('clearance row keys must stay stable and unique across samples');
      }
      if (this.registeredPointIndices[index] !== row.pointIndex) {
        throw new Error('clearance key changed its stable point index');
      }
      this.mappedSeen[index] = 1;
      const canonical = state.clearances[index];
      if (!canonical || (canonical.pointIndex !== -1 && canonical.pointIndex !== row.pointIndex)) {
        throw new Error('clearance key changed its stable point index');
      }
      if (canonical.pointIndex === -1) canonical.pointIndex = row.pointIndex;
      canonical.key = row.key;
      canonical.valid = row.valid;
      canonical.distance = row.distance;
      canonical.normal.copy(row.normal);
      if (
        row.valid &&
        (!(finiteNumber(row.distance) && finiteVector(row.normal)) || row.normal.lengthSq() < 1e-12)
      ) {
        throw new Error('valid clearance rows need a finite distance and nonzero finite normal');
      }
    }
    return true;
  }

  private measureState(state: PathState): void {
    let sum = 0;
    const landmarkCount = this.requestHasPalm ? LANDMARKS : LANDMARKS - 1;
    for (let landmark = 0; landmark < landmarkCount; landmark++) {
      const wrist = state.forward.wrist;
      for (let axis = 0; axis < DIRECTION_COMPONENTS; axis++) {
        const wristComponent = axis === 0 ? wrist.x : axis === 1 ? wrist.y : wrist.z;
        const direction = landmark === 1 ? state.forward.h : state.forward.palm;
        const value =
          landmark === 0
            ? wristComponent
            : wristComponent +
              this.handLength * (axis === 0 ? direction.x : axis === 1 ? direction.y : direction.z);
        const error = (this.targetLandmarks[landmark * 3 + axis] - value) / this.span;
        this.residual[landmark * 3 + axis] = error;
        sum += error * error;
      }
    }
    state.primaryError = sum;
    state.positionError = Math.sqrt(sum) * this.span;
    state.orientationError = this.orientationError(state.forward);
    if (this.requestHasElbow) {
      const dx = (this.targetElbow.x - state.forward.elbow.x) / this.span;
      const dy = (this.targetElbow.y - state.forward.elbow.y) / this.span;
      const dz = (this.targetElbow.z - state.forward.elbow.z) / this.span;
      const excess = this.deviationExcess(state.q[6]);
      state.secondaryError =
        dx * dx + dy * dy + dz * dz + DEVIATION_COMFORT_WEIGHT * excess * excess;
    } else {
      state.secondaryError = 0;
    }
    let violation = 0;
    let penetrationSquareSum = 0;
    for (const clearance of state.clearances) {
      if (clearance.valid && clearance.distance < 0) {
        violation = Math.max(violation, -clearance.distance);
        const normalized = clearance.distance / this.span;
        penetrationSquareSum += normalized * normalized;
      }
    }
    state.maxViolation = Math.max(0, violation);
    state.penetrationSquareSum = penetrationSquareSum;
  }

  private orientationError(forwardResult: ArmForwardResult): number {
    const handDot = THREE.MathUtils.clamp(forwardResult.h.dot(this.targetHand), -1, 1);
    let error = Math.acos(handDot);
    if (this.requestHasPalm) {
      const palmDot = THREE.MathUtils.clamp(forwardResult.palm.dot(this.targetPalm), -1, 1);
      error = Math.max(error, Math.acos(palmDot));
    }
    return error;
  }

  /**
   * At zero elevation shoulderPlane is only a gauge. Choose a bounded plane
   * that points the next positive lift along the primary landmark descent.
   */
  private poleGaugeProposal(
    state: PathState,
    context: ArmForwardContext,
    bounds: ResolvedBounds,
  ): number | undefined {
    if (
      state.q[1] !== 0 ||
      this.rightHand[1] > 0 ||
      !(bounds.upper[0] > bounds.lower[0]) ||
      !(bounds.upper[1] > 0)
    )
      return undefined;
    if (!this.polePrimaryGradient(state, context)) return undefined;
    const gL = this.poleGradient[0];
    const gF = this.poleGradient[1];
    const magnitude = Math.hypot(gL, gF);
    if (
      !finiteNumber(magnitude) ||
      magnitude * DIFFERENCE_SCALE <= this.lexicalTolerance(state.primaryError)
    )
      return undefined;

    const ray = Math.atan2(gF, gL);
    this.poleRay = ray;
    const firstEquivalent = Math.floor((state.q[0] - ray) / FULL_TURN);
    let best = state.q[0];
    let bestAlignment = Number.NEGATIVE_INFINITY;
    let bestMovement = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < 2; offset++) {
      const equivalent = ray + (firstEquivalent + offset) * FULL_TURN;
      const target = Math.max(bounds.lower[0], Math.min(bounds.upper[0], equivalent));
      const alignment = Math.cos(target - ray);
      const movement = Math.abs(target - state.q[0]);
      if (alignment > bestAlignment || (alignment === bestAlignment && movement < bestMovement)) {
        best = target;
        bestAlignment = alignment;
        bestMovement = movement;
      }
    }
    if (
      best === state.q[0] ||
      bestAlignment - Math.cos(state.q[0] - ray) <= this.lexicalTolerance(state.primaryError)
    )
      return undefined;
    return best;
  }

  /** Four pure FK probes estimate only the primary tangent at the lift pole. */
  private polePrimaryGradient(state: PathState, context: ArmForwardContext): boolean {
    const half = DIFFERENCE_SCALE;
    const positiveL = this.poleProbe(state, context, 0, half, this.probePlus);
    const negativeL = this.poleProbe(state, context, Math.PI, half, this.probeMinus);
    if (!(positiveL && negativeL)) return false;
    const landmarkCount = this.requestHasPalm ? LANDMARKS : LANDMARKS - 1;
    let gL = 0;
    for (let landmark = 0; landmark < landmarkCount; landmark++) {
      for (let axis = 0; axis < DIRECTION_COMPONENTS; axis++) {
        const row = landmark * DIRECTION_COMPONENTS + axis;
        const derivative =
          (this.landmarkComponent(this.probePlus.forward, landmark, axis) -
            this.landmarkComponent(this.probeMinus.forward, landmark, axis)) /
          (2 * half * this.span);
        gL += derivative * this.residual[row];
      }
    }

    const positiveF = this.poleProbe(state, context, Math.PI / 2, half, this.probePlus);
    const negativeF = this.poleProbe(state, context, (3 * Math.PI) / 2, half, this.probeMinus);
    if (!(positiveF && negativeF)) return false;
    let gF = 0;
    for (let landmark = 0; landmark < landmarkCount; landmark++) {
      for (let axis = 0; axis < DIRECTION_COMPONENTS; axis++) {
        const row = landmark * DIRECTION_COMPONENTS + axis;
        const derivative =
          (this.landmarkComponent(this.probePlus.forward, landmark, axis) -
            this.landmarkComponent(this.probeMinus.forward, landmark, axis)) /
          (2 * half * this.span);
        gF += derivative * this.residual[row];
      }
    }
    if (!(finiteNumber(gL) && finiteNumber(gF))) return false;
    this.poleGradient[0] = gL;
    this.poleGradient[1] = gF;
    return true;
  }

  private poleProbe(
    state: PathState,
    context: ArmForwardContext,
    plane: number,
    physicalElevation: number,
    out: PathState,
  ): boolean {
    const ceiling = elevationCeiling(plane, this.calibration.joints.shoulder.elevation).max;
    if (!(finiteNumber(ceiling) && ceiling > 0)) return false;
    out.q.set(state.q);
    out.q[0] = plane;
    out.q[1] = (Math.PI * physicalElevation) / ceiling;
    if (!finiteNumber(out.q[1])) return false;
    configurationFromQ(out.q, out.configuration);
    forwardArm(out.configuration, this.calibration, context, out.forward);
    return true;
  }

  private betterPoleGauge(candidate: PathState, current: PathState, rayPlane: number): boolean {
    const tolerance = this.lexicalTolerance(current.primaryError);
    if (candidate.maxViolation < current.maxViolation - this.roundoffTolerance) return true;
    if (candidate.maxViolation > current.maxViolation + this.roundoffTolerance) return false;
    if (candidate.primaryError < current.primaryError - tolerance) return true;
    if (candidate.primaryError > current.primaryError + tolerance) return false;
    if (candidate.secondaryError < current.secondaryError - tolerance) return true;
    if (candidate.secondaryError > current.secondaryError + tolerance) return false;
    return Math.cos(candidate.q[0] - rayPlane) > Math.cos(current.q[0] - rayPlane) + tolerance;
  }

  private linearize(state: PathState, context: ArmForwardContext, bounds: ResolvedBounds): boolean {
    this.measureState(state);
    this.jacobian.fill(0);
    this.elbowJacobian.fill(0);
    this.pointJacobian.fill(0);
    for (let dof = 0; dof < DOFS; dof++) {
      const h = DIFFERENCE_SCALE * Math.max(1, Math.abs(state.q[dof]));
      const canMinus = state.q[dof] - h >= bounds.lower[dof];
      const canPlus = state.q[dof] + h <= bounds.upper[dof];
      if (!(canMinus || canPlus)) continue;
      const useMinus = canMinus;
      const usePlus = canPlus;
      const lowQ = useMinus ? state.q[dof] - h : state.q[dof];
      const highQ = usePlus ? state.q[dof] + h : state.q[dof];
      if (highQ === lowQ) continue;
      this.probeMinus.q.set(state.q);
      this.probePlus.q.set(state.q);
      this.probeMinus.q[dof] = lowQ;
      this.probePlus.q[dof] = highQ;
      if (!this.evaluateGeometry(this.probeMinus, context, bounds)) continue;
      if (!this.evaluateGeometry(this.probePlus, context, bounds)) continue;
      const divisor = highQ - lowQ;
      const landmarkCount = this.requestHasPalm ? LANDMARKS : LANDMARKS - 1;
      for (let landmark = 0; landmark < landmarkCount; landmark++) {
        for (let axis = 0; axis < DIRECTION_COMPONENTS; axis++) {
          const minusValue = this.landmarkComponent(this.probeMinus.forward, landmark, axis);
          const plusValue = this.landmarkComponent(this.probePlus.forward, landmark, axis);
          const index = (landmark * DIRECTION_COMPONENTS + axis) * DOFS + dof;
          this.jacobian[index] = (plusValue - minusValue) / (divisor * this.span);
        }
      }
      const elbowOffset = dof;
      this.elbowJacobian[elbowOffset] =
        (this.probePlus.forward.elbow.x - this.probeMinus.forward.elbow.x) / (divisor * this.span);
      this.elbowJacobian[DOFS + elbowOffset] =
        (this.probePlus.forward.elbow.y - this.probeMinus.forward.elbow.y) / (divisor * this.span);
      this.elbowJacobian[2 * DOFS + elbowOffset] =
        (this.probePlus.forward.elbow.z - this.probeMinus.forward.elbow.z) / (divisor * this.span);
      for (let pointIndex = 0; pointIndex < state.points.length; pointIndex++) {
        const minus = this.probeMinus.points[pointIndex].position;
        const plus = this.probePlus.points[pointIndex].position;
        const offset = pointIndex * DIRECTION_COMPONENTS * DOFS + dof;
        this.pointJacobian[offset] = (plus.x - minus.x) / divisor;
        this.pointJacobian[offset + DOFS] = (plus.y - minus.y) / divisor;
        this.pointJacobian[offset + 2 * DOFS] = (plus.z - minus.z) / divisor;
      }
    }
    const landmarkCount = this.requestHasPalm ? LANDMARKS : LANDMARKS - 1;
    this.normalMatrix.fill(0);
    this.rightHand.fill(0);
    for (let row = 0; row < landmarkCount * DIRECTION_COMPONENTS; row++) {
      const offset = row * DOFS;
      for (let i = 0; i < DOFS; i++) {
        const ji = this.jacobian[offset + i];
        this.rightHand[i] += ji * this.residual[row];
        for (let j = 0; j < DOFS; j++) {
          this.normalMatrix[i * DOFS + j] += ji * this.jacobian[offset + j];
        }
      }
    }
    return this.normalMatrix.every(Number.isFinite) && this.rightHand.every(Number.isFinite);
  }

  private linearizePenetration(
    state: PathState,
    context: ArmForwardContext,
    bounds: ResolvedBounds,
  ): boolean {
    this.pointJacobian.fill(0);
    for (let dof = 0; dof < DOFS; dof++) {
      const h = DIFFERENCE_SCALE * Math.max(1, Math.abs(state.q[dof]));
      const canMinus = state.q[dof] - h >= bounds.lower[dof];
      const canPlus = state.q[dof] + h <= bounds.upper[dof];
      if (!(canMinus || canPlus)) continue;
      const lowQ = canMinus ? state.q[dof] - h : state.q[dof];
      const highQ = canPlus ? state.q[dof] + h : state.q[dof];
      if (highQ === lowQ) continue;
      this.probeMinus.q.set(state.q);
      this.probePlus.q.set(state.q);
      this.probeMinus.q[dof] = lowQ;
      this.probePlus.q[dof] = highQ;
      if (!this.evaluateGeometry(this.probeMinus, context, bounds)) return false;
      if (!this.evaluateGeometry(this.probePlus, context, bounds)) return false;
      const divisor = highQ - lowQ;
      for (let pointIndex = 0; pointIndex < state.points.length; pointIndex++) {
        const minus = this.probeMinus.points[pointIndex].position;
        const plus = this.probePlus.points[pointIndex].position;
        const offset = pointIndex * DIRECTION_COMPONENTS * DOFS + dof;
        this.pointJacobian[offset] = (plus.x - minus.x) / divisor;
        this.pointJacobian[offset + DOFS] = (plus.y - minus.y) / divisor;
        this.pointJacobian[offset + 2 * DOFS] = (plus.z - minus.z) / divisor;
      }
    }

    this.normalMatrix.fill(0);
    this.rightHand.fill(0);
    for (const clearance of state.clearances) {
      if (!clearance.valid || clearance.distance >= 0) continue;
      const pointIndex = clearance.pointIndex;
      if (pointIndex < 0 || pointIndex >= state.points.length) return false;
      const rowOffset = pointIndex * DIRECTION_COMPONENTS * DOFS;
      const residual = (clearance.distance - RESTORE_MARGIN) / this.span;
      for (let i = 0; i < DOFS; i++) {
        const ji =
          (clearance.normal.x * this.pointJacobian[rowOffset + i] +
            clearance.normal.y * this.pointJacobian[rowOffset + DOFS + i] +
            clearance.normal.z * this.pointJacobian[rowOffset + 2 * DOFS + i]) /
          this.span;
        this.rightHand[i] -= ji * residual;
        for (let j = 0; j < DOFS; j++) {
          const jj =
            (clearance.normal.x * this.pointJacobian[rowOffset + j] +
              clearance.normal.y * this.pointJacobian[rowOffset + DOFS + j] +
              clearance.normal.z * this.pointJacobian[rowOffset + 2 * DOFS + j]) /
            this.span;
          this.normalMatrix[i * DOFS + j] += ji * jj;
        }
      }
    }
    return this.normalMatrix.every(Number.isFinite) && this.rightHand.every(Number.isFinite);
  }

  private landmarkComponent(result: ArmForwardResult, landmark: number, axis: number): number {
    let value: number;
    if (landmark === 0)
      value = axis === 0 ? result.wrist.x : axis === 1 ? result.wrist.y : result.wrist.z;
    else if (landmark === 1) {
      value = axis === 0 ? result.wrist.x : axis === 1 ? result.wrist.y : result.wrist.z;
      value += this.handLength * (axis === 0 ? result.h.x : axis === 1 ? result.h.y : result.h.z);
    } else {
      value = axis === 0 ? result.wrist.x : axis === 1 ? result.wrist.y : result.wrist.z;
      value +=
        this.handLength * (axis === 0 ? result.palm.x : axis === 1 ? result.palm.y : result.palm.z);
    }
    return value;
  }

  private initialDamping(): number {
    let trace = 0;
    for (let i = 0; i < DOFS; i++) trace += this.normalMatrix[i * DOFS + i];
    return Math.max(trace / DOFS, 1e-12) * 1e-4;
  }

  private buildHessian(damping: number): void {
    this.hessian.set(this.normalMatrix);
    for (let i = 0; i < DOFS; i++) this.hessian[i * DOFS + i] += damping;
  }

  private solveLinear(
    matrix: Float64Array,
    rhs: Float64Array,
    out: Float64Array,
    rhsOffset = 0,
    outOffset = 0,
  ): boolean {
    this.cholesky.fill(0);
    for (let i = 0; i < DOFS; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = matrix[i * DOFS + j];
        for (let k = 0; k < j; k++)
          sum -= this.cholesky[i * DOFS + k] * this.cholesky[j * DOFS + k];
        if (i === j) {
          if (!(sum > 0 && finiteNumber(sum))) return false;
          this.cholesky[i * DOFS + j] = Math.sqrt(sum);
        } else {
          this.cholesky[i * DOFS + j] = sum / this.cholesky[j * DOFS + j];
        }
      }
    }
    for (let i = 0; i < DOFS; i++) {
      let sum = rhs[rhsOffset + i];
      for (let j = 0; j < i; j++) sum -= this.cholesky[i * DOFS + j] * this.solveScratch[j];
      this.solveScratch[i] = sum / this.cholesky[i * DOFS + i];
    }
    for (let i = DOFS - 1; i >= 0; i--) {
      let sum = this.solveScratch[i];
      for (let j = i + 1; j < DOFS; j++) sum -= this.cholesky[j * DOFS + i] * out[outOffset + j];
      out[outOffset + i] = sum / this.cholesky[i * DOFS + i];
    }
    for (let i = 0; i < DOFS; i++) if (!finiteNumber(out[outOffset + i])) return false;
    return true;
  }

  private makeConstrainedStep(
    state: PathState,
    bounds: ResolvedBounds,
    unconstrained: Float64Array,
    clearances: readonly ArmPathClearance[],
    includeClearanceConstraints = true,
    nullspace = false,
  ): boolean {
    this.lastQpResult = 'rejected';
    let constraintCount = 0;
    for (let dof = 0; dof < DOFS; dof++) {
      const lowerOffset = constraintCount++ * DOFS;
      this.qpA.fill(0, lowerOffset, lowerOffset + DOFS);
      this.qpA[lowerOffset + dof] = 1;
      this.qpB[constraintCount - 1] = bounds.lower[dof] - state.q[dof];
      const upperOffset = constraintCount++ * DOFS;
      this.qpA.fill(0, upperOffset, upperOffset + DOFS);
      this.qpA[upperOffset + dof] = -1;
      this.qpB[constraintCount - 1] = state.q[dof] - bounds.upper[dof];
    }
    if (includeClearanceConstraints) {
      for (let row = 0; row < clearances.length; row++) {
        const clearance = clearances[row];
        const forced = this.forcedRows[row];
        if (!(clearance.valid || forced)) continue;
        const pointIndex = forced ? this.forcedPointIndex[row] : clearance.pointIndex;
        if (pointIndex < 0 || pointIndex >= state.points.length) continue;
        const displacement = this.predictedPointDisplacement(pointIndex, unconstrained);
        if (
          !(nullspace || forced) &&
          clearance.distance > clearance.normal.length() * displacement + this.roundoffTolerance
        )
          continue;
        if (constraintCount >= this.qpCapacity) return false;
        const offset = constraintCount * DOFS;
        const normal = forced ? this.forcedNormals[row] : clearance.normal;
        for (let dof = 0; dof < DOFS; dof++) {
          const jx = this.pointJacobian[pointIndex * 3 * DOFS + dof];
          const jy = this.pointJacobian[(pointIndex * 3 + 1) * DOFS + dof];
          const jz = this.pointJacobian[(pointIndex * 3 + 2) * DOFS + dof];
          this.qpA[offset + dof] = (normal.x * jx + normal.y * jy + normal.z * jz) / this.span;
        }
        const distance = forced
          ? this.forcedDistance[row] +
            normal.dot(
              this.clearanceScratch.subVectors(
                state.points[pointIndex].position,
                this.forcedPoints[row],
              ),
            )
          : clearance.distance;
        this.qpB[constraintCount] = -distance / this.span;
        constraintCount++;
      }
    }
    for (let constraint = 0; constraint < constraintCount; constraint++) {
      const aOffset = constraint * DOFS;
      if (nullspace) {
        this.qpB[constraint] -= dotRow(this.qpA, constraint, this.primaryDelta);
        for (let dof = 0; dof < DOFS; dof++) this.secondaryVector[dof] = this.qpA[aOffset + dof];
        this.projectToPrimaryNullspace(this.secondaryVector);
        if (!this.solveLinear(this.hessian, this.secondaryVector, this.qpZ, 0, aOffset))
          return false;
        this.projectToPrimaryNullspace(this.qpZ, aOffset);
      } else if (!this.solveLinear(this.hessian, this.qpA, this.qpZ, aOffset, aOffset))
        return false;
      const denominator = dotRow(this.qpA, constraint, this.qpZ, aOffset);
      if (!(denominator > 1e-16) && this.qpB[constraint] > CONSTRAINT_EPSILON) return false;
    }
    const result = solveDualActiveSet(
      this.qpA,
      this.qpB,
      this.qpZ,
      constraintCount,
      unconstrained,
      this.qpDelta,
      this.qpLambda,
      this.qpScratch,
    );
    if (result !== 'optimal') {
      this.lastQpResult = result;
      return false;
    }
    if (nullspace) this.projectToPrimaryNullspace(this.qpDelta);
    for (let constraint = 0; constraint < constraintCount; constraint++) {
      if (dotRow(this.qpA, constraint, this.qpDelta) < this.qpB[constraint] - CONSTRAINT_EPSILON)
        return false;
    }
    for (let dof = 0; dof < DOFS; dof++) {
      const endpoint = state.q[dof] + this.qpDelta[dof] + (nullspace ? this.primaryDelta[dof] : 0);
      if (!finiteNumber(endpoint)) return false;
      const bounded = Math.max(bounds.lower[dof], Math.min(bounds.upper[dof], endpoint));
      if (Math.abs(bounded - endpoint) > CONSTRAINT_EPSILON) return false;
      // Clamping individual coordinates would leave the primary nullspace.
      if (!nullspace) this.qpDelta[dof] = bounded - state.q[dof];
    }
    for (let constraint = 0; constraint < constraintCount; constraint++) {
      if (dotRow(this.qpA, constraint, this.qpDelta) < this.qpB[constraint] - CONSTRAINT_EPSILON)
        return false;
    }
    if (!this.qpDelta.every(Number.isFinite)) return false;
    this.lastStepTemporal = false;
    for (let dof = 0; dof < DOFS && !this.lastStepTemporal; dof++) {
      this.lastStepTemporal =
        (bounds.lowerTemporal[dof] === 1 && this.qpLambda[2 * dof] > 0) ||
        (bounds.upperTemporal[dof] === 1 && this.qpLambda[2 * dof + 1] > 0);
    }
    this.lastQpResult = 'optimal';
    return true;
  }

  private predictedPointDisplacement(pointIndex: number, delta: Float64Array): number {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let dof = 0; dof < DOFS; dof++) {
      const offset = pointIndex * 3 * DOFS + dof;
      x += this.pointJacobian[offset] * delta[dof];
      y += this.pointJacobian[offset + DOFS] * delta[dof];
      z += this.pointJacobian[offset + 2 * DOFS] * delta[dof];
    }
    return Math.hypot(x, y, z);
  }

  private rememberFailedRows(state: PathState): void {
    for (let i = 0; i < state.clearances.length; i++) {
      const row = state.clearances[i];
      if (!row.valid || row.distance >= -this.roundoffTolerance) continue;
      this.forcedRows[i] = true;
      this.forcedDistance[i] = row.distance;
      this.forcedNormals[i].copy(row.normal);
      this.forcedPointIndex[i] = row.pointIndex;
      this.forcedPoints[i].copy(state.points[row.pointIndex].position);
      this.newForcedRows = true;
    }
  }

  private prepareSweep(
    start: PathState,
    end: PathState,
    context: ArmForwardContext,
    bounds: ResolvedBounds,
    queryBudget: number,
  ): boolean {
    this.preparedSweepCount = 0;
    if (queryBudget < 1) return false;
    for (let quarter = 0; quarter < 3; quarter++) {
      const fraction = (quarter + 1) / 4;
      const state = this.quarterStates[quarter];
      if (!this.interpolateSweepQ(state.q, start.q, end.q, fraction, bounds)) return false;
      if (!this.evaluateGeometry(state, context, bounds)) return false;
      if (!this.rememberSweepFraction(fraction, queryBudget)) return false;
    }
    for (let interval = 0; interval < 4; interval++) {
      const a = interval === 0 ? start : this.quarterStates[interval - 1];
      const b = interval === 3 ? end : this.quarterStates[interval];
      if (
        !this.prepareSweepInterval(
          start,
          end,
          a,
          b,
          interval / 4,
          (interval + 1) / 4,
          0,
          context,
          bounds,
          queryBudget,
        )
      )
        return false;
    }
    return true;
  }

  /** Adaptive FK sampling at a fixed proxy resolution; this is not exact mesh CCD. */
  private prepareSweepInterval(
    fullStart: PathState,
    fullEnd: PathState,
    a: PathState,
    b: PathState,
    aFraction: number,
    bFraction: number,
    depth: number,
    context: ArmForwardContext,
    bounds: ResolvedBounds,
    queryBudget: number,
  ): boolean {
    if (this.maxPointTravel(a, b) <= this.resolution) return true;
    if (depth >= MAX_SWEEP_DEPTH) return false;
    const middle = this.recursiveStates[depth];
    const middleFraction = (aFraction + bFraction) / 2;
    if (!this.interpolateSweepQ(middle.q, fullStart.q, fullEnd.q, middleFraction, bounds))
      return false;
    if (!this.evaluateGeometry(middle, context, bounds)) return false;
    if (!this.rememberSweepFraction(middleFraction, queryBudget)) return false;
    return (
      this.prepareSweepInterval(
        fullStart,
        fullEnd,
        a,
        middle,
        aFraction,
        middleFraction,
        depth + 1,
        context,
        bounds,
        queryBudget,
      ) &&
      this.prepareSweepInterval(
        fullStart,
        fullEnd,
        middle,
        b,
        middleFraction,
        bFraction,
        depth + 1,
        context,
        bounds,
        queryBudget,
      )
    );
  }

  private rememberSweepFraction(fraction: number, queryBudget: number): boolean {
    if (this.preparedSweepCount >= this.preparedSweepFractions.length) return false;
    this.preparedSweepFractions[this.preparedSweepCount++] = fraction;
    // One additional query is reserved for the candidate endpoint itself.
    return this.preparedSweepCount + 1 <= queryBudget;
  }

  private interpolateSweepQ(
    out: Float64Array,
    start: Float64Array,
    end: Float64Array,
    fraction: number,
    bounds: ResolvedBounds,
  ): boolean {
    for (let dof = 0; dof < DOFS; dof++) {
      const raw = start[dof] + (end[dof] - start[dof]) * fraction;
      if (!finiteNumber(raw)) return false;
      const bounded = Math.max(bounds.lower[dof], Math.min(bounds.upper[dof], raw));
      if (Math.abs(bounded - raw) > CONSTRAINT_EPSILON) return false;
      out[dof] = bounded;
    }
    return true;
  }

  /** Replay the exact geometry-only fraction list with actual environment queries. */
  private validatePreparedSweep(
    end: PathState,
    context: ArmForwardContext,
    bounds: ResolvedBounds,
    environment: ArmPathEnvironment,
    queryCeiling: number,
  ): boolean {
    if (environment.rowCount === 0) return true;
    const sample = this.quarterStates[0];
    for (let i = 0; i < this.preparedSweepCount; i++) {
      if (
        !this.interpolateSweepQ(
          sample.q,
          this.originalStart.q,
          end.q,
          this.preparedSweepFractions[i],
          bounds,
        )
      )
        return false;
      if (!this.evaluateGeometry(sample, context, bounds)) return false;
      if (!this.sampleClearances(sample, environment, queryCeiling)) return false;
      this.measureState(sample);
      if (sample.maxViolation > this.roundoffTolerance) {
        this.rememberFailedRows(sample);
        return false;
      }
    }
    return true;
  }

  private lineTrialQueryCeiling(lineCandidatesUsed: number): number {
    const remainingTrials = MAX_LINE_SEARCHES - lineCandidatesUsed;
    if (remainingTrials <= 0) return this.environmentBatches;
    return (
      this.environmentBatches +
      Math.floor((MAX_ENVIRONMENT_BATCHES - this.environmentBatches) / remainingTrials)
    );
  }

  private minimumSweepBatches(start: PathState, end: PathState): number {
    const travel = this.maxPointTravel(start, end);
    if (!finiteNumber(travel)) return Number.POSITIVE_INFINITY;
    return Math.max(4, Math.ceil(travel / this.resolution));
  }

  private maxPointTravel(a: PathState, b: PathState): number {
    let max = 0;
    for (let i = 0; i < a.points.length; i++) {
      max = Math.max(max, a.points[i].position.distanceTo(b.points[i].position));
    }
    return max;
  }

  private makeSecondaryStep(state: PathState, bounds: ResolvedBounds): boolean {
    if (!this.requestHasElbow) return false;
    const rowCount = this.requestHasPalm ? 9 : 6;
    const basis = this.rowBasis;
    let basisCount = 0;
    basis.fill(0);
    let largest = 0;
    for (let row = 0; row < rowCount; row++) {
      let norm = 0;
      for (let dof = 0; dof < DOFS; dof++) norm += this.jacobian[row * DOFS + dof] ** 2;
      largest = Math.max(largest, Math.sqrt(norm));
    }
    const threshold = DIFFERENCE_SCALE * largest;
    this.primaryRankThreshold = threshold;
    for (let row = 0; row < rowCount; row++) {
      for (let dof = 0; dof < DOFS; dof++)
        this.secondaryVector[dof] = this.jacobian[row * DOFS + dof];
      for (let pass = 0; pass < 2; pass++) {
        for (let basisIndex = 0; basisIndex < basisCount; basisIndex++) {
          const offset = basisIndex * DOFS;
          let projection = 0;
          for (let dof = 0; dof < DOFS; dof++)
            projection += this.secondaryVector[dof] * basis[offset + dof];
          for (let dof = 0; dof < DOFS; dof++)
            this.secondaryVector[dof] -= projection * basis[offset + dof];
        }
      }
      let norm = 0;
      for (let dof = 0; dof < DOFS; dof++) norm += this.secondaryVector[dof] ** 2;
      norm = Math.sqrt(norm);
      if (norm <= threshold) continue;
      const offset = basisCount++ * DOFS;
      for (let dof = 0; dof < DOFS; dof++) basis[offset + dof] = this.secondaryVector[dof] / norm;
    }
    this.primaryBasisCount = basisCount;
    if (basisCount >= DOFS) return false;

    this.projectedElbowJacobian.fill(0);
    for (let axis = 0; axis < DIRECTION_COMPONENTS; axis++) {
      for (let dof = 0; dof < DOFS; dof++) {
        this.secondaryVector[dof] = this.elbowJacobian[axis * DOFS + dof];
      }
      for (let basisIndex = 0; basisIndex < basisCount; basisIndex++) {
        const offset = basisIndex * DOFS;
        let projection = 0;
        for (let dof = 0; dof < DOFS; dof++)
          projection += this.secondaryVector[dof] * basis[offset + dof];
        for (let dof = 0; dof < DOFS; dof++)
          this.secondaryVector[dof] -= projection * basis[offset + dof];
      }
      this.projectedElbowJacobian.set(this.secondaryVector, axis * DOFS);
    }
    this.normalMatrix.fill(0);
    this.rightHand.fill(0);
    const elbowErrorX =
      (this.targetElbow.x - state.forward.elbow.x) / this.span -
      dotRow(this.elbowJacobian, 0, this.primaryDelta);
    const elbowErrorY =
      (this.targetElbow.y - state.forward.elbow.y) / this.span -
      dotRow(this.elbowJacobian, 1, this.primaryDelta);
    const elbowErrorZ =
      (this.targetElbow.z - state.forward.elbow.z) / this.span -
      dotRow(this.elbowJacobian, 2, this.primaryDelta);
    for (let i = 0; i < DOFS; i++) {
      for (let j = 0; j < DOFS; j++) {
        for (let axis = 0; axis < DIRECTION_COMPONENTS; axis++) {
          this.normalMatrix[i * DOFS + j] +=
            this.projectedElbowJacobian[axis * DOFS + i] *
            this.projectedElbowJacobian[axis * DOFS + j];
        }
      }
      this.rightHand[i] =
        this.projectedElbowJacobian[i] * elbowErrorX +
        this.projectedElbowJacobian[DOFS + i] * elbowErrorY +
        this.projectedElbowJacobian[2 * DOFS + i] * elbowErrorZ;
    }
    // The pole may not spend wrist deviation past the comfortable band the hand does not need.
    const excess = this.deviationExcess(state.q[6] + this.primaryDelta[6]);
    if (excess !== 0) {
      const row = this.comfortRow;
      row.fill(0);
      row[6] = 1;
      this.projectToPrimaryNullspace(row);
      for (let i = 0; i < DOFS; i++) {
        for (let j = 0; j < DOFS; j++)
          this.normalMatrix[i * DOFS + j] += DEVIATION_COMFORT_WEIGHT * row[i] * row[j];
        this.rightHand[i] -= DEVIATION_COMFORT_WEIGHT * row[i] * excess;
      }
    }
    let trace = 0;
    for (let i = 0; i < DOFS; i++) trace += this.normalMatrix[i * DOFS + i];
    const damping = Math.max(trace / DOFS, 1e-12) * 1e-4;
    this.buildHessian(damping);
    this.projectToPrimaryNullspace(this.rightHand);
    if (!this.solveLinear(this.hessian, this.rightHand, this.solved)) return false;
    // A second projection removes small numerical leakage from the damped solve.
    this.projectToPrimaryNullspace(this.solved);
    if (this.solved.every((value) => Math.abs(value) < 1e-10)) return false;
    if (!this.makeConstrainedStep(state, bounds, this.solved, state.clearances, true, true))
      return false;
    const leakage =
      this.primaryRankThreshold * this.stepNorm(this.qpDelta) + this.lexicalTolerance(0);
    for (let row = 0; row < rowCount; row++) {
      if (Math.abs(dotRow(this.jacobian, row, this.qpDelta)) > leakage) return false;
    }
    for (let dof = 0; dof < DOFS; dof++) this.qpDelta[dof] += this.primaryDelta[dof];
    return this.qpDelta.every(Number.isFinite);
  }

  /** Signed radians `deviation` lies past its comfort aim, zero inside it. */
  private deviationExcess(deviation: number): number {
    const [free0, free1] = this.calibration.joints.wrist.dofs.deviation.free;
    const lower = free0 + DEVIATION_COMFORT_MARGIN;
    const upper = free1 - DEVIATION_COMFORT_MARGIN;
    if (deviation < lower) return deviation - lower;
    if (deviation > upper) return deviation - upper;
    return 0;
  }

  private projectToPrimaryNullspace(vector: Float64Array, vectorOffset = 0): void {
    for (let basisIndex = 0; basisIndex < this.primaryBasisCount; basisIndex++) {
      const offset = basisIndex * DOFS;
      let projection = 0;
      for (let i = 0; i < DOFS; i++)
        projection += this.rowBasis[offset + i] * vector[vectorOffset + i];
      for (let i = 0; i < DOFS; i++)
        vector[vectorOffset + i] -= this.rowBasis[offset + i] * projection;
    }
  }

  private writeHierarchyCandidate(
    state: PathState,
    context: ArmForwardContext,
    bounds: ResolvedBounds,
    alpha: number,
    secondary: boolean,
  ): boolean {
    if (!this.writeBoundedTrial(state.q, this.primaryDelta, alpha, bounds)) return false;
    this.candidate.q.set(this.trialQ);
    if (!secondary) return true;
    const primary = this.probeMinus;
    const hierarchical = this.probePlus;
    primary.q.set(this.trialQ);
    if (!this.evaluateGeometry(primary, context, bounds)) return false;
    if (this.writeBoundedTrial(state.q, this.qpDelta, alpha, bounds)) {
      hierarchical.q.set(this.trialQ);
      if (
        this.evaluateGeometry(hierarchical, context, bounds) &&
        this.retractElbow(primary, hierarchical, context, bounds)
      )
        return true;
    }
    this.candidate.q.set(primary.q);
    return true;
  }

  /**
   * A differential nullspace step has second-order hand error. Retract its elbow
   * onto the two-link circle of the primary step's achieved wrist, then preserve
   * that step's achieved hand frame. The linear clearance rows guide the proposal;
   * actual endpoint and original-start sweep queries still decide acceptance.
   */
  private retractElbow(
    primary: PathState,
    hierarchical: PathState,
    context: ArmForwardContext,
    bounds: ResolvedBounds,
  ): boolean {
    const n = this.retractionNormal.subVectors(primary.forward.wrist, context.shoulder);
    const d = n.length();
    if (!(d > this.roundoffTolerance)) return false;
    n.multiplyScalar(1 / d);
    const center = this.retractionCenter
      .copy(context.shoulder)
      .addScaledVector(n, (context.upperLength ** 2 - context.lowerLength ** 2 + d * d) / (2 * d));
    const radius = primary.forward.elbow.distanceTo(center);
    if (!(radius > this.roundoffTolerance)) return false;
    const elbow = this.retractionElbow.subVectors(hierarchical.forward.elbow, center);
    elbow.addScaledVector(n, -elbow.dot(n));
    const projectedRadius = elbow.length();
    if (!(projectedRadius > this.roundoffTolerance)) return false;
    elbow.multiplyScalar(radius / projectedRadius).add(center);
    const directions = this.retractionDirections;
    directions.upperArm.subVectors(elbow, context.shoulder);
    directions.lowerArm.subVectors(primary.forward.wrist, elbow);
    directions.hand.copy(primary.forward.h);
    if (
      !configurationOfDirections(
        directions,
        this.requestHasPalm ? primary.forward.palm : null,
        this.calibration,
        context,
        hierarchical.configuration,
        this.candidate.configuration,
      )
    )
      return false;
    const configuration = this.candidate.configuration;
    const q = this.candidate.q;
    q[0] = configuration.shoulderPlane;
    q[1] = configuration.shoulderLift * Math.PI;
    q[2] = configuration.humeralRotation;
    // Fixed wrist distance and link lengths fix unsigned elbow flex exactly.
    // Reusing it avoids an acos round trip crossing an active bound by roundoff.
    q[3] = primary.q[3];
    q[4] = configuration.forearmRoll;
    q[5] = configuration.wristFlex;
    q[6] = configuration.wristDev;
    // Never clamp an inverse result: it would undo the hand-preserving retraction.
    if (!this.evaluateGeometry(this.candidate, context, bounds)) return false;
    const achieved = this.candidate.forward;
    if (
      achieved.wrist.distanceTo(primary.forward.wrist) > SETTLED_POSITION_FRACTION * this.span ||
      Math.acos(THREE.MathUtils.clamp(achieved.h.dot(primary.forward.h), -1, 1)) >
        SETTLED_ORIENTATION ||
      (this.requestHasPalm &&
        Math.acos(THREE.MathUtils.clamp(achieved.palm.dot(primary.forward.palm), -1, 1)) >
          SETTLED_ORIENTATION)
    )
      return false;
    this.measureState(primary);
    this.measureState(this.candidate);
    const tolerance = this.lexicalTolerance(primary.primaryError);
    return (
      this.candidate.primaryError <= primary.primaryError + tolerance &&
      this.candidate.secondaryError < primary.secondaryError - tolerance
    );
  }

  private better(candidate: PathState, current: PathState): boolean {
    const tolerance = this.lexicalTolerance(current.primaryError);
    if (candidate.maxViolation < current.maxViolation - this.roundoffTolerance) return true;
    if (candidate.maxViolation > current.maxViolation + this.roundoffTolerance) return false;
    if (candidate.primaryError < current.primaryError - tolerance) return true;
    if (candidate.primaryError > current.primaryError + tolerance) return false;
    // Below the tolerance but above settled is a band no step could leave.
    if (this.isPrimarySettled(candidate) && !this.isPrimarySettled(current)) return true;
    if (candidate.secondaryError < current.secondaryError - tolerance) return true;
    if (candidate.secondaryError > current.secondaryError + tolerance) return false;
    return (
      this.configurationDisplacement(candidate.q, this.startQ) <
      this.configurationDisplacement(current.q, this.startQ) - tolerance
    );
  }

  private improvesPenetration(candidate: PathState, current: PathState): boolean {
    if (candidate.maxViolation < current.maxViolation - this.roundoffTolerance) return true;
    if (candidate.maxViolation > current.maxViolation + this.roundoffTolerance) return false;
    const sumTolerance =
      64 *
      Number.EPSILON *
      Math.max(1, candidate.penetrationSquareSum, current.penetrationSquareSum);
    return candidate.penetrationSquareSum < current.penetrationSquareSum - sumTolerance;
  }

  private lexicalTolerance(primary: number): number {
    return LEXICAL_EPSILON * Math.max(1, primary);
  }

  private configurationDisplacement(a: Float64Array, b: Float64Array): number {
    let result = 0;
    for (let i = 0; i < DOFS; i++) result += (a[i] - b[i]) ** 2;
    return result;
  }

  private isSettled(state: PathState): boolean {
    return (
      this.isPrimarySettled(state) &&
      (!this.requestHasElbow || state.secondaryError <= SETTLED_POSITION_FRACTION ** 2)
    );
  }

  private isPrimarySettled(state: PathState): boolean {
    return (
      state.positionError <= SETTLED_POSITION_FRACTION * this.span &&
      state.orientationError <= SETTLED_ORIENTATION
    );
  }

  /** Descent the damped GN model predicts for `step`: gᵀδ − ½δᵀHδ. */
  private predictedDescent(step: Float64Array): number {
    let result = 0;
    for (let i = 0; i < DOFS; i++) {
      let curvature = 0;
      for (let j = 0; j < DOFS; j++) curvature += this.hessian[i * DOFS + j] * step[j];
      result += step[i] * (this.rightHand[i] - 0.5 * curvature);
    }
    return result;
  }

  private stepNorm(step: Float64Array): number {
    let sum = 0;
    for (let i = 0; i < DOFS; i++) sum += step[i] * step[i];
    return Math.sqrt(sum);
  }

  private copyState(source: PathState, target: PathState): void {
    target.q.set(source.q);
    target.configuration.shoulderPlane = source.configuration.shoulderPlane;
    target.configuration.shoulderLift = source.configuration.shoulderLift;
    target.configuration.humeralRotation = source.configuration.humeralRotation;
    target.configuration.elbowFlex = source.configuration.elbowFlex;
    target.configuration.forearmRoll = source.configuration.forearmRoll;
    target.configuration.wristFlex = source.configuration.wristFlex;
    target.configuration.wristDev = source.configuration.wristDev;
    copyForward(source.forward, target.forward);
    for (let i = 0; i < source.points.length; i++)
      target.points[i].position.copy(source.points[i].position);
    for (let i = 0; i < source.clearances.length; i++) {
      const sourceRow = source.clearances[i];
      const targetRow = target.clearances[i];
      targetRow.key = sourceRow.key;
      targetRow.pointIndex = sourceRow.pointIndex;
      targetRow.valid = sourceRow.valid;
      targetRow.distance = sourceRow.distance;
      targetRow.normal.copy(sourceRow.normal);
    }
    target.primaryError = source.primaryError;
    target.secondaryError = source.secondaryError;
    target.positionError = source.positionError;
    target.orientationError = source.orientationError;
    target.maxViolation = source.maxViolation;
    target.penetrationSquareSum = source.penetrationSquareSum;
  }

  private copyToOutput(source: PathState, out: ArmPathPlanOutput, status: ArmPathStatus): void {
    out.q.set(source.q);
    configurationFromQ(out.q, out.configuration);
    copyForward(source.forward, out.forward);
    for (let i = 0; i < source.points.length; i++)
      out.points[i].position.copy(source.points[i].position);
    for (let i = 0; i < source.clearances.length; i++) {
      const sourceRow = source.clearances[i];
      const targetRow = out.clearances[i];
      targetRow.key = sourceRow.key;
      targetRow.pointIndex = sourceRow.pointIndex;
      targetRow.valid = sourceRow.valid;
      targetRow.distance = sourceRow.distance;
      targetRow.normal.copy(sourceRow.normal);
    }
    out.status = status;
    out.positionError = source.positionError;
    out.orientationError = source.orientationError;
    out.secondaryError = source.secondaryError;
    out.maxViolation = source.maxViolation;
    out.environmentBatches = this.environmentBatches;
  }
}

/** Allocate the reusable result object for a solver and a fixed environment row count. */
export function makeArmPathPlanOutput(
  _calibration: ArmCalibration,
  handGeometry: HandGeometryCalibration,
  rowCount: number,
): ArmPathPlanOutput {
  if (!Number.isInteger(rowCount) || rowCount < 0)
    throw new Error('row count must be a nonnegative integer');
  const points = proxyPoints(handGeometry);
  return {
    q: new Float64Array(DOFS),
    configuration: emptyConfiguration(),
    forward: makeArmForwardResult(),
    points,
    clearances: cloneRows(rowCount),
    status: 'blocked',
    positionError: Number.POSITIVE_INFINITY,
    orientationError: Number.POSITIVE_INFINITY,
    secondaryError: Number.POSITIVE_INFINITY,
    maxViolation: Number.POSITIVE_INFINITY,
    iterations: 0,
    environmentBatches: 0,
  };
}
