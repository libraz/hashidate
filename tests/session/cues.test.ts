import { describe, expect, it } from 'vitest';
import { textToVisemes } from '@/engine/face';
import type { Shot } from '@/engine/types';
import { FakeSlides } from './fakes';
import { build, DT, type Harness } from './harness';

/**
 * Cues written into a line, and where in it they land.
 */

describe('cues in a line', () => {
  /** Ten morae, so a cue at the middle of it lands at a time worth asserting on. */
  const TEN = 'あいうえおかきくけこ';

  /** Step until the performance is no longer `from`, and report the mouth time. */
  const firesAt = (
    { director, step }: Pick<Harness, 'director' | 'step'>,
    from: string | null = null,
  ): number => {
    for (let i = 0; i < 400; i++) {
      step(1);
      if (director.performance !== from) return director.mouth.time;
    }
    throw new Error('no cue fired within the frame budget');
  };

  it('keeps the markup out of the mouth, which is the whole reason it is parsed on the way in', () => {
    const { session, step } = build();
    const seen: number[] = [];
    session.on((ev) => {
      if (ev.type === 'turn.start') seen.push(ev.seconds ?? 0);
    });
    session.say({ text: '[hello]こんばんは[happy]' });
    step(1);

    // Said as written, the ids would be eight morae of nonsense on top of the
    // line. The track is the length of the words alone.
    expect(seen[0]).toBeCloseTo(textToVisemes('こんばんは').duration, 12);
  });

  it('queues the spoken line, so nothing downstream can find markup to leak', () => {
    const { session, step } = build();
    session.say({ text: '[hello]こんばんは[explain]ところで' });
    step(1);
    expect(session.turn?.text).toBe('こんばんはところで');
  });

  it('plays a cue partway through the line rather than at either end of it', () => {
    const harness = build();
    harness.session.say({ text: 'あいうえお[happy]かきくけこ' });
    const at = firesAt(harness);

    expect(harness.director.performance).toBe('happy');
    // Halfway: after the first five morae and before the line is over.
    const half = textToVisemes('あいうえお').duration;
    expect(at).toBeGreaterThanOrEqual(half);
    expect(at).toBeLessThan(half + 4 * DT);
  });

  it('opens on a cue written at the top of the line, without a frame of the old face first', () => {
    const { session, director, step } = build();
    session.say({ text: '[happy]あいうえお' });
    step(1);
    expect(director.performance).toBe('happy');
  });

  it('plays several in the order they were written', () => {
    const { session, director, runUntil } = build();
    const seen: string[] = [];
    session.say({ text: 'あい[calm]うえお[happy]かきく[gloomy]けこ' });
    runUntil(() => {
      const showing = director.performance;
      if (showing && seen.at(-1) !== showing) seen.push(showing);
      return seen.length === 3;
    });
    expect(seen).toEqual(['calm', 'happy', 'gloomy']);
  });

  it('rescales to the line that is actually spoken, because the position is a fraction', () => {
    // The reading is half again as long as the text. A cue held as a time in
    // seconds would fire a third of the way into this and be wrong by 0.3 s;
    // held as a fraction it stays in the middle of the sentence — which is where
    // it was written, and where it will still be when TTS audio is the clock.
    const harness = build();
    const reading = 'あいうえおかきくけこさしすせそ';
    harness.session.say({ text: 'あいうえお[happy]かきくけこ', reading });
    const at = firesAt(harness);

    const half = textToVisemes(reading).duration / 2;
    expect(at).toBeGreaterThanOrEqual(half);
    expect(at).toBeLessThan(half + 4 * DT);
    expect(at).toBeGreaterThan(textToVisemes(TEN).duration / 2 + 0.2);
  });

  it('drops a cue the performance table has no name for, rather than playing it', () => {
    const { session, director, step } = build();
    session.say({ text: 'あいうえお[nosuchthing]かきくけこ', perform: 'hello' });
    step(1);
    expect(session.turn?.cues).toEqual([]);

    // And specifically does not take the face down on the way past. `perform()`
    // releases what is showing when handed an id it does not know, which is
    // right for a caller who can see they got no face and wrong in the middle of
    // a word.
    step(Math.ceil(0.9 / DT));
    expect(director.performance).toBe('hello');
  });

  it('takes down the performance the last cue left up, not the one the turn opened with', () => {
    const { session, director, runUntil } = build();
    session.say({ text: 'あいうえお[happy]かきくけこ', perform: 'hello' });
    runUntil(() => !session.busy);
    // What a turn leaves behind is whatever was showing last. Released against
    // `perform` instead, `happy` would sit on the character's face for good —
    // the turn would look for `hello`, not find it, and put nothing back.
    expect(director.performance).toBeNull();
  });

  it('holds the last cue past the line when the turn asked to hold', () => {
    const { session, director, runUntil } = build();
    session.say({ text: 'あいうえお[happy]かきくけこ', perform: 'hello', hold: true });
    runUntil(() => !session.busy);
    expect(director.performance).toBe('happy');
  });

  it('drops what has not fired when the line is cut off', () => {
    const { session, director, step } = build();
    session.say({ text: 'あいうえお[happy]かきくけこ' });
    step(2);
    expect(director.performance).toBeNull();
    session.interrupt();
    step(Math.ceil(3 / DT));
    // A line that was stopped should stop changing face. Left queued, the cue
    // would land seconds later over whatever the stream had moved on to.
    expect(director.performance).toBeNull();
  });

  it('is a pose change when the line is nothing but cues', () => {
    const { session, director, step } = build();
    session.say({ text: '[happy]' });
    step(1);
    expect(director.performance).toBe('happy');
    expect(session.turn?.text).toBe('');
  });

  it('runs typed visual cues on the same mouth clock as performances', () => {
    const shots: Shot[] = [];
    const slides = new FakeSlides();
    const { session, director, step } = build({
      camera: (shot) => shots.push(shot),
      slides,
    });
    session.say({
      text: '[@camera full][@slide 3][@expression F_JITO][@gesture nod][@hop bounce]あ',
    });
    step(1);

    expect(shots).toEqual([{ frame: 'full' }]);
    expect(slides.calls).toEqual([{ call: 'setSlide', page: 3 }]);
    expect(director.expression).toBe('F_JITO');
    expect(director.body.gesture?.id).toBe('nod');
    expect(director.body.jumping).toBe(true);
  });

  it('fires a typed camera cue at its written mouth-clock position', () => {
    const shots: Shot[] = [];
    const { session, director, step } = build({ camera: (shot) => shots.push(shot) });
    session.say({ text: 'あいうえお[@camera full]かきくけこ' });

    for (let i = 0; i < 400 && shots.length === 0; i++) step(1);

    const half = textToVisemes('あいうえお').duration;
    expect(shots).toEqual([{ frame: 'full' }]);
    expect(director.mouth.time).toBeGreaterThanOrEqual(half);
    expect(director.mouth.time).toBeLessThan(half + 4 * DT);
  });

  it('reports typed BGM cues once per source cue and retains their source ordinals', () => {
    const { session, step } = build();
    session.say({
      id: 'bgm-line',
      text: '[@perform typo][@bgm play 日本語の曲 name.mp3][@bgm pause][@bgm stop]',
    });
    step(1);

    expect(session.takeEvents().filter((event) => event.type === 'cue.fire')).toEqual([
      {
        type: 'cue.fire',
        turn: 'bgm-line',
        cueId: 'bgm-line:cue:1',
        cue: { kind: 'bgm', action: 'play', track: '日本語の曲 name.mp3' },
      },
      {
        type: 'cue.fire',
        turn: 'bgm-line',
        cueId: 'bgm-line:cue:2',
        cue: { kind: 'bgm', action: 'pause' },
      },
      {
        type: 'cue.fire',
        turn: 'bgm-line',
        cueId: 'bgm-line:cue:3',
        cue: { kind: 'bgm', action: 'stop' },
      },
    ]);
  });

  it('drops an unknown typed expression instead of clearing the current face', () => {
    const { session, director, step } = build();
    director.setExpression('F_DOYA');
    session.say({ text: '[@expression DOES_NOT_EXIST]あ' });
    step(1);
    expect(director.expression).toBe('F_DOYA');
  });
});

