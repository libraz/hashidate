import * as THREE from 'three';
import type { ArmSolution } from '../rig';
import { LIMIT_SLEW } from '../rig/arm-driver';
import type { ArmFrameSideCommit, Rig, StandingArmPose } from '../rig/rig';
import type {
  ArmSlot,
  FingerName,
  FingerSpec,
  GestureDef,
  GesturePhase,
  GestureVariation,
  PointSpec,
  Pose,
  Profile,
  Side,
  SpineOffsets,
  SpineSlot,
  Vec3Tuple,
} from '../types';
import { ReachAnchors } from './anchors';
import { claspMeasure, claspSpread } from './clasp';
import { gestureDef } from './custom';
import { FingerLife } from './finger-life';
import { DirFollower, OMEGA_PER_RATE, ScalarFollower } from './follow';
import { CharacterFrame, sideMirror } from './frame';
import { Gaze, HEAD_OMEGA, type SpeechGaze } from './gaze';
import { BASE_FINGERS, BASE_PALM, BASE_POSE, pointHand } from './gestures';
import { OPEN_HAND } from './gestures/hands';
import { CROUCH_T, type HopSpec, type JumpArc, planJump, sampleJump } from './jump';
import { aimEyes, makeGazeFrame, prepareGaze } from './look';
import { IdlePosture, type PostureInput } from './posture';
import { ArmResolver, mkReachScratch, type ResolvedArm } from './resolve';
import { FINGER_ONSET, LINK_ONSET, minJerk, onset, reachEnvelope, UNTHREAD } from './timing';

/**
 * Body layer: base pose, idle life (breathing / sway / head / gaze), and the
 * playback of built-in or loaded gesture definitions.
 *
 * Directions are authored in "character space" — x outward from the midline,
 * y up, z forward — and mirrored per side at apply time. Authoring this way
 * means a gesture written once works on either arm and on any rig, because the
 * rig resolves directions rather than local angles.
 */

const ARM_SLOTS: ArmSlot[] = ['shoulder', 'upperArm', 'lowerArm', 'hand'];
/** The link each slot hangs from when poses are blended. See `composeArmTarget`. */
const ARM_PARENT: Partial<Record<ArmSlot, 'upperArm' | 'lowerArm'>> = {
  lowerArm: 'upperArm',
  hand: 'lowerArm',
};
const FINGER_NAMES: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];

/**
 * Idle drift grows toward the extremity: a shoulder barely moves, a hand is
 * never still. Applying it uniformly makes the whole arm wobble as one rigid
 * piece, which is worse than not applying it at all.
 */
const DRIFT_WEIGHT: Record<ArmSlot, number> = {
  shoulder: 0.3,
  upperArm: 0.6,
  lowerArm: 1.0,
  hand: 1.5,
};

/**
 * The arms follow their composed target rather than being set to it.
 *
 * The target is not continuous and cannot be made so: switching gestures moves
 * it by a large angle in a single frame, and a gesture starting moves it fast
 * while its envelope rises. Blending between poses does not fix that — it only
 * decides *which* discontinuous target is in force. A follower does, because no
 * step in the target survives one.
 *
 * The cutoff sits above the fastest authored oscillation (`deny` swings at
 * ~1.4 Hz), so gestures keep their snap; only steps are removed. The value is a
 * direct trade: it caps the per-frame change at roughly 1-exp(-k/60) of the
 * distance to target, so 13 puts a worst-case switch near 11°/frame while
 * costing a 1.2 Hz swing about 13% of its amplitude. Fingers follow slightly
 * slower because a hand changing shape reads as one motion.
 *
 * Quoted in first-order terms, which is how they were measured; `follow.ts`
 * converts. The filter itself is second-order — see there for why.
 */
const ARM_FOLLOW = 13;
const FINGER_FOLLOW = 13;
/**
 * Each finger's share of `FINGER_FOLLOW`. A hand whose five fingers arrive
 * together changes shape like a part being swapped; led by the index and
 * trailed by the little finger, it closes and opens as a ripple.
 */
const FINGER_STAGGER: Record<FingerName, number> = {
  thumb: 1.1,
  index: 1.1,
  middle: 1,
  ring: 0.9,
  little: 0.8,
};
const fingerRate = (f: FingerName): number => FINGER_FOLLOW * FINGER_STAGGER[f];

/**
 * How fast the limb follows while a reach is carrying the wrist through the
 * room.
 *
 * The follower exists to take steps out of a target that jumps. A travelling
 * reach has no steps in it: the target is interpolated from where the wrist
 * already was, on a curve that is smooth in position, velocity and
 * acceleration. So there is nothing left for the filter to do, and what it does
 * instead is bend the path — a lag in *direction* space pulls the hand off the
 * curve it was being sent along, and the arm arrives at each frame's target one
 * pose behind, which is the one thing a travelling reach must not do.
 *
 * Not switched off outright, because the first frame of a travel can still step:
 * the elbow the search picks for the departure point need not be the one the
 * arm was holding. At four times the standing rate that resolves inside three
 * frames and the rest of the path runs where it was aimed.
 */
const TRAVEL_FOLLOW = ARM_FOLLOW * 4;

/**
 * How fast the applied camera-tracking share follows `lookAt`: the head's own
 * settle frequency, so a change in how much it tracks moves like a glance.
 */
const LOOK_FOLLOW = HEAD_OMEGA / OMEGA_PER_RATE;

/**
 * Sides, in the order the arm loop walks them.
 */
const SIDES: readonly Side[] = ['L', 'R'];

/** The travel probe samples the authored opening before playback has begun. */
const PROBE_PHASE: GesturePhase = Object.freeze({ entrance: 0, held: 0 });

/** The arm loop's order for a clasp: the lead hand first, so the follower reads it posed. */
const ORDER_L: readonly Side[] = ['L', 'R'];
const ORDER_R: readonly Side[] = ['R', 'L'];

/**
 * Seconds of lead per radian the arms have to travel.
 *
 * A gesture's authored `lead` is a floor, not the whole answer: how long the
 * arm needs depends on how far it is from where the gesture wants it, and that
 * is not knowable when the gesture is written. Raising a hand from the hip to
 * beside the face is ~100° and takes about half a second; going there from a
 * pose that already has the hand up takes almost none.
 *
 * Moving every distance in the same fixed time is one of the strongest tells
 * that something is machine-driven — people take longer over longer reaches.
 */
const LEAD_PER_RAD = 0.32;

/**
 * A fingertip aim as a caller states it: angles in **degrees**, because the
 * control API and `ctl` speak degrees. `point()` converts to the radians the
 * internal `PointSpec` is in.
 */
export interface PointCommand {
  /** Degrees, 0 straight ahead, positive to the character's right. */
  azimuth?: number;
  /** Degrees, 0 at shoulder height, positive up. */
  elevation?: number;
  /** 0..1 of full reach. */
  extent?: number;
  /** Which fingertip the coordinate refers to. */
  finger?: FingerName;
  point?: Vec3Tuple | null;
  palm?: Vec3Tuple | null;
}

/**
 * A gesture in play. Exported because the UI reads the definition's label and
 * the id straight off the live slot.
 */
export interface ActiveGesture {
  def: GestureDef;
  id: string;
  v: GestureVariation;
  time: number;
  released: boolean;
  speed: number;
  /** Seconds of entrance, this playback's own — see `LEAD_PER_RAD`. */
  lead: number;
  /** This playback's own entrance and post-arrival clock, passed to `build`. */
  phase: { entrance: number; held: number };
  /** Playback time the exit starts at: the end of the hold, or a held pose's release. */
  exitAt: number;
  /** Entrance progress, 0..1, at the moment it was let go; the entrance holds there while the exit runs. */
  releasedIn: number;
}

/**
 * Most gestures fading at once. Each one resolves both arms every frame, and
 * firing gestures faster than their leads would otherwise grow the list without bound.
 */
const MAX_FADING = 4;

const mkSlotWeights = (): Record<ArmSlot, number> => ({
  shoulder: 0,
  upperArm: 0,
  lowerArm: 0,
  hand: 0,
});

/**
 * A gesture on its way out. It keeps moving while its weight decays, and leaves
 * only once that weight is spent — never because another gesture arrived, short
 * of `MAX_FADING` being reached, when its share is folded into the rest.
 */
interface Outgoing {
  g: ActiveGesture;
  /** The hand shape's weight, on its own decay; the finger and clasp blends read it. */
  w: number;
  spineWeight: number;
  spineStart: number;
  /** Per arm link, as `spineWeight` and `spineStart` are for the spine. */
  armW: Record<ArmSlot, number>;
  armStart: Record<ArmSlot, number>;
  armAlive: boolean;
  spineAlive: boolean;
  /** This slot's own solver output and elbow state. */
  reach: Record<Side, ArmSolution>;
  /** This frame's pose and resolved arms. */
  pose: Pose | null;
  arm: Record<Side, ResolvedArm | null>;
}

const mkOutgoing = (g: ActiveGesture): Outgoing => ({
  g,
  w: 0,
  spineWeight: 0,
  spineStart: 0,
  armW: mkSlotWeights(),
  armStart: mkSlotWeights(),
  armAlive: false,
  spineAlive: false,
  reach: mkReachScratch(),
  pose: null,
  arm: { L: null, R: null },
});

/** Whether a pose writes the head or the neck. */
const touchesHead = (s: SpineOffsets | undefined): boolean => !!s && ('head' in s || 'neck' in s);

/** Scratch for the girdle turn gathered across gesture slots. */
const _girdleTurn = new THREE.Vector3();
const _girdleDir = new THREE.Vector3();

/** The frame's breath and drift terms, shared by every arm slot's compose step. */
interface IdleEnv {
  br: number;
  d: number;
  armDrift: number;
  dt: number;
}

interface ArmBridgeSideSample {
  q: Float64Array;
  upperLocal: THREE.Quaternion;
  lowerLocal: THREE.Quaternion;
  handLocal: THREE.Quaternion;
  points: THREE.Vector3[];
  torsoLocal: THREE.Vector3[];
  headLocal: THREE.Vector3[];
  hasTorso: boolean;
  hasHead: boolean;
}

interface ArmBridgeSample {
  s: number;
  side: Record<Side, ArmBridgeSideSample>;
}

interface ArmBridgeInterval {
  from: ArmBridgeSample;
  to: ArmBridgeSample;
  depth: number;
  travel: number;
}

interface ArmFrameWork {
  contextRetries: number;
  armStepRetries: number;
  bridgeSamples: number;
  solverCalls: number;
  solverIterations: number;
  environmentBatches: number;
}

function makeArmBridgeSideSample(pointCount: number): ArmBridgeSideSample {
  return {
    q: new Float64Array(7),
    upperLocal: new THREE.Quaternion(),
    lowerLocal: new THREE.Quaternion(),
    handLocal: new THREE.Quaternion(),
    points: Array.from({ length: pointCount }, () => new THREE.Vector3()),
    torsoLocal: Array.from({ length: pointCount }, () => new THREE.Vector3()),
    headLocal: Array.from({ length: pointCount }, () => new THREE.Vector3()),
    hasTorso: false,
    hasHead: false,
  };
}

function makeArmBridgeSample(pointCounts: Record<Side, number>): ArmBridgeSample {
  return {
    s: 0,
    side: {
      L: makeArmBridgeSideSample(pointCounts.L),
      R: makeArmBridgeSideSample(pointCounts.R),
    },
  };
}

const ARM_BRIDGE_STARTS = [0, 0.25, 0.5, 0.75, 1] as const;
const ARM_BRIDGE_MAX_DEPTH = 8;
const ARM_BRIDGE_MAX_SAMPLES = 96;
const ARM_STEP_BACKTRACKS = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125] as const;

/**
 * Bridge samples one frame's commit may spend across all its context retries:
 * two full bridges. The heaviest ordinary frame measured used 161; seven
 * attempts failing on speed reach 672. Past it the frame keeps its accepted pose.
 * Mirrored weight-shift certification at a 0.5 s step fell from 279 to 185 samples.
 * The changed rejection order needs a render check.
 */
const ARM_FRAME_BRIDGE_BUDGET = 2 * ARM_BRIDGE_MAX_SAMPLES;

