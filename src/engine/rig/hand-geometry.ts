import * as THREE from 'three';
import { fingerCurl } from '../anatomy';
import type { FingerName, FingerSpec, HandContact, JointTable, Profile, Side } from '../types';
import { FINGER_NAMES } from '../types';
import { cloneJointTable } from './arm-configuration';
import { composeFingerRotation } from './hands';

/** The virtual fingertip carries this much of the final bone past the last joint. */
export const FINGER_TIP_EXTENSION = 0.75;

type FingerJointPath = {
  readonly position: THREE.Vector3;
  readonly rest: THREE.Quaternion;
  readonly scale: THREE.Vector3;
  readonly curlAxis?: THREE.Vector3;
  readonly splayAxis?: THREE.Vector3;
  readonly jointIndex?: number;
};

interface FingerPointPath {
  readonly finger: FingerName;
  readonly jointIndex: number;
  readonly tip: boolean;
  readonly nodes?: readonly FingerJointPath[];
  readonly previousPoint?: number;
  readonly lastPoint?: number;
}

/** Captured hand hierarchy in the hand bone's local coordinate frame. */
export interface HandGeometryCalibration {
  /** Absent on legacy collision-only calibrations; contacts require an explicit capture. */
  readonly handPresent?: boolean;
  readonly metricScale: number;
  readonly joints: JointTable;
  readonly points: readonly FingerPointPath[];
}

/** A point on one finger, with a stable identity across samples. */
export interface HandGeometryPoint {
  readonly finger: FingerName;
  readonly jointIndex: number;
  readonly tip: boolean;
  readonly position: THREE.Vector3;
}

/** Reusable result buffer; create once per calibration with makeHandGeometrySample. */
export interface HandGeometrySample {
  readonly points: HandGeometryPoint[];
}

const _pathMatrix = new THREE.Matrix4();
const _localMatrix = new THREE.Matrix4();
const _localQuaternion = new THREE.Quaternion();
const _rotationScratch = new THREE.Quaternion();
const _position = new THREE.Vector3();
const _tipDelta = new THREE.Vector3();

function pathFromHand(hand: THREE.Bone, target: THREE.Bone): THREE.Object3D[] | null {
  const path: THREE.Object3D[] = [];
  let node: THREE.Object3D | null = target;
  while (node && node !== hand) {
    path.unshift(node);
    node = node.parent;
  }
  return node === hand ? path : null;
}

/**
 * Capture the resolved hand hierarchy once, while the avatar is in its bind pose.
 * `metricScale` is the hand's uniform world scale: it is applied once to the
 * hand-bone-local points, so a .01 armature and a unit-scale armature agree in metres.
 */
export function captureHandGeometry(
  profile: Profile,
  side: Side,
  rest: ReadonlyMap<THREE.Bone, THREE.Quaternion>,
  axes: {
    axes: ReadonlyMap<THREE.Bone, THREE.Vector3>;
    splayAxes: ReadonlyMap<THREE.Bone, THREE.Vector3>;
  },
  joints: JointTable,
  metricScale: number,
): HandGeometryCalibration {
  const points: FingerPointPath[] = [];
  const hand = profile.bones[`hand.${side}`];

  if (hand) {
    for (const finger of FINGER_NAMES) {
      const chain = profile.fingerBones[`${finger}.${side}`];
      if (!chain?.length) continue;

      const fingerPointIndices: number[] = [];
      let valid = true;
      const chains = chain.map((bone) => pathFromHand(hand, bone));
      if (chains.some((path) => path === null)) valid = false;
      if (!valid) continue;

      for (let jointIndex = 0; jointIndex < chain.length; jointIndex++) {
        const path = chains[jointIndex] as THREE.Object3D[];
        const nodes = path.map((node): FingerJointPath => {
          const isBone = node instanceof THREE.Bone;
          const bone = isBone ? (node as THREE.Bone) : undefined;
          const index = bone ? chain.indexOf(bone) : -1;
          const curlAxis = bone ? axes.axes.get(bone) : undefined;
          const splayAxis = index === 0 && bone ? axes.splayAxes.get(bone) : undefined;
          return {
            position: node.position.clone(),
            rest: (bone ? (rest.get(bone) ?? bone.quaternion) : node.quaternion).clone(),
            scale: node.scale.clone(),
            ...(curlAxis ? { curlAxis: curlAxis.clone() } : {}),
            ...(splayAxis ? { splayAxis: splayAxis.clone() } : {}),
            ...(index >= 0 ? { jointIndex: index } : {}),
          };
        });
        fingerPointIndices.push(points.length);
        points.push({ finger, jointIndex, tip: false, nodes });
      }

      if (chain.length >= 2) {
        points.push({
          finger,
          jointIndex: chain.length - 1,
          tip: true,
          previousPoint: fingerPointIndices[chain.length - 2],
          lastPoint: fingerPointIndices[chain.length - 1],
        });
      }
    }
  }

  return { handPresent: !!hand, metricScale, joints: cloneJointTable(joints), points };
}

