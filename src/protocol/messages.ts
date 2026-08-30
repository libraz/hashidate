import { z } from 'zod';
import type { Tuning as EngineTuning } from '../engine/tuning';
import type {
  LabelledId as EngineLabelledId,
  PlacementReport as EnginePlacementReport,
  SessionEvent as EngineSessionEvent,
  SessionState as EngineSessionState,
  SlideReport as EngineSlideReport,
  Vocabulary as EngineVocabulary,
  VoiceReport as EngineVoiceReport,
  GestureGroup,
  PerformanceGroup,
  SessionEventType,
} from '../engine/types';
import type { Localized } from '../i18n/locale';
import {
  type Assert,
  bgmDspSchema,
  bgmTransportSchema,
  cameraFrameSchema,
  commandSchema,
  type Equals,
  type Expect,
  emotionVectorSchema,
  fingerNameSchema,
  placementSchema,
  RECORD_DEFAULTS,
  RECORD_LIMITS,
  sideSchema,
  slidePlacementSchema,
  turnSchema,
} from './commands';
import { inlineCueActionSchema } from './cues';

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

/**
 * A display string in both languages at once.
 *
 * The wire carries the pair and the client picks one. The alternative — resolving
 * at the source — would mean the server choosing a language on behalf of whoever
 * happens to be reading the panel, and there is nothing in a control request that
 * says who that is.
 */
export const localizedSchema = z.object({
  en: z.string(),
  ja: z.string(),
});

type _LocalizedMatchesEngine = Expect<Equals<z.infer<typeof localizedSchema>, Localized>>;

export const labelledIdSchema = z.object({
  id: z.string(),
  label: localizedSchema,
});

export type LabelledId = z.infer<typeof labelledIdSchema>;
type _LabelledIdMatchesEngine = Expect<Equals<LabelledId, EngineLabelledId>>;

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
  /**
   * Whether the browser is refusing that viewer an audio device until somebody
   * touches the page. See `VoiceReport` in the engine — it is on the wire
   * because it is the one fault here that a control surface cannot fix by
   * sending anything, only by telling the operator where to click.
   */
  blocked: z.boolean(),
});

export type VoiceReport = z.infer<typeof voiceReportSchema>;
type _VoiceReportMatchesEngine = Assert<VoiceReport, EngineVoiceReport>;
type _EngineMatchesVoiceReport = Assert<EngineVoiceReport, VoiceReport>;

/**
 * What the document layer is showing, so a control surface can draw it.
 *
 * On the same footing as `VoiceReport`: the page count is discovered by opening
 * the file, and `ready` is the difference between a page that is up and one
 * that is still being drawn — which is the only thing an operator holding an
 * arrow key needs to know and the one thing the command cannot tell them.
 *
 * `error` is here for the same reason `blocked` is on the voice report: it is a
 * fault nothing can be sent to fix, only reported to whoever can put the file
 * back.
 */
export const slideReportSchema = z.object({
  deck: z.string().nullable(),
  page: z.number(),
  pages: z.number(),
  ready: z.boolean(),
  error: z.string().nullable(),
});

export type SlideReport = z.infer<typeof slideReportSchema>;
type _SlideReportMatchesEngine = Expect<Equals<SlideReport, EngineSlideReport>>;

// --- background music ------------------------------------------------------

/** One playable file in the server's direct BGM directory. */
export const bgmTrackSchema = z.object({
  /** The NFC-normalised filename, including `.mp3` or `.flac`. */
  id: z.string(),
  /** The filename is the display label; BGM has no second localisation source. */
  label: z.string(),
  /** `audio/mpeg` for MP3 and `audio/flac` for FLAC. */
  mime: z.enum(['audio/mpeg', 'audio/flac']),
  bytes: z.number().finite().nonnegative(),
  /** Epoch seconds of the file's last modification. */
  at: z.number().finite().nonnegative(),
});

export type BgmTrack = z.infer<typeof bgmTrackSchema>;

