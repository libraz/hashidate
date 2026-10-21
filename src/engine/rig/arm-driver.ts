import * as THREE from 'three';
import type { ArmAnatomy } from '../anatomy/arm';
import type { FaceSurfaceSample } from '../anatomy/face';
import { TORSO_SAMPLES } from '../anatomy/joints';
import type { BodyClearance, BodyVolumeFrame } from '../anatomy/volumes';
import type { FingerName, FingerSpec, JointTable, Profile, Side } from '../types';
import {
  type ArmCalibration,
  type ArmConfiguration,
  type ArmForwardContext,
  type ArmForwardResult,
  boundArmConfiguration,
  captureArmCalibration,
  configurationOfDirections,
  forwardArm,
  makeArmForwardResult,
} from './arm-configuration';
import {
  type ArmPathBounds,
  type ArmPathClearance,
  type ArmPathEnvironment,
  type ArmPathPlanOutput,
  type ArmPathRequest,
  ArmStepSolver,
  configurationFromQ,
  configurationToQ,
  copyForward,
  makeArmPathPlanOutput,
} from './arm-path';
import { captureHandGeometry, type HandGeometryCalibration } from './hand-geometry';

const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];
export const FRAME_TOLERANCE = 1e-4;
/**
 * How fast the limiter's own correction may travel, in radians a second.
 *
 * The lowest value that leaves the movement alone, which is the only property
 * that matters: a cap has to be invisible to everything except a seam. Measured
 * over every gesture in the table, a link asks for more than ten radians a
 * second on one frame in a hundred and more than fifteen on one in five hundred,
 * while a seam asks for seventy and upward — the two do not overlap, and
 * fourteen sits in the gap. Played from rest at this cap, every entrance in the
 * table is unchanged to the last digit of its peak speed and its path length
 * except the two that were teleporting. At ten, half a dozen of them lose about
 * a tenth of their peak, which is the movement being damped rather than a jump
 * being caught.
 */
export const LIMIT_SLEW = 14;

const makeConfiguration = (): ArmConfiguration => ({
  shoulderPlane: 0,
  shoulderLift: 0,
  humeralRotation: 0,
  elbowFlex: 0,
  forearmRoll: 0,
  wristFlex: 0,
  wristDev: 0,
});

const makeSpec = (): Record<FingerName, number> => ({
  thumb: 0,
  index: 0,
  middle: 0,
  ring: 0,
  little: 0,
});

function copySpec(source: FingerSpec, target: Record<FingerName, number>): void {
  for (const finger of FINGERS) target[finger] = source[finger] ?? 0;
}

/** Return the common scale only when this affine world frame is a proper similarity. */
export function positiveConformalScale(matrix: THREE.Matrix4): number | null {
  const e = matrix.elements;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(e[i])) return null;
  if (
    Math.abs(e[3]) > FRAME_TOLERANCE ||
    Math.abs(e[7]) > FRAME_TOLERANCE ||
    Math.abs(e[11]) > FRAME_TOLERANCE ||
    Math.abs(e[15] - 1) > FRAME_TOLERANCE
  ) {
    return null;
  }

  const x2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
  const y2 = e[4] * e[4] + e[5] * e[5] + e[6] * e[6];
  const z2 = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
  const mean = (x2 + y2 + z2) / 3;
  if (!(Number.isFinite(mean) && mean > 1e-16)) return null;
  const tolerance = mean * FRAME_TOLERANCE;
  if (
    Math.abs(x2 - mean) > tolerance ||
    Math.abs(y2 - mean) > tolerance ||
    Math.abs(z2 - mean) > tolerance ||
    Math.abs(e[0] * e[4] + e[1] * e[5] + e[2] * e[6]) > tolerance ||
    Math.abs(e[0] * e[8] + e[1] * e[9] + e[2] * e[10]) > tolerance ||
    Math.abs(e[4] * e[8] + e[5] * e[9] + e[6] * e[10]) > tolerance
  ) {
    return null;
  }
  const determinant =
    e[0] * (e[5] * e[10] - e[9] * e[6]) -
    e[4] * (e[1] * e[10] - e[9] * e[2]) +
    e[8] * (e[1] * e[6] - e[5] * e[2]);
  return determinant > 0 ? Math.sqrt(mean) : null;
}

