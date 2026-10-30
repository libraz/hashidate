import { z } from 'zod';
import { bgmCommandSchema } from './bgm';
import { bloomCommandSchema } from './bloom';
import {
  gestureCommandSchema,
  hopCommandSchema,
  idleActCommandSchema,
  idleCommandSchema,
  idleFaceCommandSchema,
  lookCommandSchema,
  performCommandSchema,
  pointCommandSchema,
} from './body';
import {
  emotionCommandSchema,
  expressionCommandSchema,
  overlayCommandSchema,
  resetCommandSchema,
} from './face';
import { recordCommandSchema } from './record';
import {
  avatarCommandSchema,
  debugCommandSchema,
  tuneCommandSchema,
  wearCommandSchema,
} from './renderer';
import {
  backdropCommandSchema,
  cameraCommandSchema,
  deckCommandSchema,
  placeCommandSchema,
  roomCommandSchema,
  slideCommandSchema,
} from './staging';
import {
  clearCommandSchema,
  interruptCommandSchema,
  pauseCommandSchema,
  queueCommandSchema,
  sayCommandSchema,
} from './turn';
import { voiceCommandSchema } from './voice';

/**
 * The command vocabulary, as it travels on the wire.
 *
 * One definition for the three processes that speak it: the viewer applies a
 * command onto `Session`, the server stamps and fans it out, the CLI builds it.
 * The set here is exactly the set the viewer's control channel switches on —
 * one command is one session call, and a command that cannot be expressed as
 * one call means the session is missing something rather than that this
 * directory needs a special case.
 *
 * Everything is JSON: no dates, no classes, no undefined-as-a-value. Angles are
 * in degrees here and only here; see `pointCommandSchema`.
 *
 * The split is by *what a command talks to*:
 *
 * - `guards`     — the type-level checks that pin a schema to its engine type
 * - `primitives` — the scalars every command is spelled in
 * - `layout`     — a rectangle of the output frame, used by two commands
 * - `turn`       — a line of dialogue, and what can be done to a run of them
 * - `face`       — mood, drawn expression, effects
 * - `body`       — performances, gestures, hops, and the two continuous aims
 * - `staging`    — camera, room, backdrop, document, frame layout
 * - `voice`      — how the voice is processed on its way out
 * - `record`     — recording the composed frame
 * - `renderer`   — which avatar is loaded and how it is set up
 * - `bgm`        — the server-owned music transport
 *
 * Import this barrel rather than a file inside it: `src/protocol/index.ts` is
 * the only public door, and this is the one it opens.
 */

export { BLOOM_DEFAULTS, BLOOM_RANGES } from '../../engine/types';
export { bgmActionSchema, bgmTrackIdSchema, cameraFrameSchema } from '../cues';
export {
  BGM_DEFAULT_LOOP,
  BGM_DEFAULT_VOLUME,
  BGM_DEFAULTS,
  BGM_DSP_DEFAULTS,
  BGM_FADE_DEFAULT_IN_SECONDS,
  BGM_FADE_DEFAULT_OUT_SECONDS,
  BGM_FADE_DEFAULTS,
  BGM_FADE_LIMITS,
  BGM_RAMP_LIMITS,
  type BgmAction,
  type BgmCommand,
  type BgmDsp,
  type BgmDspPatch,
  type BgmFade,
  type BgmFadePatch,
  type BgmTransport,
  bgmCommandSchema,
  bgmDspPatchSchema,
  bgmDspSchema,
  bgmFadePatchSchema,
  bgmFadeSchema,
  bgmRampSecondsSchema,
  bgmTransportSchema,
  hasBgmSetting,
} from './bgm';
export {
  type BloomCommand,
  type BloomPatch,
  type BloomSettings,
  bloomCommandSchema,
  bloomPatchSchema,
  bloomSettingsSchema,
} from './bloom';
export {
  gestureCommandSchema,
  hopCommandSchema,
  idleActCommandSchema,
  idleCommandSchema,
  idleFaceCommandSchema,
  lookCommandSchema,
  performCommandSchema,
  pointCommandSchema,
} from './body';
export {
  emotionCommandSchema,
  expressionCommandSchema,
  overlayCommandSchema,
  resetCommandSchema,
} from './face';
export type { Assert, Equals, Expect } from './guards';
export {
  type Anchor,
  type AvatarPlacement,
  avatarPlacementSchema,
  type Placement,
  placementSchema,
  placeStageSchema,
  type SlidePlacement,
  slidePlacementSchema,
} from './layout';
export {
  type CameraFrame,
  type EmotionName,
  type EmotionVector,
  emotionNameSchema,
  emotionVectorSchema,
  type FingerName,
  fingerNameSchema,
  type Side,
  sideSchema,
} from './primitives';
export { RECORD_DEFAULTS, RECORD_LIMITS, recordCommandSchema } from './record';
export {
  avatarCommandSchema,
  debugCommandSchema,
  type TuningPatch,
  tuneCommandSchema,
  wearCommandSchema,
} from './renderer';
export {
  backdropCommandSchema,
  cameraCommandSchema,
  deckCommandSchema,
  placeCommandSchema,
  roomCommandSchema,
  type Shot,
  slideCommandSchema,
} from './staging';
export {
  clearCommandSchema,
  interruptCommandSchema,
  pauseCommandSchema,
  queueCommandSchema,
  type Staging,
  sayCommandSchema,
  stageSchema,
  type TurnRequest,
  turnSchema,
} from './turn';
export { type VoiceDsp, voiceCommandSchema, voiceDspSchema } from './voice';

