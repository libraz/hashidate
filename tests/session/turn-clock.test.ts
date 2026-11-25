import { describe, expect, it } from 'vitest';
import { textToVisemes } from '@/engine/face';
import { FakeVoice } from './fakes';
import { build, DT, TURN_GAP, VOICE_WAIT } from './harness';

/** One loop iteration with a frame that took `elapsed` and was capped to `DT`. */
function frame(h: ReturnType<typeof build>, elapsed: number): void {
  h.session.update(DT, elapsed);
  h.director.update(DT, { elapsed });
}

describe('TurnQueue / elapsed', () => {
  it('runs the beat between turns down by elapsed', () => {
    const h = build();
    h.session.say({ id: 'a', text: 'あ' });
    h.runUntil(() => h.session.queue.length === 0);
    h.runUntil(() => h.session.state().turn === null);
    h.session.say({ id: 'b', text: 'い' });
    frame(h, TURN_GAP + 0.01);
    expect(h.session.state().turn).toBe('b');
  });

  it('counts the wait for a take in elapsed', () => {
    // Never answered, so the head of the queue waits until the silent fallback.
    const h = build({ voice: (now) => new FakeVoice(now, { defer: true }) });
    h.session.say({ id: 'a', text: 'あいう' });
    frame(h, VOICE_WAIT + textToVisemes('あいう').duration + 0.01);
    expect(h.session.state().turn).toBe('a');
  });

  it('measures the break in a run of speech in elapsed', () => {
    const h = build();
    h.session.say({ id: 'a', text: 'あ' });
    h.runUntil(() => h.session.queue.length === 0);
    h.runUntil(() => h.session.state().turn === null);
    // A long stall on an empty queue is a break in the run, as real time says.
    frame(h, 1.2);
    h.session.say({ id: 'b', text: 'い' });
    h.runUntil(() => h.session.state().turn === 'b');
    expect(h.director.speechOpens).toBe(true);
  });

  it('defaults elapsed to dt', () => {
    const h = build();
    h.session.say({ id: 'a', text: 'あ' });
    h.runUntil(() => h.session.queue.length === 0);
    h.runUntil(() => h.session.state().turn === null);
    h.session.say({ id: 'b', text: 'い' });
    h.session.update(DT);
    expect(h.session.state().turn).toBeNull();
  });
});
