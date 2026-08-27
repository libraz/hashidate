import { beforeEach, describe, expect, it } from 'vitest';
import { TurnQueue } from '@/server/queue';

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
