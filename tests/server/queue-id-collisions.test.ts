import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnQueue } from '@/server/queue';

const fixedNow = 1_700_000_000_000;
const candidate = (sequence: number): string =>
  `q${fixedNow.toString(36)}-${sequence.toString(36)}`;

let queue: TurnQueue;

beforeEach(() => {
  queue = new TurnQueue();
  vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const pendingIds = (): string[] => queue.list().map((entry) => entry.id);
const storedIds = (): string[] => [
  ...pendingIds(),
  ...queue.airing().map((entry) => entry.id),
  ...queue.history().map((entry) => entry.id),
];

describe('TurnQueue generated ids', () => {
  it.each(['pending', 'on-air', 'history'] as const)(
    'add skips an id already in %s',
    (location) => {
      const occupied = queue.say({ id: candidate(1), text: 'caller' });
      if (location === 'on-air') queue.start(occupied.id);
      if (location === 'history') queue.complete(occupied.id);

      const [added] = queue.add([{ text: 'automatic' }]);

      expect(added.id).toBe(candidate(2));
      expect(storedIds()).toHaveLength(new Set(storedIds()).size);
    },
  );

  it('complete removes the generated line when its first candidate was already pending', () => {
    const caller = queue.say({ id: candidate(1), text: 'caller' });
    const [automatic] = queue.add([{ text: 'automatic' }]);

    expect(automatic.id).not.toBe(caller.id);
    expect(new Set(storedIds()).size).toBe(storedIds().length);
    expect(queue.complete(automatic.id)).toBe(true);
    expect(pendingIds()).toEqual([caller.id]);
    expect(queue.history().map((entry) => entry.text)).toEqual(['automatic']);
  });
});

describe('TurnQueue.say ids', () => {
  it('remints a duplicate caller id past the occupied generated candidate', () => {
    const first = queue.say({ id: candidate(1), text: 'first' });
    const second = queue.say({ id: candidate(1), text: 'duplicate' });

    expect(first.id).toBe(candidate(1));
    expect(second.id).toBe(candidate(2));
    expect(new Set(pendingIds()).size).toBe(2);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
  ] as const)('mints an id for an %s caller id past the occupied candidate', (_label, id) => {
    queue.say({ id: candidate(1), text: 'occupied' });

    const entry = queue.say(id === undefined ? { text: 'fallback' } : { id, text: 'fallback' });
    expect(entry.id).toBe(candidate(2));
  });
});

describe('TurnQueue.replace ids', () => {
  it('keeps the first accepted caller id and remints a duplicate later in the batch', () => {
    queue.replace([
      { id: 'chosen', text: 'first' },
      { id: 'chosen', text: 'second' },
    ]);

    expect(pendingIds()).toEqual(['chosen', candidate(1)]);
  });

  it('keeps an earlier caller id and avoids it for a later automatic id', () => {
    queue.replace([{ id: candidate(1), text: 'caller first' }, { text: 'automatic later' }]);

    expect(pendingIds()).toEqual([candidate(1), candidate(2)]);
    expect(queue.list().map((entry) => entry.text)).toEqual(['caller first', 'automatic later']);
  });

  it('remints an accepted caller id that is already in history', () => {
    const spoken = queue.say({ id: candidate(1), text: 'spoken' });
    queue.complete(spoken.id);

    queue.replace([{ id: spoken.id, text: 'replacement' }]);

    expect(pendingIds()).toEqual([candidate(2)]);
    expect(queue.history().map((entry) => entry.id)).toEqual([spoken.id]);
  });

  it('preserves left-to-right acceptance when an earlier generated id matches a later caller id', () => {
    queue.replace([{ text: 'generated first' }, { id: candidate(1), text: 'caller later' }]);

    expect(pendingIds()).toEqual([candidate(1), candidate(2)]);
    expect(queue.list().map((entry) => entry.text)).toEqual(['generated first', 'caller later']);
  });

  it('retains metadata when a pending entry is kept by id', () => {
    const [original] = queue.add([{ text: 'before', perform: 'hello' }], {
      source: 'script',
      note: 'operator note',
    });

    vi.mocked(Date.now).mockReturnValue(fixedNow + 1000);
    queue.replace([{ id: original.id, text: 'after' }]);

    expect(queue.list()[0]).toMatchObject({
      id: original.id,
      text: 'after',
      source: 'script',
      note: 'operator note',
      at: original.at,
    });
  });
});

describe('TurnQueue.rewind ids', () => {
  it('from with cut requeues history and airing entries without reusing occupied ids', () => {
    const pending = queue.say({ id: candidate(1), text: 'still pending' });
    const first = queue.say({ id: candidate(2), text: 'first spoken' });
    queue.complete(first.id);
    const second = queue.say({ id: candidate(3), text: 'second spoken' });
    queue.complete(second.id);
    const airing = queue.say({ id: candidate(4), text: 'cut on air' });
    queue.start(airing.id);

    const replay = queue.rewind(first.id, 'from', { cut: true });

    expect(replay?.map((entry) => entry.text)).toEqual([
      'first spoken',
      'second spoken',
      'cut on air',
    ]);
    expect(replay?.map((entry) => entry.id)).not.toEqual([first.id, second.id, airing.id]);
    expect(
      replay?.every((entry) => ![pending.id, first.id, second.id, airing.id].includes(entry.id)),
    ).toBe(true);
    expect(storedIds()).toHaveLength(new Set(storedIds()).size);
  });

  it('one does not reuse the original history id', () => {
    const original = queue.say({ id: candidate(1), text: 'repeat' });
    queue.complete(original.id);

    const replay = queue.rewind(original.id, 'one');

    expect(replay?.[0].id).not.toBe(original.id);
    expect(queue.history().map((entry) => entry.id)).toEqual([original.id]);
    expect(storedIds()).toHaveLength(new Set(storedIds()).size);
  });
});