/**
 * The two halves of a gesture's envelope, kept apart rather than multiplied.
 *
 * `blend` — their product — is what the pose is worth this frame and is all
 * most of the layer needs. A reach that travels through the room needs them
 * separately: the entrance says how far along its path the hand is, and only
 * the exit may take the arm back off the pose. Multiplying first loses which of
 * the two a falling weight came from, and a reach cannot tell a hand that has
 * not set out yet from one that is being let go.
 */
interface Envelope {
  /** 0 to 1 over the lead, then held. Never falls. */
  entrance: number;
  /** 1 until the gesture is let go, then back to 0. Never rises. */
  exit: number;
}

/** What the director hands the body layer each frame. */
export interface BodyContext {
  headWorldTarget?: THREE.Vector3 | null;
}

const mkDirs = (): Record<ArmSlot, Vec3Tuple> => ({
  shoulder: [0, 0, 0],
  upperArm: [0, 0, 0],
  lowerArm: [0, 0, 0],
  hand: [0, 0, 0],
});

const mkVecs = (): Record<ArmSlot, THREE.Vector3> => ({
  shoulder: new THREE.Vector3(),
  upperArm: new THREE.Vector3(),
  lowerArm: new THREE.Vector3(),
  hand: new THREE.Vector3(),
});

const mkState = (rest: Record<ArmSlot, THREE.Vector3>): Record<ArmSlot, DirFollower> => ({
  shoulder: new DirFollower(rest.shoulder),
  upperArm: new DirFollower(rest.upperArm),
  lowerArm: new DirFollower(rest.lowerArm),
  hand: new DirFollower(rest.hand),
});

/** The standing pose with any per-avatar resting directions applied. */
const restPose = (
  override: Partial<Record<ArmSlot, Vec3Tuple>> | undefined,
): Record<ArmSlot, THREE.Vector3> => {
  const pose = {} as Record<ArmSlot, THREE.Vector3>;
  for (const slot of ARM_SLOTS) {
    const dir = override?.[slot];
    pose[slot] = dir ? new THREE.Vector3(...dir).normalize() : BASE_POSE[slot].clone();
  }
  return pose;
};

const mkFingerState = (): Record<FingerName, ScalarFollower> => ({
  thumb: new ScalarFollower(BASE_FINGERS.thumb),
  index: new ScalarFollower(BASE_FINGERS.index),
  middle: new ScalarFollower(BASE_FINGERS.middle),
  ring: new ScalarFollower(BASE_FINGERS.ring),
  little: new ScalarFollower(BASE_FINGERS.little),
});

/** One finger of a clasp hand, opened `k` of the way toward flat; the follower's thumb starts flat. */
const claspCurl = (follower: boolean, f: FingerName, pv: number, k: number): number => {
  const from = follower && f === 'thumb' ? OPEN_HAND.thumb : pv;
  return from + (OPEN_HAND[f] - from) * k;
};

const mkFingerSpread = (): Record<FingerName, number> => ({
  thumb: 0,
  index: 0,
  middle: 0,
  ring: 0,
  little: 0,
});

const mkFingerSpreadState = (): Record<FingerName, ScalarFollower> => ({
  thumb: new ScalarFollower(0),
  index: new ScalarFollower(0),
  middle: new ScalarFollower(0),
  ring: new ScalarFollower(0),
  little: new ScalarFollower(0),
});

const mkEnv = (): Envelope => ({ entrance: 0, exit: 1 });

/**
 * What the current gesture is worth for one channel this frame.
 *
 * Per channel rather than one number for the whole gesture, because the
 * links of a limb do not start together — `this.blend` is what the same
 * expression gives for a channel with no onset delay of its own.
 */
const plain = (e: Envelope): number => e.entrance * e.exit;

const mkArmEnv = (): Record<ArmSlot, Envelope> => ({
  shoulder: mkEnv(),
  upperArm: mkEnv(),
  lowerArm: mkEnv(),
  hand: mkEnv(),
});

export interface BodyOptions {
  random?: () => number;
}

export class Body {
  private readonly _random: () => number;
  rig: Rig;
  p: Profile;
  t: number;

  breathPeriod: number;
  breathDepth: number;
  idleAmount: number;
  weightShift: number;
  gazeAmount: number;
  lookAt: number;

  speaking: boolean;
  speechEnergy: number;
  /** Phrase-final nod this frame, rad, positive down. */
  speechNod: number;
  /** Seconds of the current line still to play. */
  speechRemaining: number;
  /** The line starts a run of speech rather than continuing one. */
  speechOpens: boolean;
  /** Nothing is queued behind the line, so the run ends with it. */
  speechCloses: boolean;

  gesture: ActiveGesture | null;
  blend: number;

  hipsRest: THREE.Vector3;
  /** Parent-local metre vectors for floor sway and world-up lift. */
  hipsRight: THREE.Vector3;
  hipsUp: THREE.Vector3;

  /** The parent whose live linear transform turns metre vectors into local translations. */
  private readonly _hipsParent: THREE.Object3D | null;
  /** Rest anatomical right, held in the hips parent frame so root turns do not feed back through the live chest. */
  private readonly _hipsRestRight = new THREE.Vector3();
  private _hipsHasAnatomicalRight = false;
  private readonly _hipsParentLinear = new THREE.Matrix3();
  private readonly _hipsParentInverse = new THREE.Matrix3();
  private readonly _hipsFrameLinear = new THREE.Matrix3();
  private readonly _hipsRightWorld = new THREE.Vector3();
  private readonly _hipsUpWorld = new THREE.Vector3();
  private readonly _hipsRestRightWorld = new THREE.Vector3();
  private readonly _hipsRestHipsXWorld = new THREE.Vector3();
  private readonly _hipsRestHipsQ = new THREE.Quaternion();

  jumpHeight: number;
  gravity: number;

  saccade: number;

  private _jump: JumpArc | null;
  private _jumpT: number;
  /** A run asked for while one was in flight; it starts when that one lands. */
  private _hopQueued: HopSpec | null;
  private _rise: number;
  private _load: number;
  /** Whether the current gesture's exit has begun, and how far through it is. */
  private _exiting = false;
  private _exitU = 0;

  private _gaze: Gaze;
  /** The tracking share actually applied; chases `lookAt`. */
  private readonly _look = new ScalarFollower(1);
  private readonly _gazeFrame = makeGazeFrame();

  private _armDirs: Record<Side, Record<ArmSlot, Vec3Tuple>>;
  private _armWorld: Record<Side, Record<ArmSlot, Vec3Tuple>>;
  private _armVec: Record<Side, Record<ArmSlot, THREE.Vector3>>;
  private _armWorldVec: Record<Side, Record<ArmSlot, THREE.Vector3>>;
  private readonly _palmWorldVector: Record<Side, THREE.Vector3> = {
    L: new THREE.Vector3(),
    R: new THREE.Vector3(),
  };
  private readonly _transactionCurls: Record<Side, Record<FingerName, number>>;
  private readonly _transactionSpread: Record<Side, Record<FingerName, number>>;
  private readonly _bridgeCurls: Record<Side, Record<FingerName, number>>;
  private readonly _bridgeSpread: Record<Side, Record<FingerName, number>>;
  private readonly _bridgeSamples: ArmBridgeSample[];
  private readonly _bridgeKnots: ArmBridgeSample[];
  private readonly _bridgeFrontier: ArmBridgeInterval[];
  private _bridgePendingCount = 0;
  private _bridgeSampleCount = 0;
  private _bridgeAlpha = 1;
  private _bridgeResolution = Number.POSITIVE_INFINITY;
  private readonly _bridgeRel = new THREE.Vector3();
  private readonly _armFrameWork: ArmFrameWork = {
    contextRetries: 0,
    armStepRetries: 0,
    bridgeSamples: 0,
    solverCalls: 0,
    solverIterations: 0,
    environmentBatches: 0,
  };
  private readonly _acceptedTuple: Record<
    Side,
    Record<'upperArm' | 'lowerArm' | 'hand', Vec3Tuple>
  > = {
    L: { upperArm: [0, 0, 0], lowerArm: [0, 0, 0], hand: [0, 0, 0] },
    R: { upperArm: [0, 0, 0], lowerArm: [0, 0, 0], hand: [0, 0, 0] },
  };
  private readonly _frameCommit: Record<Side, ArmFrameSideCommit | null> = { L: null, R: null };
  private readonly _fullArmQ: Record<Side, Float64Array> = {
    L: new Float64Array(7),
    R: new Float64Array(7),
  };
  private readonly _betaArmQ: Record<Side, Float64Array> = {
    L: new Float64Array(7),
    R: new Float64Array(7),
  };
  private _bridgeFailure: 'speed' | 'geometry' | 'budget' = 'geometry';
  /** `_armVec` before breathing and drift, which is what a child link is carried by. */
  private _armBlend: Record<Side, Record<ArmSlot, THREE.Vector3>>;
  private readonly _carryDir = new THREE.Vector3();
  private readonly _carryQ = new THREE.Quaternion();
  private _armState: Record<Side, Record<ArmSlot, DirFollower>>;
  private _fingerSpec: Record<Side, Record<FingerName, number>>;
  private _fingerState: Record<Side, Record<FingerName, ScalarFollower>>;
  private _fingerSpreadSpec: Record<Side, Record<FingerName, number>>;
  private _fingerSpreadState: Record<Side, Record<FingerName, ScalarFollower>>;
  /** Drift and lag on top of the authored hand. See `finger-life.ts`. */
  private readonly _fingerLife: FingerLife;
  /** Clasp finger spread per side and role; null where the rig cannot be measured. */
  private readonly _claspSpread: Record<
    Side,
    { lead: FingerSpec | null; follow: FingerSpec | null }
  >;
  private _twist: Record<Side, ScalarFollower>;

  /**
   * The current gesture's envelope, split per arm link by its onset delay, and
   * the plain one everything else reads. Recomputed each frame; held on the
   * instance only so the arm loop and the reach resolver see the same numbers.
   */
  private _env: Envelope;
  private _armEnv: Record<ArmSlot, Envelope>;
  private _fingerEnv: Envelope;

  private _palm: Record<Side, DirFollower>;
  private _palmTarget: THREE.Vector3;
  private _palmOut: Record<Side, Vec3Tuple>;
  private _palmWorldOut: Record<Side, Vec3Tuple>;
  private _palmW: Record<Side, ScalarFollower>;

  /** Gestures on their way out, oldest first. Only `handoff` adds to it. */
  private readonly _fading: Outgoing[] = [];
  // Spine offsets have no follower. Fade them against the incoming entrance,
  // independently of the arm/finger lifetime and its exponential decay.
  private readonly _spineFading: Outgoing[] = [];
  /** The incoming entrance's clock, which outgoing spine and arm weights fade against. */
  private _fadeTime = 0;
  private _fadeDuration = 0;
  /** What each arm link's outgoing weights keep of their start this frame. */
  private readonly _fadeRemaining = mkSlotWeights();
  /** Spent outgoing slots, kept so a gesture switch does not allocate. */
  private readonly _spare: Outgoing[] = [];
  /** The current gesture's solver output and elbow state. */
  private _curReach = mkReachScratch();
  /** Solver output for `travel`'s probe, so a probe moves no live slot's elbow. */
  private readonly _probeReach = mkReachScratch();

  /** Where each arm link rests; the standing pose unless the avatar overrides it. */
  private readonly _rest: Record<ArmSlot, THREE.Vector3>;
  /** The character-space to world boundary. See `frame.ts`. */
  private readonly axes: CharacterFrame;
  /** Where a reach is going, in world space. See `anchors.ts`. */
  private readonly anchors: ReachAnchors;
  /** Breathing, weight, drift — what a standing body does. See `posture.ts`. */
  private readonly _posture = new IdlePosture();
  /** The posture's per-frame input and the arms' idle terms, refilled rather than rebuilt. */
  private readonly _postureIn: PostureInput;
  /** The gaze's per-frame view of the line, refilled rather than rebuilt. */
  private readonly _speech: SpeechGaze = {
    speaking: false,
    remaining: 0,
    opens: true,
    closes: true,
  };
  private readonly _idleEnv: IdleEnv = { br: 0, d: 0, armDrift: 0, dt: 0 };
  /** What one arm of a pose actually asks for. See `resolve.ts`. */
  private readonly _arm: ArmResolver;
  private _lastExternalArmRevision = 0;

