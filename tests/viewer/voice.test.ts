import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceDsp } from '@/protocol';
import { BrowserAudioOutput } from '@/viewer/audio-output';
import { buildImpulse } from '@/viewer/rooms';
import { BrowserVoice, buildEnvelope, envelopeAt, startContext } from '@/viewer/voice';
import { loadBase, measure, mergeDsp, processTake } from '@/viewer/voice-chain';
import { build as buildSession, settle } from '../session/harness';

// The browser graph below is real (in-memory Web Audio nodes), while the
// optional WASM preset resolver is kept out of these deterministic tests. The
// bypass path is the documented fallback when the processor is unavailable.
vi.mock('@/viewer/voice-chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/viewer/voice-chain')>();
  return {
    ...actual,
    loadBase: vi.fn(async () => ({})),
    processTake: vi.fn(actual.processTake),
    measure: vi.fn(actual.measure),
  };
});

vi.mock('@/viewer/rooms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/viewer/rooms')>();
  return { ...actual, buildImpulse: vi.fn() };
});

/**
 * The envelope the mouth follows, measured off a decoded take.
 *
 * Only the arithmetic is tested here — the parts that need an `AudioContext`
 * need a browser, and the reason this is a pure function taking samples rather
 * than an analyser node reading a live graph is so that the part worth checking
 * can be.
 */

const RATE = 48_000;

/** A tone at a given amplitude, for `seconds`. */
function tone(amplitude: number, seconds: number, hz = 220): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
  }
  return out;
}

const concat = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

interface FakeAudioNode {
  kind: string;
  connections: unknown[];
  gain?: { value: number };
  buffer?: AudioBuffer | null;
  connect(destination: unknown): unknown;
  disconnect(): void;
}

function audioNode(kind: string): FakeAudioNode {
  const value: FakeAudioNode = {
    kind,
    connections: [],
    connect(destination) {
      value.connections.push(destination);
      return destination;
    },
    disconnect() {
      value.connections = [];
    },
  };
  if (kind === 'gain') value.gain = { value: 0 };
  if (kind === 'convolver') value.buffer = null;
  return value;
}

