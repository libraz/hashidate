import { beforeEach, describe, expect, it } from 'vitest';
import type { Command, CommandName } from '@/protocol';
import { Standing } from '@/server/standing';

/**
 * The setup a renderer joining late has to be told about.
 *
 * The thing worth testing is the line between a setting and a moment. A costume
 * is still on an hour later; a gesture finished a second after it started, and
 * replaying it to a renderer that has only just connected would be re-enacting
 * something rather than restoring anything.
 */

let standing: Standing;

beforeEach(() => {
  standing = new Standing();
});

/** The verbs, in the order they would be replayed. */
const verbs = (): CommandName[] => standing.commands().map((command) => command.cmd);

describe('what counts as standing', () => {
  it.each<[CommandName, Command]>([
    ['avatar', { cmd: 'avatar', id: 'sample' }],
    ['tune', { cmd: 'tune', idle: { breathDepth: 1 } }],
    ['wear', { cmd: 'wear', slot: 'top', item: 'shirt' }],
    ['camera', { cmd: 'camera', frame: 'full' }],
    ['backdrop', { cmd: 'backdrop', id: 'night' }],
    ['room', { cmd: 'room', id: 'hall' }],
    ['voice', { cmd: 'voice', preset: 'bright' }],
    ['idle', { cmd: 'idle', on: true }],
    ['look', { cmd: 'look', amount: 0.5 }],
    ['emotion', { cmd: 'emotion', vec: { joy: 1 } }],
  ])('keeps %s, because its effect outlives the moment it arrived', (verb, command) => {
    expect(standing.record(command)).toBe(true);
    expect(verbs()).toEqual([verb]);
  });

  it.each<[CommandName, Command]>([
    ['say', { cmd: 'say', text: 'あ' }],
    ['queue', { cmd: 'queue', turns: [] }],
    ['interrupt', { cmd: 'interrupt' }],
    ['clear', { cmd: 'clear' }],
    ['expression', { cmd: 'expression', id: 'F_DOYA' }],
    ['overlay', { cmd: 'overlay', id: 'FX_BLUSH' }],
    ['reset', { cmd: 'reset' }],
    ['perform', { cmd: 'perform', id: 'hello' }],
    ['gesture', { cmd: 'gesture', id: 'wave' }],
    ['hop', { cmd: 'hop' }],
    ['point', { cmd: 'point', azimuth: 30 }],
  ])('drops %s, which is a moment rather than a setup', (_verb, command) => {
    expect(standing.record(command)).toBe(false);
    expect(standing.commands()).toEqual([]);
  });

  it('starts empty and says so', () => {
    expect(standing.empty).toBe(true);
    standing.record({ cmd: 'camera', frame: 'face' });
    expect(standing.empty).toBe(false);
  });

  it('stays empty after a command that is not one of the standing kind', () => {
    standing.record({ cmd: 'gesture', id: 'wave' });
    expect(standing.empty).toBe(true);
  });
});

describe('the newest statement of a setting wins', () => {
  it('keeps only the last camera, backdrop and room', () => {
    standing.record({ cmd: 'camera', frame: 'face' });
    standing.record({ cmd: 'backdrop', id: 'day' });
    standing.record({ cmd: 'camera', frame: 'full' });
    standing.record({ cmd: 'backdrop', id: null });
    expect(standing.commands()).toEqual([
      { cmd: 'camera', frame: 'full' },
      { cmd: 'backdrop', id: null },
    ]);
  });

  it('replays in setup order rather than the order they arrived', () => {
    // The avatar replaces the scene every later command talks to, and a costume
    // is meaningless against the wrong body.
    standing.record({ cmd: 'camera', frame: 'face' });
    standing.record({ cmd: 'wear', slot: 'top', item: 'shirt' });
    standing.record({ cmd: 'avatar', id: 'sample' });
    standing.record({ cmd: 'wear', slot: 'top', item: 'coat' });
    expect(verbs()).toEqual(['avatar', 'wear', 'camera']);
  });
});