  /** Joint strain from the last fingertip solve, per arm. */
  get pointStrain(): Record<Side, number> {
    return this._arm.pointStrain;
  }

  constructor(rig: Rig, profile: Profile, { random = Math.random }: BodyOptions = {}) {
    this._random = random;
    this.rig = rig;
    this.p = profile;
    this._rest = restPose(profile.avatar.armRest);
    this.axes = new CharacterFrame(rig, profile);
    this.anchors = new ReachAnchors(profile, rig, this.axes);
    this._arm = new ArmResolver(profile, rig, this.axes, this.anchors);
    this.t = 0;

    this.breathPeriod = 4.2;
    this.breathDepth = 1;
    this.idleAmount = 1; // head micro-motion, posture drift, arm drift
    this.weightShift = 1; // slow lateral shift of the standing weight
    this.gazeAmount = 1; // saccades layered on top of camera tracking
    this.lookAt = 1; // 0 = straight ahead, 1 = track the camera; a target, see `_look`

    // Set per frame by the director from the mouth layer.
    this.speaking = false;
    this.speechEnergy = 0;
    this.speechNod = 0;
    this.speechRemaining = 0;
    this.speechOpens = true;
    this.speechCloses = true;

    // The current gesture, and `_fading` for whatever is on its way out, so a
    // switch crossfades instead of cutting.
    this.gesture = null;
    this.blend = 0;

    const hips = profile.bones.hips;
    this.hipsRest = hips ? hips.position.clone() : new THREE.Vector3();
    this.hipsRight = new THREE.Vector3(1, 0, 0);
    this.hipsUp = new THREE.Vector3(0, 1, 0);
    this._hipsParent = hips?.parent ?? null;

    /**
     * Parent-local vectors for metre-sized hips translations.
     *
     * The weight shift below is the one place in the runtime that writes a bone
     * *translation* rather than a rotation, and a translation is in the parent's
     * units — which may be rotated or scaled differently on each axis. Rotations
     * are radians and are the same number on any rig, which is why nothing else
     * has needed this — and why the omission was invisible. The sway follows the
     * anatomical right projected onto the floor and the lift follows world up,
     * the gravity the hop uses; each world metre goes through the inverse parent
     * transform unnormalised, so it lands as a metre.
     *
     * One of these avatars is authored in centimetres under a 0.01 scale at the
     * armature (the same fact `profile/bones.ts` records for the arm lengths),
     * so a figure written as 12 mm landed as 0.12 mm and the hips did not move
     * at all. The other is authored in metres and behaved as written, which is
     * exactly the shape of bug that survives being looked at on one avatar.
     */
    // Capture the rest frame once, then use the same metric refresh every frame.
    // The parent may be turned or scaled by the host after Body construction.
    this.refreshHipsFrame(true);

    // --- jump ---------------------------------------------------------------
    // Metres the hips rise at the apex, and the gravity the arc is solved under.
    // Real gravity gives a real arc; lowering it keeps the same height and makes
    // the character hang at the top, which is a look and not an error.
    this.jumpHeight = 0.08;
    this.gravity = 9.81;
    this._jump = null;
    this._jumpT = 0;
    this._hopQueued = null;
    this._rise = 0; // hips above rest this frame, metres
    this._load = 0; // 0..1, how far into the dip the body is

    // Gaze wanders and snaps back rather than staring; `saccade` carries the
    // amplitude on the frame a new fixation starts so the director can blink
    // with it.
    this._gaze = new Gaze({ random: this._random });
    this.saccade = 0;

    // Pre-allocated per side and slot. This runs every frame for hours at a
    // time, and steady garbage shows up as dropped frames long before it shows
    // up as memory.
    this._armDirs = { L: mkDirs(), R: mkDirs() };
    this._armWorld = { L: mkDirs(), R: mkDirs() };
    this._armVec = { L: mkVecs(), R: mkVecs() }; // composed target for this frame
    this._armWorldVec = { L: mkVecs(), R: mkVecs() };
    this._transactionCurls = { L: mkFingerSpread(), R: mkFingerSpread() };
    this._transactionSpread = { L: mkFingerSpread(), R: mkFingerSpread() };
    this._bridgeCurls = { L: mkFingerSpread(), R: mkFingerSpread() };
    this._bridgeSpread = { L: mkFingerSpread(), R: mkFingerSpread() };
    const bridgePointCounts = {
      L: rig.armDriver('L')?.output.points.length ?? 0,
      R: rig.armDriver('R')?.output.points.length ?? 0,
    };
    this._bridgeSamples = Array.from({ length: ARM_BRIDGE_MAX_SAMPLES }, () =>
      makeArmBridgeSample(bridgePointCounts),
    );
    this._bridgeKnots = Array.from(
      { length: ARM_BRIDGE_STARTS.length },
      () => this._bridgeSamples[0],
    );
    this._bridgeFrontier = Array.from({ length: ARM_BRIDGE_MAX_SAMPLES }, () => ({
      from: this._bridgeSamples[0],
      to: this._bridgeSamples[0],
      depth: 0,
      travel: 0,
    }));
    this._armBlend = { L: mkVecs(), R: mkVecs() };
    this._armState = { L: mkState(this._rest), R: mkState(this._rest) }; // what the arm is actually doing
    this._fingerSpec = { L: { ...BASE_FINGERS }, R: { ...BASE_FINGERS } };
    this._fingerState = {
      L: mkFingerState(),
      R: mkFingerState(),
    };
    this._fingerSpreadSpec = { L: mkFingerSpread(), R: mkFingerSpread() };
    this._fingerSpreadState = { L: mkFingerSpreadState(), R: mkFingerSpreadState() };
    const spreadFor = (side: Side, role: 'lead' | 'follow') => {
      const m = claspMeasure(profile.limb, side);
      return m ? claspSpread(m, role, mkFingerSpread()) : null;
    };
    this._claspSpread = {
      L: { lead: spreadFor('L', 'lead'), follow: spreadFor('L', 'follow') },
      R: { lead: spreadFor('R', 'lead'), follow: spreadFor('R', 'follow') },
    };
    this._twist = { L: new ScalarFollower(0), R: new ScalarFollower(0) };

    this._env = mkEnv();
    this._armEnv = mkArmEnv();
    this._fingerEnv = mkEnv();

    this._palm = { L: new DirFollower(BASE_PALM), R: new DirFollower(BASE_PALM) };
    this._palmTarget = new THREE.Vector3();
    this._palmOut = { L: [0, 0, 0], R: [0, 0, 0] };
    this._palmWorldOut = { L: [0, 0, 0], R: [0, 0, 0] };
    // How strongly the palm target is honoured. A weight on a constraint rather
    // than something with a trajectory, so it is clamped where it is read: a
    // filter with momentum can undershoot past zero, and a negative weight
    // does not mean "less constrained", it means the palm faces backwards.
    this._palmW = { L: new ScalarFollower(1), R: new ScalarFollower(1) };

    this._postureIn = {
      t: 0,
      speaking: false,
      speechEnergy: 0,
      nod: 0,
      breathPeriod: this.breathPeriod,
      breathDepth: this.breathDepth,
      weightShift: this.weightShift,
      idleAmount: this.idleAmount,
      hipsRest: this.hipsRest,
      hipsRight: this.hipsRight,
      hipsUp: this.hipsUp,
      jumpHeight: this.jumpHeight,
      rise: 0,
      load: 0,
    };

    this.bootstrapStandingPose();
    this.seedArmFollowersFromRig();
    this._lastExternalArmRevision = rig.externalArmRevision;
    // Finger life must see the bootstrapped hand on its first sensor read.
    this._fingerLife = new FingerLife(profile, rig.palmLocal);
  }

  /**
   * Recompute the parent-local metre vectors from the current parent transform.
   *
   * The anatomical right is captured once in the hips parent's rest frame. It
   * is deliberately not read from the live chest here: the chest is also
   * driven by posture, and feeding that pose back into the translation axis
   * makes a breath slowly rotate the direction it is trying to express. The
   * floor projection is applied only after the rest vector has been carried
   * through the current parent, so a root turn or non-uniform scale changes the
   * metric without changing the authored sign.
   */
  private refreshHipsFrame(captureRest = false): void {
    const hips = this.p.bones.hips;
    const parent = this._hipsParent;
    if (!(hips && parent)) return;

    // The host may transform an outer wrapper without walking its own scene
    // graph. Update the parent chain first; updating the root alone would
    // otherwise reuse that wrapper's previous matrix for this frame. The full
    // walk is only for the rest capture, which reads the chest's world matrix.
    parent.updateWorldMatrix(true, false);
    if (captureRest) this.p.root.updateMatrixWorld(true);
    const parentLinear = this._hipsParentLinear.setFromMatrix4(parent.matrixWorld);
    const determinant = parentLinear.determinant();
    if (
      !Number.isFinite(determinant) ||
      determinant === 0 ||
      !parentLinear.elements.every(Number.isFinite)
    ) {
      // A singular host transform has no meaningful inverse metric. Keep the
      // last finite vectors rather than allowing one bad frame to poison the
      // posture state with NaNs.
      return;
    }
    const parentInverse = this._hipsParentInverse.copy(parentLinear).invert();
    if (!parentInverse.elements.every(Number.isFinite)) return;

    if (captureRest) {
      this._hipsHasAnatomicalRight = false;
      const frameBone = this.p.bones.chest ?? this.p.bones.spine ?? hips;
      const frame = this.p.body;
      if (frame && frameBone) {
        const restRightWorld = this._hipsRestRightWorld
          .copy(frame.right)
          .applyMatrix3(this._hipsFrameLinear.setFromMatrix4(frameBone.matrixWorld));
        const restRightLengthSq = restRightWorld.lengthSq();
        if (Number.isFinite(restRightLengthSq) && restRightLengthSq > 1e-12) {
          restRightWorld.normalize();
          // Exporters disagree on whether right is +X; the rest hips axis keeps
          // the tuned sway sign. This gauge is intentionally captured once.
          const hipsXWorld = this._hipsRestHipsXWorld
            .set(1, 0, 0)
            .applyQuaternion(hips.getWorldQuaternion(this._hipsRestHipsQ));
          const hipsXLengthSq = hipsXWorld.lengthSq();
          const floorRight = this._hipsRightWorld.copy(restRightWorld);
          floorRight.y = 0;
          const floorHipsX = this._hipsUpWorld.copy(hipsXWorld);
          floorHipsX.y = 0;
          const floorRightLengthSq = floorRight.lengthSq();
          const floorHipsXLengthSq = floorHipsX.lengthSq();
          if (
            Number.isFinite(hipsXLengthSq) &&
            hipsXLengthSq > 1e-12 &&
            Number.isFinite(floorRightLengthSq) &&
            floorRightLengthSq > 1e-12 &&
            Number.isFinite(floorHipsXLengthSq) &&
            floorHipsXLengthSq > 1e-12
          ) {
            floorRight.normalize();
            floorHipsX.normalize();
            if (floorRight.dot(floorHipsX) < 0) restRightWorld.negate();
          }

          this._hipsRestRight.copy(restRightWorld).applyMatrix3(parentInverse);
          const restParentLengthSq = this._hipsRestRight.lengthSq();
          this._hipsHasAnatomicalRight =
            Number.isFinite(restParentLengthSq) && restParentLengthSq > 1e-12;
        }
      }
    }

    this._hipsUpWorld.set(0, 1, 0);
    const up = this._hipsUpWorld.applyMatrix3(parentInverse);
    const upLengthSq = up.lengthSq();
    if (Number.isFinite(upLengthSq) && upLengthSq > 1e-12) this.hipsUp.copy(up);

    let rightValid = false;
    if (this._hipsHasAnatomicalRight) {
      const rightWorld = this._hipsRightWorld.copy(this._hipsRestRight).applyMatrix3(parentLinear);
      const rightLengthSq = rightWorld.lengthSq();
      if (Number.isFinite(rightLengthSq) && rightLengthSq > 1e-12) {
        rightWorld.y = 0;
        const floorLengthSq = rightWorld.lengthSq();
        if (Number.isFinite(floorLengthSq) && floorLengthSq > 1e-12) {
          rightWorld.normalize();
          // Not normalised: a non-uniform scale needs the per-axis length for a metre.
          const right = rightWorld.applyMatrix3(parentInverse);
          const localLengthSq = right.lengthSq();
          if (Number.isFinite(localLengthSq) && localLengthSq > 1e-12) {
            this.hipsRight.copy(right);
            rightValid = true;
          }
        }
      }
    }

    if (!rightValid) {
      // No body frame (or a frame whose right has become vertical): preserve
      // the old parent-local-X fallback, refreshed for the current metric.
      const xWorld = this._hipsRightWorld.set(1, 0, 0).applyMatrix3(parentLinear);
      const xLengthSq = xWorld.lengthSq();
      if (Number.isFinite(xLengthSq) && xLengthSq > 1e-12) {
        const xLength = Math.sqrt(xLengthSq);
        if (Number.isFinite(xLength)) this.hipsRight.set(1 / xLength, 0, 0);
      }
    }
  }

