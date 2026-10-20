import { describe, expect, it } from 'vitest';
import { linesFrom, pageStarts, type Script, scriptSchema } from '@/script';

/**
 * Starting a script part-way through.
 *
 * A line's page is mostly implied: setup opens the document on page 1 and a
 * line names a page only where it turns. So where each page starts, and what a
 * run started there must be told so that it looks as it would have, both come
 * from walking the script from the top.
 */

const script = (raw: unknown): Script => scriptSchema.parse(raw);

/** Setup opens the deck; the lines turn pages, move the camera and the layout. */
const talk = script({
  setup: [{ cmd: 'deck', id: 'talk' }],
  lines: [
    { text: '表紙です。', stage: { camera: 'bust' } },
    {
      text: '[@slide 2]次へ。',
      stage: { place: { avatar: { anchor: 'bottom-right', width: 0.5 } } },
    },
    { text: 'まだ 2 ページ目。[@camera full]' },
    { text: '3 ページ目。', stage: { slide: 3, place: { avatar: { margin: 0 } } } },
    { text: '終わり。', stage: { camera: 'upper' } },
  ],
});

describe('pageStarts', () => {
  it('follows setup, line stages and inline cues, in order', () => {
    expect(pageStarts(talk)).toEqual([
      { line: 0, deck: 'talk', page: 1 },
      { line: 1, deck: 'talk', page: 2 },
      { line: 3, deck: 'talk', page: 3 },
    ]);
  });

  it('opens a document named on a line at its first page, and skips lines with none', () => {
    const demo = script({
      lines: [
        { text: 'まだ資料なし。' },
        { text: '資料を出します。', stage: { deck: 'a' } },
        { text: '二枚目。', stage: { slide: 2 } },
        { text: '下げます。', stage: { deck: null } },
        { text: '別の資料。', stage: { deck: 'b', slide: 4 } },
      ],
    });
    expect(pageStarts(demo)).toEqual([
      { line: 1, deck: 'a', page: 1 },
      { line: 2, deck: 'a', page: 2 },
      { line: 4, deck: 'b', page: 4 },
    ]);
  });
});

describe('linesFrom', () => {
  it('folds what the earlier lines set into the first line, under its own stage', () => {
    const lines = linesFrom(talk, 3);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      text: '3 ページ目。',
      stage: {
        // The inline camera cue in line 2 is what the shot was left at.
        camera: 'full',
        slide: 3,
        place: { avatar: { anchor: 'bottom-right', width: 0.5, margin: 0 } },
      },
    });
    // Everything after the first line goes as written.
    expect(lines[1]).toBe(talk.lines[4]);
  });

  it('states the page it starts on, including one an inline cue turned to', () => {
    expect(linesFrom(talk, 2)[0]?.stage).toEqual({
      camera: 'bust',
      slide: 2,
      place: { avatar: { anchor: 'bottom-right', width: 0.5 } },
    });
  });

  it('starts on the page before a cue in its own line, so the cue turns it as written', () => {
    expect(linesFrom(talk, 1)[0]?.stage?.slide).toBe(1);
  });

  it('does not name a document setup opened, which would open it again', () => {
    expect(linesFrom(talk, 4)[0]?.stage).not.toHaveProperty('deck');
  });

  it('names a document an earlier line opened, or took down', () => {
    const demo = script({
      lines: [
        { text: '出します。', stage: { deck: 'a', slide: 2 } },
        { text: 'ここから。' },
        { text: '下げます。', stage: { deck: null } },
        { text: '資料なしで。' },
      ],
    });
    expect(linesFrom(demo, 1)[0]?.stage).toEqual({ deck: 'a', slide: 2 });
    expect(linesFrom(demo, 3)[0]?.stage).toEqual({ deck: null });
  });

  it('lets a line that opens its own document start at that document’s page', () => {
    const swap = script({
      setup: [{ cmd: 'deck', id: 'a', page: 5 }],
      lines: [{ text: 'a の 5。' }, { text: 'b へ。', stage: { deck: 'b' } }],
    });
    expect(linesFrom(swap, 1)[0]?.stage).toEqual({ deck: 'b' });
  });

  it('leaves a script with no document unstaged beyond what its lines set', () => {
    const plain = script({
      lines: [{ text: 'あ', stage: { backdrop: 'dusk' } }, { text: 'い' }],
    });
    expect(linesFrom(plain, 1)[0]).toEqual({ text: 'い', stage: { backdrop: 'dusk' } });
    expect(pageStarts(plain)).toEqual([]);
  });

  it('answers nothing past the end', () => {
    expect(linesFrom(talk, talk.lines.length)).toEqual([]);
  });
});

