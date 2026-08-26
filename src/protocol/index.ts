/**
 * The wire protocol for the control API.
 *
 * The viewer, the server and the CLI all import from here and nowhere else:
 * this is the single definition of what a command is, what comes back, and what
 * either side is allowed to assume. Everything is a zod schema with its type
 * inferred from it, so validation and the type can never say different things.
 */

export {
  type Command,
  type CommandName,
  cameraCommandSchema,
  cameraFrameSchema,
  clearCommandSchema,
  commandSchema,
  emotionCommandSchema,
  emotionNameSchema,
  emotionVectorSchema,
  expressionCommandSchema,
  fingerNameSchema,
  gestureCommandSchema,
  idleCommandSchema,
  interruptCommandSchema,
  lookCommandSchema,
  overlayCommandSchema,
  parseCommand,
  pointCommandSchema,
  resetCommandSchema,
  sayCommandSchema,
  sideSchema,
  wearCommandSchema,
} from './commands';
export {
  type CommandRequest,
  type CommandResponse,
  commandRequestSchema,
  commandResponseSchema,
  type EventsResponse,
  eventsResponseSchema,
  labelledIdSchema,
  type ReportBody,
  reportBodySchema,
  type SessionEvent,
  type SessionState,
  type Snapshot,
  type StreamMessage,
  sessionEventSchema,
  sessionEventTypeSchema,
  sessionStateSchema,
  snapshotSchema,
  streamMessageSchema,
  type Vocabulary,
  vocabularySchema,
} from './messages';