/** Create a result buffer with identities and vectors stable across every sample. */
export function makeHandGeometrySample(calibration: HandGeometryCalibration): HandGeometrySample {
  return {
    points: calibration.points.map(({ finger, jointIndex, tip }) => ({
      finger,
      jointIndex,
      tip,
      position: new THREE.Vector3(),
    })),
  };
}

/**
 * Evaluate finger joints and virtual tips from captured rest geometry only.
 * The sample never reads or writes the avatar's live bones or any pose history.
 */
export function sampleHandGeometry(
  calibration: HandGeometryCalibration,
  curls: FingerSpec,
  spread: FingerSpec,
  out: HandGeometrySample,
): HandGeometrySample {
  if (out.points.length !== calibration.points.length) {
    throw new Error('hand geometry sample buffer was created for a different calibration');
  }

  const { points } = calibration;
  for (let outputIndex = 0; outputIndex < points.length; outputIndex++) {
    const path = points[outputIndex];
    const output = out.points[outputIndex];
    if (
      output.finger !== path.finger ||
      output.jointIndex !== path.jointIndex ||
      output.tip !== path.tip
    ) {
      throw new Error('hand geometry sample buffer identities do not match the calibration');
    }

    if (path.tip) {
      const previous = out.points[path.previousPoint as number].position;
      const last = out.points[path.lastPoint as number].position;
      output.position
        .copy(last)
        .addScaledVector(_tipDelta.subVectors(last, previous), FINGER_TIP_EXTENSION);
      continue;
    }

    evaluateFingerPath(calibration, path, curls, spread, _pathMatrix);
    _position.setFromMatrixPosition(_pathMatrix).multiplyScalar(calibration.metricScale);
    output.position.copy(_position);
  }
  return out;
}

/** Compose the same captured hierarchy for collision points and contact landmarks. */
function evaluateFingerPath(
  calibration: HandGeometryCalibration,
  path: FingerPointPath,
  curls: FingerSpec,
  spread: FingerSpec,
  out: THREE.Matrix4,
): void {
  out.identity();
  for (const node of path.nodes ?? []) {
    const jointIndex = node.jointIndex;
    const amount = jointIndex === undefined ? 0 : (curls[path.finger] ?? 0);
    const nodeJoints = calibration.joints[path.finger === 'thumb' ? 'thumb' : 'finger'];
    if (node.curlAxis) {
      composeFingerRotation(
        _localQuaternion,
        node.rest,
        node.curlAxis,
        fingerCurl(nodeJoints, jointIndex as number, amount),
        node.splayAxis,
        jointIndex === 0 ? (spread[path.finger] ?? 0) : 0,
        _rotationScratch,
      );
    } else {
      _localQuaternion.copy(node.rest);
    }
    _localMatrix.compose(node.position, _localQuaternion, node.scale);
    out.multiply(_localMatrix);
  }
}

interface ContactSegment {
  readonly finger: FingerName;
  readonly segment: 0 | 1;
  readonly start: FingerPointPath;
  readonly end: FingerPointPath;
  readonly normal: THREE.Vector3 | null;
}

/** Captured contact geometry in metric hand-bone coordinates, without live bones. */
export interface HandContactCalibration {
  readonly geometry: HandGeometryCalibration;
  readonly palmNormal: THREE.Vector3 | null;
  readonly palmCenter: THREE.Vector3 | null;
  readonly segments: readonly ContactSegment[];
}

const _contactStart = new THREE.Matrix4();
const _contactEnd = new THREE.Matrix4();
const _contactLinear = new THREE.Matrix3();
const _contactPoint = new THREE.Vector3();
const _contactEndPoint = new THREE.Vector3();
const _contactNormal = new THREE.Vector3();
const _contactTangent = new THREE.Vector3();
const EMPTY_CONTROLS: FingerSpec = {};

