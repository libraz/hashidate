import { describe, expect, it } from 'vitest';
import { TUNING_RANGES } from '@/engine/tuning';
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
  camera: [
    { cmd: 'camera', frame: 'face' },
    { cmd: 'camera', frame: 'bust' },
    { cmd: 'camera', frame: 'upper' },
    { cmd: 'camera', frame: 'full' },
  ],
  wear: [
    { cmd: 'wear', slot: 'top', item: 'shirt' },
    { cmd: 'wear', slot: 'top', item: null },
    { cmd: 'wear', preset: 'default' },
    { cmd: 'wear' },
  ],
  room: [{ cmd: 'room', id: 'hall' }, { cmd: 'room', id: null }, { cmd: 'room' }],
  backdrop: [{ cmd: 'backdrop', id: 'night' }, { cmd: 'backdrop', id: null }, { cmd: 'backdrop' }],
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
      { cmd: 'camera' },
      { cmd: 'camera', frame: 'macro' },
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
