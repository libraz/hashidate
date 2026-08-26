import type * as THREE from 'three';

/**
 * Shared vocabulary for the runtime.
 *
 * Every layer below the director speaks in *canonical slots* — "upperArm.L",
 * viseme "a", emotion "joy" — and the profile resolves those against whatever
 * one particular avatar happens to call things. This file is that vocabulary,
 * plus the shape of the two objects the layers hand each other: the avatar
 * descriptor going in, and the resolved profile coming out.
 *
 * Nothing here imports from anywhere but three. It is the one module every
 * other one is allowed to depend on.
 */

// --- primitives -------------------------------------------------------------

/** Which arm, in the character's own terms. Never a world direction. */
export type Side = 'L' | 'R';

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'little';

/** A finger chain, keyed as it is stored on the profile. */
export type FingerKey = `${FingerName}.${Side}`;

/** The links an arm pose names, shoulder to hand. */
export type ArmSlot = 'shoulder' | 'upperArm' | 'lowerArm' | 'hand';

/** Slots along the spine, which take additive offsets rather than aims. */
export type SpineSlot = 'hips' | 'spine' | 'chest' | 'neck' | 'head';

export type EyeSlot = `eye.${Side}`;

export type ArmBoneSlot = `${ArmSlot}.${Side}`;

/** Every bone slot the profile tries to resolve. */
export type BoneSlot = SpineSlot | EyeSlot | ArmBoneSlot;

/**
 * A direction in *character space*: x outward from the midline, y up, z
 * forward. Mirrored per side when applied, which is what lets one authored
 * gesture serve both arms on any rig.
 */
export type Vec3Tuple = [number, number, number];

// --- expression vocabulary --------------------------------------------------

export type EmotionName =
  | 'neutral'
  | 'joy'
  | 'anger'
  | 'sadness'
  | 'surprise'
  | 'relaxed'
  | 'thinking'
  | 'shy';

/**
 * A blend, not a choice. Weights need not sum to one — the layers that consume
 * it normalise where normalising is meaningful.
 */
export type EmotionVector = Partial<Record<EmotionName, number>>;

/** Mouth shapes, as the profile routes them. `n` and `sil` are optional on a rig. */
export type VisemeName = 'a' | 'i' | 'u' | 'e' | 'o' | 'n' | 'sil';

/** The VRM 1.0 preset emotions, used only as the degraded fallback channel. */
export type VrmEmotionName = 'neutral' | 'joy' | 'anger' | 'sadness' | 'relaxed' | 'surprise';

/** A weight map in some shape vocabulary — ARKit's, or one avatar's own. */
export type ShapeWeights = Record<string, number>;

/** Camera framings the session can be asked for. */
export type CameraFrame = 'face' | 'bust' | 'upper' | 'full';

// --- anatomy ----------------------------------------------------------------

/**
 * One degree of freedom, in radians.
 *
 * Two bands rather than one bound: `free` is the range daily movement actually
 * uses and costs nothing, `max` is the hard stop. The gap between them is the
 * strained band a solver may spend at a rising cost. See `anatomy/joints.ts`.
 */
export interface JointDof {
  label: string;
  free: [number, number];
  max: [number, number];
}

/** Shoulder elevation ceiling samples: `[planeDegrees, freeDegrees, maxDegrees]`. */
export type ElevationRow = [number, number, number];

export interface JointSpec {
  label: string;
  dofs: Record<string, JointDof>;
  /** Only the shoulder has one: how far it lifts depends on which way it lifts. */
  elevation?: ElevationRow[];
}

/**
 * The joint table.
 *
 * Engine data, not avatar data — it describes the body being depicted, so it is
 * the same for every humanoid. An avatar that is deliberately not human
 * overrides it through `AvatarDescriptor.anatomy`.
 */
