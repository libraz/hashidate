import { describe, expect, it } from 'vitest';
import { textToVisemes } from '@/engine/face';
import { same } from '@/i18n/locale';
import { type FakeTake, FakeVoice } from './fakes';
import { build, DT, settle, VOICE_WAIT } from './harness';

/**
 * A line that is actually spoken: the take, the room it is heard in, and the
 * chain it goes out through.
 */

describe('a turn with a voice', () => {
  it('holds the turn back until the line has been synthesised', async () => {
    let voice: FakeVoice | null = null;
    const { session, step } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { defer: true });
        return voice;
      },
    });
    session.say({ text: 'あいうえお' });
    step(60);
    // Starting on the estimate and correcting when the audio turns up would put
    // a visible jump in the middle of every line. The take arrives first or the
    // line does not open.
    expect(session.turn).toBeNull();
    expect(session.queue).toHaveLength(1);

    await (voice as unknown as FakeVoice).answer();
    step(1);
    expect(session.turn?.text).toBe('あいうえお');
  });

  it('asks for every queued line at once, so only the first turn of a run waits', async () => {
    let voice: FakeVoice | null = null;
    const { session } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { defer: true });
        return voice;
      },
    });
    session.say({ text: 'あい' });
    session.say({ text: 'うえ' });
    session.say({ text: 'おか' });
    // Queued, not played: three requests are in flight before the first line
    // has opened, so the second and third are ready by the time they come up.
    expect((voice as unknown as FakeVoice).asked).toEqual(['あい', 'うえ', 'おか']);
  });

  it('stretches the viseme track onto the length the audio turned out to be', async () => {
    const { session, step } = build({ voice: (now) => new FakeVoice(now, { seconds: 3 }) });
    let seconds = 0;
    session.on((ev) => {
      if (ev.type === 'turn.start') seconds = ev.seconds ?? 0;
    });
    session.say({ text: 'あいうえお' });
    await settle();
    step(1);

    // The estimate for five morae is 0.675 s. The take is three seconds, and it
    // is the take that gets said.
    expect(textToVisemes('あいうえお').duration).toBeCloseTo(0.675, 6);
    expect(seconds).toBe(3);
  });

  it('keeps the line open for as long as the audio lasts', async () => {
    const { session, step, runUntil } = build({
      voice: (now) => new FakeVoice(now, { seconds: 3 }),
    });
    session.say({ text: 'あ' });
    await settle();
    step(1);
    // One mora is 0.135 s of estimate. Without the stretch the turn would be
    // over in a sixth of a second while the voice kept talking for another two.
    step(Math.ceil(2 / DT));
    expect(session.turn).not.toBeNull();
    runUntil(() => !session.busy);
  });

  it('puts the mouth on the audio clock rather than on the frame clock', async () => {
    // The take runs at half the harness's rate — a stand-in for the renderer
    // stalling, which is the only direction this ever goes wrong in: a frame is
    // never delivered early, so a mouth adding up `dt` can only run ahead.
    const { session, director, step } = build({
      voice: (now) => new FakeVoice(now, { seconds: 4, rate: 0.5 }),
    });
    session.say({ text: 'あいうえおかきくけこ' });
    await settle();
    step(1);
    step(60);

    // A second of frames, half a second of audio.
    expect(director.mouth.time).toBeGreaterThan(0.4);
    expect(director.mouth.time).toBeLessThan(0.6);
  });

  it('places a cue at the same fraction of the line the audio actually is', async () => {
    const { session, director, step } = build({
      voice: (now) => new FakeVoice(now, { seconds: 3 }),
    });
    session.say({ text: 'あいうえお[happy]かきくけこ' });
    await settle();
    step(1);

    // Halfway is 1.5 s of audio, not 0.675 s of estimate. A cue held as a time
    // rather than as a fraction would have fired at a fifth of the way in.
    step(Math.ceil(1.2 / DT));
    expect(director.performance).toBeNull();
    step(Math.ceil(0.5 / DT));
    expect(director.performance).toBe('happy');
  });

  it('scales mouth travel by how loud the take is right now', async () => {
    const { session, director, step } = build({
      voice: (now) => new FakeVoice(now, { seconds: 2 }),
    });
    session.say({ text: 'あいうえお' });
    await settle();
    step(1);
    const mouth = director.mouth;
    const take = session.turn?.take as FakeTake;
    step(30);
    expect(mouth.amplitude).toBe(1);

    // Silence in the middle of a take closes the mouth, whatever the track
    // thinks is being said there — which is what keeps a pause the text never
    // predicted from being mouthed through.
    take.amplitude = 0;
    step(30);
    expect(mouth.amplitude).toBe(0);
    expect(Object.values(mouth.weights).every((w) => w < 0.02)).toBe(true);
  });

  it('goes back to full travel on a line that has no audio', async () => {
    const { session, director, step, runUntil } = build({
      voice: (now) => new FakeVoice(now, { seconds: 1, nullAfter: 1 }),
    });
    session.say({ id: 'spoken', text: 'あいうえお' });
    session.say({ id: 'silent', text: 'かきくけこ' });
    await settle();
    step(1);
    (session.turn?.take as FakeTake).amplitude = 0.2;
    step(10);
    expect(director.mouth.amplitude).toBe(0.2);

    // The sidecar went away between the two lines, so the second has no
    // envelope to follow. Left alone the mouth would spend it a fifth open, for
    // no reason visible anywhere near the cause.
    runUntil(() => session.turn?.id === 'silent');
    step(1);
    expect(director.mouth.amplitude).toBe(1);
  });

  it('stops the audio when the line is cut off', async () => {
    let voice: FakeVoice | null = null;
    const { session, step } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { seconds: 5 });
        return voice;
      },
    });
    session.say({ text: 'あいうえお' });
    await settle();
    step(2);
    session.interrupt();
    // Otherwise the kill switch stops everything except the thing the viewer
    // can actually hear.
    expect((voice as unknown as FakeVoice).takes[0].stopped).toBe(true);
  });

  it('plays the line silently when the voice never answers', async () => {
    let voice: FakeVoice | null = null;
    const { session, step } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { defer: true });
        return voice;
      },
    });
    session.say({ text: 'あいうえお' });
    step(Math.ceil((VOICE_WAIT + 0.2) / DT));
    // A wedged sidecar must cost the line its sound and nothing else. A stream
    // that stops dead is the worse failure.
    expect(session.turn?.text).toBe('あいうえお');
    expect(session.turn?.take).toBeUndefined();
    void voice;
  });

  it('plays the line silently when synthesis fails, rather than dropping the turn', async () => {
    const { session, step } = build({ voice: (now) => new FakeVoice(now, { fail: true }) });
    session.say({ text: 'あいうえお' });
    await settle();
    step(1);
    expect(session.turn?.text).toBe('あいうえお');
    expect(session.turn?.take).toBeNull();
  });

  it('does not ask the voice for a turn with no words in it', async () => {
    let voice: FakeVoice | null = null;
    const { session, step } = build({
      voice: (now) => {
        voice = new FakeVoice(now);
        return voice;
      },
    });
    session.say({ perform: 'hello' });
    await settle();
    step(1);
    // A pose change has nothing to say, and a turn that waited for a take that
    // was never coming would stall the queue for `VOICE_WAIT` every time.
    expect((voice as unknown as FakeVoice).asked).toEqual([]);
    expect(session.turn?.perform).toBe('hello');
  });
});

