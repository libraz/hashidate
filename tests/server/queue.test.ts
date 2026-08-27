import { beforeEach, describe, expect, it } from 'vitest';
import { HISTORY_MAX, TurnQueue } from '@/server/queue';

/**
 * The pending list, which is the only copy that counts.
 *
 * Everything here is about a queue being *edited while it is being played* —
 * reordered, interjected into, rewritten one line at a time — because that is
 * the only situation it exists for. A queue that is only ever appended to would
 * not need to be here at all.
 */

let queue: TurnQueue;

beforeEach(() => {
  queue = new TurnQueue();
});

/** The ids in order, which is what every assertion here is really about. */
const ids = (): string[] => queue.list().map((entry) => entry.id);
const texts = (): string[] => queue.list().map((entry) => entry.text ?? '');

/** Queue `n` lines and hand back their ids. */
const fill = (...lines: string[]): string[] =>
  queue.add(lines.map((text) => ({ text }))).map((entry) => entry.id);

describe('TurnQueue.add', () => {
  it('mints an id per entry even inside one millisecond', () => {
    const added = queue.add([{ text: 'あ' }, { text: 'い' }, { text: 'う' }]);
    expect(new Set(added.map((e) => e.id)).size).toBe(3);
  });

  it('overrides a caller-supplied id rather than filing under it', () => {
    // The id is what every edit addresses and what turn events come back under,
    // so two entries sharing one would make both unaddressable.
    const [entry] = queue.add([{ id: 'mine', text: 'あ' }]);
    expect(entry.id).not.toBe('mine');
  });

  it('appends by default and keeps batch order when unshifting', () => {
    fill('one', 'two');
    queue.add([{ text: 'a' }, { text: 'b' }], { at: 'unshift' });
    // The pair goes next, first line first — not reversed, which is what a
    // naive per-item unshift would produce.
    expect(texts()).toEqual(['a', 'b', 'one', 'two']);
  });

  it('carries source and note onto every turn in the batch', () => {
    queue.add([{ text: 'あ' }, { text: 'い' }], { source: 'comment', note: '視聴者から' });
    expect(queue.list().map((e) => e.source)).toEqual(['comment', 'comment']);
    expect(queue.list()[1].note).toBe('視聴者から');
  });
});

describe('TurnQueue.move', () => {
  it('places the entry at the index it was dropped on, measured after the lift', () => {
    const [a, b, c] = fill('a', 'b', 'c');
    queue.move(a, 1);
    // Dragging the first row one place down has to actually move it. Measuring
    // `to` against the list *before* the lift would make this a no-op.
    expect(ids()).toEqual([b, a, c]);
  });

  it('clamps a drop past either end instead of failing', () => {
    const [a, b, c] = fill('a', 'b', 'c');
    expect(queue.move(a, 99)).toBe(true);
    expect(ids()).toEqual([b, c, a]);
    expect(queue.move(a, -5)).toBe(true);
    expect(ids()).toEqual([a, b, c]);
  });

  it('refuses an id that is not pending', () => {
    fill('a');
    expect(queue.move('gone', 0)).toBe(false);
  });
});

describe('TurnQueue.update', () => {
  it('rewrites the line and keeps the id, the source and the timestamp', () => {
    const [entry] = queue.add([{ text: 'まちがい' }], { source: 'llm' });
    queue.update(entry.id, { text: 'なおした' });
    const [after] = queue.list();
    expect(after).toMatchObject({ id: entry.id, text: 'なおした', source: 'llm', at: entry.at });
  });

  it('leaves untouched fields alone, so a partial edit cannot clobber', () => {
    const [entry] = queue.add([{ text: 'あ', emotion: { joy: 1 }, perform: 'hello' }]);
    queue.update(entry.id, { reading: 'あー' });
    expect(queue.list()[0]).toMatchObject({
      text: 'あ',
      emotion: { joy: 1 },
      perform: 'hello',
      reading: 'あー',
    });
  });

  it('refuses an id that started playing while the form was open', () => {
    const [entry] = queue.add([{ text: 'あ' }]);
    queue.complete(entry.id);
    expect(queue.update(entry.id, { text: 'おそい' })).toBe(false);
  });
});

describe('TurnQueue.shift and pop', () => {
  it('take from the front and the back and answer null when empty', () => {
    const [a, b, c] = fill('a', 'b', 'c');
    expect(queue.shift()?.id).toBe(a);
    expect(queue.pop()?.id).toBe(c);
    expect(queue.shift()?.id).toBe(b);
    expect(queue.shift()).toBeNull();
    expect(queue.pop()).toBeNull();
  });
});

describe('TurnQueue.command', () => {
  it('strips the operator fields rather than trusting the schema to drop them', () => {
    queue.add([{ text: 'あ', perform: 'hello' }], { source: 'comment', note: '内緒' });
    const command = queue.command();
    expect(command.cmd).toBe('queue');
    const [turn] = command.cmd === 'queue' ? command.turns : [];
    expect(turn).toMatchObject({ text: 'あ', perform: 'hello' });
    // The note is the operator's and is never spoken, never synthesised and
    // never sent to a renderer that has no use for it.
    expect(turn).not.toHaveProperty('note');
    expect(turn).not.toHaveProperty('source');
    expect(turn).not.toHaveProperty('at');
  });

  it('carries the id, which is what turn events come back under', () => {
    const [entry] = queue.add([{ text: 'あ' }]);
    const command = queue.command();
    const turns = command.cmd === 'queue' ? command.turns : [];
    expect(turns[0].id).toBe(entry.id);
  });
});

