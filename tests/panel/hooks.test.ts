import { describe, expect, it } from 'vitest';
import { singleFlight } from '@/panel/hooks';
import type { Snapshot } from '@/protocol';

const snap = (seq: number) => ({ seq }) as unknown as Snapshot;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness(reads: Array<Promise<Snapshot | { error: string }>>) {
  let calls = 0;
  const shown: number[] = [];
  const errors: string[] = [];
  const poll = singleFlight(() => reads[calls++], {
    alive: () => true,
    onFailure: (message) => errors.push(message),
    onSnapshot: (next) => shown.push(next.seq),
  });
  return { poll, shown, errors, calls: () => calls };
}

describe('singleFlight', () => {
  it('coalesces requests made during a read into one follow-up', async () => {
    const first = deferred<Snapshot>();
    const h = harness([first.promise, Promise.resolve(snap(2)), Promise.resolve(snap(3))]);
    const running = h.poll();
    void h.poll();
    void h.poll();
    expect(h.calls()).toBe(1);
    first.resolve(snap(1));
    await running;
    expect(h.calls()).toBe(2);
    expect(h.shown).toEqual([1, 2]);
  });

  it('drops a snapshot older than the one shown', async () => {
    const h = harness([Promise.resolve(snap(5)), Promise.resolve(snap(4))]);
    await h.poll();
    await h.poll();
    expect(h.shown).toEqual([5]);
  });

  it('accepts a lower seq after a failure, as a restarted server counts again', async () => {
    const h = harness([
      Promise.resolve(snap(9)),
      Promise.resolve({ error: 'down' }),
      Promise.resolve(snap(1)),
    ]);
    await h.poll();
    await h.poll();
    await h.poll();
    expect(h.errors).toEqual(['down']);
    expect(h.shown).toEqual([9, 1]);
  });

  it('allows a new read once the previous one has finished', async () => {
    const h = harness([Promise.resolve(snap(1)), Promise.resolve(snap(2))]);
    await h.poll();
    await h.poll();
    expect(h.calls()).toBe(2);
  });
});
