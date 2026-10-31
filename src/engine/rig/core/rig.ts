/**
 * The rig, run in the wasm core: `Rig`'s public surface over `hd_rig_*` (tabled in
 * `src/core/abi/rig.ts`), for the differential test to run beside the TS rig until the switch.
 *
 * What the rig owns and motion keeps reading — the anatomy's frame, `palmLocal`, the contact
 * prediction, the finger shape and frame, the accepted arm and hand records, a driver's
 * `acceptedQ` — are live views at the core's addresses, one object per record for the rig's life.
 * What the caller owns crosses through the scratch: copied in before the call, out after it.
 * Every call that may read or move a node goes through the scene graph's `run`, which mirrors the
 * root's ancestors in and back out.
 */

import * as THREE from 'three';
import { allocating, core, handleFinalizer } from '../../../core';
import type { Core } from '../../../core/abi';
import { ARM_SLOTS, FINGERS, SIDES } from '../../../core/abi/profile';
import {
  ARM_STATE_CURLS,
  ARM_STATE_DIRECTIONS,
  ARM_STATE_FOREARM_ROLL,
  ARM_STATE_PALM,
  ARM_STATE_SPREAD,
  CONTACT_FINGER,
  CONTACT_PALM,
  CONTEXT,
  FORWARD,
  LAYOUT,
  LAYOUT_ARM_SOLVER_OFF,
  LAYOUT_ARM_SOLVER_OFF_COUNT,
  LAYOUT_BIND_FRAME_L,
  LAYOUT_CONTACT_L,
  LAYOUT_FINGER_SHAPE_L,
  LAYOUT_FORE_ROLL,
  LAYOUT_PALM_LOCAL_L,
  LAYOUT_READINGS,
  LAYOUT_SCRATCH,
  LAYOUT_SHAPE_COUNT_L,
  LAYOUT_SHAPE_L,
  LAYOUT_SHAPE_STRIDE,
  LAYOUT_UPPER_ROLL,
  LIMITS_NO_FEASIBLE_POSE,
  NO_NODE,
  OFFSET_SLOTS,
  POINT_AZIMUTH,
  POINT_ELEVATION,
  POINT_EXTENT,
  POINT_PALM,
  POINT_POINT,
  READING,
  READING_IDS,
  REGION_CENTER,
  REGION_HEEL,
  SCRATCH_SOLUTION,
  SCRATCH_SPREAD,
  SCRATCH_STAGE_CURLS,
  SCRATCH_STAGE_SPREAD,
  SIDE_COMMIT,
  SOLVER_OFF,
  STANDING,
  SURFACE_BACK,
  SURFACE_CENTER,
  SURFACE_NONE,
  SURFACE_PAD,
  TRI_FALSE,
  TRI_TRUE,
  TRI_UNSET,
  VEC3,
  ZONES,
} from '../../../core/abi/rig';
import { SceneGraph } from '../../../core/scene';
import { JOINTS } from '../../anatomy';
import type { HandSensePose } from '../../motion/finger-life';
import type { ArmResolver } from '../../motion/resolve';
import type {
  ArmSlot,
  FingerName,
  FingerSpec,
  HandContact,
  JointReading,
  JointTable,
  Profile,
  Side,
  Vec3Tuple,
} from '../../types';
import type { ArmForwardContext, ArmForwardResult } from '../arm-configuration';
import type { ArmSolution, ReachLinks } from '../reach';
import type {
  AcceptedArmState,
  ArmFrameSideCommit,
  OffsetSlot,
  PointRequest,
  StandingArmPose,
} from '../rig';
import { CoreArmAnatomy } from './anatomy';
import { type ArmFollowed, CoreArmTransaction } from './arm-transaction';
import { CoreCharacterFrame } from './frame';
import { RigHandle } from './handle';
import { LIMITS_REFUSED, READING_LABELS, solverOffReason } from './labels';
import { buildCoreProfile } from './profile';
import {
  type MutableContext,
  readContext,
  readSolution,
  readVec,
  sideCode,
  writeContext,
  writeForward,
  writeQuat,
  writeSolution,
  writeSpec,
  writeVec,
} from './records';
import {
  arrayView,
  float64View,
  heap,
  matrix3View,
  rebindHeap,
  recordView,
  vector3View,
} from './views';