  /**
   * Blend one arm slot's target direction for this frame, in character space.
   *
   * `cDir` is the incoming gesture's direction for this slot and may be absent;
   * `cw` is what it is worth this frame — per slot rather than per gesture,
   * because the links of a limb do not start together. The outgoing gestures
   * come in at their own weights unless `outgoing` is false.
   */
  private composeArmTarget(
    slot: ArmSlot,
    side: Side,
    env: IdleEnv,
    cDir: THREE.Vector3 | undefined,
    cw: number,
    outgoing: boolean,
    cParent?: THREE.Vector3,
  ): THREE.Vector3 {
    // A forearm or hand is blended as it hangs from its parent, not as a
    // direction of its own. Two poses' forearms lerped in character space while
    // their upper arms lerp too turn the elbow's bend plane about the humerus,
    // and a folded elbow hands most of that turn to the palm: leaving the cheek
    // for a wave asked the forearm for ninety degrees of roll a frame.
    const parent = ARM_PARENT[slot];
    const to = parent ? this._armBlend[side][parent] : null;
    const carry = (dir: THREE.Vector3, from: THREE.Vector3 | undefined): THREE.Vector3 => {
      const d = this._carryDir.copy(dir);
      if (to && from) d.applyQuaternion(this._carryQ.setFromUnitVectors(from, to));
      return d;
    };
    const parentOf = (arm: ResolvedArm | null | undefined) => (parent ? arm?.[parent] : undefined);
    const v = this._armVec[side][slot].copy(
      carry(this._rest[slot], parent ? this._rest[parent] : undefined),
    );
    // Outgoing first, then incoming: the incoming gesture takes over as its
    // blend rises, and the two never both sit at full weight.
    if (outgoing && !cDir) {
      // Nothing to complement: the link goes home on the outgoing decay, which
      // the incoming lead was never sized to cover.
      for (const f of this._fading) {
        const pDir = this.outgoingDir(f, side, slot);
        if (pDir) v.lerp(carry(pDir, parentOf(f.arm[side])), f.w).normalize();
      }
    } else if (outgoing) {
      // Each lerp takes a slot's share of what the chain holds so far, so every
      // outgoing slot lands at its own `armW` and rest keeps only what is left.
      let pool = 1 - cw;
      for (const f of this._fading) if (this.outgoingDir(f, side, slot)) pool -= f.armW[slot];
      pool = Math.max(0, pool);
      for (const f of this._fading) {
        const pDir = this.outgoingDir(f, side, slot);
        const share = f.armW[slot];
        if (!pDir || share <= 0) continue;
        pool += share;
        v.lerp(carry(pDir, parentOf(f.arm[side])), share / pool).normalize();
      }
    }
    if (cDir) v.lerp(carry(cDir, cParent), cw).normalize();
    this._armBlend[side][slot].copy(v);

    // Breathing and idle drift are added *after* the gesture blend, not before
    // it. Folding them into the base pose means a gesture at full strength
    // lerps them away and the arms go dead mid-motion — a hand held in a pose
    // is still attached to someone who is breathing.
    v.y += (slot === 'shoulder' ? 0.022 : 0.014) * env.d * env.br;

    const ph = side === 'L' ? 0 : 1.9;
    const w = env.armDrift * DRIFT_WEIGHT[slot];
    v.y += w * Math.sin(this.t * 0.27 + ph);
    v.z += w * 0.8 * Math.sin(this.t * 0.19 + ph + 0.6);
    v.x += w * 0.5 * Math.sin(this.t * 0.23 + ph + 1.3);
    return v.normalize();
  }

  /** What an outgoing slot states for one arm link: the authored shoulder, or the resolved link. */
  private outgoingDir(f: Outgoing, side: Side, slot: ArmSlot): THREE.Vector3 | undefined {
    return slot === 'shoulder'
      ? f.pose?.arms?.[side]?.shoulder
      : (f.arm[side]?.[slot] ?? undefined);
  }

  /** Follow one arm slot's target and write the result into `_armDirs`. */
  private followArm(
    slot: ArmSlot,
    side: Side,
    v: THREE.Vector3,
    dt: number,
    rate: number,
  ): Vec3Tuple {
    // Follow the target instead of snapping to it. See ARM_FOLLOW.
    const s = this._armState[side][slot].step(v, dt, rate);
    const out = this._armDirs[side][slot];
    // Keep the follower output in character space. It is projected into world
    // space only at the Rig boundary, after the spine has been committed.
    out[0] = s.x;
    out[1] = s.y;
    out[2] = s.z;
    return out;
  }

  /**
   * Aim a fingertip, and hold it there.
   *
   * Built as a gesture rather than as a separate channel. A pointing arm has to
   * crossfade with a wave, take a lead time proportional to how far it travels,
   * hold until released and give way to the next gesture — all of which the
   * gesture slot already does, and none of which is worth a second
   * implementation that would drift out of step with the first.
   *
   *   side       "L" | "R"
   *   azimuth    degrees, 0 straight ahead, positive to the character's right
   *   elevation  degrees, 0 at shoulder height, positive up
   *   extent     0..1 of full reach
   *   finger     which fingertip the coordinate refers to
   *
   * The angles arrive in degrees because that is what the control API and `ctl`
   * state them in, and are converted here: the `PointSpec` everything below
   * this line reads is radians.
   *
   * The torso helps, as it does in life: past about 40 degrees off the midline
   * an arm alone cannot get there comfortably and the chest turns into it. That
   * is stated here rather than in the solver because it has to reach the spine
   * before the frame's spine offsets are committed, and the arms are solved
   * after that.
   */
  point(side: Side, spec: PointCommand = {}): void {
    const D = Math.PI / 180;
    const az = (spec.azimuth ?? 0) * D;
    const el = (spec.elevation ?? 0) * D;
    const extent = THREE.MathUtils.clamp(spec.extent ?? 0.8, 0.1, 1);
    const finger = spec.finger ?? 'index';
    const at: PointSpec = {
      azimuth: az,
      elevation: el,
      extent,
      mirror: false,
      finger,
      point: spec.point ?? null,
      palm: spec.palm ?? null,
    };
    // Shaped for the finger that was asked for, not for the index. The solver
    // reads the fingertip's position off this curl, so a hand shaped to point
    // with the wrong finger aims one that is folded into the palm — and the
    // whole arm then travels to put that knuckle where the target is. Built
    // once here rather than inside `build`, which runs every frame.
    const hand = pointHand(finger);
    // Scaled by extent: turning the chest toward something the hand is not
    // actually reaching for reads as the whole character swivelling.
    const turn = az * 0.22 * extent;
    const lean = -Math.max(0, el) * 0.1 * extent;
    const def: GestureDef = {
      label: { en: 'Pointing', ja: '指し示す' },
      group: 'explain',
      lead: 0.3,
      hold: 1.6,
      sustain: true,
      build: () => ({
        point: { [side]: at },
        fingers: { [side]: hand },
        spine: {
          chest: [lean * 0.6, turn * 0.6, 0],
          spine: [lean * 0.4, turn * 0.4, 0],
        },
      }),
    };
    this.playDef(def, `point.${side}`);
  }

  play(id: string, side?: Side): void {
    const def = gestureDef(id);
    if (!def) return;
    this.playDef(def, id, side);
  }

  /**
   * Start a gesture from a definition object, named or synthesised.
   *
   * `side` pins the mirror axis the variation would otherwise pick at random —
   * which hand a one-handed gesture acts with, and which way the head turns on
   * the rest. A loaded motion states its own hands and ignores it; see
   * `compileMotion`.
   */
  playDef(def: GestureDef, id: string, side?: Side): void {
    if (!def) return;
    this.syncExternalArmRevision();
    // Hand the outgoing gesture on so it fades out while the new one fades in.
    // Dropping it outright leaves the standing blend weight pointing at a
    // completely different pose, and the arms teleport on the switch frame —
    // the most visible artefact this layer had.
    this.handoff();
    const v: GestureVariation = {
      // Frequency and amplitude, never phase: `build` is called from t=0 and a
      // phase offset would put every oscillation mid-swing on frame one, which
      // snaps the limb into the gesture instead of easing it in.
      rate: 0.92 + this._random() * 0.16,
      scale: 0.9 + this._random() * 0.2,
      // Random unless the caller named a hand. Left random on purpose when it
      // did not: a character that greets with the same arm every single time
      // reads as a mechanism, and the table was authored so that either hand
      // works. What a caller pins is a hand it has a reason for — the one away
      // from the slide, the one it used on the line before.
      side: side === undefined ? (this._random() < 0.5 ? -1 : 1) : sideMirror(side),
    };
    // The distance-derived extension is capped: past about a second an
    // entrance stops reading as deliberate and starts reading as slow,
    // however far the arm has to go. The authored lead remains a floor — doze
    // deliberately takes 1.5 seconds so its entrance reads as falling asleep.
    const lead = Math.max(def.lead, Math.min(0.95, this.travel(def, v) * LEAD_PER_RAD));
    for (const f of this._spineFading) f.spineStart = f.spineWeight;
    for (const f of this._fading) for (const slot of ARM_SLOTS) f.armStart[slot] = f.armW[slot];
    while (this._fading.length > MAX_FADING) this.foldFading();
    this._fadeTime = 0;
    this._fadeDuration = lead;
    this.gesture = {
      def,
      id,
      v,
      time: 0,
      released: false,
      speed: 0.93 + this._random() * 0.14,
      lead,
      phase: { entrance: 0, held: 0 },
      exitAt: lead + def.hold,
      releasedIn: 1,
    };
    this._env.entrance = 0;
    this._env.exit = 1;
    for (const slot of ARM_SLOTS) {
      this._armEnv[slot].entrance = 0;
      this._armEnv[slot].exit = 1;
    }
    this._fingerEnv.entrance = 0;
    this._fingerEnv.exit = 1;
    this._arm.mark();
    this._arm.freezeClasp(false);
    this._exiting = false;
  }

  /** Largest angle any arm has to cover to reach the gesture's opening pose. */
  private travel(def: GestureDef, v: GestureVariation): number {
    const pose = def.build(0, v, PROBE_PHASE);
    let worst = 0;
    for (const side of SIDES) {
      const mirror = sideMirror(side);
      this._probeReach[side].swivelDir.set(0, 0, 0);
      const arm = this._arm.resolve(pose, side, mirror, this._probeReach, 1);
      if (!arm) continue;
      for (const slot of ARM_SLOTS) {
        const dir = arm[slot];
        if (!dir) continue;
        worst = Math.max(worst, this._armState[side][slot].dir.angleTo(dir));
      }
    }
    return worst;
  }

  /** Add one gesture slot's girdle turn for `side`, if it is a reach that states no shoulder. */
  private girdleShare(
    pose: Pose | null,
    side: Side,
    weight: number,
    dir: Vec3Tuple,
    turn: THREE.Vector3,
    frameReady: boolean,
  ): void {
    const gr = pose?.reach?.[side];
    if (!gr || pose?.arms?.[side]?.shoulder || weight <= 0) return;
    const gt = this.anchors.target(gr, side, frameReady);
    if (gt) this.rig.girdleRoom(side, gt, dir, weight, turn);
  }