export interface JointTable {
  shoulder: JointSpec & { elevation: ElevationRow[] };
  elbow: JointSpec;
  wrist: JointSpec;
  finger: JointSpec;
  thumb: JointSpec;
  neck: JointSpec;
  spine: JointSpec;
}

export type StrainZone = 'natural' | 'strained' | 'limit';

/** One row of the joint readout. */
export interface JointReading {
  id: string;
  label: string;
  /** Degrees, or a percentage where `unit` says so. */
  deg: number;
  unit?: string;
  strain: number;
  zone: StrainZone;
  range: [number, number];
  /**
   * False for a quantity that exists but is not determined by the current pose
   * — the plane of a hanging arm, the rotation of a straight one. Showing a
   * zone for those would report noise as a judgement.
   */
  measured: boolean;
}

// --- profile ----------------------------------------------------------------

/** One place a shape name lands. A name may live on several meshes. */
export interface MorphTarget {
  mesh: THREE.Mesh;
  index: number;
}

/**
 * How far the gaze chain may turn, in radians.
 *
 * Avatar data: the usable range is a property of how the eye is drawn, and a
 * toon eye whose iris nearly fills its opening has almost no travel before
 * sclera appears.
 */
export interface GazeLimits {
  eyeYaw: number;
  eyePitch: number;
  headYaw: number;
  headPitch: number;
  neckYaw: number;
  neckPitch: number;
}

/**
 * A right/up/forward frame for the head, in head-local space, plus the
 * interpupillary distance the face anchors are measured in.
 */
export interface FaceFrame {
  origin: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
  ipd: number;
}

/** The torso frame, in chest-local space. `span` is trunk half-width plus arm. */
export interface BodyFrame {
  right: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
  span?: number | null;
}

export interface BlinkShapes {
  both: string | null;
  L: string | null;
  R: string | null;
}

export interface ArkitSupport {
  /** 52 minus tongueOut is normal for Japanese avatars, so the bar is 45. */
  supported: boolean;
  count: number;
  names: Set<string>;
}

/**
 * The resolved avatar.
 *
 * The runtime never names a bone or a blendshape directly; it asks the profile
 * for a canonical slot and the profile answers in this avatar's terms. Swapping
 * avatars means swapping this object.
 */
export interface Profile {
  /** The loaded GLB scene, kept so anatomy can measure the body's actual shape. */
  root: THREE.Object3D;
  avatar: AvatarDescriptor;
  bones: Partial<Record<BoneSlot, THREE.Bone>>;
  fingerBones: Partial<Record<FingerKey, THREE.Bone[]>>;
  morphTargets: Map<string, MorphTarget[]>;
  faceMeshes: THREE.Mesh[];
  /** Flat name → index view, for the HUD. Routing goes through `morphTargets`. */
  dict: Record<string, number>;
  viseme: Partial<Record<VisemeName, string>>;
  vrmEmotion: Partial<Record<VrmEmotionName, string>>;
  blink: BlinkShapes;
  arkit: ArkitSupport;
  /** Which world X is the character's left. Derived, never assumed. */
  sideSign: number;
  /** Bone-local direction toward the next link, per slot and per finger segment. */
  restDir: Record<string, THREE.Vector3>;
  /** Shape groups discovered from the author's separator shapes. */
  groups: Map<string, string[]>;
  face: FaceFrame | null;
  body: BodyFrame | null;
  /** World-unit segment lengths: `upper.L`, `lower.R`, `tip.L.index`, … */
  limb: Record<string, number>;
  /** Everything auto-detection could not resolve, for reporting rather than throwing. */
  missing: string[];
  gaze: GazeLimits;
  /** Present only where the avatar overrides the human joint table. */
  anatomy?: JointTable;
}

// --- gestures ---------------------------------------------------------------

/** Per-finger curl, 0 straight to 1 the joint's natural full flexion. */
export type FingerSpec = Partial<Record<FingerName, number>>;

