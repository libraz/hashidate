import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { HAND_CONTACT, JOINTS } from '@/engine/anatomy';
import { TORSO_SAMPLES } from '@/engine/anatomy/joints';
import { elevationCeiling } from '@/engine/anatomy/strain';
import { buildProfile } from '@/engine/profile';
import { Rig, solveFingerAxes } from '@/engine/rig';
import * as armConfigurationModule from '@/engine/rig/arm-configuration';
import {
  type ArmConfiguration,
  type ArmForwardContext,
  captureArmCalibration,
  forwardArm,
  makeArmForwardResult,
} from '@/engine/rig/arm-configuration';
import {
  type ArmPathBounds,
  type ArmPathEnvironment,
  type ArmPathRequest,
  ArmStepSolver,
  makeArmPathPlanOutput,
} from '@/engine/rig/arm-path';
import { captureHandGeometry, type HandGeometryCalibration } from '@/engine/rig/hand-geometry';
import { buildRig } from '../helpers/scene';

const identity = new THREE.Quaternion();
const up = new THREE.Vector3(0, 1, 0);
const right = new THREE.Vector3(1, 0, 0);
const forward = new THREE.Vector3(0, 0, 1);

function fixture(side: 'L' | 'R' = 'R', yaw = 0, scale = 1) {
  const calibration = captureArmCalibration({
    upper: { axis: up, front: forward, rest: identity },
    lower: { axis: up, rest: identity },
    hand: { axis: up, palm: forward, rest: identity },
    radialSign: side === 'L' ? -1 : 1,
    joints: JOINTS,
  });
  const rotation = new THREE.Quaternion().setFromAxisAngle(up, yaw);
  const context: ArmForwardContext = {
    side,
    shoulder: new THREE.Vector3(0, 0, 0).applyQuaternion(rotation),
    upperLength: 0.31 * scale,
    lowerLength: 0.27 * scale,
    up: up.clone().applyQuaternion(rotation),
    right: right.clone().applyQuaternion(rotation),
    forward: forward.clone().applyQuaternion(rotation),
    upperParentWorld: rotation,
  };
  // No finger chains is a valid captured hand shape for the numeric kernel.
  const handGeometry = { metricScale: scale, joints: JOINTS, points: [] };
  const handLength = 0.1 * scale;
  const solver = new ArmStepSolver(calibration, handGeometry, handLength, 0.006 * scale);
  const output = makeArmPathPlanOutput(calibration, handGeometry, 0);
  return { calibration, context, handGeometry, handLength, solver, output };
}

function fingerFixture(scale = 1) {
  const h = fixture('R', 0, scale);
  const built = buildRig({ armatureScale: scale });
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const hand = profile.bones['hand.R'];
  if (!hand) throw new Error('missing synthetic right hand');
  const geometry: HandGeometryCalibration = captureHandGeometry(
    profile,
    'R',
    rig.rest,
    solveFingerAxes(profile),
    rig.joints,
    hand.getWorldScale(new THREE.Vector3()).x,
  );
  const solver = new ArmStepSolver(h.calibration, geometry, h.handLength, 0.006 * scale);
  return {
    ...h,
    handGeometry: geometry,
    solver,
    output: makeArmPathPlanOutput(h.calibration, geometry, 0),
  };
}

function neutralTraceFixture() {
  const calibration = {
    upper: {
      axis: new THREE.Vector3(1, 0, 0),
      front: new THREE.Vector3(0, 0, -1),
      rest: new THREE.Quaternion(0, 0, 0, 1),
    },
    lower: {
      axis: new THREE.Vector3(1, 0, 0),
      rest: new THREE.Quaternion(0, 0, 0, 1),
    },
    hand: {
      axis: new THREE.Vector3(1, 0, 0),
      palm: new THREE.Vector3(0, -1, 0),
      rest: new THREE.Quaternion(0, 0, 0, 1),
    },
    radialSign: -1,
    joints: JOINTS,
  };
  const context: ArmForwardContext = {
    side: 'R',
    shoulder: new THREE.Vector3(0.155901888668811, 1.1405163252064308, -0.006688540336977538),
    upperLength: 0.17,
    lowerLength: 0.14999999999999997,
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    forward: new THREE.Vector3(0, 0, -1),
    upperParentWorld: new THREE.Quaternion(
      4.377774469290759e-19,
      0.03068963967145867,
      -0.1329884385763209,
      0.9906423275945099,
    ),
  };
  const handGeometry = fingerFixture().handGeometry;
  const handLength = 0.1187500000000001;
  const solver = new ArmStepSolver(calibration, handGeometry, handLength, 0.0011250000000000001);
  const output = makeArmPathPlanOutput(calibration, handGeometry, 1);
  const start = new Float64Array([0, 1.615676221846179, 0, 0, 0, 0, 0]);
  const request: ArmPathRequest = {
    wrist: new THREE.Vector3(0.23258893762054733, 0.8375989149964106, -0.06958939001876399),
    hand: new THREE.Vector3(0.1302542439055869, -0.9618774934566418, -0.24046937336416044),
    palm: new THREE.Vector3(-0.8799221644217047, -0.22391718724853235, 0.419044243265706),
    curls: {
      thumb: 0.24745597271258368,
      index: 0.31225594371769966,
      middle: 0.3759045026355887,
      ring: 0.43840089115382835,
      little: 0.49974139671977874,
    },
    spread: {
      thumb: 0,
      index: -6.759174985994615e-10,
      middle: -3.1398130906790893e-10,
      ring: 8.305082845022316e-12,
      little: 3.189180344303935e-10,
    },
    elbow: new THREE.Vector3(0.2070761780500716, 0.9801702184784808, -0.03056987538156583),
  };
  const bound: ArmPathBounds = {
    lower: new Float64Array([
      -0.23333333333333334, 1.3823428885128457, -0.23333333333333334, 0, -0.23333333333333334,
      -0.23333333333333334, -0.23333333333333334,
    ]),
    upper: new Float64Array([
      0.23333333333333334, 1.8490095551795125, 0.23333333333333334, 0.23333333333333334,
      0.23333333333333334, 0.23333333333333334, 0.23333333333333334,
    ]),
  };
  return { calibration, context, handGeometry, handLength, solver, output, start, request, bound };
}

function configFrom(q: Float64Array): ArmConfiguration {
  return {
    shoulderPlane: q[0],
    shoulderLift: q[1] / Math.PI,
    humeralRotation: q[2],
    elbowFlex: q[3],
    forearmRoll: q[4],
    wristFlex: q[5],
    wristDev: q[6],
  };
}

function requestAt(
  calibration: ReturnType<typeof captureArmCalibration>,
  context: ArmForwardContext,
  q: Float64Array,
  _handLength: number,
): ArmPathRequest {
  const fk = forwardArm(configFrom(q), calibration, context, makeArmForwardResult());
  return {
    wrist: fk.wrist.clone(),
    hand: fk.h.clone(),
    palm: fk.palm.clone(),
    curls: {},
    spread: {},
  };
}

function bounds(): ArmPathBounds {
  return {
    lower: new Float64Array([
      -Math.PI,
      0,
      JOINTS.shoulder.dofs.rotation.max[0],
      JOINTS.elbow.dofs.flexion.max[0],
      JOINTS.elbow.dofs.rotation.max[0],
      JOINTS.wrist.dofs.flexion.max[0],
      JOINTS.wrist.dofs.deviation.max[0],
    ]),
    upper: new Float64Array([
      Math.PI,
      Math.PI,
      JOINTS.shoulder.dofs.rotation.max[1],
      JOINTS.elbow.dofs.flexion.max[1],
      JOINTS.elbow.dofs.rotation.max[1],
      JOINTS.wrist.dofs.flexion.max[1],
      JOINTS.wrist.dofs.deviation.max[1],
    ]),
  };
}

function freeEnvironment(): ArmPathEnvironment {
  return {
    rowCount: 0,
    sample: (_points, _rows) => {},
  };
}

function planeEnvironment(
  pointIndex: number,
  axis: THREE.Vector3,
  offset: number,
): ArmPathEnvironment {
  return {
    rowCount: 1,
    sample: (points, rows) => {
      const row = rows[0];
      row.key = 'plane';
      row.pointIndex = pointIndex;
      row.valid = true;
      row.distance = offset - points[pointIndex].position.dot(axis);
      row.normal.copy(axis).negate();
    },
  };
}

function outwardPlaneEnvironment(
  key: string,
  pointIndex: number,
  normal: THREE.Vector3,
  boundary: number,
): ArmPathEnvironment {
  return {
    rowCount: 1,
    sample: (points, rows) => {
      const row = rows[0];
      row.key = key;
      row.pointIndex = pointIndex;
      row.valid = true;
      row.distance = points[pointIndex].position.dot(normal) - boundary;
      row.normal.copy(normal);
    },
  };
}

function curledFingerCollisionFixture(surface: 'plane' | 'sphere' = 'plane') {
  const h = fingerFixture();
  const start = new Float64Array([0.1, 0.45, 0.1, 0.55, 0, 0, 0]);
  const curls = { index: 0.8 };
  const request = { ...requestAt(h.calibration, h.context, start, h.handLength), curls };
  const fingerId = 'finger.index.2.tip';
  h.solver.plan(request, start, h.context, bounds(), freeEnvironment(), h.output);
  const pointIndex = h.output.points.findIndex((point) => point.id === fingerId);
  if (pointIndex < 0) throw new Error(`missing ${fingerId}`);
  const curledPoint = h.output.points[pointIndex].position.clone();

  const openRequest = { ...request, curls: {} };
  h.solver.plan(openRequest, start, h.context, bounds(), freeEnvironment(), h.output);
  const openPoint = h.output.points[pointIndex].position.clone();

  const qPlus = new Float64Array(start);
  qPlus[0] += 0.25;
  const plusRequest = { ...requestAt(h.calibration, h.context, qPlus, h.handLength), curls };
  h.solver.plan(plusRequest, qPlus, h.context, bounds(), freeEnvironment(), h.output);
  const outward = h.output.points[pointIndex].position.clone().sub(curledPoint).normalize();
  const boundary = curledPoint.dot(outward) + 0.002;
  const center = curledPoint.clone().addScaledVector(outward, -0.05);
  const radius = 0.052;
  const environment: ArmPathEnvironment =
    surface === 'plane'
      ? outwardPlaneEnvironment('finger-plane', pointIndex, outward, boundary)
      : {
          rowCount: 1,
          sample: (points, rows) => {
            const row = rows[0];
            row.key = 'finger-sphere';
            row.pointIndex = pointIndex;
            row.valid = true;
            row.normal.copy(points[pointIndex].position).sub(center);
            row.distance = row.normal.length() - radius;
            row.normal.normalize();
          },
        };
  const restrictedBounds = bounds();
  for (let dof = 0; dof < 7; dof++) {
    restrictedBounds.lower[dof] = start[dof];
    restrictedBounds.upper[dof] = start[dof];
  }
  restrictedBounds.upper[0] = start[0] + 0.4;

  return {
    ...h,
    start,
    request,
    pointIndex,
    curledPoint,
    openPoint,
    outward,
    boundary,
    environment,
    restrictedBounds,
    output: makeArmPathPlanOutput(h.calibration, h.handGeometry, environment.rowCount),
  };
}

