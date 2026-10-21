import * as THREE from 'three';
import { humeralReference, lateralReference } from '../anatomy/arm-frame';
import { clampDof, elevationCeiling } from '../anatomy/strain';
import type { ElevationRow, JointSpec, JointTable, Side } from '../types';

/**
 * How the roll that turns the palm to face somewhere is split up the arm.
 *
 * Three joints turn a palm over, and only one of them is below the elbow.
 * Rotating the humerus about its own axis carries the whole limb round; the
 * radius crossing the ulna adds pronation; the wrist itself contributes nothing
 * at all — it has no axial degree of freedom, and what a rig puts on the hand
 * bone is pronation rendered in the wrong place, because the skeleton has no
 * twist bone to put it on.
 *
 * Spending them in that order matters, and getting it wrong is what this used to
 * do. Charging the whole roll to forearm and wrist gave a hand reaching for the
 * mouth 150 degrees of pronation against a limit of 80 — nearly twice the range
 * a forearm has, while the shoulder above it sat unrotated with its own range
 * untouched. Skin weighted across a joint twisted that far collapses to zero
 * volume, so it does not merely look wrong: the wrist disappears.
 *
 * The shoulder is asked first, then the forearm, and the wrist takes only the
 * share of the forearm's pronation that has to be rendered above the joint for
 * the twist to reach the hand.
 *
 * PRONATION_SPLIT is a rendering choice, not an anatomical one: both parts are
 * the same rotation, and the measurement reports their sum as pronation. A real
 * forearm twists progressively along its length, so the lower bone taking the
 * larger share is what looks right.
 */
export const PRONATION_SPLIT = 0.4; // of the total pronation, the share on the hand

interface BoneCalibrationInput {
  readonly axis: THREE.Vector3;
  readonly rest: THREE.Quaternion;
}

interface UpperCalibrationInput extends BoneCalibrationInput {
  readonly front: THREE.Vector3;
}

interface HandCalibrationInput extends BoneCalibrationInput {
  readonly palm: THREE.Vector3;
}

export interface ArmCalibrationInput {
  readonly upper: UpperCalibrationInput;
  readonly lower: BoneCalibrationInput;
  readonly hand: HandCalibrationInput;
  readonly radialSign: number;
  readonly joints: JointTable;
}

interface BoneCalibration {
  readonly axis: THREE.Vector3;
  readonly rest: THREE.Quaternion;
}

interface UpperCalibration extends BoneCalibration {
  readonly front: THREE.Vector3;
}

interface HandCalibration extends BoneCalibration {
  readonly palm: THREE.Vector3;
}

/** Rest geometry and hard joint ranges captured independently of a live rig. */
export interface ArmCalibration {
  readonly upper: UpperCalibration;
  readonly lower: BoneCalibration;
  readonly hand: HandCalibration;
  readonly radialSign: number;
  readonly joints: JointTable;
}

/** Anatomical angles for one arm; angles remain scalar and unwrapped. */
export interface ArmConfiguration {
  shoulderPlane: number;
  /** Fraction of the plane's own elevation ceiling; unbounded requests may exceed 1. */
  shoulderLift: number;
  humeralRotation: number;
  elbowFlex: number;
  /** Total pronation, split between forearm and hand rendering. */
  forearmRoll: number;
  wristFlex: number;
  wristDev: number;
}

export interface ArmDirections {
  readonly upperArm: THREE.Vector3;
  readonly lowerArm: THREE.Vector3;
  readonly hand: THREE.Vector3;
}

export interface ArmForwardContext {
  readonly side: Side;
  readonly shoulder: THREE.Vector3;
  readonly upperLength: number;
  readonly lowerLength: number;
  readonly up: THREE.Vector3;
  readonly right: THREE.Vector3;
  readonly forward: THREE.Vector3;
  /** World frame of the parent above the upper-arm bone. */
  readonly upperParentWorld: THREE.Quaternion;
}