/**
 * Directions for one arm, in character space. Omitted links keep their rest pose.
 *
 * `palm` and `twist` ride along with the links rather than sitting beside them
 * because a solved reach produces all six together and the blend path must not
 * be able to tell an authored arm from a solved one — that is what lets a point
 * crossfade with a wave. `thumbsUp` in particular depends on it: its palm has
 * to travel this path, because a `twist` stated anywhere else is ignored.
 */
export interface ArmDirections {
  shoulder?: THREE.Vector3;
  upperArm?: THREE.Vector3;
  lowerArm?: THREE.Vector3;
  hand?: THREE.Vector3;
  /** Which way the palm faces. Aiming the hand leaves this roll undetermined. */
  palm?: THREE.Vector3;
  /** Axial roll about the hand's own axis, radians. */
  twist?: number;
}

/** Which anchor a reach lands on. Face anchors are in IPD, body anchors in spans. */
export type AnchorSpace = 'face' | 'body';

/**
 * A pose that has to make *contact*, given as a place rather than as directions.
 *
 * A direction fixes where the elbow points and leaves where the hand ends up to
 * the avatar's arm length, which is why anything touching the face is authored
 * this way instead.
 */
export interface ReachSpec {
  /** Anchor name — see `FACE_ANCHORS` / `BODY_ANCHORS` in `profile/frames.ts`. */
  at: string;
  space?: AnchorSpace;
  /** Nudge from the anchor, in the anchor's own units. */
  offset?: Vec3Tuple;
  /** Wrist-to-fingertip direction, character space. */
  hand?: Vec3Tuple;
  /** Which way the palm faces, character space. */
  palm?: Vec3Tuple;
  /** Where the elbow is drawn toward, from the shoulder, in body spans. */
  pole?: Vec3Tuple;
  /** Raw elbow angle about the reach line. `pole` is preferred; see `rig/reach.ts`. */
  elbow?: number;
  twist?: number;
}

/**
 * A fingertip target, given as a bearing from the shoulder in the body's own
 * frame. Survives the character turning, leaning or being a different size in a
 * way a world position does not.
 */
export interface PointSpec {
  /** Radians. 0 straight ahead, positive toward the character's right. */
  azimuth?: number;
  /** Radians. 0 at shoulder height, positive up. */
  elevation?: number;
  /** 0..1 of the arm's full reach, fingertip included. */
  extent?: number;
  finger?: FingerName;
  /** False for an absolute bearing; otherwise the azimuth mirrors per side. */
  mirror?: boolean;
  /**
   * Authored form: a tuple in character space.
   *
   * The motion layer rewrites these into shared scratch vectors on the way to
   * the solver rather than allocating per frame, so what the *rig* accepts is
   * wider — see `PointRequest` in `rig/`. Keeping the two apart means a gesture
   * table cannot accidentally be written against runtime scratch, which is
   * shared and would alias.
   */
  point?: Vec3Tuple | null;
  palm?: Vec3Tuple | null;
  twist?: number;
}

/** Additive spine offsets for a frame, in radians, per slot. */
export type SpineOffsets = Partial<Record<SpineSlot, Vec3Tuple>>;

/** What one frame of a gesture asks for. Every field is optional. */
export interface Pose {
  arms?: Partial<Record<Side, ArmDirections>>;
  fingers?: Partial<Record<Side, FingerSpec>>;
  reach?: Partial<Record<Side, ReachSpec>>;
  point?: Partial<Record<Side, PointSpec>>;
  spine?: SpineOffsets;
}

/**
 * Per-playback variation. Frequency and amplitude only, never phase: `build` is
 * called from t=0 and a phase offset would put every oscillation mid-swing on
 * the first frame, snapping the limb into the gesture.
 */
export interface GestureVariation {
  rate: number;
  scale: number;
  /** ±1. Which hand a one-handed gesture uses. */
  side: number;
}

export type GestureGroup = 'reaction' | 'greeting' | 'explain' | 'emote' | 'cute' | 'pose';

