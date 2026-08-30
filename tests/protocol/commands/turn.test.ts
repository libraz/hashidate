import { describe, expect, it } from 'vitest';
import { parseCommand } from '@/protocol';

/**
 * A line, and the cues written into it.
 */

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

  it('rejects an empty reading instead of treating it as a pronunciation', () => {
    expect(parseCommand({ cmd: 'say', text: 'あ', reading: '' })).toBeNull();
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

  it('accepts typed cues without rewriting the source text', () => {
    const text =
      '導入[@gesture big wave][@camera bust]です[@slide 2][@bgm play 日本語の曲 name.mp3][@bgm pause]';
    expect(parseCommand({ cmd: 'say', text })).toEqual({ cmd: 'say', text });
  });

  it.each([
    '導入[@unknown value]です',
    '導入[@perform]です',
    '導入[@camera]です',
    '導入[@camera wide]です',
    '導入[@slide 0]です',
    '導入[@slide 1.5]です',
    '導入[@bgm rewind]です',
    '導入[@bgm stop song.mp3]です',
    '導入[@bgm play song.wav]です',
  ])('rejects malformed typed cue markup %j', (text) => {
    expect(parseCommand({ cmd: 'say', text })).toBeNull();
  });
});
