import { describe, expect, it } from 'vitest';
import { same } from '@/i18n/locale';
import { checkLine, checkQueue } from '@/panel/lint';
import type { QueueEntry, Vocabulary } from '@/protocol';

/**
 * The checks the engine deliberately does not make.
 *
 * Everything asserted here is a failure the renderer is built to *survive*
 * quietly — a cue naming nothing is dropped, a malformed bracket is stripped,
 * a line is spoken with a face that never changed. That is the right behaviour
 * on the render path and the reason none of it is visible until it has already
 * gone out. These tests pin the one place it is visible.
 *
 * The findings themselves come from the message catalogue, so they read in
 * English here: that is the locale the store falls back to away from a browser.
 * What is being asserted is which check fired, not how it is worded.
 */

const vocabulary: Partial<Vocabulary> = {
  performances: [
    {
      id: 'hello',
      label: same('挨拶'),
      group: 'greeting',
      emotion: {},
      gesture: null,
      hop: null,
      sustain: false,
    },
    {
      id: 'explain',
      label: same('説明'),
      group: 'explain',
      emotion: {},
      gesture: null,
      hop: null,
      sustain: false,
    },
  ],
  gestures: [{ id: 'wave', label: same('手を振る'), group: 'greeting', sustain: false }],
  hops: [{ id: 'jump', label: same('跳ぶ') }],
  expressions: [{ id: 'F_DOYA', label: same('ドヤ') }],
};

const messages = (turn: Parameters<typeof checkLine>[0]): string[] =>
  checkLine(turn, vocabulary).findings.map((f) => f.message);

describe('checkLine, on cues', () => {
  it('resolves a well-formed cue and marks it known', () => {
    const check = checkLine({ text: '[hello]こんばんは。[explain]今日は' }, vocabulary);
    expect(check.spoken).toBe('こんばんは。今日は');
    expect(check.cues.map((c) => [c.perform, c.known])).toEqual([
      ['hello', true],
      ['explain', true],
    ]);
    expect(check.findings).toEqual([]);
  });

  it('keeps typed cues generic and gives each kind a concise label', () => {
    const check = checkLine(
      {
        text: '[@perform hello]あ[@expression F_DOYA]い[@gesture wave]う[@hop jump]え[@camera bust]お[@slide 3]か[@bgm play opening.mp3]き[@bgm pause]く[@bgm stop]',
      },
      vocabulary,
    );
    expect(check.cues.map((cue) => [cue.action.kind, cue.label, cue.known])).toEqual([
      ['perform', 'performance hello', true],
      ['expression', 'expression F_DOYA', true],
      ['gesture', 'gesture wave', true],
      ['hop', 'hop jump', true],
      ['camera', 'camera bust', true],
      ['slide', 'slide 3', true],
      ['bgm', 'bgm play opening.mp3', true],
      ['bgm', 'bgm pause', true],
      ['bgm', 'bgm stop', true],
    ]);
    expect(check.spoken).toBe('あいうえおかきく');
  });

  it('flags a cue the performance table does not have', () => {
    // The session drops this rather than playing it, and drops it silently —
    // releasing the face mid-sentence over a typo would be worse. So this
    // message is the only way anyone finds out before the stream does.
    expect(messages({ text: '[greet]こんばんは' })).toEqual([
      '[greet] is not in the performance table',
    ]);
  });

  it('flags unknown typed dynamic ids but accepts protocol-only actions', () => {
    const check = checkLine(
      {
        text: '[@perform nope][@expression nope][@gesture nope][@hop nope][@camera full][@slide 2][@bgm stop]',
      },
      vocabulary,
    );
    const warnings = check.findings
      .filter((finding) => finding.severity === 'warn')
      .map((finding) => finding.message);
    expect(warnings).toEqual([
      'performance nope does not exist',
      'expression nope does not exist',
      'gesture nope does not exist',
      'hop nope does not exist',
    ]);
  });

  it('treats an explicitly empty vocabulary group as known to have no ids', () => {
    const check = checkLine({ text: '[@expression nope]あ' }, { expressions: [] });
    expect(check.findings.map((finding) => finding.message)).toContain(
      'expression nope does not exist',
    );
  });

  it('judges nothing before a vocabulary has arrived', () => {
    // With no avatar loaded every id is unknown, and painting the whole queue
    // yellow on startup would train the operator to ignore the colour.
    const check = checkLine({ text: '[whatever]あ' }, {});
    expect(check.cues[0].known).toBe(true);
    expect(check.findings).toEqual([]);
  });

  it('flags a bracketed run that is not id-shaped', () => {
    // `[笑]` is the one an LLM writes: markup that was meant to be a cue, is
    // not one, and comes out of the spoken line leaving nothing behind.
    const found = messages({ text: '[笑]おかしいですね' });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('cannot be read as a cue');
  });

  it('flags an unclosed bracket, which takes the rest of the line with it', () => {
    const found = messages({ text: 'こんばんは[hello' });
    expect(found.some((m) => m.includes('cannot be read as a cue'))).toBe(true);
  });

  it('passes a line with no brackets at all', () => {
    expect(messages({ text: 'ふつうの台詞です' })).toEqual([]);
  });
});