describe('the room the voice is heard in', () => {
  it('forwards the room to the voice and keeps it there', () => {
    let voice: FakeVoice | null = null;
    const { session } = build({
      voice: (now) => {
        voice = new FakeVoice(now);
        return voice;
      },
    });
    session.setRoom('hall');
    session.setRoom(null);
    session.setRoom('booth');
    // Verbatim, including the null: deciding what an unknown or absent id means
    // is the voice's job, because the room table is its data and not the
    // session's. The session only carries the name across.
    expect((voice as unknown as FakeVoice).roomsSet).toEqual(['hall', null, 'booth']);
  });

  it('advertises the voice’s rooms in the vocabulary', () => {
    const { session } = build({ voice: (now) => new FakeVoice(now) });
    expect(session.vocabulary().rooms).toEqual([
      { id: 'booth', label: same('ブース') },
      { id: 'hall', label: same('ホール') },
    ]);
  });

  it('has no rooms and does nothing without a voice', () => {
    const { session } = build();
    // The distinction a caller needs: an empty list says `room` will not do
    // anything here, rather than leaving them to send one and watch for a
    // change that never comes.
    expect(session.vocabulary().rooms).toEqual([]);
    expect(() => session.setRoom('hall')).not.toThrow();
  });
});

describe('the voice chain', () => {
  it('forwards the request verbatim, including an absent preset', () => {
    let voice: FakeVoice | null = null;
    const { session } = build({
      voice: (now) => {
        voice = new FakeVoice(now);
        return voice;
      },
    });
    session.setVoiceChain({ preset: 'bright-idol' });
    session.setVoiceChain({ dsp: { retune: { semitones: 3 } } });
    session.setVoiceChain({ preset: null });
    // Absent and null are different answers — keep the base, versus bypass —
    // and defaulting either of them here would take that distinction away from
    // the only layer that can act on it.
    expect((voice as unknown as FakeVoice).chainsSet).toEqual([
      { preset: 'bright-idol', dsp: undefined },
      { preset: undefined, dsp: { retune: { semitones: 3 } } },
      { preset: null, dsp: undefined },
    ]);
  });

  it('advertises the voice’s presets, and none without a voice', () => {
    expect(build({ voice: (now) => new FakeVoice(now) }).session.vocabulary().voicePresets).toEqual(
      [{ id: 'neutral-monitor', label: same('素のまま') }],
    );
    const { session } = build();
    expect(session.vocabulary().voicePresets).toEqual([]);
    expect(() => session.setVoiceChain({ preset: 'bright-idol' })).not.toThrow();
  });
});