describe('the wardrobe, which is a list rather than a value', () => {
  it('keeps one command per slot, so a hat and a jacket are both still on', () => {
    standing.record({ cmd: 'wear', slot: 'top', item: 'shirt' });
    standing.record({ cmd: 'wear', slot: 'head', item: 'hat' });
    expect(standing.commands()).toEqual([
      { cmd: 'wear', slot: 'top', item: 'shirt' },
      { cmd: 'wear', slot: 'head', item: 'hat' },
    ]);
  });

  it('replaces an earlier statement of the same slot in place', () => {
    standing.record({ cmd: 'wear', slot: 'top', item: 'shirt' });
    standing.record({ cmd: 'wear', slot: 'head', item: 'hat' });
    standing.record({ cmd: 'wear', slot: 'top', item: 'coat' });
    expect(standing.commands()).toEqual([
      { cmd: 'wear', slot: 'head', item: 'hat' },
      { cmd: 'wear', slot: 'top', item: 'coat' },
    ]);
  });

  it('keeps taking a garment off, which is a slot set to nothing', () => {
    standing.record({ cmd: 'wear', slot: 'top', item: 'shirt' });
    standing.record({ cmd: 'wear', slot: 'top', item: null });
    expect(standing.commands()).toEqual([{ cmd: 'wear', slot: 'top', item: null }]);
  });

  it('starts the list over on a whole outfit', () => {
    standing.record({ cmd: 'wear', slot: 'top', item: 'shirt' });
    standing.record({ cmd: 'wear', preset: 'stage' });
    expect(standing.commands()).toEqual([{ cmd: 'wear', preset: 'stage' }]);
  });

  it('keeps the slots chosen after an outfit, in order behind it', () => {
    standing.record({ cmd: 'wear', preset: 'stage' });
    standing.record({ cmd: 'wear', slot: 'head', item: 'hat' });
    expect(standing.commands()).toEqual([
      { cmd: 'wear', preset: 'stage' },
      { cmd: 'wear', slot: 'head', item: 'hat' },
    ]);
  });

  it('ignores a wear that names neither a slot nor an outfit', () => {
    expect(standing.record({ cmd: 'wear' })).toBe(true);
    expect(standing.commands()).toEqual([]);
  });

  it('forgets the wardrobe when the avatar changes, and keeps the tuning', () => {
    // Slot names and garment ids are the old avatar's data. The tuning is scales
    // and multipliers, which mean the same thing on any body.
    standing.record({ cmd: 'tune', idle: { breathDepth: 1.4 } });
    standing.record({ cmd: 'wear', slot: 'top', item: 'shirt' });
    standing.record({ cmd: 'avatar', id: 'other' });
    expect(verbs()).toEqual(['avatar', 'tune']);
  });
});

describe('the two commands that merge rather than replace', () => {
  it('folds tune groups together, so an earlier fader is not undone by a later one', () => {
    standing.record({ cmd: 'tune', idle: { breathDepth: 1.4 } });
    standing.record({ cmd: 'tune', sway: { stiffness: 2 } });
    standing.record({ cmd: 'tune', idle: { blink: false } });
    expect(standing.commands()).toEqual([
      { cmd: 'tune', idle: { breathDepth: 1.4, blink: false }, sway: { stiffness: 2 } },
    ]);
  });

  it('lets a later value of the same fader win', () => {
    standing.record({ cmd: 'tune', idle: { breathDepth: 1.4 } });
    standing.record({ cmd: 'tune', idle: { breathDepth: 0.2 } });
    expect(standing.commands()).toEqual([{ cmd: 'tune', idle: { breathDepth: 0.2 } }]);
  });

  it('drops settle, which already happened and is not a state', () => {
    standing.record({ cmd: 'tune', sway: { stiffness: 2 }, settle: true });
    expect(standing.commands()).toEqual([{ cmd: 'tune', sway: { stiffness: 2 } }]);
  });

  it('folds the voice chain section by section', () => {
    standing.record({ cmd: 'voice', preset: 'bright', dsp: { retune: { semitones: 3 } } });
    standing.record({ cmd: 'voice', dsp: { eq: { airDb: 2 } } });
    expect(standing.commands()).toEqual([
      {
        cmd: 'voice',
        preset: 'bright',
        dsp: { retune: { semitones: 3 }, eq: { airDb: 2 } },
      },
    ]);
  });

  it('keeps a later preset without losing the overrides on top of it', () => {
    standing.record({ cmd: 'voice', dsp: { eq: { airDb: 2 } } });
    standing.record({ cmd: 'voice', preset: 'warm' });
    expect(standing.commands()).toEqual([
      { cmd: 'voice', preset: 'warm', dsp: { eq: { airDb: 2 } } },
    ]);
  });

  it('keeps an explicit null preset, which is the chain bypassed', () => {
    standing.record({ cmd: 'voice', preset: 'bright' });
    standing.record({ cmd: 'voice', preset: null });
    expect(standing.commands()).toEqual([{ cmd: 'voice', preset: null }]);
  });

  it('drops the correlation id, which belonged to the request and not the state', () => {
    standing.record({ cmd: 'tune', id: 'c-1', idle: { blink: true } });
    standing.record({ cmd: 'voice', id: 'c-2', preset: 'bright' });
    for (const command of standing.commands()) {
      expect(command).not.toHaveProperty('id');
    }
  });
});
