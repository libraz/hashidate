import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlClient } from '@/cli/client';
import { point } from '@/cli/commands/body';
import { tune } from '@/cli/commands/renderer';
import { parseVoiceArgs, voice } from '@/cli/commands/voice';

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
