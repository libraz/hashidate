import { describe, expect, it } from 'vitest';
import { EMPTY } from '@/panel/hooks';
import { transport } from '@/panel/Panel';
import type { QueueEntry, Snapshot } from '@/protocol';

/**
 * When the header's Stop and Drop can be pressed.
 *
 * Neither may be a no-op that looks live: Stop is for a run in progress, Drop
 * for lines still waiting. The playing-ness of a queue is read from every
 * signal the snapshot has, because each of them can be the only one set.
 */

const entry = (id: string): QueueEntry => ({ id, text: 'あ', at: 1_800_000_000 });

const snapshot = (over: {
  airing?: boolean;
  turn?: boolean;
  speaking?: boolean;
  pending?: boolean;
  paused?: boolean;
}): Snapshot => ({
  ...EMPTY,
  airing: over.airing ? [entry('q1')] : [],
  state: { turn: over.turn ? 'q1' : null, speaking: over.speaking ?? false },
  queue: over.pending ? [entry('q2')] : [],
  paused: over.paused ?? false,
});

describe('the transport buttons', () => {
  it('are both disabled with nothing on air and nothing waiting', () => {
    expect(transport(snapshot({}))).toEqual({ stop: false, drop: false });
    expect(transport(snapshot({ paused: true }))).toEqual({ stop: false, drop: false });
  });

  it('leave Stop off for a held queue, which is not playing', () => {
    expect(transport(snapshot({ pending: true, paused: true }))).toEqual({
      stop: false,
      drop: true,
    });
  });

  it('keep Stop on between two lines of a running queue', () => {
    expect(transport(snapshot({ pending: true }))).toEqual({ stop: true, drop: true });
  });

  it('keep Stop on for a line on air, whichever signal says so', () => {
    for (const signal of ['airing', 'turn', 'speaking'] as const) {
      expect(transport(snapshot({ [signal]: true, paused: true })).stop, signal).toBe(true);
    }
  });

  it('follow the rule in every combination', () => {
    const flags = ['airing', 'turn', 'speaking', 'pending', 'paused'] as const;
    for (let bits = 0; bits < 1 << flags.length; bits += 1) {
      const on = Object.fromEntries(flags.map((flag, i) => [flag, (bits & (1 << i)) !== 0]));
      const onAir = on.airing || on.turn || on.speaking;
      expect(transport(snapshot(on)), JSON.stringify(on)).toEqual({
        stop: onAir || (on.pending && !on.paused),
        drop: on.pending,
      });
    }
  });
});
