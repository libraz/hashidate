import * as THREE from 'three';
import {
  ArmAnatomy,
  FINGER_WIDTH,
  HAND_CONTACT,
  JOINTS,
  rollRoom,
  rotationTrust,
} from '../anatomy';
import type { HandSensePose } from '../motion/finger-life';
import type {
  ArmSlot,
  FingerName,
  FingerSpec,
  JointReading,
  JointTable,
  Profile,
  Side,
  Vec3Tuple,
} from '../types';
import type { ArmConfiguration, ArmForwardContext, ArmForwardResult } from './arm-configuration';
import { PRONATION_SPLIT } from './arm-configuration';
import {
  ArmDriver,
  type ArmDriverAcceptedSnapshot,
  FRAME_TOLERANCE,
  LIMIT_SLEW,
  positiveConformalScale,
} from './arm-driver';
import type { ArmPathPlanOutput } from './arm-path';
import { ElbowSearch } from './elbow';
import { FINGER_TIP_EXTENSION } from './hand-geometry';
import { Hands } from './hands';
import { GroundedLegs } from './legs';
import { type PointRequest, PointSolver, worldDirection } from './point';
import type { ArmSolution, ReachLinks } from './reach';
import { solveReach } from './reach';
import { type OffsetSlot, SpineOffsets } from './spine';

/**
 * Bone layer.
 *
 * Poses are expressed as *world-space direction targets* for each limb rather
 * than local Euler angles. Rest orientations differ wildly between avatars, so
 * "point the forearm down and slightly forward" ports across rigs while
 * "rotate 72 degrees about local X" does not.
 *
 * Per frame the caller resets to the rest pose, stacks additive offsets for the
 * spine chain, then aims the arm chains parent-first.
 *
 * What is here is the arm: aiming a chain, keeping it inside its anatomical
 * stops, and spending the roll that turns a palm over. The four questions that
 * are not the arm's are beside it — `spine.ts` for the additive half of a
 * frame, `hands.ts` for the fingers, `elbow.ts` for where the elbow goes once a
 * wrist position is fixed, and `point.ts` for turning a fingertip bearing into
 * a wrist target. `legs.ts` adds optional standing contact before those arm
 * targets are solved, so a pelvis correction also moves their reach origins.
 */

const _q = new THREE.Quaternion();
const _local = new THREE.Quaternion();
const _twistQ = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _gC = new THREE.Vector3();
const _gS = new THREE.Vector3();
const _gA = new THREE.Vector3();
const _gB = new THREE.Vector3();
const _gX = new THREE.Vector3();
// How far the clavicle may turn to get the arm room. The sternoclavicular joint
// gives roughly ten degrees of depression and twenty of retraction, and a swing
// away from a target in front of the face is a mix of the two.
const GIRDLE_ROM = 0.38;
const _slewAxis = new THREE.Vector3();
const _slewPerp = new THREE.Vector3();
const _palmCur = new THREE.Vector3();
const _palmWant = new THREE.Vector3();
const _palmAxis = new THREE.Vector3();
const _hingeFront = new THREE.Vector3();
const _hingeFold = new THREE.Vector3();
const _hingeAxis = new THREE.Vector3();
const FINGER_NAMES: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];
/** Turns per hand per frame: the later ones catch a finger an earlier one brought in. */
const FINGER_PASSES = 3;
/** Damping on the fingers' turn, in squared finger half-thicknesses. */
const FINGER_DAMP = 0.01;
/**
 * Most a hand turns in a frame to clear its fingers: the span of the wrist's
 * narrowest comfortable range. A correction, not a pose — a hand set inside the
 * face needs its arm moved, and turned further it only folded the wrist.
 */
const FINGER_TURN_MAX = JOINTS.wrist.dofs.deviation.free[1] - JOINTS.wrist.dofs.deviation.free[0];
const _fW = new THREE.Vector3();
const _fP = new THREE.Vector3();
const _fT = new THREE.Vector3();
const _fU = new THREE.Vector3();
const _fN = new THREE.Vector3();
const _fG = new THREE.Vector3();
const _fB = new THREE.Vector3();
const _fA = new THREE.Matrix3();
const _fTurn = new THREE.Quaternion();
const _fParent = new THREE.Quaternion();
const _fLocal = new THREE.Quaternion();
const _fFrame = new THREE.Matrix3();
/** Trial flexion that measures a curl's lever on a finger's points. */
const FINGER_CURL_PROBE = 0.05;
const _fSpec: FingerSpec = {};
const _fIn = Array.from({ length: 5 }, () => ({
  p: new THREE.Vector3(),
  n: new THREE.Vector3(),
  d: 0,
  i: 0,
}));
const _armS = new THREE.Vector3();
const _fixDir = new THREE.Vector3();
// Stands in for a bone that was never given a rest orientation, which cannot
// happen for a bone the profile resolved. Only ever read.
const _restFallback = new THREE.Quaternion();
/**
 * The palm constraint one aim is solved against: the palm normal in hand-bone
 * space, where it should end up in world space, and how hard to insist.
 */
interface PalmSpec {
  local: THREE.Vector3;
  target: THREE.Vector3;
  weight: number;
}

type BodySnapshotSlot = 'hips' | 'spine' | 'chest' | 'neck' | 'head' | 'shoulder.L' | 'shoulder.R';

const BODY_SNAPSHOT_SLOTS: readonly BodySnapshotSlot[] = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulder.L',
  'shoulder.R',
];

/** The small body context reconstructed for each arm feasibility sample. */
export interface RigBodyPoseSnapshot {
  readonly slots: Partial<Record<BodySnapshotSlot, THREE.Quaternion>>;
  readonly hipsPosition: THREE.Vector3;
  rise: number;
}

export interface ArmFrameSideCommit {
  readonly output: ArmPathPlanOutput;
  readonly context: ArmForwardContext;
  readonly curls: FingerSpec;
  readonly spread: FingerSpec;
}

/** One side of the default pose Body may install before its first frame. */
export interface StandingArmPose {
  readonly shoulder: THREE.Vector3;
  readonly upperArm: THREE.Vector3;
  readonly lowerArm: THREE.Vector3;
  readonly hand: THREE.Vector3;
  readonly palm: THREE.Vector3;
  readonly curls: FingerSpec;
  readonly spread: FingerSpec;
}

/** The last displayed arm frame, in the character coordinates Body follows. */
export interface AcceptedArmState {
  readonly directions: Record<ArmSlot, Vec3Tuple>;
  readonly palm: Vec3Tuple;
  readonly curls: Record<FingerName, number>;
  readonly spread: Record<FingerName, number>;
  forearmRoll: number;
}

function makeAcceptedArmState(): AcceptedArmState {
  return {
    directions: {
      shoulder: [0, 0, 0],
      upperArm: [0, 0, 0],
      lowerArm: [0, 0, 0],
      hand: [0, 0, 0],
    },
    palm: [0, 0, 0],
    curls: { thumb: 0, index: 0, middle: 0, ring: 0, little: 0 },
    spread: { thumb: 0, index: 0, middle: 0, ring: 0, little: 0 },
    forearmRoll: 0,
  };
}

interface MutableArmForwardContext {
  side: Side;
  shoulder: THREE.Vector3;
  upperLength: number;
  lowerLength: number;
  up: THREE.Vector3;
  right: THREE.Vector3;
  forward: THREE.Vector3;
  upperParentWorld: THREE.Quaternion;
}

interface ArmFrameCarrier {
  readonly object: THREE.Object3D;
  readonly scale: number;
}

interface ArmFrameSnapshot {
  readonly carriers: ArmFrameCarrier[];
  valid: boolean;
}

function makeArmFrameSnapshot(): ArmFrameSnapshot {
  return { carriers: [], valid: false };
}