interface ArmForwardScratch {
  readonly lateral: THREE.Vector3;
  readonly bend: THREE.Vector3;
  readonly ref: THREE.Vector3;
  readonly perp: THREE.Vector3;
  readonly currentAxis: THREE.Vector3;
  readonly currentFront: THREE.Vector3;
  readonly currentPalm: THREE.Vector3;
  readonly neutralPalm: THREE.Vector3;
  readonly radial: THREE.Vector3;
  readonly wristSwing: THREE.Vector3;
  readonly cross: THREE.Vector3;
  readonly upperRestWorld: THREE.Quaternion;
  readonly lowerRestWorld: THREE.Quaternion;
  readonly lowerNeutralWorld: THREE.Quaternion;
  readonly handRestWorld: THREE.Quaternion;
  readonly handNeutralWorld: THREE.Quaternion;
  readonly swing: THREE.Quaternion;
  readonly twist: THREE.Quaternion;
}

interface ArmInverseScratch {
  readonly u: THREE.Vector3;
  readonly l: THREE.Vector3;
  readonly h: THREE.Vector3;
  readonly lateral: THREE.Vector3;
  readonly bend: THREE.Vector3;
  readonly ref: THREE.Vector3;
  readonly perp: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly radial: THREE.Vector3;
  readonly swing: THREE.Vector3;
  readonly twist: THREE.Quaternion;
  readonly neutral: ArmForwardResult;
}

/** Directions, positions and bone rotations for one forward-kinematic pose. */
export interface ArmForwardResult {
  readonly u: THREE.Vector3;
  readonly l: THREE.Vector3;
  readonly h: THREE.Vector3;
  readonly palm: THREE.Vector3;
  readonly elbow: THREE.Vector3;
  readonly wrist: THREE.Vector3;
  readonly upperWorld: THREE.Quaternion;
  readonly lowerWorld: THREE.Quaternion;
  readonly handWorld: THREE.Quaternion;
  readonly upperLocal: THREE.Quaternion;
  readonly lowerLocal: THREE.Quaternion;
  readonly handLocal: THREE.Quaternion;
  /** @internal Reusable work buffers owned by this output object. */
  readonly _scratch: ArmForwardScratch;
}

const inverseScratch = new WeakMap<ArmConfiguration, ArmInverseScratch>();

function cloneSpec(spec: JointSpec): JointSpec {
  const dofs: JointSpec['dofs'] = {};
  for (const [name, dof] of Object.entries(spec.dofs)) {
    dofs[name] = {
      label: { ...dof.label },
      free: [...dof.free],
      max: [...dof.max],
    };
  }
  return {
    label: { ...spec.label },
    dofs,
    ...(spec.elevation ? { elevation: spec.elevation.map((row) => [...row] as ElevationRow) } : {}),
  };
}

/** Deep copy of a joint table, so a calibration cannot be changed through its source. */
export function cloneJointTable(table: JointTable): JointTable {
  return {
    shoulder: cloneSpec(table.shoulder) as JointTable['shoulder'],
    elbow: cloneSpec(table.elbow),
    wrist: cloneSpec(table.wrist),
    finger: cloneSpec(table.finger),
    thumb: cloneSpec(table.thumb),
    neck: cloneSpec(table.neck),
    spine: cloneSpec(table.spine),
  };
}

function validateWristInverseDomain(joints: JointTable): void {
  const flexion = joints.wrist.dofs.flexion.max;
  const deviation = joints.wrist.dofs.deviation.max;
  const maxFlexion = Math.max(Math.abs(flexion[0]), Math.abs(flexion[1]));
  const maxDeviation = Math.max(Math.abs(deviation[0]), Math.abs(deviation[1]));

  // The exact wrist inverse loses its palm-normal projection at 90 degrees.
  // Reject a hard-range rectangle that could reach that singular pose.
  if (Math.hypot(maxFlexion, maxDeviation) >= Math.PI / 2) {
    throw new Error('wrist hard ranges must stay inside a 90 degree combined bend');
  }
}

function unitAxis(axis: THREE.Vector3): THREE.Vector3 {
  if (axis.lengthSq() < 1e-12) throw new Error('arm calibration axis must be nonzero');
  return axis.normalize();
}

