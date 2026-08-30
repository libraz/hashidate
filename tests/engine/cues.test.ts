import { describe, expect, it } from 'vitest';
import { hasCueMarkup, isWellFormed, parseLine } from '@/engine/cues';
import { textToVisemes } from '@/engine/face';
import { PERFORMANCE_IDS } from '@/engine/performance';

/**
 * Cue markup: performance changes written into the line.
 *
 * The one property worth more than all the others here is that nothing in
 * brackets is ever spoken, so it is tested as a property over hostile input
 * rather than as a list of cases — see `never speaks its markup` below. The
 * cases are for what a *well-formed* line is supposed to do.
 */

/**
 * Lines that are wrong in every way one has come up: unclosed, unopened,
 * nested, empty, doubled, not an id, not ASCII, only markup. Every one of them
 * goes through the same assertion, because the guarantee is not about any of
 * them individually.
 */
const HOSTILE = [
  '[',
  ']',
  '[]',
  '[[]]',
  '[[hello]]',
  '[hello',
  'hello]',
  'こんばんは[',
  'こんばんは]です',
  '[hello[explain]は',
  '[hello world]は',
  '[笑]は',
  '[1st]は',
  '[][][]',
  ']hello[',
  '[hello]]',
  '[[hello]',
  'あ[い]う',
];

/** Lines that are legal, including the ones that only look alarming. */
const SOUND = [
  'こんばんは',
  '[hello]',
  '[hello]こんばんは。[explain]今日は。',
  '[HELLO]は',
  '[nosuchthing]は',
  '',
];

/** Whether every character of `part` appears in `whole`, in order. */
function isSubsequence(part: string, whole: string): boolean {
  let cursor = 0;
  for (const ch of part) {
    const found = whole.indexOf(ch, cursor);
    if (found === -1) return false;
    cursor = found + ch.length;
  }
  return true;
}

describe('the cue grammar', () => {
  it('accepts a line with no markup at all', () => {
    expect(isWellFormed('こんばんは。今日もありがとう。')).toBe(true);
    expect(hasCueMarkup('こんばんは。今日もありがとう。')).toBe(false);
  });

  it('accepts a bracketed id, wherever it sits', () => {
    expect(isWellFormed('[hello]こんばんは')).toBe(true);
    expect(isWellFormed('こんばんは[explain]ところで')).toBe(true);
    expect(isWellFormed('こんばんは[happy]')).toBe(true);
    expect(isWellFormed('[hello][happy]')).toBe(true);
  });

  it.each(SOUND)('accepts %j', (source) => {
    expect(isWellFormed(source)).toBe(true);
  });

  it('accepts an id the performance table does not have', () => {
    // Deliberate: the table is engine data and the wire carries ids as plain
    // strings, exactly as the `perform` field beside this one does. Checking it
    // here would make a cue stricter than the command it is the inline form of.
    expect(isWellFormed('[nosuchthing]は')).toBe(true);
  });

  it('accepts typed visual and BGM cues, including spaced dynamic ids and filenames', () => {
    expect(
      isWellFormed(
        '[@perform happy face]こんばんは[@expression F JITO][@gesture big wave][@hop high bounce][@camera full][@slide 3][@bgm play 日本語の曲 name.mp3][@bgm pause][@bgm stop]',
      ),
    ).toBe(true);
  });

  // Including the dangerous near-misses. `[笑]` is what a language model writes
  // when it means a stage direction, and 「かくかっこ わらい かくかっことじ」 is
  // the sentence this whole design exists so that nobody ever hears.
  it.each(HOSTILE)(
    'refuses %j, so the command carrying it is dropped rather than read out',
    (source) => {
      expect(isWellFormed(source)).toBe(false);
    },
  );

  it.each([
    '[@unknown value]は',
    '[@perform]は',
    '[@camera portrait]は',
    '[@slide 0]は',
    '[@slide 1.5]は',
    '[@bgm next]は',
    '[@bgm pause track.mp3]は',
    '[@bgm play .hidden.mp3]は',
    '[@bgm play song.wav]は',
  ])('refuses malformed typed cue %j', (source) => {
    expect(isWellFormed(source)).toBe(false);
  });

  it('spots markup anywhere, which is what the reading field is checked with', () => {
    expect(hasCueMarkup('さんけん')).toBe(false);
    expect(hasCueMarkup('[hello]さんけん')).toBe(true);
    expect(hasCueMarkup('さんけん]')).toBe(true);
  });

  it('can express every performance id, which is what makes the id shape a real rule', () => {
    // The grammar says an id is a letter followed by letters and digits. If the
    // table ever gains an id with an underscore or a hyphen in it, that entry
    // becomes unreachable from a line — silently, since the parser would simply
    // not recognise it. This is the assertion that stops that landing.
    for (const id of PERFORMANCE_IDS) expect(isWellFormed(`[${id}]`)).toBe(true);
  });
});