describe('checkLine, on the fields around the line', () => {
  it('flags a bracket in a reading', () => {
    expect(messages({ text: '三件', reading: 'さん[けん]' })).toContain(
      'A reading cannot contain square brackets',
    );
  });

  it('flags a perform, gesture or expression the avatar does not have', () => {
    expect(messages({ text: 'あ', perform: 'nope' })).toContain(
      'perform: nope is not in the performance table',
    );
    expect(messages({ text: 'あ', gesture: 'nope' })).toContain('gesture: nope does not exist');
    expect(messages({ text: 'あ', expression: 'nope' })).toContain(
      'expression: nope does not exist',
    );
  });

  it('accepts the ones it does have', () => {
    expect(
      messages({ text: 'あ', perform: 'hello', gesture: 'wave', expression: 'F_DOYA' }),
    ).toEqual([]);
  });

  it('notes a turn that says and does nothing', () => {
    expect(messages({ text: '   ' })).toEqual([
      'An empty turn, with neither a line nor a performance',
    ]);
  });

  it('does not call a pose-only turn empty', () => {
    // A turn with no text is a pose change, which is a legitimate thing to
    // queue — it has no mouth to wait on and closes on the next frame.
    expect(messages({ perform: 'hello' })).toEqual([]);
  });
});

describe('checkLine, on length and spacing', () => {
  it('measures against the reading when one is given', () => {
    // The same rule the mouth follows: written, 三件 is guessed at four morae;
    // the kana says otherwise, and the estimate has to follow the kana.
    const written = checkLine({ text: '三件' }, vocabulary).seconds;
    const read = checkLine({ text: '三件', reading: 'さんけん' }, vocabulary).seconds;
    expect(read).not.toBeCloseTo(written, 6);
  });

  it('notes a line too long to be interrupted cleanly', () => {
    const long = 'あいうえおかきくけこ'.repeat(20);
    const found = messages({ text: long });
    expect(found.some((m) => m.includes('cannot be interrupted cleanly'))).toBe(true);
  });

  it('notes two cues that land close enough that only the second is seen', () => {
    const found = messages({ text: '[hello]あ[explain]いうえおかきくけこさしすせそ' });
    expect(found.some((m) => m.includes('land too close together'))).toBe(true);
  });

  it('crowds typed cues by their labels, regardless of kind', () => {
    const found = messages({ text: '[@camera bust]あ[@bgm stop]いうえお' });
    expect(found.some((m) => m.includes('camera bust') && m.includes('bgm stop'))).toBe(true);
  });

  it('does not flag cues that are comfortably apart', () => {
    expect(
      messages({ text: '[hello]あいうえおかきくけこ。[explain]さしすせそたちつてと' }),
    ).toEqual([]);
  });
});

describe('checkQueue', () => {
  const entry = (id: string, text: string): QueueEntry => ({ id, text, at: 0 });

  it('totals the estimate and counts only the warnings', () => {
    const result = checkQueue(
      [entry('a', '[hello]ふつうの行'), entry('b', '[nope]だめな行'), entry('c', '   ')],
      vocabulary,
    );
    expect(result.checks.size).toBe(3);
    expect(result.seconds).toBeGreaterThan(0);
    // The empty turn is a note, not a warning: the count is what the operator
    // has to act on before going live, and a note is an observation.
    expect(result.warnings).toBe(1);
  });

  it('is empty for an empty queue', () => {
    expect(checkQueue([], vocabulary)).toMatchObject({ seconds: 0, warnings: 0 });
  });
});
