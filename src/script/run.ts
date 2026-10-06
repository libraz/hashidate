import {
  type CommandRequest,
  commandResponseSchema,
  type QueueResponse,
  type TurnRequest,
} from '../protocol';
import type { LoadedScript } from './index';

/** The part of the control client needed to execute a loaded script. */
export interface ScriptControl {
  queueClear(): Promise<unknown>;
  command(command: CommandRequest): Promise<unknown>;
  queueAdd(turns: TurnRequest[], options?: { source?: string }): Promise<QueueResponse>;
}

/** The two responses from a script run, kept separate because they have different fates. */
export interface ScriptRunResult {
  /** The live setup response, or undefined when the script has no setup. */
  setup: unknown | undefined;
  /** The queue after the script's lines were added. */
  queue: QueueResponse;
}

/**
 * Apply a script in the order its two halves require: clear, setup, then queue.
 *
 * Setup is a live command and can be refused when no viewer is attached; the
 * lines still belong to the server's queue. The raw setup response is returned
 * so each caller can explain that distinction without making this shared layer
 * choose its presentation.
 *
 * The hold is always stated, never left alone. It is a standing setting, so a
 * queue held for an earlier take is still held now — a run that said nothing
 * about it would load its lines into a queue that never starts, and look
 * exactly like a run that failed silently.
 */
export async function runScript(
  control: ScriptControl,
  loaded: LoadedScript,
  { replace = false, hold = false }: { replace?: boolean; hold?: boolean } = {},
): Promise<ScriptRunResult> {
  if (replace) await control.queueClear();

  const setup = loaded.script.setup?.length
    ? await control.command({ batch: loaded.script.setup })
    : undefined;
  // Before the lines, so there is no moment in which a renderer holds a full
  // queue with nothing yet telling it whether to start on it.
  await control.command({ cmd: 'pause', on: hold });
  const queue = await control.queueAdd(loaded.script.lines, { source: loaded.id });

  return { setup, queue };
}

/** What an operator needs to hear about a setup response. */
export interface SetupOutcome {
  /** The setup was refused, or the server said why it failed; null otherwise. */
  error: string | null;
  /** Commands that reached no renderer and are not kept for the next one. */
  lost: string[];
}

/**
 * Read a setup response the way every surface that runs a script must.
 *
 * With per-command fates the server has kept what it could, so only `lost`
 * commands are worth a word; without them a refusal or an error is a failure.
 * The lines are queued either way.
 */
export function setupOutcome(
  response: unknown,
  commands: ReadonlyArray<{ cmd: string }>,
): SetupOutcome {
  // Fates first: a response with a lost command also carries an error string,
  // and reading that would call the whole setup failed.
  const parsed = commandResponseSchema.safeParse(response);
  if (parsed.success) {
    const { fates } = parsed.data;
    const lost = commands.filter((_, index) => fates[index] === 'lost').map((c) => c.cmd);
    return { error: null, lost };
  }
  if (typeof response === 'object' && response !== null && !Array.isArray(response)) {
    const { error } = response as { error?: unknown };
    if (typeof error === 'string') return { error, lost: [] };
  }
  const refused = (response as { ok?: unknown } | null)?.ok === false;
  return { error: refused ? 'control command was not delivered' : null, lost: [] };
}
