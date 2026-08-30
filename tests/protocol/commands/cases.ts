import type { Command, CommandName } from '@/protocol';
import { commandSchema } from '@/protocol';

/**
 * The command vocabulary as it travels on the wire.
 *
 * The set pinned here is the set `viewer/control-client.ts` switches on: one
 * command is one session call, so a verb that parses but has no case there, or
 * a case with no verb here, is a hole in the control path.
 *
 * Shared by every suite in this directory, because the roster is the one thing
 * they all agree about — the files beside it look at one command family each.
 */

/** Every case in the control client's `apply` switch, with a payload for each. */
export const SWITCH_CASES: Record<CommandName, Command[]> = {
  say: [
    { cmd: 'say', text: 'こんにちは' },
    {
      cmd: 'say',
      id: 'turn-1',
      text: 'こんにちは',
      emotion: { joy: 0.8, surprise: 0.2 },
      expression: 'F_DOYA',
      gesture: 'wave',
      perform: 'hello',
      side: 'L',
      hold: true,
    },
    { cmd: 'say', emotion: null, expression: null, gesture: null, perform: null },
    { cmd: 'say' },
  ],
  interrupt: [{ cmd: 'interrupt' }, { cmd: 'interrupt', id: 'c-1' }],
  clear: [{ cmd: 'clear' }, { cmd: 'clear', id: 'c-2' }],
  pause: [{ cmd: 'pause' }, { cmd: 'pause', on: false }, { cmd: 'pause', on: true, id: 'c-3' }],
  record: [
    { cmd: 'record', on: true, session: 'r1', width: 1920, height: 1080, fps: 30 },
    { cmd: 'record', on: false, session: 'r1' },
  ],
  emotion: [
    { cmd: 'emotion', vec: { anger: 1 } },
    { cmd: 'emotion', emotion: { sadness: 0.5 } },
    { cmd: 'emotion' },
  ],
  expression: [
    { cmd: 'expression', id: 'F_JITO' },
    { cmd: 'expression', id: null },
    { cmd: 'expression' },
  ],
  overlay: [
    { cmd: 'overlay', id: 'FX_BLUSH' },
    { cmd: 'overlay', id: 'FX_BLUSH', weight: 0.35 },
    { cmd: 'overlay', id: 'FX_BLUSH', on: false },
  ],
  reset: [{ cmd: 'reset' }, { cmd: 'reset', id: 'c-3' }],
  perform: [
    { cmd: 'perform', id: 'happy' },
    { cmd: 'perform', id: 'wave', side: 'L' },
    { cmd: 'perform', id: null },
    { cmd: 'perform' },
  ],
  gesture: [
    { cmd: 'gesture', id: 'wave' },
    { cmd: 'gesture', id: 'peace', side: 'R' },
    { cmd: 'gesture' },
  ],
  hop: [{ cmd: 'hop', hop: 'bounce' }, { cmd: 'hop', id: 'c-4' }, { cmd: 'hop' }],
  point: [
    { cmd: 'point', side: 'L', azimuth: 40, elevation: -10, extent: 0.5, finger: 'thumb' },
    { cmd: 'point', azimuth: 0 },
    { cmd: 'point' },
  ],
  look: [{ cmd: 'look', amount: 0 }, { cmd: 'look', amount: 1 }, { cmd: 'look' }],
  idle: [{ cmd: 'idle', on: true }, { cmd: 'idle', on: false }, { cmd: 'idle' }],
  debug: [{ cmd: 'debug', on: true }, { cmd: 'debug', on: false }, { cmd: 'debug' }],
  camera: [
    { cmd: 'camera', frame: 'face' },
    { cmd: 'camera', frame: 'bust' },
    { cmd: 'camera', frame: 'upper' },
    { cmd: 'camera', frame: 'full' },
    { cmd: 'camera', frame: 'full', yaw: -30, pitch: 12, zoom: 1.4 },
    // What a drag on the panel's preview sends: where the operator is standing,
    // and nothing about how much of the character is in shot.
    { cmd: 'camera', yaw: 18, zoom: 0.8 },
    { cmd: 'camera' },
  ],
  wear: [
    { cmd: 'wear', slot: 'top', item: 'shirt' },
    { cmd: 'wear', slot: 'top', item: null },
    { cmd: 'wear', preset: 'default' },
    { cmd: 'wear' },
  ],
  room: [{ cmd: 'room', id: 'hall' }, { cmd: 'room', id: null }, { cmd: 'room' }],
  backdrop: [{ cmd: 'backdrop', id: 'night' }, { cmd: 'backdrop', id: null }, { cmd: 'backdrop' }],
  deck: [
    { cmd: 'deck', id: 'intro' },
    { cmd: 'deck', id: 'intro', page: 4 },
    { cmd: 'deck', id: null },
    { cmd: 'deck' },
  ],
  slide: [
    { cmd: 'slide', page: 7 },
    { cmd: 'slide', by: 1 },
    { cmd: 'slide', by: -1 },
    { cmd: 'slide', id: 'c-6', page: 2, by: 3 },
    { cmd: 'slide' },
  ],
  place: [
    { cmd: 'place', avatar: { anchor: 'bottom-right', width: 0.35 } },
    { cmd: 'place', slide: { anchor: 'center', width: 1, height: 1, fit: 'contain' } },
    {
      cmd: 'place',
      id: 'c-7',
      avatar: { anchor: 'left', width: 0.4, height: 0.9, margin: 0.05 },
      slide: { anchor: 'right', width: 0.6, height: 0.8, margin: 0.02, fit: 'cover' },
    },
    { cmd: 'place' },
  ],
  queue: [
    { cmd: 'queue', turns: [] },
    {
      cmd: 'queue',
      turns: [{ text: 'ひとつめ' }, { id: 'q1', text: 'ふたつめ', perform: 'hello' }],
    },
  ],
  voice: [
    { cmd: 'voice', preset: 'bright-idol' },
    { cmd: 'voice', preset: null },
    { cmd: 'voice', dsp: { retune: { semitones: 3 }, eq: { airDb: 2 } } },
    { cmd: 'voice' },
  ],
  avatar: [{ cmd: 'avatar', id: 'sample' }],
  tune: [
    { cmd: 'tune', idle: { breathDepth: 1.2 } },
    { cmd: 'tune', sway: { enabled: false }, settle: true },
    {
      cmd: 'tune',
      id: 'c-5',
      idle: {
        breathDepth: 1,
        breathPeriod: 4.5,
        idleAmount: 0.8,
        weightShift: 1,
        gazeAmount: 1.1,
        eyeLimit: 0.6,
        blink: true,
      },
      sway: { enabled: true, stiffness: 1.5, inertia: 0.9, gravity: 1 },
      hop: { height: 0.12, gravity: 9.8 },
      tail: { amount: 2 },
      render: { toon: true, arkit: false },
      settle: false,
    },
    { cmd: 'tune' },
  ],
  bgm: [
    { cmd: 'bgm' },
    { cmd: 'bgm', action: 'play', track: 'opening.mp3', volume: 0.2, loop: true },
    {
      cmd: 'bgm',
      dsp: { toneDb: 1, reverb: { mix: 0.35, decay: 0.7, damping: 0.4 } },
      fade: { inSeconds: 0.25 },
    },
    {
      cmd: 'bgm',
      action: 'pause',
      track: 'opening.flac',
      volume: 0,
      loop: false,
      revision: 7,
      transport: 'paused',
      position: 12.5,
      at: 1_700_000_000,
    },
    { cmd: 'bgm', track: null },
  ],
};

/** The `cmd` tags the union actually carries. */
export const unionTags = commandSchema.options.map((option) => option.shape.cmd.value).sort();