export interface GestureDef {
  label: string;
  group: GestureGroup;
  /** Seconds of entrance. A floor — the real lead scales with how far the arms travel. */
  lead: number;
  /** Seconds held at full weight before the exit begins. */
  hold: number;
  /** A pose that holds until released rather than running out on its own. */
  sustain?: boolean;
  build(t: number, v: GestureVariation): Pose;
}

// --- avatar descriptor ------------------------------------------------------

export interface ShapeOverrides {
  blink?: { both?: string[]; L?: string[]; R?: string[] };
  viseme?: Partial<Record<VisemeName, string[]>>;
}

/** A group of author-drawn shapes, discovered by group name rather than by convention. */
export interface DrawnShapeSpec {
  /** Group label, as it appears between the author's separator shapes. */
  group: string;
  /** Shapes in that group that are not expressions — fitting shapes and the like. */
  exclude?: string[];
  label?: (id: string) => string;
}

/** Finished whole-face drawings, plus which canonical emotion reaches each. */
export interface PresetSpec extends DrawnShapeSpec {
  emotion?: Partial<Record<EmotionName, string>>;
}

export interface MaterialRules {
  /** Genuinely flat pieces — hair cards, coats — that need both faces drawn. */
  doubleSided?: RegExp;
  /** Coplanar overlays on the face: lashes, brows, drawn effects. */
  faceDecal?: RegExp;
}

export interface WardrobeItem {
  id: string;
  label: string;
  meshes: string[];
  /** Shapes this item raises while worn — VRChat `*Hide`, or a `Shrink_*` family. */
  hide?: string[];
}

export interface WardrobeSlot {
  label: string;
  items: WardrobeItem[];
}

export interface WardrobePreset {
  label: string;
  set: Record<string, string | null>;
}

export interface WardrobeTable {
  slots: Record<string, WardrobeSlot>;
  presets?: Record<string, WardrobePreset>;
  note?: string;
}

/** A sphere, or a capsule when `tail` is given. Metres along the bone's own axes. */
export interface ColliderSpec {
  bone: string;
  offset?: Vec3Tuple;
  tail?: Vec3Tuple;
  radius?: number;
  /** Invert it: keep the point *within* the sphere rather than out of it. */
  inside?: boolean;
}

export interface SwayGroupSpec {
  id: string;
  label?: string;
  /** Restoring force toward the rest direction. */
  stiffness?: number;
  /** Fraction of velocity lost per step, 0..1. */
  drag?: number;
  gravity?: number;
  gravityDir?: Vec3Tuple;
  /** The swinging tail's own radius, for collision. */
  radius?: number;
  roots?: string[];
  /** Name a hub and take its children as roots, rather than listing sixteen bones. */
  childrenOf?: string[];
  /** Collider set ids from `SwaySpec.colliders`. */
  colliders?: string[];
}

export interface SwaySpec {
  colliders?: Record<string, ColliderSpec[]>;
  groups: SwayGroupSpec[];
}

/** An appendage posed rather than merely simulated. Angles in radians. */
export interface TailDrive {
  /** Which sway group's roots to claim. */
  group?: string;
  swing?: number;
  lift?: number;
  /** Resting bias on the lift axis, -1..1. */
  rest?: number;
}

/**
 * Everything that is a property of one particular model.
 *
 * Adding an avatar is adding one of these. Nothing in the director, the rig or
 * the motion layer changes. Every field except `id`, `label` and `url` is
 * optional; an avatar that states none of them still loads, and whatever cannot
 * be resolved is reported through `Profile.missing` rather than failing.
 */
