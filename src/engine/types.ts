import type * as THREE from 'three';
import type { Localized } from '../i18n/locale';

/**
 * Shared vocabulary for the runtime.
 *
 * Every layer below the director speaks in *canonical slots* — "upperArm.L",
 * viseme "a", emotion "joy" — and the profile resolves those against whatever
 * one particular avatar happens to call things. This file is that vocabulary,
 * plus the shape of the two objects the layers hand each other: the avatar
 * descriptor going in, and the resolved profile coming out.
 *
 * Nothing here imports from anywhere but three and the `Localized` type, which
 * is what every display string in the vocabulary is. It is the one module every
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
  label: Localized;
  free: [number, number];
  max: [number, number];
}

/** Shoulder elevation ceiling samples: `[planeDegrees, freeDegrees, maxDegrees]`. */
export type ElevationRow = [number, number, number];

export interface JointSpec {
  label: Localized;
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
  label: Localized;
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

/**
 * How the performance table is filed. It mirrors the gesture groups, plus
 * `mood` for the entries that are a face and nothing else — which the gesture
 * table has no way to express and which are most of what an idle character does.
 */
export type PerformanceGroup =
  | 'mood'
  | 'reaction'
  | 'greeting'
  | 'explain'
  | 'emote'
  | 'cute'
  | 'pose';

export interface GestureDef {
  label: Localized;
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
  /**
   * Tidy up a shape name for display — strip the author's prefix, swap the
   * underscores. Plain string in and out, because what comes back is still the
   * author's own name for a drawing and reads the same in either language; the
   * caller wraps the result with `same()` on the way into the vocabulary.
   */
  label?: (id: string) => string;
}

/** Finished whole-face drawings, plus which canonical emotion reaches each. */
export interface PresetSpec extends DrawnShapeSpec {
  emotion?: Partial<Record<EmotionName, string>>;
  /**
   * The group holding the author's parking shapes — the `*Hide` family that
   * moves a part out of view rather than deforming it.
   *
   * Stated so the engine can measure which drawings fold one in and are
   * therefore whole or nothing; see `swap` in `face/presets.ts`. Naming the
   * group is all that is needed, because what each shape parks does not matter,
   * only that a drawing already contains the travel.
   */
  hideGroup?: string;
}

export interface MaterialRules {
  /** Genuinely flat pieces — hair cards, coats — that need both faces drawn. */
  doubleSided?: RegExp;
  /** Coplanar overlays on the face: lashes, brows, drawn effects. */
  faceDecal?: RegExp;
}

export interface WardrobeItem {
  id: string;
  label: Localized;
  meshes: string[];
  /** Shapes this item raises while worn — VRChat `*Hide`, or a `Shrink_*` family. */
  hide?: string[];
}

export interface WardrobeSlot {
  label: Localized;
  items: WardrobeItem[];
}

export interface WardrobePreset {
  label: Localized;
  set: Record<string, string | null>;
}

export interface WardrobeTable {
  slots: Record<string, WardrobeSlot>;
  presets?: Record<string, WardrobePreset>;
  /** Shown above the slots in the renderer's own wardrobe tab, so both languages. */
  note?: Localized;
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
  /** Shown in the renderer's own tuning readout, so both languages. */
  label?: Localized;
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
  label: Localized;
  author?: Localized;
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
 * Where a line is delivered: the framing, the set and the acoustic.
 *
 * The three staging axes `Session` already exposes as their own calls, gathered
 * so a turn can carry them. They behave here exactly as they do there — each is
 * a pass-through to whatever the renderer supplied, each persists after the
 * turn, and an axis left out is an axis left alone. `null` is not "left out":
 * it is the empty value that axis has, dry for a room and flat for a backdrop.
 */
export interface Staging {
  camera?: CameraFrame;
  backdrop?: string | null;
  room?: string | null;
  /**
   * Which document is up. Usually set once at the top of a segment rather than
   * per line, but it is here for the run that moves between two of them.
   */
  deck?: string | null;
  /**
   * Which page of it, 1 based. **Absolute, and there is deliberately no
   * relative form here.** A queued line may be dropped, reordered or sent round
   * again, and a "next page" written into one of those means a different page
   * every time the script is touched — the whole deck slips by one and nothing
   * says why. An operator turning a page live is reacting and says `by`; a
   * script describing a line it has not reached yet knows the number.
   *
   * No null, unlike the two axes above: a page has no empty value. Taking the
   * document away is `deck: null`.
   */
  slide?: number;
  /**
   * Where the two layers sit in the broadcast frame, as `place` states it.
   *
   * Here because a document and a layout are one decision made at one moment: a
   * deck that fills the frame wants the character small in a corner, and the
   * line that puts the deck up is the line that wants her moved. Sent as a
   * separate command it lands at some other time, and the frame is briefly
   * wrong in the most visible way there is — two things on top of each other.
   *
   * A partial merge, like the command it mirrors, and persistent like every
   * other axis on this interface: absent means "leave it", never "reset it", so
   * the line that takes the deck down is the line that says where she stands
   * without one.
   */
  place?: { avatar?: Placement; slide?: SlidePlacement };
}

/**
 * Where the camera stands: a named framing, and how far it has been moved off it.
 *
 * ## Why the framing is not enough on its own
 *
 * The four framings answer "how much of the character is in shot" and are the
 * right unit for a script: a line is delivered in a bust shot, and what that
 * means in metres is the renderer's problem and differs per avatar. What they
 * cannot say is "from slightly to the left, a little closer" — which is most of
 * what an operator does to a shot while watching it, and all of what a drag on
 * a preview produces.
 *
 * ## Relative, so it survives a swap
 *
 * The offsets are stated against the framing rather than in world space. An
 * absolute camera position measured on one avatar puts the next one's head out
 * of frame, because the two differ in height and in where the bones sit; a
 * quarter-turn and a 1.3× dolly mean the same thing on both.
 *
 * Every field is optional and an absent one is left where it was, so a drag
 * sends two numbers and a framing change sends one.
 */
export interface Shot {
  frame?: CameraFrame;
  /** Degrees around the framing's target. 0 is straight on, positive to the right. */
  yaw?: number;
  /** Degrees above it. 0 is level with the framing, positive looking down. */
  pitch?: number;
  /** Multiplier on the framing's distance. 1 is the framing, higher is closer. */
  zoom?: number;
}

/**
 * How far a shot may travel, in the same units `Shot` states.
 *
 * Read by the wire schema, which refuses a value outside them, and by the
 * renderer, which stops the pointer at them. Both, and from one place: a drag
 * that could push the camera past what the schema accepts would produce a
 * command that is silently dropped, and the picture being dragged would be the
 * only one that moved.
 *
 * A guard rather than a taste. At the pole there is no bearing left to speak
 * of, and a zoom outside these puts the camera inside the character's head or
 * far enough away that there is nothing to see.
 */
export const SHOT_LIMITS = {
  yaw: { min: -180, max: 180 },
  pitch: { min: -85, max: 85 },
  zoom: { min: 0.25, max: 4 },
} as const;

/** Where in the output frame a layer sits. Nine positions, as a grid. */
export type Anchor =
  | 'center'
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';

/**
 * A rectangle of the output frame, as a layer occupies it.
 *
 * ## Not the same question as `Shot`, and joining them would be wrong
 *
 * A shot is where the camera stands: a bearing and a distance in the world the
 * character is in. This is where the resulting *picture* is put in the frame
 * that goes to air. Both change how big the character looks and that is the
 * whole of what they have in common — a document behind the character has a
 * placement and no shot at all, and moving the camera to make room for one
 * would mean re-framing every line of a segment.
 *
 * ## Two fractions rather than a size and an aspect
 *
 * `width` and `height` are independent fractions of the stage. Stating it as
 * one size plus an aspect reads better and has a hole in it: at full size there
 * is no aspect to apply — the layer is the frame — so the aspect would have to
 * be ignored at exactly one value and honoured everywhere else, and a slider
 * dragged down from 1 would jump the moment it left the top. A surface that
 * wants one knob moves both from one, which is a surface's business.
 *
 * ## The rectangle is an area, and it does not decide the shot
 *
 * A framing is stated as a world-space top and bottom edge, so pointing it at a
 * rectangle of some other shape has to give something up — and both obvious
 * answers are wrong. Filling the rectangle keeps the vertical and cuts the arms
 * off both sides, which is where a raised hand and most of the hair are.
 * Standing the camera back until the width fits crops nothing and grows the
 * vertical by the same factor, so an upper-body shot quietly becomes a
 * full-body one.
 *
 * So the renderer draws the *frame's own shape*, scaled to fit inside whatever
 * area this names: the picture the whole frame would have shown, smaller and
 * off to one side. Nothing is cropped, nothing is reframed, and a framing goes
 * on meaning exactly what it says. What the area does not cover is left
 * transparent, so what shows through it is the document.
 *
 * What lands on the anchor is the **character**, not that picture. A framing is
 * a wide picture with a narrow figure in the middle of it, so putting the
 * picture's edge on the frame's edge leaves the character a quarter of a frame
 * short of it, in front of a large piece of nothing. The empty side is pushed
 * out past the edge instead and clipped there, which is what an overlay hanging
 * off the side of a shot looks like anyway.
 *
 * A consequence worth knowing: only the tighter of the two fractions decides
 * anything for the character, and at `1` there is nowhere for an anchor to move
 * to. The document is the layer the pair is really for — see `fit`.
 */
export interface Placement {
  anchor?: Anchor;
  /** Fraction of the stage width. 1 is the full frame. */
  width?: number;
  /** Fraction of the stage height. */
  height?: number;
  /**
   * Gap from the edges the anchor pulls the layer to, as a fraction of the
   * stage **height** on both axes — a margin measured per axis on a 16:9 frame
   * puts a wider gap at the side than at the bottom for the same number, and
   * the two are read as one inset by everyone who looks at them.
   *
   * Nothing for a centred layer, which touches no edge.
   */
  margin?: number;
}

/** A `Placement` with the one extra question a picture asks: how it fills it. */
export interface SlidePlacement extends Placement {
  /** `contain` shows the whole page and letterboxes; `cover` fills and crops. */
  fit?: 'contain' | 'cover';
}

/**
 * How far a placement may go, in the same units it states.
 *
 * Read by the wire schema and by whatever draws it, from one place, for the
 * reason `SHOT_LIMITS` is. The floor is a guard rather than a taste: below a
 * tenth of the frame the character is a smudge and the layer is more likely to
 * be a typo in a query string than an instruction.
 */
export const PLACEMENT_LIMITS = {
  width: { min: 0.1, max: 1 },
  height: { min: 0.1, max: 1 },
  margin: { min: 0, max: 0.2 },
} as const;

/**
 * One turn: a line of dialogue delivered with a face and a gesture.
 *
 * Everything optional applies for the duration of the turn — except the
 * emotion, which persists, because a mood does not end with the sentence, and
 * the staging, which persists because a shot is not a property of a sentence.
 */
export interface TurnRequest {
  id?: string;
  /**
   * The line, with its cues in it.
   *
   * `[hello]こんばんは。[explain]今日はこの話をします。` — a bracketed id starts
   * that performance at the point it is written, which is the only way to place
   * one inside a sentence: a second turn would put a gap in the middle of a
   * clause, and a separate `perform` command cannot know when the first half
   * has been said.
   *
   * Brackets are reserved and are never spoken. See `cues.ts` — the guarantee
   * is structural, and it is the reason this field is parsed on the way into
   * the queue rather than on the way out of it.
   */
  text?: string;
  /**
   * How `text` is pronounced, in kana. Optional, and only worth supplying where
   * the writing is ambiguous.
   *
   * Japanese writing does not carry its own reading, and nothing downstream can
   * recover one: the mouth counts a kanji as two morae because most are, which
   * is a guess, and the speech model has no dictionary to consult — it reads
   * whatever its text encoder learned, with no way to correct it. So both the
   * viseme track and the voice are driven from this when it is given, and from
   * `text` when it is not.
   *
   * It is the same field for both on purpose. A reading supplied to fix "3件"
   * fixes the mouth as a side effect, and a caller that had to think about the
   * pronunciation once should not have to think about it again.
   *
   * It carries no cues. Those are positions in the line and belong with the
   * line; a reading is kana and a bracket in one is a mistake, which the wire
   * format refuses rather than strips.
   */
  reading?: string;
  emotion?: EmotionVector | null;
  expression?: string | null;
  gesture?: string | null;
  /**
   * A named face-and-movement from the performance table, applied before the
   * three fields above so they can override parts of it. Released with the turn
   * unless `hold`; its mood persists either way.
   */
  perform?: string | null;
  /** Keep the drawn face up after the line ends. Off by default: held past its
   *  line a drawn face stops reading as a reaction and starts reading as a mask. */
  hold?: boolean;
  /**
   * The shot this line is delivered in, applied as the turn begins.
   *
   * Everything else here describes the character. This describes where they are
   * being seen and heard, and it is on a turn for one reason: timing. The
   * standalone calls take effect when they are made, which is what a caller
   * reacting to something wants and the opposite of what a caller writing a
   * script wants — a script knows its fourth line needs a wide shot long before
   * the first line has been said, and had no way to say so without waiting.
   *
   * Waiting is what this exists to avoid. A caller that sends one line and waits
   * for it pays the whole of the next line's synthesis as silence; sending the
   * run at once hides it behind playback. See `Staging` for the field itself.
   */
  stage?: Staging;
}

/**
 * One performance change lifted out of a line, and where in it that happens.
 *
 * The grammar and the guarantee that goes with it are in `cues.ts`; this is
 * only the shape the rest of the engine sees.
 */
export interface Cue {
  /**
   * The performance to start — a plain string, like the `perform` field this is
   * the inline form of. An id the table does not have is dropped where the
   * table is known, which is the session.
   */
  perform: string;
  /**
   * Where it lands, as a fraction of the line: 0 at the first mora, 1 at the
   * last.
   *
   * A fraction and not a time, because the line is not necessarily as long as
   * the estimate it was measured against. A supplied `reading` is a different
   * string of a different length, and TTS audio is a different length again;
   * the fraction survives both, and a time in seconds would be wrong the moment
   * the utterance was not exactly as long as guessed.
   */
  at: number;
}

/**
 * One synthesised line, ready to play.
 *
 * Stated here and implemented in the viewer, which is the only layer that has
 * an `AudioContext` to implement it with. The engine holds the shape so that
 * the turn queue can wait for one, stretch a track onto its length and read its
 * envelope, without importing a browser.
 */
export interface Take {
  /**
   * How long the audio actually is. Measured off the decoded buffer rather than
   * taken from whatever the synthesiser claimed — the buffer is the thing that
   * will be played, and it is the only number both sides can agree on.
   */
  seconds: number;
  /**
   * Seconds since `play`, on the audio device's own clock rather than the
   * frame's.
   *
   * Keeps counting past `seconds` once the audio has finished, and has to: the
   * mouth decides it has stopped speaking by the clock running past the end of
   * its track, so a clock that stopped at the last mora would leave the turn
   * open for good.
   */
  readonly elapsed: number;
  /** How loud it is right now, 0..1, normalised against this take's own peak. */
  readonly amplitude: number;
  play(): void;
  stop(): void;
}

/**
 * How the voice is processed on its way out, as the engine passes it along.
 *
 * `dsp` is deliberately opaque here. What a voice chain *is* — which processors,
 * in what order, with what parameters — belongs to whatever implements `Voice`,
 * on exactly the footing rooms and the wardrobe are already on: the engine names
 * the thing and does not describe it. The real shape is stated once, in the
 * protocol layer, and once more in the renderer that applies it.
 */
export interface VoiceChainRequest {
  /** Base preset id. `null` bypasses the chain; absent keeps the current base. */
  preset?: string | null;
  /** Overrides applied on top of the base. */
  dsp?: Record<string, unknown>;
}

/**
 * What the voice can say about itself, for a control surface to display.
 *
 * The resolved configuration comes back rather than being assumed by whoever
 * sent it, for the same reason `SessionState` is reported rather than inferred
 * from the last command: a panel that draws its own sliders from what it last
 * sent will keep drawing them after the renderer has refused, reloaded or
 * resolved a preset differently.
 */
export interface VoiceReport {
  /** The base preset in use, or null when the chain is bypassed. */
  preset: string | null;
  /** The complete resolved configuration, or null when nothing is applied. */
  dsp: Record<string, unknown> | null;
  /** The acoustic space, downstream of the chain. */
  room: string | null;
  /** Integrated loudness of the last take, LUFS. Null before anything is spoken. */
  lufs: number | null;
  /** True peak of the last take, dBTP. */
  truePeakDb: number | null;
  /**
   * Whether the renderer is being refused an audio device.
   *
   * A browser will not start one until the page it is on has been interacted
   * with, so a viewer nobody has clicked plays every line silently. Nothing an
   * orchestrator sends can clear it — the fix is a person touching that page —
   * which is exactly why it is reported: from anywhere else the failure looks
   * the same as a speech sidecar that is not running.
   */
  blocked: boolean;
}

/**
 * What the character is seen in front of.
 *
 * The visual counterpart to the `rooms` on `Voice`, and on exactly the same
 * footing: the engine knows that backdrops have ids and labels and knows
 * nothing whatever about what one is. A backdrop is geometry, lighting and
 * tone mapping, all of which belong to the renderer — the engine's business is
 * the character, and a `Scenery` that was any more specific than this would be
 * the engine holding an opinion about a wall.
 *
 * Absent on a renderer that has no backdrops, which is the same shape as a
 * renderer with no voice: `backdrop` then does nothing, and the empty list in
 * the vocabulary is how a caller can tell without sending one and watching.
 */
export interface Scenery {
  /** The rooms this renderer can show. Ids and labels only. */
  readonly backdrops: LabelledId[];
  /** Show one of them, or null for the flat background. Unknown ids are null. */
  setBackdrop(id: string | null): void;
}

/**
 * The document the character is presenting from.
 *
 * On the same footing as `Scenery`: the engine knows that a document has an id
 * and pages, and knows nothing at all about what one is. A page is an image on
 * a layer somewhere behind the character, and everything about how it gets
 * there — reading a file, rasterising it, deciding how sharp it needs to be —
 * belongs to the renderer.
 *
 * **There is no list here, unlike `Scenery.backdrops`.** What backdrops exist
 * is renderer data, decided in the source it ships with. What documents exist
 * is whatever the operator dropped in a directory five minutes ago, which only
 * the process with a filesystem can answer — so the roster comes back from the
 * control server, and this port is asked to show one rather than to enumerate
 * them. A renderer handed an id it cannot open says so in its report and keeps
 * drawing, because a broken file is not a reason for a stream to stop.
 *
 * Absent on a renderer with no document layer at all, which is every test.
 */
export interface Slides {
  /**
   * Put a document up, or take the one that is up down.
   *
   * `page` is where to open it. Absent is the first page — not "keep the page
   * we were on", which would be a page number from another document.
   */
  setDeck(id: string | null, page?: number): void;
  /** Go to a page, 1 based. Past either end is clamped, not an error. */
  setSlide(page: number): void;
  /**
   * Move by a number of pages. Its own call rather than a signed `setSlide`,
   * because "the next one" is not a page number — the caller that says it does
   * not know which page is up, and one that did would say so.
   */
  turnSlide(by: number): void;
  /** What is actually on screen, which is not always what was asked for. */
  report(): SlideReport;
}

/**
 * What the document layer is doing, so a control surface can draw it.
 *
 * Reported for the reason `VoiceReport` is: the answer is only known where the
 * work happens. How many pages a document has is discovered by opening it, and
 * a panel that counted on the number it was told would be showing `4 / 0` until
 * somebody turned a page.
 */
export interface SlideReport {
  /** What was asked for, null when nothing is up. */
  deck: string | null;
  /** The page showing, 1 based. 0 when there is no document. */
  page: number;
  /** How many it has. 0 until it is open. */
  pages: number;
  /** Whether the page showing is the page asked for. False while one is drawn. */
  ready: boolean;
  /** Why a document is not up, for the operator. Null when nothing is wrong. */
  error: string | null;
}

/**
 * How the frame is laid out right now, so a control surface can draw it.
 *
 * Reported for the reason `VoiceReport` and `SlideReport` are: a panel that
 * draws its sliders from what it last sent is wrong from the moment it opens,
 * because a source opened on `?place=bottom-right:0.32x0.6` was never told to
 * be there by anything the panel saw — and it is wrong again after every
 * `place` an orchestrator sends.
 *
 * Both halves are **resolved**, never partial. What is in force is the whole
 * question here; a partial answer would be the last patch somebody sent, which
 * is exactly what the surface asking cannot rely on.
 */
export interface PlacementReport {
  avatar: Required<Placement>;
  slide: Required<SlidePlacement>;
}

/**
 * How the output frame is laid out: where the character is in it, and where the
 * document behind them sits.
 *
 * A renderer's question rather than a performance's, which is why it is a port
 * of its own beside `Shading` instead of a field on anything the director
 * holds. The character does not move — the picture of them is put somewhere
 * else in the frame — and the difference matters the moment a gesture is
 * authored against a framing: it still plays exactly as it did.
 *
 * Both halves are partials that land on top of what is already set, on the same
 * rule as a tuning patch: a surface with one slider under the pointer sends one
 * number, and absent means "leave it" rather than "reset it".
 */
export interface Composition {
  setPlacement(placement: { avatar?: Placement; slide?: SlidePlacement }): void;
  /** What the merging produced, and what is actually being drawn. */
  report(): PlacementReport;
}

/**
 * How the avatar's own materials are drawn.
 *
 * One switch, and it is here rather than on the director because the answer is
 * a renderer's: toon shading is a material graph over the meshes a GLB loader
 * built, and the engine has no meshes — it has a rig and a face. Absent on a
 * renderer that draws only one way, which is every test.
 *
 * It exists at all because the fallback is worth being able to see. Turning it
 * off gives the materials the file arrived with, which is how a model that
 * looks wrong is told apart from a shader that is wrong about it.
 */
export interface Shading {
  readonly toon: boolean;
  setToon(on: boolean): void;
}

/**
 * Where a line goes to be spoken.
 *
 * One method, and it is deliberately the *whole* line at once rather than a
 * stream: the speech model does not stream, and being handed the finished take
 * before the turn opens is what lets everything else be planned against a known
 * length instead of corrected mid-sentence.
 */
export interface Voice {
  /**
   * Synthesise a line, or answer null when there is nothing to synthesise it
   * with — no sidecar running, a request that failed, audio the browser will
   * not let us start yet. Null is a normal answer and means "play it silently",
   * not an error: the renderer has to work on a machine that does not have the
   * voice.
   */
  prepare(text: string, reading?: string): Promise<Take | null>;
  /**
   * The acoustic spaces this voice can be heard in, for the vocabulary.
   *
   * Ids and labels only. What a room *is* — its size, its walls, how much of it
   * is in the mix — belongs to whatever implements this, on the same footing as
   * the wardrobe: the engine names the thing and does not describe it.
   */
  readonly rooms: LabelledId[];
  /** Put the voice in one of them, or null for none. An unknown id is none. */
  setRoom(id: string | null): void;
  /**
   * The voice chains this voice can be put through, for the vocabulary. Ids and
   * labels only, on the same footing as `rooms`.
   */
  readonly presets: LabelledId[];
  /**
   * Set the chain. Applies from the next line synthesised: a take already made
   * was made with the chain that was up at the time, and re-making the queue on
   * every parameter change would send all of it back to the synthesiser.
   */
  setChain(request: VoiceChainRequest): void;
  /** What is currently applied, and what the last take measured. */
  report(): VoiceReport;
}

/**
 * A queued turn: a request with its id minted and its line already parsed.
 *
 * `text` here is what is *said* — the markup came out in `Session.say`, and
 * nothing downstream of the queue has to know that there was any.
 */
export interface Turn extends TurnRequest {
  id: string;
  text: string;
  cues: Cue[];
  /**
   * The audio for this line. Three states and each means something different:
   *
   * - **absent** — the voice has not answered yet, and the turn waits.
   * - **null** — there will be no audio, and the turn plays on the estimate.
   * - **a take** — ready, and the turn will run on its clock.
   *
   * Synthesis starts when the turn is *queued*, not when it is played, so a
   * caller that sends three lines in one batch has all three being made while
   * the first is still being said. The wait is therefore paid once, at the top
   * of a run, rather than between every line.
   */
  take?: Take | null;
}

export type SessionEventType =
  | 'turn.queued'
  | 'turn.start'
  | 'turn.end'
  | 'turn.interrupted'
  | 'queue.dropped'
  | 'queue.replaced'
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
  /** The performance showing, or null. Cleared as soon as one is released. */
  performance: string | null;
  gesture: string | null;
  /** Whether a run of hops is in flight. */
  hopping: boolean;
  /** Joint strain from the last fingertip solve, per arm. */
  strain: Record<Side, number>;
  lookAt: number;
  wardrobe: Record<string, string | null> | null;
}

/**
 * An id, and what to call it on screen.
 *
 * The label is both languages at once rather than one of them. Whoever renders
 * it picks — see `src/i18n/locale.ts` — because the surfaces that draw these
 * lists learn the vocabulary from the control server rather than from the avatar
 * tables, and the server has no way to know which language is being read.
 */
export interface LabelledId {
  id: string;
  label: Localized;
}

/**
 * What this avatar can be asked to do.
 *
 * Discovered, not declared: the expression list comes from the avatar's own
 * shape groups and the wardrobe from its meshes, so swapping the avatar changes
 * what the orchestrator is offered.
 */
export interface Vocabulary {
  avatar: { id: string | null; label: Localized | null };
  emotions: LabelledId[];
  expressions: LabelledId[];
  overlays: LabelledId[];
  /**
   * Faces and movements named together, and the list to reach for first: the
   * two below are the parts a performance is assembled from, and are here for a
   * caller that wants something the table has no name for.
   *
   * `emotion` is echoed so a caller can see what a performance will do to the
   * mood without having to play it — the mood is the one thing that persists
   * after the performance ends.
   */
  performances: Array<
    LabelledId & {
      group: PerformanceGroup;
      emotion: EmotionVector;
      gesture: string | null;
      hop: string | null;
      /** Held until something replaces it, rather than running out on its own. */
      sustain: boolean;
    }
  >;
  gestures: Array<LabelledId & { group: GestureGroup; sustain: boolean }>;
  hops: LabelledId[];
  /**
   * How to put a performance inside a line rather than at the start of one.
   *
   * Stated rather than discovered, like `pointing.note` below — but it belongs
   * here for the same reason everything else does: this object is what gets
   * pasted into a system prompt, and a syntax the caller is never told about is
   * a syntax nobody uses.
   */
  cue: { syntax: string; note: Localized };
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
    note: Localized;
  };
  wardrobe: Record<string, { label: Localized; items: LabelledId[] }>;
  wardrobePresets: LabelledId[];
  /**
   * Where the voice is heard. Empty on a renderer with no voice at all, which
   * is also the case where `room` does nothing — so a caller can tell the two
   * apart from the vocabulary rather than by sending one and watching.
   */
  rooms: LabelledId[];
  /**
   * Where the character is seen. Empty on a renderer that has no backdrops,
   * which is also the case where `backdrop` does nothing — the same tell the
   * rooms above give.
   *
   * Separate from `rooms` because they are separate axes: one is the set, the
   * other is the acoustic, and a stream changes them at different moments and
   * for different reasons.
   */
  backdrops: LabelledId[];
  /**
   * The named voice chains, on the same footing as the rooms above: what a
   * chain *does* is renderer data, and the wire carries only what it is called.
   */
  voicePresets: LabelledId[];
}
