import { describe, expect, it } from 'vitest';
import { textToVisemes } from '@/engine/face';
import { type FakeTake, FakeVoice } from './fakes';
import { build, DT, IDLE_AFTER, settle, TURN_GAP, types } from './harness';

/**
 * The queue: putting lines on it, taking them off, and the three verbs that
 * change what is pending.
 */

describe('Session.say', () => {
  it('returns the id it queued the turn under', () => {
    const { session } = build();
    const id = session.say({ text: 'あいうえお' });
    expect(id).toMatch(/^t[0-9a-z]+-[0-9a-z]+$/);
    expect(session.queue).toHaveLength(1);
    expect(session.queue[0].id).toBe(id);
  });

  it('keeps a caller-supplied id rather than generating over it', () => {
    const { session } = build();
    expect(session.say({ id: 'turn-7', text: 'あ' })).toBe('turn-7');
    expect(session.queue[0].id).toBe('turn-7');
  });

  it('reports the resulting queue depth on turn.queued', () => {
    const { session } = build();
    session.say({ id: 'a' });
    session.say({ id: 'b' });
    expect(session.takeEvents()).toEqual([
      { type: 'turn.queued', turn: 'a', queued: 1 },
      { type: 'turn.queued', turn: 'b', queued: 2 },
    ]);
  });

  it('defaults every optional field, leaving text empty', () => {
    const { session } = build();
    session.say();
    expect(session.queue[0]).toMatchObject({
      text: '',
      emotion: null,
      expression: null,
      gesture: null,
      hold: false,
    });
  });
});

describe('turn sequencing', () => {
  it('plays queued turns in the order they were given', () => {
    const { session, runUntil } = build();
    const started: string[] = [];
    session.on((ev) => {
      if (ev.type === 'turn.start' && ev.turn) started.push(ev.turn);
    });
    session.say({ id: 'first', text: 'あい' });
    session.say({ id: 'second', text: 'うえ' });
    session.say({ id: 'third', text: 'おか' });
    runUntil(() => !session.busy);
    expect(started).toEqual(['first', 'second', 'third']);
  });

  it('leaves TURN_GAP between the end of one turn and the start of the next', () => {
    const { session, now, runUntil } = build();
    const at = new Map<string, number>();
    session.on((ev) => at.set(`${ev.type}:${ev.turn}`, now()));
    session.say({ id: 'a', text: 'あい' });
    session.say({ id: 'b', text: 'うえ' });
    runUntil(() => !session.busy);

    const gap = (at.get('turn.start:b') as number) - (at.get('turn.end:a') as number);
    expect(gap).toBeGreaterThanOrEqual(TURN_GAP);
    expect(gap).toBeLessThan(TURN_GAP + 2 * DT);
  });

  it('ends the turn when the mouth stops, not when the duration speak() returned elapses', () => {
    const { session, now, runUntil } = build();
    let startedAt = 0;
    let endedAt = 0;
    let seconds = 0;
    session.on((ev) => {
      if (ev.type === 'turn.start') {
        startedAt = now();
        seconds = ev.seconds ?? 0;
      }
      if (ev.type === 'turn.end') endedAt = now();
    });
    session.say({ id: 'a', text: 'あいうえおかきくけこ' });
    runUntil(() => endedAt > 0);

    expect(seconds).toBeGreaterThan(0);
    // The mouth releases the last mora after the estimate runs out, so a turn
    // driven off `seconds` would cut the line short.
    // The mouth holds the last mora for a beat past the estimate, so the turn
    // outlives `seconds` by that release and one frame of detection — a turn
    // driven off the returned duration would close roughly a fifth of a second
    // early, every line, and the error would accumulate down the queue.
    expect(endedAt - startedAt).toBeGreaterThan(seconds + 0.19);
    expect(endedAt - startedAt).toBeLessThan(seconds + 0.24);
  });

  it('builds the viseme track from the reading when one is given, not from the text', () => {
    const { session, runUntil } = build();
    const seen: number[] = [];
    session.on((ev) => {
      if (ev.type === 'turn.start') seen.push(ev.seconds ?? 0);
    });
    // Written, the mouth has to guess: it counts each kanji as two morae, so
    // 三件 comes out four beats long. The kana says it is さ-ん-け-ん, and the
    // two ん are shorter than a full mora — a different length, which is the
    // only way to tell from out here which string the track was built from.
    session.say({ id: 'written', text: '三件' });
    runUntil(() => !session.busy);
    session.say({ id: 'read', text: '三件', reading: 'さんけん' });
    runUntil(() => !session.busy);

    const [written, read] = seen;
    expect(written).toBeCloseTo(textToVisemes('三件').duration, 12);
    expect(read).toBeCloseTo(textToVisemes('さんけん').duration, 12);
    expect(read).not.toBeCloseTo(written, 3);
  });

  it('falls back to the text when no reading is given', () => {
    const { session, runUntil } = build();
    const seen: number[] = [];
    session.on((ev) => {
      if (ev.type === 'turn.start') seen.push(ev.seconds ?? 0);
    });
    session.say({ id: 'a', text: 'さんけん' });
    runUntil(() => !session.busy);
    session.say({ id: 'b', text: 'さんけん', reading: 'さんけん' });
    runUntil(() => !session.busy);

    expect(seen[0]).toBeCloseTo(seen[1], 12);
  });

  it('keeps the turn open while the mouth is still speaking past the estimate', () => {
    const { session, director, step } = build();
    let seconds = 0;
    session.on((ev) => {
      if (ev.type === 'turn.start') seconds = ev.seconds ?? 0;
    });
    session.say({ id: 'a', text: 'あいうえおかきくけこ' });
    step(1);
    step(Math.ceil(seconds / DT));

    expect(director.mouth.speaking).toBe(true);
    expect(session.turn?.id).toBe('a');
  });

  it('emits turn.queued, turn.start, turn.end and queue.empty as the last turn drains', () => {
    const { session, runUntil } = build();
    session.say({ id: 'only', text: 'あい' });
    runUntil(() => !session.busy);
    expect(types(session.takeEvents())).toEqual([
      'turn.queued',
      'turn.start',
      'turn.end',
      'queue.empty',
    ]);
  });

  it('withholds queue.empty until the last turn of a run ends', () => {
    const { session, runUntil } = build();
    session.say({ id: 'a', text: 'あい' });
    session.say({ id: 'b', text: 'うえ' });
    runUntil(() => !session.busy);
    const seen = types(session.takeEvents());
    expect(seen.filter((t) => t === 'queue.empty')).toHaveLength(1);
    expect(seen[seen.length - 1]).toBe('queue.empty');
  });

  it('reports busy from the moment a turn is queued until the queue drains', () => {
    const { session, runUntil } = build();
    expect(session.busy).toBe(false);
    session.say({ id: 'a', text: 'あい' });
    expect(session.busy).toBe(true);
    runUntil(() => !session.busy);
    expect(session.turn).toBeNull();
    expect(session.queue).toHaveLength(0);
  });
});

