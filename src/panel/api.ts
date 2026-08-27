import type { EmotionVector, FingerName, Side } from '@/engine/types';
import type {
  CameraFrame,
  Command,
  HistoryResponse,
  QueueEntry,
  QueueResponse,
  QueueRewind,
  Snapshot,
  TuningPatch,
  TurnRequest,
  VoiceDsp,
} from '@/protocol';

/** Which of the two rewinds. See `queueRewindSchema`. */
export type RewindMode = QueueRewind['mode'];

/**
 * The panel's whole relationship with the runtime: HTTP, and nothing else.
 *
 * This is the difference between the panel and the console beside it. The
 * console reaches into the live scene — `director.blinkEnabled = v` — because it
 * is on the same page as the renderer and its job is to answer "why does that
 * pose look wrong". The panel is not on that page and must not behave as though
 * it were: every control here goes through the control API, so what the panel
 * can do is exactly what an orchestrator can do, and a control that works here
 * is a control an LLM can drive.
 *
 * That constraint is load-bearing rather than tidy. A panel that could poke the
 * scene directly would have to be a second renderer to do it — a second avatar,
 * a second WebGL context, a second set of blinks that do not match the one on
 * air, because the idle layer runs on `Math.random()` and two of them do not
 * agree. There is one renderer, it is the one OBS is pointed at, and this asks
 * it for things.
 */

/** Same origin, always. The server serves this page and the API from one port. */
const BASE = '/api';

/**
 * How often the panel re-reads the runtime.
 *
 * Slower than the viewer's own 700 ms report, because nothing here is on a
 * frame: the queue changes when somebody changes it and the meters update once
 * per line. Fast enough that a turn starting is visible before the operator
 * wonders whether the click worked.
 */
export const POLL_INTERVAL = 500;

/** What a failed request answers with, so callers branch on data rather than throw. */
export interface Failure {
  error: string;
}

const isFailure = (value: unknown): value is Failure =>
  typeof value === 'object' && value !== null && typeof (value as Failure).error === 'string';

/**
 * One request, with the network error folded into the result.
 *
 * The server is a local process that gets restarted while the panel is open, so
 * "not reachable" is an ordinary state and not an exception. Every caller here
 * has to render something either way, and a thrown error would only be caught
 * and turned back into this by each of them.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T | Failure> {
  try {
    const res = await fetch(`${BASE}${path}`, init);
    const body = (await res.json()) as unknown;
    if (!res.ok) return isFailure(body) ? body : { error: `HTTP ${res.status}` };
    return body as T;
  } catch {
    return { error: '制御サーバーに接続できません' };
  }
}

const post = <T>(path: string, body: unknown): Promise<T | Failure> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// --- reading ----------------------------------------------------------------

/** Everything the panel draws, in one round trip. */
export const readState = (): Promise<Snapshot | Failure> => request<Snapshot>('/state');

// --- the queue --------------------------------------------------------------

/** What a queue mutation answers with. `entry` only comes back from shift/pop. */
export type QueueResult = (QueueResponse & { entry?: QueueEntry | null }) | Failure;

export interface AddOptions {
  at?: 'push' | 'unshift';
  source?: string;
  note?: string;
}

export const queueAdd = (turns: TurnRequest[], opts: AddOptions = {}): Promise<QueueResult> =>
  post<QueueResponse>('/queue', { turns, ...opts });

export const queueUpdate = (
  id: string,
  patch: TurnRequest & { source?: string; note?: string },
): Promise<QueueResult> => post<QueueResponse>('/queue/update', { id, ...patch });

export const queueRemove = (id: string): Promise<QueueResult> =>
  post<QueueResponse>('/queue/remove', { id });

export const queueMove = (id: string, to: number): Promise<QueueResult> =>
  post<QueueResponse>('/queue/move', { id, to });

export const queueShift = (): Promise<QueueResult> => post<QueueResponse>('/queue/shift', {});

export const queuePop = (): Promise<QueueResult> => post<QueueResponse>('/queue/pop', {});

export const queueClear = (): Promise<QueueResult> => post<QueueResponse>('/queue/clear', {});

// --- what has already been said ---------------------------------------------

/**
 * The spoken lines, oldest first.
 *
 * Read on its own rather than out of the snapshot, and read only while the
 * operator is looking at it: a hundred lines twice a second, to say something
 * that changes once a line, would be the largest thing on this wire.
 */
export const readHistory = (): Promise<HistoryResponse | Failure> =>
  request<HistoryResponse>('/history');