interface DriverInput {
  readonly profile: Profile;
  readonly side: Side;
  readonly joints: JointTable;
  readonly rest: ReadonlyMap<THREE.Bone, THREE.Quaternion>;
  readonly fingerAxes: ReadonlyMap<THREE.Bone, THREE.Vector3>;
  readonly fingerSplayAxes: ReadonlyMap<THREE.Bone, THREE.Vector3>;
  readonly palmLocal: THREE.Vector3;
  readonly radialSign: number;
  readonly humeralFront: THREE.Vector3;
  readonly anatomy: ArmAnatomy;
  readonly fingerClearance: number;
}

interface MutableArmPathRequest {
  wrist: THREE.Vector3;
  hand: THREE.Vector3;
  palm: THREE.Vector3 | null;
  curls: FingerSpec;
  spread: FingerSpec;
  elbow: THREE.Vector3;
}

export interface ArmDriverAcceptedSnapshot {
  readonly q: Float64Array;
  readonly configuration: ArmConfiguration;
  readonly curls: Record<FingerName, number>;
  readonly spread: Record<FingerName, number>;
  readonly forward: ArmForwardResult;
  readonly rollHistory: number;
}

/** Per-side adapter joining the stateless FK and collision solver to a rig. */
export class ArmDriver {
  readonly calibration: ArmCalibration;
  readonly handGeometry: HandGeometryCalibration;
  readonly solver: ArmStepSolver;
  readonly output: ArmPathPlanOutput;
  readonly bridgeOutput: ArmPathPlanOutput;
  readonly environment: ArmPathEnvironment;
  readonly acceptedQ = new Float64Array(7);
  readonly startQ = new Float64Array(7);
  readonly targetQ = new Float64Array(7);
  readonly lowerBounds = new Float64Array(7);
  readonly upperBounds = new Float64Array(7);
  readonly bounds: ArmPathBounds;
  readonly bridgeLowerBounds = new Float64Array(7);
  readonly bridgeUpperBounds = new Float64Array(7);
  readonly bridgeBounds: ArmPathBounds;
  readonly sweepResolution: number;
  readonly acceptedConfiguration = makeConfiguration();
  readonly targetConfiguration = makeConfiguration();
  readonly acceptedCurls = makeSpec();
  readonly acceptedSpread = makeSpec();
  readonly proposedCurls = makeSpec();
  readonly proposedSpread = makeSpec();
  readonly acceptedForward = makeArmForwardResult();
  readonly targetForward = makeArmForwardResult();
  readonly neutralForward = makeArmForwardResult();
  readonly request: MutableArmPathRequest;
  readonly volumeFrame: BodyVolumeFrame = { torso: null, head: null };

  private readonly side: Side;
  private readonly profile: Profile;
  private readonly anatomy: ArmAnatomy;
  private readonly fingerClearance: number;
  private readonly pointsPerSample: number;
  private readonly clearancePointIds: string[];
  private readonly clearanceKeys: string[];
  private readonly requestWrist = new THREE.Vector3();
  private readonly requestElbow = new THREE.Vector3();
  private readonly requestHand = new THREE.Vector3();
  private readonly requestUpper = new THREE.Vector3();
  private readonly requestLower = new THREE.Vector3();
  private readonly requestPalm = new THREE.Vector3();
  private readonly neutralConfiguration = makeConfiguration();
  private readonly neutralDirections = {
    upperArm: new THREE.Vector3(),
    lowerArm: new THREE.Vector3(),
    hand: new THREE.Vector3(),
  };
  private readonly neutralPalm = new THREE.Vector3();
  private readonly projectedPalm = new THREE.Vector3();
  private readonly rollAxis = new THREE.Vector3();
  private readonly validationWrist = new THREE.Vector3();
  private readonly validationHand = new THREE.Vector3();
  private readonly validationElbow = new THREE.Vector3();
  private readonly validationPalm = new THREE.Vector3();
  private readonly validationCurls = makeSpec();
  private readonly validationSpread = makeSpec();
  private readonly validationRequest: MutableArmPathRequest;
  private readonly bodyRows: BodyClearance[] = [
    {
      surface: 'torso',
      valid: false,
      distance: Number.POSITIVE_INFINITY,
      normal: new THREE.Vector3(),
    },
    {
      surface: 'head',
      valid: false,
      distance: Number.POSITIVE_INFINITY,
      normal: new THREE.Vector3(),
    },
  ];
  private readonly faceSample: FaceSurfaceSample = {
    distance: 0,
    normal: new THREE.Vector3(),
    valid: false,
  };
  private rollHeld = 0;
  private readonly bridgeStartQ = new Float64Array(7);

