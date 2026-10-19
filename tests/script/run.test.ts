import { describe, expect, it, vi } from 'vitest';
import { ControlError, type QueueOutcome } from '@/control/client';
import type { CommandRequest, TurnRequest } from '@/protocol';
import type { LoadedScript } from '@/script';
import { runScript, type ScriptControl, setupOutcome } from '@/script/run';

const loaded = (setup?: LoadedScript['script']['setup']): LoadedScript => ({
  id: 'opening',
  path: 'show/scripts/opening.yaml',
  script: {
    setup,
    lines: [{ text: 'first' }, { text: 'second' }],
  },
});

const queue: QueueOutcome = { queue: [], viewers: 1 };

function control(
  setupResponse: unknown = { ok: true, viewers: 1, ids: ['setup'], fates: ['delivered'] },
  added: QueueOutcome = queue,
): ScriptControl & {
  calls: string[];
  clear: ReturnType<typeof vi.fn>;
  commandCall: ReturnType<typeof vi.fn>;
  queueAddCall: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const clear = vi.fn(async () => {
    calls.push('clear');
    return { queue: [], viewers: 1 };
  });
  const commandCall = vi.fn(async (command: CommandRequest) => {
    // Setup and the hold travel as one batch, the hold last.
    calls.push('batch' in command ? 'batch' : 'single');
    return setupResponse;
  });
  const queueAddCall = vi.fn(async (_turns: TurnRequest[], _options?: { source?: string }) => {
    calls.push('queue');
    return added;
  });
  return {
    queueClear: clear,
    command: commandCall,
    queueAdd: queueAddCall,
    calls,
    clear,
    commandCall,
    queueAddCall,
  };
}

describe('runScript', () => {
  it('sends setup and the hold as one batch, then clears, then queues', async () => {
    const client = control();
    const script = loaded([{ cmd: 'camera', frame: 'bust' }]);

    const result = await runScript(client, script, { replace: true });

    expect(client.calls).toEqual(['batch', 'clear', 'queue']);
    expect(client.clear).toHaveBeenCalledOnce();
    expect(client.commandCall).toHaveBeenCalledWith({
      batch: [...(script.script.setup ?? []), { cmd: 'pause', on: false }],
    });
    expect(client.queueAddCall).toHaveBeenCalledWith(script.script.lines, { source: 'opening' });
    expect(result).toEqual({
      setup: { ok: true, viewers: 1, ids: ['setup'], fates: ['delivered'] },
      queue,
    });
  });

  it('does not clear when not replacing, and reports no setup', async () => {
    const client = control();

    const result = await runScript(client, loaded([]));

    // The hold is the one command a run always sends. It is a standing setting,
    // so a run that said nothing about it would load its lines into a queue
    // held for an earlier take and never start.
    expect(client.commandCall).toHaveBeenCalledWith({ batch: [{ cmd: 'pause', on: false }] });
    expect(client.calls).toEqual(['batch', 'queue']);
    expect(client.clear).not.toHaveBeenCalled();
    expect(result.setup).toBeUndefined();
  });

  it('keeps a viewer-less setup response while still queueing the lines', async () => {
    const refused = {
      ok: false,
      viewers: 0,
      ids: [],
      fates: ['lost', 'retained'],
      error: 'no viewer connected',
    };
    const client = control(refused);
    const script = loaded([{ cmd: 'camera', frame: 'bust' }]);

    const result = await runScript(client, script);

    expect(result.setup).toBe(refused);
    expect(client.queueAddCall).toHaveBeenCalledOnce();
  });

  it('holds the queue when asked, in the same batch', async () => {
    const client = control();
    await runScript(client, loaded(), { hold: true });
    expect(client.commandCall).toHaveBeenCalledWith({ batch: [{ cmd: 'pause', on: true }] });
  });

  it('throws the server reason on a refusal, before clearing or queueing anything', async () => {
    const client = control({
      error: 'speech sidecar is loading its model; playback cannot start until it is ready',
    });

    await expect(
      runScript(client, loaded([{ cmd: 'camera', frame: 'bust' }]), { replace: true }),
    ).rejects.toThrow(ControlError);
    await expect(runScript(client, loaded(), { replace: true })).rejects.toThrow(
      /loading its model/,
    );
    expect(client.clear).not.toHaveBeenCalled();
    expect(client.queueAddCall).not.toHaveBeenCalled();
  });

  it('throws when the queue add is refused', async () => {
    const client = control(undefined, { queue: [], viewers: 1, error: 'sidecar not answering' });

    await expect(runScript(client, loaded())).rejects.toThrow('sidecar not answering');
  });
});

describe('setupOutcome', () => {
  const commands = [{ cmd: 'avatar' }, { cmd: 'gesture' }];
  const fates = (...f: string[]) => ({ ok: false, viewers: 0, ids: [], fates: f });

  it('reports an error string and a bare refusal as failures', () => {
    expect(setupOutcome({ error: 'HTTP 400' }, commands)).toEqual({ error: 'HTTP 400', lost: [] });
    expect(setupOutcome({ ok: false }, commands).error).toBe('control command was not delivered');
  });

  it('names lost commands rather than failing when the response also carries an error string', () => {
    expect(
      setupOutcome({ ...fates('retained', 'lost'), error: 'no viewer connected' }, commands),
    ).toEqual({ error: null, lost: ['gesture'] });
  });

  it('names only the commands that were lost when fates are present', () => {
    expect(setupOutcome(fates('retained', 'lost'), commands)).toEqual({
      error: null,
      lost: ['gesture'],
    });
  });

  it('stays quiet for a delivered setup', () => {
    expect(
      setupOutcome({ ok: true, viewers: 1, ids: [], fates: ['delivered', 'delivered'] }, commands),
    ).toEqual({
      error: null,
      lost: [],
    });
  });
});