function audioBuffer(samples: Float32Array, sampleRate = 1_000): AudioBuffer {
  return {
    duration: samples.length / sampleRate,
    length: samples.length,
    numberOfChannels: 1,
    sampleRate,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

function webAudioEnvironment(
  options: { blocked?: boolean; decodeError?: boolean; muted?: boolean } = {},
) {
  vi.mocked(loadBase).mockReset().mockResolvedValue({});
  const destination = audioNode('destination');
  const capture = audioNode('capture') as FakeAudioNode & { stream: MediaStream };
  capture.stream = { id: 'capture' } as unknown as MediaStream;
  const created: FakeAudioNode[] = [];
  const decoded = audioBuffer(new Float32Array(1_000).fill(0.5));
  vi.mocked(buildImpulse).mockReset().mockResolvedValue(decoded);
  let decodeCalls = 0;
  const sources: Array<
    FakeAudioNode & {
      buffer: AudioBuffer | null;
      startCalls: number;
      start: () => void;
      stop: () => void;
    }
  > = [];
  const context = {
    state: options.blocked ? ('suspended' as AudioContextState) : ('running' as AudioContextState),
    currentTime: 10,
    sampleRate: 1_000,
    destination,
    createGain: () => {
      const node = audioNode('gain');
      created.push(node);
      return node;
    },
    createConvolver: () => {
      const node = audioNode('convolver');
      created.push(node);
      return node;
    },
    createMediaStreamDestination: () => {
      created.push(capture);
      return capture;
    },
    createBufferSource: () => {
      const source = audioNode('source') as FakeAudioNode & {
        buffer: AudioBuffer | null;
        startCalls: number;
        start: () => void;
        stop: () => void;
      };
      source.buffer = null;
      source.startCalls = 0;
      source.start = () => {
        source.startCalls++;
      };
      source.stop = () => {};
      sources.push(source);
      return source;
    },
    createBuffer: (_channels: number, length: number, sampleRate: number) =>
      audioBuffer(new Float32Array(length), sampleRate),
    decodeAudioData: async () => {
      decodeCalls++;
      if (options.decodeError) throw new Error('invalid audio');
      return decoded;
    },
    resume: async () => {},
    close: async () => {},
  };
  const output = new BrowserAudioOutput({
    context: context as unknown as AudioContext,
    muted: options.muted ?? false,
    resumeWaitMs: 5,
  });
  const voice = new BrowserVoice({ base: '/api', output });
  // Do not let the optional processor load race these graph tests. Bypass is
  // also the expected behavior when libsonare is not available on a checkout.
  voice.setChain({ preset: null });
  const send = vi.fn(async (_url: string, _request: RequestInit) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(1),
  }));
  vi.stubGlobal('fetch', send);
  return {
    context,
    created,
    decoded,
    decodeCalls: () => decodeCalls,
    output,
    voice,
    sources,
    send,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('buildEnvelope', () => {
  it('runs at a hundred windows a second', () => {
    expect(buildEnvelope(tone(0.5, 1), RATE)).toHaveLength(100);
    expect(buildEnvelope(tone(0.5, 2.5), RATE)).toHaveLength(250);
  });

  it('normalises to the take rather than to an absolute level', () => {
    // The same words said quietly and loudly must move the mouth the same
    // amount. Any fixed gain would have to be retuned every time the voice was
    // retrained, or every time a reference clip was normalised differently.
    const quiet = buildEnvelope(tone(0.02, 1), RATE);
    const loud = buildEnvelope(tone(0.9, 1), RATE);
    expect(Math.max(...quiet)).toBeCloseTo(1, 3);
    expect(Math.max(...loud)).toBeCloseTo(1, 3);
  });

  it('is not decided by one loud instant', () => {
    // A single plosive against a whole quiet line. Referenced to the peak, the
    // rest of the line would sit near zero and the mouth would barely open for
    // any of it.
    const envelope = buildEnvelope(concat(tone(1, 0.02), tone(0.1, 2)), RATE);
    const body = Array.from(envelope.slice(20));
    expect(Math.min(...body)).toBeGreaterThan(0.9);
  });

  it('follows the loudness through a line, and closes on the silence in it', () => {
    const envelope = buildEnvelope(concat(tone(0.6, 0.5), tone(0, 0.5), tone(0.6, 0.5)), RATE);
    expect(envelopeAt(envelope, 0.25)).toBeGreaterThan(0.9);
    // The pause the text never predicted. This is the whole reason the mouth is
    // scaled by an envelope and not left to the track alone.
    expect(envelopeAt(envelope, 0.75)).toBe(0);
    expect(envelopeAt(envelope, 1.25)).toBeGreaterThan(0.9);
  });

  it('yields silence for silence rather than dividing by nothing', () => {
    const envelope = buildEnvelope(tone(0, 1), RATE);
    expect(Array.from(envelope).every((v) => v === 0)).toBe(true);
  });

  it('survives an empty take', () => {
    expect(Array.from(buildEnvelope(new Float32Array(0), RATE))).toEqual([0]);
  });
});

/**
 * Starting the audio device.
 *
 * The one part of this that needs a browser and is still worth testing here,
 * because what it exists for is a browser behaviour rather than an arithmetic:
 * a context the page has not earned the right to start leaves `resume()`
 * pending forever rather than rejecting it. Awaiting that directly is what made
 * a viewer nobody had clicked silent for the rest of its life — the requests are
 * chained, so the line that waited took every line behind it with it.
 */
describe('startContext', () => {
  /** A context that answers a `resume()` the way the browser is willing to. */
  const fake = (state: AudioContextState, starts: boolean) => {
    const ctx = {
      state,
      resume: () =>
        starts
          ? Promise.resolve().then(() => {
              ctx.state = 'running';
            })
          : // Refused: never settles. Not a rejection — that would be a kindness
            // the browser does not extend.
            new Promise<void>(() => {}),
    };
    return ctx;
  };

  it('answers immediately for a context that is already running', async () => {
    const ctx = fake('running', true);
    expect(await startContext(ctx, 50)).toBe(true);
  });

  it('starts a suspended context the browser is willing to start', async () => {
    const ctx = fake('suspended', true);
    expect(await startContext(ctx, 50)).toBe(true);
    expect(ctx.state).toBe('running');
  });

  it('gives up on a refusal instead of waiting on a promise that never settles', async () => {
    const ctx = fake('suspended', false);
    expect(await startContext(ctx, 20)).toBe(false);
    expect(ctx.state).toBe('suspended');
  });

  it('can be asked again, which is how the voice comes back after a click', async () => {
    const ctx = fake('suspended', false);
    expect(await startContext(ctx, 20)).toBe(false);
    // The page has been interacted with. The same context starts on a second
    // ask, which is why it is kept rather than thrown away and rebuilt.
    ctx.resume = () =>
      Promise.resolve().then(() => {
        ctx.state = 'running';
      });
    expect(await startContext(ctx, 20)).toBe(true);
  });

  it('will not reopen a context that was closed on teardown', async () => {
    const ctx = fake('closed', true);
    expect(await startContext(ctx, 20)).toBe(false);
    expect(ctx.state).toBe('closed');
  });
});

describe('envelopeAt', () => {
  it('reads silence outside the take, so a clock past the end closes the mouth', () => {
    // `elapsed` runs on past the audio deliberately — it is how the mouth knows
    // the line is over — so being asked beyond the end is the normal case.
    const envelope = buildEnvelope(tone(0.5, 1), RATE);
    expect(envelopeAt(envelope, 1.5)).toBe(0);
    expect(envelopeAt(envelope, -0.2)).toBe(0);
  });
});

describe('BrowserVoice with an in-memory Web Audio graph', () => {
  it('decodes a take, keeps its clock, and routes dry/wet gain into the output bus', async () => {
    const fake = webAudioEnvironment();
    const captured = await fake.voice.captureStream();
    expect(captured).toBe(fake.output.captureDestination.stream);

    const take = await fake.voice.prepare('hello');
    expect(take).not.toBeNull();
    expect(fake.send).toHaveBeenCalledWith(
      '/api/speech',
      expect.objectContaining({ body: JSON.stringify({ text: 'hello' }) }),
    );
    expect(fake.decodeCalls()).toBe(1);

    const chainGains = fake.created.filter((node) => node.kind === 'gain').slice(-4);
    expect(chainGains[1].gain?.value).toBe(1);
    expect(chainGains[2].gain?.value).toBe(0);
    expect(chainGains[3].connections).toContain(fake.output.voiceBus);

    take?.play();
    expect(fake.sources[0].startCalls).toBe(1);
    fake.context.currentTime = 10.25;
    expect(take?.elapsed).toBeCloseTo(0.25);
    expect(take?.amplitude).toBeGreaterThan(0.9);
    take?.stop();
    expect(take?.elapsed).toBeCloseTo(0.25);
    expect(take?.amplitude).toBe(0);
    take?.stop();

    fake.voice.dispose();
    fake.output.dispose();
  });

  it('keeps a decode failure silent and reports a refused audio clock as blocked', async () => {
    const decodeFailure = webAudioEnvironment({ decodeError: true });
    expect(await decodeFailure.voice.prepare('bad audio')).toBeNull();
    expect(decodeFailure.voice.isBlocked).toBe(false);
    decodeFailure.voice.dispose();
    decodeFailure.output.dispose();

    const blocked = webAudioEnvironment({ blocked: true });
    expect(await blocked.voice.prepare('not yet')).toBeNull();
    expect(blocked.voice.isBlocked).toBe(true);
    expect(blocked.voice.report().blocked).toBe(true);
    expect(blocked.send).not.toHaveBeenCalled();
    blocked.voice.dispose();
    blocked.output.dispose();
  });

  it('recovers a paused session queue through BrowserVoice output unlock', async () => {
    const fake = webAudioEnvironment({ blocked: true });
    const { session, step } = buildSession({ voice: () => fake.voice });
    const startedSeconds: number[] = [];
    session.on((event) => {
      if (event.type === 'turn.start' && event.seconds !== undefined) {
        startedSeconds.push(event.seconds);
      }
    });
    session.paused = true;
    session.say({ id: 'first', text: 'あ' });
    session.say({ id: 'second', text: 'い' });

    await vi.waitFor(() => expect(session.queue.map((turn) => turn.take)).toEqual([null, null]));
    expect(fake.send).not.toHaveBeenCalled();

    fake.context.state = 'running';
    await fake.output.ensureRunning();
    await settle();
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(fake.decodeCalls()).toBe(2));
    await vi.waitFor(() =>
      expect(session.queue.every((turn) => turn.take !== null && turn.take !== undefined)).toBe(
        true,
      ),
    );

    session.paused = false;
    step(1);
    expect(session.turn?.id).toBe('first');
    expect(fake.sources).toHaveLength(1);
    expect(fake.sources[0].startCalls).toBe(1);
    expect(startedSeconds[0]).toBe(fake.decoded.duration);

    session.dispose();
    fake.voice.dispose();
    fake.output.dispose();
  });

  it('does not recreate removed queue work after session disposal and unlock', async () => {
    const fake = webAudioEnvironment({ blocked: true });
    const { session } = buildSession({ voice: () => fake.voice });
    session.paused = true;
    session.say({ id: 'removed', text: 'あ' });
    await vi.waitFor(() => expect(session.queue[0]?.take).toBeNull());

    session.dispose();
    fake.context.state = 'running';
    await fake.output.ensureRunning();
    await settle();

    expect(session.queue).toHaveLength(0);
    expect(fake.send).not.toHaveBeenCalled();
    fake.voice.dispose();
    fake.output.dispose();
  });

  it('keeps the sidecar retry budget after an unlock retry gets a 503', async () => {
    const fake = webAudioEnvironment({ blocked: true });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { session } = buildSession({ voice: () => fake.voice });
    session.paused = true;
    session.say({ id: 'a', text: 'あ' });
    session.say({ id: 'b', text: 'い' });

    await vi.waitFor(() => expect(session.queue.map((turn) => turn.take)).toEqual([null, null]));
    fake.send.mockResolvedValueOnce({
      ok: false,
      status: 503,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    fake.send.mockResolvedValueOnce({
      ok: false,
      status: 503,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    fake.context.state = 'running';
    await fake.output.ensureRunning();
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(session.queue.map((turn) => turn.take)).toEqual([null, null]));

    now.mockReturnValue(21_001);
    session.say({ id: 'c', text: 'う' });
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledTimes(5));
    expect(
      fake.send.mock.calls.map(([, request]) => JSON.parse(String(request.body)).text),
    ).toEqual(['あ', 'い', 'う', 'あ', 'い']);
    await vi.waitFor(() =>
      expect(session.queue.every((turn) => turn.take !== null && turn.take !== undefined)).toBe(
        true,
      ),
    );
    expect(fake.decodeCalls()).toBe(3);

    session.dispose();
    fake.voice.dispose();
    fake.output.dispose();
  });

  it('still prepares muted preview audio while the shared context is suspended', async () => {
    const fake = webAudioEnvironment({ blocked: true, muted: true });
    let wall = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    const take = await fake.voice.prepare('preview');

    expect(take?.seconds).toBe(fake.decoded.duration);
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.output.master.gain.value).toBe(0);
    take?.play();
    expect(fake.sources[0].startCalls).toBe(1);
    wall += 300;
    expect(take?.elapsed).toBeGreaterThan(0.25);

    fake.voice.dispose();
    fake.output.dispose();
  });

  it('backs off a missing sidecar after 503 and retries after the fixed interval', async () => {
    const fake = webAudioEnvironment();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    fake.send.mockResolvedValueOnce({
      ok: false,
      status: 503,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    expect(await fake.voice.prepare('first')).toBeNull();
    expect(await fake.voice.prepare('during backoff')).toBeNull();
    expect(fake.send).toHaveBeenCalledTimes(1);

    now.mockReturnValue(21_001);
    expect(await fake.voice.prepare('after backoff')).not.toBeNull();
    expect(fake.send).toHaveBeenCalledTimes(2);

    fake.voice.dispose();
    fake.output.dispose();
  });

  it('announces availability only after its own audio device refusal', async () => {
    const normal = webAudioEnvironment();
    const normalListener = vi.fn();
    expect(normal.voice.onAvailable).toEqual(expect.any(Function));
    normal.voice.onAvailable?.(normalListener);
    await normal.output.ensureRunning();
    expect(normalListener).not.toHaveBeenCalled();

    normal.send.mockResolvedValueOnce({
      ok: false,
      status: 503,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    expect(await normal.voice.prepare('missing')).toBeNull();
    expect(normalListener).not.toHaveBeenCalled();
    normal.voice.dispose();
    normal.output.dispose();

    const refused = webAudioEnvironment({ blocked: true });
    const refusedListener = vi.fn();
    refused.voice.onAvailable?.(refusedListener);
    expect(await refused.voice.prepare('not yet')).toBeNull();
    expect(refusedListener).not.toHaveBeenCalled();
    refused.context.state = 'running';
    await refused.output.ensureRunning();
    expect(refusedListener).toHaveBeenCalledTimes(1);
    refused.voice.dispose();
    refused.output.dispose();

    const concurrent = webAudioEnvironment({ blocked: true });
    const concurrentListener = vi.fn();
    concurrent.voice.onAvailable?.(concurrentListener);
    expect(await concurrent.voice.prepare('not yet')).toBeNull();
    concurrent.context.state = 'running';
    await concurrent.voice.captureStream();
    expect(concurrentListener).toHaveBeenCalledTimes(1);
    concurrent.voice.dispose();
    concurrent.output.dispose();
  });

  it('clears the blocked warning the moment the output unlocks, without another line', async () => {
    const fake = webAudioEnvironment({ blocked: true });
    expect(await fake.voice.prepare('not yet')).toBeNull();
    expect(fake.voice.report().blocked).toBe(true);

    // A gesture, or anything else that gets the shared context running.
    fake.context.state = 'running';
    await fake.output.ensureRunning();
    expect(fake.voice.report().blocked).toBe(false);
    expect(fake.send).not.toHaveBeenCalled();

    fake.voice.dispose();
    fake.output.dispose();
  });

  it('meters the take that last started playing, and nothing once bypassed', async () => {
    const fake = webAudioEnvironment();
    fake.voice.setChain({ preset: 'default' });
    await vi.waitFor(() => expect(fake.voice.report().dsp).not.toBeNull());
    vi.mocked(processTake).mockImplementation((samples) => Float32Array.from(samples));
    vi.mocked(measure)
      .mockReturnValueOnce({ lufs: -20, truePeakDb: -2 })
      .mockReturnValueOnce({ lufs: -10, truePeakDb: -1 });

    const first = await fake.voice.prepare('one');
    const second = await fake.voice.prepare('two');
    // Both are made; neither has been heard.
    expect(fake.voice.report().lufs).toBeNull();
    first?.play();
    expect(fake.voice.report()).toMatchObject({ lufs: -20, truePeakDb: -2 });
    second?.play();
    expect(fake.voice.report()).toMatchObject({ lufs: -10, truePeakDb: -1 });

    fake.voice.setChain({ preset: null });
    expect(fake.voice.report()).toMatchObject({ lufs: null, truePeakDb: null });
    vi.mocked(processTake).mockReset();
    vi.mocked(measure).mockReset();
    fake.voice.dispose();
    fake.output.dispose();
  });

  it('still asks for the lines queued before a failure, and backs off only later ones', async () => {
    const fake = webAudioEnvironment();
    fake.send.mockRejectedValueOnce(new Error('connection refused'));
    // A batch: all three are asked for before the first answers.
    const takes = [fake.voice.prepare('a'), fake.voice.prepare('b'), fake.voice.prepare('c')];
    const [a, b, c] = await Promise.all(takes);

    expect(a).toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(fake.send).toHaveBeenCalledTimes(3);

    fake.voice.dispose();
    fake.output.dispose();
  });

  it('skips a dropped line without the sidecar, and cuts one in flight without backing off', async () => {
    const fake = webAudioEnvironment();
    const before = new AbortController();
    before.abort();
    expect(await fake.voice.prepare('dropped', undefined, before.signal)).toBeNull();
    expect(fake.send).not.toHaveBeenCalled();

    const during = new AbortController();
    fake.send.mockImplementationOnce(async () => {
      during.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    expect(await fake.voice.prepare('cut', undefined, during.signal)).toBeNull();
    // The next line is asked for: a cut request says nothing about the sidecar.
    expect(await fake.voice.prepare('next')).not.toBeNull();
    expect(fake.send).toHaveBeenCalledTimes(2);

    fake.voice.dispose();
    fake.output.dispose();
  });

  it('runs a take on the wall clock once the audio clock stalls, so the line still ends', async () => {
    const fake = webAudioEnvironment();
    let wall = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    const take = await fake.voice.prepare('hello');
    take?.play();
    fake.context.currentTime = 10.1;
    wall += 100;
    expect(take?.elapsed).toBeCloseTo(0.1);

    // The device stops: currentTime never moves again.
    wall += 100;
    expect(take?.elapsed).toBeCloseTo(0.1);
    wall += 2_000;
    expect(take?.elapsed).toBeGreaterThan(take?.seconds ?? Number.POSITIVE_INFINITY);

    fake.voice.dispose();
    fake.output.dispose();
  });

  it('does not rewind when the audio clock resumes after wall-clock fallback', async () => {
    const fake = webAudioEnvironment();
    let wall = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    const take = await fake.voice.prepare('hello');
    take?.play();
    fake.context.currentTime = 10.1;
    wall += 100;
    expect(take?.elapsed).toBeCloseTo(0.1);

    wall += 300;
    const fallback = take?.elapsed ?? 0;
    expect(fallback).toBeGreaterThan(0.3);

    fake.context.currentTime = 10.2;
    wall += 10;
    const resumed = take?.elapsed ?? 0;
    expect(resumed).toBeGreaterThanOrEqual(fallback);
    wall += 100;
    fake.context.currentTime = 10.3;
    expect(take?.elapsed).toBeCloseTo(resumed + 0.1, 3);

    fake.voice.dispose();
    fake.output.dispose();
  });

  it('does not install a chain that resolves after the caller bypasses it', async () => {
    const fake = webAudioEnvironment();
    let resolveBase!: (value: { inputGainDb: number }) => void;
    const pending = new Promise<{ inputGainDb: number }>((resolve) => {
      resolveBase = resolve;
    });
    vi.mocked(loadBase).mockImplementationOnce(() => pending);
    const voice = new BrowserVoice({ output: fake.output });
    voice.setChain({ preset: null });
    resolveBase({ inputGainDb: 3 });
    await pending;
    await Promise.resolve();
    expect(voice.report().dsp).toBeNull();

    voice.dispose();
    fake.voice.dispose();
    fake.output.dispose();
  });

  it('does not install a room impulse that resolves after the caller selects dry', async () => {
    const fake = webAudioEnvironment();
    await fake.voice.captureStream();
    let resolveImpulse!: (value: AudioBuffer) => void;
    const pending = new Promise<AudioBuffer>((resolve) => {
      resolveImpulse = resolve;
    });
    vi.mocked(buildImpulse).mockImplementationOnce(() => pending);

    fake.voice.setRoom('hall');
    fake.voice.setRoom(null);
    resolveImpulse(fake.decoded);
    await pending;
    await Promise.resolve();

    const chainGains = fake.created.filter((node) => node.kind === 'gain').slice(-4);
    const convolver = fake.created.find((node) => node.kind === 'convolver');
    expect(convolver?.buffer).toBeNull();
    expect(chainGains[1].gain?.value).toBe(1);
    expect(chainGains[2].gain?.value).toBe(0);

    fake.voice.dispose();
    fake.output.dispose();
  });
});

describe('voice-chain configuration', () => {
  it('merges scalar and known section overrides without inventing fields', () => {
    const overrides = {
      inputGainDb: 1.2,
      gate: { thresholdDb: -32 },
      unknownSection: { value: 10 },
    } as unknown as VoiceDsp;
    expect(
      mergeDsp(
        {
          inputGainDb: 1,
          gate: { thresholdDb: -40, enabled: true },
        },
        overrides,
      ),
    ).toEqual({
      inputGainDb: 1.2,
      gate: { thresholdDb: -32, enabled: true },
    });
  });
});