/** The server's canonical BGM transport and timeline. */
export const bgmStateSchema = z.object({
  track: z.string().nullable(),
  volume: z.number().min(0).max(1),
  loop: z.boolean(),
  /** The server-owned libsonare DSP patch for the BGM stream. */
  dsp: bgmDspSchema,
  transport: bgmTransportSchema,
  position: z.number().finite().nonnegative(),
  revision: z.number().int().nonnegative(),
  /** Epoch seconds at which `position` was measured. */
  at: z.number().finite().nonnegative(),
  /** Duration reported by a renderer, if it has decoded the selected track. */
  duration: z.number().finite().nonnegative().nullable(),
  /** An audible renderer's inability to play the selected track. */
  blocked: z.boolean(),
  error: z.string().nullable(),
  /** True when the renderer had to fall back to a dry BGM worklet path. */
  dspDegraded: z.boolean().default(false),
});

export type BgmState = z.infer<typeof bgmStateSchema>;

/**
 * What a renderer reports about the BGM command it most recently received.
 *
 * `revision` is echoed so the server can reject a delayed report from an old
 * command. `muted` identifies preview renderers: they may contribute a decoded
 * duration, but their blocked/error status must never hide a problem on the
 * audible renderer. Position, timestamp and transport are diagnostics; the
 * server's coordinator remains the timeline authority. `dspDegraded` reports
 * a dry-worklet fallback and is sticky on the server for the current revision.
 */
export const bgmReportSchema = z.object({
  revision: z.number().int().nonnegative(),
  track: z.string().nullable().default(null),
  /** Optional resolved readout; the server does not accept it as authority. */
  dsp: bgmDspSchema.optional(),
  transport: bgmTransportSchema.default('stopped'),
  position: z.number().finite().min(0).default(0),
  duration: z.number().finite().nonnegative().nullable().default(null),
  muted: z.boolean().default(false),
  blocked: z.boolean().default(false),
  error: z.string().nullable().default(null),
  /** Sticky for the current revision on audible renderers; muted reports omit its effect. */
  dspDegraded: z.boolean().default(false),
  /** Epoch seconds at which the renderer sampled its position. */
  at: z.number().finite().nonnegative().optional(),
});

export type BgmReport = z.infer<typeof bgmReportSchema>;

/** The fresh response to `GET /api/bgm`. */
export const bgmResponseSchema = z.object({
  tracks: z.array(bgmTrackSchema),
});

export type BgmResponse = z.infer<typeof bgmResponseSchema>;

/**
 * One document the control server can serve, as it found it on disk.
 *
 * Not in the vocabulary, and that is the point: the vocabulary is what the
 * loaded avatar can be asked to do, discovered from the avatar. This is a
 * directory listing, it changes when somebody saves a file, and it is re-read
 * rather than cached — so it rides on the snapshot the panel is already polling
 * and comes from the only process that can see the filesystem.
 *
 * `pages` is counted without rasterising anything, so it is known before the
 * document has ever been shown.
 */
export const deckSchema = labelledIdSchema.extend({
  pages: z.number(),
  bytes: z.number(),
  /** Epoch seconds of the file's last modification, for sorting by newest. */
  at: z.number(),
});

export type Deck = z.infer<typeof deckSchema>;

/** The reply to `GET /api/decks`, and to a rescan. */
export const decksResponseSchema = z.object({
  decks: z.array(deckSchema),
});

export type DecksResponse = z.infer<typeof decksResponseSchema>;

/**
 * The reply to `GET /api/decks/<id>/text`: what a document says, page by page.
 *
 * The piece that makes a document narratable. An orchestrator writing a script
 * needs the words on the pages before it can write anything about them, and it
 * cannot get them from the renderer — the control channel carries commands one
 * way and a report the other, and a request for a document's contents is
 * neither. So the server reads the text itself, which it can do without drawing
 * anything.
 *
 * `pages` is 1 based and in order, with an entry for every page asked for —
 * including the empty string for a page that is all picture, because a gap in
 * the list would be indistinguishable from a page that was not requested.
 */
export const deckTextResponseSchema = z.object({
  id: z.string(),
  pages: z.number(),
  from: z.number(),
  text: z.array(z.string()),
});

export type DeckTextResponse = z.infer<typeof deckTextResponseSchema>;

/**
 * One script on disk, as much of it as a picker needs.
 *
 * Not the script itself. A run of turns is the largest thing in `show/` that is
 * text, and the panel draws a row per file — so what travels is what a row
 * shows and what a decision is made on: what it is called, how long it is, and
 * when it was saved. The turns arrive by being queued, which is the only thing
 * anybody does with them.
 *
 * `title` is the script's own, a plain string rather than a `Localized`, on the
 * rule `scriptSchema` states: a script is written in one language because its
 * lines are. Absent when the file gives none, and then the id is the name.
 */