/** Frees the core's half of a rig dropped without `dispose()`. */
const finalizer = handleFinalizer((c, h) => c.hd_rig_free(h));

const CONTACT_SURFACES = { center: SURFACE_CENTER, pad: SURFACE_PAD, back: SURFACE_BACK } as const;

/** The prediction `predictHandContact` returns, live over one side's record. */
interface ContactPrediction {
  readonly contact: Readonly<THREE.Vector3>;
  readonly shape: readonly THREE.Vector3[];
  readonly bindFrame: Readonly<THREE.Matrix3>;
}

/** What motion reads off an arm driver. */
interface CoreArmDriver {
  readonly acceptedQ: Float64Array;
}

function makeContext(side: Side): MutableContext {
  return {
    side,
    shoulder: new THREE.Vector3(),
    upperLength: 0,
    lowerLength: 0,
    up: new THREE.Vector3(),
    right: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    upperParentWorld: new THREE.Quaternion(),
  };
}

function acceptedArmStateView(address: number): AcceptedArmState {
  const at = address / 8;
  const directions = {} as Record<ArmSlot, Vec3Tuple>;
  for (const [k, slot] of ARM_SLOTS.entries()) {
    directions[slot] = arrayView(address + 8 * (ARM_STATE_DIRECTIONS + VEC3 * k), 3) as Vec3Tuple;
  }
  const state = {
    directions,
    palm: arrayView(address + 8 * ARM_STATE_PALM, 3) as Vec3Tuple,
    curls: recordView(address + 8 * ARM_STATE_CURLS, FINGERS) as Record<FingerName, number>,
    spread: recordView(address + 8 * ARM_STATE_SPREAD, FINGERS) as Record<FingerName, number>,
  } as AcceptedArmState;
  Object.defineProperty(state, 'forearmRoll', {
    enumerable: true,
    get: () => heap()[at + ARM_STATE_FOREARM_ROLL],
    set: (v: number) => {
      heap()[at + ARM_STATE_FOREARM_ROLL] = v;
    },
  });
  return state;
}

function handPoseView(address: number): HandSensePose {
  const field = (k: number) => vector3View(address + 8 * VEC3 * k);
  return {
    knuckle: field(0),
    palm: field(1),
    forearm: field(2),
    index: field(3),
    little: field(4),
  };
}

/** One view per core address, made on first sight. */
function memo<T>(make: (address: number) => T): (address: number) => T {
  const seen = new Map<number, T>();
  return (address) => {
    let view = seen.get(address);
    if (view === undefined) {
      view = make(address);
      seen.set(address, view);
    }
    return view;
  };
}

export class CoreRig {
  readonly p: Profile;
  readonly joints: JointTable;
  readonly anat: CoreArmAnatomy;
  /** Why the constrained arm solver is off, one line per side; see `Rig.armSolverOff`. */
  readonly armSolverOff: string[] = [];
  /** Palm normal in hand-bone space, per side that has one. */
  readonly palmLocal: Partial<Record<Side, THREE.Vector3>> = {};
  /** Total pronation, both bones. */
  readonly foreRoll: Record<Side, number>;
  /** Axial twist given to the humerus. */
  readonly upperRoll: Record<Side, number>;

  readonly #rig: RigHandle;
  readonly #layout: Uint32Array;
  readonly #frame: CoreCharacterFrame;
  readonly #transactions = new Set<CoreArmTransaction>();
  readonly #contexts: Record<Side, MutableContext> = { L: makeContext('L'), R: makeContext('R') };
  readonly #predictions: Partial<Record<Side, ContactPrediction>> = {};
  readonly #drivers: Partial<Record<Side, CoreArmDriver>> = {};
  readonly #shapes: Record<Side, THREE.Vector3[]> = { L: [], R: [] };
  readonly #armStates = memo(acceptedArmStateView);
  readonly #handPoses = memo(handPoseView);
  readonly #fingerFrames = memo(matrix3View);
  #fingerAxis: Map<THREE.Bone, THREE.Vector3> | null = null;
  #fingerSplayAxis: Map<THREE.Bone, THREE.Vector3> | null = null;