function finiteVector(value: THREE.Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

/** Capture normals and palm landmarks from the existing bind hierarchy. */
export function captureHandContactGeometry(
  geometry: HandGeometryCalibration,
  palmLocal: THREE.Vector3,
): HandContactCalibration {
  const palmNormal =
    finiteVector(palmLocal) && palmLocal.lengthSq() > 0 ? palmLocal.clone().normalize() : null;
  const segments: ContactSegment[] = [];
  let palmCenter: THREE.Vector3 | null = geometry.handPresent === true ? new THREE.Vector3() : null;
  for (const finger of FINGER_NAMES) {
    const real = geometry.points.filter((point) => point.finger === finger && !point.tip);
    if (finger !== 'thumb' && palmCenter) {
      const mcp = real.find((point) => point.jointIndex === 0);
      if (!mcp) palmCenter = null;
      else {
        evaluateFingerPath(geometry, mcp, EMPTY_CONTROLS, EMPTY_CONTROLS, _contactStart);
        palmCenter.add(
          _contactPoint.setFromMatrixPosition(_contactStart).multiplyScalar(geometry.metricScale),
        );
      }
    }
    for (const segment of [0, 1] as const) {
      const start = real.find((point) => point.jointIndex === segment);
      const end = real.find((point) => point.jointIndex === segment + 1);
      if (!(start && end)) continue;
      evaluateFingerPath(geometry, start, EMPTY_CONTROLS, EMPTY_CONTROLS, _contactStart);
      evaluateFingerPath(geometry, end, EMPTY_CONTROLS, EMPTY_CONTROLS, _contactEnd);
      _contactTangent
        .setFromMatrixPosition(_contactEnd)
        .sub(_contactPoint.setFromMatrixPosition(_contactStart));
      let normal: THREE.Vector3 | null = null;
      _contactLinear.setFromMatrix4(_contactStart);
      if (
        palmNormal &&
        finiteVector(_contactTangent) &&
        _contactTangent.lengthSq() > 0 &&
        Number.isFinite(_contactLinear.determinant()) &&
        _contactLinear.determinant() !== 0
      ) {
        _contactTangent.normalize();
        _contactNormal
          .copy(palmNormal)
          .addScaledVector(_contactTangent, -palmNormal.dot(_contactTangent));
        if (finiteVector(_contactNormal) && _contactNormal.lengthSq() > 0) {
          // A normal is a covector: bind transpose stores it in the segment carrier.
          normal = _contactNormal.normalize().applyMatrix3(_contactLinear.transpose()).clone();
        }
      }
      segments.push({ finger, segment, start, end, normal });
    }
  }
  // Halfway from the hand origin to the mean of the four non-thumb MCPs.
  if (palmCenter) palmCenter.multiplyScalar(1 / 8);
  return { geometry, palmNormal, palmCenter, segments };
}

/** Evaluate a contact proxy, leaving out unchanged for unsupported or invalid selectors. */
export function sampleHandContact(
  calibration: HandContactCalibration,
  curls: FingerSpec,
  spread: FingerSpec,
  selector: HandContact,
  clearance: number,
  out: THREE.Vector3,
): boolean {
  const { geometry } = calibration;
  if (
    geometry.handPresent !== true ||
    !selector ||
    !Number.isFinite(geometry.metricScale) ||
    geometry.metricScale <= 0
  )
    return false;
  const surface = selector.surface ?? 'center';
  if (surface !== 'center' && surface !== 'pad' && surface !== 'back') return false;
  if (surface !== 'center' && (!Number.isFinite(clearance) || clearance < 0)) return false;
  if (selector.kind === 'palm') {
    if (selector.region === 'heel') _contactPoint.set(0, 0, 0);
    else if (selector.region === 'center' && calibration.palmCenter)
      _contactPoint.copy(calibration.palmCenter);
    else return false;
    if (surface !== 'center') {
      if (!calibration.palmNormal) return false;
      _contactNormal.copy(calibration.palmNormal);
    }
  } else if (selector.kind === 'finger') {
    if (!Number.isFinite(selector.fraction) || selector.fraction < 0 || selector.fraction > 1)
      return false;
    let segment: ContactSegment | undefined;
    for (const entry of calibration.segments) {
      if (entry.finger === selector.finger && entry.segment === selector.segment) {
        segment = entry;
        break;
      }
    }
    if (!segment) return false;
    evaluateFingerPath(geometry, segment.start, curls, spread, _contactStart);
    evaluateFingerPath(geometry, segment.end, curls, spread, _contactEnd);
    _contactPoint.setFromMatrixPosition(_contactStart);
    _contactEndPoint.setFromMatrixPosition(_contactEnd);
    _contactPoint.lerp(_contactEndPoint, selector.fraction).multiplyScalar(geometry.metricScale);
    if (surface !== 'center') {
      if (!segment.normal) return false;
      _contactLinear.setFromMatrix4(_contactStart);
      const determinant = _contactLinear.determinant();
      if (!Number.isFinite(determinant) || determinant === 0) return false;
      _contactNormal.copy(segment.normal).applyMatrix3(_contactLinear.invert().transpose());
      if (!finiteVector(_contactNormal) || _contactNormal.lengthSq() === 0) return false;
      _contactNormal.normalize();
    }
  } else return false;
  if (surface !== 'center')
    _contactPoint.addScaledVector(_contactNormal, surface === 'pad' ? clearance : -clearance);
  if (!finiteVector(_contactPoint)) return false;
  out.copy(_contactPoint);
  return true;
}