  private constructor(
    input: DriverInput,
    calibration: ArmCalibration,
    handGeometry: HandGeometryCalibration,
  ) {
    this.side = input.side;
    this.profile = input.profile;
    this.anatomy = input.anatomy;
    this.fingerClearance = input.fingerClearance;
    this.sweepResolution = input.fingerClearance / 4;
    this.calibration = calibration;
    this.handGeometry = handGeometry;
    this.pointsPerSample = handGeometry.points.length + 3 * TORSO_SAMPLES + 1;
    const rowCount = this.pointsPerSample * 3;
    this.solver = new ArmStepSolver(
      calibration,
      handGeometry,
      input.profile.limb?.[`tip.${input.side}.middle`] ?? 0,
      this.sweepResolution,
    );
    this.output = makeArmPathPlanOutput(calibration, handGeometry, rowCount);
    this.bridgeOutput = makeArmPathPlanOutput(calibration, handGeometry, rowCount);
    this.clearancePointIds = this.output.points.map((point) => point.id);
    this.clearanceKeys = this.clearancePointIds.flatMap((id) => [
      `${id}:torso`,
      `${id}:head`,
      `${id}:face`,
    ]);
    this.bounds = { lower: this.lowerBounds, upper: this.upperBounds };
    this.bridgeBounds = { lower: this.bridgeLowerBounds, upper: this.bridgeUpperBounds };
    this.request = {
      wrist: this.requestWrist,
      hand: this.requestHand,
      palm: null,
      curls: this.acceptedCurls,
      spread: this.acceptedSpread,
      elbow: this.requestElbow,
    };
    this.validationRequest = {
      wrist: this.validationWrist,
      hand: this.validationHand,
      palm: null,
      curls: this.validationCurls,
      spread: this.validationSpread,
      elbow: this.validationElbow,
    };
    this.environment = {
      rowCount,
      sample: (points, rows) => this.sampleEnvironment(points, rows),
    };
  }

  get requestRollHistory(): number {
    return this.rollHeld;
  }

  set requestRollHistory(value: number) {
    this.rollHeld = value;
  }

  captureAcceptedState(): ArmDriverAcceptedSnapshot {
    const forward = makeArmForwardResult();
    copyForward(this.acceptedForward, forward);
    return {
      q: this.acceptedQ.slice(),
      configuration: { ...this.acceptedConfiguration },
      curls: { ...this.acceptedCurls },
      spread: { ...this.acceptedSpread },
      forward,
      rollHistory: this.rollHeld,
    };
  }

  restoreAcceptedState(snapshot: ArmDriverAcceptedSnapshot): void {
    this.acceptedQ.set(snapshot.q);
    Object.assign(this.acceptedConfiguration, snapshot.configuration);
    copyForward(snapshot.forward, this.acceptedForward);
    copySpec(snapshot.curls, this.acceptedCurls);
    copySpec(snapshot.spread, this.acceptedSpread);
    this.rollHeld = snapshot.rollHistory;
  }

  /** Return null for rigs the calibrated rotational model cannot represent. */
  static create(input: DriverInput): ArmDriver | null {
    const { profile, side } = input;
    const upper = profile.bones[`upperArm.${side}`];
    const lower = profile.bones[`lowerArm.${side}`];
    const hand = profile.bones[`hand.${side}`];
    const upperLength = profile.limb?.[`upper.${side}`];
    const lowerLength = profile.limb?.[`lower.${side}`];
    const handLength = profile.limb?.[`tip.${side}.middle`];
    if (
      !(
        upper &&
        lower &&
        hand &&
        upperLength &&
        lowerLength &&
        handLength &&
        input.palmLocal &&
        input.humeralFront &&
        input.fingerClearance > 0
      )
    ) {
      return null;
    }

    profile.root.updateWorldMatrix(true, true);
    upper.updateWorldMatrix(true, false);
    lower.updateWorldMatrix(true, false);
    hand.updateWorldMatrix(true, false);
    if (![upper, lower, hand].every((bone) => positiveConformalScale(bone.matrixWorld) !== null))
      return null;
    const parent = upper.parent;
    if (!parent) return null;
    parent.updateWorldMatrix(true, false);
    const parentWorld = parent.getWorldQuaternion(new THREE.Quaternion());
    const upperWorld = upper.getWorldQuaternion(new THREE.Quaternion());
    const lowerWorld = lower.getWorldQuaternion(new THREE.Quaternion());
    const handWorld = hand.getWorldQuaternion(new THREE.Quaternion());
    const calibrationInput = {
      upper: {
        axis: profile.restDir[`upperArm.${side}`],
        front: input.humeralFront,
        rest: parentWorld.invert().multiply(upperWorld),
      },
      lower: {
        axis: profile.restDir[`lowerArm.${side}`],
        rest: upperWorld.invert().multiply(lowerWorld),
      },
      hand: {
        axis: profile.restDir[`hand.${side}`],
        palm: input.palmLocal,
        rest: lowerWorld.invert().multiply(handWorld),
      },
      radialSign: input.radialSign,
      joints: input.joints,
    };

    try {
      const calibration = captureArmCalibration(calibrationInput);
      const geometry = captureHandGeometry(
        profile,
        side,
        input.rest,
        { axes: input.fingerAxes, splayAxes: input.fingerSplayAxes },
        input.joints,
        hand.getWorldScale(new THREE.Vector3()).x,
      );
      return new ArmDriver(input, calibration, geometry);
    } catch {
      return null;
    }
  }