/** Copy all avatar-owned rest data so later bone edits cannot change this calibration. */
export function captureArmCalibration(input: ArmCalibrationInput): ArmCalibration {
  const upperAxis = unitAxis(input.upper.axis.clone());
  const upperFront = input.upper.front
    .clone()
    .addScaledVector(upperAxis, -input.upper.front.dot(upperAxis));
  if (upperFront.lengthSq() < 1e-12)
    throw new Error('upper humeral front must not parallel its axis');
  upperFront.normalize();

  const lowerAxis = unitAxis(input.lower.axis.clone());
  const handAxis = unitAxis(input.hand.axis.clone());
  const handPalm = input.hand.palm
    .clone()
    .addScaledVector(handAxis, -input.hand.palm.dot(handAxis));
  if (handPalm.lengthSq() < 1e-12) throw new Error('hand palm normal must not parallel its axis');
  handPalm.normalize();
  const joints = cloneJointTable(input.joints);
  validateWristInverseDomain(joints);

  return {
    upper: {
      axis: upperAxis,
      front: upperFront,
      rest: input.upper.rest.clone().normalize(),
    },
    lower: {
      axis: lowerAxis,
      rest: input.lower.rest.clone().normalize(),
    },
    hand: {
      axis: handAxis,
      palm: handPalm,
      rest: input.hand.rest.clone().normalize(),
    },
    radialSign: input.radialSign < 0 ? -1 : 1,
    joints,
  };
}

/** Allocate one reusable result and its scratch vectors/quaternions. */
export function makeArmForwardResult(): ArmForwardResult {
  return {
    u: new THREE.Vector3(),
    l: new THREE.Vector3(),
    h: new THREE.Vector3(),
    palm: new THREE.Vector3(),
    elbow: new THREE.Vector3(),
    wrist: new THREE.Vector3(),
    upperWorld: new THREE.Quaternion(),
    lowerWorld: new THREE.Quaternion(),
    handWorld: new THREE.Quaternion(),
    upperLocal: new THREE.Quaternion(),
    lowerLocal: new THREE.Quaternion(),
    handLocal: new THREE.Quaternion(),
    _scratch: {
      lateral: new THREE.Vector3(),
      bend: new THREE.Vector3(),
      ref: new THREE.Vector3(),
      perp: new THREE.Vector3(),
      currentAxis: new THREE.Vector3(),
      currentFront: new THREE.Vector3(),
      currentPalm: new THREE.Vector3(),
      neutralPalm: new THREE.Vector3(),
      radial: new THREE.Vector3(),
      wristSwing: new THREE.Vector3(),
      cross: new THREE.Vector3(),
      upperRestWorld: new THREE.Quaternion(),
      lowerRestWorld: new THREE.Quaternion(),
      lowerNeutralWorld: new THREE.Quaternion(),
      handRestWorld: new THREE.Quaternion(),
      handNeutralWorld: new THREE.Quaternion(),
      swing: new THREE.Quaternion(),
      twist: new THREE.Quaternion(),
    },
  };
}

function makeArmInverseScratch(): ArmInverseScratch {
  return {
    u: new THREE.Vector3(),
    l: new THREE.Vector3(),
    h: new THREE.Vector3(),
    lateral: new THREE.Vector3(),
    bend: new THREE.Vector3(),
    ref: new THREE.Vector3(),
    perp: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    radial: new THREE.Vector3(),
    swing: new THREE.Vector3(),
    twist: new THREE.Quaternion(),
    neutral: makeArmForwardResult(),
  };
}

function scratchFor(out: ArmConfiguration): ArmInverseScratch {
  let scratch = inverseScratch.get(out);
  if (!scratch) {
    scratch = makeArmInverseScratch();
    inverseScratch.set(out, scratch);
  }
  return scratch;
}

/** Build a calibrated local/world quaternion for a bone whose child axis is aimed. */
function aimWorld(
  restWorld: THREE.Quaternion,
  localAxis: THREE.Vector3,
  target: THREE.Vector3,
  currentAxis: THREE.Vector3,
  swing: THREE.Quaternion,
  out: THREE.Quaternion,
): THREE.Quaternion {
  currentAxis.copy(localAxis).applyQuaternion(restWorld).normalize();
  swing.setFromUnitVectors(currentAxis, target);
  return out.copy(swing).multiply(restWorld);
}

/** Match a calibrated local direction and front to the chosen humeral frame. */
function aimUpper(
  calibration: ArmCalibration,
  context: ArmForwardContext,
  u: THREE.Vector3,
  bend: THREE.Vector3,
  out: THREE.Quaternion,
  scratch: ArmForwardScratch,
): void {
  scratch.upperRestWorld.copy(context.upperParentWorld).multiply(calibration.upper.rest);
  aimWorld(
    scratch.upperRestWorld,
    calibration.upper.axis,
    u,
    scratch.currentAxis,
    scratch.swing,
    out,
  );
  scratch.currentFront.copy(calibration.upper.front).applyQuaternion(out);
  scratch.currentFront.addScaledVector(u, -scratch.currentFront.dot(u)).normalize();
  const angle = Math.atan2(
    scratch.cross.crossVectors(scratch.currentFront, bend).dot(u),
    scratch.currentFront.dot(bend),
  );
  scratch.twist.setFromAxisAngle(u, angle);
  out.premultiply(scratch.twist);
}

