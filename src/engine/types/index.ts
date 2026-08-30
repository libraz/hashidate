/**
 * Shared vocabulary for the runtime.
 *
 * Every layer below the director speaks in *canonical slots* — "upperArm.L",
 * viseme "a", emotion "joy" — and the profile resolves those against whatever
 * one particular avatar happens to call things. This directory is that
 * vocabulary, plus the shape of the two objects the layers hand each other: the
 * avatar descriptor going in, and the resolved profile coming out.
 *
 * Nothing here imports from anywhere but three, the `Localized` type — which is
 * what every display string in the vocabulary is — and the cue action the
 * protocol layer names. It is the one module every other one is allowed to
 * depend on, and this barrel is how they depend on it: import `engine/types`,
 * never a file inside it, so that regrouping these declarations stays a matter
 * of taste rather than a rename across the tree.
 *
 * The split is by *what a declaration describes*:
 *
 * - `primitives` — the slots and scalars everything else is spelled in
 * - `anatomy`    — the body being depicted, the same for every humanoid
 * - `profile`    — one avatar resolved against those canonical slots
 * - `avatar`     — what an avatar states about itself, before it is resolved
 * - `pose`       — what one frame of movement asks for
 * - `staging`    — where a line is delivered and how the frame is laid out
 * - `turn`       — a line of dialogue, from request to queued object
 * - `voice`      — what the voice is asked for and reports back
 * - `ports`      — the seams a renderer implements
 * - `session`    — what the session tells the outside world
 */

export type {
  ElevationRow,
  JointDof,
  JointReading,
  JointSpec,
  JointTable,
  StrainZone,
} from './anatomy';
export type {
  AvatarDescriptor,
  ColliderSpec,
  DrawnShapeSpec,
  MaterialRules,
  PresetSpec,
  ShapeOverrides,
  SwayGroupSpec,
  SwaySpec,
  TailDrive,
  WardrobeItem,
  WardrobePreset,
  WardrobeSlot,
  WardrobeTable,
} from './avatar';
export type {
  Composition,
  Scenery,
  Shading,
  Slides,
  Voice,
} from './ports';
export type {
  AnchorSpace,
  ArmDirections,
  FingerSpec,
  GestureDef,
  GestureGroup,
  GestureVariation,
  PerformanceGroup,
  PointSpec,
  Pose,
  ReachSpec,
  SpineOffsets,
} from './pose';
export type {
  ArmBoneSlot,
  ArmSlot,
  BoneSlot,
  CameraFrame,
  EmotionName,
  EmotionVector,
  EyeSlot,
  FingerKey,
  FingerName,
  LabelledId,
  ShapeWeights,
  Side,
  SpineSlot,
  Vec3Tuple,
  VisemeName,
  VrmEmotionName,
} from './primitives';
export type {
  ArkitSupport,
  BlinkShapes,
  BodyFrame,
  FaceFrame,
  GazeLimits,
  MorphTarget,
  Profile,
} from './profile';
export type {
  SessionEvent,
  SessionEventType,
  SessionState,
  Vocabulary,
} from './session';
export type {
  Anchor,
  Placement,
  PlacementReport,
  Shot,
  SlidePlacement,
  SlideReport,
  Staging,
} from './staging';
export { PLACEMENT_LIMITS, SHOT_LIMITS } from './staging';
export type { Cue, Take, Turn, TurnRequest } from './turn';
export type { VoiceChainRequest, VoiceReport } from './voice';