export const scriptSummarySchema = z.object({
  /** The filename without its extension. See `loadScript`. */
  id: z.string(),
  title: z.string().optional(),
  /** How many turns it queues, and how many commands it sets up first. */
  lines: z.number(),
  setup: z.number(),
  bytes: z.number(),
  /** Epoch seconds of the file's last modification, as a document's is. */
  at: z.number(),
});

export type ScriptSummary = z.infer<typeof scriptSummarySchema>;

/**
 * The reply to `GET /api/scripts`: what is there, and what would not parse.
 *
 * Both halves, on the same rule the motion roster follows. A file an operator
 * saved into the directory and that is not a script has to be visible as
 * exactly that — a name missing from a list reads as a name typed wrong, which
 * is the one thing it is not.
 */
export const scriptsResponseSchema = z.object({
  scripts: z.array(scriptSummarySchema),
  errors: z.array(z.object({ id: z.string(), error: z.string() })),
});

export type ScriptsResponse = z.infer<typeof scriptsResponseSchema>;

/**
 * The recording the server has open, if there is one.
 *
 * The server's own observation rather than a viewer's report, on the same
 * footing as `speech`: the bytes are arriving here and the file is open here,
 * so this is the one process that can say whether a recording is actually
 * being written. A renderer that believed it was recording into a file that
 * was never opened is the failure this shape exists to make impossible.
 *
 * `bytes` is what has landed on disk. It is the only honest progress figure —
 * a recorder that has silently stopped producing chunks looks exactly like one
 * that is still going until this stops climbing.
 */
export const recordingSchema = z.object({
  session: z.string(),
  /** Absolute path of the file being written. */
  file: z.string(),
  /**
   * What the renderer's encoder actually chose, or null before the first chunk.
   * The container decides the extension, so this is what says whether the
   * result is the mp4 that was asked for.
   */
  mime: z.string().nullable(),
  /** Epoch seconds the recording was opened. */
  since: z.number(),
  bytes: z.number(),
  /** Whether the end of the queue ends the recording. See `Recordings`. */
  autoStop: z.boolean(),
  /** The output frame, as the renderer was asked for it. */
  width: z.number(),
  height: z.number(),
  fps: z.number(),
});

export type Recording = z.infer<typeof recordingSchema>;

/**
 * What the set-once layer is running, so a remote fader can be drawn at the
 * value that is actually in force rather than at the one somebody last sent.
 *
 * Reported for the same reason `VoiceReport` is: the defaults belong to the
 * engine objects that own them and differ per avatar, so a panel that inferred
 * them from its own command history would be wrong from the moment it opened
 * and wrong again after every swap.
 *
 * `has` is what makes the difference between a control that is off and a
 * control that is not there. An avatar with no spring bones has no sway to
 * tune, and a fader for a chain that does not exist is a dead one.
 */
export const tuningSchema = z.object({
  idle: z.object({
    breathDepth: z.number(),
    breathPeriod: z.number(),
    idleAmount: z.number(),
    weightShift: z.number(),
    gazeAmount: z.number(),
    eyeLimit: z.number(),
    blink: z.boolean(),
  }),
  sway: z.object({
    enabled: z.boolean(),
    stiffness: z.number(),
    inertia: z.number(),
    gravity: z.number(),
  }),
  /** `height` is metres here, as it is in the command. */
  hop: z.object({ height: z.number(), gravity: z.number() }),
  tail: z.object({ amount: z.number() }),
  render: z.object({ toon: z.boolean(), arkit: z.boolean() }),
  has: z.object({ sway: z.boolean(), tail: z.boolean(), arkit: z.boolean() }),
});

export type Tuning = z.infer<typeof tuningSchema>;
type _TuningMatchesEngine = Expect<Equals<Tuning, EngineTuning>>;

/**
 * A rectangle of the frame as it is *in force*, rather than as somebody asked
 * for it.
 *
 * ## Why this is not `placementSchema`
 *
 * That one governs what may be **sent**, so every field on it is optional and an
 * absent one means "leave it alone" — which is what lets a slider under the
 * pointer send one number. Read back, the same shape would be useless: a report
 * with three fields missing says what the last patch happened to name, and the
 * surface asking has no way to tell an anchor that is centred from an anchor
 * nobody has mentioned. So the limits, the anchor list and the fit stay stated
 * once, in the command schema, and this is that schema with the optionality
 * taken off.
 */