describe('Session.interrupt', () => {
  it('stops the current line, drops the queue and reports both', () => {
    const { session, director, step } = build();
    session.say({ id: 'a', text: 'あいうえおかきくけこ' });
    session.say({ id: 'b', text: 'さしすせそ' });
    step(4);
    expect(session.turn?.id).toBe('a');
    session.takeEvents();

    session.interrupt();

    expect(session.turn).toBeNull();
    expect(session.queue).toHaveLength(0);
    expect(director.mouth.speaking).toBe(false);
    expect(session.takeEvents()).toEqual([
      { type: 'turn.interrupted', turn: 'a' },
      { type: 'queue.dropped', turns: ['b'] },
    ]);
  });

  it('releases the running gesture along with the line', () => {
    const { session, director, step } = build();
    session.say({ id: 'a', text: 'あいうえお', gesture: 'wave' });
    step(4);
    expect(director.body.gesture?.id).toBe('wave');
    session.interrupt();
    expect(director.body.gesture?.released).toBe(true);
  });

  it('emits nothing when there is neither a turn nor a queue', () => {
    const { session } = build();
    session.interrupt();
    expect(session.takeEvents()).toEqual([]);
  });

  it('starts the next queued turn without waiting out a gap', () => {
    const { session, now, step } = build();
    session.say({ id: 'a', text: 'あいうえおかきくけこ' });
    step(4);
    session.interrupt();
    session.takeEvents();

    const interruptedAt = now();
    session.say({ id: 'b', text: 'さし' });
    let startedAt = 0;
    session.on((ev) => {
      if (ev.type === 'turn.start') startedAt = now();
    });
    step(1);
    expect(startedAt - interruptedAt).toBeLessThan(TURN_GAP);
  });
});

