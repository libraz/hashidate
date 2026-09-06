import { describe, expect, it } from 'vitest';
import type { Take, Voice, VoiceReport } from '@/engine/types';
import { FakeTake } from './fakes';
import { build, DT, settle, VOICE_WAIT } from './harness';

class DeferredVoice implements Voice {
  readonly takes: FakeTake[] = [];
  private readonly pending: Array<(take: FakeTake) => void> = [];
  private answered = 0;

  constructor(private readonly now: () => number) {}

  prepare(): Promise<Take> {
    const take = new FakeTake(1, this.now);
    this.takes.push(take);
    return new Promise((resolve) => this.pending.push(() => resolve(take)));
  }

  async answerNext(): Promise<void> {
    this.pending.shift()?.(this.takes[this.answered++]);
    await settle();
  }

  readonly rooms = [];
  setRoom(): void {}
  readonly presets = [];
  setChain(): void {}
  report(): VoiceReport {
    return {
      preset: null,
      dsp: null,
      room: null,
      lufs: null,
      truePeakDb: null,
      blocked: false,
    };
  }
}

describe('session teardown', () => {
  it('stops a playing take and leaves a late answer eventless', async () => {
    let voice!: DeferredVoice;
    const { session, step } = build({
      voice: (now) => {
        voice = new DeferredVoice(now);
        return voice;
      },
    });

    session.say({ id: 'playing', text: 'あ', gesture: 'peace' });
    await voice.answerNext();
    step(1);
    expect(session.turn?.id).toBe('playing');
    expect(voice.takes[0].playedAt).not.toBeNull();

    session.takeEvents();
    session.say({ id: 'late', text: 'い' });
    session.takeEvents();
    session.dispose();

    expect(voice.takes[0].stopped).toBe(true);
    expect(session.takeEvents()).toEqual([
      { type: 'turn.end', turn: 'playing', interrupted: true },
    ]);

    await voice.answerNext();
    expect(voice.takes).toHaveLength(2);
    expect(voice.takes[1].stopped).toBe(true);
    expect(session.takeEvents()).toEqual([]);
  });

  it('stops active, prepared and late takes while ending only the active turn', async () => {
    let voice!: DeferredVoice;
    const { session, director, step } = build({
      voice: (now) => {
        voice = new DeferredVoice(now);
        return voice;
      },
    });

    session.say({ id: 'active', text: 'あ', expression: 'F_JITO', gesture: 'peace' });
    session.say({ id: 'prepared', text: 'い' });
    step(Math.ceil((VOICE_WAIT + 0.1) / DT));
    expect(session.turn?.id).toBe('active');
    expect(director.mouth.speaking).toBe(true);

    await voice.answerNext();
    await voice.answerNext();
    session.takeEvents();
    expect(voice.takes).toHaveLength(2);
    expect(voice.takes[0].stopped).toBe(true);

    session.say({ id: 'late', text: 'う' });
    session.takeEvents();
    session.dispose();

    expect(session.turn).toBeNull();
    expect(session.queue).toHaveLength(0);
    expect(director.mouth.speaking).toBe(false);
    expect(director.body.gesture?.released).toBe(true);
    expect(session.takeEvents()).toEqual([{ type: 'turn.end', turn: 'active', interrupted: true }]);

    await voice.answerNext();
    expect(voice.takes).toHaveLength(3);
    expect(voice.takes.every((take) => take.stopped)).toBe(true);

    // Teardown is idempotent and no later frame can publish another boundary.
    session.dispose();
    session.update(1);
    expect(session.takeEvents()).toEqual([]);
  });

  it('does not publish queue.dropped when there is no active turn', () => {
    const { session } = build();
    session.say({ id: 'pending', text: 'あ' });
    session.takeEvents();

    session.dispose();

    expect(session.takeEvents()).toEqual([]);
    expect(session.queue).toHaveLength(0);
  });
});
