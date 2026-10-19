import { z } from 'zod';
import type {
  ArmSlot,
  AvatarDescriptor,
  ColliderSpec,
  DrawnShapeSpec,
  EmotionName,
  GazeLimits,
  JointDof,
  JointSpec,
  JointTable,
  MaterialRules,
  PbrScalarOverride,
  PresetCompositionSpec,
  PresetSpec,
  ShapeOverrides,
  ShapeWeights,
  SkinPointAnchorInfluenceSpec,
  SkinPointAnchorMetadataSpec,
  SkinPointAnchorSpec,
  SwayGroupSpec,
  SwaySpec,
  TailDrive,
  Vec3Tuple,
  WardrobeItem,
  WardrobePreset,
  WardrobeSlot,
  WardrobeTable,
} from '../engine/types';
import { emotionNameSchema, turnSchema } from './commands';
import type { Equals, Expect, Simplify } from './commands/guards';
import {
  armSlotSchema,
  localizedSchema,
  vec3Schema,
  visemeNameSchema,
} from './messages/primitives';
import { describeIssues } from './motions';

/**
 * An avatar the operator described, on its way from the control server to the
 * renderer.
 *
 * The file is JSON (or YAML) and the engine's descriptor holds six RegExp fields
 * and two functions, so this schema is the engine type minus everything JSON
 * cannot say, plus the two closed forms that stand in for it: a pattern object
 * and a label rule. The server validates a file with it and serves the raw
 * object; the renderer parses it again to get the compiled descriptor.
 *
 * What each field means is in `src/engine/types/avatar.ts`. This file only says
 * what is well formed.
 */

const finite = z.number().finite();
const names = z.array(z.string());

// --- the two forms that stand in for RegExp and function ---------------------

/** The longest pattern a file may state; no real shape-name match comes near it. */
const PATTERN_MAX_LENGTH = 1024;

const patternObject = z.strictObject({
  pattern: z.string(),
  ignoreCase: z.boolean().optional(),
});

function compilePattern(
  value: z.output<typeof patternObject>,
  ctx: z.core.$RefinementCtx,
): RegExp | null {
  const fail = (message: string): null => {
    ctx.issues.push({ code: 'custom', message, input: value, path: ['pattern'] });
    return null;
  };
  if (value.pattern.length === 0) return fail('a pattern may not be empty');
  if (value.pattern.length > PATTERN_MAX_LENGTH) {
    return fail(`a pattern may not be longer than ${PATTERN_MAX_LENGTH} characters`);
  }
  try {
    return new RegExp(value.pattern, value.ignoreCase ? 'i' : '');
  } catch (cause) {
    return fail(`not a valid regular expression: ${(cause as Error).message}`);
  }
}

/** `{ pattern, ignoreCase? }`, compiled. */
const patternSchema = patternObject.transform(
  (value, ctx) => compilePattern(value, ctx) ?? z.NEVER,
);

/** A pattern that names the group in its one capture group. */
const separatorSchema = patternObject.transform((value, ctx) => {
  const regexp = compilePattern(value, ctx);
  if (!regexp) return z.NEVER;
  // `|` adds an empty alternative, so the match against '' always succeeds and
  // its length is the group count plus one.
  const groups = (new RegExp(`${value.pattern}|`).exec('')?.length ?? 1) - 1;
  if (groups !== 1) {
    ctx.issues.push({
      code: 'custom',
      message: `a separator needs exactly one capture group, found ${groups}`,
      input: value,
      path: ['pattern'],
    });
    return z.NEVER;
  }
  return regexp;
});

/** `{ stripPrefix?, underscoresToSpaces? }`, compiled to the function the engine calls. */
const labelRuleSchema = z
  .strictObject({
    stripPrefix: z.string().optional(),
    underscoresToSpaces: z.boolean().optional(),
  })
  .transform((rule) => (id: string): string => {
    const stripped =
      rule.stripPrefix !== undefined && id.startsWith(rule.stripPrefix)
        ? id.slice(rule.stripPrefix.length)
        : id;
    return rule.underscoresToSpaces ? stripped.replaceAll('_', ' ') : stripped;
  });