/** Shared zero-roll hand frame for forward poses and their direction inverse. */
function neutralHandFrame(
  calibration: ArmCalibration,
  context: ArmForwardContext,
  u: THREE.Vector3,
  l: THREE.Vector3,
  bend: THREE.Vector3,
  out: ArmForwardResult,
): void {
  const s = out._scratch;
  aimUpper(calibration, context, u, bend, out.upperWorld, s);
  s.lowerRestWorld.copy(out.upperWorld).multiply(calibration.lower.rest);
  aimWorld(
    s.lowerRestWorld,
    calibration.lower.axis,
    l,
    s.currentAxis,
    s.swing,
    s.lowerNeutralWorld,
  );
  s.handRestWorld.copy(s.lowerNeutralWorld).multiply(calibration.hand.rest);
  aimWorld(s.handRestWorld, calibration.hand.axis, l, s.currentAxis, s.swing, s.handNeutralWorld);
  s.neutralPalm.copy(calibration.hand.palm).applyQuaternion(s.handNeutralWorld);
  s.neutralPalm.addScaledVector(l, -s.neutralPalm.dot(l)).normalize();
}

/** Aim the hand to an axis and palm normal with a world-space roll about its axis. */
function aimHand(
  calibration: ArmCalibration,
  parentWorld: THREE.Quaternion,
  targetAxis: THREE.Vector3,
  targetPalm: THREE.Vector3,
  out: THREE.Quaternion,
  scratch: ArmForwardScratch,
): void {
  scratch.handRestWorld.copy(parentWorld).multiply(calibration.hand.rest);
  aimWorld(
    scratch.handRestWorld,
    calibration.hand.axis,
    targetAxis,
    scratch.currentAxis,
    scratch.swing,
    out,
  );

  scratch.currentPalm.copy(calibration.hand.palm).applyQuaternion(out);
  scratch.currentPalm.addScaledVector(targetAxis, -scratch.currentPalm.dot(targetAxis)).normalize();
  scratch.neutralPalm
    .copy(targetPalm)
    .addScaledVector(targetAxis, -targetPalm.dot(targetAxis))
    .normalize();
  const angle = Math.atan2(
    scratch.cross.crossVectors(scratch.currentPalm, scratch.neutralPalm).dot(targetAxis),
    scratch.currentPalm.dot(scratch.neutralPalm),
  );
  scratch.twist.setFromAxisAngle(targetAxis, angle);
  out.premultiply(scratch.twist);
}

/** Explicitly bound a requested configuration to the captured hard joint ranges. */
export function boundArmConfiguration(
  configuration: ArmConfiguration,
  calibration: ArmCalibration,
  out: ArmConfiguration,
): ArmConfiguration {
  out.shoulderPlane = configuration.shoulderPlane;
  out.shoulderLift = THREE.MathUtils.clamp(configuration.shoulderLift, 0, 1);
  out.humeralRotation = clampDof(
    configuration.humeralRotation,
    calibration.joints.shoulder.dofs.rotation,
  );
  out.elbowFlex = clampDof(configuration.elbowFlex, calibration.joints.elbow.dofs.flexion);
  out.forearmRoll = clampDof(configuration.forearmRoll, calibration.joints.elbow.dofs.rotation);
  out.wristFlex = clampDof(configuration.wristFlex, calibration.joints.wrist.dofs.flexion);
  out.wristDev = clampDof(configuration.wristDev, calibration.joints.wrist.dofs.deviation);
  return out;
}