// --- the set ----------------------------------------------------------------

/**
 * Every command the viewer accepts, and no others. Discriminated on `cmd` so
 * that the switch which applies them narrows exhaustively.
 */
export const commandSchema = z.discriminatedUnion('cmd', [
  sayCommandSchema,
  queueCommandSchema,
  interruptCommandSchema,
  clearCommandSchema,
  pauseCommandSchema,
  emotionCommandSchema,
  expressionCommandSchema,
  overlayCommandSchema,
  resetCommandSchema,
  performCommandSchema,
  gestureCommandSchema,
  hopCommandSchema,
  pointCommandSchema,
  lookCommandSchema,
  idleCommandSchema,
  idleActCommandSchema,
  idleFaceCommandSchema,
  debugCommandSchema,
  recordCommandSchema,
  cameraCommandSchema,
  roomCommandSchema,
  backdropCommandSchema,
  deckCommandSchema,
  slideCommandSchema,
  placeCommandSchema,
  voiceCommandSchema,
  wearCommandSchema,
  avatarCommandSchema,
  tuneCommandSchema,
  bgmCommandSchema,
  bloomCommandSchema,
]);

export type Command = z.infer<typeof commandSchema>;

/** The `cmd` tag on its own, for a caller that only needs the verb. */
export type CommandName = Command['cmd'];

/**
 * The verbs that act on the run rather than on the state around it.
 *
 * Refused wherever commands travel beside lines — a script's setup and
 * teardown, a batch's `after` — because each would race the queue those lines
 * are in: a `say` is a line outside the list, a `clear` deletes the list.
 */
export const RUN_VERBS: ReadonlySet<CommandName> = new Set(['say', 'queue', 'interrupt', 'clear']);

/**
 * The verbs only the server issues: `record` carries a session the server
 * mints, and `idleAct`/`idleFace` are the autopilot's choices, made once for
 * every renderer. Refused from every caller, so what a renderer acts on is
 * always what the server decided.
 */
export const SERVER_VERBS: ReadonlySet<CommandName> = new Set(['record', 'idleAct', 'idleFace']);

/** A command that sets state, never one of `RUN_VERBS` or `SERVER_VERBS`. */
export const stateCommandSchema = commandSchema
  .refine((command) => !RUN_VERBS.has(command.cmd), {
    error: 'say, queue, interrupt and clear act on the run and cannot be carried beside lines',
  })
  .refine((command) => !SERVER_VERBS.has(command.cmd), {
    error: 'record, idleAct and idleFace are issued by the server, not by a caller',
  });

/** What the control server answers when a queue edit names an entry that is not pending. */
export const NO_SUCH_ENTRY = 'no such entry';

/** Commands whose `id` belongs to the payload rather than to correlation. */
export const PAYLOAD_ID_COMMAND_NAMES = [
  'expression',
  'overlay',
  'gesture',
  'perform',
  'avatar',
  'room',
  'backdrop',
  'deck',
] as const satisfies readonly CommandName[];

export type PayloadIdCommandName = (typeof PAYLOAD_ID_COMMAND_NAMES)[number];

/** Set form for callers that need to test a command tag while stamping it. */
export const PAYLOAD_ID_COMMANDS: ReadonlySet<PayloadIdCommandName> = new Set(
  PAYLOAD_ID_COMMAND_NAMES,
);

export function isPayloadIdCommand(
  command: Command,
): command is Extract<Command, { cmd: PayloadIdCommandName }>;
export function isPayloadIdCommand(command: CommandName): boolean;
export function isPayloadIdCommand(command: Command | CommandName): boolean {
  const name = typeof command === 'string' ? command : command.cmd;
  return PAYLOAD_ID_COMMANDS.has(name as PayloadIdCommandName);
}

/**
 * Parse one command, returning null rather than throwing.
 *
 * The orchestrator and the renderer are separate processes with separate
 * release cycles, and a newer caller talking to an older renderer should
 * degrade rather than crash the stream: the command it does not understand is
 * dropped and everything else keeps flowing. Unknown *fields* are stripped for
 * the same reason, so a command that gained an argument upstream still applies
 * here, minus the argument. Operation groups whose keys select a named action,
 * such as `tune`, are strict so a typo cannot look like a successful no-op.
 */
export function parseCommand(value: unknown): Command | null {
  const parsed = commandSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