/**
 * Send something already said round again. See `queueRewindSchema` for what the
 * two modes mean and why `interrupt` is a decision rather than a default.
 */
export const queueRewind = (
  id: string,
  mode: RewindMode,
  interrupt: boolean,
): Promise<QueueResult> => post<QueueResponse>('/queue/rewind', { id, mode, interrupt });

// --- commands ---------------------------------------------------------------

/**
 * Send one command.
 *
 * Deliberately the same door an orchestrator uses. The transport panel does not
 * get a private path to the renderer for `interrupt` just because a stop button
 * feels like it deserves one — if it needed one, so would the orchestrator, and
 * that is a protocol problem rather than a panel problem.
 */
export const send = (command: Command): Promise<unknown> => post('/command', command);

/** Stop mid-sentence and drop everything pending. Both ends, in one call. */
export const interrupt = (): Promise<unknown> => send({ cmd: 'interrupt' });

/** Let the current line finish and drop the rest. */
export const clear = (): Promise<unknown> => send({ cmd: 'clear' });

export const setRoom = (id: string | null): Promise<unknown> => send({ cmd: 'room', id });

/**
 * Frame the shot.
 *
 * Belongs beside the preview rather than in a tab: framing is the one thing an
 * operator changes *because of what they can see*, and a control for it that is
 * not next to the picture is a control used by memory.
 */
export const setCamera = (frame: CameraFrame): Promise<unknown> => send({ cmd: 'camera', frame });

export const setVoice = (preset: string | null | undefined, dsp?: VoiceDsp): Promise<unknown> =>
  send({ cmd: 'voice', ...(preset === undefined ? {} : { preset }), ...(dsp ? { dsp } : {}) });

// --- the stage --------------------------------------------------------------

/** What the character is seen in front of. Null is the flat background. */
export const setBackdrop = (id: string | null): Promise<unknown> => send({ cmd: 'backdrop', id });

/**
 * Load a different avatar.
 *
 * The renderer holds every command sent behind this one until the model is
 * standing, so a swap followed by a costume in the same breath arrives in that
 * order. See `ControlClient.apply`.
 */
export const setAvatar = (id: string): Promise<unknown> => send({ cmd: 'avatar', id });

/** The idle autopilot: whether the character keeps moving between lines. */
export const setIdle = (on: boolean): Promise<unknown> => send({ cmd: 'idle', on });

// --- the performance --------------------------------------------------------

/** A named face-and-movement, or `null` to release the one that is up. */
export const perform = (id: string | null): Promise<unknown> => send({ cmd: 'perform', id });

export const setEmotion = (vec: EmotionVector): Promise<unknown> => send({ cmd: 'emotion', vec });

/** One of the avatar's drawn expressions, or `null` to hand the face back. */
export const setExpression = (id: string | null): Promise<unknown> =>
  send({ cmd: 'expression', id });

export const setOverlay = (id: string, weight: number): Promise<unknown> =>
  send({ cmd: 'overlay', id, weight });

/** Drop the drawn expression and every overlay, and take the mood to neutral. */
export const resetFace = (): Promise<unknown> => send({ cmd: 'reset' });

/** A gesture, or — with no id — stop the one that is running. */
export const gesture = (id?: string): Promise<unknown> =>
  send(id === undefined ? { cmd: 'gesture' } : { cmd: 'gesture', id });

export const hop = (id?: string): Promise<unknown> =>
  send({ cmd: 'hop', ...(id === undefined ? {} : { hop: id }) });

export interface Aim {
  side: Side;
  finger: FingerName;
  /** Degrees, as the wire states them. */
  azimuth: number;
  elevation: number;
  extent: number;
}

export const point = (aim: Aim): Promise<unknown> => send({ cmd: 'point', ...aim });

/** How much the gaze tracks the camera. A blend, not an angle. */
export const setLook = (amount: number): Promise<unknown> => send({ cmd: 'look', amount });

// --- the wardrobe -----------------------------------------------------------

/** Dress one slot. `null` takes the garment off. */
export const wear = (slot: string, item: string | null): Promise<unknown> =>
  send({ cmd: 'wear', slot, item });

/** A whole outfit at once. */
export const wearPreset = (preset: string): Promise<unknown> => send({ cmd: 'wear', preset });

// --- the set-once layer -----------------------------------------------------

/**
 * Move part of the tuning. A patch names the faders that moved and nothing else,
 * so a drag costs one small message. See `tuneCommandSchema`.
 */
export const tune = (patch: TuningPatch): Promise<unknown> => send({ cmd: 'tune', ...patch });

export { isFailure };
