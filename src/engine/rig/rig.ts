import * as THREE from 'three';
import { ArmAnatomy, FINGER_WIDTH, HAND_CONTACT, JOINTS } from '../anatomy';
import type { HandSensePose } from '../motion/finger-life';
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
} from '../types';
import { FINGER_NAMES } from '../types';
import { ArmChain } from './arm-chain';
import type { ArmConfiguration, ArmForwardContext, ArmForwardResult } from './arm-configuration';
import {
  ArmDriver,
  type ArmDriverAcceptedSnapshot,
  FRAME_TOLERANCE,
  positiveConformalScale,
} from './arm-driver';
import type { ArmPathEnvironment, ArmPathPlanOutput } from './arm-path';
import { ArmTwists } from './arm-twists';
import { ElbowSearch } from './elbow';
import { FingerClearance, handFrame } from './finger-clearance';
import { ShoulderGirdle } from './girdle';
import {
  captureHandContactGeometry,
  type HandContactCalibration,
  type HandGeometrySample,
  makeHandGeometrySample,
  sampleHandContact,
  sampleHandGeometry,
} from './hand-geometry';
import { Hands } from './hands';
import { GroundedLegs } from './legs';
import { type PointRequest, PointSolver } from './point';
import type { ArmSolution, ReachLinks } from './reach';
import { solveReach } from './reach';
import { SkeletonRefresh } from './skeleton';
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
 * stops, and spending the roll that turns a palm over. The five questions that
 * are not the arm's are beside it — `spine.ts` for the additive half of a
 * frame, `hands.ts` for the fingers, `elbow.ts` for where the elbow goes once a
 * wrist position is fixed, `girdle.ts` for the clavicle's turn that makes the
 * arm room, and `point.ts` for turning a fingertip bearing into a wrist
 * target. `legs.ts` adds optional standing contact before those arm targets
 * are solved, so a pelvis correction also moves their reach origins.
 */

const _q = new THREE.Quaternion();
const _armS = new THREE.Vector3();
// Stands in for a bone that was never given a rest orientation, which cannot
// happen for a bone the profile resolved. Only ever read.
const _restFallback = new THREE.Quaternion();

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
  /** Signed authored jump translation; the foot solver clamps its anchor lift. */
  rise: number;
  /** Radians about world up the skeleton is turned; the slots hold the pre-turn pelvis. */
  turn: number;
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

export type { PointRequest } from './point';
export type { OffsetSlot } from './spine';

export class Rig {
  readonly p: Profile;
  private readonly armTwists: ArmTwists | null;
  /** bone -> rest quaternion */
  readonly rest = new Map<THREE.Bone, THREE.Quaternion>();

  readonly anat: ArmAnatomy;
  readonly joints: JointTable;

  /** The additive half of a frame: spine and eyes. See `spine.ts`. */
  private readonly spine: SpineOffsets;
  /** The clavicle's room-making turn. See `girdle.ts`. */
  private readonly girdle: ShoulderGirdle;
  /** Optional standing legs: foot contact is solved before the arms. */
  private readonly legs: GroundedLegs | null;
  /** The pass that stands in for a full one once only bones have moved; see `skeletonOnly`. */
  private readonly skeleton: SkeletonRefresh;
  /** The fingers, which are curled rather than aimed. See `hands.ts`. */
  private readonly hands: Hands;
  /** Fingers held off the face, and the shape they last took. See `finger-clearance.ts`. */
  private readonly fingers: FingerClearance;
  /** The arm's bone writes, roll budget and limiter slew. See `arm-chain.ts`. */
  private readonly chain: ArmChain;
  /** Where the elbow goes once a wrist position is fixed. See `elbow.ts`. */
  private readonly elbow: ElbowSearch;
  /** A bearing, back-solved into an arm. See `point.ts`. */
  private readonly point: PointSolver;

