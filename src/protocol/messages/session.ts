import { z } from 'zod';
import type {
  SessionEvent as EngineSessionEvent,
  SessionState as EngineSessionState,
  Vocabulary as EngineVocabulary,
  GestureGroup,
  PerformanceGroup,
  SessionEventType,
} from '../../engine/types';
import {
  type Assert,
  cameraFrameSchema,
  type Equals,
  type Expect,
  emotionVectorSchema,
  fingerNameSchema,
  sideSchema,
} from '../commands';
import { inlineCueActionSchema } from '../cues';
import { labelledIdSchema, localizedSchema } from './primitives';

/**
 * The engine's own three interfaces, as schemas.
 *
 * `SessionState`, `SessionEvent` and `Vocabulary` are decided in the engine and
 * merely travel here, so each is pinned to its engine type by a guard. The
 * guard is the whole point: a field added there that never reaches the wire is
 * a silent hole in what the orchestrator can see.
 */

export const sessionEventTypeSchema = z.enum([
  'turn.queued',
  'turn.start',
  'turn.end',
  'turn.interrupted',
  'queue.dropped',
  'queue.replaced',
  'queue.empty',
  'cue.fire',
]);
type _EventTypesMatchEngine = Expect<
  Equals<z.infer<typeof sessionEventTypeSchema>, SessionEventType>
>;

/**
 * One thing that happened, as the viewer reports it. Which of the optional
 * fields are populated depends on `type`: a `turn.end` carries `turn`, a
 * `queue.dropped` carries `turns`. The engine does not model that dependency
 * either, and pretending to here would invent a contract the emitter has not
 * agreed to.
 */
export const sessionEventSchema = z.object({
  type: sessionEventTypeSchema,
  turn: z.string().optional(),
  turns: z.array(z.string()).optional(),
  queued: z.number().optional(),
  seconds: z.number().optional(),
  /** Stable `${turn}:cue:${ordinal}` id for an inline BGM cue. */
  cueId: z.string().optional(),
  /** The BGM inline cue action requested at that point in the turn. */
  cue: inlineCueActionSchema.optional(),
  /** Stamped by the server on arrival, not by the engine. */
  seq: z.number().optional(),
  at: z.number().optional(),
});

export type SessionEvent = z.infer<typeof sessionEventSchema>;
type _EventMatchesEngine = Expect<Equals<SessionEvent, EngineSessionEvent>>;

/** Everything an orchestrator might branch on, cheap enough to poll. */
export const sessionStateSchema = z.object({
  speaking: z.boolean(),
  turn: z.string().nullable(),
  queued: z.number(),
  busy: z.boolean(),
  idle: z.boolean(),
  idleEnabled: z.boolean(),
  emotion: emotionVectorSchema,
  expression: z.string().nullable(),
  pickedExpression: z.string().nullable(),
  overlays: z.record(z.string(), z.number()),
  performance: z.string().nullable(),
  gesture: z.string().nullable(),
  hopping: z.boolean(),
  /** Joint strain from the last fingertip solve, per arm. */
  strain: z.record(sideSchema, z.number()),
  lookAt: z.number(),
  wardrobe: z.record(z.string(), z.string().nullable()).nullable(),
});

export type SessionState = z.infer<typeof sessionStateSchema>;
type _StateMatchesEngine = Expect<Equals<SessionState, EngineSessionState>>;

const gestureGroupSchema = z.enum(['reaction', 'greeting', 'explain', 'emote', 'cute', 'pose']);
type _GestureGroupsMatchEngine = Expect<Equals<z.infer<typeof gestureGroupSchema>, GestureGroup>>;

const performanceGroupSchema = z.enum([
  'mood',
  'reaction',
  'greeting',
  'explain',
  'emote',
  'cute',
  'pose',
]);
type _PerformanceGroupsMatchEngine = Expect<
  Equals<z.infer<typeof performanceGroupSchema>, PerformanceGroup>
>;

/**
 * What this avatar can be asked to do.
 *
 * Discovered, not declared: the expressions come from the avatar's own shape
 * groups and the wardrobe from its meshes, so swapping the avatar changes what
 * the orchestrator is offered. This is the object to paste into an LLM's system
 * prompt, which is why `pointing.note` is prose — it is read by the caller, not
 * by the code.
 */
export const vocabularySchema = z.object({
  /** Which avatar this vocabulary describes; everything below it is that avatar's. */
  avatar: z.object({ id: z.string().nullable(), label: localizedSchema.nullable() }),
  emotions: z.array(labelledIdSchema),
  expressions: z.array(labelledIdSchema),
  overlays: z.array(labelledIdSchema),
  /** Faces and movements named together; the two lists after it are its parts. */
  performances: z.array(
    labelledIdSchema.extend({
      group: performanceGroupSchema,
      emotion: emotionVectorSchema,
      gesture: z.string().nullable(),
      hop: z.string().nullable(),
      sustain: z.boolean(),
    }),
  ),
  gestures: z.array(labelledIdSchema.extend({ group: gestureGroupSchema, sustain: z.boolean() })),
  hops: z.array(labelledIdSchema),
  /** How to write a performance into a line. Stated, not discovered. */
  cue: z.object({ syntax: z.string(), note: localizedSchema }),
  cameras: z.array(cameraFrameSchema),
  /**
   * Pointing is continuous, so it is advertised as ranges rather than as a list
   * of ids. Degrees, matching the `point` command and not the engine's radians.
   */
  pointing: z.object({
    side: z.array(sideSchema),
    azimuth: z.tuple([z.number(), z.number()]),
    elevation: z.tuple([z.number(), z.number()]),
    extent: z.tuple([z.number(), z.number()]),
    finger: z.array(fingerNameSchema),
    note: localizedSchema,
  }),
  /** Slot names are avatar data, so the keys are open. */
  wardrobe: z.record(
    z.string(),
    z.object({ label: localizedSchema, items: z.array(labelledIdSchema) }),
  ),
  wardrobePresets: z.array(labelledIdSchema),
  /** Where the voice is heard. Empty on a renderer that has no voice at all. */
  rooms: z.array(labelledIdSchema),
  /** Where the character is seen. Empty on a renderer with no backdrops. */
  backdrops: z.array(labelledIdSchema),
  /** The named voice chains, on the same footing as the rooms above. */
  voicePresets: z.array(labelledIdSchema),
});

export type Vocabulary = z.infer<typeof vocabularySchema>;

/**
 * Two-way assignability rather than identity: the engine writes one gesture
 * entry as `LabelledId & { … }` and an intersection is interchangeable with the
 * flat object without being the same type.
 */
type _VocabularyMatchesEngine = Assert<Vocabulary, EngineVocabulary>;
type _EngineMatchesVocabulary = Assert<EngineVocabulary, Vocabulary>;
