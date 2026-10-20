import { describe, expect, it } from 'vitest';
import { EMPTY } from '@/panel/hooks';
import { tallyState } from '@/panel/Panel';
import type { Snapshot } from '@/protocol';

/**
 * What the bar's tally says.
 *
 * Every combination of the four inputs, because the order of precedence is the
 * rule: a server that is gone outranks everything, a server with no renderer
 * outranks whatever stale turn it last heard of, and only then on air, held or
 * standing by.
 */

const snapshot = (connected: boolean, turn: boolean, paused: boolean): Snapshot => ({
  ...EMPTY,
  connected,
  state: { turn: turn ? 'q1' : null },
  paused,
});

describe('the tally', () => {
  it('follows the order of precedence in every combination', () => {
    for (const offline of [true, false]) {
      for (const connected of [true, false]) {
        for (const turn of [true, false]) {
          for (const paused of [true, false]) {
            const expected = offline
              ? 'offline'
              : !connected
                ? 'unattached'
                : turn
                  ? 'live'
                  : paused
                    ? 'held'
                    : 'idle';
            expect(
              tallyState(snapshot(connected, turn, paused), offline),
              JSON.stringify({ offline, connected, turn, paused }),
            ).toBe(expected);
          }
        }
      }
    }
  });
});
