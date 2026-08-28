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
    ['place', { cmd: 'place', avatar: { anchor: 'bottom-right' } }],
    ['deck', { cmd: 'deck', id: 'intro' }],
    ['slide', { cmd: 'slide', page: 4 }],
    ['backdrop', { cmd: 'backdrop', id: 'night' }],
    ['room', { cmd: 'room', id: 'hall' }],
    ['voice', { cmd: 'voice', preset: 'bright' }],
    ['idle', { cmd: 'idle', on: true }],
    ['look', { cmd: 'look', amount: 0.5 }],
    ['pause', { cmd: 'pause', on: true }],
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
    ['record', { cmd: 'record', on: true, session: 'r1' }],
  ])('drops %s, which is a moment rather than a setup', (_verb, command) => {
    expect(standing.record(command)).toBe(false);
    expect(standing.commands()).toEqual([]);
  });

  it('never keeps the telemetry readout, however long it was left on', () => {
    // The one exclusion that is a safety property rather than a taxonomy. A
    // readout raised to answer a question during rehearsal must not come back
    // by itself on the source OBS reloads at the top of the broadcast, so `off`
    // is what a fresh renderer is handed no matter what was sent before it.
    expect(standing.record({ cmd: 'debug', on: true })).toBe(false);
    expect(standing.commands()).toEqual([]);
    expect(standing.empty).toBe(true);
  });

  it('keeps the hold, so a stage reloaded mid-setup comes back held', () => {
    expect(standing.paused).toBe(false);
    standing.record({ cmd: 'pause', on: true });
    expect(standing.paused).toBe(true);
    standing.record({ cmd: 'pause', on: false });
    expect(standing.paused).toBe(false);
  });

  it('reads a hold with no argument as a hold, as the schema states', () => {
    standing.record({ cmd: 'pause' });
    expect(standing.paused).toBe(true);
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

  it('puts the document up before the page it is open at', () => {
    // A `deck` states the page it opens on, so replayed the other way round it
    // would undo the page the replay had just turned to.
    standing.record({ cmd: 'slide', page: 7 });
    standing.record({ cmd: 'backdrop', id: 'night' });
    standing.record({ cmd: 'deck', id: 'intro', page: 7 });
    standing.record({ cmd: 'place', slide: { fit: 'cover' } });
    standing.record({ cmd: 'slide', page: 9 });
    expect(verbs()).toEqual(['place', 'backdrop', 'deck', 'slide']);
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

  it('folds the framing and the offsets off it together', () => {
    // They come from different places — a script names a shot, a drag on the
    // preview moves it — and a renderer joining later needs both.
    standing.record({ cmd: 'camera', frame: 'full' });
    standing.record({ cmd: 'camera', yaw: 25, zoom: 1.3 });
    standing.record({ cmd: 'camera', frame: 'bust' });
    expect(standing.commands()).toEqual([{ cmd: 'camera', frame: 'bust', yaw: 25, zoom: 1.3 }]);
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

  it('folds the two halves of the frame layout together', () => {
    // A panel sends one slider at a time, so keeping only the last one would
    // undo the width while the margin was still under the pointer.
    standing.record({ cmd: 'place', avatar: { anchor: 'bottom-right', width: 0.4 } });
    standing.record({ cmd: 'place', slide: { fit: 'contain' } });
    standing.record({ cmd: 'place', avatar: { margin: 0.02 } });
    expect(standing.commands()).toEqual([
      {
        cmd: 'place',
        avatar: { anchor: 'bottom-right', width: 0.4, margin: 0.02 },
        slide: { fit: 'contain' },
      },
    ]);
  });

  it('drops the correlation id, which belonged to the request and not the state', () => {
    standing.record({ cmd: 'tune', id: 'c-1', idle: { blink: true } });
    standing.record({ cmd: 'voice', id: 'c-2', preset: 'bright' });
    standing.record({ cmd: 'place', id: 'c-3', avatar: { width: 0.5 } });
    for (const command of standing.commands()) {
      expect(command).not.toHaveProperty('id');
    }
  });
});

/**
 * The page a document is open at, which is the one thing here that is counted
 * rather than remembered.
 *
 * A relative turn means "the page after the one showing", and what is showing is
 * an observation — the one kind of thing this file refuses to keep. So it is
 * resolved from the commands that went out and stored absolute, and a renderer
 * joining late clamps that number against the same document the live one did.
 */
describe('turning pages', () => {
  /** The stored slide, which is always the absolute form. */
  const slide = (): Command | undefined =>
    standing.commands().find((command) => command.cmd === 'slide');

  it('accumulates relative turns into an absolute page', () => {
    standing.record({ cmd: 'deck', id: 'intro' });
    standing.record({ cmd: 'slide', by: 1 });
    standing.record({ cmd: 'slide', by: 1 });
    standing.record({ cmd: 'slide', by: 3 });
    expect(slide()).toEqual({ cmd: 'slide', page: 6 });
  });

  it('treats a bare slide as the next page', () => {
    standing.record({ cmd: 'deck', id: 'intro' });
    standing.record({ cmd: 'slide' });
    standing.record({ cmd: 'slide' });
    expect(slide()).toEqual({ cmd: 'slide', page: 3 });
  });

  it('lets an absolute page win and counts on from it', () => {
    standing.record({ cmd: 'deck', id: 'intro' });
    standing.record({ cmd: 'slide', page: 12, by: -5 });
    standing.record({ cmd: 'slide', by: 1 });
    expect(slide()).toEqual({ cmd: 'slide', page: 13 });
  });

  it('never stores the relative form, which a late renderer could not apply', () => {
    standing.record({ cmd: 'deck', id: 'intro' });
    standing.record({ cmd: 'slide', by: 4 });
    // A renderer that was not there for the first turns would apply this one to
    // page one and be four pages behind the stream for the rest of the segment.
    expect(slide()).not.toHaveProperty('by');
  });

  it('opens a document at its own page and forgets the last one', () => {
    standing.record({ cmd: 'deck', id: 'intro' });
    standing.record({ cmd: 'slide', by: 8 });
    standing.record({ cmd: 'deck', id: 'other', page: 3 });
    expect(slide()).toBeUndefined();
    standing.record({ cmd: 'slide', by: 1 });
    expect(slide()).toEqual({ cmd: 'slide', page: 4 });
  });

  it('opens at the first page when the deck does not say which', () => {
    standing.record({ cmd: 'deck', id: 'intro', page: 40 });
    standing.record({ cmd: 'deck', id: 'other' });
    standing.record({ cmd: 'slide', by: 1 });
    expect(slide()).toEqual({ cmd: 'slide', page: 2 });
  });

  it('resets the counter when the document is taken down', () => {
    standing.record({ cmd: 'deck', id: 'intro', page: 20 });
    standing.record({ cmd: 'deck', id: null });
    standing.record({ cmd: 'slide', by: 1 });
    expect(slide()).toEqual({ cmd: 'slide', page: 2 });
  });

  it('stops at the first page rather than counting below it', () => {
    standing.record({ cmd: 'deck', id: 'intro', page: 2 });
    standing.record({ cmd: 'slide', by: -9 });
    expect(slide()).toEqual({ cmd: 'slide', page: 1 });
    // And counts forward from the clamp, exactly as the renderer does — which is
    // what keeps the two ends on the same page.
    standing.record({ cmd: 'slide', by: 1 });
    expect(slide()).toEqual({ cmd: 'slide', page: 2 });
  });

  it('keeps the document across an avatar swap, unlike the wardrobe', () => {
    // A document is a file on disk and the frame layout is about the broadcast
    // frame. Neither one belonged to the body that was replaced.
    standing.record({ cmd: 'deck', id: 'intro', page: 5 });
    standing.record({ cmd: 'place', avatar: { width: 0.4 } });
    standing.record({ cmd: 'avatar', id: 'other' });
    expect(verbs()).toEqual(['avatar', 'place', 'deck']);
  });
});