/** Pure forward kinematics for one anatomically configured arm. */
export function forwardArm(
  configuration: ArmConfiguration,
  calibration: ArmCalibration,
  context: ArmForwardContext,
  out: ArmForwardResult,
): ArmForwardResult {
  const s = out._scratch;
  const plane = configuration.shoulderPlane;
  const theta =
    configuration.shoulderLift * elevationCeiling(plane, calibration.joints.shoulder.elevation).max;
  s.lateral.copy(context.right);
  if (context.side === 'L') s.lateral.negate();
  out.u
    .copy(context.up)
    .multiplyScalar(-Math.cos(theta))
    .addScaledVector(s.lateral, Math.sin(theta) * Math.cos(plane))
    .addScaledVector(context.forward, Math.sin(theta) * Math.sin(plane))
    .normalize();

  const humeralRotation = configuration.humeralRotation;
  const flex = configuration.elbowFlex;
  const ref = humeralReference(out.u, context.up, context.forward, s.ref);
  const perp = lateralReference(out.u, ref, context.up, context.forward, s.lateral, s.perp);
  s.bend
    .copy(ref)
    .multiplyScalar(Math.cos(humeralRotation))
    .addScaledVector(perp, Math.sin(humeralRotation))
    .normalize();
  out.l
    .copy(out.u)
    .multiplyScalar(Math.cos(flex))
    .addScaledVector(s.bend, Math.sin(flex))
    .normalize();

  neutralHandFrame(calibration, context, out.u, out.l, s.bend, out);
  out.upperLocal.copy(context.upperParentWorld).invert().multiply(out.upperWorld);

  const forearmRoll = configuration.forearmRoll;
  const wristFlex = configuration.wristFlex;
  const wristDev = configuration.wristDev;
  s.twist.setFromAxisAngle(out.l, forearmRoll);
  out.palm.copy(s.neutralPalm).applyQuaternion(s.twist).normalize();
  const wristAngle = Math.hypot(wristFlex, wristDev);
  if (wristAngle < 1e-12) {
    out.h.copy(out.l);
  } else {
    s.radial.crossVectors(out.palm, out.l).multiplyScalar(calibration.radialSign).normalize();
    s.wristSwing
      .copy(out.palm)
      .multiplyScalar(wristFlex / wristAngle)
      .addScaledVector(s.radial, wristDev / wristAngle);
    out.h
      .copy(out.l)
      .multiplyScalar(Math.cos(wristAngle))
      .addScaledVector(s.wristSwing, Math.sin(wristAngle))
      .normalize();
    out.palm
      .multiplyScalar(Math.cos(wristAngle))
      .addScaledVector(out.l, (-Math.sin(wristAngle) * wristFlex) / wristAngle)
      .normalize();
  }

  const carry = forearmRoll * (1 - PRONATION_SPLIT);
  out.lowerLocal.copy(out.upperWorld).invert().multiply(s.lowerNeutralWorld);
  s.twist.setFromAxisAngle(calibration.lower.axis, carry);
  out.lowerLocal.multiply(s.twist);
  out.lowerWorld.copy(out.upperWorld).multiply(out.lowerLocal);

  aimHand(calibration, out.lowerWorld, out.h, out.palm, out.handWorld, s);
  out.handLocal.copy(out.lowerWorld).invert().multiply(out.handWorld);

  out.elbow.copy(context.shoulder).addScaledVector(out.u, context.upperLength);
  out.wrist.copy(out.elbow).addScaledVector(out.l, context.lowerLength);
  return out;
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

function unitVector(value: THREE.Vector3 | null | undefined): value is THREE.Vector3 {
  return finiteVector(value) && Math.abs(value.lengthSq() - 1) < 1e-4;
}

function unitQuaternion(value: THREE.Quaternion | null | undefined): value is THREE.Quaternion {
  return (
    !!value &&
    typeof value.lengthSq === 'function' &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z) &&
    Number.isFinite(value.w) &&
    Math.abs(value.lengthSq() - 1) < 1e-4
  );
}

function finiteRange(
  value: readonly [number, number] | undefined,
): value is readonly [number, number] {
  return !!value && Number.isFinite(value[0]) && Number.isFinite(value[1]) && value[0] <= value[1];
}

function validContextFrame(context: ArmForwardContext | null | undefined): boolean {
  if (!context || (context.side !== 'L' && context.side !== 'R')) return false;
  if (
    !(
      unitVector(context.up) &&
      unitVector(context.right) &&
      unitVector(context.forward) &&
      unitQuaternion(context.upperParentWorld) &&
      finiteVector(context.shoulder) &&
      Number.isFinite(context.upperLength) &&
      Number.isFinite(context.lowerLength)
    ) ||
    context.upperLength <= 0 ||
    context.lowerLength <= 0
  ) {
    return false;
  }
  return (
    Math.abs(context.up.dot(context.right)) < 1e-4 &&
    Math.abs(context.up.dot(context.forward)) < 1e-4 &&
    Math.abs(context.right.dot(context.forward)) < 1e-4
  );
}