  /** Release the current gesture, including a sustained pose. */
  stopGesture(): void {
    const g = this.gesture;
    if (!g || g.released) return;
    // A pose let go leaves from where it is, at the weight it has: the exit
    // starts now, and the entrance stops where it got to rather than finishing.
    const held = g.def.sustain === true;
    g.exitAt = held ? g.time : Math.min(g.exitAt, g.time);
    g.releasedIn = g.lead > 0 ? Math.min(1, g.time / g.lead) : 1;
    g.released = true;
  }

  /**
   * Move the current gesture into the outgoing slots at the weight it has now.
   *
   * The one place a gesture leaves the current slot early. It keeps its pose
   * time and its solver state, and from here its weight only decays, so a
   * switch can neither drop it nor raise it — however many arrive within one
   * fade, up to `MAX_FADING`.
   */
  private handoff(): void {
    const g = this.gesture;
    if (g && this.blend > 0) {
      const out = this._spare.pop() ?? mkOutgoing(g);
      const reach = out.reach;
      out.g = g;
      out.w = this.blend;
      out.spineWeight = this.blend;
      out.spineStart = this.blend;
      // Each link at what it was worth on screen; an overshoot hands over at full weight.
      for (const slot of ARM_SLOTS) {
        out.armW[slot] = Math.min(1, plain(this._armEnv[slot]));
        out.armStart[slot] = out.armW[slot];
      }
      out.armAlive = true;
      out.spineAlive = true;
      out.reach = this._curReach;
      out.pose = null;
      this._curReach = reach;
      this._fading.push(out);
      this._spineFading.push(out);
    }
    // A new slot's elbow starts at its own answer; see `ElbowSearch.search`.
    this._curReach.L.swivelDir.set(0, 0, 0);
    this._curReach.R.swivelDir.set(0, 0, 0);
    this._curReach.L.clasp = false;
    this._curReach.R.clasp = false;
    this.gesture = null;
    this.blend = 0;
  }