/**
 * What has been said, and putting it back.
 *
 * The history exists so that the past is addressable during a broadcast: a line
 * that came out wrong is not gone, it is a row with two buttons on it. These
 * tests are mostly about the difference between those two buttons, because that
 * difference — repeat one line, or rewind past it — is the whole feature.
 */
describe('TurnQueue history', () => {
  it('moves a finished entry out of the pending list and into the history', () => {
    const [a, b] = fill('a', 'b');
    expect(queue.complete(a)).toBe(true);
    expect(ids()).toEqual([b]);
    expect(queue.history().map((e) => e.id)).toEqual([a]);
  });

  it('stamps when it was said and leaves a finished line unmarked', () => {
    const [a] = fill('a');
    queue.complete(a);
    const [entry] = queue.history();
    expect(entry.saidAt).toBeGreaterThan(0);
    expect(entry.interrupted).toBeUndefined();
  });

  it('marks a line that was cut off, which is the one most likely to be wanted back', () => {
    const [a] = fill('a');
    queue.complete(a, { interrupted: true });
    expect(queue.history()[0].interrupted).toBe(true);
  });

  it('answers false for an id it does not have, and files nothing', () => {
    expect(queue.complete('nope')).toBe(false);
    expect(queue.history()).toEqual([]);
  });

  it('keeps the newest HISTORY_MAX and drops from the old end', () => {
    for (let i = 0; i < HISTORY_MAX + 20; i++) {
      const [id] = fill(`line ${i}`);
      queue.complete(id);
    }
    const history = queue.history();
    expect(history).toHaveLength(HISTORY_MAX);
    // The end of the list is the end nobody reaches for.
    expect(history[0].text).toBe('line 20');
    expect(history.at(-1)?.text).toBe(`line ${HISTORY_MAX + 19}`);
  });

  it('hands back a copy, so a caller cannot edit what was said', () => {
    const [a] = fill('a');
    queue.complete(a);
    queue.history()[0].text = 'rewritten';
    expect(queue.history()[0].text).toBe('a');
  });

  it('is not emptied by clearing the pending list', () => {
    const [a] = fill('a');
    queue.complete(a);
    fill('b');
    queue.clear();
    expect(ids()).toEqual([]);
    expect(queue.history()).toHaveLength(1);
  });

  it('forgets everything when asked, leaving the pending list alone', () => {
    const [a] = fill('a');
    queue.complete(a);
    const [b] = fill('b');
    queue.forget();
    expect(queue.history()).toEqual([]);
    expect(ids()).toEqual([b]);
  });
});

describe('TurnQueue.rewind', () => {
  /** Say `lines` in order, so the history has something with a shape. */
  const said = (...lines: string[]): string[] =>
    lines.map((text) => {
      const [id] = fill(text);
      queue.complete(id);
      return id;
    });

  it('from: puts the line and everything said after it back, in order', () => {
    const [, b] = said('a', 'b', 'c');
    fill('pending');
    const added = queue.rewind(b, 'from');
    expect(added?.map((e) => e.text)).toEqual(['b', 'c']);
    // At the front, so the show carries on from that point rather than after
    // whatever was already waiting.
    expect(texts()).toEqual(['b', 'c', 'pending']);
  });

  it('from: ends the history where the rewind began', () => {
    const [, b] = said('a', 'b', 'c');
    queue.rewind(b, 'from');
    // Those lines are about to be said again, and will be filed again when they
    // are. Leaving them would file each of them twice.
    expect(queue.history().map((e) => e.text)).toEqual(['a']);
  });

  it('one: copies a single line and leaves the history whole', () => {
    const [, b] = said('a', 'b', 'c');
    const added = queue.rewind(b, 'one');
    expect(added?.map((e) => e.text)).toEqual(['b']);
    expect(texts()).toEqual(['b']);
    // Repeating a line is not rewinding past it.
    expect(queue.history().map((e) => e.text)).toEqual(['a', 'b', 'c']);
  });

  it('mints a new id, so nothing ends twice under the same one', () => {
    const [a] = said('a');
    const added = queue.rewind(a, 'one');
    expect(added?.[0].id).not.toBe(a);
    expect(added?.[0].at).toBeGreaterThan(0);
  });

  it('carries source and note back with the line', () => {
    const [entry] = queue.add([{ text: 'あ' }], { source: 'comment', note: '視聴者から' });
    queue.complete(entry.id);
    const added = queue.rewind(entry.id, 'one');
    expect(added?.[0]).toMatchObject({ source: 'comment', note: '視聴者から' });
  });

  it('does not carry the end-of-line fields back into the queue', () => {
    const [a] = said('a');
    const added = queue.rewind(a, 'one');
    expect(added?.[0]).not.toHaveProperty('saidAt');
    expect(added?.[0]).not.toHaveProperty('interrupted');
  });

  it('brings an interrupted line back as an ordinary pending one', () => {
    const [id] = fill('cut off');
    queue.complete(id, { interrupted: true });
    const added = queue.rewind(id, 'one');
    expect(added?.[0].text).toBe('cut off');
    expect(added?.[0]).not.toHaveProperty('interrupted');
  });

  it('answers null for an id that has aged off the end, and changes nothing', () => {
    said('a');
    fill('pending');
    expect(queue.rewind('nope', 'from')).toBeNull();
    expect(texts()).toEqual(['pending']);
    expect(queue.history()).toHaveLength(1);
  });

  it('defaults to from, which is what a rewind means', () => {
    const [, b] = said('a', 'b', 'c');
    queue.rewind(b);
    expect(texts()).toEqual(['b', 'c']);
  });
});