function validCalibrationFrame(calibration: ArmCalibration | null | undefined): boolean {
  if (!(calibration?.upper && calibration.lower && calibration.hand)) return false;
  if (
    !(
      unitVector(calibration.upper.axis) &&
      unitVector(calibration.upper.front) &&
      unitQuaternion(calibration.upper.rest) &&
      unitVector(calibration.lower.axis) &&
      unitQuaternion(calibration.lower.rest) &&
      unitVector(calibration.hand.axis) &&
      unitVector(calibration.hand.palm) &&
      unitQuaternion(calibration.hand.rest)
    ) ||
    Math.abs(calibration.upper.axis.dot(calibration.upper.front)) >= 1e-4 ||
    Math.abs(calibration.hand.axis.dot(calibration.hand.palm)) >= 1e-4 ||
    (calibration.radialSign !== -1 && calibration.radialSign !== 1)
  ) {
    return false;
  }
  const joints = calibration.joints;
  const shoulderRotation = joints?.shoulder?.dofs?.rotation?.max;
  const elbowFlexion = joints?.elbow?.dofs?.flexion?.max;
  const elbowRotation = joints?.elbow?.dofs?.rotation?.max;
  const wristFlexion = joints?.wrist?.dofs?.flexion?.max;
  const wristDeviation = joints?.wrist?.dofs?.deviation?.max;
  if (
    !joints?.shoulder?.elevation ||
    joints.shoulder.elevation.length < 2 ||
    !finiteRange(shoulderRotation) ||
    !finiteRange(elbowFlexion) ||
    !finiteRange(elbowRotation) ||
    !finiteRange(wristFlexion) ||
    !finiteRange(wristDeviation)
  ) {
    return false;
  }
  const rows = joints.shoulder.elevation;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!Array.isArray(row) || row.length !== 3 || !row.every(Number.isFinite)) return false;
    if (index > 0) {
      const previousRow = rows[index - 1];
      if (!previousRow || row[0] <= previousRow[0]) return false;
    }
  }
  const maxFlexion = Math.max(Math.abs(wristFlexion[0]), Math.abs(wristFlexion[1]));
  const maxDeviation = Math.max(Math.abs(wristDeviation[0]), Math.abs(wristDeviation[1]));
  return Math.hypot(maxFlexion, maxDeviation) < Math.PI / 2;
}

function unwrapNear(angle: number, reference: number): number {
  return reference + Math.atan2(Math.sin(angle - reference), Math.cos(angle - reference));
}

function nearestSupportedRoll(
  angle: number,
  previous: number | undefined,
  bounds: readonly [number, number],
): number {
  const turn = Math.PI * 2;
  const first = Math.ceil((bounds[0] - angle) / turn);
  const last = Math.floor((bounds[1] - angle) / turn);
  if (first > last) return angle;
  const target = previous !== undefined && Number.isFinite(previous) ? previous : 0;
  const nearest = Math.round((target - angle) / turn);
  return angle + THREE.MathUtils.clamp(nearest, first, last) * turn;
}

/**
 * Invert measured world directions into an unbounded anatomical request.
 * A true result means the geometry could be inverted, not that it is feasible.
 */
