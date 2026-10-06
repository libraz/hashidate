import { describe, expect, it, vi } from 'vitest';
import type { CommandRequest, QueueResponse, TurnRequest } from '@/protocol';
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

const queue: QueueResponse = { queue: [], viewers: 1 };

function control(
  setupResponse: unknown = { ok: true, viewers: 1, ids: ['setup'] },
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
    // The hold is a command too, and is always stated. Recorded separately so
    // the order the two halves go out in stays legible.
    calls.push('cmd' in command && command.cmd === 'pause' ? `hold ${command.on}` : 'setup');
    return setupResponse;
  });
  const queueAddCall = vi.fn(async (_turns: TurnRequest[], _options?: { source?: string }) => {
    calls.push('queue');
    return queue;
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
  it('runs replacement, setup, and queue in that order', async () => {
    const client = control();
    const script = loaded([{ cmd: 'camera', frame: 'bust' }]);

    const result = await runScript(client, script, { replace: true });

    expect(client.calls).toEqual(['clear', 'setup', 'hold false', 'queue']);
    expect(client.clear).toHaveBeenCalledOnce();
    expect(client.commandCall).toHaveBeenCalledWith({ batch: script.script.setup });
    expect(client.queueAddCall).toHaveBeenCalledWith(script.script.lines, { source: 'opening' });
    expect(result).toEqual({ setup: { ok: true, viewers: 1, ids: ['setup'] }, queue });
  });

  it('does not clear or send an empty setup when not replacing', async () => {
    const client = control();

    const result = await runScript(client, loaded([]));

    // The hold is the one command a run always sends. It is a standing setting,
    // so a run that said nothing about it would load its lines into a queue
    // held for an earlier take and never start.
    expect(client.calls).toEqual(['hold false', 'queue']);
    expect(client.clear).not.toHaveBeenCalled();
    expect(result.setup).toBeUndefined();
  });

  it('keeps a refused setup response while still queueing the lines', async () => {
    const refused = { ok: false, viewers: 0, ids: [], error: 'no viewer connected' };
    const client = control(refused);
    const script = loaded([{ cmd: 'camera', frame: 'bust' }]);

    const result = await runScript(client, script);

    expect(result.setup).toBe(refused);
    expect(result.setup).toMatchObject({ ok: false });
    expect(client.queueAddCall).toHaveBeenCalledOnce();
    expect(client.calls).toEqual(['setup', 'hold false', 'queue']);
  });

  it('holds the queue when asked, before the lines land in it', async () => {
    // There is no arrangement of these in which a renderer holds a full queue
    // with nothing yet telling it whether to start on it.
    const client = control();
    await runScript(client, loaded(), { hold: true });
    expect(client.calls).toEqual(['hold true', 'queue']);
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