describe('a cued turn, over every combination of the fields around it', () => {
  /**
   * The cross product rather than a sample of it: 40 cases is cheap, and what
   * a turn leaves showing is decided by four things at once — the last cue, the
   * `perform` it opened with, whether it holds, and whether the mouth ran on a
   * reading. Three of the four have been wrong at some point in this file's
   * history.
   */
  const LINES = {
    none: { text: 'あいうえおかきくけこ', last: null },
    leading: { text: '[happy]あいうえおかきくけこ', last: 'happy' },
    middle: { text: 'あいうえお[happy]かきくけこ', last: 'happy' },
    multiple: { text: 'あい[calm]うえお[happy]かきくけこ', last: 'happy' },
    unknown: { text: 'あいうえお[nosuchthing]かきくけこ', last: null },
  } as const;

  const CASES = Object.entries(LINES).flatMap(([kind, line]) =>
    [undefined, 'あいうえおかきくけこさしすせそ'].flatMap((reading) =>
      [undefined, 'hello'].flatMap((perform) =>
        [false, true].map((hold) => ({ kind, line, reading, perform, hold })),
      ),
    ),
  );

  it.each(CASES)(
    '$kind cues, reading $reading, perform $perform, hold $hold',
    ({ line, reading, perform, hold }) => {
      const { session, director, runUntil } = build();
      session.say({ text: line.text, reading, perform, hold });
      runUntil(() => !session.busy);

      // Whatever the turn put up last is what it has to put back — unless it
      // was told to hold, in which case that same thing is what stays.
      const showing = line.last ?? perform ?? null;
      expect(director.performance).toBe(hold ? showing : null);
    },
  );
});