export function configurationOfDirections(
  directions: ArmDirections,
  palm: THREE.Vector3 | null,
  calibration: ArmCalibration,
  context: ArmForwardContext,
  previous: ArmConfiguration | null,
  out: ArmConfiguration,
): boolean {
  if (
    !(
      directions &&
      finiteVector(directions.upperArm) &&
      finiteVector(directions.lowerArm) &&
      finiteVector(directions.hand)
    ) ||
    directions.upperArm.lengthSq() < 1e-12 ||
    directions.lowerArm.lengthSq() < 1e-12 ||
    directions.hand.lengthSq() < 1e-12 ||
    (palm !== null && !finiteVector(palm)) ||
    !validCalibrationFrame(calibration) ||
    !validContextFrame(context) ||
    !out
  ) {
    return false;
  }

  const s = scratchFor(out);
  s.u.copy(directions.upperArm).normalize();
  s.l.copy(directions.lowerArm).normalize();
  s.h.copy(directions.hand).normalize();
  const previousPlane =
    previous && Number.isFinite(previous.shoulderPlane) ? previous.shoulderPlane : 0;
  const previousRotation =
    previous && Number.isFinite(previous.humeralRotation) ? previous.humeralRotation : 0;
  const previousRoll =
    previous && Number.isFinite(previous.forearmRoll) ? previous.forearmRoll : undefined;

  s.lateral.copy(context.right);
  if (context.side === 'L') s.lateral.negate();
  const theta = Math.acos(THREE.MathUtils.clamp(-s.u.dot(context.up), -1, 1));
  s.swing.copy(s.u).addScaledVector(context.up, -s.u.dot(context.up));
  const plane =
    s.swing.lengthSq() < 1e-10
      ? previousPlane
      : unwrapNear(Math.atan2(s.swing.dot(context.forward), s.swing.dot(s.lateral)), previousPlane);
  const ceiling = elevationCeiling(plane, calibration.joints.shoulder.elevation).max;
  if (!Number.isFinite(ceiling) || ceiling <= 0) return false;

  const elbowCos = THREE.MathUtils.clamp(s.u.dot(s.l), -1, 1);
  const elbowFlex = Math.acos(elbowCos);
  const bendLengthSq = s.bend.copy(s.l).addScaledVector(s.u, -elbowCos).lengthSq();
  const ref = humeralReference(s.u, context.up, context.forward, s.ref);
  const perp = lateralReference(s.u, ref, context.up, context.forward, s.lateral, s.perp);
  if (s.ref.lengthSq() < 1e-10 || s.perp.lengthSq() < 1e-10) return false;
  const humeralRotation =
    bendLengthSq < 1e-10
      ? previousRotation
      : Math.atan2(
          s.bend.dot(perp) / Math.sqrt(bendLengthSq),
          s.bend.dot(ref) / Math.sqrt(bendLengthSq),
        );
  s.bend
    .copy(ref)
    .multiplyScalar(Math.cos(humeralRotation))
    .addScaledVector(perp, Math.sin(humeralRotation))
    .normalize();

  const neutral = s.neutral;
  neutralHandFrame(calibration, context, s.u, s.l, s.bend, neutral);
  const neutralPalm = neutral._scratch.neutralPalm;
  if (neutralPalm.lengthSq() < 1e-10 || !finiteVector(neutralPalm)) return false;
  const wristCos = THREE.MathUtils.clamp(s.l.dot(s.h), -1, 1);
  const wristAngle = Math.acos(wristCos);

  let forearmRoll = previousRoll ?? 0;
  if (palm) {
    s.normal.copy(palm).addScaledVector(s.l, -palm.dot(s.l));
    if (s.normal.lengthSq() < 1e-10) return false;
    s.normal.normalize();
    if (wristCos < 0) s.normal.negate();
    const roll = Math.atan2(
      s.swing.crossVectors(neutralPalm, s.normal).dot(s.l),
      neutralPalm.dot(s.normal),
    );
    forearmRoll = nearestSupportedRoll(
      roll,
      previousRoll,
      calibration.joints.elbow.dofs.rotation.max,
    );
  } else {
    s.twist.setFromAxisAngle(s.l, forearmRoll);
    s.normal.copy(neutralPalm).applyQuaternion(s.twist).normalize();
  }

  s.swing.copy(s.h).addScaledVector(s.l, -wristCos);
  let wristFlex = 0;
  let wristDev = 0;
  if (wristAngle > 1e-4) {
    if (s.swing.lengthSq() < 1e-10) return false;
    s.swing.normalize();
    s.radial.crossVectors(s.normal, s.l).multiplyScalar(calibration.radialSign);
    if (s.radial.lengthSq() < 1e-10) return false;
    s.radial.normalize();
    wristFlex = wristAngle * s.swing.dot(s.normal);
    wristDev = wristAngle * s.swing.dot(s.radial);
  }

  out.shoulderPlane = plane;
  out.shoulderLift = theta / ceiling;
  out.humeralRotation = humeralRotation;
  out.elbowFlex = elbowFlex;
  out.forearmRoll = forearmRoll;
  out.wristFlex = wristFlex;
  out.wristDev = wristDev;
  return true;
}