  /**
   * Off switch for the anatomical limiting, so a pose can be compared against
   * what the raw geometry produces. Worth keeping: when a gesture looks
   * wrong, the first question is whether the limiter caused it or revealed
   * it, and that is one toggle rather than an afternoon. Only the limiting
   * goes: hand contact is still predicted and the face still clears the hand,
   * so both runs are asked for the same reach.
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
    this.chain.releaseSlew();
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

  /** The humerus's front at rest, in its own space: the way the elbow folds. */
  private readonly _humeralFront: Partial<Record<Side, THREE.Vector3>> = {};
  private readonly _contactPrediction: Partial<
    Record<
      Side,
      {
        calibration: HandContactCalibration;
        sample: HandGeometrySample;
        contact: THREE.Vector3;
        shape: readonly THREE.Vector3[];
        bindFrame: THREE.Matrix3;
      }
    >
  > = {};
  /**
   * Why the constrained arm solver is off, one line per side whose arm bones
   * resolved but built no driver. It needs both sides, so any line here means
   * both arms run the legacy chain.
   */
  readonly armSolverOff: string[] = [];
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
  private _acceptedTurn = 0;
  private _lastPlantSuccess = true;
  private readonly _prePlantHips = new THREE.Vector3();
  private readonly _postPlantHips = new THREE.Vector3();
  private readonly _preTurnHipsQ = new THREE.Quaternion();
  private readonly _postTurnHipsQ = new THREE.Quaternion();
  private readonly _turnMatrix = new THREE.Matrix4();
  private readonly _turnScratch = new THREE.Matrix4();
  private readonly _turnPivot = new THREE.Vector3();
  private readonly _turnScale = new THREE.Vector3();
  private readonly _transportUp = new THREE.Vector3();
  private readonly _transportInverse = new THREE.Matrix3();
  private readonly _nativeArmEnvironment: Partial<
    Record<
      Side,
      {
        environment: ArmPathEnvironment;
        sample: ArmPathEnvironment['sample'];
        rowCount: number;
        sampleEnvironment: ArmDriver['sampleEnvironment'];
      }
    >
  > = {};
  private readonly _actualUpper = new THREE.Vector3();
  private readonly _actualLower = new THREE.Vector3();
  private readonly _actualHand = new THREE.Vector3();
  private readonly _actualPalm = new THREE.Vector3();
  private readonly _applyParentQ = new THREE.Quaternion();
  private readonly _applyLocalQ = new THREE.Quaternion();
  private readonly _applyTargetQ = new THREE.Quaternion();
  private readonly _measureQ = new THREE.Quaternion();
  private readonly _measureA = new THREE.Vector3();
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
    this.skeleton = new SkeletonRefresh(profile.root);
    this.captureArmFrameMetrics();

    const all = [...Object.values(profile.bones), ...Object.values(profile.fingerBones).flat()];
    for (const b of all) this.rest.set(b, b.quaternion.clone());
    this.armTwists = ArmTwists.create(profile);
    this.spine = new SpineOffsets(profile);
    this.legs = GroundedLegs.create(profile, (bone) => this.restOf(bone));

    this.joints = profile.anatomy ?? JOINTS;
    this.girdle = new ShoulderGirdle(profile, this.joints);
    this.hands = new Hands(profile, this.joints, (bone) => this.restOf(bone));

    // Anatomy has to be built after the finger axes: it reads the same rest
    // geometry to work out which side of the hand the thumb is on.
    this.anat = new ArmAnatomy(profile);
    this.fingers = new FingerClearance(profile, this.hands, this.anat, (side) =>
      this.fingerClearance(side),
    );
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
    this.chain = new ArmChain(
      profile,
      this.joints,
      this.anat,
      this.hands.palmLocal,
      this._humeralFront,
      this.foreRoll,
      this.upperRoll,
      this.armTwists,
      (bone) => this.restOf(bone),
      {
        dt: () => this.dt,
        limitsEnabled: () => this.limitsEnabled,
        armContext: (side) => this.armContext(side),
      },
    );