function enteringPlaneEnvironment(
  pointIndex: number,
  axis: THREE.Vector3,
  activation: number,
  offset: number,
): ArmPathEnvironment {
  return {
    rowCount: 1,
    sample: (points, rows) => {
      const row = rows[0];
      const coordinate = points[pointIndex].position.dot(axis);
      row.key = 'entering-plane';
      row.pointIndex = pointIndex;
      row.valid = coordinate >= activation;
      if (row.valid) {
        row.distance = offset - coordinate;
        row.normal.copy(axis).negate();
      } else {
        row.distance = Number.POSITIVE_INFINITY;
        row.normal.set(0, 0, 0);
      }
    },
  };
}

type ForwardFixture = Pick<ReturnType<typeof fixture>, 'calibration' | 'context' | 'handLength'>;

function primaryErrorAt(h: ForwardFixture, q: Float64Array, request: ArmPathRequest): number {
  const result = forwardArm(configFrom(q), h.calibration, h.context, makeArmForwardResult());
  const hand = request.hand.clone().normalize();
  const palm = request.palm?.clone().addScaledVector(hand, -request.palm.dot(hand)).normalize();
  const errors = [
    result.wrist.distanceTo(request.wrist),
    result.wrist
      .clone()
      .addScaledVector(result.h, h.handLength)
      .distanceTo(request.wrist.clone().addScaledVector(hand, h.handLength)),
  ];
  if (palm) {
    errors.push(
      result.wrist
        .clone()
        .addScaledVector(result.palm, h.handLength)
        .distanceTo(request.wrist.clone().addScaledVector(palm, h.handLength)),
    );
  }
  return Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0));
}

function firstHandProxy(h: ForwardFixture, q: Float64Array): THREE.Vector3 {
  const result = forwardArm(configFrom(q), h.calibration, h.context, makeArmForwardResult());
  return result.wrist
    .clone()
    .addScaledVector(result.h, (h.handLength * HAND_CONTACT) / TORSO_SAMPLES);
}

function boundedAround(q: Float64Array, halfWidth: number): ArmPathBounds {
  const full = bounds();
  return {
    lower: Float64Array.from(q, (value, index) => Math.max(full.lower[index], value - halfWidth)),
    upper: Float64Array.from(q, (value, index) => Math.min(full.upper[index], value + halfWidth)),
  };
}

function poleReturnQ(plane = -1.0605277708708791): Float64Array {
  return new Float64Array([
    plane,
    0,
    0.8775014769549042,
    0.6286143089887103,
    -1.3097985816478976,
    0.29435979269206314,
    0.004239725810632073,
  ]);
}

function poleReturnBounds(q: Float64Array, halfWidth = 14 / 60): ArmPathBounds {
  const result = boundedAround(q, halfWidth);
  result.lower[0] = q[0] - halfWidth;
  result.upper[0] = q[0] + halfWidth;
  return result;
}

function snapshotRequest(request: ArmPathRequest): unknown {
  return {
    wrist: request.wrist.toArray(),
    hand: request.hand.toArray(),
    palm: request.palm?.toArray() ?? null,
    curls: { ...request.curls },
    spread: { ...request.spread },
    elbow: request.elbow?.toArray() ?? null,
  };
}

function observeCertificates(solver: ArmStepSolver, output?: { iterations: number }) {
  // Forward calls unchanged: the observations distinguish a final certificate
  // rejection from an endpoint or QP rejection in the public geometric tests.
  const internal = solver as unknown as {
    current: { q: Float64Array };
    certifiedCheckpoint: { q: Float64Array };
    currentIsCertified: boolean;
    environmentBatches: number;
    reservedSweepCount: number;
    isSettled: (state: unknown) => boolean;
    certifyCurrent: (...args: unknown[]) => boolean;
  };
  const events: {
    attempted: number[];
    checkpoint: number[];
    returned: number[];
    certified: boolean;
    before: number;
    after: number;
    reserved: number;
    settled: boolean;
    iteration: number;
  }[] = [];
  const certify = internal.certifyCurrent.bind(internal);
  vi.spyOn(internal, 'certifyCurrent').mockImplementation((...args) => {
    const needed = !internal.currentIsCertified;
    const attempted = Array.from(internal.current.q);
    const checkpoint = Array.from(internal.certifiedCheckpoint.q);
    const before = internal.environmentBatches;
    const reserved = internal.reservedSweepCount;
    const settled = internal.isSettled(internal.current);
    const iteration = output?.iterations ?? 0;
    const certified = certify(...args);
    if (needed) {
      events.push({
        attempted,
        checkpoint,
        returned: Array.from(internal.current.q),
        certified,
        before,
        after: internal.environmentBatches,
        reserved,
        settled,
        iteration,
      });
    }
    return certified;
  });
  return events;
}

function observeHierarchy(solver: ArmStepSolver, output: { iterations: number }) {
  type State = {
    q: Float64Array;
    forward: ReturnType<typeof makeArmForwardResult>;
    primaryError: number;
    secondaryError: number;
  };
  const internal = solver as unknown as {
    candidate: State;
    retractElbow: (primary: State, hierarchical: State, ...args: unknown[]) => boolean;
    makeConstrainedStep: (...args: unknown[]) => boolean;
    evaluatePlanCandidate: (...args: unknown[]) => boolean;
  };
  const retractions: {
    accepted: boolean;
    primaryChange: number;
    elbowImprovement: number;
    wristMovement: number;
    handMovement: number;
    palmMovement: number;
  }[] = [];
  const qpCalls = new Map<number, number>();
  const candidates = new Map<number, number>();
  if (typeof internal.retractElbow === 'function') {
    const retract = internal.retractElbow.bind(internal);
    vi.spyOn(internal, 'retractElbow').mockImplementation((primary, hierarchical, ...args) => {
      const accepted = retract(primary, hierarchical, ...args);
      retractions.push({
        accepted,
        primaryChange: internal.candidate.primaryError - primary.primaryError,
        elbowImprovement: primary.secondaryError - internal.candidate.secondaryError,
        wristMovement: internal.candidate.forward.wrist.distanceTo(primary.forward.wrist),
        handMovement: internal.candidate.forward.h.distanceTo(primary.forward.h),
        palmMovement: internal.candidate.forward.palm.distanceTo(primary.forward.palm),
      });
      return accepted;
    });
  }
  for (const [method, counts] of [
    ['makeConstrainedStep', qpCalls],
    ['evaluatePlanCandidate', candidates],
  ] as const) {
    const original = internal[method].bind(internal);
    vi.spyOn(internal, method).mockImplementation((...args) => {
      counts.set(output.iterations, (counts.get(output.iterations) ?? 0) + 1);
      return original(...args);
    });
  }
  return { retractions, qpCalls, candidates };
}