  /**
   * Retire the outgoing arm slot worth least, short of the one just handed over,
   * whose hand the finger blend may still be holding.
   *
   * Not the oldest: under rapid firing the oldest is the pose still on screen
   * and each later slot holds only the sliver its entrance reached. The arm
   * blends are lerp chains, so taking a link out hands its share back, in
   * proportion, to everything blended before it — rest and the older slots.
   */
  private foldFading(): void {
    let victim = 0;
    let least = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this._fading.length - 1; i++) {
      const s = this._fading[i].armStart;
      const worth = s.shoulder + s.upperArm + s.lowerArm + s.hand;
      if (worth < least) {
        least = worth;
        victim = i;
      }
    }
    const v = this._fading[victim];
    for (const slot of ARM_SLOTS) {
      let before = 1;
      for (let j = victim + 1; j < this._fading.length; j++)
        before -= this._fading[j].armStart[slot];
      const left = before - v.armStart[slot];
      if (left <= 1e-9) continue;
      const k = before / left;
      for (let j = 0; j < victim; j++) {
        const f = this._fading[j];
        f.armStart[slot] *= k;
        f.armW[slot] = f.armStart[slot];
      }
    }
    this._fading.splice(victim, 1);
    v.armAlive = false;
    if (!v.spineAlive) {
      v.pose = null;
      this._spare.push(v);
    }
  }

  /**
   * Start a run of hops. The arc it runs is `planJump`'s, and a run of more
   * than one is continuous — see there for why it needs no gap between them.
   */
  hop({ height = this.jumpHeight, count = 1 }: Partial<HopSpec> = {}): void {
    // Restarting a run in flight would drop the hips to rest in one frame; the
    // new one waits for the landing, which ends standing and at rest.
    if (this._jump) {
      this._hopQueued = { height, count };
      return;
    }
    this._jump = planJump(height, this.gravity, count);
    this._jumpT = 0;
  }

  /** Finish the current hop, dropping any later cycles from a run and any run queued after it. */
  finishHop(): void {
    this._hopQueued = null;
    const jump = this._jump;
    if (!jump) return;
    const cycle = jump.push + jump.flight + jump.brake;
    const elapsed = Math.max(0, this._jumpT - CROUCH_T);
    const current = Math.min(jump.count, Math.floor(elapsed / cycle) + 1);
    jump.count = current;
  }

  /** Whether a hop is in flight. Read by the panel. */
  get jumping(): boolean {
    return this._jump !== null;
  }

  /**
   * Advance the hop, leaving the hips' rise and the body's compression in
   * `_rise` and `_load`. Both are zero on every frame that is not part of one.
   */
  private jumpStep(dt: number): void {
    this._rise = 0;
    this._load = 0;
    const j = this._jump;
    if (!j) return;

    this._jumpT += dt;
    const s = sampleJump(j, this._jumpT);
    if (s.done) {
      this._jump = null;
      const next = this._hopQueued;
      if (next) {
        this._hopQueued = null;
        this._jump = planJump(next.height, this.gravity, next.count);
        this._jumpT = 0;
      }
      return;
    }
    this._rise = s.rise;
    this._load = s.load;
  }

  /** Current gaze offset in radians, x = yaw, y = pitch. */
  get gaze(): THREE.Vector2 {
    return this._gaze.offset;
  }

  /** Breathing phase, 0..1, exposed so the UI can show it. */
  get breath(): number {
    return this._posture.breath;
  }

  private resetArmFrameWork(): void {
    this._armFrameWork.contextRetries = 0;
    this._armFrameWork.armStepRetries = 0;
    this._armFrameWork.bridgeSamples = 0;
    this._armFrameWork.solverCalls = 0;
    this._armFrameWork.solverIterations = 0;
    this._armFrameWork.environmentBatches = 0;
  }

  private bootstrapStandingPose(): void {
    const frameReady = this.axes.ready();
    const poseFor = (side: Side): StandingArmPose => {
      const world = (slot: ArmSlot) =>
        this.axes.toWorld(
          new THREE.Vector3(),
          this._rest[slot],
          side,
          sideMirror(side),
          frameReady,
        );
      return {
        shoulder: world('shoulder'),
        upperArm: world('upperArm'),
        lowerArm: world('lowerArm'),
        hand: world('hand'),
        palm: this.axes.toWorld(new THREE.Vector3(), BASE_PALM, side, sideMirror(side), frameReady),
        curls: { ...BASE_FINGERS },
        spread: mkFingerSpread(),
      };
    };
    this.rig.bootstrapStandingPose({ L: poseFor('L'), R: poseFor('R') });
  }

  /** Seed the followers once from the pose they will actually continue from. */
  private seedArmFollowersFromRig(): void {
    const frameReady = this.axes.ready();
    for (const side of SIDES) {
      const accepted = this.rig.armStateForBodyInitialization(side);
      const tuple = this._acceptedTuple[side];
      let stanceReady = true;
      for (const slot of ARM_SLOTS) {
        const source = accepted.directions[slot];
        const length = Math.hypot(source[0], source[1], source[2]);
        if (!(Number.isFinite(length) && length > 1e-12)) {
          if (slot !== 'shoulder') stanceReady = false;
          continue;
        }
        const state = this._armState[side][slot];
        state.reset(this._carryDir.set(source[0], source[1], source[2]));
        const target = this._armDirs[side][slot];
        target[0] = source[0] / length;
        target[1] = source[1] / length;
        target[2] = source[2] / length;
      }
      if (stanceReady) {
        for (const slot of ['upperArm', 'lowerArm', 'hand'] as const) {
          const target = tuple[slot];
          const source = this._armDirs[side][slot];
          target[0] = source[0];
          target[1] = source[1];
          target[2] = source[2];
        }
        this._arm.note(side, tuple.upperArm, tuple.lowerArm, tuple.hand);
      }
      const palm = accepted.palm;
      const palmLength = Math.hypot(palm[0], palm[1], palm[2]);
      if (Number.isFinite(palmLength) && palmLength > 1e-12) {
        this._palm[side].reset(this._carryDir.set(palm[0], palm[1], palm[2]));
        this._palmOut[side][0] = palm[0] / palmLength;
        this._palmOut[side][1] = palm[1] / palmLength;
        this._palmOut[side][2] = palm[2] / palmLength;
      }
      if (Number.isFinite(accepted.forearmRoll)) {
        this._twist[side].reset(accepted.forearmRoll / this.axes.axialMirror(side, frameReady));
      }
      for (const finger of FINGER_NAMES) {
        const curl = accepted.curls[finger];
        if (Number.isFinite(curl)) {
          this._fingerSpec[side][finger] = curl;
          this._fingerState[side][finger].reset(curl);
        }
        const spread = accepted.spread[finger];
        if (Number.isFinite(spread)) {
          this._fingerSpreadSpec[side][finger] = spread;
          this._fingerSpreadState[side][finger].reset(spread);
        }
      }
    }
  }

  private syncExternalArmRevision(): void {
    const revision = this.rig.externalArmRevision;
    if (revision === this._lastExternalArmRevision) return;
    this.seedArmFollowersFromRig();
    this._lastExternalArmRevision = revision;
  }

  private armFrameBudgetSpent(): boolean {
    return this._armFrameWork.bridgeSamples >= ARM_FRAME_BRIDGE_BUDGET;
  }

  /** Whether this attempt's or this frame's sample allowance is used up, recording which. */
  private armBridgeSamplesSpent(): boolean {
    if (this.armFrameBudgetSpent()) {
      this._bridgeFailure = 'budget';
      return true;
    }
    if (this._bridgeSampleCount < ARM_BRIDGE_MAX_SAMPLES) return false;
    this._bridgeFailure = 'geometry';
    return true;
  }

  private recordArmSolve(output: { iterations: number; environmentBatches: number }): void {
    this._armFrameWork.solverCalls++;
    this._armFrameWork.solverIterations += output.iterations;
    this._armFrameWork.environmentBatches += output.environmentBatches;
  }

  /** Advance one gesture slot and return its pose. */
  private advance(slot: ActiveGesture, dt: number): Pose {
    slot.time += dt;
    slot.phase.entrance = slot.lead <= 0 ? 1 : Math.min(1, Math.max(0, slot.time / slot.lead));
    slot.phase.held = Math.max(0, slot.time - slot.lead) * slot.speed;
    return slot.def.build(slot.time * slot.speed, slot.v, slot.phase);
  }

  private commitArmTransaction(dt: number): void {
    const rig = this.rig;
    rig.captureProposedBodyContext(this._rise);
    const rollComposed: Record<Side, boolean> = { L: false, R: false };
    let committed = false;
    for (let attempt = 0; attempt <= 6; attempt++) {
      if (this.armFrameBudgetSpent()) break;
      if (attempt > 0) this._armFrameWork.contextRetries++;
      const alpha = attempt === 0 ? 1 : attempt === 6 ? 0 : 2 ** -attempt;
      const candidateRise = rig.applyBodyContext(alpha, 1);
      this._bridgeAlpha = alpha;
      this._bridgeSampleCount = 0;
      const leftDriver = rig.armDriver('L');
      const rightDriver = rig.armDriver('R');
      if (!(leftDriver && rightDriver)) continue;
      this._bridgeResolution = Math.min(leftDriver.sweepResolution, rightDriver.sweepResolution);
      const frameReady = this.axes.ready();
      let feasible = true;
      for (const side of ['L', 'R'] as Side[]) {
        const driver = rig.armDriver(side);
        const context = rig.armForwardContextFromUpdatedBody(side);
        if (!(driver && context)) {
          feasible = false;
          break;
        }
        driver.captureVolumeFrame();

        const directions = this._armDirs[side];
        const upper = this._armWorldVec[side].upperArm.fromArray(directions.upperArm).normalize();
        const lower = this._armWorldVec[side].lowerArm.fromArray(directions.lowerArm).normalize();
        const hand = this._armWorldVec[side].hand.fromArray(directions.hand).normalize();
        this.axes.toWorld(upper, upper, side, sideMirror(side), frameReady);
        this.axes.toWorld(lower, lower, side, sideMirror(side), frameReady);
        this.axes.toWorld(hand, hand, side, sideMirror(side), frameReady);

        const palm = this._palmWorldVector[side].fromArray(this._palmOut[side]).normalize();
        this.axes.toWorld(palm, palm, side, sideMirror(side), frameReady);
        for (const finger of FINGER_NAMES) {
          const from = driver.acceptedCurls[finger] ?? 0;
          const to = this._fingerSpec[side][finger] ?? 0;
          this._transactionCurls[side][finger] = from + (to - from) * alpha;
          const fromSpread = driver.acceptedSpread[finger] ?? 0;
          const toSpread = this._fingerSpreadSpec[side][finger] ?? 0;
          this._transactionSpread[side][finger] = fromSpread + (toSpread - fromSpread) * alpha;
        }

        const twist = this._twist[side].value * this.axes.axialMirror(side, frameReady);
        driver.composeRequest(
          context,
          upper,
          lower,
          hand,
          palm,
          this._palmW[side].value,
          twist,
          this._transactionCurls[side],
          this._transactionSpread[side],
          !rollComposed[side],
        );
        rollComposed[side] = true;

        let output = driver.plan(context, dt);
        this.recordArmSolve(output);
        if (output.status === 'blocked') {
          if (!driver.restoreEndpoint(context, dt, true)) {
            this.recordArmSolve(driver.output);
            feasible = false;
            break;
          }
          this.recordArmSolve(driver.output);
          output = driver.output;
        }
        this._frameCommit[side] = {
          output,
          context,
          curls: this._transactionCurls[side],
          spread: this._transactionSpread[side],
        };
        this._fullArmQ[side].set(output.q);
      }
      if (!feasible) continue;
      const left = this._frameCommit.L;
      const right = this._frameCommit.R;
      if (!(left && right)) continue;

      for (let backtrack = 0; backtrack < ARM_STEP_BACKTRACKS.length; backtrack++) {
        const beta = ARM_STEP_BACKTRACKS[backtrack];
        if (beta === undefined) continue;
        if (beta < 1 && !this.evaluateArmCandidate(alpha, beta)) {
          feasible = false;
          break;
        }

        if (this.validateArmBridge(alpha, dt)) {
          if (!rig.commitArmFrame({ L: left, R: right }, candidateRise)) {
            feasible = false;
            break;
          }

          const acceptedFrameReady = this.axes.ready();
          for (const side of ['L', 'R'] as Side[]) {
            const driver = rig.armDriver(side);
            if (!driver) continue;
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
            this.axes.toCharacter(
              accepted.hand,
              driver.acceptedForward.h,
              side,
              acceptedFrameReady,
            );
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
          committed = true;
          break;
        }

        if (this._bridgeFailure !== 'speed' || backtrack + 1 === ARM_STEP_BACKTRACKS.length) {
          feasible = false;
          break;
        }
        this._armFrameWork.armStepRetries++;
      }
      if (committed) break;
      if (!feasible) continue;
    }

    // A failed articulation must not hold back the common signed jump
    // translation. This is its own accepted result, not a passed arm bridge.
    if (!committed) committed = rig.commitArmTransport(this._rise);
    if (!committed) {
      rig.applyBodyContext(0, 0);
      for (const side of ['L', 'R'] as Side[]) {
        const driver = rig.armDriver(side);
        const context = rig.armForwardContextFromUpdatedBody(side);
        if (driver && context) {
          const acceptedForward = driver.refreshAcceptedForward(context);
          rig.stageArmForward(side, acceptedForward, driver.acceptedCurls, driver.acceptedSpread);
        }
      }
    }
  }

  /** Evaluate a shared beta-scaled arm increment against the unchanged request. */
  private evaluateArmCandidate(alpha: number, beta: number): boolean {
    if (this.armBridgeSamplesSpent()) return false;
    this._bridgeSampleCount++;
    this._armFrameWork.bridgeSamples++;
    this.rig.applyBodyContext(alpha, 1);
    let valid = true;
    for (const side of ['L', 'R'] as Side[]) {
      const driver = this.rig.armDriver(side);
      const plan = this._frameCommit[side];
      const context = this.rig.armForwardContextFromUpdatedBody(side);
      if (!(driver && plan && context)) {
        valid = false;
        continue;
      }
      driver.captureVolumeFrame();
      const q = this._betaArmQ[side];
      const full = this._fullArmQ[side];
      for (let i = 0; i < q.length; i++) {
        q[i] = driver.acceptedQ[i] + (full[i] - driver.acceptedQ[i]) * beta;
      }
      if (!driver.validateLockedPose(q, context, plan.curls, plan.spread, driver.output)) {
        this.recordArmSolve(driver.output);
        valid = false;
        continue;
      }
      this.recordArmSolve(driver.output);
    }
    if (!valid) this._bridgeFailure = 'geometry';
    return valid;
  }

  private validateArmBridge(alpha: number, dt: number): boolean {
    this._bridgePendingCount = 0;
    const left = this.rig.armDriver('L');
    const right = this.rig.armDriver('R');
    if (!(left && right)) {
      this._bridgeFailure = 'geometry';
      return false;
    }
    this._bridgeAlpha = alpha;
    this._bridgeResolution = Math.min(left.sweepResolution, right.sweepResolution);
    this._bridgeFailure = 'geometry';

    let valid = true;
    let restored = false;
    let knotCount = 0;
    try {
      let previous: ArmBridgeSample | null = null;
      for (const s of ARM_BRIDGE_STARTS) {
        const sample = this.sampleArmBridge(s);
        if (!(sample && (!previous || this.armBridgeStepWithinBudget(previous, sample, dt)))) {
          valid = false;
          break;
        }
        this._bridgeKnots[knotCount++] = sample;
        previous = sample;
      }
      if (valid) {
        for (let index = 1; index < knotCount; index++) {
          if (
            !this.classifyArmBridgeInterval(
              this._bridgeKnots[index - 1],
              this._bridgeKnots[index],
              0,
            )
          ) {
            valid = false;
            break;
          }
        }
      }
      while (valid && this._bridgePendingCount > 0) {
        // Every unresolved interval needs its own distinct midpoint to certify.
        if (this._armFrameWork.bridgeSamples + this._bridgePendingCount > ARM_FRAME_BRIDGE_BUDGET) {
          this._bridgeFailure = 'budget';
          valid = false;
          break;
        }
        if (this._bridgeSampleCount + this._bridgePendingCount > ARM_BRIDGE_MAX_SAMPLES) {
          this._bridgeFailure = 'geometry';
          valid = false;
          break;
        }
        const selected = this.selectArmBridgeInterval();
        const interval = this._bridgeFrontier[selected];
        const from = interval.from;
        const to = interval.to;
        const depth = interval.depth;
        // Child classification may immediately reuse the freed record.
        const last = --this._bridgePendingCount;
        this._bridgeFrontier[selected] = this._bridgeFrontier[last];
        this._bridgeFrontier[last] = interval;
        const middle = this.sampleArmBridge((from.s + to.s) / 2);
        if (
          !(
            middle &&
            this.armBridgeStepWithinBudget(from, middle, dt) &&
            this.armBridgeStepWithinBudget(middle, to, dt)
          )
        ) {
          valid = false;
          break;
        }
        if (
          !this.classifyArmBridgeInterval(from, middle, depth + 1) ||
          !this.classifyArmBridgeInterval(middle, to, depth + 1)
        )
          valid = false;
      }
    } finally {
      restored = this.restoreArmBridgeContext(alpha);
    }
    if (!restored) this._bridgeFailure = 'geometry';
    return valid && restored;
  }

  /** Classify a rate-checked interval without treating a pending midpoint as certified. */
  private classifyArmBridgeInterval(
    from: ArmBridgeSample,
    to: ArmBridgeSample,
    depth: number,
  ): boolean {
    const travel = this.armBridgeTravel(from, to);
    if (!Number.isFinite(travel)) {
      this._bridgeFailure = 'geometry';
      return false;
    }
    if (travel <= this._bridgeResolution) return true;
    if (depth >= ARM_BRIDGE_MAX_DEPTH) {
      this._bridgeFailure = 'geometry';
      return false;
    }
    const interval = this._bridgeFrontier[this._bridgePendingCount++];
    interval.from = from;
    interval.to = to;
    interval.depth = depth;
    interval.travel = travel;
    return true;
  }

  /** Refine the greatest measured travel first, with a stable path-order tie break. */
  private selectArmBridgeInterval(): number {
    let selected = 0;
    for (let index = 1; index < this._bridgePendingCount; index++) {
      const candidate = this._bridgeFrontier[index];
      const current = this._bridgeFrontier[selected];
      if (
        candidate.travel > current.travel ||
        (candidate.travel === current.travel && candidate.from.s < current.from.s)
      )
        selected = index;
    }
    return selected;
  }

  private restoreArmBridgeContext(alpha: number): boolean {
    this.rig.applyBodyContext(alpha, 1);
    for (const side of ['L', 'R'] as Side[]) {
      const driver = this.rig.armDriver(side);
      const plan = this._frameCommit[side];
      const context = this.rig.armForwardContextFromUpdatedBody(side);
      if (!(driver && plan && context)) return false;
      driver.captureVolumeFrame();
      // `context` is Rig's reusable per-side record, so the existing commit
      // already points at this refreshed final candidate context.
    }
    return true;
  }

  private sampleArmBridge(s: number): ArmBridgeSample | null {
    if (this.armBridgeSamplesSpent()) return null;
    const sample = this._bridgeSamples[this._bridgeSampleCount++];
    if (!sample) return null;
    this._armFrameWork.bridgeSamples++;
    sample.s = s;
    this.rig.applyBodyContext(this._bridgeAlpha * s, s);

    for (const side of ['L', 'R'] as Side[]) {
      const driver = this.rig.armDriver(side);
      const endpoint = this._frameCommit[side];
      const context = this.rig.armForwardContextFromUpdatedBody(side);
      if (!(driver && endpoint && context)) return null;
      driver.captureVolumeFrame();

      const state = sample.side[side];
      for (let i = 0; i < state.q.length; i++) {
        state.q[i] = driver.acceptedQ[i] + (endpoint.output.q[i] - driver.acceptedQ[i]) * s;
      }
      for (const finger of FINGER_NAMES) {
        const fromCurl = driver.acceptedCurls[finger] ?? 0;
        const toCurl = endpoint.curls[finger] ?? 0;
        this._bridgeCurls[side][finger] = fromCurl + (toCurl - fromCurl) * s;
        const fromSpread = driver.acceptedSpread[finger] ?? 0;
        const toSpread = endpoint.spread[finger] ?? 0;
        this._bridgeSpread[side][finger] = fromSpread + (toSpread - fromSpread) * s;
      }
      const valid = driver.validateLockedPose(
        state.q,
        context,
        this._bridgeCurls[side],
        this._bridgeSpread[side],
      );
      this.recordArmSolve(driver.bridgeOutput);
      if (!valid) {
        this._bridgeFailure = 'geometry';
        return null;
      }

      const output = driver.bridgeOutput;
      state.upperLocal.copy(output.forward.upperLocal);
      state.lowerLocal.copy(output.forward.lowerLocal);
      state.handLocal.copy(output.forward.handLocal);
      for (let i = 0; i < output.points.length; i++)
        state.points[i]?.copy(output.points[i].position);
      state.hasTorso = this.copyBridgeFrameCoordinates(
        output.points,
        driver.volumeFrame.torso,
        state.torsoLocal,
      );
      state.hasHead = this.copyBridgeFrameCoordinates(
        output.points,
        driver.volumeFrame.head,
        state.headLocal,
      );
      if (state.points.length !== output.points.length) {
        this._bridgeFailure = 'geometry';
        return null;
      }
    }
    return sample;
  }

  private copyBridgeFrameCoordinates(
    points: readonly { position: THREE.Vector3 }[],
    frame: { O: THREE.Vector3; up: THREE.Vector3; right: THREE.Vector3; fwd: THREE.Vector3 } | null,
    out: THREE.Vector3[],
  ): boolean {
    if (!frame || out.length !== points.length) return false;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const target = out[i];
      if (!(point && target)) return false;
      this._bridgeRel.subVectors(point.position, frame.O);
      target.set(
        this._bridgeRel.dot(frame.right),
        this._bridgeRel.dot(frame.up),
        this._bridgeRel.dot(frame.fwd),
      );
    }
    return true;
  }

  private armBridgeStepWithinBudget(
    from: ArmBridgeSample,
    to: ArmBridgeSample,
    dt: number,
  ): boolean {
    const deltaS = to.s - from.s;
    const allowance = LIMIT_SLEW * Math.max(0, dt) * deltaS + Math.sqrt(Number.EPSILON);
    let within = true;
    for (const side of ['L', 'R'] as Side[]) {
      const a = from.side[side];
      const b = to.side[side];
      for (const dof of [5, 6]) {
        if (Math.abs(b.q[dof] - a.q[dof]) > allowance) within = false;
      }
      if (
        a.upperLocal.angleTo(b.upperLocal) > allowance ||
        a.lowerLocal.angleTo(b.lowerLocal) > allowance ||
        a.handLocal.angleTo(b.handLocal) > allowance
      ) {
        within = false;
      }
    }
    if (!within) this._bridgeFailure = 'speed';
    return within;
  }

  private armBridgeTravel(from: ArmBridgeSample, to: ArmBridgeSample): number {
    let maximum = 0;
    for (const side of ['L', 'R'] as Side[]) {
      const a = from.side[side];
      const b = to.side[side];
      if (a.points.length !== b.points.length) return Number.POSITIVE_INFINITY;
      for (let i = 0; i < a.points.length; i++) {
        const aPoint = a.points[i];
        const bPoint = b.points[i];
        if (!(aPoint && bPoint)) return Number.POSITIVE_INFINITY;
        maximum = Math.max(maximum, aPoint.distanceTo(bPoint));
        if (a.hasTorso !== b.hasTorso || a.hasHead !== b.hasHead) return Number.POSITIVE_INFINITY;
        if (a.hasTorso) {
          const aLocal = a.torsoLocal[i];
          const bLocal = b.torsoLocal[i];
          if (!(aLocal && bLocal)) return Number.POSITIVE_INFINITY;
          maximum = Math.max(maximum, aLocal.distanceTo(bLocal));
        }
        if (a.hasHead) {
          const aLocal = a.headLocal[i];
          const bLocal = b.headLocal[i];
          if (!(aLocal && bLocal)) return Number.POSITIVE_INFINITY;
          maximum = Math.max(maximum, aLocal.distanceTo(bLocal));
        }
      }
    }
    return maximum;
  }

  update(dt: number, ctx?: BodyContext): void {
    const headWorldTarget = ctx?.headWorldTarget ?? null;
    this.syncExternalArmRevision();
    this.t += dt;
    this.resetArmFrameWork();
    const { rig, p } = this;
    // The rig's anatomical limiter is the one thing below this line with a
    // speed of its own — see `Rig.slew` — and this is where it learns the frame.
    rig.dt = dt;

    // --- gesture envelopes ------------------------------------------------
    let g: Pose | null = null;
    if (this.gesture) {
      const { def, lead } = this.gesture;
      const t = this.gesture.time + dt;
      const out = lead * 1.25;
      // A sustained pose holds at full weight until it is released.
      const held = def.sustain && !this.gesture.released;
      // Eased in and out. A linear ramp starts and stops with a visible corner,
      // which is exactly the frame the eye picks up as machine-driven.
      //
      // The two phases are computed apart and multiplied at the end rather than
      // being decided between: only one of them is ever off 1, so the product
      // is the same number the branch used to produce, and a reach can ask
      // which of the two a weight below 1 came from. See `Envelope`.
      const xIn = this.gesture.released
        ? this.gesture.releasedIn
        : lead > 0
          ? Math.min(1, t / lead)
          : 1;
      const { exitAt } = this.gesture;
      const xOut = held || t < exitAt ? 1 : Math.max(0, 1 - (t - exitAt) / out);
      this._env.entrance = minJerk(xIn);
      this._env.exit = minJerk(xOut);
      this._exitU = 1 - xOut;
      if (xOut < 1 && !this._exiting) {
        this._exiting = true;
        this._arm.beginExit();
        this._arm.freezeClasp(true);
      }

      // Per link, staggered outward along the limb and allowed to overshoot.
      for (const slot of ARM_SLOTS) {
        const e = this._armEnv[slot];
        e.entrance = reachEnvelope(onset(xIn, LINK_ONSET[slot]));
        e.exit = this._env.exit;
      }
      // No overshoot on a curl: a finger that opens past straight to settle
      // back is a joint bending the wrong way, not a limb carrying momentum.
      this._fingerEnv.entrance = minJerk(onset(xIn, FINGER_ONSET));
      this._fingerEnv.exit = this._env.exit;

      // The envelope *is* the weight, with nothing chasing it. It is already
      // zero-velocity and zero-acceleration at both ends, so a lag on top adds
      // nothing but lateness and an exponential tail that never quite arrives —
      // and that tail was most of what made a finished gesture read as still
      // settling into itself.
      // No `v.scale` here: amplitude variation belongs to the oscillations a
      // gesture writes, and a weight past 1 pushes a pose past what was authored.
      const target = this._env.entrance * this._env.exit;
      this.blend = target;
      // Built from t=0, not from t-lead. Freezing the pose through the lead and
      // only starting the motion afterwards makes the gesture appear to begin
      // twice: once as the blend rises, again as the motion kicks in.
      g = this.advance(this.gesture, dt);
      if (target === 0 && this.blend < 0.01) {
        this.gesture = null;
        this.blend = 0;
        g = null;
      }
    }

    // Restarted switches capture the weights already on screen, including all
    // earlier outgoing slots. Their sum complements the new entrance without
    // pulling a held pose toward rest. This clock also runs after a release.
    this._fadeTime += dt;
    const fadeFraction =
      this._fadeDuration > 0 ? Math.min(1, this._fadeTime / this._fadeDuration) : 1;
    const spineRemaining = 1 - minJerk(fadeFraction);
    // The arm links fade against the incoming links' own staggered entrance.
    const remaining = this._fadeRemaining;
    for (const slot of ARM_SLOTS) {
      remaining[slot] = 1 - Math.min(1, reachEnvelope(onset(fadeFraction, LINK_ONSET[slot])));
    }

    let kept = 0;
    // The hand the last gesture left is held until the new one's fingers come
    // in, so its slot outlives its arm weight; see the finger blend. Taken
    // before pruning: if this slot goes, no older one inherits the hold.
    const handSource = this._fading[this._fading.length - 1];
    const holdingHand = !!(g?.fingers || g?.fingerSpread) && this._fingerEnv.entrance < 1;
    for (const f of this._fading) {
      f.w *= Math.exp(-dt * 6);
      let armLeft = 0;
      for (const slot of ARM_SLOTS) {
        f.armW[slot] = f.armStart[slot] * remaining[slot];
        armLeft += f.armW[slot];
      }
      if (armLeft === 0 && f.w < 0.01 && !(holdingHand && f === handSource)) {
        f.armAlive = false;
        if (!f.spineAlive) {
          f.pose = null;
          this._spare.push(f);
        }
        continue;
      }
      // The outgoing gesture keeps moving while it fades. Dissolving a frozen
      // pose looks different from a gesture being abandoned partway through,
      // and the second is what actually happened.
      f.pose = this.advance(f.g, dt);
      this._fading[kept++] = f;
    }
    this._fading.length = kept;

    kept = 0;
    for (const f of this._spineFading) {
      f.spineWeight = f.spineStart * spineRemaining;
      if (f.spineWeight === 0) {
        f.spineAlive = false;
        if (!f.armAlive) {
          f.pose = null;
          this._spare.push(f);
        }
        continue;
      }
      // The arm loop already advanced live arm slots. A spine that outlives
      // its arm still builds exactly once per frame, using the same pose clock.
      if (!f.armAlive) f.pose = this.advance(f.g, dt);
      this._spineFading[kept++] = f;
    }
    this._spineFading.length = kept;

    // A gesture that moves the head or neck owns it: the nod gives way by the
    // gesture's own weight, keyed on which slots it writes rather than their values.
    let w = this.gesture && touchesHead(g?.spine) ? this.blend : 0;
    for (const f of this._spineFading) if (touchesHead(f.pose?.spine)) w += f.spineWeight;
    w = Math.min(1, w);

    // Everything a standing body does on its own — breathing, the weight
    // shift, the hop's fold through the trunk, the head's drift. See
    // `posture.ts`. The hop is advanced first because the fold reads its
    // output; nothing about it touches the rig.
    this.jumpStep(dt);
    this.refreshHipsFrame();
    const pin = this._postureIn;
    pin.t = this.t;
    pin.speaking = this.speaking;
    pin.speechEnergy = this.speechEnergy;
    pin.nod = this.speechNod * (1 - w);
    pin.breathPeriod = this.breathPeriod;
    pin.breathDepth = this.breathDepth;
    pin.weightShift = this.weightShift;
    pin.idleAmount = this.idleAmount;
    pin.hipsRest = this.hipsRest;
    pin.hipsRight = this.hipsRight;
    pin.hipsUp = this.hipsUp;
    pin.jumpHeight = this.jumpHeight;
    pin.rise = this._rise;
    pin.load = this._load;
    const { br, d } = this._posture.apply(rig, p, dt, pin);
    const idle = this.idleAmount;
    // Every gesture slot contributes to the spine; the outgoing ones are fading.
    for (const f of this._spineFading) {
      if (!f.pose?.spine) continue;
      for (const [slot, o] of Object.entries(f.pose.spine) as Array<[SpineSlot, Vec3Tuple]>) {
        rig.addOffset(slot, o[0] * f.spineWeight, o[1] * f.spineWeight, o[2] * f.spineWeight);
      }
    }
    if (g?.spine) {
      for (const [slot, o] of Object.entries(g.spine) as Array<[SpineSlot, Vec3Tuple]>) {
        rig.addOffset(slot, o[0] * this.blend, o[1] * this.blend, o[2] * this.blend);
      }
    }

    // --- gaze -------------------------------------------------------------
    const speech = this._speech;
    speech.speaking = this.speaking;
    speech.remaining = this.speechRemaining;
    speech.opens = this.speechOpens;
    speech.closes = this.speechCloses;
    this._gaze.update(dt, this.t, speech);
    this.saccade = this._gaze.saccade;
    prepareGaze(
      rig,
      p,
      this._gaze,
      { lookAt: this._look.step(this.lookAt, dt, LOOK_FOLLOW), gazeAmount: this.gazeAmount },
      headWorldTarget,
      this._gazeFrame,
    );

    rig.commitSpine();
    // Before the live frame and reach origins are read; springs still see the pose last.
    rig.plantLegs(this._rise);
    // Spine offsets change the body frame. Resolve it once here, after commit,
    // so every direction sent to Rig in this frame uses the same live basis.
    const frameReady = rig.anat.update();
    const armTransaction = rig.beginBodyArmFrame();

    // --- arms -------------------------------------------------------------
    const armDrift = 0.016 * idle;
    const env = this._idleEnv;
    env.br = br;
    env.d = d;
    env.armDrift = armDrift;
    env.dt = dt;

    for (const side of g?.clasp ? (g.clasp.lead === 'L' ? ORDER_L : ORDER_R) : SIDES) {
      const mirror = sideMirror(side);
      const dirs = this._armDirs[side];
      const worldDirs = this._armWorld[side];
      // Set by `resolveArm` below, for this frame only: whether the current
      // gesture is carrying this hand through the room rather than posing it.
      this._arm.clearTravelling(side);

      // The shoulder is posed before the arm is solved, not with it. A reach
      // starts from the upper arm's world position, and posing the shoulder
      // moves that position — by a quarter of an interpupillary distance on
      // this rig. Solving first and posing after leaves every reach short by
      // exactly that, permanently: the shoulder is back at its rest orientation
      // by the time the next frame solves, so there is nothing to converge on.
      // Only authored directions are read here; a reach never states a shoulder.
      const es = this._armEnv.shoulder;
      const sv = this.composeArmTarget(
        'shoulder',
        side,
        env,
        g?.arms?.[side]?.shoulder,
        plain(es),
        true,
      );

      // Give the girdle its say before the shoulder is posed. Only for a reach,
      // and only where the pose has no shoulder of its own to state — a gesture
      // that says where the shoulder goes means it. Folded into the follower's
      // target, every slot at its own weight, so the turn arrives and leaves
      // with the reach rather than on the switch frame.
      const turn = _girdleTurn.set(0, 0, 0);
      this.axes.tupleToWorld(worldDirs.shoulder, sv, side, mirror, frameReady);
      for (const f of this._fading) {
        this.girdleShare(f.pose, side, f.w, worldDirs.shoulder, turn, frameReady);
      }
      this.girdleShare(g, side, this.blend, worldDirs.shoulder, turn, frameReady);
      if (turn.lengthSq() > 0) {
        rig.turnGirdle(worldDirs.shoulder, turn);
        this.axes.toCharacter(sv, _girdleDir.fromArray(worldDirs.shoulder), side, frameReady);
      }
      this.followArm('shoulder', side, sv, dt, ARM_FOLLOW);
      this.axes.tupleToWorld(worldDirs.shoulder, dirs.shoulder, side, mirror, frameReady);
      rig.aimShoulder(side, worldDirs.shoulder);

      for (const f of this._fading) {
        f.arm[side] = this._arm.resolve(
          f.pose,
          side,
          mirror,
          f.reach,
          this._armEnv.hand.entrance,
          false,
          frameReady,
        );
      }
      const cArm = this._arm.resolve(
        g,
        side,
        mirror,
        this._curReach,
        this._armEnv.hand.entrance,
        true,
        frameReady,
      );

      /**
       * A link is *carried* when a travelling reach is deciding where it goes,
       * and blended when a pose is.
       *
       * Only the two links that decide where the wrist *is*. The hand's own
       * direction is stated by the pose rather than solved from the target, so
       * there is nothing about it the interpolated point has already eased —
       * carrying it would put the wrist at the gesture's angle while the arm is
       * still down by the hip, which is a request no wrist has the range for.
       * It rides the staggered envelope with the palm and the twist instead.
       *
       * A carried link takes the incoming pose at full weight, because the
       * entrance is already in the target: applying it twice would ease the arm
       * toward a point that is itself still easing, and the hand would leave
       * late and creep the last part of the way. Only the exit may take it back
       * off. The amplitude variation goes too — a travel ends on an anchor that
       * is a point on the body, and scaling a contact by 0.92 is a hand that
       * stops short of the cheek it was reaching for. Variation belongs to the
       * oscillations a gesture writes on top, and they still carry it.
       *
       * The outgoing gesture drops out entirely for the same reason: the travel
       * departs from where the wrist actually was, which already includes
       * whatever the outgoing pose was contributing. Crossfading it back in on
       * top would count it twice.
       *
       * An exit carries every link, the hand included, at full weight: the way
       * home is already in the solve, hand and all — see `ArmResolver.retreat`.
       */
      const back =
        this._exiting && g ? this._arm.retreat(cArm, side, this._exitU, this._rest) : null;
      const travelling = this._arm.travelling(side);

      for (const slot of ARM_SLOTS) {
        if (slot === 'shoulder') continue;
        const carried = back !== null || (travelling && slot !== 'hand');
        const src = back ?? cArm;
        const parent = ARM_PARENT[slot];
        const v = this.composeArmTarget(
          slot,
          side,
          env,
          src?.[slot],
          back ? 1 : carried ? this._armEnv[slot].exit : plain(this._armEnv[slot]),
          !carried,
          parent ? src?.[parent] : undefined,
        );
        this.followArm(slot, side, v, dt, carried ? TRAVEL_FOLLOW : ARM_FOLLOW);
        this.axes.tupleToWorld(worldDirs[slot], dirs[slot], side, mirror, frameReady);
        this.axes.toWorld(this._armWorldVec[side][slot], dirs[slot], side, mirror, frameReady);
      }

      // The wrist's own channels ride the hand link's envelope: a palm roll and
      // a forearm twist are part of the hand arriving, not of the arm setting
      // out, and starting them with the shoulder is what made a hand appear to
      // present itself before it had gone anywhere.
      //
      // Not travel-aware, unlike the limb directions above. A palm and a twist
      // are stated by the pose rather than solved from the target, so there is
      // nothing about them that the interpolated target has already eased —
      // taking them at full weight from the first frame would be a step. They
      // arrive late instead, which is what a wrist does.
      // As for the limbs: an arm the incoming gesture poses is complemented, and
      // one it leaves alone goes home on the outgoing decay.
      const cw = plain(this._armEnv.hand);
      let twistTarget = 0;
      for (const f of this._fading) {
        twistTarget += (f.arm[side]?.twist ?? 0) * (cArm ? f.armW.hand : f.w);
      }
      twistTarget += (cArm?.twist ?? 0) * cw;
      this._twist[side].step(twistTarget, dt, ARM_FOLLOW);

      // Palm direction blends and follows like the limb directions do; see
      // `composeArmTarget` for the shares.
      const pt = this._palmTarget.copy(BASE_PALM);
      if (cArm?.palm) {
        let pool = 1 - cw;
        for (const f of this._fading) if (f.arm[side]?.palm) pool -= f.armW.hand;
        pool = Math.max(0, pool);
        for (const f of this._fading) {
          const palm = f.arm[side]?.palm;
          const share = f.armW.hand;
          if (!palm || share <= 0) continue;
          pool += share;
          pt.lerp(palm, share / pool).normalize();
        }
        pt.lerp(cArm.palm, cw).normalize();
      } else {
        for (const f of this._fading) {
          const palm = f.arm[side]?.palm;
          if (palm) pt.lerp(palm, f.w).normalize();
        }
      }
      const ps = this._palm[side].step(pt, dt, ARM_FOLLOW);
      const po = this._palmOut[side];
      // Palm state follows the same canonical frame as the arm directions.
      po[0] = ps.x;
      po[1] = ps.y;
      po[2] = ps.z;
      const palmWorld = this.axes.tupleToWorld(
        this._palmWorldOut[side],
        po,
        side,
        mirror,
        frameReady,
      );
      this._palmWorldVector[side].fromArray(palmWorld);

      // BASE_PALM describes an arm hanging at the side, and only that. A pose
      // that raises the hand and states no palm of its own must not be held to
      // it — keeping a lifted hand rolled as though it were still by the hip
      // demands most of a half turn, which is where the wrist collapsed. Such a
      // pose releases the constraint as it blends in and the roll falls back to
      // whatever the aim itself produces.
      let hold = 1;
      for (const f of this._fading) {
        const arm = f.arm[side];
        if (arm && !arm.palm) hold -= cArm ? f.armW.hand : f.w;
      }
      if (cArm && !cArm.palm) hold -= cw;
      const palmW = Math.max(0, this._palmW[side].step(Math.max(0, hold), dt, ARM_FOLLOW));

      if (!armTransaction) {
        rig.aimArmLegacy(
          side,
          worldDirs,
          this._twist[side].value * this.axes.axialMirror(side, frameReady),
          palmWorld,
          palmW,
        );
        this._arm.note(side, dirs.upperArm, dirs.lowerArm, dirs.hand);
      }

      const cf = g?.fingers?.[side];
      const cfSpread = g?.fingerSpread?.[side];
      const spec = this._fingerSpec[side];
      const spread = this._fingerSpreadSpec[side];
      const fw = plain(this._fingerEnv);
      // A clasp's fingers open toward flat over the first part of the exit, or of
      // the fade once it is no longer the current gesture.
      const cc = g?.clasp;
      const cSpread = cc ? this._claspSpread[side][side === cc.lead ? 'lead' : 'follow'] : null;
      const cK = minJerk((this._exiting ? this._exitU : 0) / UNTHREAD);
      // Interlaced fingers are not free to drift or trail; the life fades with
      // whatever share of the hand a clasp still holds.
      let held = cc ? fw * (1 - cK) : 0;
      for (const o of this._fading) {
        if (o.pose?.clasp) held += o.w * (1 - minJerk((1 - o.w) / UNTHREAD));
      }
      const free = Math.max(0, 1 - held);
      // A switch hands the hand straight over. The outgoing shape fades on its
      // own decay and the incoming one starts late (FINGER_ONSET); weighted
      // as they are, the gap between sagged even fist-to-point a quarter open.
      // The hold goes to `handSource` alone, never to an older slot left last.
      // Held so that rest shows through only as far as the new gesture's own
      // exit lets it: (1 - hold)(1 - fw) = 1 - exit.
      const fx = this._fingerEnv.exit;
      const handHold = (cf || cfSpread) && fw < 1 ? 1 - (1 - fx) / (1 - fw) : 0;
      this._fingerLife.sense(side, dt, armTransaction ? rig.lastAcceptedHandPose(side) : undefined);
      for (const f of FINGER_NAMES) {
        let val = BASE_FINGERS[f];
        let spreadVal = 0;
        for (const o of this._fading) {
          const oc = o.pose?.clasp;
          const oSpread = oc ? this._claspSpread[side][side === oc.lead ? 'lead' : 'follow'] : null;
          const oK = minJerk((1 - o.w) / UNTHREAD);
          let pv = o.pose?.fingers?.[side]?.[f];
          if (pv !== undefined && oSpread) pv = claspCurl(side !== oc?.lead, f, pv, oK);
          const ow = o === handSource ? Math.max(o.w, handHold) : o.w;
          if (pv !== undefined) val += (pv - val) * ow;
          const pvSpread = oSpread
            ? (oSpread[f] ?? 0) * (1 - oK)
            : o.pose?.fingerSpread?.[side]?.[f];
          if (pvSpread !== undefined) spreadVal += (pvSpread - spreadVal) * ow;
        }
        let cv = cf?.[f];
        if (cv !== undefined && cSpread) cv = claspCurl(side !== cc?.lead, f, cv, cK);
        if (cv !== undefined) val += (cv - val) * fw;
        val += this._fingerLife.offset(side, f, val, this.t, idle, br * d, free);
        spec[f] = val;

        const cvSpread = cSpread ? (cSpread[f] ?? 0) * (1 - cK) : cfSpread?.[f];
        if (cvSpread !== undefined) spreadVal += (cvSpread - spreadVal) * fw;
        spreadVal += this._fingerLife.spread(side, f, val, free);
        spread[f] = this._fingerSpreadState[side][f].step(spreadVal, dt, FINGER_FOLLOW);
      }
      const state = this._fingerState[side];
      this._fingerLife.enslave(side, spec, dt, fingerRate, free);
      for (const f of FINGER_NAMES) spec[f] = state[f].step(spec[f], dt, fingerRate(f));
      if (armTransaction) {
        const driver = rig.armDriver(side);
        if (cc && side === cc.lead && driver) {
          const context = rig.armForwardContext(side);
          if (context) {
            driver.captureVolumeFrame();
            driver.composeRequest(
              context,
              this._armWorldVec[side].upperArm,
              this._armWorldVec[side].lowerArm,
              this._armWorldVec[side].hand,
              this._palmWorldVector[side],
              palmW,
              this._twist[side].value * this.axes.axialMirror(side, frameReady),
              spec,
              spread,
              false,
            );
            const provisional = driver.plan(context, dt);
            this.recordArmSolve(provisional);
            if (provisional.status === 'blocked' && !driver.restoreEndpoint(context, dt, true)) {
              this.recordArmSolve(driver.output);
              // Keep the last committed leader visible to the clasp resolver.
              rig.stageArmForward(
                side,
                driver.acceptedForward,
                driver.acceptedCurls,
                driver.acceptedSpread,
              );
            } else {
              if (provisional.status === 'blocked') this.recordArmSolve(driver.output);
              rig.stageArmOutput(side, provisional, spec, spread);
            }
          }
        }
      } else {
        rig.curlHandLegacy(side, spec, spread);
      }
    }

    if (armTransaction) this.commitArmTransaction(dt);
    else rig.finishLegacyBodyFrame(this._rise);
    aimEyes(rig, p, this._gazeFrame);
    rig.commitEyes();
  }
}