/** The settings of the `[@bgm set …]` cue a run starts with, or null. */
function leadingBgm(text: string | undefined): Record<string, unknown> | null {
  const match = (text ?? '').match(/^\[@bgm set (\{.*?\})\]/u);
  return match === null ? null : (JSON.parse(match[1] ?? '') as Record<string, unknown>);
}

describe('linesFrom and the BGM', () => {
  /** Setup selects the track stopped; the first line starts it, later lines adjust it. */
  const show = script({
    setup: [{ cmd: 'bgm', track: 'piano.mp3', volume: 0.14, loop: true }],
    lines: [
      { text: '[@bgm play]こんばんは。' },
      { text: '[@bgm set {"volume": 0.35}]大きく。' },
      { text: '[@bgm set {"dsp": {"reverb": {"mix": 0.2}}}]響き。' },
      { text: '[@bgm set {"dsp": {"reverb": {"decay": 0.5}}}]もっと。' },
      { text: 'ここから。', reading: 'ここから。' },
      { text: '[@bgm stop]おしまい。' },
      { text: '後書き。' },
    ],
  });

  it('starts the music a skipped line started, with the settings the skipped lines left', () => {
    const [first] = linesFrom(show, 4);
    expect(leadingBgm(first?.text)).toEqual({
      action: 'play',
      volume: 0.35,
      dsp: { reverb: { mix: 0.2, decay: 0.5 } },
    });
    // The line's own words, and its reading, follow the cue untouched.
    expect(first?.text?.endsWith(']ここから。')).toBe(true);
    expect(first?.reading).toBe('ここから。');
  });

  it('leaves the music stopped when a skipped line stopped it', () => {
    expect(leadingBgm(linesFrom(show, 6)[0]?.text)).toMatchObject({ action: 'stop' });
  });

  it('adds nothing when no skipped line touched the music', () => {
    expect(linesFrom(show, 0)[0]?.text).toBe('[@bgm play]こんばんは。');
    expect(linesFrom(talk, 3)[0]?.text).toBe('3 ページ目。');
  });

  it('carries the track a skipped play cue named', () => {
    const named = script({
      lines: [{ text: '[@bgm play other.mp3]はじめ。' }, { text: 'ここから。' }],
    });
    expect(leadingBgm(linesFrom(named, 1)[0]?.text)).toEqual({
      action: 'play',
      track: 'other.mp3',
    });
  });
});

describe('linesFrom and the character', () => {
  /** The character is hidden on a line, shown again by a cue, moved by another. */
  const show = script({
    setup: [{ cmd: 'deck', id: 'talk' }],
    lines: [
      { text: '声だけで。', stage: { place: { avatar: { visible: false } } } },
      { text: 'まだ声だけ。' },
      { text: '[@place {"avatar": {"visible": true}}]出てきました。' },
      { text: 'あ[@place {"avatar": {"shift": -0.2}}]左へ。' },
      { text: 'ここから。' },
    ],
  });

  it('starts hidden where an earlier line hid the character', () => {
    expect(linesFrom(show, 1)[0]?.stage?.place).toEqual({ avatar: { visible: false } });
  });

  it('carries what layout cues in skipped lines left, folded onto the line stages', () => {
    expect(linesFrom(show, 4)[0]?.stage?.place).toEqual({
      avatar: { visible: true, shift: -0.2 },
    });
  });
});

describe('linesFrom and bloom', () => {
  it('accepts bloom setup and carries an earlier off toggle into a resumed run', () => {
    const show = script({
      setup: [{ cmd: 'bloom', enabled: true }],
      lines: [
        { text: '光を切る。', stage: { bloom: false } },
        { text: 'ここから。' },
        { text: '戻す。', stage: { bloom: true } },
        { text: '再開。' },
      ],
    });

    expect(show.setup).toEqual([{ cmd: 'bloom', enabled: true }]);
    expect(linesFrom(show, 1)[0]?.stage?.bloom).toBe(false);
    expect(linesFrom(show, 3)[0]?.stage?.bloom).toBe(true);
  });
});