const resolvedPlacementSchema = placementSchema.required();
const resolvedSlidePlacementSchema = slidePlacementSchema.required();

/**
 * How the frame is laid out, so a control surface can draw the layout that is
 * actually going to air.
 *
 * Reported for the same reason `tuningSchema` is: the value belongs to whatever
 * is applying it, and a panel that inferred it from its own command history
 * would be wrong from the moment it opened. Here that is not a corner case but
 * the ordinary one — a browser source opened on `?place=bottom-right:0.32x0.6`
 * is showing a corner that no command ever asked for.
 */
export const placementReportSchema = z.object({
  avatar: resolvedPlacementSchema,
  slide: resolvedSlidePlacementSchema,
});

export type PlacementReport = z.infer<typeof placementReportSchema>;
type _PlacementReportMatchesEngine = Assert<PlacementReport, EnginePlacementReport>;
type _EngineMatchesPlacementReport = Assert<EnginePlacementReport, PlacementReport>;

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
  tuning: tuningSchema.optional(),
  /**
   * What the document layer is showing. Absent from a renderer that has none,
   * which is how a panel tells "no document layer" from "no document up".
   */
  slides: slideReportSchema.optional(),
  /**
   * How this renderer is laying the frame out. Absent from one that draws only
   * one way, on the same footing as the slide report above.
   */
  placement: placementReportSchema.optional(),
  /** What this renderer is doing with the server-owned background track. */
  bgm: bgmReportSchema.optional(),
  /**
   * Every avatar this renderer can load, which is not the same question as what
   * the loaded one can do. It rides with the vocabulary rather than on the timer
   * — the roster is fixed for the life of the process — and it is here at all so
   * that a surface offering a picker is offering the renderer's own list rather
   * than a copy of the registry it happens to share a bundle with.
   */
  avatars: z.array(labelledIdSchema).optional(),
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
 * A turn the renderer has finished with, as the server files it.
 *
 * The entry it was, plus the two things that only become true at the end: when
 * it stopped, and whether it got there. A line that was cut off is kept for the
 * same reason a finished one is — it is the line most likely to be wanted back,
 * because being cut off is usually the reason somebody reaches for the history
 * at all.
 *
 * The id is the one it was said under, so the event log for that turn and the
 * row an operator is looking at still name the same thing. Sending it round
 * again mints a new one; see `queueRewindSchema`.
 */