function makeArmContext(side: Side): MutableArmForwardContext {
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

const _palmSpec: PalmSpec = {
  local: new THREE.Vector3(),
  target: new THREE.Vector3(),
  weight: 1,
};

/**
 * Joint limits are anatomy, and live in `anatomy/`.
 *
 * What used to be here was a cone: each link could deviate from the one above
 * it by so many radians, whatever direction it deviated in. That bounded the
 * damage without needing to know a rotation axis — which is real, axes differ
 * per rig — but it cannot tell flexion from extension, so it permitted 75
 * degrees of radial deviation at a wrist whose actual range is 20, and it had
 * no opinion at all about an elbow bending sideways.
 *
 * The replacement measures the pose against a body frame derived from the rig's
 * own geometry, so it stays skeleton-independent while knowing which way is
 * which. See `anatomy/` for the model and for why it carries two bands rather
 * than one bound.
 */

/**
 * Below this the elbow is bent far enough that humeral rotation swings the
 * forearm instead of rolling it, and the shoulder has nothing useful to lend.
 *
 * This is the reason you turn a doorknob by supinating rather than by rotating
 * your shoulder: at a right angle the shoulder's rotation has become a sideways
 * sweep of the whole forearm and does not reach the palm at all.
 */
const ROLL_TRANSFER_MIN = 0.25;
/**
 * The directions the anatomical clamp bounds.
 *
 * No shoulder: the girdle is posed from the pose's own request, and `girdleRoom`
 * is the only thing that moves it.
 */
type LimitedDirs = Partial<Record<ArmSlot, THREE.Vector3>> & {
  upperArm: THREE.Vector3;
  lowerArm: THREE.Vector3;
  hand: THREE.Vector3;
};

/** The three the clamp bounds, in the order the slew walks them. */
const LIMITED_SLOTS = ['upperArm', 'lowerArm', 'hand'] as const;

export type { PointRequest } from './point';
export type { OffsetSlot } from './spine';

export class Rig {
  readonly p: Profile;
  /** bone -> rest quaternion */
  readonly rest = new Map<THREE.Bone, THREE.Quaternion>();

  readonly anat: ArmAnatomy;
  readonly joints: JointTable;

  /** The additive half of a frame: spine and eyes. See `spine.ts`. */
  private readonly spine: SpineOffsets;
  /** Optional standing legs: foot contact is solved before the arms. */
  private readonly legs: GroundedLegs | null;
  /** The fingers, which are curled rather than aimed. See `hands.ts`. */
  private readonly hands: Hands;
  /** Where the elbow goes once a wrist position is fixed. See `elbow.ts`. */
  private readonly elbow: ElbowSearch;
  /** A bearing, back-solved into an arm. See `point.ts`. */
  private readonly point: PointSolver;

  /**
   * Off switch for the anatomical limiting, so a pose can be compared against
   * what the raw geometry produces. Worth keeping: when a gesture looks
   * wrong, the first question is whether the limiter caused it or revealed
   * it, and that is one toggle rather than an afternoon.
   */
  get limitsEnabled(): boolean {
    return this._limitsEnabled;
  }

  set limitsEnabled(on: boolean) {
    if (on === this._limitsEnabled) return;
    if (!on) {
      this._limitsEnabled = false;
      this.invalidateArmContinuation();
      return;
    }

    // Rotations and translation preserve the captured anatomy. A live scale,
    // reflection or shear does not, so keep the legacy path until that metric
    // returns to the one the arm calibration describes.
    if (!this.bothArmFramesSupported()) {
      this._limitsEnabled = true;
      this.invalidateArmContinuation();
      return;
    }

    // The diagnostic path can leave a pose outside the hard box or inside the
    // body. Preflight every supported side before exposing constrained mode;
    // a failed re-seed must leave the displayed and accepted poses untouched.
    if (!this.reseedConstrainedArms()) {
      this._limitsEnabled = false;
      this.invalidateArmContinuation();
      throw new Error('Could not restore a feasible arm pose; anatomical limits remain disabled.');
    }
    this._limitsEnabled = true;
    this._armContinuationReady = true;
    this._heldLimit.L = false;
    this._heldLimit.R = false;
    this._externalArmRevision++;
  }

  private _limitsEnabled = true;

  /**
   * Seconds since the last frame, for the limiter's slew. Written by the body
   * layer at the top of its own update; a caller that poses the rig by hand and
   * never sets it gets the nominal frame, which is what a single-shot pose
   * wants anyway.
   */
  dt = 1 / 60;

  // Two buffers alternated down an arm chain. `aim` reads the parent's world
  // rotation and writes the child's, so the two cannot be the same object —
  // and allocating a fresh quaternion per bone per frame is the kind of
  // steady garbage that surfaces as a dropped frame hours into a stream.
  private readonly _chainQ = [new THREE.Quaternion(), new THREE.Quaternion()];

  // Arm state below the shoulder, held aside rather than threaded through
  // `_chainQ`. Those two buffers alternate down a chain, which is enough when
  // each link is posed once; the roll budget poses the forearm and hand more
  // than once — a trial twist on the humerus has to be paid for and measured
  // — and by then the alternating buffers have been overwritten.
  private readonly _upperParentQ = new THREE.Quaternion();
  private readonly _upperQ = new THREE.Quaternion();
  private readonly _foreQ = new THREE.Quaternion();
  private readonly _handQ = new THREE.Quaternion();
  private readonly _aim: Record<ArmSlot, THREE.Vector3> = {
    shoulder: new THREE.Vector3(),
    upperArm: new THREE.Vector3(),
    lowerArm: new THREE.Vector3(),
    hand: new THREE.Vector3(),
  };
  /** Roll the last palm solve asked for. */
  private _roll = 0;
  /** Each hand's fingers as last posed, in its own frame. See `fingerShape`. */
  private readonly _fingerShape: Record<Side, THREE.Vector3[]> = { L: [], R: [] };
  /** The humerus's front at rest, in its own space: the way the elbow folds. */
  private readonly _humeralFront: Partial<Record<Side, THREE.Vector3>> = {};
  /** What the roll budget delivered last frame, for its slew. See `aimArm`. */
  private readonly _rollHeld: Record<Side, { fore: number; humeral: number; set: boolean }> = {
    L: { fore: 0, humeral: 0, set: false },
    R: { fore: 0, humeral: 0, set: false },
  };

  // Scratch for the anatomical clamp, which needs all three arm directions at
  // once — the chain walk in `aimArm` only ever holds one.
  private readonly _limited: Record<Side, LimitedDirs>;
  // Where the limiter actually left each link last frame, and whether that is
  // known for this side. See `slew`.
  private readonly _held: Record<Side, LimitedDirs>;
  private readonly _heldLimit: Record<Side, boolean> = { L: false, R: false };
  private readonly _palmWorld: Record<Side, THREE.Vector3> = {
    L: new THREE.Vector3(),
    R: new THREE.Vector3(),
  };
  private readonly _armDrivers: Record<Side, ArmDriver | null> = { L: null, R: null };
  private readonly _armFrameSnapshots: Record<Side, ArmFrameSnapshot> = {
    L: makeArmFrameSnapshot(),
    R: makeArmFrameSnapshot(),
  };
  private _armContinuationReady = false;
  private readonly _armContexts: Record<Side, MutableArmForwardContext> = {
    L: makeArmContext('L'),
    R: makeArmContext('R'),
  };
  private readonly _acceptedHandPose: Record<Side, HandSensePose | null> = { L: null, R: null };
  private readonly _acceptedArmState: Record<Side, AcceptedArmState> = {
    L: makeAcceptedArmState(),
    R: makeAcceptedArmState(),
  };
  private readonly _bodyInitializationState: Record<Side, AcceptedArmState> = {
    L: makeAcceptedArmState(),
    R: makeAcceptedArmState(),
  };
  private readonly _posedCurls: Record<Side, Record<FingerName, number>> = {
    L: { thumb: 0, index: 0, middle: 0, ring: 0, little: 0 },
    R: { thumb: 0, index: 0, middle: 0, ring: 0, little: 0 },
  };
  private readonly _posedSpread: Record<Side, Record<FingerName, number>> = {
    L: { thumb: 0, index: 0, middle: 0, ring: 0, little: 0 },
    R: { thumb: 0, index: 0, middle: 0, ring: 0, little: 0 },
  };
  private readonly _acceptedBodyPose: RigBodyPoseSnapshot;
  private readonly _proposedBodyPose: RigBodyPoseSnapshot;
  private _externalArmRevision = 0;
  private _standingBootstrapClaimed = false;
  private _acceptedRise = 0;
  private readonly _actualUpper = new THREE.Vector3();
  private readonly _actualLower = new THREE.Vector3();
  private readonly _actualHand = new THREE.Vector3();
  private readonly _actualPalm = new THREE.Vector3();
  private readonly _applyParentQ = new THREE.Quaternion();
  private readonly _applyLocalQ = new THREE.Quaternion();
  private readonly _applyTargetQ = new THREE.Quaternion();
  private readonly _applySwingQ = new THREE.Quaternion();
  private readonly _measureQ = new THREE.Quaternion();
  private readonly _measureA = new THREE.Vector3();
  private readonly _measureB = new THREE.Vector3();
  private readonly _measureC = new THREE.Vector3();
  private readonly _staticUpper = new THREE.Vector3();
  private readonly _staticLower = new THREE.Vector3();
  private readonly _staticHand = new THREE.Vector3();
  private readonly _staticPalm = new THREE.Vector3();
  private readonly _staticBoundedConfiguration: ArmConfiguration = {
    shoulderPlane: 0,
    shoulderLift: 0,
    humeralRotation: 0,
    elbowFlex: 0,
    forearmRoll: 0,
    wristFlex: 0,
    wristDev: 0,
  };
  private readonly _staticQ = new Float64Array(7);
  private readonly _handPoseScratch: Record<Side, HandSensePose> = {
    L: {
      knuckle: new THREE.Vector3(),
      palm: new THREE.Vector3(),
      forearm: new THREE.Vector3(),
      index: new THREE.Vector3(),
      little: new THREE.Vector3(),
    },
    R: {
      knuckle: new THREE.Vector3(),
      palm: new THREE.Vector3(),
      forearm: new THREE.Vector3(),
      index: new THREE.Vector3(),
      little: new THREE.Vector3(),
    },
  };

  constructor(profile: Profile) {
    this.p = profile;
    profile.root.updateWorldMatrix(true, true);
    this.captureArmFrameMetrics();

    const all = [...Object.values(profile.bones), ...Object.values(profile.fingerBones).flat()];
    for (const b of all) this.rest.set(b, b.quaternion.clone());
    this.spine = new SpineOffsets(profile);
    this.legs = GroundedLegs.create(profile, (bone) => this.restOf(bone));

    this.joints = profile.anatomy ?? JOINTS;
    this.hands = new Hands(profile, this.joints, (bone) => this.restOf(bone));

    // Anatomy has to be built after the finger axes: it reads the same rest
    // geometry to work out which side of the hand the thumb is on.
    this.anat = new ArmAnatomy(profile);
    this.elbow = new ElbowSearch(profile, this.anat, {
      solveReach: (side, target, angle, out, framed) =>
        this.solveReach(side, target, angle, out, framed),
      armContext: (side) => this.armContext(side),
      dt: () => this.dt,
    });
    this.point = new PointSolver(
      profile,
      this.joints,
      this.anat,
      (side, wrist, handDir, palmN, out) => this.elbow.search(side, wrist, handDir, palmN, out),
    );

    const trio = (): LimitedDirs => ({
      upperArm: new THREE.Vector3(),
      lowerArm: new THREE.Vector3(),
      hand: new THREE.Vector3(),
    });
    this._limited = { L: trio(), R: trio() };
    this._held = { L: trio(), R: trio() };

    const chest = profile.bones.chest ?? profile.bones.spine ?? profile.bones.hips;
    for (const side of ['L', 'R'] as Side[]) {
      const upper = profile.bones[`upperArm.${side}`];
      if (!(upper && chest && profile.body)) continue;
      upper.updateWorldMatrix(true, false);
      const q = upper.getWorldQuaternion(new THREE.Quaternion());
      const along = profile.restDir[`upperArm.${side}`].clone().applyQuaternion(q);
      const front = profile.body.forward.clone().applyQuaternion(chest.getWorldQuaternion(_q));
      front.addScaledVector(along, -front.dot(along));
      if (front.lengthSq() > 1e-8)
        this._humeralFront[side] = front.normalize().applyQuaternion(q.invert());
    }

    this._acceptedBodyPose = this.makeBodyPoseSnapshot();
    this._proposedBodyPose = this.makeBodyPoseSnapshot();
    this.captureBodyPose(this._acceptedBodyPose, 0);
    this.captureBodyPose(this._proposedBodyPose, 0);
    for (const side of ['L', 'R'] as Side[]) {
      const palmLocal = this.palmLocal[side];
      const humeralFront = this._humeralFront[side];
      if (!(palmLocal && humeralFront)) continue;
      const driver = ArmDriver.create({
        profile,
        side,
        joints: this.joints,
        rest: this.rest,
        fingerAxes: this.hands.axis,
        fingerSplayAxes: this.hands.splayAxis,
        palmLocal,
        radialSign: this.anat.radialSign[side],
        humeralFront,
        anatomy: this.anat,
        fingerClearance: this.fingerClearance(side),
      });
      if (!driver) continue;
      const context = this.armForwardContext(side);
      if (!(context && this.readActualArmPose(side))) continue;
      if (
        !driver.seedFromPose(
          context,
          this._actualUpper,
          this._actualLower,
          this._actualHand,
          this._actualPalm,
        )
      )
        continue;
      this._armDrivers[side] = driver;
      this._acceptedHandPose[side] = this.captureHandPose(side);
      this.foreRoll[side] = driver.acceptedConfiguration.forearmRoll;
      this.captureAcceptedArmState(
        side,
        driver.acceptedForward,
        this._posedCurls[side],
        this._posedSpread[side],
      );
    }
    this._armContinuationReady = this.bothArmFramesSupported();
  }

  /** Curl axis per finger bone, in that bone's own space. */
  get fingerAxis(): Map<THREE.Bone, THREE.Vector3> {
    return this.hands.axis;
  }

  /** Splay axis for proximal finger bones, in that bone's own space. */
  get fingerSplayAxis(): Map<THREE.Bone, THREE.Vector3> {
    return this.hands.splayAxis;
  }

  /** Palm normal in hand-bone space. */
  get palmLocal(): Partial<Record<Side, THREE.Vector3>> {
    return this.hands.palmLocal;
  }

  get externalArmRevision(): number {
    return this._externalArmRevision;
  }

  acceptedArmState(side: Side): Readonly<AcceptedArmState> {
    return this._acceptedArmState[side];
  }

  /**
   * Install the default standing pose once, before the first Body frame.
   *
   * This is deliberately a paired static endpoint transaction: no clock or
   * follower has advanced yet, and a partial shoulder/arm pair would make the
   * first displayed pose depend on which side happened to validate first.
   */
  bootstrapStandingPose(poses: Record<Side, StandingArmPose>): boolean {
    if (this._standingBootstrapClaimed) return false;
    this._standingBootstrapClaimed = true;
    if (!(this._externalArmRevision === 0 && this._limitsEnabled && this.bothArmFramesSupported()))
      return false;

    const shoulders: Record<Side, THREE.Quaternion | null> = {
      L: this.p.bones['shoulder.L']?.quaternion.clone() ?? null,
      R: this.p.bones['shoulder.R']?.quaternion.clone() ?? null,
    };
    let committed = false;
    try {
      for (const side of ['L', 'R'] as Side[]) {
        const pose = poses[side];
        if (
          !(
            [pose.shoulder, pose.upperArm, pose.lowerArm, pose.hand, pose.palm].every(
              (direction) =>
                Number.isFinite(direction.x) &&
                Number.isFinite(direction.y) &&
                Number.isFinite(direction.z) &&
                direction.lengthSq() > 1e-12,
            ) &&
            FINGER_NAMES.every((finger) => Number.isFinite(pose.curls[finger])) &&
            FINGER_NAMES.every((finger) => Number.isFinite(pose.spread[finger]))
          )
        ) {
          return false;
        }
        if (!this.canWriteArm(side)) return false;
      }

      // Both clavicles change the shoulder origins, so stage both before
      // capturing either FK context.
      this.aimShoulder('L', poses.L.shoulder);
      this.aimShoulder('R', poses.R.shoulder);
      this.p.root.updateMatrixWorld(true);

      const plans: Partial<Record<Side, ArmFrameSideCommit>> = {};
      for (const side of ['L', 'R'] as Side[]) {
        const pose = poses[side];
        const driver = this._armDrivers[side];
        const context = this.armForwardContext(side);
        if (!(driver && context)) return false;

        driver.captureVolumeFrame();
        const request = driver.composeRequest(
          context,
          pose.upperArm,
          pose.lowerArm,
          pose.hand,
          pose.palm,
          1,
          0,
          pose.curls,
          pose.spread,
          false,
        );
        if (
          !(
            request.palm &&
            driver.configurationFromPose(
              context,
              pose.upperArm,
              pose.lowerArm,
              pose.hand,
              request.palm,
            )
          )
        ) {
          return false;
        }

        let output = driver.output;
        if (!driver.validateLockedPose(driver.targetQ, context, pose.curls, pose.spread, output)) {
          const bounded = driver.boundConfiguration(
            driver.targetConfiguration,
            this._staticBoundedConfiguration,
          );
          driver.configurationToQ(bounded, this._staticQ);
          driver.requestForConfiguration(bounded, context, pose.curls, pose.spread);
          if (!driver.restoreEndpointFrom(this._staticQ, context, 0, false)) return false;
          output = driver.output;
        }
        plans[side] = { output, context, curls: pose.curls, spread: pose.spread };
      }

      const left = plans.L;
      const right = plans.R;
      if (!(left && right && this.commitArmFrame({ L: left, R: right }, this._acceptedRise)))
        return false;

      for (const side of ['L', 'R'] as Side[]) {
        const driver = this._armDrivers[side];
        if (!driver) return false;
        driver.requestRollHistory = driver.acceptedConfiguration.forearmRoll;
      }
      this.captureBodyPose(this._proposedBodyPose, this._acceptedRise);
      committed = true;
      return true;
    } finally {
      if (!committed) {
        for (const side of ['L', 'R'] as Side[]) {
          const shoulder = this.p.bones[`shoulder.${side}`];
          const prior = shoulders[side];
          if (shoulder && prior) shoulder.quaternion.copy(prior);
        }
        this.p.root.updateMatrixWorld(true);
        this.anat.update();
      }
    }
  }

  /** Read the authoritative accepted pose, or measure the live legacy pose. */
  armStateForBodyInitialization(side: Side): Readonly<AcceptedArmState> {
    if (this._limitsEnabled && this._armContinuationReady && this.armFrameSupported(side))
      return this._acceptedArmState[side];

    const out = this._bodyInitializationState[side];
    for (const slot of ['shoulder', 'upperArm', 'lowerArm', 'hand'] as const) {
      const direction = out.directions[slot];
      direction[0] = 0;
      direction[1] = 0;
      direction[2] = 0;
    }
    out.palm[0] = 0;
    out.palm[1] = 0;
    out.palm[2] = 0;
    if (this.readActualArmPose(side)) {
      this.toAcceptedCharacter(out.directions.upperArm, this._actualUpper, side);
      this.toAcceptedCharacter(out.directions.lowerArm, this._actualLower, side);
      this.toAcceptedCharacter(out.directions.hand, this._actualHand, side);
      this.toAcceptedCharacter(out.palm, this._actualPalm, side);
      const shoulder = this.p.bones[`shoulder.${side}`];
      if (shoulder) {
        this._staticUpper
          .copy(this.p.restDir[`shoulder.${side}`])
          .applyQuaternion(shoulder.getWorldQuaternion(this._measureQ))
          .normalize();
        this.toAcceptedCharacter(out.directions.shoulder, this._staticUpper, side);
      }
    }
    for (const finger of FINGER_NAMES) {
      out.curls[finger] = this._posedCurls[side][finger];
      out.spread[finger] = this._posedSpread[side][finger];
    }
    out.forearmRoll = this.foreRoll[side];
    return out;
  }

  armDriver(side: Side): ArmDriver | null {
    return this._armDrivers[side];
  }

  private captureArmFrameMetrics(): void {
    const chest = this.p.bones.chest ?? this.p.bones.spine ?? this.p.bones.hips;
    const head = this.p.bones.head ?? this.p.bones.neck;
    for (const side of ['L', 'R'] as Side[]) {
      const snapshot = this._armFrameSnapshots[side];
      const upper = this.p.bones[`upperArm.${side}`];
      const lower = this.p.bones[`lowerArm.${side}`];
      const hand = this.p.bones[`hand.${side}`];
      if (!(upper?.parent && upper && lower && hand)) continue;
      const candidates = [upper.parent, upper, lower, hand, chest, head];
      for (const object of candidates) {
        if (!object || snapshot.carriers.some((carrier) => carrier.object === object)) continue;
        object.updateWorldMatrix(true, false);
        const scale = positiveConformalScale(object.matrixWorld);
        if (scale === null) {
          snapshot.valid = false;
          snapshot.carriers.length = 0;
          break;
        }
        snapshot.carriers.push({ object, scale });
      }
      snapshot.valid = snapshot.carriers.length > 0;
    }
  }

  private armFrameSupportedFromUpdatedRoot(side: Side): boolean {
    const snapshot = this._armFrameSnapshots[side];
    if (!(this._armDrivers[side] && snapshot.valid && snapshot.carriers.length > 0)) return false;
    for (const carrier of snapshot.carriers) {
      carrier.object.updateWorldMatrix(true, false);
      const scale = positiveConformalScale(carrier.object.matrixWorld);
      if (
        scale === null ||
        Math.abs(scale - carrier.scale) > Math.max(scale, carrier.scale) * FRAME_TOLERANCE
      ) {
        return false;
      }
    }
    return true;
  }

  private armFrameSupported(side: Side): boolean {
    this.p.root.updateWorldMatrix(true, false);
    return this.armFrameSupportedFromUpdatedRoot(side);
  }

  private constrainedSideSupported(side: Side): boolean {
    if (!this._limitsEnabled) return false;
    if (this.armFrameSupported(side)) return true;
    this.invalidateArmContinuation();
    return false;
  }

  private bothArmFramesSupported(): boolean {
    this.p.root.updateWorldMatrix(true, false);
    return this.armFrameSupportedFromUpdatedRoot('L') && this.armFrameSupportedFromUpdatedRoot('R');
  }

  private invalidateArmContinuation(): void {
    if (!this._armContinuationReady) return;
    this._armContinuationReady = false;
    this._heldLimit.L = false;
    this._heldLimit.R = false;
    this._rollHeld.L.fore = 0;
    this._rollHeld.L.humeral = 0;
    this._rollHeld.L.set = false;
    this._rollHeld.R.fore = 0;
    this._rollHeld.R.humeral = 0;
    this._rollHeld.R.set = false;
    this._roll = 0;
  }

  /** Body uses one shared support decision for both arms at the start of a frame. */
  beginBodyArmFrame(): boolean {
    if (!(this._limitsEnabled && this.bothArmFramesSupported())) {
      this.invalidateArmContinuation();
      return false;
    }
    return this._armContinuationReady;
  }

  /** Re-seed only after a complete legacy frame has been rendered. */
  finishLegacyBodyFrame(rise: number): void {
    if (!(this._limitsEnabled && this.bothArmFramesSupported())) {
      this.invalidateArmContinuation();
      return;
    }
    if (this._armContinuationReady || !this.reseedConstrainedArms(rise)) return;
    this._armContinuationReady = true;
    this._externalArmRevision++;
  }

  /** Refresh and return this side's reusable FK frame. */
  armForwardContext(side: Side): ArmForwardContext | null {
    const upper = this.p.bones[`upperArm.${side}`];
    const parent = upper?.parent;
    const upperLength = this.p.limb?.[`upper.${side}`] ?? 0;
    const lowerLength = this.p.limb?.[`lower.${side}`] ?? 0;
    if (!(upper && parent && upperLength > 0 && lowerLength > 0 && this.anat.update())) return null;
    this.p.root.updateMatrixWorld(true);
    if (!this.armContext(side)) return null;
    upper.updateWorldMatrix(true, false);
    parent.updateWorldMatrix(true, false);
    const context = this._armContexts[side];
    upper.getWorldPosition(context.shoulder);
    context.upperLength = upperLength;
    context.lowerLength = lowerLength;
    context.up.copy(this.anat.up);
    context.right.copy(this.anat.right);
    context.forward.copy(this.anat.fwd);
    context.upperParentWorld.copy(parent.getWorldQuaternion(this._applyParentQ));
    return context;
  }

  /** Capture the once-followed body context that candidate arms will use. */
  captureProposedBodyContext(rise: number): void {
    this.captureBodyPose(this._proposedBodyPose, rise);
  }

  /** Rebuild one common-alpha body sample and its deterministic leg contact. */
  applyBodyContext(alpha: number): number {
    const a = this._acceptedBodyPose;
    const b = this._proposedBodyPose;
    const blend = THREE.MathUtils.clamp(alpha, 0, 1);
    for (const slot of BODY_SNAPSHOT_SLOTS) {
      const bone = this.p.bones[slot];
      const qa = a.slots[slot];
      const qb = b.slots[slot];
      if (!(bone && qa && qb)) continue;
      this._applyTargetQ.copy(qb);
      bone.quaternion.copy(qa).slerp(this._applyTargetQ, blend);
    }
    const hips = this.p.bones.hips;
    if (hips) hips.position.lerpVectors(a.hipsPosition, b.hipsPosition, blend);
    const rise = THREE.MathUtils.lerp(a.rise, b.rise, blend);
    this.p.root.updateMatrixWorld(true);
    this.plantLegs(rise);
    this.p.root.updateMatrixWorld(true);
    this.anat.update();
    return rise;
  }

  /** Stage a solver output without changing accepted arm or finger history. */
  stageArmOutput(
    side: Side,
    output: ArmPathPlanOutput,
    curls: FingerSpec,
    spread: FingerSpec,
  ): boolean {
    return this.stageArmForward(side, output.forward, curls, spread);
  }

  stageArmForward(
    side: Side,
    forward: ArmForwardResult,
    curls: FingerSpec,
    spread: FingerSpec,
  ): boolean {
    if (!this.canWriteArm(side)) return false;
    this.writeArmForward(side, forward);
    this.hands.curlHand(side, curls, spread);
    this.copyPosedFingerSpec(side, curls, spread);
    this.p.root.updateMatrixWorld(true);
    return true;
  }

  /** Apply and accept both sides only after the common-alpha frame is complete. */
  commitArmFrame(plans: Record<Side, ArmFrameSideCommit>, rise: number): boolean {
    for (const side of ['L', 'R'] as Side[]) if (!this.canWriteArm(side)) return false;
    for (const side of ['L', 'R'] as Side[]) {
      const plan = plans[side];
      this.writeArmForward(side, plan.output.forward);
      this.hands.curlHand(side, plan.curls, plan.spread);
      this.copyPosedFingerSpec(side, plan.curls, plan.spread);
      this.p.root.updateMatrixWorld(true);
    }
    for (const side of ['L', 'R'] as Side[]) {
      const plan = plans[side];
      const driver = this._armDrivers[side];
      if (!driver) return false;
      driver.accept(plan.output.q, plan.context, plan.curls, plan.spread);
      this.foreRoll[side] = driver.acceptedConfiguration.forearmRoll;
      this.upperRoll[side] = 0;
      this.noteFingers(side);
      this._acceptedHandPose[side] = this.captureHandPose(side);
      this.captureAcceptedArmState(side, driver.acceptedForward, plan.curls, plan.spread);
    }
    this.captureBodyPose(this._acceptedBodyPose, rise);
    this._acceptedRise = rise;
    return true;
  }

  lastAcceptedHandPose(side: Side): Readonly<HandSensePose> | null {
    return this._acceptedHandPose[side];
  }

  /** Total pronation, both bones. */
  readonly foreRoll: Record<Side, number> = { L: 0, R: 0 };
  /** Axial twist given to the humerus. */
  readonly upperRoll: Record<Side, number> = { L: 0, R: 0 };

  /**
   * The rest orientation captured at construction. Every bone that reaches
   * here came out of the profile, so the map always has it.
   */
  private restOf(bone: THREE.Bone): THREE.Quaternion {
    return this.rest.get(bone) ?? _restFallback;
  }

  /** Start a frame: every controlled bone back to its rest orientation. */
  reset(): void {
    for (const [bone, q] of this.rest) bone.quaternion.copy(q);
    this.spine.clear();
    for (const side of ['L', 'R'] as Side[]) {
      for (const finger of FINGER_NAMES) {
        this._posedCurls[side][finger] = 0;
        this._posedSpread[side][finger] = 0;
      }
    }
  }

  private makeBodyPoseSnapshot(): RigBodyPoseSnapshot {
    const slots: RigBodyPoseSnapshot['slots'] = {};
    for (const slot of BODY_SNAPSHOT_SLOTS) {
      if (this.p.bones[slot]) slots[slot] = new THREE.Quaternion();
    }
    return { slots, hipsPosition: new THREE.Vector3(), rise: 0 };
  }

  private captureBodyPose(out: RigBodyPoseSnapshot, rise: number): void {
    for (const slot of BODY_SNAPSHOT_SLOTS) {
      const bone = this.p.bones[slot];
      const target = out.slots[slot];
      if (bone && target) target.copy(bone.quaternion);
    }
    const hips = this.p.bones.hips;
    if (hips) out.hipsPosition.copy(hips.position);
    out.rise = rise;
  }

  private canWriteArm(side: Side): boolean {
    return !!(
      this._armDrivers[side] &&
      this.p.bones[`upperArm.${side}`] &&
      this.p.bones[`lowerArm.${side}`] &&
      this.p.bones[`hand.${side}`]
    );
  }

  private writeWorldRotation(bone: THREE.Bone, world: THREE.Quaternion): void {
    const parent = bone.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      parent.getWorldQuaternion(this._applyParentQ);
      this._applyLocalQ.copy(this._applyParentQ).invert().multiply(world);
      bone.quaternion.copy(this._applyLocalQ);
    } else {
      bone.quaternion.copy(world);
    }
    bone.updateWorldMatrix(false, true);
  }

  private writeArmForward(side: Side, forward: ArmForwardResult): void {
    const upper = this.p.bones[`upperArm.${side}`];
    const lower = this.p.bones[`lowerArm.${side}`];
    const hand = this.p.bones[`hand.${side}`];
    if (!(upper && lower && hand)) return;
    this.writeWorldRotation(upper, forward.upperWorld);
    this.writeWorldRotation(lower, forward.lowerWorld);
    this.writeWorldRotation(hand, forward.handWorld);
  }

  private readActualArmPose(side: Side): boolean {
    const upper = this.p.bones[`upperArm.${side}`];
    const lower = this.p.bones[`lowerArm.${side}`];
    const hand = this.p.bones[`hand.${side}`];
    const palm = this.palmLocal[side];
    if (!(upper && lower && hand && palm)) return false;
    this.p.root.updateMatrixWorld(true);
    this._actualUpper
      .copy(this.p.restDir[`upperArm.${side}`])
      .applyQuaternion(upper.getWorldQuaternion(this._measureQ))
      .normalize();
    this._actualLower
      .copy(this.p.restDir[`lowerArm.${side}`])
      .applyQuaternion(lower.getWorldQuaternion(this._measureQ))
      .normalize();
    this._actualHand
      .copy(this.p.restDir[`hand.${side}`])
      .applyQuaternion(hand.getWorldQuaternion(this._measureQ))
      .normalize();
    this._actualPalm
      .copy(palm)
      .applyQuaternion(hand.getWorldQuaternion(this._measureQ))
      .normalize();
    return true;
  }

  private captureHandPose(side: Side): HandSensePose | null {
    const hand = this.p.bones[`hand.${side}`];
    const elbow = this.p.bones[`lowerArm.${side}`];
    const palmLocal = this.palmLocal[side];
    const knuckle = this.p.fingerBones[`middle.${side}`]?.[0];
    const index = this.p.fingerBones[`index.${side}`]?.[0];
    const little = this.p.fingerBones[`little.${side}`]?.[0];
    if (!(hand && elbow && palmLocal && knuckle && index && little)) return null;
    this.p.root.updateMatrixWorld(true);
    const out = this._handPoseScratch[side];
    knuckle.getWorldPosition(out.knuckle);
    hand.getWorldQuaternion(this._measureQ);
    out.palm.copy(palmLocal).applyQuaternion(this._measureQ).normalize();
    hand.getWorldPosition(out.forearm);
    elbow.getWorldPosition(this._measureA);
    out.forearm.sub(this._measureA).normalize();
    index.getWorldPosition(out.index as THREE.Vector3);
    little.getWorldPosition(out.little as THREE.Vector3);
    return out;
  }

  private toAcceptedCharacter(out: Vec3Tuple, value: THREE.Vector3, side: Side): void {
    if (this.anat.update()) {
      const lateral = side === 'R' ? 1 : -1;
      out[0] = value.dot(this.anat.right) * lateral;
      out[1] = value.dot(this.anat.up);
      out[2] = value.dot(this.anat.fwd);
    } else {
      const lateral = side === 'L' ? this.p.sideSign : -this.p.sideSign;
      out[0] = value.x * lateral;
      out[1] = value.y;
      out[2] = value.z;
    }
    const length = Math.hypot(out[0], out[1], out[2]);
    if (length > 1e-12) {
      out[0] /= length;
      out[1] /= length;
      out[2] /= length;
    }
  }

  private captureAcceptedArmState(
    side: Side,
    forward: ArmForwardResult | null,
    curls: FingerSpec,
    spread: FingerSpec,
  ): boolean {
    const state = this._acceptedArmState[side];
    if (forward) {
      this.toAcceptedCharacter(state.directions.upperArm, forward.u, side);
      this.toAcceptedCharacter(state.directions.lowerArm, forward.l, side);
      this.toAcceptedCharacter(state.directions.hand, forward.h, side);
      this.toAcceptedCharacter(state.palm, forward.palm, side);
    } else {
      if (!this.readActualArmPose(side)) return false;
      this.toAcceptedCharacter(state.directions.upperArm, this._actualUpper, side);
      this.toAcceptedCharacter(state.directions.lowerArm, this._actualLower, side);
      this.toAcceptedCharacter(state.directions.hand, this._actualHand, side);
      this.toAcceptedCharacter(state.palm, this._actualPalm, side);
    }
    const shoulder = this.p.bones[`shoulder.${side}`];
    if (shoulder) {
      this._staticUpper
        .copy(this.p.restDir[`shoulder.${side}`])
        .applyQuaternion(shoulder.getWorldQuaternion(this._measureQ))
        .normalize();
      this.toAcceptedCharacter(state.directions.shoulder, this._staticUpper, side);
    }
    for (const finger of FINGER_NAMES) {
      state.curls[finger] = curls[finger] ?? 0;
      state.spread[finger] = spread[finger] ?? 0;
    }
    state.forearmRoll =
      this._armDrivers[side]?.acceptedConfiguration.forearmRoll ?? this.foreRoll[side];
    return true;
  }

  private copyPosedFingerSpec(side: Side, curls: FingerSpec, spread: FingerSpec): void {
    for (const finger of FINGER_NAMES) {
      this._posedCurls[side][finger] = curls[finger] ?? 0;
      this._posedSpread[side][finger] = spread[finger] ?? 0;
    }
  }

  /** Accumulate a small additive rotation on a spine-chain slot (radians). */
  addOffset(slot: OffsetSlot, x: number, y: number, z: number): void {
    this.spine.add(slot, x, y, z);
  }

  /** Bake accumulated spine offsets into local quaternions. */
  commitSpine(): void {
    this.spine.commit(this.p, (bone) => this.restOf(bone));
  }

  /** Keep standing feet planted, or carry their contact points through a hop. */
  plantLegs(rise: number): void {
    this.legs?.apply(rise);
  }

  /**
   * Aim one bone so its child direction points along `targetWorld`.
   * Writes this bone's world rotation into `out` and returns it, so the next
   * bone down can use it as its parent rotation.
   */
  private aim(
    bone: THREE.Bone,
    restDir: THREE.Vector3,
    parentWorldQ: THREE.Quaternion,
    targetWorld: THREE.Vector3,
    twist: number,
    out: THREE.Quaternion,
    palm: PalmSpec | null = null,
  ): THREE.Quaternion {
    const curWorld = _q.copy(parentWorldQ).multiply(this.restOf(bone));
    const curDir = _v.copy(restDir).applyQuaternion(curWorld).normalize();
    out.setFromUnitVectors(curDir, targetWorld).multiply(curWorld);

    // Aiming a bone leaves the roll about its own axis undetermined: pointing
    // the fingers somewhere says nothing about which way the palm faces, and
    // `setFromUnitVectors` picks the shortest rotation, so the roll comes out
    // as a side effect of the rest pose rather than as anything anyone chose.
    // Where a palm target is given, solve the roll that satisfies it.
    this._roll = 0;
    if (palm) {
      const cur = _palmCur.copy(palm.local).applyQuaternion(out);
      const want = _palmWant.copy(palm.target);
      // Both projected onto the plane normal to the aim axis; the signed angle
      // between them in that plane is the roll needed.
      cur.addScaledVector(targetWorld, -cur.dot(targetWorld));
      want.addScaledVector(targetWorld, -want.dot(targetWorld));
      if (cur.lengthSq() > 1e-8 && want.lengthSq() > 1e-8) {
        cur.normalize();
        want.normalize();
        const cos = THREE.MathUtils.clamp(cur.dot(want), -1, 1);
        const sin = _palmAxis.crossVectors(cur, want).dot(targetWorld);
        // Weighted, so a pose that states no palm can give the constraint up
        // instead of inheriting one: at weight 0 this is the plain minimal
        // rotation, which is a fine default for a hand that nobody has an
        // opinion about.
        //
        // Reported, not applied. Which joints pay for the roll is a question
        // about the whole arm — the shoulder above the elbow has more of the
        // range than everything below it — and this method holds one bone.
        this._roll = Math.atan2(sin, cos) * palm.weight;
      }
    }

    _local.copy(parentWorldQ).invert().multiply(out);
    if (twist) {
      _local.multiply(_twistQ.setFromAxisAngle(restDir, twist));
      // Keep `out` consistent with what the bone actually ends up at, in case
      // anything downstream threads from it.
      out.copy(parentWorldQ).multiply(_local);
    }
    bone.quaternion.copy(_local);
    return out;
  }

  /**
   * Turn an aimed humerus about its own axis until its front faces the way the
   * forearm folds.
   *
   * The shortest-arc aim leaves the humerus at whatever roll the swing from rest
   * gives it, so a rotated arm bent its elbow up to eighty degrees off the bone's
   * own hinge: the crease of the mesh faced one way and the forearm folded
   * another, and pronation was counted from a frame no forearm has. Faded in with
   * the bend, by the trust the measurement gives it, because a straight elbow
   * folds nowhere.
   */
  private hingeUpper(side: Side, upper: THREE.Bone, uD: THREE.Vector3, lD: THREE.Vector3): void {
    const rest = this._humeralFront[side];
    const trust = rotationTrust(Math.acos(THREE.MathUtils.clamp(uD.dot(lD), -1, 1)));
    if (!rest || trust <= 0) return;
    const front = _hingeFront.copy(rest).applyQuaternion(this._upperQ);
    front.addScaledVector(uD, -front.dot(uD));
    const fold = _hingeFold.copy(lD).addScaledVector(uD, -lD.dot(uD));
    if (front.lengthSq() < 1e-8 || fold.lengthSq() < 1e-8) return;
    front.normalize();
    fold.normalize();
    const turn = Math.atan2(_hingeAxis.crossVectors(front, fold).dot(uD), front.dot(fold));
    upper.quaternion.multiply(
      _twistQ.setFromAxisAngle(this.p.restDir[`upperArm.${side}`], turn * trust),
    );
    this._upperQ.copy(this._upperParentQ).multiply(upper.quaternion);
  }

  /**
   * Swing the shoulder girdle away from a reach, in place, before the arm is
   * solved from it.
   *
   * A hand cannot be brought to the face by the arm alone. The elbow's flexion
   * fixes a nearest reachable point — fold it as far as it goes and the wrist
   * is still a fixed distance from the shoulder — so on a narrow-shouldered,
   * short-necked figure the face can sit inside that radius and no choice of
   * elbow, pole or wrist reaches it. Measured on the validation avatar the
   * shoulder is 0.09 to 0.14 from the face anchors against an arm of 0.33; the
   * same ratio on a person is around a half to two thirds.
   *
   * What a person does about it is drop and draw back the shoulder, and that is
   * what this does: the clavicle turns away from the target until the wrist can
   * sit where the elbow's *comfortable* range wants it, bounded by the girdle's
   * own travel. It buys a couple of centimetres, which is the difference
   * between a forearm folded flat and one that reads as resting.
   *
   * `dir` is the clavicle's aim, and the turn it needs, scaled by `weight`, is
   * added to `turnOut` as a rotation vector rather than applied: every reach in
   * play adds its share, and `turnGirdle` applies the sum, bounded by the
   * girdle's travel. The current angle is taken from `dir` rather than from
   * where the bone actually points, so the result is a function of the request
   * alone — read back from the posed bone it would measure its own correction,
   * find nothing left to do, and let the shoulder spring back on the next frame.
   */
  girdleRoom(
    side: Side,
    targetWorld: THREE.Vector3,
    dir: Vec3Tuple,
    weight: number,
    turnOut: THREE.Vector3,
  ): void {
    const { bones, limb } = this.p;
    const clav = bones[`shoulder.${side}`];
    const upper = bones[`upperArm.${side}`];
    const La = limb?.[`upper.${side}`];
    const Lf = limb?.[`lower.${side}`];
    if (!(clav && upper && La && Lf) || weight <= 0) return;

    clav.updateWorldMatrix(true, false);
    upper.updateWorldMatrix(true, false);
    const C = clav.getWorldPosition(_gC);
    // Turning the clavicle cannot change this, so the posed bones give the rest
    // length as readily as the rest pose would.
    const r = C.distanceTo(upper.getWorldPosition(_gS));
    if (r < 1e-4) return;

    const a = _gA.set(dir[0], dir[1], dir[2]);
    if (a.lengthSq() < 1e-8) return;
    a.normalize();
    const b = _gB.copy(targetWorld).sub(C);
    const L = b.length();
    if (L < 1e-4) return;
    b.multiplyScalar(1 / L);

    // Where the wrist has to sit for the elbow to stay inside its free range.
    const flexFree = this.joints?.elbow?.dofs?.flexion?.free?.[1] ?? Math.PI;
    const want = Math.sqrt(La * La + Lf * Lf - 2 * La * Lf * Math.cos(Math.PI - flexFree));
    // Law of cosines on the triangle root-shoulder-target: the shoulder sits on
    // a sphere of radius r about the clavicle root, and this is the cosine that
    // puts it `want` from the target.
    const K = (r * r + L * L - want * want) / (2 * r * L);
    const cos0 = THREE.MathUtils.clamp(a.dot(b), -1, 1);
    if (!(K < cos0)) return;

    const need = Math.acos(THREE.MathUtils.clamp(K, -1, 1)) - Math.acos(cos0);
    const turn = Math.min(need, GIRDLE_ROM) * weight;
    if (turn < 1e-4) return;
    // b cross a, not a cross b: rotating about the latter carries the shoulder
    // *toward* the target, which is the wrong way round and reads as a hunch.
    const axis = _gX.crossVectors(b, a);
    if (axis.lengthSq() < 1e-8) return;
    turnOut.addScaledVector(axis.normalize(), turn);
  }

  /**
   * Turn the clavicle's aim `dir` in place by the rotation `girdleRoom`
   * gathered, its angle clamped to the girdle's travel however many reaches
   * contributed.
   */
  turnGirdle(dir: Vec3Tuple, turn: THREE.Vector3): void {
    const angle = Math.min(turn.length(), GIRDLE_ROM);
    if (angle < 1e-4) return;
    const a = _gA
      .set(dir[0], dir[1], dir[2])
      .normalize()
      .applyAxisAngle(_gX.copy(turn).normalize(), angle);
    dir[0] = a.x;
    dir[1] = a.y;
    dir[2] = a.z;
  }

  /**
   * Pose the shoulder alone.
   *
   * Split out of `aimArm` because a reach has to be solved from where the upper
   * arm will be, and that is not where it rests: the clavicle carries it a
   * noticeable distance. The caller poses the shoulder, solves, then poses the
   * rest of the chain — `aimArm` re-aims the shoulder to the same direction on
   * its way past, which costs one quaternion and keeps the chain in one place.
   */
  aimShoulder(side: Side, dir: Vec3Tuple | THREE.Vector3 | null): void {
    const { bones, restDir } = this.p;
    const bone = bones[`shoulder.${side}`];
    // The clavicle's own parent, which a rig may not have put on the chest slot.
    const parent = bone?.parent;
    if (!(bone && parent && dir)) return;
    this.aim(
      bone,
      restDir[`shoulder.${side}`],
      parent.getWorldQuaternion(this._chainQ[0]),
      worldDirection(dir),
      0,
      this._chainQ[1],
    );
  }

  private seedDriverFromActual(side: Side, context: ArmForwardContext, driver: ArmDriver): boolean {
    if (!this.readActualArmPose(side)) return false;
    if (
      !driver.seedFromPose(
        context,
        this._actualUpper,
        this._actualLower,
        this._actualHand,
        this._actualPalm,
      )
    ) {
      return false;
    }
    driver.accept(driver.acceptedQ, context, this._posedCurls[side], this._posedSpread[side]);
    return true;
  }

  private restoreDriverAfterRejectedStatic(
    driver: ArmDriver,
    snapshot: ArmDriverAcceptedSnapshot,
  ): void {
    driver.restoreAcceptedState(snapshot);
  }

  private staticPlan(driver: ArmDriver, context: ArmForwardContext): ArmPathPlanOutput | null {
    if (
      !driver.configurationFromPose(
        context,
        this._staticUpper,
        this._staticLower,
        this._staticHand,
        driver.request.palm,
      )
    ) {
      return null;
    }
    let output = driver.planFrom(driver.acceptedQ, context, 0, false);
    if (output.status !== 'blocked') return output;
    // A static pose has no temporal path promise; if the optimization cannot
    // move, test the exact inverse request as a complete endpoint.
    if (!driver.restoreEndpointFrom(driver.targetQ, context, 0, false)) return null;
    output = driver.output;
    return output;
  }

  private commitStaticArm(
    side: Side,
    output: ArmPathPlanOutput,
    context: ArmForwardContext,
    curls: FingerSpec,
    spread: FingerSpec,
    bumpRevision = true,
  ): void {
    const driver = this._armDrivers[side];
    if (!driver) return;
    this.writeArmForward(side, output.forward);
    this.hands.curlHand(side, curls, spread);
    this.copyPosedFingerSpec(side, curls, spread);
    this.p.root.updateMatrixWorld(true);
    driver.accept(output.q, context, curls, spread);
    this.foreRoll[side] = driver.acceptedConfiguration.forearmRoll;
    this.upperRoll[side] = 0;
    this.noteFingers(side);
    this._acceptedHandPose[side] = this.captureHandPose(side);
    this.captureAcceptedArmState(side, driver.acceptedForward, curls, spread);
    this.captureBodyPose(this._acceptedBodyPose, this._acceptedRise);
    if (bumpRevision) this._externalArmRevision++;
  }

  private tryStaticAimArm(
    side: Side,
    dirs: Record<ArmSlot, Vec3Tuple>,
    twist: number,
    palmTarget: Vec3Tuple | null,
    palmWeight: number,
  ): boolean {
    const driver = this._armDrivers[side];
    if (!driver) return false;
    const driverSnapshot = driver.captureAcceptedState();
    const clavicle = this.p.bones[`shoulder.${side}`];
    const priorClavicle = clavicle?.quaternion.clone() ?? null;
    this.aimShoulder(side, dirs.shoulder);
    const context = this.armForwardContext(side);
    if (!(context && this.seedDriverFromActual(side, context, driver))) {
      if (clavicle && priorClavicle) clavicle.quaternion.copy(priorClavicle);
      this.p.root.updateMatrixWorld(true);
      this.restoreDriverAfterRejectedStatic(driver, driverSnapshot);
      return false;
    }

    this._staticUpper.set(...dirs.upperArm).normalize();
    this._staticLower.set(...dirs.lowerArm).normalize();
    this._staticHand.set(...dirs.hand).normalize();
    this._staticPalm.set(0, 0, 0);
    const targetPalm = palmTarget
      ? this._staticPalm.set(palmTarget[0], palmTarget[1], palmTarget[2]).normalize()
      : null;
    driver.captureVolumeFrame();
    const priorRoll = driver.requestRollHistory;
    driver.composeRequest(
      context,
      this._staticUpper,
      this._staticLower,
      this._staticHand,
      targetPalm,
      palmWeight,
      twist,
      this._posedCurls[side],
      this._posedSpread[side],
    );
    const output = this.staticPlan(driver, context);
    if (!output) {
      driver.requestRollHistory = priorRoll;
      if (clavicle && priorClavicle) clavicle.quaternion.copy(priorClavicle);
      this.p.root.updateMatrixWorld(true);
      this.restoreDriverAfterRejectedStatic(driver, driverSnapshot);
      return false;
    }
    this.commitStaticArm(side, output, context, this._posedCurls[side], this._posedSpread[side]);
    return true;
  }

  private tryStaticHand(side: Side, curls: FingerSpec, spread: FingerSpec): boolean {
    const driver = this._armDrivers[side];
    if (!driver) return false;
    const driverSnapshot = driver.captureAcceptedState();
    const context = this.armForwardContext(side);
    if (!(context && this.seedDriverFromActual(side, context, driver))) {
      this.restoreDriverAfterRejectedStatic(driver, driverSnapshot);
      return false;
    }
    driver.captureVolumeFrame();
    driver.requestForConfiguration(driver.acceptedConfiguration, context, curls, spread);
    const output = driver.planFrom(driver.acceptedQ, context, 0, false);
    if (
      output.status === 'blocked' &&
      !driver.restoreEndpointFrom(driver.acceptedQ, context, 0, false)
    ) {
      this.restoreDriverAfterRejectedStatic(driver, driverSnapshot);
      return false;
    }
    this.commitStaticArm(side, driver.output, context, curls, spread);
    return true;
  }

  private noteExternalArmEdit(side: Side): void {
    if (!this.captureAcceptedArmState(side, null, this._posedCurls[side], this._posedSpread[side]))
      return;
    this._acceptedHandPose[side] = this.captureHandPose(side);
    this.captureBodyPose(this._acceptedBodyPose, this._acceptedRise);
    this._externalArmRevision++;
  }

  private reseedConstrainedArms(rise = this._acceptedRise): boolean {
    const snapshots: Partial<Record<Side, ArmDriverAcceptedSnapshot>> = {};
    const pending: Array<{
      side: Side;
      driver: ArmDriver;
      context: ArmForwardContext;
      output: ArmPathPlanOutput;
      curls: FingerSpec;
      spread: FingerSpec;
    }> = [];

    for (const side of ['L', 'R'] as Side[]) {
      const driver = this._armDrivers[side];
      if (driver) snapshots[side] = driver.captureAcceptedState();
    }

    for (const side of ['L', 'R'] as Side[]) {
      const driver = this._armDrivers[side];
      const context = this.armForwardContext(side);
      if (!driver) continue;
      if (!(context && this.seedDriverFromActual(side, context, driver))) {
        this.restoreReseedSnapshots(snapshots);
        return false;
      }
      driver.captureVolumeFrame();
      const bounded = driver.boundConfiguration(
        driver.acceptedConfiguration,
        this._staticBoundedConfiguration,
      );
      driver.configurationToQ(bounded, this._staticQ);
      driver.requestForConfiguration(
        bounded,
        context,
        this._posedCurls[side],
        this._posedSpread[side],
      );
      const valid = driver.validateLockedPose(
        this._staticQ,
        context,
        this._posedCurls[side],
        this._posedSpread[side],
        driver.output,
      );
      const endpointValid = valid || driver.restoreEndpointFrom(this._staticQ, context, 0, false);
      if (!endpointValid) {
        this.restoreReseedSnapshots(snapshots);
        return false;
      }
      pending.push({
        side,
        driver,
        context,
        output: driver.output,
        curls: this._posedCurls[side],
        spread: this._posedSpread[side],
      });
    }

    this._acceptedRise = rise;
    for (const plan of pending) {
      this.commitStaticArm(plan.side, plan.output, plan.context, plan.curls, plan.spread, false);
      plan.driver.requestRollHistory = plan.driver.acceptedConfiguration.forearmRoll;
    }
    return true;
  }

  private restoreReseedSnapshots(
    snapshots: Partial<Record<Side, ArmDriverAcceptedSnapshot>>,
  ): void {
    for (const side of ['L', 'R'] as Side[]) {
      const driver = this._armDrivers[side];
      const snapshot = snapshots[side];
      if (driver && snapshot) driver.restoreAcceptedState(snapshot);
    }
  }

  /**
   * Pose one arm. `dirs` holds world-space unit directions keyed by chain slot;
   * omitted slots keep their rest orientation relative to the parent.
   */
  aimArm(
    side: Side,
    dirs: Record<ArmSlot, Vec3Tuple>,
    twist = 0,
    palmTarget: Vec3Tuple | null = null,
    palmWeight = 1,
  ): void {
    if (this.constrainedSideSupported(side)) {
      this.tryStaticAimArm(side, dirs, twist, palmTarget, palmWeight);
      return;
    }
    this.aimArmLegacy(side, dirs, twist, palmTarget, palmWeight);
    this.noteExternalArmEdit(side);
  }

  /** Legacy single-chain path, used only when limiting is explicitly disabled or unsupported. */
  aimArmLegacy(
    side: Side,
    dirs: Record<ArmSlot, Vec3Tuple>,
    twist = 0,
    palmTarget: Vec3Tuple | null = null,
    palmWeight = 1,
  ): void {
    const { bones, restDir } = this.p;
    const palmLocal = this.palmLocal[side];
    let palm: PalmSpec | null = null;
    if (palmTarget && palmWeight > 1e-3 && palmLocal) {
      _palmSpec.local = palmLocal;
      _palmSpec.target.set(palmTarget[0], palmTarget[1], palmTarget[2]).normalize();
      _palmSpec.weight = palmWeight;
      palm = _palmSpec;
    }
    const chest = bones.chest ?? bones.spine ?? bones.hips;
    if (!chest) return;

    // Bound the whole arm before any of it is posed, so a limit is never
    // something a pose can argue its way past. Done up front rather than link
    // by link because the anatomical measurement is not local to a joint: how
    // far the shoulder may lift depends on which plane it lifted in, and
    // whether a wrist is bent or deviated depends on which way the palm faces.
    // The chain walk below only ever holds one link at a time.
    const lim = this.limit(side, dirs, palm);

    // The bounded directions, each in its own vector. `worldDirection` hands back one
    // shared scratch, which was enough while the chain was walked a link at a
    // time; the roll budget needs all three at once to know how much of a
    // shoulder rotation would reach the palm.
    const dir = (slot: ArmSlot): THREE.Vector3 | null => {
      const raw = lim?.[slot] ?? dirs[slot];
      if (!raw) return null;
      const into = this._aim[slot];
      return Array.isArray(raw)
        ? into.set(raw[0], raw[1], raw[2]).normalize()
        : into.copy(raw).normalize();
    };
    const sD = dir('shoulder');
    const uD = dir('upperArm');
    const lD = dir('lowerArm');
    const hD = dir('hand');

    const clav = bones[`shoulder.${side}`];
    const upper = bones[`upperArm.${side}`];
    const fore = bones[`lowerArm.${side}`];
    const hand = bones[`hand.${side}`];
    const foreDir = restDir[`lowerArm.${side}`];
    const handDir = restDir[`hand.${side}`];

    // --- down as far as the upper arm ---------------------------------------
    // From the chain's real parent, which a rig may not have put on the chest slot.
    let q = ((clav ?? upper)?.parent ?? chest).getWorldQuaternion(this._chainQ[0]);
    if (clav) {
      q = sD
        ? this.aim(clav, restDir[`shoulder.${side}`], q, sD, 0, this._chainQ[1])
        : this._chainQ[1].copy(q).multiply(this.restOf(clav));
    }
    this._upperParentQ.copy(q);
    if (upper) {
      if (uD) this.aim(upper, restDir[`upperArm.${side}`], this._upperParentQ, uD, 0, this._upperQ);
      else this._upperQ.copy(q).multiply(this.restOf(upper));
      if (uD && lD) this.hingeUpper(side, upper, uD, lD);
    } else this._upperQ.copy(q);

    /**
     * Pose the forearm and hand from wherever the upper arm now sits, spending
     * `carry` on forearm pronation and `hw` on the hand. Returns the roll the
     * palm still wants, which does not depend on `hw` — it is measured against
     * the untwisted aim — so the same call both prices a trial and pays for it.
     */
    const below = (carry: number, hw: number): number => {
      let p = this._upperQ;
      if (fore) {
        if (lD) this.aim(fore, foreDir, this._upperQ, lD, 0, this._foreQ);
        else this._foreQ.copy(this._upperQ).multiply(this.restOf(fore));
        if (carry) {
          fore.quaternion.multiply(_twistQ.setFromAxisAngle(foreDir, carry));
          this._foreQ.copy(this._upperQ).multiply(fore.quaternion);
        }
        p = this._foreQ;
      }
      if (!hand) return 0;
      if (!hD) {
        hand.quaternion.copy(this.restOf(hand));
        this._handQ.copy(p).multiply(hand.quaternion);
        return 0;
      }
      this.aim(hand, handDir, p, hD, hw, this._handQ, palm);
      return this._roll;
    };

    // --- who pays for the roll ----------------------------------------------
    const pron = this.joints.elbow.dofs.rotation;
    let R = below(0, 0);
    let humeral = 0;

    if (palm && upper && uD && lD && Math.abs(R) > 1e-3) {
      const spare = R - THREE.MathUtils.clamp(R, pron.max[0], pron.max[1]);
      // How much of a humeral rotation arrives at the palm.
      //
      // Twisting a bone and then re-aiming the one below it to the direction it
      // was already pointing passes on the twist scaled by the cosine of the
      // angle between them — all of it in line, none at a right angle, and
      // negated past that. The palm is two joints down, so it happens twice.
      //
      // Both terms are needed. Stopping at the elbow overstates what reaches a
      // bent wrist, and it was the missing wrist term that had the shoulder
      // declining to help on the reaches that needed it most.
      const transfer = uD.dot(lD) * (hD ? lD.dot(hD) : 1);
      if (spare && Math.abs(transfer) > ROLL_TRANSFER_MIN) {
        // Measured, not assumed: the shoulder may already be rotated by where
        // the elbow points, and that spends the same range. A hand with no
        // direction of its own follows the forearm, which is a straight wrist
        // and the same substitution the elbow search makes.
        this.anat.measure(side, uD, lD, hD ?? lD, null);
        const room = rollRoom(this.anat.m.rotation, this.joints.shoulder.dofs.rotation);
        humeral = THREE.MathUtils.clamp(spare / transfer, room[0], room[1]);
      }
    }

    if (humeral && upper) {
      upper.quaternion.multiply(_twistQ.setFromAxisAngle(restDir[`upperArm.${side}`], humeral));
      this._upperQ.copy(this._upperParentQ).multiply(upper.quaternion);
      const after = below(0, 0);
      // The transfer estimate is a cosine, and near the gate it is a rough one.
      // A donation that left the palm further from where it was asked to face is
      // not a donation; undo it rather than ship an arm rotated for nothing.
      if (Math.abs(after) >= Math.abs(R)) {
        upper.quaternion.multiply(_twistQ.setFromAxisAngle(restDir[`upperArm.${side}`], -humeral));
        this._upperQ.copy(this._upperParentQ).multiply(upper.quaternion);
        humeral = 0;
        below(0, 0);
      } else R = after;
    }

    // The axial half of `slew`: neither roll shows in a link direction, so the
    // direction slew cannot see one change. A palm demand passing half a turn
    // changes sign in a frame, and the clamp sent the forearm from one stop to
    // the other; the shoulder's share steps on its gate and its undo. Eased, the
    // arm still ends where the plain answer says, however it was arrived at.
    const held = this._rollHeld[side];
    const rollStep = LIMIT_SLEW * this.dt;
    if (held.set && rollStep > 0) {
      const eased =
        held.humeral + THREE.MathUtils.clamp(humeral - held.humeral, -rollStep, rollStep);
      if (upper && eased !== humeral) {
        upper.quaternion.multiply(
          _twistQ.setFromAxisAngle(restDir[`upperArm.${side}`], eased - humeral),
        );
        this._upperQ.copy(this._upperParentQ).multiply(upper.quaternion);
        humeral = eased;
        R = below(0, 0);
      }
    }

    let total = THREE.MathUtils.clamp(R, pron.max[0], pron.max[1]);
    if (held.set && rollStep > 0)
      total = held.fore + THREE.MathUtils.clamp(total - held.fore, -rollStep, rollStep);
    held.fore = total;
    held.humeral = humeral;
    held.set = true;
    const carry = total * (1 - PRONATION_SPLIT);
    const hw = palm ? total * PRONATION_SPLIT : twist;
    below(carry, hw);

    // Pronation is recorded here rather than measured later: it is a roll about
    // the forearm's own axis, and a roll about an axis leaves no trace in the
    // segment directions the rest of the model reads. Both bones' shares are
    // recorded as one number, because anatomically they are one rotation.
    this.foreRoll[side] = total;
    this.upperRoll[side] = humeral;

    // --- the wrist, against the palm the arm actually reached ---------------
    //
    // The clamp up top could only bound the wrist against the palm the pose
    // asked for. Where the roll budget could not deliver all of it, the palm
    // ends up somewhere else, and the split of the bend into flexion and
    // deviation turns with it. One correction pass: clamping again moves the
    // palm again, and the second-order term is not worth a third aim per arm
    // per frame.
    if (this.limitsEnabled && palm && hD && lD && hand && palmLocal) {
      const got = this._palmWorld[side].copy(palmLocal).applyQuaternion(this._handQ).normalize();
      _fixDir.copy(hD);
      this.anat.clampWrist(side, lD, hD, got);
      // Bounding the wrist can put the hand back into the face the clamp just
      // lifted it off — this runs after `clamp`, so it has the last word on
      // where the hand points, and it knows nothing about the body. Lift it out
      // again. Only the hand turns, about the wrist, so the arm above it stays
      // exactly as posed.
      if (uD) this.anat.clearHand(side, uD, lD, hD);
      if (hD.distanceToSquared(_fixDir) > 1e-8) below(carry, hw);
    }
  }

  /**
   * The palm normal to measure a wrist against, in world space.
   *
   * The palm *target* the pose asked for, or null where it asked for nothing.
   *
   * Null is the meaningful case, not a fallback. The wrist has to be bounded
   * before the arm is aimed, and the roll that decides where the palm ends up
   * is solved during the aim — so the only palm knowable here is the one the
   * pose stated. Where it stated none, the palm is genuinely free, and
   * `anatomy/` scores the wrist accordingly. Substituting last frame's actual
   * palm looks more informed and is worse: it feeds the previous clamp back
   * into the next one.
   */
  private palmWorld(side: Side, palm: PalmSpec | null): THREE.Vector3 | null {
    if (!palm) return null;
    return this._palmWorld[side].copy(palm.target).normalize();
  }

  /**
   * Give the anatomy model this arm's origin and segment lengths, so it can
   * place the arm instead of only pointing it. Needed for the torso clearance,
   * which is a question about positions — and about the whole arm, not just the
   * elbow: reaching across the body puts both ends of the arm outside the trunk
   * and the middle of it inside.
   */
  private armContext(side: Side): boolean {
    const upper = this.p.bones[`upperArm.${side}`];
    const La = this.p.limb?.[`upper.${side}`];
    if (!(upper && La)) {
      this.anat.clearArm();
      return false;
    }
    upper.updateWorldMatrix(true, false);
    // The hand's collision proxy runs from the wrist to where the hand *touches*
    // — half its length, the middle of the palm — and stops there.
    //
    // It has to stop there, and the number has to be the same one the motion
    // layer backs the wrist off by. A reach places the palm on its anchor, and
    // the anchor is a point on the skin; test any further down the hand and the
    // samples past the contact point are inside the body *by construction*.
    // Testing 60% against a 50% back-off did exactly that, and left the poses
    // that touch the face reading 24 to 43 percent buried with the arm itself
    // completely clear.
    this.anat.setArm(
      upper.getWorldPosition(_armS),
      La,
      this.p.limb?.[`lower.${side}`] ?? 0,
      (this.p.limb?.[`tip.${side}.middle`] ?? 0) * HAND_CONTACT,
    );
    return true;
  }

  /**
   * Pull one arm's directions inside its anatomical stops.
   *
   * Returns rig-owned vectors rather than editing `dirs` in place: `dirs` is
   * the body layer's smoothed state, and folding a limit back into it would
   * make the limit accumulate — an arm held against a stop would keep being
   * pushed further into it, one frame's clamp at a time.
   */
  private limit(
    side: Side,
    dirs: Record<ArmSlot, Vec3Tuple>,
    palm: PalmSpec | null,
  ): LimitedDirs | null {
    if (!(this.limitsEnabled && this.anat.update())) return null;
    const u = dirs.upperArm;
    const l = dirs.lowerArm;
    const h = dirs.hand;
    if (!(u && l && h)) return null;
    this.armContext(side);
    const out = this._limited[side];
    out.upperArm.copy(worldDirection(u));
    out.lowerArm.copy(worldDirection(l));
    out.hand.copy(worldDirection(h));
    this.anat.clamp(side, out.upperArm, out.lowerArm, out.hand, this.palmWorld(side, palm));
    this.slew(side, out);
    return out;
  }

  /**
   * Hold the limiter's output to a speed a limb can move at.
   *
   * The body layer takes great care that nothing it hands down here steps — the
   * followers in `motion/follow.ts` exist for that and nothing else — and then
   * this layer puts a step back in. A clamp is a projection onto the set of
   * poses a joint allows, that set is not convex, and projection onto a
   * non-convex set is discontinuous by construction: the humeral rotation is
   * bounded to half a circle, so a request that drifts past the far side of it
   * is equally close to both stops and the nearest one changes in a single
   * frame. The forearm then swings a hundred and eighty degrees between two
   * frames. Measured across every ordered switch between two gestures, one in
   * six carried the wrist faster than four metres a second and the worst carried
   * it at twenty-six, against a peak of two or three for the movement itself.
   * Switching the limiter off entirely left five in a thousand over four, which
   * is what said the clamp was the whole of it rather than a part.
   *
   * The elevation ceiling, the elbow and the wrist each have a seam of their own
   * and no one of them accounts for it, so this bounds the result rather than
   * chasing them: whatever the clamp asks for, the arm travels there at a speed
   * a limb has. Below the cap nothing changes at all, which is what makes it
   * safe — see `LIMIT_SLEW`. The cost is that for the tenth of a second after a
   * seam the arm is outside the stop it was being pulled inside, and that is the
   * trade: `measure` reads the posed bones, so the panel shows the excursion
   * honestly rather than reporting the pose the clamp asked for.
   */
  private slew(side: Side, out: LimitedDirs): void {
    const held = this._held[side];
    const step = LIMIT_SLEW * this.dt;
    if (!(this._heldLimit[side] && step > 0)) {
      for (const slot of LIMITED_SLOTS) held[slot].copy(out[slot]);
      this._heldLimit[side] = true;
      return;
    }
    for (const slot of LIMITED_SLOTS) {
      const cur = held[slot];
      const want = out[slot];
      const axis = _slewAxis.crossVectors(cur, want);
      const sin = axis.length();
      const cos = THREE.MathUtils.clamp(cur.dot(want), -1, 1);
      if (Math.atan2(sin, cos) <= step) {
        cur.copy(want);
      } else if (sin > 1e-9) {
        cur.applyAxisAngle(axis.divideScalar(sin), step).normalize();
      } else {
        // Exactly opposed, which is the half-turn this exists for and the one
        // case where the shortest rotation does not name an axis. Any
        // perpendicular is as short as any other and one has to be picked —
        // leaving the axis at zero would park the link on the far side of the
        // sphere and call it arrived, which is the teleport rather than a fix.
        _slewPerp.set(1, 0, 0);
        if (Math.abs(cur.x) > 0.9) _slewPerp.set(0, 1, 0);
        cur.applyAxisAngle(axis.crossVectors(cur, _slewPerp).normalize(), step).normalize();
      }
      out[slot].copy(cur);
    }
  }

  /**
   * Measure one arm as it currently stands, for the panel.
   *
   * Reads the posed bones rather than the requested directions on purpose: what
   * is worth showing is the pose that survived the clamp, not the one that was
   * asked for. Allocates, so it is a readout and not a frame-loop call.
   */
  measure(side: Side): JointReading[] | null {
    const { bones, restDir } = this.p;
    const u = bones[`upperArm.${side}`];
    const l = bones[`lowerArm.${side}`];
    const h = bones[`hand.${side}`];
    if (!(u && l && h && this.anat.update())) return null;
    this.armContext(side);
    const dir = (bone: THREE.Bone, slot: string) =>
      new THREE.Vector3()
        .copy(restDir[slot])
        .applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()))
        .normalize();
    const palmLocal = this.palmLocal[side];
    const palm = palmLocal
      ? new THREE.Vector3()
          .copy(palmLocal)
          .applyQuaternion(h.getWorldQuaternion(new THREE.Quaternion()))
          .normalize()
      : this.anat.up.clone().negate();
    this.anat.measure(
      side,
      dir(u, `upperArm.${side}`),
      dir(l, `lowerArm.${side}`),
      dir(h, `hand.${side}`),
      palm,
      this.foreRoll[side],
      this.upperRoll[side],
    );
    return this.anat.report();
  }

  /**
   * Reach a wrist to a world position, choosing the elbow rather than being
   * told it.
   *
   * The authored alternative is `solveReach` with an explicit angle, and it is
   * the wrong default: the angle is measured from the body's forward direction
   * about a line whose bearing changes with every target, so one constant means
   * a different elbow for every gesture that uses it. Every face-touching pose
   * in the table carried the same -0.3, which put the elbow in front of the
   * chest for a hand going to the crown and folded the arm across the face.
   *
   * `pole` is a world point the elbow is drawn toward, as the gesture table
   * states one; without it the search predicts its own. See `ElbowSearch`.
   */
  solveReachNatural(
    side: Side,
    targetWorld: THREE.Vector3,
    handDir: THREE.Vector3 | null,
    out: ArmSolution,
    pole: THREE.Vector3 | null = null,
  ): ArmSolution | null {
    return this.elbow.search(side, targetWorld, handDir, null, out, pole) !== null ? out : null;
  }

  /**
   * Back-solve an arm from a fingertip. See `point.ts`, which holds the
   * arithmetic that turns a bearing into a wrist target.
   */
  solvePoint(side: Side, spec: PointRequest, out: ArmSolution): ArmSolution | null {
    return this.point.solve(side, spec, out);
  }

  /**
   * Solve a two-link reach so the wrist lands on `targetWorld`. See
   * `reach.ts`, which holds the geometry, and `reachRef` for `framed`.
   */
  solveReach(
    side: Side,
    targetWorld: THREE.Vector3,
    elbowAngle: number,
    out: ReachLinks,
    framed?: boolean,
  ): ReachLinks | null {
    return solveReach(this.p, this.joints, this.anat, side, targetWorld, elbowAngle, out, framed);
  }

  /** Curl a finger. See `Hands.curlFinger`. */
  curlFinger(name: FingerName, side: Side, amount: number): void {
    if (this.constrainedSideSupported(side)) {
      const curls = { ...this._posedCurls[side], [name]: amount };
      this.tryStaticHand(side, curls, this._posedSpread[side]);
      return;
    }
    this.curlFingerLegacy(name, side, amount);
    this._posedCurls[side][name] = amount;
    this.noteExternalArmEdit(side);
  }

  curlHand(side: Side, spec: FingerSpec, spread: FingerSpec = {}): void {
    if (this.constrainedSideSupported(side)) {
      this.tryStaticHand(side, spec, spread);
      return;
    }
    this.curlHandLegacy(side, spec, spread);
    this.noteExternalArmEdit(side);
  }

  /** Legacy direct finger write, used by Body only for an explicit limiter opt-out. */
  curlFingerLegacy(name: FingerName, side: Side, amount: number): void {
    this.hands.curlFinger(name, side, amount);
  }

  /** Legacy direct hand write, used by Body only for an explicit limiter opt-out. */
  curlHandLegacy(side: Side, spec: FingerSpec, spread: FingerSpec = {}): void {
    for (const finger of FINGER_NAMES) _fSpec[finger] = spec[finger] ?? 0;
    this.hands.curlHand(side, spec, spread);
    // Before clearance bends any: record the uncropped shape in the frame the
    // reached hand actually carries wherever it is placed next.
    this.noteFingers(side);
    this.clearFingers(side, spec, spread);
    // `clearFingers` can bend the fingers farther or straighten them to keep
    // their tips off the face. Preserve the final rendered controls for the
    // next constrained re-seed, rather than the values before clearance.
    this.copyPosedFingerSpec(side, _fSpec, spread);
  }

  /** How far off the skin a finger's bones are held: half its thickness, from the knuckle pitch. */
  fingerClearance(side: Side): number {
    return 0.5 * FINGER_WIDTH * (this.p.limb?.[`pitch.${side}`] ?? 0);
  }

  /**
   * The hand's finger joints and tips as last posed, in the frame of the
   * pointing direction and palm it actually reached (see `handFrame`): where
   * a hand puts its fingers, for placing it somewhere it has not been yet. A
   * roll budget and wrist limits can leave the hand short of the request;
   * measuring the bones in that requested frame makes the recorded shape
   * depend on how much the pose was clamped. `clearFace` feeds that shape into
   * the next frame's wrist target, so the mismatch feeds back into the arm and
   * made face poses depend on the update rate.
   */
  fingerShape(side: Side): readonly THREE.Vector3[] {
    return this._fingerShape[side];
  }

  private noteFingers(side: Side): void {
    const hand = this.p.bones[`hand.${side}`];
    const palm = this.palmLocal[side];
    if (!(hand && palm)) return;
    // The fingers are where the reached bones put them, even if the requested
    // direction and palm could not pass the wrist limits. Using the request as
    // the inverse frame made this shape carry the clamp error into `clearFace`
    // and feed it back into the next hand placement.
    hand.getWorldQuaternion(_fParent);
    _fG.copy(this.p.restDir[`hand.${side}`]).applyQuaternion(_fParent);
    _fN.copy(palm).applyQuaternion(_fParent);
    const F = handFrame(_fG, _fN, _fFrame);
    if (!F) return;
    F.transpose();
    const W = hand.getWorldPosition(_fW);
    const out = this._fingerShape[side];
    let k = 0;
    for (const f of FINGER_NAMES) {
      const chain = this.p.fingerBones[`${f}.${side}`];
      if (!chain?.length) continue;
      for (let i = 0; i <= chain.length; i++) {
        if (!this.fingerPoint(chain, i, _fP)) continue;
        if (k === out.length) out.push(new THREE.Vector3());
        out[k++].copy(_fP).sub(W).applyMatrix3(F);
      }
    }
    out.length = k;
  }

  /**
   * Point `i` of a finger chain, the last one past its last bone: the tip has no
   * bone, so the last segment is carried on, as `limb` estimates it.
   */
  private fingerPoint(chain: THREE.Bone[], i: number, out: THREE.Vector3): boolean {
    if (i < chain.length) {
      chain[i].getWorldPosition(out);
      return true;
    }
    if (chain.length < 2) return false;
    chain[i - 1].getWorldPosition(out);
    out.addScaledVector(
      _fT.subVectors(out, chain[i - 2].getWorldPosition(_fU)),
      FINGER_TIP_EXTENSION,
    );
    return true;
  }

  /**
   * Keep the fingers out of the face: turn the hand about the wrist, and curl a
   * finger the turn could not free.
   *
   * The arm's escape ends the hand at the palm's contact point, deliberately —
   * see `HAND_CONTACT` — so the fingers past it went wherever the hand pointed:
   * a hand turning from behind the ear to the mouth swept them through the
   * cheek, and curled knuckles beside a cheek sank into it. Each joint and the
   * tip is held half a finger's thickness off the skin, that thickness taken
   * from the avatar's own knuckle pitch. Only the hand and its fingers move, so
   * the arm above them, and everything it reported, stands.
   */
  private clearFingers(side: Side, spec: FingerSpec, spread: FingerSpec): void {
    const face = this.anat.face;
    const hand = this.p.bones[`hand.${side}`];
    const clear = this.fingerClearance(side);
    const parent = hand?.parent;
    if (!(face && hand && parent && clear > 0)) return;
    const damp = FINGER_DAMP * clear * clear;
    face.refresh();
    hand.updateWorldMatrix(true, true);
    const W = hand.getWorldPosition(_fW);
    let turned = 0;
    for (let pass = 0; pass < FINGER_PASSES && turned < FINGER_TURN_MAX; pass++) {
      // One small turn for every finger that is in, solved together. Pushing
      // the worst one alone pressed the next one in: fingers kissed to the lips
      // touch skin that faces several ways, and the hand rocked between them.
      // Each point gains (w x r).n = w.(r x n) along its normal; least squares
      // over that, damped so a point straight down the lever does not throw it.
      _fA.set(0, 0, 0, 0, 0, 0, 0, 0, 0);
      _fB.set(0, 0, 0);
      let any = false;
      for (const f of FINGER_NAMES) {
        const chain = this.p.fingerBones[`${f}.${side}`];
        if (!chain?.length) continue;
        for (let i = 0; i <= chain.length; i++) {
          if (!this.fingerPoint(chain, i, _fP)) continue;
          const d = face.shortfall(_fP, clear, _fN);
          if (d <= 0) continue;
          any = true;
          const g = _fG.copy(_fP).sub(W).cross(_fN);
          const e = _fA.elements;
          e[0] += g.x * g.x;
          e[1] += g.y * g.x;
          e[2] += g.z * g.x;
          e[3] += g.x * g.y;
          e[4] += g.y * g.y;
          e[5] += g.z * g.y;
          e[6] += g.x * g.z;
          e[7] += g.y * g.z;
          e[8] += g.z * g.z;
          _fB.addScaledVector(g, d);
        }
      }
      if (!any) return;
      const e = _fA.elements;
      e[0] += damp;
      e[4] += damp;
      e[8] += damp;
      const w = _fB.applyMatrix3(_fA.invert());
      const angle = w.length();
      if (!(angle > 1e-6)) break;
      const turn = Math.min(angle, FINGER_TURN_MAX - turned);
      turned += turn;
      _fTurn.setFromAxisAngle(w.divideScalar(angle), turn);
      // A world turn about the wrist, put into the hand's own parent space.
      parent.getWorldQuaternion(_fParent);
      hand.quaternion.premultiply(
        _fLocal.copy(_fParent).invert().multiply(_fTurn).multiply(_fParent),
      );
      hand.updateWorldMatrix(false, true);
    }

    // What the turn left in: fingers pressed on skin facing opposite ways, the
    // tip under the jaw and the knuckles at the cheek. A finger gives to what
    // it is pushed into, so each one left in curls or straightens on its own,
    // least squares over its points, between straight and its full flexion.
    for (const f of FINGER_NAMES) _fSpec[f] = spec[f] ?? 0;
    for (let pass = 0; pass < FINGER_PASSES; pass++) {
      let moved = false;
      for (const f of FINGER_NAMES) {
        const chain = this.p.fingerBones[`${f}.${side}`];
        const from = _fSpec[f] ?? 0;
        const lo = Math.min(from, 0) - from;
        const hi = Math.max(from, 1) - from;
        if (!chain?.length) continue;
        let n = 0;
        for (let i = 0; i <= chain.length && n < _fIn.length; i++) {
          if (!this.fingerPoint(chain, i, _fIn[n].p)) continue;
          _fIn[n].d = face.shortfall(_fIn[n].p, clear, _fIn[n].n);
          if (_fIn[n].d > 0) _fIn[n++].i = i;
        }
        if (!n) continue;
        // The curl's lever on each point, by a small trial flexion.
        _fSpec[f] = from + FINGER_CURL_PROBE;
        this.hands.curlHand(side, _fSpec, spread);
        hand.updateWorldMatrix(false, true);
        let num = 0;
        let den = damp;
        for (let k = 0; k < n; k++) {
          const q = _fIn[k];
          this.fingerPoint(chain, q.i, _fP);
          const j = _fP.sub(q.p).dot(q.n) / FINGER_CURL_PROBE;
          num += j * q.d;
          den += j * j;
        }
        _fSpec[f] = from + THREE.MathUtils.clamp(num / den, lo, hi);
        this.hands.curlHand(side, _fSpec, spread);
        hand.updateWorldMatrix(false, true);
        if (_fSpec[f] !== from) moved = true;
      }
      if (!moved) return;
    }
  }
}
const _hfY = new THREE.Vector3();
const _hfZ = new THREE.Vector3();
/**
 * The frame a hand's pointing direction and palm normal make, as columns:
 * pointing, palm, and their cross. Null when the two are parallel. Normalises
 * `point` in place.
 */
export function handFrame(
  point: THREE.Vector3,
  palm: THREE.Vector3,
  out: THREE.Matrix3,
): THREE.Matrix3 | null {
  const x = point.lengthSq() > 1e-12 ? point.normalize() : null;
  if (!x) return null;
  const y = _hfY.copy(palm).addScaledVector(x, -palm.dot(x));
  if (y.lengthSq() < 1e-8) return null;
  y.normalize();
  const z = _hfZ.crossVectors(x, y);
  return out.set(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z);
}
