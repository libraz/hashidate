import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlClient } from '@/cli/client';
import { point } from '@/cli/commands/body';
import { tune } from '@/cli/commands/renderer';
import { play } from '@/cli/commands/show';
import { parseVoiceArgs, voice } from '@/cli/commands/voice';
import { show } from '@/cli/output';
import type { QueueResponse } from '@/protocol';

type FakeClient = Pick<ControlClient, 'command'>;

function client(): { client: FakeClient; commands: unknown[] } {
  const commands: unknown[] = [];
  const fake: FakeClient = {
    command: vi.fn(async (command: unknown) => {
      commands.push(command);
      return { ok: true };
    }) as unknown as ControlClient['command'],
  };
  return { client: fake, commands };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CLI command construction', () => {
  it('keeps the valid point azimuth/elevation and extent options', async () => {
    const { client: fake, commands } = client();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await point(fake as ControlClient, ['40', '25', '--extent', '0.9']);

    expect(commands).toEqual([
      {
        cmd: 'point',
        azimuth: 40,
        elevation: 25,
        extent: 0.9,
        side: 'R',
        finger: 'index',
      },
    ]);
  });

  it('names and rejects a third numeric point positional', async () => {
    const { client: fake, commands } = client();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process exited');
    });

    await expect(point(fake as ControlClient, ['40', '25', '0.9'])).rejects.toThrow(
      'process exited',
    );

    expect(error).toHaveBeenCalledWith(expect.stringContaining('0.9'));
    expect(commands).toHaveLength(0);
  });

  it('uses the strict protocol schema for tune assignments', async () => {
    const { client: fake, commands } = client();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await tune(fake as ControlClient, ['sway.stiffness=2']);

    expect(commands).toEqual([{ cmd: 'tune', sway: { stiffness: 2 } }]);
  });

  it.each([
    ['sway.stifness=2', 'stifness'],
    ['swya.stiffness=2', 'swya'],
  ])(
    'surfaces a misspelled tune path (%s) instead of reporting success',
    async (assignment, typo) => {
      const { client: fake, commands } = client();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process exited');
      });

      await expect(tune(fake as ControlClient, [assignment])).rejects.toThrow('process exited');

      expect(error).toHaveBeenCalledWith(expect.stringContaining(typo));
      expect(commands).toHaveLength(0);
    },
  );
});

describe('voice CLI', () => {
  it('parses a preset without adding provider-specific fields', () => {
    expect(parseVoiceArgs(['stream'])).toEqual({ preset: 'stream' });
  });

  it('parses bypass as the protocol null preset', () => {
    expect(parseVoiceArgs(['--bypass'])).toEqual({ preset: null });
  });

  it.each([
    ['no argument', []],
    ['both forms', ['stream', '--bypass']],
    ['extra positional', ['stream', 'other']],
  ])('rejects %s', (_label, args) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process exited');
    });

    expect(() => parseVoiceArgs(args)).toThrow('process exited');
    expect(error).toHaveBeenCalled();
  });

  it('sends a selected preset through the canonical voice command schema', async () => {
    const { client: fake, commands } = client();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await voice(fake as ControlClient, ['stream']);

    expect(commands).toEqual([{ cmd: 'voice', preset: 'stream' }]);
  });

  it('sends null to bypass the voice chain', async () => {
    const { client: fake, commands } = client();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await voice(fake as ControlClient, ['--bypass']);

    expect(commands).toEqual([{ cmd: 'voice', preset: null }]);
  });
});

describe('command response failures', () => {
  it.each([
    [{ ok: false, error: 'no viewer connected' }, 'no viewer connected'],
    [{ error: 'no command', detail: ['invalid'] }, 'no command'],
  ])('prints the response and exits nonzero for %j', (response, message) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process exited');
    });

    expect(() => show(response)).toThrow('process exited');
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(output).toHaveBeenCalledWith(expect.stringContaining(message));
  });
});

describe('play setup failures', () => {
  it('queues the script and prints its summary before exiting for refused setup', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process exited');
    });
    const commands: unknown[] = [];
    const queue: QueueResponse = { queue: [], viewers: 0 };
    const fake = {
      command: vi.fn(async (command: unknown) => {
        commands.push(command);
        return typeof command === 'object' && command !== null && 'batch' in command
          ? { ok: false, viewers: 0, ids: [], error: 'no viewer connected' }
          : { ok: true, viewers: 0 };
      }),
      queueAdd: vi.fn(async () => queue),
    } as unknown as ControlClient;

    await expect(play(fake, ['demo'])).rejects.toThrow('process exited');

    expect(commands).toEqual([{ batch: expect.any(Array) }, { cmd: 'pause', on: false }]);
    expect(fake.queueAdd).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('queued from demo'));
    expect(error).toHaveBeenCalledWith('setup was not delivered: no viewer is connected');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