  constructor(profile: Profile) {
    this.p = profile;
    this.joints = profile.anatomy ?? JOINTS;
    const graph = SceneGraph.of(profile.root);
    const c = core();
    // The TS rig's first step, so the measurement below reads the pose the TS rig measures.
    profile.root.updateWorldMatrix(true, true);
    const p = buildCoreProfile(profile, graph);
    const h = graph.run((scene) => allocating(() => c.hd_rig_new(scene, p)));
    rebindHeap();
    const layout = new Uint32Array(core().memory.buffer, c.hd_rig_layout(h), LAYOUT).slice();
    this.#layout = layout;
    const rig = new RigHandle(h, graph, layout[LAYOUT_SCRATCH] / 8);
    this.#rig = rig;
    finalizer.register(this, h);

    this.anat = new CoreArmAnatomy(rig, layout);
    this.#frame = new CoreCharacterFrame(rig);
    this.foreRoll = recordView(layout[LAYOUT_FORE_ROLL], SIDES);
    this.upperRoll = recordView(layout[LAYOUT_UPPER_ROLL], SIDES);
    for (const [s, side] of SIDES.entries()) {
      const palm = layout[LAYOUT_PALM_LOCAL_L + s];
      if (palm !== 0) this.palmLocal[side] = vector3View(palm);
    }
    const off = new Uint32Array(
      core().memory.buffer,
      layout[LAYOUT_ARM_SOLVER_OFF],
      SOLVER_OFF * layout[LAYOUT_ARM_SOLVER_OFF_COUNT],
    );
    for (let k = 0; k < layout[LAYOUT_ARM_SOLVER_OFF_COUNT]; k++) {
      const [side, reason, refusal, calibration] = off.subarray(SOLVER_OFF * k);
      this.armSolverOff.push(`${SIDES[side]}: ${solverOffReason(reason, refusal, calibration)}`);
    }
  }

