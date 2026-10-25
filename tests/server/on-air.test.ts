import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnAirOwners } from '@/server/on-air';
import { TurnQueue } from '@/server/queue';

/**
 * Which renderers own the line on air, and the grace before it is abandoned.
 */

const GRACE_MS = 3000;

let queue: TurnQueue;
let abandoned: string[];
let others: boolean;
let owners: OnAirOwners;

/** A line that has started, so it is on air rather than pending. */
function airing(text = 'line'): string {
  const [entry] = queue.add([{ text }]);
  queue.start(entry.id);
  return entry.id;
}

beforeEach(() => {
  vi.useFakeTimers();
  queue = new TurnQueue(() => 0);
  abandoned = [];
  others = false;
  owners = new OnAirOwners(
    queue,
    () => others,
    (turnId) => abandoned.push(turnId),
    GRACE_MS,
  );
});

afterEach(() => {
  owners.dispose();
  vi.useRealTimers();
});

describe('connection counting', () => {
  it('counts attachments per renderer and reports only the last detach', () => {
    owners.attach('a');
    owners.attach('a');
    expect(owners.connections('a')).toBe(2);
    expect(owners.detach('a')).toBe(false);
    expect(owners.connections('a')).toBe(1);
    expect(owners.detach('a')).toBe(true);
    expect(owners.connections('a')).toBe(0);
  });
});

describe('grace after the last owner leaves', () => {
  it('abandons the line once the grace has run out', () => {
    const id = airing();
    owners.attach('a');
    owners.noteTurnOwner(id, 'a');
    owners.detach('a');

    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(abandoned).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(abandoned).toEqual([id]);
  });

  it('keeps the line while another renderer that reported it is still connected', () => {
    const id = airing();
    owners.attach('a');
    owners.attach('b');
    owners.noteTurnOwner(id, 'a');
    owners.noteTurnOwner(id, 'b');
    owners.detach('a');

    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(abandoned).toEqual([]);
  });

  it('cancels the grace when the owner reattaches', () => {
    const id = airing();
    owners.attach('a');
    owners.noteTurnOwner(id, 'a');
    owners.detach('a');
    owners.attach('a');
    owners.rendererConnected('a');

    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(abandoned).toEqual([]);
  });

  it('never abandons a line owned by a report without a renderer id', () => {
    const id = airing();
    owners.noteTurnOwner(id);
    owners.attach('a');
    owners.noteTurnOwner(id, 'a');
    owners.detach('a');

    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(abandoned).toEqual([]);
  });

  it('treats an owner that reports before it connects as absent', () => {
    const id = airing();
    owners.noteTurnOwner(id, 'a');

    vi.advanceTimersByTime(GRACE_MS);
    expect(abandoned).toEqual([id]);
  });

  it('does not abandon a line that has already left the air', () => {
    const id = airing();
    owners.noteTurnOwner(id, 'a');
    queue.complete(id);

    vi.advanceTimersByTime(GRACE_MS);
    expect(abandoned).toEqual([]);
  });
});

describe('a renderer attaching to an ownerless line', () => {
  it('abandons it at once when no other client is connected', () => {
    const id = airing();
    owners.noteTurnOwner(id, 'a');
    owners.attach('b');
    owners.rendererConnected('b');

    expect(abandoned).toEqual([id]);
  });

  it('leaves the grace running when another client may still be reporting', () => {
    const id = airing();
    owners.noteTurnOwner(id, 'a');
    vi.advanceTimersByTime(GRACE_MS - 1);
    others = true;
    owners.attach('b');
    owners.rendererConnected('b');

    expect(abandoned).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(abandoned).toEqual([id]);
  });
});

describe('forgetting a line', () => {
  it('drops the owners and the timer when the turn ends', () => {
    const id = airing();
    owners.noteTurnOwner(id, 'a');
    owners.clearTurnOwners(id);

    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(abandoned).toEqual([]);
  });

  it('ignores an owner for a line the queue does not know', () => {
    owners.noteTurnOwner('nope', 'a');

    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(abandoned).toEqual([]);
  });

  it('stops every pending timer on dispose', () => {
    const id = airing();
    owners.noteTurnOwner(id, 'a');
    owners.dispose();

    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(abandoned).toEqual([]);
  });
});
