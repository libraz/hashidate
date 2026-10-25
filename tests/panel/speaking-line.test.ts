import { describe, expect, it } from 'vitest';
import { EMPTY } from '@/panel/hooks';
import { idleActOnAir, lineOnAir } from '@/panel/preview/SpeakingLine';
import type { QueueEntry, Snapshot } from '@/protocol';

/**
 * What the panel reads out under the picture.
 *
 * The readout is the operator's answer to "what is it saying right now", and
 * every case below is one where the honest answer is silence: a line that
 * ended, a renderer that went stale, a server too old to report the set at all.
 * Showing the wrong sentence there is worse than showing none, because it is
 * read while the operator is looking at the render rather than at the panel.
 */

const entry = (id: string, text: string): QueueEntry => ({ id, text, at: 1_800_000_000 });

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({ ...EMPTY, ...over });

describe('the line on air', () => {
  it('reads the words out of the server-held entry the running turn names', () => {
    expect(
      lineOnAir(
        snapshot({
          state: { speaking: true, turn: 'q2' },
          airing: [entry('q1', 'ended'), entry('q2', 'こんばんは。')],
        }),
      ),
    ).toBe('こんばんは。');
  });

  it('takes the cue markup out, since none of it is spoken', () => {
    expect(
      lineOnAir(
        snapshot({
          state: { turn: 'q1' },
          airing: [entry('q1', '[hello]こんばんは。[explain]今日は…')],
        }),
      ),
    ).toBe('こんばんは。今日は…');
  });

  it('says nothing when no turn is running', () => {
    expect(lineOnAir(snapshot({ state: { turn: null }, airing: [entry('q1', 'あ')] }))).toBeNull();
  });

  it('says nothing for a stale state, which carries no turn to match', () => {
    // The hub withholds the whole state rather than serving one that has aged
    // out, so a renderer that has gone quiet takes the readout with it — while
    // the entry it started is still standing in the airing set.
    expect(lineOnAir(snapshot({ state: {}, airing: [entry('q1', 'あ')] }))).toBeNull();
  });

  it('says nothing for a turn the server has no words for', () => {
    // A `say` posted straight to `/api/command` never enters the queue, so the
    // line on air is genuinely not the server's to report.
    expect(lineOnAir(snapshot({ state: { turn: 'c3-1' }, airing: [] }))).toBeNull();
  });

  it('says nothing when the server does not report what is on air at all', () => {
    const { airing: _absent, ...older } = snapshot({ state: { turn: 'q1' } });
    expect(lineOnAir(older)).toBeNull();
  });

  it('reads an empty string for a turn that is a gesture and no dialogue', () => {
    // Distinct from null: something is on air, and it has nothing to say. The
    // strip draws that as a note rather than as standing by.
    expect(lineOnAir(snapshot({ state: { turn: 'q1' }, airing: [entry('q1', '')] }))).toBe('');
  });
});

describe('the idle act on air', () => {
  const peace = {
    id: 'peace',
    label: { en: 'Peace', ja: 'ピース' },
    group: 'idol' as const,
    emotion: { joy: 1 },
    gesture: 'peace',
    hop: null,
    sustain: false,
  };
  const vocabulary = { performances: [peace] };

  it("names the autopilot's pick while the idle is engaged between turns", () => {
    expect(
      idleActOnAir(
        snapshot({ state: { turn: null, idle: true, performance: 'peace' }, vocabulary }),
      ),
    ).toEqual(peace.label);
  });

  it('says nothing while a turn is running, which the strip reads out instead', () => {
    expect(
      idleActOnAir(
        snapshot({ state: { turn: 'q1', idle: true, performance: 'peace' }, vocabulary }),
      ),
    ).toBeNull();
  });

  it("says nothing when the idle is not engaged, since the performance is the caller's", () => {
    expect(
      idleActOnAir(
        snapshot({ state: { turn: null, idle: false, performance: 'peace' }, vocabulary }),
      ),
    ).toBeNull();
  });

  it('says nothing for an id the avatar does not offer', () => {
    expect(
      idleActOnAir(
        snapshot({ state: { turn: null, idle: true, performance: 'ghost' }, vocabulary }),
      ),
    ).toBeNull();
  });
});