export interface AvatarDescriptor {
  id: string;
  label: string;
  author?: string;
  /** GLB path, served from `public/`. */
  url: string;
  /** Matches this author's shape-group delimiter, capturing the group name. */
  separator?: RegExp;
  /** Measured limits, or null to inherit the conservative engine defaults. */
  gaze?: Partial<GazeLimits> | null;
  /** Names for canonical slots the engine's own candidate lists do not resolve. */
  shapes?: ShapeOverrides;
  presets?: PresetSpec | null;
  /**
   * Emotion composition in this avatar's own shape names, for avatars without
   * ARKit.
   *
   * `null` is accepted and means the same as absent — an avatar that implements
   * neither channel still reports the ARKit gap through `Profile.missing`,
   * because it genuinely has no way to compose an expression. Writing the `null`
   * is a note to the next reader that the model was looked at, not a flag the
   * runtime branches on.
   */
  emotionShapes?: Partial<Record<EmotionName, ShapeWeights>> | null;
  /** Which of those shapes the mouth layer owns while speaking. */
  mouthShapePattern?: RegExp | null;
  overlays?: DrawnShapeSpec | null;
  materials?: MaterialRules;
  wardrobe?: WardrobeTable;
  sway?: SwaySpec;
  drive?: { tail?: TailDrive };
  /** Demo turns, played by the viewer's script button. */
  script?: TurnRequest[];
  /** For an avatar that is deliberately not human. */
  anatomy?: JointTable;
}

// --- session ----------------------------------------------------------------

/**
 * One turn: a line of dialogue delivered with a face and a gesture.
 *
 * Everything optional applies for the duration of the turn — except the
 * emotion, which persists, because a mood does not end with the sentence.
 */
export interface TurnRequest {
  id?: string;
  text?: string;
  emotion?: EmotionVector | null;
  expression?: string | null;
  gesture?: string | null;
  /** Keep the drawn face up after the line ends. Off by default: held past its
   *  line a drawn face stops reading as a reaction and starts reading as a mask. */
  hold?: boolean;
}

export interface Turn extends TurnRequest {
  id: string;
  text: string;
}

export type SessionEventType =
  | 'turn.queued'
  | 'turn.start'
  | 'turn.end'
  | 'turn.interrupted'
  | 'queue.dropped'
  | 'queue.empty';

export interface SessionEvent {
  type: SessionEventType;
  turn?: string;
  turns?: string[];
  queued?: number;
  seconds?: number;
  /** Stamped by the server, not by the engine. */
  seq?: number;
  at?: number;
}

/** Everything an orchestrator might branch on, cheap enough to poll. */
export interface SessionState {
  speaking: boolean;
  turn: string | null;
  queued: number;
  busy: boolean;
  idle: boolean;
  idleEnabled: boolean;
  emotion: EmotionVector;
  expression: string | null;
  pickedExpression: string | null;
  overlays: Record<string, number>;
  gesture: string | null;
  /** Joint strain from the last fingertip solve, per arm. */
  strain: Record<Side, number>;
  lookAt: number;
  wardrobe: Record<string, string | null> | null;
}

export interface LabelledId {
  id: string;
  label: string;
}

/**
 * What this avatar can be asked to do.
 *
 * Discovered, not declared: the expression list comes from the avatar's own
 * shape groups and the wardrobe from its meshes, so swapping the avatar changes
 * what the orchestrator is offered.
 */
export interface Vocabulary {
  avatar: { id: string | null; label: string | null };
  emotions: LabelledId[];
  expressions: LabelledId[];
  overlays: LabelledId[];
  gestures: Array<LabelledId & { group: GestureGroup; sustain: boolean }>;
  cameras: CameraFrame[];
  /**
   * Continuous, so it is stated as ranges rather than as a list of ids.
   *
   * **These bounds are DEGREES**, like the control API and the CLI — unlike
   * `PointSpec` above, which is the engine-internal radian form. The conversion
   * happens once, in the motion layer's `point()`.
   */
  pointing: {
    side: Side[];
    azimuth: [number, number];
    elevation: [number, number];
    extent: [number, number];
    finger: FingerName[];
    note: string;
  };
  wardrobe: Record<string, { label: string; items: LabelledId[] }>;
  wardrobePresets: LabelledId[];
}
