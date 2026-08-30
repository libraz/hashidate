import type { Localized } from '../../i18n/locale';
import type { JointTable } from './anatomy';
import type { EmotionName, ShapeWeights, Vec3Tuple, VisemeName } from './primitives';
import type { GazeLimits } from './profile';
import type { TurnRequest } from './turn';

/**
 * One model's own data, and the pieces `AvatarDescriptor` is assembled from:
 * which shapes the author drew, what the character can wear, and what swings.
 *
 * Everything here is stated per avatar and read by `profile/`. Nothing in it
 * describes the runtime.
 */

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
  /**
   * Faces the idle autopilot may not reach for on its own.
   *
   * Distinct from `exclude`, and the difference is the whole point: an excluded
   * shape is not an expression at all and leaves the vocabulary entirely, while
   * these are perfectly good drawings that simply must not arrive unasked. A
   * sleeping face is the clearest case — it is worth having for the moment
   * somebody asks for it by name, and it is not something the character should
   * drift into while waiting for the next turn.
   *
   * So they stay in the list, stay reachable by `setExpression` and by a script
   * cue, and are only kept out of the pool the autopilot picks from.
   */
  idleExclude?: string[];
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