  seedFromPose(
    context: ArmForwardContext,
    upperArm: THREE.Vector3,
    lowerArm: THREE.Vector3,
    hand: THREE.Vector3,
    palm: THREE.Vector3,
  ): boolean {
    if (
      !configurationOfDirections(
        { upperArm, lowerArm, hand },
        palm,
        this.calibration,
        context,
        null,
        this.acceptedConfiguration,
      )
    ) {
      return false;
    }
    configurationToQ(this.acceptedConfiguration, this.acceptedQ);
    this.rollHeld = this.acceptedConfiguration.forearmRoll;
    forwardArm(this.acceptedConfiguration, this.calibration, context, this.acceptedForward);
    return true;
  }

  /** Bound an inverse pose explicitly before using it as a constrained seed. */
  boundConfiguration(
    configuration: ArmConfiguration,
    out: ArmConfiguration = this.targetConfiguration,
  ): ArmConfiguration {
    return boundArmConfiguration(configuration, this.calibration, out);
  }

  /** Encode one configuration in the solver's stable seven-value order. */
  configurationToQ(configuration: ArmConfiguration, out: Float64Array): Float64Array {
    configurationToQ(configuration, out);
    return out;
  }

  configurationFromPose(
    context: ArmForwardContext,
    upperArm: THREE.Vector3,
    lowerArm: THREE.Vector3,
    hand: THREE.Vector3,
    palm: THREE.Vector3 | null,
  ): boolean {
    if (
      !configurationOfDirections(
        { upperArm, lowerArm, hand },
        palm,
        this.calibration,
        context,
        this.acceptedConfiguration,
        this.targetConfiguration,
      )
    ) {
      return false;
    }
    configurationToQ(this.targetConfiguration, this.targetQ);
    return true;
  }

  /** Capture one fixed candidate body frame before the solver samples it. */
  captureVolumeFrame(): void {
    this.anatomy.captureVolumeFrame(this.volumeFrame);
    this.anatomy.face?.refresh();
  }