// --- gaze, shapes, presets ----------------------------------------------------

const gazeSchema = z
  .strictObject({
    eyeYaw: finite,
    eyePitch: finite,
    headYaw: finite,
    headPitch: finite,
    neckYaw: finite,
    neckPitch: finite,
  })
  .partial();

type _GazeMatchesEngine = Expect<Equals<z.output<typeof gazeSchema>, Partial<GazeLimits>>>;

const shapeOverridesSchema = z.strictObject({
  blink: z
    .strictObject({ both: names.optional(), L: names.optional(), R: names.optional() })
    .optional(),
  viseme: z.partialRecord(visemeNameSchema, names).optional(),
});

type _ShapeOverridesMatchEngine = Expect<
  Equals<z.output<typeof shapeOverridesSchema>, ShapeOverrides>
>;

const drawnShapeFields = {
  group: z.string(),
  exclude: names.optional(),
  label: labelRuleSchema.optional(),
};

const presetCompositionSchema = z.strictObject({
  blink: z.literal('preserve').optional(),
  speechNeutralizer: z.string().optional(),
  speechNeutralizerEnvelope: z.literal('viseme-support').optional(),
});

type _PresetCompositionMatchesEngine = Expect<
  Equals<z.output<typeof presetCompositionSchema>, PresetCompositionSpec>
>;

const presetSchema = z.strictObject({
  ...drawnShapeFields,
  emotion: z.partialRecord(emotionNameSchema, z.string()).optional(),
  composition: z.record(z.string(), presetCompositionSchema).optional(),
  hideGroup: z.string().optional(),
  idleExclude: names.optional(),
});

const overlaysSchema = z.strictObject(drawnShapeFields);

type _DrawnShapeKeysMatchEngine = Expect<
  Equals<keyof z.output<typeof overlaysSchema>, keyof DrawnShapeSpec>
>;
type _PresetKeysMatchEngine = Expect<Equals<keyof z.output<typeof presetSchema>, keyof PresetSpec>>;

const emotionShapesSchema = z.partialRecord(emotionNameSchema, z.record(z.string(), finite));

type _EmotionShapesMatchEngine = Expect<
  Equals<z.output<typeof emotionShapesSchema>, Partial<Record<EmotionName, ShapeWeights>>>
>;

// --- materials ----------------------------------------------------------------

const pbrScalarSchema = z.strictObject({
  metalness: finite,
  roughness: finite,
  reflection: finite.optional(),
});

type _PbrScalarMatchesEngine = Expect<Equals<z.output<typeof pbrScalarSchema>, PbrScalarOverride>>;

const materialsSchema = z.strictObject({
  doubleSided: patternSchema.optional(),
  faceDecal: patternSchema.optional(),
  blendTransparent: patternSchema.optional(),
  preserveImported: patternSchema.optional(),
  preservedPbrOverrides: z.record(z.string(), pbrScalarSchema).optional(),
});

type _MaterialKeysMatchEngine = Expect<
  Equals<keyof z.output<typeof materialsSchema>, keyof MaterialRules>
>;

// --- wardrobe -----------------------------------------------------------------

const wardrobeItemSchema = z.strictObject({
  id: z.string(),
  label: localizedSchema,
  meshes: names,
  hide: names.optional(),
});

type _WardrobeItemMatchesEngine = Expect<Equals<z.output<typeof wardrobeItemSchema>, WardrobeItem>>;

const wardrobeSlotSchema = z.strictObject({
  label: localizedSchema,
  items: z.array(wardrobeItemSchema),
});

type _WardrobeSlotMatchesEngine = Expect<Equals<z.output<typeof wardrobeSlotSchema>, WardrobeSlot>>;

const wardrobePresetSchema = z.strictObject({
  label: localizedSchema,
  set: z.record(z.string(), z.string().nullable()),
});

type _WardrobePresetMatchesEngine = Expect<
  Equals<z.output<typeof wardrobePresetSchema>, WardrobePreset>
>;

