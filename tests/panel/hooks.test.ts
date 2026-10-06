import { describe, expect, it } from 'vitest';
import { EMPTY_BGM, normalizeBgmState, singleFlight } from '@/panel/hooks';
import type { BgmState, Snapshot } from '@/protocol';

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

describe('normalizeBgmState', () => {
  it('fills DSP groups omitted by an older server without resetting known leaves', () => {
    const legacy = {
      ...EMPTY_BGM,
      dsp: {
        toneDb: -2,
        compression: 0.4,
        width: 1.25,
        reverb: { mix: 0.2, decay: 0.7, damping: 0.3 },
      },
    } as unknown as BgmState;

    const normalized = normalizeBgmState(legacy);

    expect(normalized).toMatchObject({
      dsp: {
        toneDb: -2,
        compression: 0.4,
        width: 1.25,
        reverb: { mix: 0.2, decay: 0.7, damping: 0.3 },
        pitch: { semitones: 0, mix: 0 },
        presence: { amount: 0, drive: 2, frequencyHz: 3200 },
      },
    });
    expect(normalized).not.toBe(legacy);
    expect(normalized?.dsp).not.toBe(legacy.dsp);
  });

  it('merges partial new groups while preserving their supplied leaves', () => {
    const state = {
      ...EMPTY_BGM,
      dsp: {
        ...EMPTY_BGM.dsp,
        pitch: { semitones: 7, mix: 0.35 },
        presence: { amount: 0.25, drive: 3, frequencyHz: 3200 },
      },
    };

    expect(normalizeBgmState(state)?.dsp).toEqual(state.dsp);
  });
});
