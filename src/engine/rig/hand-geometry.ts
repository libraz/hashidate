import * as THREE from 'three';
import { fingerCurl } from '../anatomy';
import type { FingerName, FingerSpec, JointSpec, JointTable, Profile, Side } from '../types';
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

const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];
const _pathMatrix = new THREE.Matrix4();
const _localMatrix = new THREE.Matrix4();
const _localQuaternion = new THREE.Quaternion();
const _rotationScratch = new THREE.Quaternion();
const _position = new THREE.Vector3();
const _tipDelta = new THREE.Vector3();

function cloneJointSpec(spec: JointSpec): JointSpec {
  return {
    label: { ...spec.label },
    dofs: Object.fromEntries(
      Object.entries(spec.dofs).map(([name, dof]) => [
        name,
        { label: { ...dof.label }, free: [...dof.free], max: [...dof.max] },
      ]),
    ),
    ...(spec.elevation
      ? { elevation: spec.elevation.map((row) => [...row] as [number, number, number]) }
      : {}),
  };
}

function cloneJointTable(table: JointTable): JointTable {
  return {
    shoulder: cloneJointSpec(table.shoulder) as JointTable['shoulder'],
    elbow: cloneJointSpec(table.elbow),
    wrist: cloneJointSpec(table.wrist),
    finger: cloneJointSpec(table.finger),
    thumb: cloneJointSpec(table.thumb),
    neck: cloneJointSpec(table.neck),
    spine: cloneJointSpec(table.spine),
  };
}

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
    for (const finger of FINGERS) {
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

  return { metricScale, joints: cloneJointTable(joints), points };
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

    _pathMatrix.identity();
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
      _pathMatrix.multiply(_localMatrix);
    }
    _position.setFromMatrixPosition(_pathMatrix).multiplyScalar(calibration.metricScale);
    output.position.copy(_position);
  }
  return out;
}
