import { describe, expect, it } from 'vitest';
import { TUNING_RANGES } from '@/engine/tuning';
import type { Anchor } from '@/engine/types';
import { PLACEMENT_LIMITS } from '@/engine/types';
import type { Command, CommandName } from '@/protocol';
import { commandSchema, parseCommand } from '@/protocol';

/**
 * The command vocabulary as it travels on the wire.
 *
 * The set pinned here is the set `viewer/control-client.ts` switches on: one
 * command is one session call, so a verb that parses but has no case there, or
 * a case with no verb here, is a hole in the control path.
 */

/** Every case in the control client's `apply` switch, with a payload for each. */
const SWITCH_CASES: Record<CommandName, Command[]> = {
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
  perform: [{ cmd: 'perform', id: 'happy' }, { cmd: 'perform', id: null }, { cmd: 'perform' }],
  gesture: [{ cmd: 'gesture', id: 'wave' }, { cmd: 'gesture' }],
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
};

/** The `cmd` tags the union actually carries. */
const unionTags = commandSchema.options.map((option) => option.shape.cmd.value).sort();

describe('the command set', () => {
  it('carries exactly the verbs the control client switches on', () => {
    expect(unionTags).toEqual(Object.keys(SWITCH_CASES).sort());
  });

  for (const [name, payloads] of Object.entries(SWITCH_CASES)) {
    it(`round-trips every ${name} payload unchanged`, () => {
      for (const payload of payloads) {
        expect(parseCommand(payload)).toEqual(payload);
      }
    });
  }

  it('round-trips through JSON, since the wire carries text', () => {
    for (const payloads of Object.values(SWITCH_CASES)) {
      for (const payload of payloads) {
        expect(parseCommand(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
      }
    }
  });
});

describe('parseCommand degrading rather than throwing', () => {
  it('returns null for a value that is not a command at all', () => {
    for (const junk of [undefined, null, 0, 'say', true, [], {}, [{ cmd: 'say' }], 'null']) {
      expect(parseCommand(junk)).toBeNull();
    }
  });

  it('returns null for a verb this renderer does not know', () => {
    expect(parseCommand({ cmd: 'teleport', to: 'stage' })).toBeNull();
    expect(parseCommand({ cmd: 'Say', text: 'hi' })).toBeNull();
    expect(parseCommand({ text: 'hi' })).toBeNull();
  });

  it('returns null for a known verb with a malformed payload', () => {
    const malformed: unknown[] = [
      { cmd: 'say', text: 42 },
      { cmd: 'say', emotion: { euphoria: 1 } },
      { cmd: 'say', hold: 'yes' },
      { cmd: 'overlay' },
      { cmd: 'overlay', id: 'FX_BLUSH', weight: 1.5 },
      { cmd: 'overlay', id: 'FX_BLUSH', weight: -0.1 },
      { cmd: 'camera', frame: 'macro' },
      { cmd: 'camera', yaw: 400 },
      { cmd: 'camera', pitch: 90 },
      { cmd: 'camera', zoom: 0 },
      { cmd: 'camera', zoom: 12 },
      { cmd: 'point', side: 'left' },
      { cmd: 'point', azimuth: Number.POSITIVE_INFINITY },
      { cmd: 'point', azimuth: Number.NaN },
      { cmd: 'point', finger: 'pinky' },
      { cmd: 'look', amount: 2 },
      { cmd: 'idle', on: 1 },
      { cmd: 'expression', id: 7 },
      { cmd: 'wear', slot: 3 },
      { cmd: 'avatar' },
      { cmd: 'avatar', id: null },
      { cmd: 'deck', page: 0 },
      { cmd: 'deck', page: 2.5 },
      { cmd: 'deck', id: 7 },
      { cmd: 'slide', page: 0 },
      { cmd: 'slide', by: 0.5 },
      { cmd: 'place', avatar: { anchor: 'middle' } },
      { cmd: 'place', slide: { fit: 'stretch' } },
      { cmd: 'place', avatar: { width: 0 } },
      { cmd: 'tune', idle: { breathPeriod: 0 } },
      { cmd: 'tune', sway: { stiffness: 99 } },
      { cmd: 'tune', render: { toon: 'on' } },
    ];
    for (const value of malformed) expect(parseCommand(value)).toBeNull();
  });

  it('strips a field a newer caller added rather than rejecting the command', () => {
    expect(parseCommand({ cmd: 'say', text: 'あ', urgency: 'high' })).toEqual({
      cmd: 'say',
      text: 'あ',
    });
  });

  it('rejects an unknown emotion name instead of half-applying the blend', () => {
    expect(parseCommand({ cmd: 'emotion', vec: { joy: 1, smug: 1 } })).toBeNull();
  });
});

describe('commands whose absent argument means stop', () => {
  it('gesture with no id parses, because the release is not a second verb', () => {
    expect(parseCommand({ cmd: 'gesture' })).toEqual({ cmd: 'gesture' });
  });

  it('point with neither angle parses, and means release the arm', () => {
    const parsed = parseCommand({ cmd: 'point' });
    expect(parsed).toEqual({ cmd: 'point' });
    expect((parsed as { azimuth?: number }).azimuth).toBeUndefined();
    expect((parsed as { elevation?: number }).elevation).toBeUndefined();
  });

  it('point with only a side and no angle still means release', () => {
    expect(parseCommand({ cmd: 'point', side: 'L' })).toEqual({ cmd: 'point', side: 'L' });
  });
});

describe('overlay', () => {
  it('accepts a partial weight', () => {
    expect(parseCommand({ cmd: 'overlay', id: 'FX_TEARS', weight: 0.25 })).toEqual({
      cmd: 'overlay',
      id: 'FX_TEARS',
      weight: 0.25,
    });
  });

  it('accepts on: false as the short way of saying weight 0', () => {
    expect(parseCommand({ cmd: 'overlay', id: 'FX_TEARS', on: false })).toEqual({
      cmd: 'overlay',
      id: 'FX_TEARS',
      on: false,
    });
  });

  it('accepts both bounds of the weight range', () => {
    expect(parseCommand({ cmd: 'overlay', id: 'x', weight: 0 })).not.toBeNull();
    expect(parseCommand({ cmd: 'overlay', id: 'x', weight: 1 })).not.toBeNull();
  });
});

describe('emotion', () => {
  it('accepts the weights under vec', () => {
    expect(parseCommand({ cmd: 'emotion', vec: { joy: 0.6 } })).toEqual({
      cmd: 'emotion',
      vec: { joy: 0.6 },
    });
  });

  it('accepts the same weights under emotion', () => {
    expect(parseCommand({ cmd: 'emotion', emotion: { joy: 0.6 } })).toEqual({
      cmd: 'emotion',
      emotion: { joy: 0.6 },
    });
  });

  it('keeps both spellings when both are given, so the applier can prefer vec', () => {
    expect(parseCommand({ cmd: 'emotion', vec: { joy: 1 }, emotion: { anger: 1 } })).toEqual({
      cmd: 'emotion',
      vec: { joy: 1 },
      emotion: { anger: 1 },
    });
  });

  it('accepts every canonical emotion name', () => {
    const names = ['neutral', 'joy', 'anger', 'sadness', 'surprise', 'relaxed', 'thinking', 'shy'];
    for (const name of names) {
      expect(parseCommand({ cmd: 'emotion', vec: { [name]: 1 } })).not.toBeNull();
    }
  });

  it('does not bound the weights, because the consuming layers normalise', () => {
    expect(parseCommand({ cmd: 'emotion', vec: { joy: 4, anger: -1 } })).toEqual({
      cmd: 'emotion',
      vec: { joy: 4, anger: -1 },
    });
  });
});

describe('point angles', () => {
  it('accepts a bearing past the anatomical range, so strain can report the cost', () => {
    // Rejecting these would take away the only way a caller can tell an aim the
    // arm met from one it could only approximate.
    expect(parseCommand({ cmd: 'point', azimuth: 400, elevation: -900 })).toEqual({
      cmd: 'point',
      azimuth: 400,
      elevation: -900,
    });
  });

  it('accepts an extent outside the range the solver clamps to', () => {
    expect(parseCommand({ cmd: 'point', azimuth: 10, extent: 12 })).toEqual({
      cmd: 'point',
      azimuth: 10,
      extent: 12,
    });
  });

  it('accepts the advertised bounds themselves', () => {
    for (const azimuth of [-120, 120]) {
      for (const elevation of [-70, 110]) {
        expect(parseCommand({ cmd: 'point', azimuth, elevation })).not.toBeNull();
      }
    }
  });
});

describe('expression', () => {
  it('parses null, which hands the face back to the emotion vector', () => {
    expect(parseCommand({ cmd: 'expression', id: null })).toEqual({
      cmd: 'expression',
      id: null,
    });
  });

  it('distinguishes an explicit null from an absent id only by presence', () => {
    const explicit = parseCommand({ cmd: 'expression', id: null }) as { id?: string | null };
    const absent = parseCommand({ cmd: 'expression' }) as { id?: string | null };
    expect(explicit.id).toBeNull();
    expect('id' in absent).toBe(false);
  });

  it('spends id on the expression rather than on correlation', () => {
    expect(parseCommand({ cmd: 'expression', id: 'F_DOYA' })).toEqual({
      cmd: 'expression',
      id: 'F_DOYA',
    });
  });
});

describe('say', () => {
  it('carries the turn id under the same field the events come back on', () => {
    const parsed = parseCommand({ cmd: 'say', id: 'turn-9', text: 'あ' });
    expect(parsed).toMatchObject({ id: 'turn-9' });
  });

  it('carries a shot alongside the line', () => {
    const parsed = parseCommand({
      cmd: 'say',
      text: 'あ',
      stage: { camera: 'full', backdrop: 'night', room: 'hall' },
    });
    expect(parsed).toMatchObject({ stage: { camera: 'full', backdrop: 'night', room: 'hall' } });
  });

  // The distinction the engine acts on: an absent axis keeps what it had, a
  // null one is emptied. A schema that defaulted either way would make one of
  // the two unsayable, and it is the kind of thing a later `??` deletes.
  it('keeps an omitted staging axis omitted and a null one null', () => {
    expect(parseCommand({ cmd: 'say', text: 'あ', stage: { room: null } })).toEqual({
      cmd: 'say',
      text: 'あ',
      stage: { room: null },
    });
    expect(parseCommand({ cmd: 'say', text: 'あ', stage: {} })).toEqual({
      cmd: 'say',
      text: 'あ',
      stage: {},
    });
  });

  it('refuses a framing the renderer does not have', () => {
    expect(parseCommand({ cmd: 'say', text: 'あ', stage: { camera: 'closeup' } })).toBeNull();
  });

  it('carries the document and the page the line is delivered on', () => {
    const stage = { deck: 'intro', slide: 4 };
    expect(parseCommand({ cmd: 'say', text: 'あ', stage })).toEqual({
      cmd: 'say',
      text: 'あ',
      stage,
    });
  });

  it('carries a null deck, which is the line that takes the document down', () => {
    // The same absent/null split the backdrop follows: no `deck` key leaves
    // whatever is up alone, `deck: null` puts it away for this line onward.
    expect(parseCommand({ cmd: 'say', text: 'あ', stage: { deck: null } })).toEqual({
      cmd: 'say',
      text: 'あ',
      stage: { deck: null },
    });
  });

  it('carries the layout the line is delivered in, both halves', () => {
    const stage = {
      deck: 'intro',
      place: {
        avatar: { anchor: 'bottom-right' as const, width: 0.26, height: 0.54, margin: 0.015 },
        slide: { fit: 'contain' as const },
      },
    };
    expect(parseCommand({ cmd: 'say', text: 'あ', stage })).toEqual({
      cmd: 'say',
      text: 'あ',
      stage,
    });
  });

  it('carries one field of a layout on its own, so a line moves what it names', () => {
    const stage = { place: { avatar: { anchor: 'bottom-right' as const } } };
    expect(parseCommand({ cmd: 'say', text: 'あ', stage })).toEqual({
      cmd: 'say',
      text: 'あ',
      stage,
    });
  });

  it('refuses a layout the frame has no room for, exactly as place does', () => {
    for (const avatar of [{ anchor: 'middle' }, { width: 0 }, { width: 2 }, { margin: -1 }]) {
      expect(
        parseCommand({ cmd: 'say', text: 'あ', stage: { place: { avatar } } }),
        JSON.stringify(avatar),
      ).toBeNull();
    }
  });

  // `fit` is how a picture fills its rectangle, which the character's does not
  // have — it is a render of a scene rather than an image with edges.
  it('has no fit on the character half of a layout', () => {
    const parsed = parseCommand({
      cmd: 'say',
      text: 'あ',
      stage: { place: { avatar: { fit: 'cover' } } },
    });
    expect(parsed).toEqual({ cmd: 'say', text: 'あ', stage: { place: { avatar: {} } } });
  });

  it('refuses a page that is not a page', () => {
    for (const slide of [0, -1, 1.5, '2', null]) {
      expect(
        parseCommand({ cmd: 'say', text: 'あ', stage: { slide } }),
        `slide=${slide}`,
      ).toBeNull();
    }
  });

  // A queued line can be dropped, reordered or sent round again, so "the next
  // page" written into one means a different page every time the script is
  // edited. This test is here to fail if a relative form is ever added.
  it('has no relative page on a line, so a by written into one is not carried', () => {
    expect(parseCommand({ cmd: 'say', text: 'あ', stage: { by: 1 } })).toEqual({
      cmd: 'say',
      text: 'あ',
      stage: {},
    });
  });

  it('leaves a line with no staging without the key', () => {
    expect(parseCommand({ cmd: 'say', text: 'あ' })).toEqual({ cmd: 'say', text: 'あ' });
  });

  // The four combinations of the two fields, in full: the space is small enough
  // that enumerating it beats sampling it, and `reading ?? text` is exactly the
  // kind of fallback that gets one of the four wrong.
  it.each([
    { text: '3件', reading: 'さんけん' },
    { text: '3件', reading: undefined },
    { text: undefined, reading: 'さんけん' },
    { text: undefined, reading: undefined },
  ])('carries text and reading independently ($text / $reading)', ({ text, reading }) => {
    const parsed = parseCommand({ cmd: 'say', text, reading });
    expect(parsed).toEqual({
      cmd: 'say',
      ...(text === undefined ? {} : { text }),
      ...(reading === undefined ? {} : { reading }),
    });
  });

  it('rejects a non-string reading rather than dropping it, so a bad one is loud', () => {
    expect(parseCommand({ cmd: 'say', text: 'あ', reading: 42 })).toBeNull();
  });

  it('accepts an explicit null emotion, which is not the same as omitting it', () => {
    expect(parseCommand({ cmd: 'say', text: 'あ', emotion: null })).toEqual({
      cmd: 'say',
      text: 'あ',
      emotion: null,
    });
  });

  it('accepts an empty text, which is a pose change rather than a line', () => {
    expect(parseCommand({ cmd: 'say', text: '', gesture: 'nod' })).toEqual({
      cmd: 'say',
      text: '',
      gesture: 'nod',
    });
  });
});

describe('cues in a line', () => {
  it('carries the markup through untouched, because the renderer is what strips it', () => {
    // The wire is not the place to take it out. The server forwards a parsed
    // command on unchanged, so a schema that transformed here would hand the
    // viewer a line the caller never sent.
    const text = '[hello]こんばんは。[explain]今日はこの話をします。';
    expect(parseCommand({ cmd: 'say', text })).toEqual({ cmd: 'say', text });
  });

  it('accepts an id no performance table has, exactly as `perform` does', () => {
    // Ids are avatar- and engine-data on this wire and stay plain strings. A cue
    // held to a stricter rule than the field it is the inline form of would be a
    // second vocabulary to keep in step.
    expect(parseCommand({ cmd: 'say', text: '[nosuchthing]あ' })).toMatchObject({
      text: '[nosuchthing]あ',
    });
    expect(parseCommand({ cmd: 'say', text: 'あ', perform: 'nosuchthing' })).toMatchObject({
      perform: 'nosuchthing',
    });
  });

  it.each([
    ['unclosed', 'こんばんは[happy'],
    ['unopened', 'こんばんは]です'],
    ['empty', 'あ[]い'],
    ['not an id', 'あ[笑]い'],
    ['spaced', 'あ[hello world]い'],
    ['nested', 'あ[hello[explain]い'],
    ['doubled', 'あ[[hello]]い'],
  ])('drops a say whose markup is %s, so nothing of it is read out', (_kind, text) => {
    // Dropped and not repaired. The renderer would strip it safely either way —
    // nothing in brackets is ever spoken — but silently saying less than was
    // written is its own failure, and a dropped command is one the caller is
    // told about: a batch of only this answers 400.
    expect(parseCommand({ cmd: 'say', text })).toBeNull();
  });

  it('refuses a bracket in the reading rather than removing it', () => {
    // A cue is a position in the line and the reading is not the line. One
    // written here would do nothing at all, which is worse than being refused.
    expect(parseCommand({ cmd: 'say', text: 'あ', reading: '[happy]あ' })).toBeNull();
    expect(parseCommand({ cmd: 'say', text: '[happy]あ', reading: 'あ' })).toMatchObject({
      reading: 'あ',
    });
  });
});

describe('tune', () => {
  it('carries one fader on its own, because that is what a drag sends', () => {
    expect(parseCommand({ cmd: 'tune', sway: { stiffness: 1.4 } })).toEqual({
      cmd: 'tune',
      sway: { stiffness: 1.4 },
    });
  });

  it('leaves an untouched group absent rather than filling it in', () => {
    // Absent means "leave it" everywhere on this wire. A default landing here
    // would make every knob turn also reset the four groups it did not name.
    const parsed = parseCommand({ cmd: 'tune', idle: { blink: false } }) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['cmd', 'idle']);
    expect((parsed.idle as Record<string, unknown>).breathDepth).toBeUndefined();
  });

  it.each([
    ['idle', 'breathDepth', TUNING_RANGES.idle.breathDepth],
    ['idle', 'breathPeriod', TUNING_RANGES.idle.breathPeriod],
    ['idle', 'eyeLimit', TUNING_RANGES.idle.eyeLimit],
    ['sway', 'stiffness', TUNING_RANGES.sway.stiffness],
    ['sway', 'inertia', TUNING_RANGES.sway.inertia],
    ['hop', 'height', TUNING_RANGES.hop.height],
    ['hop', 'gravity', TUNING_RANGES.hop.gravity],
    ['tail', 'amount', TUNING_RANGES.tail.amount],
  ])('accepts both ends of %s.%s and refuses either side of them', (group, field, range) => {
    // The bounds a panel sweeps and the bounds the wire accepts are the same
    // object, so a fader that reaches its end cannot send something refused.
    for (const value of [range.min, range.max]) {
      expect(parseCommand({ cmd: 'tune', [group]: { [field]: value } })).not.toBeNull();
    }
    for (const value of [range.min - 0.01, range.max + 0.01]) {
      expect(parseCommand({ cmd: 'tune', [group]: { [field]: value } })).toBeNull();
    }
  });

  it('carries settle, which is the one verb in a patch of values', () => {
    expect(parseCommand({ cmd: 'tune', settle: true })).toEqual({ cmd: 'tune', settle: true });
  });

  it('parses with no groups at all, which asks for nothing and is not an error', () => {
    expect(parseCommand({ cmd: 'tune' })).toEqual({ cmd: 'tune' });
  });
});

describe('camera', () => {
  it('takes a framing on its own, which is what a script sends', () => {
    expect(parseCommand({ cmd: 'camera', frame: 'full' })).toEqual({
      cmd: 'camera',
      frame: 'full',
    });
  });

  it('takes an offset with no framing, which is what a drag sends', () => {
    // Absent means "leave it": naming a framing must not straighten a shot
    // somebody tilted, and tilting one must not change how much is in frame.
    expect(parseCommand({ cmd: 'camera', yaw: -22.5, zoom: 1.25 })).toEqual({
      cmd: 'camera',
      yaw: -22.5,
      zoom: 1.25,
    });
  });

  it('accepts both ends of every offset and refuses either side', () => {
    for (const [field, min, max] of [
      ['yaw', -180, 180],
      ['pitch', -85, 85],
      ['zoom', 0.25, 4],
    ] as const) {
      for (const value of [min, max]) {
        expect(parseCommand({ cmd: 'camera', [field]: value }), `${field}=${value}`).not.toBeNull();
      }
      for (const value of [min - 0.01, max + 0.01]) {
        expect(parseCommand({ cmd: 'camera', [field]: value }), `${field}=${value}`).toBeNull();
      }
    }
  });

  it('parses with nothing at all, which asks for nothing and is not an error', () => {
    expect(parseCommand({ cmd: 'camera' })).toEqual({ cmd: 'camera' });
  });
});

describe('deck', () => {
  it('spends id on the document rather than on correlation', () => {
    // The file's own stem, and it travels untouched: a server that stamped a
    // correlation id into this field would ask the renderer for a document
    // nobody has.
    const id = '2026年-まとめ.第一部';
    expect(parseCommand({ cmd: 'deck', id })).toEqual({ cmd: 'deck', id });
  });

  it('opens the document at a page when one is given', () => {
    expect(parseCommand({ cmd: 'deck', id: 'intro', page: 12 })).toEqual({
      cmd: 'deck',
      id: 'intro',
      page: 12,
    });
  });

  it('leaves the page absent rather than filling in the first one', () => {
    // Absent is the first page to whoever applies it. Defaulting here would put
    // a number on the wire the caller never said, and the server forwards a
    // parsed command on unchanged.
    const parsed = parseCommand({ cmd: 'deck', id: 'intro' }) as { page?: number };
    expect(parsed.page).toBeUndefined();
  });

  it('parses null, which takes the document down', () => {
    expect(parseCommand({ cmd: 'deck', id: null })).toEqual({ cmd: 'deck', id: null });
  });

  it('accepts an id the renderer may not be able to open', () => {
    // What documents exist is a directory listing, not vocabulary. A name a
    // minute out of date is the ordinary case, and it is reported rather than
    // refused here where there is nothing to report it against.
    expect(parseCommand({ cmd: 'deck', id: 'nosuchdeck' })).toMatchObject({ id: 'nosuchdeck' });
  });

  it('refuses a page that is not one, at either end of the mistake', () => {
    expect(parseCommand({ cmd: 'deck', id: 'intro', page: 0 })).toBeNull();
    expect(parseCommand({ cmd: 'deck', id: 'intro', page: -1 })).toBeNull();
    expect(parseCommand({ cmd: 'deck', id: 'intro', page: 1.5 })).toBeNull();
  });
});

describe('slide', () => {
  it('takes an absolute page, which is what a script has', () => {
    expect(parseCommand({ cmd: 'slide', page: 9 })).toEqual({ cmd: 'slide', page: 9 });
  });

  it('takes a relative move, which is what a hand on an arrow key has', () => {
    expect(parseCommand({ cmd: 'slide', by: 1 })).toEqual({ cmd: 'slide', by: 1 });
    expect(parseCommand({ cmd: 'slide', by: -1 })).toEqual({ cmd: 'slide', by: -1 });
    expect(parseCommand({ cmd: 'slide', by: -3 })).toEqual({ cmd: 'slide', by: -3 });
  });

  it('carries both when both are given, leaving the choice to whoever applies it', () => {
    // `page` wins there, not here: the schema's business is that neither is
    // dropped on the way, so the applier can see it was handed two answers.
    expect(parseCommand({ cmd: 'slide', page: 3, by: 1 })).toEqual({
      cmd: 'slide',
      page: 3,
      by: 1,
    });
  });

  it('parses with neither, which is the bare "next" an operator sends all night', () => {
    const parsed = parseCommand({ cmd: 'slide' }) as { page?: number; by?: number };
    expect(parsed).toEqual({ cmd: 'slide' });
    expect(parsed.page).toBeUndefined();
    expect(parsed.by).toBeUndefined();
  });

  it('spends id on correlation, unlike deck', () => {
    expect(parseCommand({ cmd: 'slide', id: 'c-9', by: 1 })).toEqual({
      cmd: 'slide',
      id: 'c-9',
      by: 1,
    });
  });

  it('refuses a page that is not one, while leaving by unbounded in either direction', () => {
    expect(parseCommand({ cmd: 'slide', page: 0 })).toBeNull();
    expect(parseCommand({ cmd: 'slide', page: -2 })).toBeNull();
    expect(parseCommand({ cmd: 'slide', page: 2.5 })).toBeNull();
    // Past either end of the document is clamped where the pages are known, so
    // a move of forty is a very ordinary mistake rather than a refused command.
    expect(parseCommand({ cmd: 'slide', by: 40 })).toMatchObject({ by: 40 });
  });
});

describe('place', () => {
  const ANCHORS: Anchor[] = [
    'center',
    'top-left',
    'top',
    'top-right',
    'left',
    'right',
    'bottom-left',
    'bottom',
    'bottom-right',
  ];

  it('takes the character half on its own', () => {
    expect(parseCommand({ cmd: 'place', avatar: { anchor: 'bottom-right', width: 0.3 } })).toEqual({
      cmd: 'place',
      avatar: { anchor: 'bottom-right', width: 0.3 },
    });
  });

  it('takes the document half on its own', () => {
    expect(parseCommand({ cmd: 'place', slide: { width: 0.8, fit: 'cover' } })).toEqual({
      cmd: 'place',
      slide: { width: 0.8, fit: 'cover' },
    });
  });

  it('carries one number, which is what a slider under the pointer sends', () => {
    const parsed = parseCommand({ cmd: 'place', avatar: { width: 0.5 } }) as {
      avatar?: Record<string, unknown>;
    };
    expect(parsed).toEqual({ cmd: 'place', avatar: { width: 0.5 } });
    // Absent means "leave it", never "reset it". A default landing here would
    // make every drag of the width also re-centre and re-size the layer.
    expect(parsed.avatar?.anchor).toBeUndefined();
    expect(parsed.avatar?.height).toBeUndefined();
    expect(parsed.avatar?.margin).toBeUndefined();
  });

  it('parses with neither half, which asks for nothing and is not an error', () => {
    expect(parseCommand({ cmd: 'place' })).toEqual({ cmd: 'place' });
  });

  it.each(ANCHORS)('accepts %s on both halves', (anchor) => {
    expect(parseCommand({ cmd: 'place', avatar: { anchor } })).toEqual({
      cmd: 'place',
      avatar: { anchor },
    });
    expect(parseCommand({ cmd: 'place', slide: { anchor } })).toEqual({
      cmd: 'place',
      slide: { anchor },
    });
  });

  it('refuses a position that is not one of the nine', () => {
    expect(parseCommand({ cmd: 'place', avatar: { anchor: 'middle' } })).toBeNull();
    expect(parseCommand({ cmd: 'place', slide: { anchor: 'centre' } })).toBeNull();
  });

  it.each([
    ['width', PLACEMENT_LIMITS.width],
    ['height', PLACEMENT_LIMITS.height],
    ['margin', PLACEMENT_LIMITS.margin],
  ])('accepts both ends of %s and refuses either side, on both halves', (field, range) => {
    // The bounds the panel's preview drags between and the bounds the wire
    // accepts are the same object, so a slider at its stop cannot send
    // something that is silently dropped.
    for (const half of ['avatar', 'slide'] as const) {
      for (const value of [range.min, range.max]) {
        expect(
          parseCommand({ cmd: 'place', [half]: { [field]: value } }),
          `${half}.${field}=${value}`,
        ).not.toBeNull();
      }
      for (const value of [range.min - 0.01, range.max + 0.01]) {
        expect(
          parseCommand({ cmd: 'place', [half]: { [field]: value } }),
          `${half}.${field}=${value}`,
        ).toBeNull();
      }
    }
  });

  it('has fit on the document half and nowhere else', () => {
    // How a picture fills its rectangle is a question only a picture asks. On
    // the character it is an unknown field and is stripped, like any other.
    expect(parseCommand({ cmd: 'place', slide: { fit: 'contain' } })).toEqual({
      cmd: 'place',
      slide: { fit: 'contain' },
    });
    expect(parseCommand({ cmd: 'place', avatar: { width: 0.4, fit: 'cover' } })).toEqual({
      cmd: 'place',
      avatar: { width: 0.4 },
    });
  });

  it('refuses a fit it does not have', () => {
    expect(parseCommand({ cmd: 'place', slide: { fit: 'stretch' } })).toBeNull();
  });
});

describe('the document verbs against the union', () => {
  it('narrows each of them to its own payload', () => {
    // One command is one session call, and the switch that applies them narrows
    // on `cmd`. A verb that parsed into the union without its payload being
    // reachable there would be a case that cannot be written.
    const deck = parseCommand({ cmd: 'deck', id: 'intro', page: 2 });
    if (deck?.cmd !== 'deck') throw new Error('deck did not narrow to a deck');
    expect([deck.id, deck.page]).toEqual(['intro', 2]);

    const slide = parseCommand({ cmd: 'slide', by: -1 });
    if (slide?.cmd !== 'slide') throw new Error('slide did not narrow to a slide');
    expect(slide.by).toBe(-1);

    const place = parseCommand({ cmd: 'place', slide: { fit: 'cover' } });
    if (place?.cmd !== 'place') throw new Error('place did not narrow to a place');
    expect(place.slide).toEqual({ fit: 'cover' });
  });
});

describe('avatar', () => {
  it('spends id on the avatar rather than on correlation', () => {
    expect(parseCommand({ cmd: 'avatar', id: 'sample' })).toEqual({ cmd: 'avatar', id: 'sample' });
  });

  it('requires one, because there is no sensible avatar to mean by omission', () => {
    // Unlike `expression` or `room`, where absent means "take it off". There is
    // no such thing as no avatar: the renderer would have nothing to draw.
    expect(parseCommand({ cmd: 'avatar' })).toBeNull();
  });

  it('accepts an id this renderer may not have, which it ignores when it applies', () => {
    // The roster is renderer data and travels with the vocabulary. Refusing here
    // would only move the failure to a place with less information about it.
    expect(parseCommand({ cmd: 'avatar', id: 'nosuchavatar' })).toMatchObject({
      id: 'nosuchavatar',
    });
  });
});