export const historyEntrySchema = queueEntrySchema.extend({
  /** Epoch seconds the renderer reported it done. */
  saidAt: z.number(),
  /** True when it was interrupted. Absent means it was said to the end. */
  interrupted: z.boolean().optional(),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;

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

/**
 * The body of `POST /api/queue/rewind`: send something already said round again.
 *
 * Two modes, because "again" means two different things during a broadcast and
 * the difference is where the script resumes.
 *
 * - `from` takes the named line **and everything said after it** out of the
 *   history and puts them back at the front of the queue, in order. The show
 *   carries on from that point, which is what a rewind is.
 * - `one` copies the named line to the front and leaves the history alone. For
 *   a line that was fluffed and wants saying again, without moving anything
 *   else.
 *
 * Either way the returned lines are new entries with new ids. Reusing the old
 * one would put a second `turn.end` under an id that has already ended, and
 * anything correlating against the event log would have no way to tell the two
 * apart.
 *
 * `interrupt` decides what happens to the line currently on air: cut it off
 * where it is, or let it finish and start the rewound script after it. It is a
 * choice per operation and has no default — cutting a character off mid-word is
 * sometimes exactly right and is never something to do by accident.
 */
export const queueRewindSchema = z.object({
  id: z.string(),
  mode: z.enum(['from', 'one']).default('from'),
  /** Cut the line being said. Absent lets it finish. */
  interrupt: z.boolean().optional(),
});

export type QueueRewind = z.infer<typeof queueRewindSchema>;

/** The reply to anything that reads or changes the queue. */
export const queueResponseSchema = z.object({
  queue: z.array(queueEntrySchema),
  /** How many viewers the resulting queue was delivered to. */
  viewers: z.number(),
});

export type QueueResponse = z.infer<typeof queueResponseSchema>;

/**
 * The reply to `GET /api/history`: what has been said, oldest first.
 *
 * Its own endpoint rather than a field on the snapshot, and the reason is the
 * polling rate. The panel re-reads the snapshot twice a second; a hundred spoken
 * lines riding along with every one of those would be the largest thing on the
 * wire by an order of magnitude, to say something that changes once a line.
 */
export const historyResponseSchema = z.object({
  history: z.array(historyEntrySchema),
});

export type HistoryResponse = z.infer<typeof historyResponseSchema>;

/**
 * The body of `POST /api/scripts/run`: put a script on the queue.
 *
 * Doing on the server what `runScript` does from a client — clear, setup, queue
 * — so that a panel can run a file it cannot read. The panel has no filesystem;
 * the alternative was shipping the whole script to the browser so it could send
 * the turns back, which is the same run of turns crossing the wire twice for
 * nothing.
 *
 * `pause` is why this exists as more than a convenience. A script queued to be
 * *recorded* must not start on arrival: the shot is framed after the lines are
 * loaded and before the first one is said. Holding is therefore the default,
 * and a caller that wants the old behaviour — an orchestrator running a segment
 * live — says `pause: false`.
 *
 * `replace` is not the default, on the rule the queue follows everywhere else:
 * dropping what somebody else queued is a decision, not a side effect of
 * loading a file.
 */
export const scriptRunSchema = z.object({
  id: z.string(),
  /** Empty the queue first. Absent adds to the end of it. */
  replace: z.boolean().optional(),
  /** Hold the queue rather than letting it start. Absent holds. */
  pause: z.boolean().optional(),
});

export type ScriptRun = z.infer<typeof scriptRunSchema>;

/**
 * The reply to `POST /api/scripts/run`.
 *
 * The queue as it now stands, plus what was run and whether the setup got
 * anywhere. Those last two are separate because they have separate fates: the
 * lines belong to the server's queue and survive having no renderer attached,
 * while the setup is live commands and is simply refused when there is nothing
 * to apply them to. A caller told only "ok" would have no way to know that the
 * avatar, the costume and the framing its script asked for never happened.
 */
export const scriptRunResponseSchema = queueResponseSchema.extend({
  id: z.string(),
  /** How many setup commands were sent, and how many viewers took them. */
  setup: z.number(),
  setupDelivered: z.number(),
  /** Whether the queue was left held. See `pauseCommandSchema`. */
  paused: z.boolean(),
});

export type ScriptRunResponse = z.infer<typeof scriptRunResponseSchema>;

/**
 * The body of `POST /api/record/start`.
 *
 * The size is the output frame and is unrelated to the size of the window the
 * stage happens to be in; see `recordCommandSchema`. The defaults are applied
 * here rather than in the renderer so that what the panel asked for and what
 * the server has open are the same numbers.
 */
export const recordStartSchema = z.object({
  /** What to call the file. A script id, usually. Timestamped either way. */
  name: z.string().optional(),
  width: z
    .number()
    .int()
    .min(RECORD_LIMITS.width.min)
    .max(RECORD_LIMITS.width.max)
    .default(RECORD_DEFAULTS.width),
  height: z
    .number()
    .int()
    .min(RECORD_LIMITS.height.min)
    .max(RECORD_LIMITS.height.max)
    .default(RECORD_DEFAULTS.height),
  fps: z
    .number()
    .int()
    .min(RECORD_LIMITS.fps.min)
    .max(RECORD_LIMITS.fps.max)
    .default(RECORD_DEFAULTS.fps),
  /** End the take when the queue runs out. See `RECORD_TAIL_SECONDS`. */
  autoStop: z.boolean().default(true),
  /**
   * Let a held queue go once the recording is actually rolling, rather than
   * when this request is answered. The whole reason the two are one call.
   */
  release: z.boolean().default(false),
});

export type RecordStart = z.infer<typeof recordStartSchema>;

/**
 * The body of `POST /api/record/stop`.
 *
 * `session` is optional and is a guard rather than a selector — there is only
 * ever one take open. Given, it refuses to stop a take that is not the one the
 * caller was looking at, which is the case an operator hits by leaving a stale
 * panel open on a second screen.
 */
export const recordStopSchema = z.object({
  session: z.string().optional(),
});

export type RecordStop = z.infer<typeof recordStopSchema>;

/** The reply to either recording route: the take, or null once it has closed. */
export const recordResponseSchema = z.object({
  recording: recordingSchema.nullable(),
});

export type RecordResponse = z.infer<typeof recordResponseSchema>;

// --- server -> orchestrator -------------------------------------------------

/**
 * What the control server last saw of the speech sidecar.
 *
 * Four states rather than a flag, because "there is no voice on this machine"
 * and "the voice stopped answering" deserve opposite treatment. Most machines
 * never have `tools/tts/` running — the model is another three gigabytes and
 * the recordings behind the voice are not ours — so a server that has never
 * reached it is working as designed, and `absent` says that quietly.
 *
 * `down` is the one worth interrupting somebody over: something was answering
 * on that port and has stopped, which on air means every line from here is
 * mouthed in silence. Telling the two apart is the whole reason this is not a
 * boolean, because a panel that cried about a missing sidecar on every machine
 * without one would be ignored by the time it mattered.
 */
export const speechStateSchema = z.enum(['absent', 'loading', 'ready', 'down']);

export type SpeechState = z.infer<typeof speechStateSchema>;

/**
 * The directories a control server was started on.
 *
 * Here because a listener on the port is not the same thing as *this* server.
 * Two checkouts of this project answer `/api/state` identically, and a launcher
 * that finds one already running has to decide whether to use it or to start
 * its own — a decision that cannot be made from a port number. The document
 * root is the one that decides it, since it is the build the windows would be
 * loaded from; the show directories are here because a launcher that opens them
 * in a file manager would otherwise open its own while driving somebody else's.
 *
 * Absolute paths, and loopback-only by the same licence condition as the rest
 * of this API. See `src/shell/process.ts` for the only consumer.
 */
export const serverRootsSchema = z.object({
  /** What `/` is served from. `dist` unless `--root` said otherwise. */
  document: z.string(),
  slides: z.string(),
  scripts: z.string(),
  motions: z.string(),
  recordings: z.string(),
  /** The direct BGM asset directory, when this server was started with one. */
  bgm: z.string().optional(),
});

export type ServerRoots = z.infer<typeof serverRootsSchema>;

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
  /** What the set-once layer is running. Null until a viewer has reported. */
  tuning: tuningSchema.nullable(),
  /** How the frame is laid out. Null until a viewer has reported one. */
  placement: placementReportSchema.nullable(),
  /** What this renderer can load. Empty until a viewer has reported. */
  avatars: z.array(labelledIdSchema),
  /**
   * The documents on disk, as the server last read them. Empty when there is no
   * document directory or nothing in it — see `deckSchema` for why this is here
   * rather than in the vocabulary.
   */
  decks: z.array(deckSchema),
  /** What the document layer is showing. Null until a viewer with one reports. */
  slides: slideReportSchema.nullable(),
  /** The server-owned BGM transport and timeline. */
  bgm: bgmStateSchema.optional(),
  /** The current fresh roster from the direct BGM directory. */
  bgmTracks: z.array(bgmTrackSchema).optional(),
  /**
   * Whether the voice is answering. This one is the server's own observation
   * rather than a viewer's report — the sidecar is reached from here and only
   * from here. See `speechStateSchema`.
   */
  speech: speechStateSchema,
  /** The pending turns, in the order they will be said. See `queue.ts`. */
  queue: z.array(queueEntrySchema),
  /**
   * Whether the queue is held. See `pauseCommandSchema`.
   *
   * The server's own, read off the setup it re-delivers on connect rather than
   * off a viewer's report — it is a standing setting, and a renderer that has
   * not attached yet has no opinion about it. That is what makes a script
   * loaded into a held queue stay held through a reload of the stage.
   */
  paused: z.boolean(),
  /**
   * The recording being written, or null. See `recordingSchema` for why this
   * is the server's observation rather than a renderer's.
   */
  recording: recordingSchema.nullable(),
  /**
   * Where this server is serving from. See `serverRootsSchema`.
   *
   * Optional because a hub can be built without them — every test does, and so
   * does anything embedding the hub for a purpose that has no directories. A
   * launcher deciding whether to adopt a running server reads the absence as
   * "not the one I was looking for", which is the safe answer.
   */
  roots: serverRootsSchema.optional(),
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