    const initialHips = profile.bones.hips;
    if (initialHips) {
      this._prePlantHips.copy(initialHips.position);
      this._postPlantHips.copy(initialHips.position);
      this._preTurnHipsQ.copy(initialHips.quaternion);
      this._postTurnHipsQ.copy(initialHips.quaternion);
    }
    this._acceptedBodyPose = this.makeBodyPoseSnapshot();
    this._proposedBodyPose = this.makeBodyPoseSnapshot();
    this.captureBodyPose(this._acceptedBodyPose, 0, 0);
    this.captureBodyPose(this._proposedBodyPose, 0, 0);
    for (const side of ['L', 'R'] as Side[]) {
      if (!profile.bones[`upperArm.${side}`]) continue;
      const off = (reason: string) => this.armSolverOff.push(`${side}: ${reason}`);
      const palmLocal = this.palmLocal[side];
      const humeralFront = this._humeralFront[side];
      if (!(palmLocal && humeralFront)) {
        off('no palm frame (fingers unresolved)');
        continue;
      }
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
      if (!(driver instanceof ArmDriver)) {
        off(driver.refused);
        continue;
      }
      const context = this.armForwardContext(side);
      if (!(context && this.readActualArmPose(side))) {
        off('rest arm pose unreadable');
        continue;
      }
      if (
        !driver.seedFromPose(
          context,
          this._actualUpper,
          this._actualLower,
          this._actualHand,
          this._actualPalm,
        )
      ) {
        off('rest arm pose outside the calibrated model');
        continue;
      }
      this._armDrivers[side] = driver;
      const bindFrame = handFrame(
        driver.calibration.hand.axis.clone(),
        driver.calibration.hand.palm.clone(),
        new THREE.Matrix3(),
      );
      if (bindFrame) {
        const sample = makeHandGeometrySample(driver.handGeometry);
        this._contactPrediction[side] = {
          calibration: captureHandContactGeometry(
            driver.handGeometry,
            driver.calibration.hand.palm,
          ),
          sample,
          contact: new THREE.Vector3(),
          shape: sample.points.map((point) => point.position),
          bindFrame,
        };
      }
      this._nativeArmEnvironment[side] = {
        environment: driver.environment,
        sample: driver.environment.sample,
        rowCount: driver.environment.rowCount,
        sampleEnvironment: driver.sampleEnvironment,
      };
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
      if (
        !(
          left &&
          right &&
          this.commitArmFrame({ L: left, R: right }, this._acceptedRise, this._acceptedTurn)
        )
      )
        return false;

      for (const side of ['L', 'R'] as Side[]) {
        const driver = this._armDrivers[side];
        if (!driver) return false;
        driver.requestRollHistory = driver.acceptedConfiguration.forearmRoll;
      }
      this.captureBodyPose(this._proposedBodyPose, this._acceptedRise, this._acceptedTurn);
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

  /**
   * Borrowed metric hand-bone geometry; valid until the next prediction for this side.
   *
   * Not gated on the limiter: the calibration is the avatar's shape alone, and
   * withholding it with the limiter off moved that run's blowKiss request 5.8 cm.
   */
  predictHandContact(
    side: Side,
    selector: HandContact,
    curls: FingerSpec,
    spread: FingerSpec,
  ): {
    readonly contact: Readonly<THREE.Vector3>;
    readonly shape: readonly THREE.Vector3[];
    readonly bindFrame: Readonly<THREE.Matrix3>;
  } | null {
    const prediction = this._contactPrediction[side];
    if (!(prediction && this.bothArmFramesSupported())) return null;
    if (
      !sampleHandContact(
        prediction.calibration,
        curls,
        spread,
        selector,
        this.fingerClearance(side),
        prediction.contact,
      )
    )
      return null;
    sampleHandGeometry(prediction.calibration.geometry, curls, spread, prediction.sample);
    for (const point of prediction.shape) {
      if (!(Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)))
        return null;
    }
    return prediction;
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
    this.chain.releaseContinuity();
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
  finishLegacyBodyFrame(rise: number, turn = 0): void {
    if (!(this._limitsEnabled && this.bothArmFramesSupported())) {
      this.invalidateArmContinuation();
    } else if (!this._armContinuationReady && this.reseedConstrainedArms(rise, turn)) {
      this._armContinuationReady = true;
      this._externalArmRevision++;
    }
    this.armTwists?.accept('L');
    this.armTwists?.accept('R');
  }

  /** Refresh and return this side's reusable FK frame. */
  armForwardContext(side: Side): ArmForwardContext | null {
    return this.readArmForwardContext(side, true);
  }

  /**
   * @internal Read synchronously after applyBodyContext has refreshed the scene.
   * Native evaluation only changes scratch state between the two arm reads.
   * Custom evaluators and a hips frame outside the root retain eager refreshes.
   */
  armForwardContextFromUpdatedBody(side: Side): ArmForwardContext | null {
    if (!this.nativeArmEvaluation()) return this.armForwardContext(side);
    for (let parent = this.p.bones.hips?.parent; parent; parent = parent.parent) {
      if (parent === this.p.root) return this.readArmForwardContext(side, false);
    }
    return this.armForwardContext(side);
  }

  /** Both arms evaluate natively, which writes scratch state and never the scene. */
  private nativeArmEvaluation(): boolean {
    for (const side of ['L', 'R'] as const) {
      const driver = this._armDrivers[side];
      const native = this._nativeArmEnvironment[side];
      if (
        !(
          driver &&
          native &&
          driver.environment === native.environment &&
          driver.environment.sample === native.sample &&
          driver.environment.rowCount === native.rowCount &&
          driver.sampleEnvironment === native.sampleEnvironment
        )
      )
        return false;
    }
    return true;
  }

  /**
   * True when the legs were planted this frame and only bones have moved since:
   * that plant refreshed the whole scene, so the skeleton is all a pass need cover.
   * A custom arm evaluator may have moved anything after it, so it keeps full passes.
   */
  private skeletonOnly(afterPlant: boolean): boolean {
    return afterPlant && this.legs !== null && this.nativeArmEvaluation();
  }

  private refreshScene(afterPlant: boolean): void {
    if (this.skeletonOnly(afterPlant)) this.skeleton.run();
    else this.p.root.updateMatrixWorld(true);
  }

  private readArmForwardContext(side: Side, refreshScene: boolean): ArmForwardContext | null {
    const upper = this.p.bones[`upperArm.${side}`];
    const parent = upper?.parent;
    const upperLength = this.p.limb?.[`upper.${side}`] ?? 0;
    const lowerLength = this.p.limb?.[`lower.${side}`] ?? 0;
    if (!(upper && parent && upperLength > 0 && lowerLength > 0 && this.anat.update())) return null;
    if (refreshScene) this.p.root.updateMatrixWorld(true);
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
  captureProposedBodyContext(rise: number, turn = 0): void {
    this.captureBodyPose(this._proposedBodyPose, rise, turn);
  }

  /**
   * Rebuild articulation and common airborne transport with separate progress.
   *
   * @param afterPlant the caller planted the legs earlier this frame and has
   *                   moved only bones since
   */
  applyBodyContext(alpha: number, transportProgress = alpha, afterPlant = false): number {
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
    const rise = THREE.MathUtils.lerp(
      a.rise,
      b.rise,
      THREE.MathUtils.clamp(transportProgress, 0, 1),
    );
    if (hips) {
      hips.position.lerpVectors(a.hipsPosition, b.hipsPosition, blend);
      hips.position.addScaledVector(this.transportUp(), rise);
    }
    const turn = THREE.MathUtils.lerp(
      a.turn,
      b.turn,
      THREE.MathUtils.clamp(transportProgress, 0, 1),
    );
    this.plantLegs(rise, turn, afterPlant);
    // Grounded legs refresh the whole scene before they read it and every bone
    // they write after that, so only a body without them still needs a pass.
    if (!this.legs) this.p.root.updateMatrixWorld(true);
    this.anat.update();
    return rise;
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

  /**
   * Apply and accept both sides only after the common-alpha frame is complete.
   *
   * @param afterPlant as for `applyBodyContext`
   */
  commitArmFrame(
    plans: Record<Side, ArmFrameSideCommit>,
    rise: number,
    turn = 0,
    afterPlant = false,
  ): boolean {
    for (const side of ['L', 'R'] as Side[]) if (!this.canWriteArm(side)) return false;
    // Each side writes only its own chain and reads its parents fresh, so one
    // pass after both covers what either side's fingers left stale.
    for (const side of ['L', 'R'] as Side[]) {
      const plan = plans[side];
      this.writeArmForward(side, plan.output.forward);
      this.hands.curlHand(side, plan.curls, plan.spread);
      this.copyPosedFingerSpec(side, plan.curls, plan.spread);
    }
    this.refreshScene(afterPlant);
    for (const side of ['L', 'R'] as Side[]) {
      const plan = plans[side];
      const driver = this._armDrivers[side];
      if (!driver) return false;
      driver.accept(plan.output.q, plan.context, plan.curls, plan.spread);
      this.foreRoll[side] = driver.acceptedConfiguration.forearmRoll;
      this.upperRoll[side] = 0;
      this.fingers.noteFingers(side);
      this._acceptedHandPose[side] = this.captureHandPose(side, false);
      this.captureAcceptedArmState(side, driver.acceptedForward, plan.curls, plan.spread);
    }
    this.captureBodyPose(this._acceptedBodyPose, rise, turn);
    this._acceptedRise = rise;
    this._acceptedTurn = turn;
    this.armTwists?.accept('L');
    this.armTwists?.accept('R');
    return true;
  }

  /**
   * Accept only the common signed jump translation after an articulated frame
   * could not be certified. Native torso/head/face self-clearances are invariant
   * under this rigid upper-body translation and yaw. Legs still solve contact;
   * custom environments and carriers outside the hips subtree have no such
   * guarantee.
   */
  commitArmTransport(lift: number, turn = 0, afterPlant = false): boolean {
    if (
      !(
        Number.isFinite(lift) &&
        Number.isFinite(turn) &&
        lift === this._proposedBodyPose.rise &&
        turn === this._proposedBodyPose.turn &&
        (lift !== this._acceptedRise || turn !== this._acceptedTurn) &&
        this._limitsEnabled &&
        this._armContinuationReady &&
        this.bothArmFramesSupported()
      )
    )
      return false;
    for (const side of ['L', 'R'] as Side[]) {
      const driver = this._armDrivers[side];
      const native = this._nativeArmEnvironment[side];
      if (
        !(
          driver &&
          native &&
          this.canWriteArm(side) &&
          driver.environment === native.environment &&
          driver.environment.sample === native.sample &&
          driver.environment.rowCount === native.rowCount &&
          driver.sampleEnvironment === native.sampleEnvironment
        )
      )
        return false;
    }
    if (!this.transportTopologySupported()) return false;
    for (const snapshot of [this._acceptedBodyPose, this._proposedBodyPose]) {
      const position = snapshot.hipsPosition;
      if (
        ![position.x, position.y, position.z, snapshot.rise, snapshot.turn].every(Number.isFinite)
      )
        return false;
      for (const slot of BODY_SNAPSHOT_SLOTS) {
        if (!this.p.bones[slot]) continue;
        const q = snapshot.slots[slot];
        if (!(q && [q.x, q.y, q.z, q.w].every(Number.isFinite))) return false;
      }
    }
    this.applyBodyContext(0, 1, afterPlant);
    const left = this.armForwardContextFromUpdatedBody('L');
    const right = this.armForwardContextFromUpdatedBody('R');
    if (!(left && right && this._lastPlantSuccess)) {
      this.applyBodyContext(0, 0, afterPlant);
      return false;
    }
    // Both contexts are ready before accepted history changes on either side.
    // Keep configurations, controls and roll history exactly as last accepted.
    for (const side of ['L', 'R'] as Side[]) {
      const driver = this._armDrivers[side] as ArmDriver;
      const context = side === 'L' ? left : right;
      const forward = driver.refreshAcceptedForward(context);
      this.writeArmForward(side, forward);
      this.hands.curlHand(side, driver.acceptedCurls, driver.acceptedSpread);
      this.copyPosedFingerSpec(side, driver.acceptedCurls, driver.acceptedSpread);
    }
    this.refreshScene(afterPlant);
    for (const side of ['L', 'R'] as Side[]) {
      const driver = this._armDrivers[side] as ArmDriver;
      this.fingers.noteFingers(side);
      this._acceptedHandPose[side] = this.captureHandPose(side, false);
      this.captureAcceptedArmState(
        side,
        driver.acceptedForward,
        driver.acceptedCurls,
        driver.acceptedSpread,
      );
    }
    this.captureBodyPose(this._acceptedBodyPose, lift, turn);
    this._acceptedRise = lift;
    this._acceptedTurn = turn;
    return true;
  }

  /** Every self-clearance carrier must share the hips translation, not leg IK. */
  private transportTopologySupported(): boolean {
    const hips = this.p.bones.hips;
    if (!hips) return false;
    const legBones = new Set<THREE.Object3D>();
    for (const side of ['L', 'R'] as Side[]) {
      for (const part of ['upperLeg', 'lowerLeg', 'foot', 'toe'] as const) {
        const bone = this.p.bones[`${part}.${side}`];
        if (bone) legBones.add(bone);
      }
    }
    const carried = (object: THREE.Object3D): boolean => {
      for (let node: THREE.Object3D | null = object; node; node = node.parent) {
        if (legBones.has(node)) return false;
        if (node === hips) return true;
      }
      return false;
    };
    for (const slot of BODY_SNAPSHOT_SLOTS) {
      const bone = this.p.bones[slot];
      if (bone && !carried(bone)) return false;
    }
    for (const side of ['L', 'R'] as Side[]) {
      for (const part of ['upperArm', 'lowerArm', 'hand'] as const) {
        const bone = this.p.bones[`${part}.${side}`];
        if (!(bone?.parent && carried(bone) && carried(bone.parent))) return false;
      }
      for (const finger of FINGER_NAMES) {
        for (const bone of this.p.fingerBones[`${finger}.${side}`] ?? []) {
          if (!carried(bone)) return false;
        }
      }
    }
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
    this.armTwists?.reset();
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
    return { slots, hipsPosition: new THREE.Vector3(), rise: 0, turn: 0 };
  }

  private captureBodyPose(out: RigBodyPoseSnapshot, rise: number, turn: number): void {
    for (const slot of BODY_SNAPSHOT_SLOTS) {
      const bone = this.p.bones[slot];
      const target = out.slots[slot];
      if (bone && target) target.copy(bone.quaternion);
    }
    const hips = this.p.bones.hips;
    out.rise = rise;
    out.turn = turn;
    if (hips) {
      // Same for the yaw: the snapshot keeps the pelvis as posed, so replaying
      // the turn does not turn an already-turned pelvis again.
      if (out.slots.hips && hips.quaternion.equals(this._postTurnHipsQ)) {
        out.slots.hips.copy(this._preTurnHipsQ);
      }
      // Contact may have corrected the pelvis. Preserve its authored input so
      // retries do not feed a previous leg correction back into the next one.
      out.hipsPosition.copy(
        hips.position.equals(this._postPlantHips) ? this._prePlantHips : hips.position,
      );
      out.hipsPosition.addScaledVector(this.transportUp(), -out.rise);
    }
  }

  /** World-up metres expressed in the actual hips parent's local frame. */
  private transportUp(): THREE.Vector3 {
    this._transportUp.set(0, 1, 0);
    const parent = this.p.bones.hips?.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      this._transportInverse.setFromMatrix4(parent.matrixWorld).invert();
      this._transportUp.applyMatrix3(this._transportInverse);
    }
    return this._transportUp;
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
    this.armTwists?.stage(side);
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

  /** `refreshScene` false: the caller refreshed the scene and wrote nothing since. */
  private captureHandPose(side: Side, refreshScene = true): HandSensePose | null {
    const hand = this.p.bones[`hand.${side}`];
    const elbow = this.p.bones[`lowerArm.${side}`];
    const palmLocal = this.palmLocal[side];
    const knuckle = this.p.fingerBones[`middle.${side}`]?.[0];
    const index = this.p.fingerBones[`index.${side}`]?.[0];
    const little = this.p.fingerBones[`little.${side}`]?.[0];
    if (!(hand && elbow && palmLocal && knuckle && index && little)) return null;
    if (refreshScene) this.p.root.updateMatrixWorld(true);
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

  readHeadOffset(out: THREE.Quaternion): boolean {
    return this.spine.readHeadOffset(this.p, out);
  }

  commitEyes(): void {
    this.spine.commitEyes(this.p, (bone) => this.restOf(bone));
  }

  /**
   * Keep standing feet planted, or carry their contact points through a hop.
   * `turn` (radians about world up) yaws the whole skeleton about the stance
   * centre and carries the legs through the same turn. `afterPlant` as for
   * `applyBodyContext`.
   */
  plantLegs(rise: number, turn = 0, afterPlant = false): void {
    const hips = this.p.bones.hips;
    if (hips) {
      this._prePlantHips.copy(hips.position);
      this._preTurnHipsQ.copy(hips.quaternion);
    }
    const yaw = Number.isFinite(turn) ? turn : 0;
    if (hips && yaw !== 0) this.turnHips(hips, yaw);
    this._lastPlantSuccess = this.legs
      ? this.legs.apply(rise, yaw, this.skeletonOnly(afterPlant) ? this.skeleton : null)
      : true;
    if (hips) {
      this._postPlantHips.copy(hips.position);
      this._postTurnHipsQ.copy(hips.quaternion);
    }
  }

  // Pivot on the stance centre, not the hips: the pelvis sits a few centimetres
  // ahead of the feet, and a yaw about its own vertical sweeps each foot on that
  // radius and lands it off its mark.
  private turnHips(hips: THREE.Bone, turn: number): void {
    const parent = hips.parent;
    if (!parent) return;
    parent.updateWorldMatrix(true, false);
    hips.updateMatrix();
    const world = this._turnMatrix.multiplyMatrices(parent.matrixWorld, hips.matrix);
    const pivot = this._turnPivot;
    if (this.legs) this.legs.stancePivot(pivot);
    else pivot.setFromMatrixPosition(world);
    // T(p) R_y(turn) T(-p) hipsWorld, carried back through the parent's inverse.
    world.premultiply(this._turnScratch.makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    world.premultiply(this._turnScratch.makeRotationY(turn));
    world.premultiply(this._turnScratch.makeTranslation(pivot.x, pivot.y, pivot.z));
    world.premultiply(this._turnScratch.copy(parent.matrixWorld).invert());
    world.decompose(hips.position, hips.quaternion, this._turnScale);
    hips.updateMatrix();
  }

  /** See `ShoulderGirdle.girdleRoom`. */
  girdleRoom(
    side: Side,
    targetWorld: THREE.Vector3,
    dir: Vec3Tuple,
    weight: number,
    turnOut: THREE.Vector3,
  ): void {
    this.girdle.girdleRoom(side, targetWorld, dir, weight, turnOut);
  }

  /** See `ShoulderGirdle.turnGirdle`. */
  turnGirdle(dir: Vec3Tuple, turn: THREE.Vector3): void {
    this.girdle.turnGirdle(dir, turn);
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
    this.chain.aimShoulder(side, dir);
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
    if (output.status === 'progress' || output.status === 'settled') return output;
    // A static pose has no temporal path promise; if the optimization cannot
    // move, or stops short at a box minimum, test the exact inverse request as
    // a complete endpoint.
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
    this.fingers.noteFingers(side);
    this._acceptedHandPose[side] = this.captureHandPose(side, false);
    this.captureAcceptedArmState(side, driver.acceptedForward, curls, spread);
    this.captureBodyPose(this._acceptedBodyPose, this._acceptedRise, this._acceptedTurn);
    if (bumpRevision) this._externalArmRevision++;
    this.armTwists?.accept(side);
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
    this.armTwists?.accept(side);
    if (!this.captureAcceptedArmState(side, null, this._posedCurls[side], this._posedSpread[side]))
      return;
    this._acceptedHandPose[side] = this.captureHandPose(side, false);
    this.captureBodyPose(this._acceptedBodyPose, this._acceptedRise, this._acceptedTurn);
    this._externalArmRevision++;
  }

  private reseedConstrainedArms(rise = this._acceptedRise, turn = this._acceptedTurn): boolean {
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
    this._acceptedTurn = turn;
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
   *
   * @returns false when a constrained side rejected the request: the arm, its
   * clavicle and the accepted history stay exactly as they were. Falling back
   * to the unconstrained writer there would publish a pose no limit certified.
   */
  aimArm(
    side: Side,
    dirs: Record<ArmSlot, Vec3Tuple>,
    twist = 0,
    palmTarget: Vec3Tuple | null = null,
    palmWeight = 1,
  ): boolean {
    if (this.constrainedSideSupported(side)) {
      return this.tryStaticAimArm(side, dirs, twist, palmTarget, palmWeight);
    }
    this.aimArmLegacy(side, dirs, twist, palmTarget, palmWeight);
    this.noteExternalArmEdit(side);
    return true;
  }

  /** Legacy single-chain path, used only when limiting is explicitly disabled or unsupported. */
  aimArmLegacy(
    side: Side,
    dirs: Record<ArmSlot, Vec3Tuple>,
    twist = 0,
    palmTarget: Vec3Tuple | null = null,
    palmWeight = 1,
  ): void {
    this.chain.aimArmLegacy(side, dirs, twist, palmTarget, palmWeight);
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

  /**
   * Curl a finger. See `Hands.curlFinger`.
   *
   * @returns false when a constrained side rejected the shape, as `aimArm`.
   */
  curlFinger(name: FingerName, side: Side, amount: number): boolean {
    if (this.constrainedSideSupported(side)) {
      const curls = { ...this._posedCurls[side], [name]: amount };
      return this.tryStaticHand(side, curls, this._posedSpread[side]);
    }
    this.curlFingerLegacy(name, side, amount);
    this._posedCurls[side][name] = amount;
    this.noteExternalArmEdit(side);
    return true;
  }

  /** @returns false when a constrained side rejected the shape, as `aimArm`. */
  curlHand(side: Side, spec: FingerSpec, spread: FingerSpec = {}): boolean {
    if (this.constrainedSideSupported(side)) {
      return this.tryStaticHand(side, spec, spread);
    }
    this.curlHandLegacy(side, spec, spread);
    this.noteExternalArmEdit(side);
    return true;
  }

  /** Legacy direct finger write, used by Body only for an explicit limiter opt-out. */
  curlFingerLegacy(name: FingerName, side: Side, amount: number): void {
    // Keep the splay the record holds, as the constrained path does.
    this.hands.curlFinger(name, side, amount, this._posedSpread[side][name]);
  }

  /** Legacy direct hand write, used by Body only for an explicit limiter opt-out. */
  curlHandLegacy(side: Side, spec: FingerSpec, spread: FingerSpec = {}): void {
    this.hands.curlHand(side, spec, spread);
    // Before clearance bends any: record the uncropped shape in the frame the
    // reached hand actually carries wherever it is placed next.
    this.fingers.noteFingers(side);
    const posed = this.fingers.curlClearOfFace(side, spec, spread);
    // `clearFingers` can bend the fingers farther or straighten them to keep
    // their tips off the face. Preserve the final rendered controls for the
    // next constrained re-seed, rather than the values before clearance.
    this.copyPosedFingerSpec(side, posed, spread);
    this.armTwists?.stage(side);
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
    return this.fingers.fingerShape(side);
  }

  /**
   * The world frame, as `handFrame` builds it, that the hand reached when
   * `fingerShape` was recorded: the two together are the hand as last posed.
   */
  fingerFrame(side: Side): Readonly<THREE.Matrix3> {
    return this.fingers.fingerFrame(side);
  }
}
