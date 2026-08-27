import { z } from 'zod';
import type {
  SessionEvent as EngineSessionEvent,
  SessionState as EngineSessionState,
  Vocabulary as EngineVocabulary,
  GestureGroup,
  PerformanceGroup,
  SessionEventType,
} from '../engine/types';
import {
  type Assert,
  cameraFrameSchema,
  commandSchema,
  type Equals,
  type Expect,
  emotionVectorSchema,
  fingerNameSchema,
  sideSchema,
} from './commands';

/**
 * The envelopes the control API moves commands and state around in.
 *
 *     orchestrator  ──POST /api/command──►  server  ──SSE──►  viewer
 *                   ◄──GET  /api/state───          ◄─POST──
 *
 * Commands go down the stream, state and turn events come back up by report.
 * Everything the viewer sends up is engine data — `SessionState`, `SessionEvent`
 * and `Vocabulary` are the engine's own interfaces — so those three schemas are
 * pinned to them by the type-level guards below. The guard is the whole point:
 * the engine is where those shapes are decided, and a field added there that
 * never reaches the wire is a silent hole in what the orchestrator can see.
 */

// --- engine shapes, as schemas ----------------------------------------------

export const sessionEventTypeSchema = z.enum([
  'turn.queued',
  'turn.start',
  'turn.end',
  'turn.interrupted',
  'queue.dropped',
  'queue.empty',
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

export const labelledIdSchema = z.object({
  id: z.string(),
  label: z.string(),
});

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
  avatar: z.object({ id: z.string().nullable(), label: z.string().nullable() }),
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
  cue: z.object({ syntax: z.string(), note: z.string() }),
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
    note: z.string(),
  }),
  /** Slot names are avatar data, so the keys are open. */
  wardrobe: z.record(z.string(), z.object({ label: z.string(), items: z.array(labelledIdSchema) })),
  wardrobePresets: z.array(labelledIdSchema),
});

export type Vocabulary = z.infer<typeof vocabularySchema>;

/**
 * Two-way assignability rather than identity: the engine writes one gesture
 * entry as `LabelledId & { … }` and an intersection is interchangeable with the
 * flat object without being the same type.
 */
type _VocabularyMatchesEngine = Assert<Vocabulary, EngineVocabulary>;
type _EngineMatchesVocabulary = Assert<EngineVocabulary, Vocabulary>;

// --- viewer -> server -------------------------------------------------------

/**
 * What the viewer POSTs to `/api/report`, on a timer.
 *
 * The report doubles as the heartbeat, so it goes out whether or not anything
 * changed — a server that stops hearing from a viewer marks it disconnected.
 * The vocabulary rides along only when it just changed (on connect, and when
 * the avatar is swapped), because it is the largest thing here and the least
 * volatile.
 */
export const reportBodySchema = z.object({
  state: sessionStateSchema.optional(),
  events: z.array(sessionEventSchema).optional(),
  vocabulary: vocabularySchema.optional(),
});

export type ReportBody = z.infer<typeof reportBodySchema>;

// --- orchestrator -> server -------------------------------------------------

/**
 * The body of `POST /api/command`: one command, or several under `batch` to be
 * delivered together. A batch is not a transaction — it is one round trip.
 */
export const commandRequestSchema = z.union([
  commandSchema,
  z.object({ batch: z.array(commandSchema) }),
]);

export type CommandRequest = z.infer<typeof commandRequestSchema>;

/**
 * The reply to a command.
 *
 * `ok` is about delivery, not about the avatar: it says a viewer was connected
 * to receive this, nothing about whether the pose looked right. `ids` are the
 * stamped correlation ids, in the order the commands were given, and are what a
 * caller matches the turn events against. `completed` and `state` appear only
 * for a request that asked to wait, and `completed: false` there means the wait
 * timed out rather than that anything failed.
 */
export const commandResponseSchema = z.object({
  ok: z.boolean(),
  viewers: z.number(),
  ids: z.array(z.string()),
  error: z.string().optional(),
  completed: z.boolean().optional(),
  state: sessionStateSchema.partial().optional(),
});

export type CommandResponse = z.infer<typeof commandResponseSchema>;

// --- server -> orchestrator -------------------------------------------------

/**
 * The reply to `GET /api/state`.
 *
 * `state` and `vocabulary` are partial because the server genuinely may have
 * neither: nothing has been reported yet, or the last report is stale and the
 * server is withholding it. `connected` is the flag to branch on — it is false
 * both when no viewer is attached and when the attached one has gone quiet.
 * `events` is the log since `?since=`, oldest first.
 */
export const snapshotSchema = z.object({
  connected: z.boolean(),
  viewers: z.number(),
  /** Sequence number of the newest event. Feed it back as `?since=`. */
  seq: z.number(),
  state: sessionStateSchema.partial(),
  vocabulary: vocabularySchema.partial(),
  events: z.array(sessionEventSchema),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

/** The reply to `GET /api/events`, which is the snapshot's event tail alone. */
export const eventsResponseSchema = z.object({
  seq: z.number(),
  events: z.array(sessionEventSchema),
});

export type EventsResponse = z.infer<typeof eventsResponseSchema>;

// --- server -> viewer -------------------------------------------------------

/**
 * One SSE frame. `type` is already a discriminant even though there is only one
 * kind of frame today, so a second one can be added without every viewer having
 * to guess from the shape.
 *
 * The stream also carries bare comment lines as keepalives; those never reach a
 * JSON parser, so they are not part of this union.
 */
export const streamMessageSchema = z.object({
  type: z.literal('command'),
  commands: z.array(commandSchema),
});

export type StreamMessage = z.infer<typeof streamMessageSchema>;