describe('Session.clearQueue', () => {
  it('drops what is pending and lets the current line finish', () => {
    const { session, step, runUntil } = build();
    session.say({ id: 'a', text: 'あいうえお' });
    session.say({ id: 'b', text: 'かきくけこ' });
    step(4);
    session.takeEvents();

    session.clearQueue();

    expect(session.turn?.id).toBe('a');
    expect(session.queue).toHaveLength(0);
    expect(session.takeEvents()).toEqual([{ type: 'queue.dropped', turns: ['b'] }]);

    const ended: string[] = [];
    session.on((ev) => {
      if (ev.type === 'turn.end' && ev.turn) ended.push(ev.turn);
    });
    runUntil(() => !session.busy);
    expect(ended).toEqual(['a']);
  });

  it('emits nothing when there is nothing pending', () => {
    const { session, step } = build();
    session.say({ id: 'a', text: 'あいうえお' });
    step(4);
    session.takeEvents();
    session.clearQueue();
    expect(session.takeEvents()).toEqual([]);
  });
});

describe('a held queue', () => {
  it('keeps the lines and does not start one', () => {
    // The third thing that can be done to a run of turns, and the only one that
    // keeps them: `interrupt` cuts and drops, `clear` drops, this drops nothing.
    const { session, step } = build();
    session.paused = true;
    session.say({ id: 'a', text: 'あいうえお' });
    session.say({ id: 'b', text: 'かきくけこ' });
    step(120);

    expect(session.turn).toBeNull();
    expect(session.queue.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('starts the first line as soon as the hold comes off', () => {
    const { session, step } = build();
    session.paused = true;
    session.say({ id: 'a', text: 'あいうえお' });
    step(60);
    expect(session.turn).toBeNull();

    session.paused = false;
    step(1);
    expect(session.turn?.id).toBe('a');
  });

  it('lets the line on air finish rather than cutting it', () => {
    const { session, step, runUntil } = build();
    session.say({ id: 'a', text: 'あいうえお' });
    session.say({ id: 'b', text: 'かきくけこ' });
    step(4);
    expect(session.turn?.id).toBe('a');

    session.paused = true;
    runUntil(() => session.turn === null, 30);
    // 'a' ran to its end; 'b' is still waiting rather than dropped.
    expect(session.queue.map((t) => t.id)).toEqual(['b']);
  });

  it('holds a line said directly, on the same footing as one from a script', () => {
    // A `say` goes onto the same queue as anything else, and a hold some lines
    // could walk past would not be one.
    const { session, step } = build();
    session.paused = true;
    session.say({ id: 'a', text: 'あい' });
    step(60);
    expect(session.turn).toBeNull();
  });

  it('does not count as busy, so the character stays alive while a shot is framed', () => {
    // This is the stretch a recording opens on, and it is the one place a
    // character holding perfectly still would be kept.
    const { session, step } = build({ idle: true });
    session.paused = true;
    session.say({ id: 'a', text: 'あい' });
    step(1);
    expect(session.busy).toBe(false);
    step(Math.ceil((IDLE_AFTER + 0.2) / DT));
    expect(session.d.auto).toBe(true);
  });
});

describe('turn ids', () => {
  it('are unique across calls made inside the same millisecond', () => {
    const { session } = build();
    // The wire format supports batching, and the command handler applies a
    // batch in a tight loop with no yield — so this is the ordinary path, not a
    // stress case. A timestamp alone collides here, and a caller holding three
    // identical ids cannot tell which turn's `turn.end` it is looking at.
    const ids = [
      session.say({ text: 'あ' }),
      session.say({ text: 'い' }),
      session.say({ text: 'う' }),
    ];
    expect(new Set(ids).size).toBe(3);
  });
});

/**
 * A named hand, from the four places a caller can name one.
 *
 * The gesture layer decides which arm acts and is tested at the wrist in
 * `tests/motion/body.test.ts`; what is checked here is that the hand a caller
 * wrote survives the trip — through a direct call, through a performance that
 * owns the movement, through a queued line, and through the in-place update a
 * queue replacement makes.
 */

describe('Session.replaceQueue', () => {
  it('reorders without asking the voice for anything again', async () => {
    let voice: FakeVoice | null = null;
    const { session } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { seconds: 1 });
        return voice;
      },
    });
    session.say({ id: 'a', text: 'ひとつめ' });
    session.say({ id: 'b', text: 'ふたつめ' });
    await settle();
    const asked = (voice as unknown as FakeVoice).asked.length;
    const takes = session.queue.map((turn) => turn.take);

    session.replaceQueue([
      { id: 'b', text: 'ふたつめ' },
      { id: 'a', text: 'ひとつめ' },
    ]);

    expect(session.queue.map((turn) => turn.id)).toEqual(['b', 'a']);
    // The whole point: a drag costs one message and no synthesis. Re-asking
    // would take the stream quiet for a second per line, every reorder.
    expect((voice as unknown as FakeVoice).asked).toHaveLength(asked);
    expect(session.queue.map((turn) => turn.take)).toEqual([takes[1], takes[0]]);
  });

  it('re-synthesises a line whose words changed, and only that one', async () => {
    let voice: FakeVoice | null = null;
    const { session } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { seconds: 1 });
        return voice;
      },
    });
    session.say({ id: 'a', text: 'そのまま' });
    session.say({ id: 'b', text: 'まちがい' });
    await settle();
    const kept = session.queue[0].take;

    session.replaceQueue([
      { id: 'a', text: 'そのまま' },
      { id: 'b', text: 'なおした' },
    ]);
    await settle();

    expect((voice as unknown as FakeVoice).asked).toEqual([
      'そのまま',
      'まちがい',
      // An edited line is a different line and has to be spoken again.
      'なおした',
    ]);
    expect(session.queue[0].take).toBe(kept);
  });

  it('treats a changed reading as a changed line', async () => {
    let voice: FakeVoice | null = null;
    const { session } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { seconds: 1 });
        return voice;
      },
    });
    session.say({ id: 'a', text: '三件', reading: 'さんけん' });
    await settle();
    session.replaceQueue([{ id: 'a', text: '三件', reading: 'みっけん' }]);
    await settle();
    // The words are identical and the sound is not. Matching on text alone
    // would leave the corrected pronunciation unspoken.
    expect((voice as unknown as FakeVoice).asked).toHaveLength(2);
  });

  it('updates the fields around the line in place, keeping the take', async () => {
    const { session } = build({ voice: (now) => new FakeVoice(now, { seconds: 1 }) });
    session.say({ id: 'a', text: 'あ', perform: 'hello' });
    await settle();
    const take = session.queue[0].take;

    session.replaceQueue([{ id: 'a', text: 'あ', perform: null, emotion: { joy: 1 }, hold: true }]);

    // Everything outside the line itself is applied when the turn starts, so it
    // can be rewritten without costing the audio.
    expect(session.queue[0]).toMatchObject({ perform: null, emotion: { joy: 1 }, hold: true });
    expect(session.queue[0].take).toBe(take);
  });

  it('refreshes typed cues when only cue markup changes, keeping the take', async () => {
    const { session } = build({ voice: (now) => new FakeVoice(now, { seconds: 1 }) });
    session.say({ id: 'a', text: 'あ[@bgm play first.mp3]' });
    await settle();
    const take = session.queue[0].take;

    session.replaceQueue([{ id: 'a', text: 'あ[@bgm pause]' }]);

    expect(session.queue[0].take).toBe(take);
    expect(session.queue[0].cues).toEqual([
      { action: { kind: 'bgm', action: 'pause' }, at: expect.any(Number) },
    ]);
  });

  it('stops the take of a line the new list dropped', async () => {
    const { session } = build({ voice: (now) => new FakeVoice(now, { seconds: 1 }) });
    session.say({ id: 'a', text: 'のこる' });
    session.say({ id: 'b', text: 'きえる' });
    await settle();
    const dropped = session.queue[1].take as FakeTake;

    session.replaceQueue([{ id: 'a', text: 'のこる' }]);

    // A take that is not stopped arrives a second later and starts talking over
    // whatever replaced it — the same failure a `clear` mid-synthesis has.
    expect(dropped.stopped).toBe(true);
  });

  it('does not touch the turn that is already being said', () => {
    const { session, step } = build();
    session.say({ id: 'running', text: 'いま' });
    step(2);
    expect(session.turn?.id).toBe('running');

    session.replaceQueue([{ id: 'next', text: 'つぎ' }]);

    // A queue edit is about what comes next. Stopping the line in the air is
    // what `interrupt` is for, and doing it here would make every reorder cut
    // the character off mid-word.
    expect(session.turn?.id).toBe('running');
    expect(session.queue.map((turn) => turn.id)).toEqual(['next']);
  });

  it('reports the resulting depth on queue.replaced', () => {
    const { session } = build();
    session.say({ id: 'a' });
    session.takeEvents();
    session.replaceQueue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(session.takeEvents()).toEqual([{ type: 'queue.replaced', queued: 3 }]);
  });

  it('empties the queue when given nothing', () => {
    const { session } = build();
    session.say({ id: 'a' });
    session.replaceQueue([]);
    expect(session.queue).toHaveLength(0);
  });
});
