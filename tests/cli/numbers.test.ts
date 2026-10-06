import { afterEach, describe, expect, it, vi } from 'vitest';
import { toInteger, toNumber } from '@/cli/args';
import type { ControlClient } from '@/cli/client';
import { camera, deck, move, place } from '@/cli/commands/staging';
import { say } from '@/cli/commands/turn';

/** A numeric argument is sent only when the whole of it is a number. */

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

describe('strict numeric parsing', () => {
  it.each(['', ' ', '2.7abc', '1x', 'abc', '1e3'])('toNumber refuses %j', (raw) => {
    refusing();
    expect(() => toNumber(raw, 0, '--x')).toThrow('process exited');
  });

  it('toNumber accepts whole numbers, decimals and signs', () => {
    expect([toNumber('25', 0, 'x'), toNumber('-0.5', 0, 'x'), toNumber('.5', 0, 'x')]).toEqual([
      25, -0.5, 0.5,
    ]);
  });

  it.each(['', '2.7', ' 2', '2x'])('toInteger refuses %j', (raw) => {
    refusing();
    expect(() => toInteger(raw, '--page')).toThrow('process exited');
  });

  it('slide refuses a fractional page instead of truncating it', () => {
    refusing();
    expect(move('3')).toEqual({ page: 3 });
    expect(() => move('2.7')).toThrow('process exited');
  });

  it.each([
    [camera, ['full', '--yaw', '']],
    [camera, ['full', '--zoom', '1x']],
    [deck, ['talk', '--page', '2.7']],
    [deck, ['talk', '--page', '']],
    [place, ['avatar', '--width', '']],
    [place, ['avatar', '--margin', '0.1x']],
    [say, ['hi', '--slide', '2.7']],
    [say, ['hi', '--slide', '']],
  ])('refuses %j before sending anything', async (handler, args) => {
    const { fake, commands } = client();
    refusing();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(handler(fake, args)).rejects.toThrow('process exited');
    expect(commands).toEqual([]);
  });

  it('still sends well-formed values', async () => {
    const { fake, commands } = client();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await camera(fake, ['full', '--yaw', '25']);
    await deck(fake, ['talk', '--page', '2']);
    expect(commands).toEqual([
      { cmd: 'camera', frame: 'full', yaw: 25 },
      { cmd: 'deck', id: 'talk', page: 2 },
    ]);
  });
});