  /** Compose one canonical arm request from the followed arm channels. */
  composeRequest(
    context: ArmForwardContext,
    upper: THREE.Vector3,
    lower: THREE.Vector3,
    hand: THREE.Vector3,
    palmTarget: THREE.Vector3 | null,
    palmWeight: number,
    twist: number,
    curls: FingerSpec,
    spread: FingerSpec,
    advanceRoll = true,
  ): ArmPathRequest {
    // Normalised once, and only these copies are used below: the link
    // lengths, the palm projections and the roll axis all assume unit vectors.
    upper = this.requestUpper.copy(upper).normalize();
    lower = this.requestLower.copy(lower).normalize();
    hand = this.requestHand.copy(hand).normalize();
    this.requestElbow.copy(context.shoulder).addScaledVector(upper, context.upperLength);
    this.requestWrist.copy(this.requestElbow).addScaledVector(lower, context.lowerLength);
    copySpec(curls, this.proposedCurls);
    copySpec(spread, this.proposedSpread);

    // Build a neutral palm by solving the requested links with the hand aligned
    // to the forearm, then use the same palm-normal projection as anatomical FK.
    this.neutralDirections.upperArm.copy(upper);
    this.neutralDirections.lowerArm.copy(lower);
    this.neutralDirections.hand.copy(lower);
    this.neutralPalm.set(0, 0, 0);
    if (
      configurationOfDirections(
        this.neutralDirections,
        null,
        this.calibration,
        context,
        null,
        this.neutralConfiguration,
      )
    ) {
      forwardArm(this.neutralConfiguration, this.calibration, context, this.neutralForward);
      // cos(theta) * N - sin(theta) * (wristFlex / theta) * L, with N perpendicular to L.
      this.neutralPalm
        .copy(this.neutralForward.palm)
        .multiplyScalar(lower.dot(hand))
        .addScaledVector(lower, -this.neutralForward.palm.dot(hand))
        .normalize();
      this.neutralPalm.addScaledVector(hand, -this.neutralPalm.dot(hand));
      if (this.neutralPalm.lengthSq() > 1e-12) this.neutralPalm.normalize();
    }

    let requestedPalm: THREE.Vector3 | null = null;
    if (this.neutralPalm.lengthSq() > 1e-12) {
      if (palmTarget && palmWeight > 1e-3) {
        this.projectedPalm.copy(palmTarget).addScaledVector(hand, -palmTarget.dot(hand));
        if (this.projectedPalm.lengthSq() > 1e-12) {
          this.projectedPalm.normalize();
          const raw = Math.atan2(
            this.rollAxis.crossVectors(this.neutralPalm, this.projectedPalm).dot(hand),
            this.neutralPalm.dot(this.projectedPalm),
          );
          const roll =
            this.rollHeld +
            Math.atan2(Math.sin(raw - this.rollHeld), Math.cos(raw - this.rollHeld));
          if (advanceRoll) this.rollHeld = roll;
          this.requestPalm
            .copy(this.neutralPalm)
            .applyAxisAngle(hand, roll * palmWeight)
            .normalize();
          requestedPalm = this.requestPalm;
        }
      } else if (twist !== 0) {
        if (advanceRoll) this.rollHeld = twist;
        this.requestPalm.copy(this.neutralPalm).applyAxisAngle(hand, twist).normalize();
        requestedPalm = this.requestPalm;
      }
    }
    this.request.palm = requestedPalm;
    this.request.curls = this.proposedCurls;
    this.request.spread = this.proposedSpread;
    return this.request;
  }

  requestForConfiguration(
    configuration: ArmConfiguration,
    context: ArmForwardContext,
    curls: FingerSpec,
    spread: FingerSpec,
  ): ArmPathRequest {
    forwardArm(configuration, this.calibration, context, this.targetForward);
    this.requestWrist.copy(this.targetForward.wrist);
    this.requestHand.copy(this.targetForward.h);
    this.requestElbow.copy(this.targetForward.elbow);
    this.request.palm = this.targetForward.palm;
    copySpec(curls, this.proposedCurls);
    copySpec(spread, this.proposedSpread);
    this.request.curls = this.proposedCurls;
    this.request.spread = this.proposedSpread;
    return this.request;
  }

  /** Check one fixed q and finger sample without allowing the solver to move it. */
  validateLockedPose(
    q: Float64Array,
    context: ArmForwardContext,
    curls: FingerSpec,
    spread: FingerSpec,
    out: ArmPathPlanOutput = this.bridgeOutput,
  ): boolean {
    if (q.length !== this.bridgeStartQ.length) return false;
    this.bridgeStartQ.set(q);
    for (let i = 0; i < q.length; i++) {
      this.bridgeLowerBounds[i] = q[i];
      this.bridgeUpperBounds[i] = q[i];
    }
    this.validationWrist.copy(this.request.wrist);
    this.validationHand.copy(this.request.hand);
    this.validationElbow.copy(this.request.elbow);
    this.validationRequest.palm = this.request.palm
      ? this.validationPalm.copy(this.request.palm)
      : null;
    copySpec(curls, this.validationCurls);
    copySpec(spread, this.validationSpread);
    return this.solver.restoreEndpoint(
      this.validationRequest,
      this.bridgeStartQ,
      context,
      this.bridgeBounds,
      this.environment,
      out,
    );
  }

