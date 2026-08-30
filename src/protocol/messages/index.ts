/**
 * The envelopes the control API moves commands and state around in.
 *
 *     orchestrator  ──POST /api/command──►  server  ──SSE──►  viewer
 *                   ◄──GET  /api/state───          ◄─POST──
 *
 * Commands go down the stream, state and turn events come back up by report.
 * Everything the viewer sends up is engine data — `SessionState`, `SessionEvent`
 * and `Vocabulary` are the engine's own interfaces — so those three schemas are
 * pinned to them by type-level guards. The guard is the whole point: the engine
 * is where those shapes are decided, and a field added there that never reaches
 * the wire is a silent hole in what the orchestrator can see.
 *
 * The split is by *who is speaking to whom*:
 *
 * - `primitives` — the label pair every roster is made of
 * - `session`    — the engine's own three interfaces, as schemas
 * - `reports`    — what a renderer says about itself, and the body it says it in
 * - `bgm`        — the server-owned music timeline and what renderers say of it
 * - `queue`      — the editable queue and the history behind it
 * - `decks`      — the documents on disk
 * - `scripts`    — the scripts on disk, and running one
 * - `recording`  — the take being written
 * - `envelope`   — how a command travels and what comes back
 * - `snapshot`   — everything the server knows, in one object
 *
 * Import this barrel rather than a file inside it: `src/protocol/index.ts` is
 * the only public door, and this is the one it opens.
 */

export {
  type BgmReport,
  type BgmResponse,
  type BgmState,
  type BgmTrack,
  bgmReportSchema,
  bgmResponseSchema,
  bgmStateSchema,
  bgmTrackSchema,
} from './bgm';
export {
  type Deck,
  type DecksResponse,
  type DeckTextResponse,
  deckSchema,
  decksResponseSchema,
  deckTextResponseSchema,
} from './decks';
export {
  type CommandRequest,
  type CommandResponse,
  commandRequestSchema,
  commandResponseSchema,
  type ParsedCommandElements,
  type ParsedCommandRequest,
  type ParsedStreamMessage,
  parseCommandRequest,
  parseStreamMessage,
  type StreamMessage,
  streamMessageSchema,
} from './envelope';
export {
  type LabelledId,
  labelledIdSchema,
  localizedSchema,
  type RendererId,
  rendererIdSchema,
} from './primitives';
export {
  type HistoryEntry,
  type HistoryResponse,
  historyEntrySchema,
  historyResponseSchema,
  type QueueAdd,
  type QueueEntry,
  type QueueResponse,
  type QueueRewind,
  type QueueUpdate,
  queueAddSchema,
  queueEntrySchema,
  queueResponseSchema,
  queueRewindSchema,
  queueUpdateSchema,
} from './queue';
export {
  type Recording,
  type RecordResponse,
  type RecordStart,
  type RecordStop,
  recordingSchema,
  recordResponseSchema,
  recordStartSchema,
  recordStopSchema,
} from './recording';
export {
  type AvatarStatus,
  type AvatarStatusPhase,
  avatarStatusPhaseSchema,
  avatarStatusSchema,
  type PlacementReport,
  placementReportSchema,
  type ReportBody,
  reportBodySchema,
  type SlideReport,
  slideReportSchema,
  type Tuning,
  tuningSchema,
  type VoiceReport,
  voiceReportSchema,
} from './reports';
export {
  type ScriptRun,
  type ScriptRunResponse,
  type ScriptSummary,
  type ScriptsResponse,
  scriptRunResponseSchema,
  scriptRunSchema,
  scriptSummarySchema,
  scriptsResponseSchema,
} from './scripts';
export {
  gestureGroupSchema,
  type SessionEvent,
  type SessionState,
  sessionEventSchema,
  sessionEventTypeSchema,
  sessionStateSchema,
  type Vocabulary,
  vocabularySchema,
} from './session';
export {
  type EventsResponse,
  eventsResponseSchema,
  type ServerRoots,
  type Snapshot,
  type SpeechState,
  serverRootsSchema,
  snapshotSchema,
  speechStateSchema,
} from './snapshot';
