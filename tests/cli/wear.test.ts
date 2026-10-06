import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlClient } from '@/cli/client';
import { tune, wear } from '@/cli/commands/renderer';

/**
 * `wear` and `tune` as the CLI builds them: an argument is either sent as what
 * it says or refused, never dropped or read as something else.
 */

function client(): { fake: ControlClient; commands: unknown[] } {
  const commands: unknown[] = [];
  const fake = {
    command: vi.fn(async (command: unknown) => {
      commands.push(command);
      return { ok: true };
    }),
  } as unknown as ControlClient;
  return { fake, commands };
}

function refusing(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process exited');
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wear CLI', () => {
  it.each([
    [['--slot', 'outer', 'coat'], 'coat'],
    [['--slot', 'outer', '--item', 'coat'], 'coat'],
    [['--slot', 'outer', 'none'], null],
    [['--slot', 'outer', '--item', 'none'], null],
  ])('sends %j as item %j', async (args, item) => {
    const { fake, commands } = client();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await wear(fake, args);
    expect(commands).toEqual([{ cmd: 'wear', slot: 'outer', item }]);
  });

  it.each([
    [['--slot', 'outer', 'coat', 'hat']],
    [['--slot', 'outer', '--item', 'coat', 'hat']],
    [['coat']],
    [['--item', 'coat']],
  ])('refuses %j instead of sending something else', async (args) => {
    const { fake, commands } = client();
    refusing();
    await expect(wear(fake, args)).rejects.toThrow('process exited');
    expect(commands).toHaveLength(0);
  });
});

describe('tune CLI numbers', () => {
  it.each(['idle.breathDepth=', 'idle.breathDepth= ', 'idle.breathDepth=1x'])(
    'refuses %j rather than sending a number it does not say',
    async (assignment) => {
      const { fake, commands } = client();
      refusing();
      await expect(tune(fake, [assignment])).rejects.toThrow('process exited');
      expect(commands).toHaveLength(0);
    },
  );
});
