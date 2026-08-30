import { describe, expect, it } from 'vitest';
import {
  bgmCommandSchema,
  bgmTrackIdSchema,
  isPayloadIdCommand,
  PAYLOAD_ID_COMMAND_NAMES,
  PAYLOAD_ID_COMMANDS,
  parseCommand,
  parseInlineCue,
} from '@/protocol';
import { SWITCH_CASES, unionTags } from './cases';

/**
 * The union itself: that it carries exactly the verbs the control client
 * switches on, and that an unknown one degrades rather than throwing.
 */

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

describe('payload-id command vocabulary', () => {
  it('contains exactly the commands whose id belongs to the payload', () => {
    const expected = [
      'expression',
      'overlay',
      'gesture',
      'perform',
      'avatar',
      'room',
      'backdrop',
      'deck',
    ] as const;
    expect(PAYLOAD_ID_COMMAND_NAMES).toEqual(expected);
    expect([...PAYLOAD_ID_COMMANDS]).toEqual(expected);
    expect(expected.every((cmd) => isPayloadIdCommand(cmd))).toBe(true);
    expect(isPayloadIdCommand('slide')).toBe(false);
    const room = parseCommand({ cmd: 'room', id: null });
    expect(room && isPayloadIdCommand(room)).toBe(true);
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

  it('shares one validated track id format between commands and cues', () => {
    for (const track of ['opening.mp3', '日本語の曲 name.flac']) {
      expect(bgmTrackIdSchema.safeParse(track).success, track).toBe(true);
      expect(parseCommand({ cmd: 'bgm', action: 'play', track })).toMatchObject({ track });
      expect(parseInlineCue(`@bgm play ${track}`)).toMatchObject({ track });
    }
    for (const track of [
      'opening',
      'opening.wav',
      '.opening.mp3',
      'sub/opening.mp3',
      'opening\u0085.mp3',
      'opening\u009f.mp3',
    ]) {
      expect(bgmTrackIdSchema.safeParse(track).success, track).toBe(false);
      expect(parseCommand({ cmd: 'bgm', action: 'play', track })).toBeNull();
      expect(parseInlineCue(`@bgm play ${track}`)).toBeNull();
    }
  });

  it('strips unknown BGM DSP and fade fields, including nested ones', () => {
    expect(
      bgmCommandSchema.parse({
        cmd: 'bgm',
        dsp: { toneDb: -6, future: true, reverb: { mix: 0.2, timeMs: 640 } },
        fade: { inSeconds: 1, curve: 'equal-power' },
        future: 'ignored',
      }),
    ).toEqual({
      cmd: 'bgm',
      dsp: { toneDb: -6, reverb: { mix: 0.2 } },
      fade: { inSeconds: 1 },
    });
    expect(bgmCommandSchema.safeParse({ cmd: 'bgm', dsp: { toneDb: -6, width: 2 } }).success).toBe(
      true,
    );
  });

  it('bounds crossfade patches and accepts zero for a hard switch', () => {
    expect(
      bgmCommandSchema.safeParse({ cmd: 'bgm', fade: { inSeconds: 0, outSeconds: 10 } }).success,
    ).toBe(true);
    for (const value of [-0.001, 10.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(bgmCommandSchema.safeParse({ cmd: 'bgm', fade: { inSeconds: value } }).success).toBe(
        false,
      );
      expect(bgmCommandSchema.safeParse({ cmd: 'bgm', fade: { outSeconds: value } }).success).toBe(
        false,
      );
    }
    expect(
      bgmCommandSchema.parse({ cmd: 'bgm', fade: { inSeconds: 1, curve: 'equal-power' } }),
    ).toEqual({ cmd: 'bgm', fade: { inSeconds: 1 } });
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
