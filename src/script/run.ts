import type { CommandRequest, QueueResponse, TurnRequest } from '../protocol';
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
 */
export async function runScript(
  control: ScriptControl,
  loaded: LoadedScript,
  { replace = false }: { replace?: boolean } = {},
): Promise<ScriptRunResult> {
  if (replace) await control.queueClear();

  const setup = loaded.script.setup?.length
    ? await control.command({ batch: loaded.script.setup })
    : undefined;
  const queue = await control.queueAdd(loaded.script.lines, { source: loaded.id });

  return { setup, queue };
}