  /** Free the core's half, transactions first. Idempotent. */
  dispose(): void {
    const rig = this.#rig;
    if (rig.freed) return;
    for (const t of this.#transactions) t.dispose();
    this.#transactions.clear();
    const h = rig.h;
    rig.release();
    finalizer.unregister(this);
    allocating(() => core().hd_rig_free(h));
  }

  /** The character frame over this rig's anatomy; the same instance on every read. */
  get characterFrame(): CoreCharacterFrame {
    return this.#frame;
  }

  /** A constrained arm commit over this rig, reading the followed records in `output`. */
  armTransaction(arm: ArmResolver, output: ArmFollowed, leadFloor: number): CoreArmTransaction {
    const t = new CoreArmTransaction(this.#rig, arm, output, leadFloor);
    this.#transactions.add(t);
    return t;
  }

  get limitsEnabled(): boolean {
    return this.#rig.direct((c, h) => c.hd_rig_limits_enabled(h)) === 1;
  }

  set limitsEnabled(on: boolean) {
    const code = this.#rig.run((c, h) => c.hd_rig_set_limits_enabled(h, on ? 1 : 0));
    if (code === LIMITS_NO_FEASIBLE_POSE) throw new Error(LIMITS_REFUSED);
  }

  /** Seconds since the last frame, for the limiter's slew. */
  get dt(): number {
    return this.#rig.direct((c, h) => c.hd_rig_dt(h));
  }

  set dt(dt: number) {
    this.#rig.direct((c, h) => c.hd_rig_set_dt(h, dt));
  }

  get externalArmRevision(): number {
    return this.#rig.direct((c, h) => c.hd_rig_external_arm_revision(h));
  }

  /** Curl axis per finger bone, in that bone's own space. */
  get fingerAxis(): Map<THREE.Bone, THREE.Vector3> {
    this.#fingerAxis ??= this.#axisMap((c, h, node) => c.hd_rig_finger_axis(h, node));
    return this.#fingerAxis;
  }

  /** Splay axis for proximal finger bones, in that bone's own space. */
  get fingerSplayAxis(): Map<THREE.Bone, THREE.Vector3> {
    this.#fingerSplayAxis ??= this.#axisMap((c, h, node) => c.hd_rig_finger_splay_axis(h, node));
    return this.#fingerSplayAxis;
  }

  acceptedArmState(side: Side): Readonly<AcceptedArmState> {
    const s = sideCode(side);
    return this.#armStates(this.#rig.direct((c, h) => c.hd_rig_accepted_arm_state(h, s)));
  }

  bootstrapStandingPose(poses: Record<Side, StandingArmPose>): boolean {
    const r = this.#rig;
    const f = r.s();
    let bits = 0;
    for (const [k, side] of SIDES.entries()) {
      const pose = poses[side];
      const at = r.scratch + STANDING * k;
      writeVec(f, at, pose.shoulder);
      writeVec(f, at + 3, pose.upperArm);
      writeVec(f, at + 6, pose.lowerArm);
      writeVec(f, at + 9, pose.hand);
      writeVec(f, at + 12, pose.palm);
      bits |= writeSpec(f, at + 15, pose.curls) << (10 * k);
      bits |= writeSpec(f, at + 20, pose.spread) << (10 * k + 5);
    }
    // Allocating on its first call; see the construction table in `src/core/abi/rig.ts`.
    return r.run((c, h) => allocating(() => c.hd_rig_bootstrap_standing_pose(h, bits))) === 1;
  }

  armStateForBodyInitialization(side: Side): Readonly<AcceptedArmState> {
    const s = sideCode(side);
    return this.#armStates(
      this.#rig.run((c, h) => c.hd_rig_arm_state_for_body_initialization(h, s)),
    );
  }

  armDriver(side: Side): CoreArmDriver | null {
    const s = sideCode(side);
    const address = this.#rig.direct((c, h) => c.hd_rig_arm_driver(h, s));
    if (address === 0) return null;
    let driver = this.#drivers[side];
    if (!driver) {
      driver = {} as CoreArmDriver;
      float64View(driver, 'acceptedQ', address, 7);
      this.#drivers[side] = driver;
    }
    return driver;
  }

  /** Borrowed metric hand-bone geometry; valid until the next prediction for this side. */
  predictHandContact(
    side: Side,
    selector: HandContact,
    curls: FingerSpec,
    spread: FingerSpec,
  ): ContactPrediction | null {
    const r = this.#rig;
    const s = sideCode(side);
    const f = r.s();
    const curlBits = writeSpec(f, r.scratch, curls);
    const spreadBits = writeSpec(f, r.scratch + SCRATCH_SPREAD, spread);
    const surface = selector.surface ? CONTACT_SURFACES[selector.surface] : SURFACE_NONE;
    const ok =
      selector.kind === 'palm'
        ? r.run((c, h) =>
            c.hd_rig_predict_hand_contact(
              h,
              s,
              CONTACT_PALM,
              selector.region === 'heel' ? REGION_HEEL : REGION_CENTER,
              0,
              surface,
              0,
              curlBits,
              spreadBits,
            ),
          )
        : r.run((c, h) =>
            c.hd_rig_predict_hand_contact(
              h,
              s,
              CONTACT_FINGER,
              FINGERS.indexOf(selector.finger),
              selector.segment,
              surface,
              selector.fraction,
              curlBits,
              spreadBits,
            ),
          );
    if (ok !== 1) return null;
    let prediction = this.#predictions[side];
    if (!prediction) {
      const layout = this.#layout;
      const first = layout[LAYOUT_SHAPE_L + s];
      const stride = layout[LAYOUT_SHAPE_STRIDE];
      prediction = {
        contact: vector3View(layout[LAYOUT_CONTACT_L + s]),
        shape: Array.from({ length: layout[LAYOUT_SHAPE_COUNT_L + s] }, (_, k) =>
          vector3View(first + stride * k),
        ),
        bindFrame: matrix3View(layout[LAYOUT_BIND_FRAME_L + s]),
      };
      this.#predictions[side] = prediction;
    }
    return prediction;
  }

  /** Body uses one shared support decision for both arms at the start of a frame. */
  beginBodyArmFrame(): boolean {
    return this.#rig.run((c, h) => c.hd_rig_begin_body_arm_frame(h)) === 1;
  }

  /** Re-seed only after a complete legacy frame has been rendered. */
  finishLegacyBodyFrame(rise: number, turn = 0): void {
    this.#rig.run((c, h) => c.hd_rig_finish_legacy_body_frame(h, rise, turn));
  }

  /** Refresh and return this side's reusable FK frame. */
  armForwardContext(side: Side): ArmForwardContext | null {
    const s = sideCode(side);
    return this.#context(
      side,
      this.#rig.run((c, h) => c.hd_rig_arm_forward_context(h, s)),
    );
  }