const wardrobeSchema = z.strictObject({
  slots: z.record(z.string(), wardrobeSlotSchema),
  presets: z.record(z.string(), wardrobePresetSchema).optional(),
  note: localizedSchema.optional(),
});

type _WardrobeMatchesEngine = Expect<Equals<z.output<typeof wardrobeSchema>, WardrobeTable>>;

// --- sway and drive -----------------------------------------------------------

const colliderSchema = z.strictObject({
  bone: z.string(),
  offset: vec3Schema.optional(),
  tail: vec3Schema.optional(),
  radius: finite.optional(),
  inside: z.boolean().optional(),
});

type _ColliderMatchesEngine = Expect<Equals<z.output<typeof colliderSchema>, ColliderSpec>>;

const anchorInfluenceSchema = z.strictObject({
  bone: z.string(),
  weight: finite,
  position: vec3Schema,
});

type _AnchorInfluenceMatchesEngine = Expect<
  Equals<z.output<typeof anchorInfluenceSchema>, SkinPointAnchorInfluenceSpec>
>;

const anchorSpecSchema = z.strictObject({ influences: z.array(anchorInfluenceSchema) });

type _AnchorSpecMatchesEngine = Expect<
  Equals<z.output<typeof anchorSpecSchema>, SkinPointAnchorSpec>
>;

const anchorMetadataSchema = z.strictObject({ source: z.literal('bone-metadata') });

type _AnchorMetadataMatchesEngine = Expect<
  Equals<z.output<typeof anchorMetadataSchema>, SkinPointAnchorMetadataSpec>
>;

const swayGroupSchema = z.strictObject({
  id: z.string(),
  label: localizedSchema.optional(),
  stiffness: finite.optional(),
  drag: finite.optional(),
  gravity: finite.optional(),
  gravityDir: vec3Schema.optional(),
  radius: finite.optional(),
  roots: names.optional(),
  childrenOf: names.optional(),
  colliders: names.optional(),
  anchor: z.union([anchorSpecSchema, anchorMetadataSchema]).optional(),
});

type _SwayGroupMatchesEngine = Expect<Equals<z.output<typeof swayGroupSchema>, SwayGroupSpec>>;

const swaySchema = z.strictObject({
  colliders: z.record(z.string(), z.array(colliderSchema)).optional(),
  groups: z.array(swayGroupSchema),
});

type _SwayMatchesEngine = Expect<Equals<z.output<typeof swaySchema>, SwaySpec>>;

const tailDriveSchema = z.strictObject({
  group: z.string().optional(),
  swing: finite.optional(),
  lift: finite.optional(),
  rest: finite.optional(),
});

type _TailDriveMatchesEngine = Expect<Equals<z.output<typeof tailDriveSchema>, TailDrive>>;

// --- anatomy ------------------------------------------------------------------

const range = z.tuple([finite, finite]);

const jointDofSchema = z.strictObject({ label: localizedSchema, free: range, max: range });

type _JointDofMatchesEngine = Expect<Equals<z.output<typeof jointDofSchema>, JointDof>>;

const elevationRow = z.tuple([finite, finite, finite]);

const jointFields = {
  label: localizedSchema,
  dofs: z.record(z.string(), jointDofSchema),
};

const jointSchema = z.strictObject({ ...jointFields, elevation: z.array(elevationRow).optional() });

type _JointMatchesEngine = Expect<Equals<z.output<typeof jointSchema>, JointSpec>>;

const jointTableSchema = z.strictObject({
  shoulder: z.strictObject({ ...jointFields, elevation: z.array(elevationRow) }),
  elbow: jointSchema,
  wrist: jointSchema,
  finger: jointSchema,
  thumb: jointSchema,
  neck: jointSchema,
  spine: jointSchema,
});

// The shoulder is an intersection on the engine side and a flat object here.
type SimplifyMembers<T> = { [K in keyof T]: Simplify<T[K]> };
type _JointTableMatchesEngine = Expect<
  Equals<SimplifyMembers<z.output<typeof jointTableSchema>>, SimplifyMembers<JointTable>>
>;

