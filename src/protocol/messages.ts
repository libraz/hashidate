import { z } from 'zod';
import type {
  SessionEvent as EngineSessionEvent,
  SessionState as EngineSessionState,
  Vocabulary as EngineVocabulary,
  VoiceReport as EngineVoiceReport,
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
  turnSchema,
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
  'queue.replaced',
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

/**
 * What the voice says about itself, so a control surface can draw the chain it
 * is actually running rather than the one it last asked for.
 *
 * `dsp` is the *resolved* configuration — the base preset with every override
 * merged in — and is stated loosely here on purpose. The strict shape is
 * `voiceDspSchema`, which governs what may be *sent*; what comes back is a
 * readout, and a renderer on a newer libsonare that grew a processor should be
 * able to report it rather than have the field stripped on the way through.
 */
export const voiceReportSchema = z.object({
  preset: z.string().nullable(),
  dsp: z.record(z.string(), z.unknown()).nullable(),
  room: z.string().nullable(),
  /** Integrated loudness of the last take, LUFS. Null before anything is spoken. */
  lufs: z.number().nullable(),
  /** True peak of the last take, dBTP. */
  truePeakDb: z.number().nullable(),
});

export type VoiceReport = z.infer<typeof voiceReportSchema>;
type _VoiceReportMatchesEngine = Assert<VoiceReport, EngineVoiceReport>;
type _EngineMatchesVoiceReport = Assert<EngineVoiceReport, VoiceReport>;

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
  voice: voiceReportSchema.optional(),
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

// --- the queue --------------------------------------------------------------

/**
 * One turn waiting to be said, as the control server holds it.
 *
 * A turn plus the three things only the server can know: which id it is filed
 * under, who put it there, and when. `id` is not optional here the way it is on
 * a `say` — an entry that cannot be named cannot be edited, moved or deleted,
 * and it is also the id `turn.start` and `turn.end` come back under, so the
 * panel can tell which row is being spoken without a second correlation.
 *
 * `source` and `note` are for the operator and are **never spoken**. They are
 * how a queue full of lines stays legible when they came from three places at
 * once — an orchestrator's script, a viewer's comment, something typed by hand
 * mid-stream — which is the normal case during a broadcast rather than an
 * unusual one.
 */
export const queueEntrySchema = turnSchema.extend({
  id: z.string(),
  /** Which producer put it here: an orchestrator, a comment, the panel. Free-form. */
  source: z.string().optional(),
  /** The operator's own note. Never spoken, never synthesised. */
  note: z.string().optional(),
  /** Epoch seconds it was queued, for ordering a display by age. */
  at: z.number(),
});

export type QueueEntry = z.infer<typeof queueEntrySchema>;

/**
 * The body of a queue insertion.
 *
 * `turn` and `turns` both work, and the single form is not sugar: the caller
 * that matters most is a comment handler with exactly one line to say, and
 * making it wrap that line in an array it did not want is the kind of friction
 * that gets worked around with a helper in every consumer.
 */
export const queueAddSchema = z.object({
  turn: turnSchema.optional(),
  turns: z.array(turnSchema).optional(),
  /** Where it goes. Default is the end. */
  at: z.enum(['push', 'unshift']).optional(),
  /** Which producer this came from. Applied to every turn in the batch. Never spoken. */
  source: z.string().optional(),
  /** The operator's note. Never spoken. */
  note: z.string().optional(),
});

export type QueueAdd = z.infer<typeof queueAddSchema>;

/**
 * The body of an edit: which entry, and what to change about it.
 *
 * Every field is optional except the id, so a panel that is only fixing a
 * reading does not have to resend the emotion vector it never touched — and,
 * more to the point, cannot clobber one that changed underneath it.
 */
export const queueUpdateSchema = turnSchema.extend({
  id: z.string(),
  source: z.string().optional(),
  note: z.string().optional(),
});

export type QueueUpdate = z.infer<typeof queueUpdateSchema>;

/** The reply to anything that reads or changes the queue. */
export const queueResponseSchema = z.object({
  queue: z.array(queueEntrySchema),
  /** How many viewers the resulting queue was delivered to. */
  viewers: z.number(),
});

export type QueueResponse = z.infer<typeof queueResponseSchema>;

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
  /** What the voice is running. Null until a viewer with a voice has reported. */
  voice: voiceReportSchema.nullable(),
  /** The pending turns, in the order they will be said. See `queue.ts`. */
  queue: z.array(queueEntrySchema),
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
