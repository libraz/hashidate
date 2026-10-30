import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handler } from '@/cli/args';
import { takeBase, toWait } from '@/cli/args';
import type { ControlClient } from '@/cli/client';
import { bgm } from '@/cli/commands/bgm';
import { gesture, hop, idle, look, perform, point } from '@/cli/commands/body';
import { expression, overlay } from '@/cli/commands/face';
import { state, vocab, watch } from '@/cli/commands/inspect';
import { avatar, debug, wear } from '@/cli/commands/renderer';
import { avatars, motions, play } from '@/cli/commands/show';
import { backdrop, bloom, camera, deck, decks, place, room, slide } from '@/cli/commands/staging';
import { bare, hold, resume, say } from '@/cli/commands/turn';
import { voice } from '@/cli/commands/voice';

/** Every verb refuses what it has no place for, before it asks the server anything. */

/** A client that records any call made on it, whichever method it is. */
function client(): { fake: ControlClient; calls: string[] } {
  const calls: string[] = [];
  const fake = new Proxy(
    {},
    {
      get: (_target, name) => (): Promise<unknown> => {
        calls.push(String(name));
        return Promise.resolve({});
      },
    },
  ) as ControlClient;
  return { fake, calls };
}

function refusing(): { error: ReturnType<typeof vi.spyOn>; exit: ReturnType<typeof vi.spyOn> } {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process exited');
  });
  return { error, exit };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const TAKE_NOTHING: [string, Handler][] = [
  ['hold', hold],
  ['resume', resume],
  ['reset', bare('reset')],
  ['interrupt', bare('interrupt')],
  ['clear', bare('clear')],
  ['vocab', vocab],
  ['state', state],
  ['watch', watch],
  ['decks', decks],
  ['motions', motions],
  ['avatars', avatars],
];

describe('verbs that take nothing', () => {
  it.each(TAKE_NOTHING)('%s refuses an argument or a flag and sends no request', async (_n, h) => {
    for (const args of [['extra'], ['--now']]) {
      const { fake, calls } = client();
      const { error, exit } = refusing();
      await expect(h(fake, args)).rejects.toThrow('process exited');
      expect(exit).toHaveBeenCalledWith(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(args[0]));
      expect(calls).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it.each([
    ['bgm list', ['list', 'x']],
    ['bgm pause', ['pause', 'x']],
    ['bgm stop', ['stop', '--now']],
    ['bgm resume', ['resume', 'x']],
  ])('%s refuses a surplus', async (_n, args) => {
    const { fake, calls } = client();
    refusing();
    await expect(bgm(fake, args)).rejects.toThrow('process exited');
    expect(calls).toEqual([]);
  });
});

const TAKE_ONE: [string, Handler, string[]][] = [
  ['say', say, ['hello']],
  ['perform', perform, ['happy']],
  ['gesture', gesture, ['wave']],
  ['hop', hop, ['bounce']],
  ['idle', idle, ['on']],
  ['look', look, ['0.5']],
  ['expression', expression, ['smile']],
  ['overlay', overlay, ['sweat']],
  ['avatar', avatar, ['one']],
  ['debug', debug, ['on']],
  ['camera', camera, ['full']],
  ['room', room, ['hall']],
  ['backdrop', backdrop, ['dusk']],
  ['bloom', bloom, ['on']],
  ['deck', deck, ['intro']],
  ['slide', slide, ['next']],
  ['place', place, ['avatar']],
  ['play', play, ['demo']],
  ['wear', wear, ['coat', '--slot', 'outer']],
  ['voice', voice, ['stream']],
];

describe('verbs that take one positional', () => {
  it.each(TAKE_ONE)('%s refuses a second and sends nothing', async (_n, h, args) => {
    const { fake, calls } = client();
    const { error } = refusing();
    await expect(h(fake, [...args, 'surplus'])).rejects.toThrow('process exited');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('surplus'));
    expect(calls).toEqual([]);
  });

  it('point refuses a word where a bearing belongs', async () => {
    const { fake, calls } = client();
    refusing();
    await expect(point(fake, ['left'])).rejects.toThrow('process exited');
    expect(calls).toEqual([]);
  });

  it('bgm play refuses a second filename', async () => {
    const { fake, calls } = client();
    refusing();
    await expect(bgm(fake, ['play', 'a.mp3', 'b.mp3'])).rejects.toThrow('process exited');
    expect(calls).toEqual([]);
  });
});

describe('say', () => {
  it.each(['', '   ', '\n'])('refuses blank text %j', async (text) => {
    const { fake, calls } = client();
    refusing();
    await expect(say(fake, [text])).rejects.toThrow('process exited');
    expect(calls).toEqual([]);
  });

  it.each(['--wait=abc', '--wait=0', '--wait=-2'])('refuses %s', async (flag) => {
    const { fake, calls } = client();
    refusing();
    await expect(say(fake, ['hi', flag])).rejects.toThrow('process exited');
    expect(calls).toEqual([]);
  });

  it('refuses a word after a bare --wait as a second positional', async () => {
    const { fake, calls } = client();
    refusing();
    await expect(say(fake, ['hi', '--wait', 'soon'])).rejects.toThrow('process exited');
    expect(calls).toEqual([]);
  });

  it('still sends a line with a numeric or bare --wait', async () => {
    const { fake, calls } = client();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await say(fake, ['hi', '--wait', '5']);
    await say(fake, ['hi', '--wait']);
    expect(calls).toEqual(['command', 'command']);
  });

  it('toWait keeps a positive number as written', () => {
    expect(toWait('2.5')).toBe('2.5');
    expect(toWait(undefined)).toBeUndefined();
  });
});

describe('--base', () => {
  it.each([['--base'], ['--base='], ['--base', '']])('refuses %j with no URL', (...argv) => {
    const { error, exit } = refusing();
    expect(() => takeBase(argv.flat())).toThrow('process exited');
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith('--base needs a URL');
  });
});