const armRestSchema = z.partialRecord(armSlotSchema, vec3Schema);

type _ArmRestMatchesEngine = Expect<
  Equals<z.output<typeof armRestSchema>, Partial<Record<ArmSlot, Vec3Tuple>>>
>;

// --- the file -----------------------------------------------------------------

/**
 * `url` is a path the viewer fetches from its own origin, so it has to be one:
 * rooted, with no way to leave `public/` and no scheme, host, query or fragment
 * to point it somewhere else.
 */
const urlSchema = z
  .string()
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !/[\\?#]/.test(value) &&
      !value.split('/').includes('..'),
    'a url must be a root-relative path such as /models/name.glb',
  );

/**
 * An avatar as its file states it.
 *
 * There is no `id`: the filename is the id, on the same rule a motion's is, so
 * a key by that name is refused as unknown rather than read as a second spelling.
 */
export const avatarFileSchema = z.strictObject({
  label: localizedSchema,
  author: localizedSchema.optional(),
  url: urlSchema.optional(),
  separator: separatorSchema.optional(),
  gaze: gazeSchema.nullable().optional(),
  shapes: shapeOverridesSchema.optional(),
  presets: presetSchema.nullable().optional(),
  emotionShapes: emotionShapesSchema.nullable().optional(),
  mouthShapePattern: patternSchema.nullable().optional(),
  overlays: overlaysSchema.nullable().optional(),
  materials: materialsSchema.optional(),
  wardrobe: wardrobeSchema.optional(),
  sway: swaySchema.optional(),
  drive: z.strictObject({ tail: tailDriveSchema.optional() }).optional(),
  script: z.array(turnSchema).optional(),
  anatomy: jointTableSchema.optional(),
  armRest: armRestSchema.optional(),
});

export type AvatarFile = z.output<typeof avatarFileSchema>;

type _FileKeysMatchEngine = Expect<
  Equals<keyof z.input<typeof avatarFileSchema>, keyof Omit<AvatarDescriptor, 'id'>>
>;

/** The descriptor's default `url`, for a file that does not state one. */
const defaultUrl = (id: string): string => `/models/${id}.glb`;

/**
 * Parse one avatar file's contents, returning the reason rather than throwing.
 *
 * The caller is either a server reading a file somebody is editing or a
 * renderer reading a response, and neither wants an exception — the server
 * prints the reason next to the filename, the renderer drops the avatar and
 * keeps the ones that parsed.
 */
export function parseAvatar(
  id: string,
  value: unknown,
): { ok: true; avatar: AvatarDescriptor } | { ok: false; error: string } {
  const parsed = avatarFileSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: describeIssues(parsed.error, 'avatar') };
  const avatar: AvatarDescriptor = { ...parsed.data, id, url: parsed.data.url ?? defaultUrl(id) };
  return { ok: true, avatar };
}

/**
 * What `GET /api/avatars` answers with: each entry the file's object with its
 * `id` injected, and the files that did not parse beside the ones that did.
 * Empty on a server with no directory.
 */
export const avatarsResponseSchema = z
  .object({
    // Checked one entry at a time below, so a malformed avatar joins `errors`
    // instead of taking every other avatar down with it.
    avatars: z.array(z.unknown()),
    errors: z.array(z.object({ id: z.string(), error: z.string() })),
  })
  .transform(({ avatars, errors }) => {
    const kept: AvatarDescriptor[] = [];
    const failed = [...errors];
    for (const entry of avatars) {
      const { id, ...rest } = (typeof entry === 'object' && entry !== null ? entry : {}) as {
        id?: unknown;
      };
      if (typeof id !== 'string' || id.length === 0) {
        failed.push({ id: '(no id)', error: 'avatar: the entry has no id' });
        continue;
      }
      const result = parseAvatar(id, rest);
      if (result.ok) kept.push(result.avatar);
      else failed.push({ id, error: result.error });
    }
    return { avatars: kept, errors: failed };
  });

export type AvatarsWire = z.input<typeof avatarsResponseSchema>;
export type AvatarsResponse = z.output<typeof avatarsResponseSchema>;