describe('constrained arm path kernel', () => {
  it('makes bounded progress toward a feasible FK goal without mutating inputs', () => {
    const h = fixture();
    const start = new Float64Array([0, 0, 0, 0.2, 0, 0, 0]);
    const goal = new Float64Array([0.42, 0.64, 0.35, 0.82, 0.28, 0.22, -0.13]);
    const request = requestAt(h.calibration, h.context, goal, h.handLength);
    const targetBefore = snapshotRequest(request);
    const startBefore = Array.from(start);
    const bound = bounds();
    const boundBefore = [Array.from(bound.lower), Array.from(bound.upper)];
    const environment = freeEnvironment();

    const out = h.solver.plan(request, start, h.context, bound, environment, h.output);

    expect(['progress', 'settled']).toContain(out.status);
    expect(out.positionError).toBeLessThan(0.12);
    expect(out.iterations).toBeGreaterThan(0);
    expect(out.q).not.toEqual(start);
    expect(snapshotRequest(request)).toEqual(targetBefore);
    expect(Array.from(start)).toEqual(startBefore);
    expect([Array.from(bound.lower), Array.from(bound.upper)]).toEqual(boundBefore);
    for (let i = 0; i < 7; i++) expect(out.q[i]).toBeGreaterThanOrEqual(bound.lower[i]);
    for (let i = 0; i < 7; i++) expect(out.q[i]).toBeLessThanOrEqual(bound.upper[i]);
  });

  it('makes certified progress for the neutral 60 Hz target under exact 14/60 boxes', () => {
    const h = neutralTraceFixture();
    const startBefore = Array.from(h.start);
    const requestBefore = snapshotRequest(h.request);
    const boundsBefore = [Array.from(h.bound.lower), Array.from(h.bound.upper)];
    const contextBefore = [
      h.context.shoulder.toArray(),
      h.context.up.toArray(),
      h.context.right.toArray(),
      h.context.forward.toArray(),
      h.context.upperParentWorld.toArray(),
      h.context.upperLength,
      h.context.lowerLength,
    ];
    let batches = 0;
    const pointIndex = TORSO_SAMPLES * 2 + 1;
    const environment: ArmPathEnvironment = {
      rowCount: 1,
      sample: (points, rows) => {
        batches++;
        const row = rows[0];
        row.key = 'uniform-safe';
        row.pointIndex = pointIndex;
        row.valid = true;
        row.distance = points[pointIndex].position.y + 100;
        row.normal.set(0, 1, 0);
      },
    };
    const initialError = primaryErrorAt(h, h.start, h.request);

    const out = h.solver.plan(h.request, h.start, h.context, h.bound, environment, h.output);

    expect(['progress', 'settled']).toContain(out.status);
    expect(out.positionError).toBeLessThan(initialError);
    expect(out.q).not.toEqual(h.start);
    expect(out.environmentBatches).toBeLessThanOrEqual(96);
    expect(batches).toBe(out.environmentBatches);
    expect(snapshotRequest(h.request)).toEqual(requestBefore);
    expect(Array.from(h.start)).toEqual(startBefore);
    expect([Array.from(h.bound.lower), Array.from(h.bound.upper)]).toEqual(boundsBefore);
    expect([
      h.context.shoulder.toArray(),
      h.context.up.toArray(),
      h.context.right.toArray(),
      h.context.forward.toArray(),
      h.context.upperParentWorld.toArray(),
      h.context.upperLength,
      h.context.lowerLength,
    ]).toEqual(contextBefore);
    for (let dof = 0; dof < 7; dof++) {
      expect(out.q[dof]).toBeGreaterThanOrEqual(h.bound.lower[dof]);
      expect(out.q[dof]).toBeLessThanOrEqual(h.bound.upper[dof]);
    }
    const exact = forwardArm(configFrom(out.q), h.calibration, h.context, makeArmForwardResult());
    expect(out.forward.wrist.distanceTo(exact.wrist)).toBeLessThan(1e-12);
    expect(out.forward.elbow.distanceTo(exact.elbow)).toBeLessThan(1e-12);
    expect(out.forward.u.distanceTo(exact.u)).toBeLessThan(1e-12);
    expect(out.forward.l.distanceTo(exact.l)).toBeLessThan(1e-12);
    expect(out.forward.h.distanceTo(exact.h)).toBeLessThan(1e-12);
    expect(out.forward.palm.distanceTo(exact.palm)).toBeLessThan(1e-12);
    expect(1 - Math.abs(out.forward.upperWorld.dot(exact.upperWorld))).toBeLessThan(1e-14);
    expect(1 - Math.abs(out.forward.lowerWorld.dot(exact.lowerWorld))).toBeLessThan(1e-14);
    expect(1 - Math.abs(out.forward.handWorld.dot(exact.handWorld))).toBeLessThan(1e-14);
    for (let sample = 0; sample <= 4096; sample++) {
      const t = sample / 4096;
      for (let dof = 0; dof < 7; dof++) {
        const q = h.start[dof] + (out.q[dof] - h.start[dof]) * t;
        expect(q).toBeGreaterThanOrEqual(h.bound.lower[dof]);
        expect(q).toBeLessThanOrEqual(h.bound.upper[dof]);
      }
      const q = Float64Array.from(h.start, (value, dof) => value + (out.q[dof] - value) * t);
      expect(firstHandProxy(h, q).y + 100).toBeGreaterThanOrEqual(0);
    }
  });

  it('escapes a zero-lift pole before continuing toward the neutral target', () => {
    const h = neutralTraceFixture();
    const start = poleReturnQ();
    const limit = poleReturnBounds(start);
    const initialError = primaryErrorAt(h, start, h.request);
    let batches = 0;
    const pointIndex = TORSO_SAMPLES * 2 + 1;
    const environment: ArmPathEnvironment = {
      rowCount: 1,
      sample: (points, rows) => {
        batches++;
        const row = rows[0];
        row.key = 'uniform-safe';
        row.pointIndex = pointIndex;
        row.valid = true;
        row.distance = points[pointIndex].position.y + 100;
        row.normal.set(0, 1, 0);
      },
    };
    const requestBefore = snapshotRequest(h.request);
    const startBefore = Array.from(start);
    const boundsBefore = [Array.from(limit.lower), Array.from(limit.upper)];

    const out = h.solver.plan(h.request, start, h.context, limit, environment, h.output);

    expect(['progress', 'settled']).toContain(out.status);
    expect(out.q[1]).toBeGreaterThan(0);
    expect(out.positionError).toBeLessThan(initialError);
    expect(out.environmentBatches).toBeLessThanOrEqual(96);
    expect(batches).toBe(out.environmentBatches);
    expect(snapshotRequest(h.request)).toEqual(requestBefore);
    expect(Array.from(start)).toEqual(startBefore);
    expect([Array.from(limit.lower), Array.from(limit.upper)]).toEqual(boundsBefore);
    for (let dof = 0; dof < 7; dof++) {
      expect(out.q[dof]).toBeGreaterThanOrEqual(limit.lower[dof]);
      expect(out.q[dof]).toBeLessThanOrEqual(limit.upper[dof]);
    }
    const exact = forwardArm(configFrom(out.q), h.calibration, h.context, makeArmForwardResult());
    expect(out.forward.wrist.distanceTo(exact.wrist)).toBeLessThan(1e-12);
    expect(out.forward.elbow.distanceTo(exact.elbow)).toBeLessThan(1e-12);
    expect(out.forward.u.distanceTo(exact.u)).toBeLessThan(1e-12);
    expect(out.forward.l.distanceTo(exact.l)).toBeLessThan(1e-12);
    expect(out.forward.h.distanceTo(exact.h)).toBeLessThan(1e-12);
    expect(out.forward.palm.distanceTo(exact.palm)).toBeLessThan(1e-12);
    for (let sample = 0; sample <= 4096; sample++) {
      const t = sample / 4096;
      const q = Float64Array.from(start, (value, dof) => value + (out.q[dof] - value) * t);
      for (let dof = 0; dof < 7; dof++) {
        expect(q[dof]).toBeGreaterThanOrEqual(limit.lower[dof]);
        expect(q[dof]).toBeLessThanOrEqual(limit.upper[dof]);
      }
      const pathForward = forwardArm(
        configFrom(q),
        h.calibration,
        h.context,
        makeArmForwardResult(),
      );
      const sweptPoint = pathForward.wrist
        .clone()
        .addScaledVector(pathForward.h, (h.handLength * HAND_CONTACT) / TORSO_SAMPLES);
      expect(sweptPoint.y + 100).toBeGreaterThanOrEqual(0);
    }
  });

  it.each([
    ['R', -1.0605277708708791],
    ['R', -1.0605277708708791 + 2 * Math.PI],
    ['L', -1.0605277708708791],
  ] as const)('finds positive-lift primary descent on %s from pole plane %s', (side, plane) => {
    const h = neutralTraceFixture();
    const context: ArmForwardContext = { ...h.context, side };
    const start = poleReturnQ(plane);
    const limit = poleReturnBounds(start);
    const initialError = primaryErrorAt(
      { calibration: h.calibration, context, handLength: h.handLength },
      start,
      h.request,
    );

    const out = h.solver.plan(
      h.request,
      start,
      context,
      limit,
      freeEnvironment(),
      makeArmPathPlanOutput(h.calibration, h.handGeometry, 0),
    );

    expect(['progress', 'settled']).toContain(out.status);
    expect(out.q[1]).toBeGreaterThan(0);
    expect(out.q[0]).not.toBe(start[0]);
    expect(out.positionError).toBeLessThan(initialError);
    for (let dof = 0; dof < 7; dof++) {
      expect(out.q[dof]).toBeGreaterThanOrEqual(limit.lower[dof]);
      expect(out.q[dof]).toBeLessThanOrEqual(limit.upper[dof]);
    }
  });

  it('uses the exact physical-elevation finite-difference scale for pole probes', () => {
    const h = neutralTraceFixture();
    const start = poleReturnQ();
    const limit = poleReturnBounds(start);
    const originalForwardArm = armConfigurationModule.forwardArm;
    const probes: Array<{ plane: number; shoulderLift: number }> = [];
    const forwardSpy = vi
      .spyOn(armConfigurationModule, 'forwardArm')
      .mockImplementation((configuration, calibration, context, result) => {
        if (
          [0, Math.PI, Math.PI / 2, (3 * Math.PI) / 2].includes(configuration.shoulderPlane) &&
          configuration.shoulderLift > 0 &&
          configuration.shoulderLift < 1e-4
        ) {
          probes.push({
            plane: configuration.shoulderPlane,
            shoulderLift: configuration.shoulderLift,
          });
        }
        return originalForwardArm(configuration, calibration, context, result);
      });
    try {
      h.solver.plan(
        h.request,
        start,
        h.context,
        limit,
        freeEnvironment(),
        makeArmPathPlanOutput(h.calibration, h.handGeometry, 0),
      );
    } finally {
      forwardSpy.mockRestore();
    }

    expect(probes.map((probe) => probe.plane)).toEqual([
      0,
      Math.PI,
      Math.PI / 2,
      (3 * Math.PI) / 2,
    ]);
    for (const probe of probes) {
      const physicalElevation =
        probe.shoulderLift *
        elevationCeiling(probe.plane, h.calibration.joints.shoulder.elevation).max;
      expect(physicalElevation).toBeCloseTo(Math.cbrt(Number.EPSILON), 12);
    }
  });

  it('keeps caller-locked plane and lift bounds exact at the pole', () => {
    const h = neutralTraceFixture();
    const start = poleReturnQ();
    const initialError = primaryErrorAt(h, start, h.request);
    for (const lockedDof of [0, 1]) {
      const limit = poleReturnBounds(start);
      limit.lower[lockedDof] = start[lockedDof];
      limit.upper[lockedDof] = start[lockedDof];
      const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, 0);

      const out = h.solver.plan(h.request, start, h.context, limit, freeEnvironment(), output);

      expect(out.status).toBe('blocked');
      expect(out.positionError).toBeCloseTo(initialError, 12);
      expect(Array.from(out.q)).toEqual(Array.from(start));
    }
  });

  it('does not use the exact-pole gauge proposal at a small positive lift', () => {
    const h = neutralTraceFixture();
    const start = poleReturnQ();
    start[1] = 1e-8;
    const limit = poleReturnBounds(start);
    limit.lower[0] = start[0] - 1e-4;
    limit.upper[0] = start[0] + 1e-4;
    const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, 0);

    const out = h.solver.plan(h.request, start, h.context, limit, freeEnvironment(), output);

    expect(out.status).toBe('progress');
    expect(out.q[0]).not.toBe(limit.lower[0]);
    expect(out.q[0]).not.toBe(limit.upper[0]);
    for (let dof = 0; dof < 7; dof++) {
      expect(out.q[dof]).toBeGreaterThanOrEqual(limit.lower[dof]);
      expect(out.q[dof]).toBeLessThanOrEqual(limit.upper[dof]);
    }
  });

  it('keeps the gauge move collision-safe and rejects a colliding lift', () => {
    const h = neutralTraceFixture();
    const start = poleReturnQ();
    const limit = poleReturnBounds(start);
    const initialForward = forwardArm(
      configFrom(start),
      h.calibration,
      h.context,
      makeArmForwardResult(),
    );
    const center = initialForward.wrist
      .clone()
      .addScaledVector(initialForward.h, (h.handLength * HAND_CONTACT) / TORSO_SAMPLES);
    const pointIndex = TORSO_SAMPLES * 2 + 1;
    let batches = 0;
    const environment: ArmPathEnvironment = {
      rowCount: 1,
      sample: (points, rows) => {
        batches++;
        const displacement = points[pointIndex].position.clone().sub(center);
        const row = rows[0];
        row.key = 'pole-lift-boundary';
        row.pointIndex = pointIndex;
        row.valid = true;
        row.distance = -displacement.length();
        if (displacement.lengthSq() > 0) row.normal.copy(displacement).normalize().negate();
        else row.normal.set(0, 1, 0);
      },
    };
    const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, environment.rowCount);
    const initialError = primaryErrorAt(h, start, h.request);

    const out = h.solver.plan(h.request, start, h.context, limit, environment, output);

    expect(out.status).toBe('progress');
    expect(out.q[0]).not.toBe(start[0]);
    expect(out.q[1]).toBe(0);
    for (const landmark of ['u', 'l', 'h', 'palm', 'elbow', 'wrist'] as const) {
      expect(out.forward[landmark].distanceTo(initialForward[landmark])).toBeLessThan(1e-12);
    }
    for (const rotation of ['upperWorld', 'lowerWorld', 'handWorld'] as const) {
      expect(out.forward[rotation].angleTo(initialForward[rotation])).toBeLessThan(1e-7);
    }
    expect(out.positionError).toBeCloseTo(initialError, 12);
    expect(out.maxViolation).toBe(0);
    expect(out.environmentBatches).toBe(batches);
    expect(out.environmentBatches).toBeLessThanOrEqual(96);
    expect(out.clearances[0].distance).toBeCloseTo(0, 12);
  });

  it('shares the fixed sweep-query budget across line-search halvings', () => {
    const h = fixture();
    const solver = new ArmStepSolver(h.calibration, h.handGeometry, h.handLength, 0.001);
    const pointIndex = TORSO_SAMPLES * 2 + 1;
    const start = new Float64Array([0.08, 0.48, -0.04, 0.58, 0.01, 0.02, 0]);
    const goal = new Float64Array([0.95, 1.18, -0.4, 1.25, 0.45, 0.23, -0.13]);
    const request = requestAt(h.calibration, h.context, goal, h.handLength);
    let batches = 0;
    const environment: ArmPathEnvironment = {
      rowCount: 1,
      sample: (points, rows) => {
        batches++;
        const row = rows[0];
        row.key = 'broad-clearance';
        row.pointIndex = pointIndex;
        row.valid = true;
        row.distance = points[pointIndex].position.y + 10;
        row.normal.set(0, 1, 0);
      },
    };
    const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, environment.rowCount);
    const initialError = primaryErrorAt(h, start, request);

    const out = solver.plan(request, start, h.context, bounds(), environment, output);

    expect(['progress', 'settled']).toContain(out.status);
    expect(out.positionError).toBeLessThan(initialError);
    expect(out.iterations).toBeGreaterThan(0);
    expect(out.environmentBatches).toBeLessThanOrEqual(96);
    expect(batches).toBe(out.environmentBatches);
    for (let sample = 0; sample <= 4096; sample++) {
      const t = sample / 4096;
      const q = Float64Array.from(start, (value, index) => value + (out.q[index] - value) * t);
      expect(firstHandProxy(h, q).y + 10).toBeGreaterThanOrEqual(0);
    }
  });

  it.each([
    { side: 'R' as const, yaw: 0, scale: 1, palm: true, width: 0.5, flex: 0.2, limit: 0.04 },
    { side: 'L' as const, yaw: 0, scale: 1, palm: true, width: 0.5, flex: 0.2, limit: 0.04 },
    { side: 'R' as const, yaw: 0.6, scale: 0.5, palm: true, width: 0.5, flex: 0.2, limit: 0.04 },
    { side: 'L' as const, yaw: -0.5, scale: 1.7, palm: true, width: 0.5, flex: 0.2, limit: 0.04 },
    { side: 'R' as const, yaw: 0.3, scale: 1, palm: false, width: 0.5, flex: 0.2, limit: 0.04 },
    { side: 'R' as const, yaw: 0, scale: 1, palm: true, width: 14 / 60, flex: 0.08, limit: 0.02 },
  ])(
    'uses continuous authored elbow guidance during primary progress: $side/$yaw/$scale/$palm/$width',
    (scenario) => {
      const h = fixture(scenario.side, scenario.yaw, scenario.scale);
      const start = new Float64Array([0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
      const goal = start.slice();
      goal[3] += scenario.flex;
      const request = {
        ...requestAt(h.calibration, h.context, goal, h.handLength),
        ...(scenario.palm ? {} : { palm: null }),
      };
      const limit = boundedAround(start, scenario.width);
      limit.upper[3] = start[3] + scenario.limit;
      const before = [Array.from(start), Array.from(limit.lower), Array.from(limit.upper)];
      const reference = h.solver.plan(
        request,
        start,
        h.context,
        limit,
        freeEnvironment(),
        h.output,
      );
      expect(reference.status).toBe('progress');
      const n = reference.forward.wrist.clone().sub(h.context.shoulder).normalize();
      const d = reference.forward.wrist.distanceTo(h.context.shoulder);
      const center = h.context.shoulder
        .clone()
        .addScaledVector(
          n,
          (h.context.upperLength ** 2 - h.context.lowerLength ** 2 + d ** 2) / (2 * d),
        );
      const radial = reference.forward.elbow.clone().sub(center);
      const elbows: THREE.Vector3[] = [];
      const errors: number[] = [];
      for (const sign of [-1, 1]) {
        const target = radial
          .clone()
          .applyAxisAngle(n, sign * 0.2)
          .add(center);
        const solver = new ArmStepSolver(
          h.calibration,
          h.handGeometry,
          h.handLength,
          0.006 * scenario.scale,
        );
        let queries = 0;
        const environment: ArmPathEnvironment = {
          rowCount: 1,
          sample: (points, rows) => {
            queries++;
            const row = rows[0];
            row.key = 'floor';
            row.pointIndex = TORSO_SAMPLES;
            row.valid = true;
            row.distance = points[row.pointIndex].position.y + scenario.scale;
            row.normal.set(0, 1, 0);
          },
        };
        const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, 1);
        const observed = observeHierarchy(solver, output);
        const out = solver.plan(
          { ...request, elbow: target },
          start,
          h.context,
          limit,
          environment,
          output,
        );
        expect(out.status).toBe('progress');
        elbows.push(out.forward.elbow.clone());
        errors.push(out.positionError);
        expect(out.forward.elbow.distanceTo(target)).toBeLessThan(
          reference.forward.elbow.distanceTo(target) - 0.001 * scenario.scale,
        );
        const span = h.context.upperLength + h.context.lowerLength + h.handLength;
        expect((out.positionError / span) ** 2).toBeLessThanOrEqual(
          (reference.positionError / span) ** 2 + Number.EPSILON ** (2 / 3),
        );
        const active = observed.retractions.filter((event) => event.accepted);
        expect(active.length).toBeGreaterThan(0);
        for (const event of active) {
          expect(event.primaryChange).toBeLessThanOrEqual(Number.EPSILON ** (2 / 3));
          expect(event.elbowImprovement).toBeGreaterThan(Number.EPSILON ** (2 / 3));
          expect(event.wristMovement).toBeLessThanOrEqual(1e-6 * span);
          expect(event.handMovement).toBeLessThanOrEqual(1e-5);
          if (scenario.palm) expect(event.palmMovement).toBeLessThanOrEqual(1e-5);
        }
        for (const count of observed.qpCalls.values()) expect(count).toBeLessThanOrEqual(6);
        for (const count of observed.candidates.values()) expect(count).toBeLessThanOrEqual(6);
        expect(out.iterations).toBeLessThanOrEqual(6);
        expect(out.environmentBatches).toBe(queries);
        expect(queries).toBeLessThanOrEqual(96);
        expect(primaryErrorAt(h, out.q, request)).toBeCloseTo(out.positionError, 12);
        const exact = forwardArm(
          configFrom(out.q),
          h.calibration,
          h.context,
          makeArmForwardResult(),
        );
        for (const key of ['wrist', 'elbow', 'u', 'l', 'h', 'palm'] as const) {
          expect(out.forward[key].distanceTo(exact[key])).toBeLessThan(1e-12);
        }
        for (let sample = 0; sample <= 1024; sample++) {
          const t = sample / 1024;
          const q = Float64Array.from(start, (value, dof) => value + (out.q[dof] - value) * t);
          for (let dof = 0; dof < 7; dof++) {
            expect(q[dof]).toBeGreaterThanOrEqual(limit.lower[dof]);
            expect(q[dof]).toBeLessThanOrEqual(limit.upper[dof]);
          }
          const fk = forwardArm(configFrom(q), h.calibration, h.context, makeArmForwardResult());
          expect(fk.elbow.y + scenario.scale).toBeGreaterThanOrEqual(0);
        }
      }
      expect([Array.from(start), Array.from(limit.lower), Array.from(limit.upper)]).toEqual(before);
      expect(
        elbows[0].distanceTo(elbows[1]),
        JSON.stringify({ errors, reference: reference.positionError }),
      ).toBeGreaterThan(0.002 * scenario.scale);
    },
  );

  it('falls back to the primary move when elbow retraction exceeds tight wrist bounds', () => {
    const h = fixture();
    const start = new Float64Array([0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
    const goal = start.slice();
    goal[3] = 1;
    const request = requestAt(h.calibration, h.context, goal, h.handLength);
    const limit = boundedAround(start, 14 / 60);
    limit.upper[3] = start[3] + 0.04;
    const reference = h.solver.plan(request, start, h.context, limit, freeEnvironment(), h.output);
    const n = reference.forward.wrist.clone().sub(h.context.shoulder).normalize();
    const center = h.context.shoulder
      .clone()
      .addScaledVector(n, reference.forward.elbow.clone().sub(h.context.shoulder).dot(n));
    const target = reference.forward.elbow.clone().sub(center).applyAxisAngle(n, -0.2).add(center);
    const solver = new ArmStepSolver(h.calibration, h.handGeometry, h.handLength, 0.006);
    const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, 0);
    const observed = observeHierarchy(solver, output);
    const out = solver.plan(
      { ...request, elbow: target },
      start,
      h.context,
      limit,
      freeEnvironment(),
      output,
    );
    expect(observed.retractions.length).toBeGreaterThan(0);
    expect(observed.retractions.every((event) => !event.accepted)).toBe(true);
    expect(Array.from(out.q)).toEqual(Array.from(reference.q));
    expect(out.positionError).toBe(reference.positionError);
    for (let dof = 0; dof < 7; dof++) {
      expect(out.q[dof]).toBeGreaterThanOrEqual(limit.lower[dof]);
      expect(out.q[dof]).toBeLessThanOrEqual(limit.upper[dof]);
    }
  });

  it.each(['locked', 'straight', 'pole', 'near-pole'] as const)(
    'keeps finite hand-preserving elbow guidance safe at %s',
    (kind) => {
      const h = fixture();
      const start = new Float64Array([0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
      if (kind === 'straight') start[3] = 0;
      if (kind === 'pole') start[1] = 0;
      if (kind === 'near-pole') start[1] = 1e-4;
      const initial = forwardArm(
        configFrom(start),
        h.calibration,
        h.context,
        makeArmForwardResult(),
      );
      const request = {
        ...requestAt(h.calibration, h.context, start, h.handLength),
        elbow: initial.elbow.clone().add(new THREE.Vector3(0.01, 0.005, 0.01)),
      };
      const limit = boundedAround(start, kind === 'locked' ? 0 : 14 / 60);
      let queries = 0;
      const environment = outwardPlaneEnvironment('floor', TORSO_SAMPLES, up, -1);
      const sample = environment.sample;
      environment.sample = (points, rows) => {
        queries++;
        sample(points, rows);
      };
      const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, 1);
      const out = h.solver.plan(request, start, h.context, limit, environment, output);
      expect(out.q.every(Number.isFinite)).toBe(true);
      expect(out.forward.wrist.distanceTo(initial.wrist)).toBeLessThan(1e-6);
      expect(out.forward.h.distanceTo(initial.h)).toBeLessThan(1e-5);
      expect(out.forward.palm.distanceTo(initial.palm)).toBeLessThan(1e-5);
      if (kind === 'locked' || kind === 'straight')
        expect(Array.from(out.q)).toEqual(Array.from(start));
      expect(out.environmentBatches).toBe(queries);
      expect(queries).toBeLessThanOrEqual(96);
      expect(out.iterations).toBeLessThanOrEqual(6);
      expect(primaryErrorAt(h, out.q, request)).toBeCloseTo(out.positionError, 12);
      for (let sampleIndex = 0; sampleIndex <= 512; sampleIndex++) {
        const t = sampleIndex / 512;
        const q = Float64Array.from(start, (value, dof) => value + (out.q[dof] - value) * t);
        for (let dof = 0; dof < 7; dof++) {
          expect(q[dof]).toBeGreaterThanOrEqual(limit.lower[dof]);
          expect(q[dof]).toBeLessThanOrEqual(limit.upper[dof]);
        }
        const exact = forwardArm(configFrom(q), h.calibration, h.context, makeArmForwardResult());
        expect(exact.elbow.y + 1).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it.each(['blocking', 'tangent'] as const)(
    'respects an elbow %s plane during secondary motion',
    (kind) => {
      const h = fixture();
      const start = new Float64Array([0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
      const initial = forwardArm(
        configFrom(start),
        h.calibration,
        h.context,
        makeArmForwardResult(),
      );
      const n = initial.wrist.clone().sub(h.context.shoulder).normalize();
      const center = h.context.shoulder
        .clone()
        .addScaledVector(n, initial.elbow.clone().sub(h.context.shoulder).dot(n));
      const radial = initial.elbow.clone().sub(center);
      const target = radial.clone().applyAxisAngle(n, -0.1).add(center);
      const request = {
        ...requestAt(h.calibration, h.context, start, h.handLength),
        elbow: target,
      };
      const limit = boundedAround(start, 14 / 60);
      const reference = h.solver.plan(
        request,
        start,
        h.context,
        limit,
        freeEnvironment(),
        h.output,
      );
      expect(reference.forward.elbow.distanceTo(initial.elbow)).toBeGreaterThan(0.001);
      const normal =
        kind === 'blocking' ? new THREE.Vector3().crossVectors(n, radial).normalize() : n.clone();
      const middle = Float64Array.from(start, (value, dof) => (value + reference.q[dof]) / 2);
      const middleElbow = forwardArm(
        configFrom(middle),
        h.calibration,
        h.context,
        makeArmForwardResult(),
      ).elbow;
      if (kind === 'tangent' && normal.dot(middleElbow.clone().sub(initial.elbow)) < 0)
        normal.negate();
      let queries = 0;
      const environment: ArmPathEnvironment = {
        rowCount: 1,
        sample: (points, rows) => {
          queries++;
          rows[0].key = 'elbow-plane';
          rows[0].pointIndex = TORSO_SAMPLES;
          rows[0].valid = true;
          rows[0].distance = normal.dot(points[TORSO_SAMPLES].position.clone().sub(initial.elbow));
          rows[0].normal.copy(normal);
        },
      };
      const solver = new ArmStepSolver(h.calibration, h.handGeometry, h.handLength, 0.006);
      const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, 1);
      const observed = observeHierarchy(solver, output);
      const out = solver.plan(request, start, h.context, limit, environment, output);
      if (kind === 'blocking') {
        expect(normal.dot(target.clone().sub(initial.elbow))).toBeLessThan(-0.001);
        expect(out.forward.elbow.distanceTo(target)).toBeGreaterThan(0.001);
      } else {
        expect(observed.retractions.some((event) => event.accepted)).toBe(true);
        expect(out.forward.elbow.distanceTo(initial.elbow)).toBeGreaterThan(0.001);
      }
      expect(out.forward.wrist.distanceTo(initial.wrist)).toBeLessThan(1e-6);
      expect(out.forward.h.distanceTo(initial.h)).toBeLessThan(1e-5);
      expect(out.forward.palm.distanceTo(initial.palm)).toBeLessThan(1e-5);
      expect(out.environmentBatches).toBe(queries);
      expect(queries).toBeLessThanOrEqual(96);
      expect(out.iterations).toBeLessThanOrEqual(6);
      for (let sample = 0; sample <= 2048; sample++) {
        const t = sample / 2048;
        const q = Float64Array.from(start, (value, dof) => value + (out.q[dof] - value) * t);
        const fk = forwardArm(configFrom(q), h.calibration, h.context, makeArmForwardResult());
        expect(normal.dot(fk.elbow.clone().sub(initial.elbow))).toBeGreaterThanOrEqual(-1e-10);
        for (let dof = 0; dof < 7; dof++) {
          expect(q[dof]).toBeGreaterThanOrEqual(limit.lower[dof]);
          expect(q[dof]).toBeLessThanOrEqual(limit.upper[dof]);
        }
      }
    },
  );

  it('reserves one final chord certificate while converging through several GN endpoints', () => {
    const h = fixture();
    const solver = new ArmStepSolver(h.calibration, h.handGeometry, h.handLength, 0.003);
    const start = new Float64Array([0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
    const goal = new Float64Array([0.35, 1, 0.15, 0.9, 0.25, 0.1, 0.05]);
    const request = requestAt(h.calibration, h.context, goal, h.handLength);
    const limit = boundedAround(start, 14 / 60);
    const before = [Array.from(start), Array.from(limit.lower), Array.from(limit.upper)];
    let batches = 0;
    const environment: ArmPathEnvironment = {
      rowCount: 1,
      sample: (points, rows) => {
        batches++;
        const row = rows[0];
        row.key = 'floor';
        row.pointIndex = TORSO_SAMPLES * 2 + 1;
        row.valid = true;
        row.distance = points[row.pointIndex].position.y + 1;
        row.normal.set(0, 1, 0);
      },
    };
    const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, environment.rowCount);
    const reference = h.solver.plan(request, start, h.context, limit, freeEnvironment(), h.output);
    expect(reference.status).toBe('settled');
    const out = solver.plan(request, start, h.context, limit, environment, output);

    expect(
      out.status,
      JSON.stringify({ error: out.positionError, batches, iterations: out.iterations }),
    ).toBe('settled');
    expect(out.positionError).toBeLessThan(1e-5);
    expect(out.iterations).toBeGreaterThan(1);
    expect(out.iterations).toBeLessThanOrEqual(6);
    expect(out.environmentBatches).toBe(batches);
    expect(batches).toBeLessThanOrEqual(96);
    expect([Array.from(start), Array.from(limit.lower), Array.from(limit.upper)]).toEqual(before);
    expect(primaryErrorAt(h, out.q, request)).toBeCloseTo(out.positionError, 12);
    for (let sample = 0; sample <= 2048; sample++) {
      const t = sample / 2048;
      const q = Float64Array.from(start, (value, dof) => value + (out.q[dof] - value) * t);
      for (let dof = 0; dof < 7; dof++) {
        expect(q[dof]).toBeGreaterThanOrEqual(limit.lower[dof]);
        expect(q[dof]).toBeLessThanOrEqual(limit.upper[dof]);
      }
      expect(firstHandProxy(h, q).y + 1).toBeGreaterThanOrEqual(0);
    }
  });

  it.each([false, true])(
    'rejects an uncertified sphere crossing with an incompatible elbow=%s',
    (incompatibleElbow) => {
      const h = fixture();
      const solver = new ArmStepSolver(h.calibration, h.handGeometry, h.handLength, 0.003);
      const start = new Float64Array([0, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
      const goal = start.slice();
      goal[0] = 0.3;
      if (incompatibleElbow) goal[3] += 0.2;
      const middle = start.slice();
      middle[0] = 0.15;
      const center = firstHandProxy(h, middle);
      const radius = 0.008;
      const pointIndex = TORSO_SAMPLES * 2 + 1;
      const limit = { lower: start.slice(), upper: start.slice() };
      limit.upper[0] = goal[0];
      const request = requestAt(h.calibration, h.context, goal, h.handLength);
      let batches = 0;
      const environment: ArmPathEnvironment = {
        rowCount: 1,
        sample: (points, rows) => {
          batches++;
          const row = rows[0];
          row.key = 'interior-sphere';
          row.pointIndex = pointIndex;
          row.normal.copy(points[pointIndex].position).sub(center);
          row.distance = row.normal.length() - radius;
          // A local query domain exposes the interior obstacle during the chord
          // replay, while both clear endpoints have no active separating plane.
          row.valid = row.distance < 0.012;
          if (row.normal.lengthSq() < 1e-12) row.normal.set(0, 1, 0);
          else row.normal.normalize();
        },
      };
      const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, 1);
      const certificates = observeCertificates(solver, output);
      const out = solver.plan(request, start, h.context, limit, environment, output);
      expect(
        certificates.some((event) => !event.certified),
        JSON.stringify(certificates),
      ).toBe(true);
      if (incompatibleElbow) {
        expect(certificates.at(-1)?.iteration, JSON.stringify(certificates)).toBe(6);
        expect(out.iterations).toBe(6);
        expect(Array.from(out.q)).toEqual(certificates.at(-1)?.checkpoint);
      } else {
        expect(certificates[0].settled, JSON.stringify(certificates)).toBe(true);
        expect(certificates[0].iteration).toBeLessThan(6);
        expect(out.iterations).toBeGreaterThan(certificates[0].iteration);
      }
      for (const event of certificates) {
        if (!event.certified) {
          expect(
            firstHandProxy(h, Float64Array.from(event.attempted)).distanceTo(center) - radius,
          ).toBeGreaterThan(0);
          expect(event.returned).toEqual(event.checkpoint);
        }
      }
      expect(out.status).toBe('progress');
      expect(out.q[0]).toBeGreaterThan(0);
      expect(out.q[0]).toBeLessThan(middle[0]);
      expect(batches).toBe(out.environmentBatches);
      expect(batches).toBeLessThanOrEqual(96);
      expect(out.positionError).toBeCloseTo(primaryErrorAt(h, out.q, request), 12);
      const actual = forwardArm(
        configFrom(out.q),
        h.calibration,
        h.context,
        makeArmForwardResult(),
      );
      for (const key of ['wrist', 'elbow', 'u', 'l', 'h', 'palm'] as const) {
        expect(out.forward[key].distanceTo(actual[key])).toBeLessThan(1e-12);
      }
      for (const key of ['upperWorld', 'lowerWorld', 'handWorld'] as const) {
        expect(1 - Math.abs(out.forward[key].dot(actual[key]))).toBeLessThan(1e-12);
      }
      expect(out.clearances[0].distance).toBeCloseTo(
        firstHandProxy(h, out.q).distanceTo(center) - radius,
        12,
      );
      for (let sample = 0; sample <= 2048; sample++) {
        const q = Float64Array.from(
          start,
          (value, dof) => value + (out.q[dof] - value) * (sample / 2048),
        );
        expect(firstHandProxy(h, q).distanceTo(center) - radius).toBeGreaterThanOrEqual(-1e-9);
      }
    },
  );

  it.each([true, false])(
    'protects the exact final-certificate reservation when an endpoint fits=%s',
    (fits) => {
      const h = fixture();
      const solver = new ArmStepSolver(h.calibration, h.handGeometry, h.handLength, 0.003);
      const start = new Float64Array([0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
      const goal = new Float64Array([0.35, 1, 0.15, 0.9, 0.25, 0.1, 0.05]);
      const request = requestAt(h.calibration, h.context, goal, h.handLength);
      const limit = boundedAround(start, 14 / 60);
      let queries = 0;
      const environment: ArmPathEnvironment = {
        rowCount: 1,
        sample: (points, rows) => {
          queries++;
          rows[0].key = 'floor';
          rows[0].pointIndex = TORSO_SAMPLES * 2 + 1;
          rows[0].valid = true;
          rows[0].distance = points[rows[0].pointIndex].position.y + 1;
          rows[0].normal.set(0, 1, 0);
        },
      };
      const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, 1);
      solver.plan(request, start, h.context, limit, environment, output);
      expect(output.status).toBe('settled');
      const internal = solver as unknown as {
        current: { q: Float64Array };
        candidate: { q: Float64Array };
        environmentBatches: number;
        preparedSweepCount: number;
        reservedSweepCount: number;
        reservedSweepFractions: Float64Array;
        currentIsCertified: boolean;
        evaluatePlanCandidate: (...args: unknown[]) => boolean;
        acceptPlanCandidate: (...args: unknown[]) => void;
        certifyCurrent: (...args: unknown[]) => boolean;
      };
      // Reuse real FK, endpoint sampling and preflight, then position only the
      // spent-work counter at the two adjacent admission boundaries.
      internal.environmentBatches = 0;
      internal.candidate.q.set(internal.current.q);
      expect(internal.evaluatePlanCandidate(h.context, limit, environment, 0)).toBe(true);
      internal.acceptPlanCandidate(environment);
      const reserved = internal.reservedSweepCount;
      const fractions = Array.from(internal.reservedSweepFractions.slice(0, reserved));
      const current = Array.from(internal.current.q);
      expect(reserved).toBeGreaterThan(3);
      internal.environmentBatches = 96 - reserved - (fits ? 1 : 0);
      queries = 0;
      if (!fits) internal.candidate.q.set(start);

      expect(internal.evaluatePlanCandidate(h.context, limit, environment, 0)).toBe(fits);
      expect(queries).toBe(fits ? 1 : 0);
      if (fits) internal.acceptPlanCandidate(environment);
      else {
        expect(internal.preparedSweepCount).toBe(3);
        expect(internal.reservedSweepCount).toBe(reserved);
        expect(Array.from(internal.reservedSweepFractions.slice(0, reserved))).toEqual(fractions);
      }
      expect(internal.currentIsCertified).toBe(false);
      expect(internal.certifyCurrent(h.context, limit, environment)).toBe(true);
      expect(internal.environmentBatches).toBe(96);
      expect(queries).toBe(reserved + (fits ? 1 : 0));
      expect(Array.from(internal.current.q)).toEqual(current);
      expect(internal.currentIsCertified).toBe(true);
    },
  );

  it('reports an unreachable request as finite blocked progress, never settled', () => {
    const h = fixture();
    const start = new Float64Array([0, 0.3, 0, 0.4, 0, 0, 0]);
    const request: ArmPathRequest = {
      wrist: new THREE.Vector3(8, 4, -7),
      hand: forward.clone(),
      palm: up.clone(),
      curls: {},
      spread: {},
    };

    const limit = bounds();
    let next = start;
    let out = h.output;
    for (let call = 0; call < 10; call++) {
      out = h.solver.plan(request, next, h.context, limit, freeEnvironment(), h.output);
      if (out.status !== 'progress') break;
      next = new Float64Array(out.q);
    }

    expect(out.status).toBe('blocked');
    expect(out.positionError).toBeGreaterThan(1);
    expect(Number.isFinite(out.positionError)).toBe(true);
    expect(out.q.every(Number.isFinite)).toBe(true);
    expect(out.maxViolation).toBe(0);
  });

  it.each([
    ['R', 0, 1],
    ['L', 0, 1],
    ['R', 0.7, 1],
    ['R', 0, 0.01],
    ['L', 0.7, 0.01],
  ] as const)('keeps q in the exact rendered frame for %s yaw %s scale %s', (side, yaw, scale) => {
    const h = fixture(side, yaw, scale);
    const start = new Float64Array([0, 0.18, 0.1, 0.5, 0.02, 0.04, -0.02]);
    const request = requestAt(h.calibration, h.context, start, h.handLength);

    const out = h.solver.plan(request, start, h.context, bounds(), freeEnvironment(), h.output);
    const exact = forwardArm(configFrom(out.q), h.calibration, h.context, makeArmForwardResult());

    expect(out.status).toBe('settled');
    expect(out.forward.wrist.distanceTo(exact.wrist)).toBeLessThan(1e-12);
    expect(1 - Math.abs(out.forward.handWorld.dot(exact.handWorld))).toBeLessThan(1e-14);
    expect(out.positionError).toBeLessThan(1e-7 * scale + 1e-12);
  });

  it('rejects an empty strict bound without changing the accepted start', () => {
    const h = fixture();
    const start = new Float64Array([0, 0.2, 0, 0.3, 0, 0, 0]);
    const before = Array.from(start);
    const strict = bounds();
    strict.lower[0] = 0.1;
    strict.upper[0] = 0.05;
    const request = requestAt(
      h.calibration,
      h.context,
      new Float64Array([0.4, 0.5, 0.3, 0.7, 0, 0, 0]),
      h.handLength,
    );

    const out = h.solver.plan(request, start, h.context, strict, freeEnvironment(), h.output);

    expect(out.status).toBe('blocked');
    expect(Array.from(out.q)).toEqual(before);
    expect(Array.from(start)).toEqual(before);
  });

  it('marks an invalid world frame as an invalid blocked result before querying clearance', () => {
    const h = fixture();
    const start = new Float64Array([0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03]);
    const request = requestAt(h.calibration, h.context, start, h.handLength);
    h.context.right.copy(h.context.up);
    let batches = 0;
    const environment: ArmPathEnvironment = {
      rowCount: 1,
      sample: () => {
        batches++;
      },
    };
    const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, environment.rowCount);

    const out = h.solver.plan(request, start, h.context, bounds(), environment, output);

    expect(out.status).toBe('blocked');
    expect(Array.from(out.q)).toEqual(Array.from(start));
    expect(out.positionError).toBe(Number.POSITIVE_INFINITY);
    expect(out.orientationError).toBe(Number.POSITIVE_INFINITY);
    expect(out.maxViolation).toBe(Number.POSITIVE_INFINITY);
    expect(out.environmentBatches).toBe(0);
    expect(batches).toBe(0);
  });

  it('rejects a stable clearance key that changes its point index between solver states', () => {
    const h = fixture();
    const start = new Float64Array([0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03]);
    const goal = new Float64Array([0.42, 0.64, 0.35, 0.82, 0.28, 0.22, -0.13]);
    const request = requestAt(h.calibration, h.context, goal, h.handLength);
    let batches = 0;
    const environment: ArmPathEnvironment = {
      rowCount: 1,
      sample: (_points, rows) => {
        const row = rows[0];
        row.key = 'unstable-point';
        row.pointIndex = TORSO_SAMPLES * 2 + 1 + (batches++ === 0 ? 0 : 1);
        row.valid = false;
        row.distance = Number.POSITIVE_INFINITY;
        row.normal.set(0, 0, 0);
      },
    };
    const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, environment.rowCount);

    expect(() => h.solver.plan(request, start, h.context, bounds(), environment, output)).toThrow(
      /stable point index/,
    );
  });

  it.each([
    ['duplicate before invalid numeric row', 1, 'duplicate', 'unique stable keys'],
    ['out-of-range point before invalid numeric row', 1, 'point-range', 'valid point indices'],
    ['omitted row', 1, 'omitted-row', 'unique stable keys'],
    ['nonfinite distance', 1, 'distance', 'finite distance'],
    ['zero normal', 1, 'normal', 'nonzero finite normal'],
    ['changed key on a later sample', 2, 'changed-key', 'stable and unique'],
    ['duplicate reordered key on a later sample', 2, 'duplicate', 'stable and unique'],
    ['changed point on a later sample', 2, 'changed-point', 'stable point index'],
    ['omitted distance on a later sample', 2, 'omitted-distance', 'finite distance'],
    ['omitted normal on a later sample', 2, 'omitted-normal', 'nonzero finite normal'],
  ] as const)(
    'rejects %s and resets the row contract for the next call',
    (_name, failAt, fault, message) => {
      const h = fixture();
      const start = new Float64Array([0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03]);
      const goal = new Float64Array([0.42, 0.64, 0.35, 0.82, 0.28, 0.22, -0.13]);
      const request = requestAt(h.calibration, h.context, goal, h.handLength);
      const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, 2);
      let queries = 0;
      const environment: ArmPathEnvironment = {
        rowCount: 2,
        sample: (_points, rows) => {
          queries++;
          const failing = queries === failAt;
          for (let slot = 0; slot < rows.length; slot++) {
            if (failing && fault === 'omitted-row' && slot === 1) continue;
            const row = rows[slot];
            row.key = `surface:${slot}`;
            row.pointIndex = slot;
            row.valid = true;
            if (!(failing && fault === 'omitted-distance' && slot === 0)) row.distance = 1;
            if (!(failing && fault === 'omitted-normal' && slot === 0)) row.normal.set(0, 1, 0);
          }
          if (!failing) return;
          if (fault === 'duplicate') {
            rows[0].key = rows[1].key;
            rows[0].pointIndex = rows[1].pointIndex;
            // Registration errors must precede this invalid value on the first query.
            if (failAt === 1) rows[0].distance = Number.NaN;
          }
          if (fault === 'point-range') {
            rows[0].distance = Number.NaN;
            rows[1].pointIndex = -1;
          }
          if (fault === 'distance') rows[0].distance = Number.NaN;
          if (fault === 'normal') rows[0].normal.set(0, 0, 0);
          if (fault === 'changed-key') rows[0].key = 'unregistered';
          if (fault === 'changed-point') rows[0].pointIndex = 2;
        },
      };
      expect(() => h.solver.plan(request, start, h.context, bounds(), environment, output)).toThrow(
        message,
      );
      expect(queries).toBe(failAt);

      // A new public call establishes its own key order and point identities, even after a throw.
      const recovery: ArmPathEnvironment = {
        rowCount: 2,
        sample: (_points, rows) => {
          for (let slot = 0; slot < rows.length; slot++) {
            rows[slot].key = `replacement:${1 - slot}`;
            rows[slot].pointIndex = 2 - slot;
            rows[slot].valid = true;
            rows[slot].distance = 1;
            rows[slot].normal.set(0, 1, 0);
          }
        },
      };
      const settledRequest = requestAt(h.calibration, h.context, start, h.handLength);
      expect(
        h.solver.restoreEndpoint(settledRequest, start, h.context, bounds(), recovery, output),
      ).toBe(true);
      const fresh = fixture();
      const freshOutput = makeArmPathPlanOutput(fresh.calibration, fresh.handGeometry, 2);
      fresh.solver.restoreEndpoint(
        settledRequest,
        start,
        h.context,
        bounds(),
        recovery,
        freshOutput,
      );
      expect(output).toEqual(freshOutput);
      expect(output.environmentBatches).toBe(1);
    },
  );

  it('keeps reused plan and restore calls identical to fresh solvers after obstacles and row changes', () => {
    const h = fixture();
    const start = new Float64Array([0.04, 0.52, 0.06, 0.6, 0.01, 0.03, 0]);
    const goal = new Float64Array([0.66, 0.9, 0.28, 1.0, 0.22, 0.18, -0.07]);
    const request = requestAt(h.calibration, h.context, goal, h.handLength);
    const pointIndex = TORSO_SAMPLES * 2 + 1;
    const startPoint = firstHandProxy(h, start);
    const goalPoint = firstHandProxy(h, goal);
    const axis = goalPoint.clone().sub(startPoint).normalize();
    const origin = startPoint.dot(axis);
    const travel = goalPoint.dot(axis) - origin;
    const obstacle = enteringPlaneEnvironment(
      pointIndex,
      axis,
      origin + travel * 0.08,
      origin + travel * 0.46,
    );
    let violatedQueries = 0;
    const obstructed: ArmPathEnvironment = {
      rowCount: 1,
      sample: (points, rows) => {
        obstacle.sample(points, rows);
        if (rows[0].valid && rows[0].distance < 0) violatedQueries++;
      },
    };
    const obstructedOutput = makeArmPathPlanOutput(h.calibration, h.handGeometry, 1);
    h.solver.plan(request, start, h.context, bounds(), obstructed, obstructedOutput);
    expect(obstructedOutput.status).toBe('progress');
    expect(violatedQueries).toBeGreaterThan(0);

    for (const [call, rowCount] of [2, 2, 3, 0, 1, 2].entries()) {
      const traces: number[][][] = [];
      const outputs = [];
      for (const solver of [h.solver, fixture().solver]) {
        const trace: number[][] = [];
        traces.push(trace);
        const environment: ArmPathEnvironment = {
          rowCount,
          sample: (points, rows) => {
            trace.push(points.flatMap((point) => point.position.toArray()));
            for (let slot = 0; slot < rows.length; slot++) {
              const index = (slot + call + trace.length) % rows.length;
              rows[slot].key = `call:${call}:surface:${index}`;
              rows[slot].pointIndex = index + call;
              rows[slot].valid = index % 2 === 0;
              rows[slot].distance = rows[slot].valid ? 1 : Number.POSITIVE_INFINITY;
              rows[slot].normal.set(0, rows[slot].valid ? 1 : 0, 0);
            }
          },
        };
        const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, rowCount);
        if (call % 2 === 0) solver.plan(request, start, h.context, bounds(), environment, output);
        else
          expect(
            solver.restoreEndpoint(request, start, h.context, bounds(), environment, output),
          ).toBe(true);
        expect(output.environmentBatches).toBe(trace.length);
        expect(output.environmentBatches).toBeLessThanOrEqual(96);
        outputs.push(output);
      }
      expect(traces[0]).toEqual(traces[1]);
      expect(outputs[0]).toEqual(outputs[1]);
      if (rowCount > 0 && call % 2 === 0) expect(traces[0].length).toBeGreaterThan(1);
    }
  });

  it.each(['plane', 'sphere'] as const)(
    'restores a newly colliding curled fingertip through a bounded whole-arm endpoint move against a %s',
    (surface) => {
      const h = curledFingerCollisionFixture(surface);
      expect(h.openPoint.distanceTo(h.curledPoint)).toBeGreaterThan(1e-3);
      const collision = h.solver.plan(
        h.request,
        h.start,
        h.context,
        h.restrictedBounds,
        h.environment,
        h.output,
      );
      expect(collision.status).toBe('blocked');
      expect(collision.maxViolation).toBeGreaterThan(1e-3);
      expect(collision.clearances[0].distance).toBeLessThan(-1e-3);
      const requestBefore = snapshotRequest(h.request);
      const startBefore = Array.from(h.start);
      const boundsBefore = [
        Array.from(h.restrictedBounds.lower),
        Array.from(h.restrictedBounds.upper),
      ];

      const restored = h.solver.restoreEndpoint(
        h.request,
        h.start,
        h.context,
        h.restrictedBounds,
        h.environment,
        h.output,
      );

      expect(restored).toBe(true);
      expect(h.output.maxViolation).toBeLessThanOrEqual(64 * Number.EPSILON * 1);
      expect(h.output.clearances[0].distance).toBeGreaterThanOrEqual(-1e-12);
      expect(h.output.q[0]).toBeGreaterThan(h.start[0]);
      for (let dof = 1; dof < 7; dof++) expect(h.output.q[dof]).toBe(h.start[dof]);
      const exact = forwardArm(
        configFrom(h.output.q),
        h.calibration,
        h.context,
        makeArmForwardResult(),
      );
      expect(h.output.forward.wrist.distanceTo(exact.wrist)).toBeLessThan(1e-12);
      expect(snapshotRequest(h.request)).toEqual(requestBefore);
      expect(Array.from(h.start)).toEqual(startBefore);
      expect([Array.from(h.restrictedBounds.lower), Array.from(h.restrictedBounds.upper)]).toEqual(
        boundsBefore,
      );
    },
  );

  it('fails restoration under a locked infeasible box and resets the output to blocked', () => {
    const h = curledFingerCollisionFixture();
    const locked = bounds();
    for (let dof = 0; dof < 7; dof++) {
      locked.lower[dof] = h.start[dof];
      locked.upper[dof] = h.start[dof];
    }

    const restored = h.solver.restoreEndpoint(
      h.request,
      h.start,
      h.context,
      locked,
      h.environment,
      h.output,
    );

    expect(restored).toBe(false);
    expect(h.output.status).toBe('blocked');
    expect(Array.from(h.output.q)).toEqual(Array.from(h.start));
    expect(h.output.maxViolation).toBe(Number.POSITIVE_INFINITY);
    expect(h.output.positionError).toBe(Number.POSITIVE_INFINITY);
    expect(h.output.points.every((point) => point.position.lengthSq() === 0)).toBe(true);
  });

  it('returns an already-feasible endpoint unchanged', () => {
    const h = fixture();
    const start = new Float64Array([0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03]);
    const request = requestAt(h.calibration, h.context, start, h.handLength);

    const restored = h.solver.restoreEndpoint(
      request,
      start,
      h.context,
      bounds(),
      freeEnvironment(),
      h.output,
    );

    expect(restored).toBe(true);
    expect(h.output.status).toBe('settled');
    expect(Array.from(h.output.q)).toEqual(Array.from(start));
    expect(h.output.maxViolation).toBe(0);
  });

  it('rejects an invalid restoration frame with the start and invalid diagnostics', () => {
    const h = fixture();
    const start = new Float64Array([0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03]);
    const request = requestAt(h.calibration, h.context, start, h.handLength);
    h.context.right.copy(h.context.up);

    const restored = h.solver.restoreEndpoint(
      request,
      start,
      h.context,
      bounds(),
      freeEnvironment(),
      h.output,
    );

    expect(restored).toBe(false);
    expect(h.output.status).toBe('blocked');
    expect(Array.from(h.output.q)).toEqual(Array.from(start));
    expect(h.output.maxViolation).toBe(Number.POSITIVE_INFINITY);
  });

  it('converges through repeated absolute trust bounds while every emitted pose stays feasible', () => {
    const h = fixture();
    const start = new Float64Array([0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03]);
    const goal = new Float64Array([0.58, 0.92, -0.32, 1.05, 0.35, 0.23, -0.15]);
    const request = requestAt(h.calibration, h.context, goal, h.handLength);
    let q = start;
    let previousError = primaryErrorAt(h, q, request);
    let status: string = 'progress';

    for (let call = 0; call < 12 && status === 'progress'; call++) {
      const out = h.solver.plan(
        request,
        q,
        h.context,
        boundedAround(q, 0.18),
        freeEnvironment(),
        h.output,
      );
      status = out.status;
      expect(out.positionError).toBeLessThanOrEqual(previousError + 1e-9);
      expect(out.q.every(Number.isFinite)).toBe(true);
      q = new Float64Array(out.q);
      previousError = out.positionError;
    }

    expect(status).toBe('settled');
    expect(previousError).toBeLessThan(1e-5);
  });

  it('keeps an accepted transition on the safe side of a plane at dense independent samples', () => {
    const h = fixture();
    const pointIndex = TORSO_SAMPLES * 2 + 1;
    const start = new Float64Array([0.05, 0.54, 0.08, 0.62, 0.02, 0.04, 0]);
    const goal = new Float64Array([0.72, 0.92, 0.32, 1.04, 0.24, 0.19, -0.08]);
    const request = requestAt(h.calibration, h.context, goal, h.handLength);
    const startPoint = firstHandProxy(h, start);
    const goalPoint = firstHandProxy(h, goal);
    const axis = goalPoint.clone().sub(startPoint).normalize();
    const offset = (startPoint.dot(axis) + goalPoint.dot(axis)) / 2;
    const environment = planeEnvironment(pointIndex, axis, offset);
    const initialError = primaryErrorAt(h, start, request);
    const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, environment.rowCount);

    const out = h.solver.plan(request, start, h.context, bounds(), environment, output);

    expect(out.status).toBe('progress');
    expect(out.positionError).toBeLessThan(initialError);
    expect(out.clearances[0].distance).toBeGreaterThanOrEqual(-1e-10);
    expect(out.q.some((value, index) => index < 4 && Math.abs(value - start[index]) > 1e-5)).toBe(
      true,
    );
    expect(out.environmentBatches).toBeLessThanOrEqual(96);
    for (let sample = 0; sample <= 1024; sample++) {
      const t = sample / 1024;
      const q = Float64Array.from(start, (value, index) => value + (out.q[index] - value) * t);
      expect(offset - firstHandProxy(h, q).dot(axis)).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('allows a zero-clearance tangent move when every swept sample stays safe', () => {
    const h = fixture();
    const pointIndex = TORSO_SAMPLES * 2 + 1;
    const start = new Float64Array([0.05, 0.54, 0.08, 0.62, 0.02, 0.04, 0]);
    const goal = new Float64Array([0.52, 0.84, 0.26, 0.94, 0.2, 0.16, -0.06]);
    const request = requestAt(h.calibration, h.context, goal, h.handLength);
    const startPoint = firstHandProxy(h, start);
    const goalPoint = firstHandProxy(h, goal);
    const travel = goalPoint.clone().sub(startPoint);
    const tangentNormal = travel.clone().cross(up);
    if (tangentNormal.lengthSq() < 1e-12) tangentNormal.crossVectors(travel, right);
    tangentNormal.normalize();
    const offset = startPoint.dot(tangentNormal);
    expect(goalPoint.dot(tangentNormal)).toBeCloseTo(offset, 12);
    const environment = planeEnvironment(pointIndex, tangentNormal, offset);
    const initialError = primaryErrorAt(h, start, request);
    const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, environment.rowCount);

    const out = h.solver.plan(request, start, h.context, bounds(), environment, output);

    expect(['progress', 'settled']).toContain(out.status);
    expect(out.positionError).toBeLessThan(initialError);
    expect(out.clearances[0].distance).toBeGreaterThanOrEqual(-1e-10);
    expect(out.environmentBatches).toBeLessThanOrEqual(96);
    for (let sample = 0; sample <= 1024; sample++) {
      const t = sample / 1024;
      const q = Float64Array.from(start, (value, index) => value + (out.q[index] - value) * t);
      expect(offset - firstHandProxy(h, q).dot(tangentNormal)).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it.each([1, 8])(
    'keeps an approaching plane active with clearance gradient magnitude %s',
    (magnitude) => {
      const h = fixture();
      const start = new Float64Array([0, 0.5, 0, 0.7, 0, 0, 0]);
      const goal = start.slice();
      goal[5] = 0.4;
      const contact = start.slice();
      contact[5] = 0.1;
      const palm = forwardArm(
        configFrom(start),
        h.calibration,
        h.context,
        makeArmForwardResult(),
      ).palm.clone();
      const offset = firstHandProxy(h, contact).dot(palm);
      const pointIndex = TORSO_SAMPLES * 2 + 1;
      const distances: number[] = [];
      const environment: ArmPathEnvironment = {
        rowCount: 1,
        sample: (points, rows) => {
          const distance = offset - points[pointIndex].position.dot(palm);
          distances.push(distance);
          rows[0].key = 'scaled-plane';
          rows[0].pointIndex = pointIndex;
          rows[0].valid = true;
          rows[0].distance = magnitude * distance;
          rows[0].normal.copy(palm).multiplyScalar(-magnitude);
        },
      };
      const strict = { lower: start.slice(), upper: start.slice() };
      strict.upper[5] = goal[5];
      const request = requestAt(h.calibration, h.context, goal, h.handLength);
      const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, 1);
      const out = h.solver.plan(request, start, h.context, strict, environment, output);

      expect(out.status).toBe('progress');
      expect(out.q[5]).toBeGreaterThan(0);
      expect(distances.length).toBeGreaterThan(1);
      expect(distances[0]).toBeGreaterThan(0);
      // Only wrist flex moves here, so its sine arc stays inside the plane
      // when the linear clearance constraint bounds the first proposed step.
      expect(distances[1]).toBeGreaterThanOrEqual(-1e-10);
      expect(out.environmentBatches).toBe(distances.length);
      expect(out.environmentBatches).toBeLessThanOrEqual(96);
      expect(
        out.forward.wrist.distanceTo(
          forwardArm(configFrom(out.q), h.calibration, h.context, makeArmForwardResult()).wrist,
        ),
      ).toBeLessThan(1e-12);
    },
  );

  it('relinearizes a violated row that becomes valid only after the trial enters its query domain', () => {
    const h = fixture();
    const pointIndex = TORSO_SAMPLES * 2 + 1;
    const start = new Float64Array([0.04, 0.52, 0.06, 0.6, 0.01, 0.03, 0]);
    const goal = new Float64Array([0.66, 0.9, 0.28, 1.0, 0.22, 0.18, -0.07]);
    const request = requestAt(h.calibration, h.context, goal, h.handLength);
    const startPoint = firstHandProxy(h, start);
    const goalPoint = firstHandProxy(h, goal);
    const axis = goalPoint.clone().sub(startPoint).normalize();
    const startCoordinate = startPoint.dot(axis);
    const travel = goalPoint.dot(axis) - startCoordinate;
    const activation = startCoordinate + travel * 0.08;
    const offset = startCoordinate + travel * 0.46;
    const environment = enteringPlaneEnvironment(pointIndex, axis, activation, offset);
    const initialError = primaryErrorAt(h, start, request);
    const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, environment.rowCount);

    const out = h.solver.plan(request, start, h.context, bounds(), environment, output);

    expect(out.status).toBe('progress');
    expect(out.positionError).toBeLessThan(initialError);
    expect(out.maxViolation).toBe(0);
    expect(out.environmentBatches).toBeLessThanOrEqual(96);
    for (let sample = 0; sample <= 1024; sample++) {
      const t = sample / 1024;
      const q = Float64Array.from(start, (value, index) => value + (out.q[index] - value) * t);
      const coordinate = firstHandProxy(h, q).dot(axis);
      if (coordinate >= activation) expect(offset - coordinate).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('handles a spherical forbidden region with stable keys and clearance rows returned in changing order', () => {
    const h = fixture('L', 0.7, 0.01);
    const pointA = TORSO_SAMPLES * 2 + 1;
    const pointB = pointA + 1;
    const start = new Float64Array([0.08, 0.48, -0.04, 0.58, 0.01, 0.02, 0]);
    const goal = new Float64Array([0.58, 0.86, -0.28, 0.98, 0.3, 0.18, -0.1]);
    const request = requestAt(h.calibration, h.context, goal, h.handLength);
    const startPoint = firstHandProxy(h, start);
    const goalPoint = firstHandProxy(h, goal);
    const center = startPoint.clone().lerp(goalPoint, 0.62);
    const radius = startPoint.distanceTo(center) * 0.82;
    let callCount = 0;
    const environment: ArmPathEnvironment = {
      rowCount: 2,
      sample: (points, rows) => {
        const first = callCount++ % 2 === 0 ? 0 : 1;
        const second = 1 - first;
        const assignments = [
          { key: 'sphere:a', pointIndex: pointA, valid: true },
          { key: 'sphere:b', pointIndex: pointB, valid: false },
        ];
        const ordered = [first, second];
        for (let slot = 0; slot < 2; slot++) {
          const assignment = assignments[ordered[slot]];
          const row = rows[slot];
          row.key = assignment.key;
          row.pointIndex = assignment.pointIndex;
          row.valid = assignment.valid;
          if (assignment.valid) {
            row.normal.copy(points[assignment.pointIndex].position).sub(center);
            row.distance = row.normal.length() - radius;
            if (row.normal.lengthSq() < 1e-12) row.normal.set(0, 1, 0);
            else row.normal.normalize();
          } else {
            row.distance = Number.POSITIVE_INFINITY;
            row.normal.set(0, 0, 0);
          }
        }
      },
    };
    const initialError = primaryErrorAt(h, start, request);
    const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, environment.rowCount);

    const out = h.solver.plan(request, start, h.context, bounds(), environment, output);

    expect(out.status).toBe('progress');
    expect(out.positionError).toBeLessThan(initialError);
    expect(out.maxViolation).toBe(0);
    expect(out.environmentBatches).toBeLessThanOrEqual(96);
    expect(out.clearances.map((row) => row.key).sort()).toEqual(['sphere:a', 'sphere:b']);
    expect(out.clearances.find((row) => row.key === 'sphere:b')?.valid).toBe(false);
    for (let sample = 0; sample <= 1024; sample++) {
      const t = sample / 1024;
      const q = Float64Array.from(start, (value, index) => value + (out.q[index] - value) * t);
      expect(firstHandProxy(h, q).distanceTo(center) - radius).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('never returns a safe GN polyline whose original-start chord cuts through a sphere', () => {
    const h = fixture();
    const start = new Float64Array([0.08, 0.48, -0.04, 0.58, 0.01, 0.02, 0]);
    const goal = new Float64Array([0.95, 1.18, -0.4, 1.25, 0.45, 0.23, -0.13]);
    const request = requestAt(h.calibration, h.context, goal, h.handLength);
    const startPoint = firstHandProxy(h, start);
    const goalPoint = firstHandProxy(h, goal);
    const center = startPoint
      .clone()
      .lerp(goalPoint, 0.35)
      .add(new THREE.Vector3(0, 0.03, 0));
    const radius = 0.19814247673641228;
    const pointIndex = TORSO_SAMPLES * 2 + 1;
    const environment: ArmPathEnvironment = {
      rowCount: 1,
      sample: (points, rows) => {
        const row = rows[0];
        row.key = 'sphere:original-chord';
        row.pointIndex = pointIndex;
        row.valid = true;
        row.normal.copy(points[pointIndex].position).sub(center);
        row.distance = row.normal.length() - radius;
        if (row.normal.lengthSq() < 1e-12) row.normal.set(0, 1, 0);
        else row.normal.normalize();
      },
    };
    const output = makeArmPathPlanOutput(h.calibration, h.handGeometry, environment.rowCount);

    const out = h.solver.plan(request, start, h.context, bounds(), environment, output);

    expect(out.maxViolation).toBe(0);
    for (let sample = 0; sample <= 2048; sample++) {
      const t = sample / 2048;
      const q = Float64Array.from(start, (value, index) => value + (out.q[index] - value) * t);
      expect(firstHandProxy(h, q).distanceTo(center) - radius).toBeGreaterThanOrEqual(-1e-9);
    }
  });
});