  fillBounds(start: Float64Array, dt: number, temporal: boolean): ArmPathBounds {
    const step = temporal ? LIMIT_SLEW * Math.max(0, dt) : Number.POSITIVE_INFINITY;
    this.lowerBounds[0] = temporal ? start[0] - step : start[0] - Math.PI * 2;
    this.upperBounds[0] = temporal ? start[0] + step : start[0] + Math.PI * 2;
    this.lowerBounds[1] = temporal ? Math.max(0, start[1] - step) : 0;
    this.upperBounds[1] = temporal ? Math.min(Math.PI, start[1] + step) : Math.PI;
    const ranges = [
      this.calibration.joints.shoulder.dofs.rotation.max,
      this.calibration.joints.elbow.dofs.flexion.max,
      this.calibration.joints.elbow.dofs.rotation.max,
      this.calibration.joints.wrist.dofs.flexion.max,
      this.calibration.joints.wrist.dofs.deviation.max,
    ];
    for (let i = 0; i < ranges.length; i++) {
      const q = i + 2;
      this.lowerBounds[q] = temporal ? Math.max(ranges[i][0], start[q] - step) : ranges[i][0];
      this.upperBounds[q] = temporal ? Math.min(ranges[i][1], start[q] + step) : ranges[i][1];
    }
    return this.bounds;
  }

  planFrom(
    start: Float64Array,
    context: ArmForwardContext,
    dt: number,
    temporal: boolean,
  ): ArmPathPlanOutput {
    this.startQ.set(start);
    return this.solver.plan(
      this.request,
      this.startQ,
      context,
      this.fillBounds(this.startQ, dt, temporal),
      this.environment,
      this.output,
    );
  }

  restoreEndpointFrom(
    start: Float64Array,
    context: ArmForwardContext,
    dt: number,
    temporal: boolean,
  ): boolean {
    this.startQ.set(start);
    return this.solver.restoreEndpoint(
      this.request,
      this.startQ,
      context,
      this.fillBounds(this.startQ, dt, temporal),
      this.environment,
      this.output,
    );
  }

  /** Query every fixed row against the immutable torso/head frame and face. */
  sampleEnvironment(
    points: readonly { id: string; kind: string; position: THREE.Vector3 }[],
    out: ArmPathClearance[],
  ): void {
    if (out.length !== this.environment.rowCount)
      throw new Error('arm clearance row count changed');
    let cursor = 0;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const id = point.id;
      // Solver proxy identities stay fixed; direct callers may reorder or rename them.
      if (this.clearancePointIds[i] !== id) {
        this.clearancePointIds[i] = id;
        for (let surface = 0; surface < this.bodyRows.length; surface++) {
          this.clearanceKeys[cursor + surface] = `${id}:${this.bodyRows[surface].surface}`;
        }
        this.clearanceKeys[cursor + this.bodyRows.length] = `${id}:face`;
      }
      this.anatomy.sampleVolumeClearances(this.volumeFrame, point.position, this.bodyRows);
      for (const row of this.bodyRows) {
        const target = out[cursor];
        target.key = this.clearanceKeys[cursor++];
        target.pointIndex = i;
        target.valid = row.valid;
        target.distance = row.distance;
        target.normal.copy(row.normal);
      }
      const face = out[cursor];
      face.key = this.clearanceKeys[cursor++];
      face.pointIndex = i;
      face.valid = false;
      face.distance = Number.POSITIVE_INFINITY;
      face.normal.set(0, 0, 0);
      if (point.kind === 'finger' && this.anatomy.face) {
        this.anatomy.face.sample(point.position, this.faceSample);
        face.valid = this.faceSample.valid;
        face.distance = this.faceSample.distance - this.fingerClearance;
        face.normal.copy(this.faceSample.normal);
        if (this.faceSample.valid) {
          const head = out[cursor - 2];
          head.valid = false;
          head.distance = Number.POSITIVE_INFINITY;
          head.normal.set(0, 0, 0);
        }
      }
    }
    if (cursor !== out.length)
      throw new Error('arm clearance row count did not match proxy points');
  }

  accept(q: Float64Array, context: ArmForwardContext, curls: FingerSpec, spread: FingerSpec): void {
    // q must not alias the reusable solver output. Copy before any future solve.
    this.acceptedQ.set(q);
    configurationFromQ(this.acceptedQ, this.acceptedConfiguration);
    forwardArm(this.acceptedConfiguration, this.calibration, context, this.acceptedForward);
    copySpec(curls, this.acceptedCurls);
    copySpec(spread, this.acceptedSpread);
  }

  /** Rebuild the cached accepted FK in a refreshed external body context. */
  refreshAcceptedForward(context: ArmForwardContext): ArmForwardResult {
    forwardArm(this.acceptedConfiguration, this.calibration, context, this.acceptedForward);
    return this.acceptedForward;
  }
}
