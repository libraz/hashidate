import { describe, expect, it } from 'vitest';
import { parseLine } from '@/engine/cues';
import { isWellFormed, parseInlineCue, sessionEventSchema, turnSchema } from '@/protocol';

describe('structured BGM cues', () => {
  const settings = {
    action: 'play',
    track: '日本語の曲  name.mp3',
    volume: 0.12,
    loop: false,
    fade: { inSeconds: 2, outSeconds: 3 },
    dsp: {
      toneDb: -2,
      compression: 0.4,
      width: 0.7,
      reverb: { mix: 0.2, decay: 0.6 },
      pitch: { semitones: 12, mix: 1 },
      presence: { amount: 0.8, drive: 4, frequencyHz: 4200 },
    },
  };
  const markup = `@bgm set ${JSON.stringify(settings)}`;

  it('keeps one compound patch through the text and event boundaries', () => {
    const action = parseInlineCue(markup);
    expect(action).toEqual({ kind: 'bgm', action: 'set', settings });
    const text = `あ[${markup}]いう`;
    expect(turnSchema.safeParse({ text }).success).toBe(true);
    const line = parseLine(text);
    expect(line.text).toBe('あいう');
    expect(line.cues).toHaveLength(1);
    expect(line.cues[0].action).toEqual(action);
    expect(line.cues[0].at).toBeGreaterThan(0);
    expect(line.cues[0].at).toBeLessThan(1);
    const event = { type: 'cue.fire', turn: 'line', cueId: 'line:cue:0', cue: action };
    expect(sessionEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    { volume: 0 },
    { loop: false },
    { track: null },
    { track: 'opening.mp3' },
    { action: 'stop', fade: { outSeconds: 4 } },
    { dsp: { reverb: { mix: 0 } } },
    { dsp: { pitch: { semitones: 12 } } },
    { dsp: { presence: { frequencyHz: 4200 } } },
  ])('accepts a meaningful partial patch %j', (patch) => {
    expect(parseInlineCue(`@bgm set ${JSON.stringify(patch)}`)).toEqual({
      kind: 'bgm',
      action: 'set',
      settings: patch,
    });
  });

  it.each([
    '{}',
    '{"dsp":{}}',
    '{"dsp":{"reverb":{}}}',
    '{"fade":{}}',
    '{"volume":1.1}',
    '{"volume":1e999}',
    '{"loop":"false"}',
    '{"fade":{"outSeconds":11}}',
    '{"dsp":{"width":3}}',
    '{"dsp":{"reverb":{"mix":0.6}}}',
    '{"dsp":{"reverb":{"typo":0.2}}}',
    '{"dsp":{"pitch":{}}}',
    '{"dsp":{"pitch":{"semitones":25}}}',
    '{"dsp":{"pitch":{"mix":1.1}}}',
    '{"dsp":{"pitch":{"typo":0.2}}}',
    '{"dsp":{"presence":{}}}',
    '{"dsp":{"presence":{"drive":9}}}',
    '{"dsp":{"presence":{"frequencyHz":499}}}',
    '{"dsp":{"presence":{"typo":0.2}}}',
    '{"dsp":{"unknown":1}}',
    '{"fade":{"unknown":1}}',
    '{"action":"settings"}',
    '{"track":"../opening.mp3"}',
    '{"revision":10,"volume":0.2}',
    '{"transport":"playing","volume":0.2}',
    '{"position":10,"volume":0.2}',
    '{"at":10,"volume":0.2}',
    '{"cmd":"bgm","volume":0.2}',
    '{"id":"caller","volume":0.2}',
    '{"kind":"camera","volume":0.2}',
    '{"volume":0.2,}',
    'null',
    '[]',
    '{"volume":0.2,"dsp":{"reverb":{}}}',
    '{"volume":0.2,"dsp":{"pitch":{}}}',
    '',
  ])('rejects malformed or ineffective patch %s at both boundaries', (json) => {
    const cue = `@bgm set ${json}`;
    expect(parseInlineCue(cue)).toBeNull();
    const text = `あ[${cue}]い`;
    expect(isWellFormed(text)).toBe(false);
    expect(turnSchema.safeParse({ text }).success).toBe(false);
    expect(parseLine(text).text).toBe('あい');
  });

  it('keeps the entire legacy filename as the track id', () => {
    expect(parseInlineCue('@bgm play set {volume=0.2}  日本語.mp3')).toEqual({
      kind: 'bgm',
      action: 'play',
      track: 'set {volume=0.2}  日本語.mp3',
    });
  });
});