describe('parseLine', () => {
  it('leaves a line with no markup exactly as it was', () => {
    const line = parseLine('こんばんは。今日もありがとう。');
    expect(line.text).toBe('こんばんは。今日もありがとう。');
    expect(line.cues).toEqual([]);
  });

  it('takes the markup out and keeps the words', () => {
    const line = parseLine('[hello]こんばんは。[explain]今日はこの話をします。');
    expect(line.text).toBe('こんばんは。今日はこの話をします。');
    expect(line.cues.map((cue) => cue.perform)).toEqual(['hello', 'explain']);
  });

  it('reports the cues in the order they occur', () => {
    const line = parseLine('あ[happy]い[gloomy]う[calm]え');
    expect(line.cues.map((cue) => cue.perform)).toEqual(['happy', 'gloomy', 'calm']);
    const at = line.cues.map((cue) => cue.at);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('puts a leading cue at the start of the line and a trailing one at the end', () => {
    const line = parseLine('[hello]あいうえお[happy]');
    expect(line.text).toBe('あいうえお');
    expect(line.cues[0].at).toBe(0);
    expect(line.cues[1].at).toBe(1);
  });

  it('places a cue by mouth time rather than by character count', () => {
    // 三件 is four beats to the mouth and two characters to a string index. A
    // cue written after it is four fifths of the way through 三件あ, not two
    // thirds — and it is the utterance the caller was placing it in.
    const line = parseLine('三件[happy]あ');
    expect(line.text).toBe('三件あ');
    expect(line.cues[0].at).toBeCloseTo(0.8, 6);
    expect(line.cues[0].at).not.toBeCloseTo(2 / 3, 2);
  });

  it('states the position as a fraction of the line, so it survives being said slower', () => {
    const line = parseLine('あい[happy]うえお');
    expect(line.cues[0].at).toBeCloseTo(
      textToVisemes('あい').duration / textToVisemes('あいうえお').duration,
      12,
    );
  });

  it('keeps a cue whose id the performance table does not have', () => {
    // Resolving it is the session's job, because the table is the session's to
    // know. Dropping it here would put the same knowledge in two places.
    expect(parseLine('[nosuchthing]あ').cues.map((cue) => cue.perform)).toEqual(['nosuchthing']);
  });

  it('parses typed actions and keeps source order on a clean-text offset', () => {
    const line = parseLine(
      'あ[@gesture big wave][@camera full]い[@bgm play 日本語の曲  name.mp3]う[@slide 3]',
    );
    expect(line.text).toBe('あいう');
    expect(line.cues).toEqual([
      { action: { kind: 'gesture', id: 'big wave' }, at: expect.any(Number) },
      { action: { kind: 'camera', frame: 'full' }, at: expect.any(Number) },
      {
        action: { kind: 'bgm', action: 'play', track: '日本語の曲  name.mp3' },
        at: expect.any(Number),
      },
      { action: { kind: 'slide', page: 3 }, at: 1 },
    ]);
    expect(line.cues.map((cue) => cue.ordinal)).toEqual([0, 1, 2, 3]);
    expect(line.cues[0].at).toBeCloseTo(
      textToVisemes('あ').duration / textToVisemes('あいう').duration,
      12,
    );
  });

  it('drops a bracketed run that is not id-shaped, rather than speaking it', () => {
    expect(parseLine('あ[笑]い').text).toBe('あい');
    expect(parseLine('あ[笑]い').cues).toEqual([]);
    expect(parseLine('あ[hello world]い').text).toBe('あい');
  });

  it('lets an unclosed bracket take the rest of the line with it', () => {
    // The fail-closed direction, and unreachable through the API — the schema
    // refuses the command first. Reached only from a caller inside the process
    // that built the line wrong, where a line that visibly stops short is the
    // bug report and a line that reads the markup out is not.
    expect(parseLine('こんばんは[happy').text).toBe('こんばんは');
  });

  it('yields a cue and no words for a line that is only markup', () => {
    const line = parseLine('[happy]');
    expect(line.text).toBe('');
    expect(line.cues).toEqual([{ perform: 'happy', at: 0 }]);
  });

  it('never speaks its markup, whatever it is handed', () => {
    // The guarantee, stated once over everything above. Any of these reaching
    // the mouth is the failure the module exists to prevent, and the assertion
    // is about the *output alphabet* rather than about any particular input —
    // a case nobody thought of still has to satisfy it.
    for (const source of [...HOSTILE, ...SOUND]) {
      const { text } = parseLine(source);
      expect(text).not.toContain('[');
      expect(text).not.toContain(']');
    }
  });

  it('never invents words, so what survives is a subsequence of what arrived', () => {
    // The other half of the guarantee: the stripper is only allowed to remove.
    // A parser that rewrote as well as removed could satisfy the assertion above
    // while putting something the caller never wrote into the character's mouth.
    const strayed = [...HOSTILE, ...SOUND].filter(
      (source) => !isSubsequence(parseLine(source).text, source),
    );
    expect(strayed).toEqual([]);
  });
});