  /** @internal Read synchronously after applyBodyContext has refreshed the scene. */
  armForwardContextFromUpdatedBody(side: Side): ArmForwardContext | null {
    const s = sideCode(side);
    return this.#context(
      side,
      this.#rig.run((c, h) => c.hd_rig_arm_forward_context_from_updated_body(h, s)),
    );
  }

  /** Capture the once-followed body context that candidate arms will use. */
  captureProposedBodyContext(rise: number, turn = 0): void {
    this.#rig.run((c, h) => c.hd_rig_capture_proposed_body_context(h, rise, turn));
  }

  /** Rebuild articulation and common airborne transport with separate progress. */
  applyBodyContext(alpha: number, transportProgress = alpha, afterPlant = false): number {
    const after = afterPlant ? 1 : 0;
    return this.#rig.run((c, h) => c.hd_rig_apply_body_context(h, alpha, transportProgress, after));
  }

  stageArmForward(
    side: Side,
    forward: ArmForwardResult,
    curls: FingerSpec,
    spread: FingerSpec,
  ): boolean {
    const r = this.#rig;
    const s = sideCode(side);
    const f = r.s();
    writeForward(f, r.scratch, forward);
    const curlBits = writeSpec(f, r.scratch + SCRATCH_STAGE_CURLS, curls);
    const spreadBits = writeSpec(f, r.scratch + SCRATCH_STAGE_SPREAD, spread);
    return r.run((c, h) => c.hd_rig_stage_arm_forward(h, s, curlBits, spreadBits)) === 1;
  }

  /** Apply and accept both sides only after the common-alpha frame is complete. */
  commitArmFrame(
    plans: Record<Side, ArmFrameSideCommit>,
    rise: number,
    turn = 0,
    afterPlant = false,
  ): boolean {
    const r = this.#rig;
    const f = r.s();
    let bits = 0;
    for (const [k, side] of SIDES.entries()) {
      const plan = plans[side];
      const at = r.scratch + SIDE_COMMIT * k;
      f.set(plan.output.q.subarray(0, 7), at);
      writeForward(f, at + 7, plan.output.forward);
      writeContext(f, at + 7 + FORWARD, plan.context);
      bits |= writeSpec(f, at + 7 + FORWARD + CONTEXT, plan.curls) << (10 * k);
      bits |= writeSpec(f, at + 7 + FORWARD + CONTEXT + 5, plan.spread) << (10 * k + 5);
    }
    const after = afterPlant ? 1 : 0;
    return r.run((c, h) => c.hd_rig_commit_arm_frame(h, rise, turn, after, bits)) === 1;
  }

  /** Accept only the common signed jump translation; see `Rig.commitArmTransport`. */
  commitArmTransport(lift: number, turn = 0, afterPlant = false): boolean {
    const after = afterPlant ? 1 : 0;
    return this.#rig.run((c, h) => c.hd_rig_commit_arm_transport(h, lift, turn, after)) === 1;
  }

  lastAcceptedHandPose(side: Side): Readonly<HandSensePose> | null {
    const s = sideCode(side);
    const address = this.#rig.direct((c, h) => c.hd_rig_last_accepted_hand_pose(h, s));
    return address === 0 ? null : this.#handPoses(address);
  }

  /** Start a frame: every controlled bone back to its rest orientation. */
  reset(): void {
    this.#rig.run((c, h) => c.hd_rig_reset(h));
  }

  /** Accumulate a small additive rotation on a spine-chain slot (radians). */
  addOffset(slot: OffsetSlot, x: number, y: number, z: number): void {
    const code = OFFSET_SLOTS.indexOf(slot);
    if (code < 0) throw new Error(`CoreRig: unknown offset slot ${slot}`);
    this.#rig.direct((c, h) => c.hd_rig_add_offset(h, code, x, y, z));
  }

  /** Bake accumulated spine offsets into local quaternions. */
  commitSpine(): void {
    this.#rig.run((c, h) => c.hd_rig_commit_spine(h));
  }

  readHeadOffset(out: THREE.Quaternion): boolean {
    const r = this.#rig;
    writeQuat(r.s(), r.scratch, out);
    const ok = r.run((c, h) => c.hd_rig_read_head_offset(h)) === 1;
    const f = r.s();
    const s = r.scratch;
    out.set(f[s], f[s + 1], f[s + 2], f[s + 3]);
    return ok;
  }

  commitEyes(): void {
    this.#rig.run((c, h) => c.hd_rig_commit_eyes(h));
  }

  /** Keep standing feet planted, or carry their contact points through a hop. */
  plantLegs(rise: number, turn = 0, afterPlant = false): void {
    const after = afterPlant ? 1 : 0;
    this.#rig.run((c, h) => c.hd_rig_plant_legs(h, rise, turn, after));
  }

  /** See `ShoulderGirdle.girdleRoom`. */
  girdleRoom(
    side: Side,
    targetWorld: THREE.Vector3,
    dir: Vec3Tuple,
    weight: number,
    turnOut: THREE.Vector3,
  ): void {
    const r = this.#rig;
    const s = sideCode(side);
    const f = r.s();
    writeVec(f, r.scratch, dir);
    writeVec(f, r.scratch + 3, turnOut);
    const { x, y, z } = targetWorld;
    r.run((c, h) => c.hd_rig_girdle_room(h, s, x, y, z, weight));
    readVec(r.s(), r.scratch + 3, turnOut);
  }

  /** See `ShoulderGirdle.turnGirdle`. */
  turnGirdle(dir: Vec3Tuple, turn: THREE.Vector3): void {
    const r = this.#rig;
    const f = r.s();
    writeVec(f, r.scratch, dir);
    writeVec(f, r.scratch + 3, turn);
    r.direct((c, h) => c.hd_rig_turn_girdle(h));
    dir[0] = f[r.scratch];
    dir[1] = f[r.scratch + 1];
    dir[2] = f[r.scratch + 2];
  }

  /** Pose the shoulder alone; see `Rig.aimShoulder`. */
  aimShoulder(side: Side, dir: Vec3Tuple | THREE.Vector3 | null): void {
    const s = sideCode(side);
    if (!dir) {
      this.#rig.run((c, h) => c.hd_rig_aim_shoulder(h, s, 0, 0, 0, 0));
      return;
    }
    const [x, y, z] = Array.isArray(dir) ? dir : [dir.x, dir.y, dir.z];
    this.#rig.run((c, h) => c.hd_rig_aim_shoulder(h, s, 1, x, y, z));
  }

  /** @returns false when a constrained side rejected the request; see `Rig.aimArm`. */
  aimArm(
    side: Side,
    dirs: Record<ArmSlot, Vec3Tuple>,
    twist = 0,
    palmTarget: Vec3Tuple | null = null,
    palmWeight = 1,
  ): boolean {
    const s = sideCode(side);
    const [bits, palm] = this.#aimInputs(dirs, palmTarget);
    return this.#rig.run((c, h) => c.hd_rig_aim_arm(h, s, bits, twist, palm, palmWeight)) === 1;
  }

  /** Legacy single-chain path, used only when limiting is explicitly disabled or unsupported. */
  aimArmLegacy(
    side: Side,
    dirs: Record<ArmSlot, Vec3Tuple>,
    twist = 0,
    palmTarget: Vec3Tuple | null = null,
    palmWeight = 1,
  ): void {
    const s = sideCode(side);
    const [bits, palm] = this.#aimInputs(dirs, palmTarget);
    this.#rig.run((c, h) => c.hd_rig_aim_arm_legacy(h, s, bits, twist, palm, palmWeight));
  }

  /** Measure one arm as it currently stands, for the panel. Allocates. */
  measure(side: Side): JointReading[] | null {
    const s = sideCode(side);
    if (this.#rig.run((c, h) => c.hd_rig_measure(h, s)) !== 1) return null;
    const f = heap();
    const at = this.#layout[LAYOUT_READINGS] / 8;
    return READING_IDS.map((id, k) => {
      const o = at + READING * k;
      const percent = f[o + 2] !== 0;
      const reading: JointReading = {
        id,
        label: READING_LABELS[k],
        deg: f[o + 1],
        ...(percent ? { unit: '%' } : {}),
        strain: f[o + 3],
        zone: ZONES[f[o + 4]],
        range: [f[o + 5], f[o + 6]],
        measured: f[o + 7] !== 0,
      };
      return reading;
    });
  }

  /** Reach a wrist to a world position, choosing the elbow; see `Rig.solveReachNatural`. */
  solveReachNatural(
    side: Side,
    targetWorld: THREE.Vector3,
    handDir: THREE.Vector3 | null,
    out: ArmSolution,
    pole: THREE.Vector3 | null = null,
  ): ArmSolution | null {
    const r = this.#rig;
    const s = sideCode(side);
    const f = r.s();
    writeVec(f, r.scratch, targetWorld);
    if (handDir) writeVec(f, r.scratch + 3, handDir);
    if (pole) writeVec(f, r.scratch + 6, pole);
    writeSolution(f, r.scratch + SCRATCH_SOLUTION, out);
    const hasHand = handDir ? 1 : 0;
    const hasPole = pole ? 1 : 0;
    const ok = r.run((c, h) => c.hd_rig_solve_reach_natural(h, s, hasHand, hasPole));
    readSolution(r.s(), r.scratch + SCRATCH_SOLUTION, out);
    return ok === 1 ? out : null;
  }

  /** Back-solve an arm from a fingertip; see `Rig.solvePoint`. */
  solvePoint(side: Side, spec: PointRequest, out: ArmSolution): ArmSolution | null {
    const r = this.#rig;
    const s = sideCode(side);
    const f = r.s();
    const at = r.scratch;
    let bits = 0;
    const scalar = (v: number | null | undefined, k: number, bit: number) => {
      if (v === undefined || v === null) return;
      f[at + k] = v;
      bits |= bit;
    };
    scalar(spec.azimuth, 0, POINT_AZIMUTH);
    scalar(spec.elevation, 1, POINT_ELEVATION);
    scalar(spec.extent, 2, POINT_EXTENT);
    if (spec.point) {
      writeVec(f, at + 3, spec.point);
      bits |= POINT_POINT;
    }
    if (spec.palm) {
      writeVec(f, at + 6, spec.palm);
      bits |= POINT_PALM;
    }
    const finger = spec.finger === undefined ? NO_NODE : FINGERS.indexOf(spec.finger);
    writeSolution(f, at + SCRATCH_SOLUTION, out);
    const ok = r.run((c, h) => c.hd_rig_solve_point(h, s, bits, finger));
    readSolution(r.s(), at + SCRATCH_SOLUTION, out);
    return ok === 1 ? out : null;
  }

  /** Solve a two-link reach so the wrist lands on `targetWorld`; see `Rig.solveReach`. */
  solveReach(
    side: Side,
    targetWorld: THREE.Vector3,
    elbowAngle: number,
    out: ReachLinks,
    framed?: boolean,
  ): ReachLinks | null {
    const r = this.#rig;
    const s = sideCode(side);
    const f = r.s();
    writeVec(f, r.scratch, targetWorld);
    writeVec(f, r.scratch + 3, out.upperArm);
    writeVec(f, r.scratch + 6, out.lowerArm);
    const tri = framed === undefined ? TRI_UNSET : framed ? TRI_TRUE : TRI_FALSE;
    const ok = r.run((c, h) => c.hd_rig_solve_reach(h, s, elbowAngle, tri));
    readVec(r.s(), r.scratch + 3, out.upperArm);
    readVec(r.s(), r.scratch + 6, out.lowerArm);
    return ok === 1 ? out : null;
  }

  /** @returns false when a constrained side rejected the shape, as `aimArm`. */
  curlFinger(name: FingerName, side: Side, amount: number): boolean {
    const finger = FINGERS.indexOf(name);
    const s = sideCode(side);
    return this.#rig.run((c, h) => c.hd_rig_curl_finger(h, finger, s, amount)) === 1;
  }

  /** @returns false when a constrained side rejected the shape, as `aimArm`. */
  curlHand(side: Side, spec: FingerSpec, spread: FingerSpec = {}): boolean {
    const s = sideCode(side);
    const [specBits, spreadBits] = this.#hand(spec, spread);
    return this.#rig.run((c, h) => c.hd_rig_curl_hand(h, s, specBits, spreadBits)) === 1;
  }

  /** Legacy direct finger write, used by Body only for an explicit limiter opt-out. */
  curlFingerLegacy(name: FingerName, side: Side, amount: number): void {
    const finger = FINGERS.indexOf(name);
    const s = sideCode(side);
    this.#rig.run((c, h) => c.hd_rig_curl_finger_legacy(h, finger, s, amount));
  }

  /** Legacy direct hand write, used by Body only for an explicit limiter opt-out. */
  curlHandLegacy(side: Side, spec: FingerSpec, spread: FingerSpec = {}): void {
    const s = sideCode(side);
    const [specBits, spreadBits] = this.#hand(spec, spread);
    this.#rig.run((c, h) => c.hd_rig_curl_hand_legacy(h, s, specBits, spreadBits));
  }

  /** How far off the skin a finger's bones are held. */
  fingerClearance(side: Side): number {
    const s = sideCode(side);
    return this.#rig.direct((c, h) => c.hd_rig_finger_clearance(h, s));
  }

  /** The hand's finger joints and tips as last posed; see `Rig.fingerShape`. */
  fingerShape(side: Side): readonly THREE.Vector3[] {
    const s = sideCode(side);
    const count = this.#rig.direct((c, h) => c.hd_rig_finger_shape(h, s));
    const shape = this.#shapes[side];
    const first = this.#layout[LAYOUT_FINGER_SHAPE_L + s];
    while (shape.length < count) shape.push(vector3View(first + 8 * VEC3 * shape.length));
    shape.length = count;
    return shape;
  }

  /** The world frame the hand reached when `fingerShape` was recorded. */
  fingerFrame(side: Side): Readonly<THREE.Matrix3> {
    const s = sideCode(side);
    return this.#fingerFrames(this.#rig.direct((c, h) => c.hd_rig_finger_frame(h, s)));
  }

  #context(side: Side, present: number): ArmForwardContext | null {
    if (present !== 1) return null;
    return readContext(heap(), this.#rig.scratch, this.#contexts[side]);
  }

  #aimInputs(dirs: Record<ArmSlot, Vec3Tuple>, palmTarget: Vec3Tuple | null): [number, number] {
    const r = this.#rig;
    const f = r.s();
    let bits = 0;
    for (const [k, slot] of ARM_SLOTS.entries()) {
      const dir = dirs[slot];
      if (!dir) continue;
      writeVec(f, r.scratch + 3 * k, dir);
      bits |= 1 << k;
    }
    if (palmTarget) writeVec(f, r.scratch + 12, palmTarget);
    return [bits, palmTarget ? 1 : 0];
  }

  #hand(spec: FingerSpec, spread: FingerSpec): [number, number] {
    const r = this.#rig;
    const f = r.s();
    return [writeSpec(f, r.scratch, spec), writeSpec(f, r.scratch + SCRATCH_SPREAD, spread)];
  }

  #axisMap(read: (c: Core, h: number, node: number) => number): Map<THREE.Bone, THREE.Vector3> {
    const map = new Map<THREE.Bone, THREE.Vector3>();
    const graph = this.#rig.graph;
    for (const chain of Object.values(this.p.fingerBones)) {
      for (const bone of chain ?? []) {
        const address = this.#rig.direct((c, h) => read(c, h, graph.indexOf(bone)));
        if (address !== 0) map.set(bone, vector3View(address));
      }
    }
    return map;
  }
}
