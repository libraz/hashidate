import { describe, expect, it } from 'vitest';
import { BrowserBgm } from '@/viewer/bgm';
import type { BgmDspPlan } from '@/viewer/bgm-dsp';

interface FakeAudio {
  preload: string;
  loop: boolean;
  volume: number;
  src: string;
  currentTime: number;
  duration: number;
  onloadedmetadata: (() => void) | null;
  onerror: (() => void) | null;
  onended: (() => void) | null;
  playCalls: number;
  paused: boolean;
  load(): void;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
}

interface AudioPlayOptions {
  playWait?: Promise<void>;
  playError?: unknown;
}

interface FakeNode {
  connections: unknown[];
  connect(destination: unknown): unknown;
  disconnect(): void;
  addEventListener?(type: string, listener: EventListener): void;
  removeEventListener?(type: string, listener: EventListener): void;
  port?: {
    postMessage(message: unknown): void;
    addEventListener(type: string, listener: EventListener): void;
    removeEventListener(type: string, listener: EventListener): void;
    start(): void;
  };
}

interface FakeParam {
  value: number;
  calls: Array<{ method: string; value: number; at?: number }>;
  cancelScheduledValues(at: number): void;
  setValueAtTime(value: number, at: number): void;
  linearRampToValueAtTime(value: number, at: number): void;
}

interface FakeGainNode extends FakeNode {
  gain: FakeParam;
}

function node(): FakeNode {
  const value: FakeNode = {
    connections: [],
    connect(destination) {
      value.connections.push(destination);
      return destination;
    },
    disconnect() {
      value.connections = [];
    },
  };
  return value;
}

function gainNode(): FakeGainNode {
  const target = node() as FakeGainNode;
  const calls: FakeParam['calls'] = [];
  target.gain = {
    value: 0,
    calls,
    cancelScheduledValues(at) {
      calls.push({ method: 'cancelScheduledValues', value: target.gain.value, at });
    },
    setValueAtTime(value, at) {
      target.gain.value = value;
      calls.push({ method: 'setValueAtTime', value, at });
    },
    linearRampToValueAtTime(value, at) {
      target.gain.value = value;
      calls.push({ method: 'linearRampToValueAtTime', value, at });
    },
  };
  return target;
}

function audio(options: AudioPlayOptions = {}): FakeAudio {
  const value: FakeAudio = {
    preload: '',
    loop: true,
    volume: 0,
    src: '',
    currentTime: 0,
    duration: 90,
    onloadedmetadata: null,
    onerror: null,
    onended: null,
    playCalls: 0,
    paused: true,
    load() {
      value.onloadedmetadata?.();
    },
    async play() {
      value.playCalls += 1;
      if (options.playWait !== undefined) await options.playWait;
      if (options.playError !== undefined) throw options.playError;
      value.paused = false;
    },
    pause() {
      value.paused = true;
    },
    removeAttribute(name) {
      if (name === 'src') value.src = '';
    },
  };
  return value;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface HarnessOptions {
  worklet?: boolean;
  secondPlay?: AudioPlayOptions;
}

function harness({ worklet = true, secondPlay }: HarnessOptions = {}) {
  const bgmBus = gainNode();
  const gains: FakeGainNode[] = [bgmBus];
  const context = {
    state: 'running' as AudioContextState,
    sampleRate: 48_000,
    audioWorklet: {
      addModule: worklet
        ? async () => {}
        : async () => {
            throw new Error('worklet refused');
          },
    },
    currentTime: 10,
    createGain: () => {
      const target = gainNode();
      gains.push(target);
      return target;
    },
    createMediaElementSource: (element: HTMLAudioElement) => {
      const source = node();
      sources.push({ element, source });
      return source;
    },
  };
  const sources: Array<{ element: HTMLAudioElement; source: FakeNode }> = [];
  const nodes: FakeNode[] = [];
  let unlock = (): void => {};
  const output = {
    context,
    bgmBus,
    gains,
    isMuted: false,
    isBlocked: false,
    ensureRunning: async () => context as unknown as AudioContext,
    onUnlock: (listener: () => void) => {
      unlock = listener;
      return () => {};
    },
  };
  const plan: BgmDspPlan = {
    sceneJson: '{}',
    targets: [],
    sceneWarnings: [],
    apply: (target) => {
      messages.push(target);
    },
  };
  const messages: unknown[] = [];
  const makeNode = () => {
    const target = node();
    const listeners = new Set<EventListener>();
    target.port = {
      postMessage: (message) => messages.push(message),
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      start: () => {},
    };
    target.addEventListener = () => {};
    target.removeEventListener = () => {};
    nodes.push(target);
    queueMicrotask(() => {
      const event = { data: { type: 'ready' } } as MessageEvent<unknown>;
      for (const listener of listeners) listener(event);
    });
    return target;
  };
  const audios: FakeAudio[] = [];
  let audioIndex = 0;
  let now = 100;
  const bgm = new BrowserBgm({
    output: output as never,
    audioFactory: () => {
      const element = audio(audioIndex++ === 1 ? secondPlay : undefined);
      audios.push(element);
      return element as unknown as HTMLAudioElement;
    },
    nodeFactory: () => makeNode() as never,
    wasmLoader: async () => new ArrayBuffer(8),
    dspPlan: plan,
    now: () => now,
  });
  return {
    bgm,
    audios,
    bgmBus,
    gains,
    context,
    messages,
    nodes,
    output,
    sources,
    advance(seconds: number) {
      now += seconds;
    },
    unlock() {
      unlock();
    },
  };
}

describe('BrowserBgm', () => {
  it('applies canonical revisions and rejects stale async state', async () => {
    const h = harness();
    expect(
      h.bgm.apply({
        cmd: 'bgm',
        id: 'a',
        revision: 2,
        track: '夜/曲.mp3',
        action: 'play',
        transport: 'playing',
        position: 2,
        at: 98,
        volume: 0.4,
      }),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.bgm.apply({ cmd: 'bgm', id: 'b', revision: 1, track: 'old.mp3' })).toBe(false);
    expect(h.bgm.currentRevision).toBe(2);
    expect(h.bgm.currentTrack).toBe('夜/曲.mp3');
    expect(h.audios[0].src).toBe('/bgm/%E5%A4%9C%2F%E6%9B%B2.mp3');
    expect(h.bgm.report().position).toBe(4);
    expect(h.bgm.report().transport).toBe('playing');
    expect(h.bgmBus.gain.value).toBe(0.4);
    expect(h.audios[0].playCalls).toBe(1);
    h.bgm.dispose();
  });

  it('routes media through per-track envelopes and one shared DSP on a track switch', async () => {
    const h = harness();
    h.bgm.apply({ cmd: 'bgm', id: 'a', revision: 1, track: 'one.mp3', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = h.nodes[0];
    expect(h.sources[0].source.connections).toContain(h.gains[2]);
    expect(h.gains[2].connections).toContain(h.gains[1]);
    expect(h.gains[1].connections).toContain(first);
    expect(first.connections).toContain(h.bgmBus);

    h.bgm.apply({ cmd: 'bgm', id: 'b', revision: 2, track: 'two.flac', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.nodes).toHaveLength(1);
    expect(h.sources[1].source.connections).toContain(h.gains[3]);
    expect(h.gains[3].connections).toContain(h.gains[1]);
    expect(h.gains[1].connections).toContain(first);
    h.bgm.dispose();
  });

  it('keeps playback alive with a dry fallback when worklet setup fails', async () => {
    const h = harness({ worklet: false });
    h.bgm.apply({ cmd: 'bgm', id: 'a', revision: 1, track: 'one.mp3', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.bgm.isDspDegraded).toBe(true);
    expect(h.bgm.report().error).toBeNull();
    expect(h.audios[0].paused).toBe(false);
    expect(h.sources[0].source.connections).toContain(h.gains[2]);
    expect(h.gains[2].connections).toContain(h.gains[1]);
    expect(h.gains[1].connections).toContain(h.bgmBus);
    h.bgm.dispose();
  });

  it('rebinds media events after stop so replayed tracks can end', async () => {
    const h = harness();
    h.bgm.apply({
      cmd: 'bgm',
      id: 'a',
      revision: 1,
      track: 'one.mp3',
      loop: false,
      action: 'play',
      transport: 'playing',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.bgm.apply({
      cmd: 'bgm',
      id: 'b',
      revision: 2,
      track: 'one.mp3',
      loop: false,
      action: 'stop',
      transport: 'stopped',
      position: 0,
    });
    h.bgm.apply({
      cmd: 'bgm',
      id: 'c',
      revision: 3,
      track: 'one.mp3',
      loop: false,
      action: 'play',
      transport: 'playing',
      position: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.audios[0].onended?.();
    expect(h.bgm.report().transport).toBe('ended');
    h.bgm.dispose();
  });

  it('seeks to the canonical clock when autoplay is unlocked later', async () => {
    const h = harness();
    h.bgm.apply({
      cmd: 'bgm',
      revision: 1,
      track: 'one.mp3',
      loop: false,
      action: 'play',
      transport: 'playing',
      position: 0,
      at: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.advance(5);
    h.unlock();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.audios[0].currentTime).toBe(5);
    h.bgm.dispose();
  });

  it('waits for incoming play before scheduling a synchronized crossfade', async () => {
    const gate = deferred();
    const h = harness({ secondPlay: { playWait: gate.promise } });
    h.bgm.apply({
      cmd: 'bgm',
      revision: 1,
      track: 'one.mp3',
      action: 'play',
      fade: { inSeconds: 2, outSeconds: 3 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstEnvelope = h.gains[2];
    expect(firstEnvelope.gain.calls).toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 1,
      at: 12,
    });

    h.bgm.apply({
      cmd: 'bgm',
      revision: 2,
      track: 'two.flac',
      action: 'play',
      fade: { inSeconds: 2, outSeconds: 3 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      firstEnvelope.gain.calls.some(
        (call) => call.method === 'linearRampToValueAtTime' && call.value === 0,
      ),
    ).toBe(false);
    expect(
      h.gains[3].gain.calls.some(
        (call) => call.method === 'linearRampToValueAtTime' && call.value === 1,
      ),
    ).toBe(false);
    expect(h.audios[0].paused).toBe(false);

    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstEnvelope.gain.calls).toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 0,
      at: 13,
    });
    expect(h.gains[3].gain.calls).toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 1,
      at: 12,
    });
    expect(h.nodes).toHaveLength(1);
    h.bgm.dispose();
  });

  it('captures both fade durations when a pending switch is issued', async () => {
    const gate = deferred();
    const h = harness({ secondPlay: { playWait: gate.promise } });
    h.bgm.apply({
      cmd: 'bgm',
      revision: 1,
      track: 'one.mp3',
      action: 'play',
      fade: { inSeconds: 1, outSeconds: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    h.bgm.apply({
      cmd: 'bgm',
      revision: 2,
      track: 'two.flac',
      action: 'play',
      fade: { inSeconds: 2, outSeconds: 3 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.bgm.apply({
      cmd: 'bgm',
      revision: 3,
      fade: { inSeconds: 7, outSeconds: 8 },
    });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.gains[2].gain.calls).toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 0,
      at: 13,
    });
    expect(h.gains[3].gain.calls).toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 1,
      at: 12,
    });

    h.bgm.apply({ cmd: 'bgm', revision: 4, track: 'three.mp3', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.gains[3].gain.calls).toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 0,
      at: 18,
    });
    expect(h.gains[4].gain.calls).toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 1,
      at: 17,
    });
    h.bgm.dispose();
  });

  it('keeps the outgoing route audible when incoming play fails', async () => {
    const gate = deferred();
    const h = harness({
      secondPlay: {
        playWait: gate.promise,
        playError: new Error('decode failed'),
      },
    });
    h.bgm.apply({ cmd: 'bgm', revision: 1, track: 'one.mp3', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.bgm.apply({ cmd: 'bgm', revision: 2, track: 'two.flac', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.audios[0].paused).toBe(false);
    expect(
      h.gains[2].gain.calls.some(
        (call) => call.method === 'linearRampToValueAtTime' && call.value === 0,
      ),
    ).toBe(false);
    expect(h.bgm.report().error).toBe('decode failed');
    h.bgm.dispose();
  });

  it('keeps the outgoing route audible when autoplay blocks incoming play', async () => {
    const gate = deferred();
    const blocked = Object.assign(new Error('gesture required'), {
      name: 'NotAllowedError',
    });
    const h = harness({
      secondPlay: {
        playWait: gate.promise,
        playError: blocked,
      },
    });
    h.bgm.apply({ cmd: 'bgm', revision: 1, track: 'one.mp3', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.bgm.apply({ cmd: 'bgm', revision: 2, track: 'two.flac', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.bgm.isBlocked).toBe(true);
    expect(h.audios[0].paused).toBe(false);
    expect(
      h.gains[2].gain.calls.some(
        (call) => call.method === 'linearRampToValueAtTime' && call.value === 0,
      ),
    ).toBe(false);
    h.bgm.dispose();
  });

  it('keeps zero fades hard and resumes a paused track immediately', async () => {
    const h = harness();
    h.bgm.apply({
      cmd: 'bgm',
      revision: 1,
      track: 'one.mp3',
      action: 'play',
      fade: { inSeconds: 0, outSeconds: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const envelope = h.gains[2];
    expect(envelope.gain.calls.some((call) => call.method === 'linearRampToValueAtTime')).toBe(
      false,
    );

    h.bgm.apply({ cmd: 'bgm', revision: 2, action: 'pause' });
    const beforeResume = envelope.gain.calls.length;
    h.bgm.apply({ cmd: 'bgm', revision: 3, action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      envelope.gain.calls
        .slice(beforeResume)
        .some((call) => call.method === 'linearRampToValueAtTime'),
    ).toBe(false);

    h.bgm.apply({
      cmd: 'bgm',
      revision: 4,
      track: 'two.flac',
      action: 'play',
      fade: { inSeconds: 0, outSeconds: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(envelope.connections).toEqual([]);
    h.bgm.dispose();
  });

  it('pauses both sides of an active crossfade immediately', async () => {
    const h = harness();
    h.bgm.apply({
      cmd: 'bgm',
      revision: 1,
      track: 'one.mp3',
      action: 'play',
      fade: { inSeconds: 2, outSeconds: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.bgm.apply({
      cmd: 'bgm',
      revision: 2,
      track: 'two.flac',
      action: 'play',
      fade: { inSeconds: 2, outSeconds: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.bgm.apply({ cmd: 'bgm', revision: 3, action: 'pause' });
    expect(h.audios[0].paused).toBe(true);
    expect(h.audios[1].paused).toBe(true);
    expect(h.sources[0].source.connections).toEqual([]);
    h.bgm.dispose();
  });

  it('hard-cleans a pending switch on pause before incoming play resolves', async () => {
    const gate = deferred();
    const h = harness({ secondPlay: { playWait: gate.promise } });
    h.bgm.apply({ cmd: 'bgm', revision: 1, track: 'one.mp3', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.bgm.apply({ cmd: 'bgm', revision: 2, track: 'two.flac', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.audios[0].paused).toBe(false);
    h.bgm.apply({ cmd: 'bgm', revision: 3, action: 'pause' });
    expect(h.audios[0].paused).toBe(true);
    expect(h.audios[1].paused).toBe(true);
    expect(h.sources[0].source.connections).toEqual([]);
    expect(h.sources[1].source.connections).toEqual([]);

    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.gains[2].gain.calls).not.toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 0,
      at: 11,
    });
    h.bgm.dispose();
  });

  it('retires rapid switches and all routes on disposal', async () => {
    const h = harness();
    for (const [revision, track] of [
      [1, 'one.mp3'],
      [2, 'two.flac'],
      [3, 'three.mp3'],
    ] as const) {
      h.bgm.apply({ cmd: 'bgm', revision, track, action: 'play' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(h.nodes).toHaveLength(1);
    expect(h.sources[0].source.connections.length).toBeGreaterThan(0);
    expect(h.sources[1].source.connections.length).toBeGreaterThan(0);
    h.bgm.dispose();
    expect(h.sources.every(({ source }) => source.connections.length === 0)).toBe(true);
    expect(h.gains.slice(2).every((gain) => gain.connections.length === 0)).toBe(true);
    expect(h.messages).toContainEqual({ type: 'destroy' });
  });

  it('retires stale delayed switches while carrying the audible route forward', async () => {
    const gate = deferred();
    const h = harness({ secondPlay: { playWait: gate.promise } });
    h.bgm.apply({
      cmd: 'bgm',
      revision: 1,
      track: 'one.mp3',
      action: 'play',
      fade: { inSeconds: 2, outSeconds: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.bgm.apply({ cmd: 'bgm', revision: 2, track: 'two.flac', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.bgm.apply({ cmd: 'bgm', revision: 3, track: 'three.mp3', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.sources[1].source.connections).toEqual([]);
    expect(h.audios[0].paused).toBe(false);
    expect(h.gains[2].gain.calls).toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 0,
      at: 12,
    });
    expect(h.gains[4].gain.calls).toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 1,
      at: 12,
    });

    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.audios[1].paused).toBe(true);
    h.bgm.dispose();
  });

  it('keeps all audible routes alive across an active rapid switch', async () => {
    const h = harness();
    h.bgm.apply({
      cmd: 'bgm',
      revision: 1,
      track: 'one.mp3',
      action: 'play',
      fade: { inSeconds: 2, outSeconds: 4 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.context.currentTime = 11;
    h.bgm.apply({
      cmd: 'bgm',
      revision: 2,
      track: 'two.flac',
      action: 'play',
      fade: { inSeconds: 2, outSeconds: 4 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstEnvelope = h.gains[2];
    const secondEnvelope = h.gains[3];
    const firstCallCount = firstEnvelope.gain.calls.length;
    h.context.currentTime = 12;
    h.bgm.apply({
      cmd: 'bgm',
      revision: 3,
      track: 'three.mp3',
      action: 'play',
      fade: { inSeconds: 3, outSeconds: 5 },
    });
    expect(h.sources[0].source.connections.length).toBeGreaterThan(0);
    expect(firstEnvelope.gain.calls).toHaveLength(firstCallCount);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstEnvelope.gain.calls).toContainEqual({
      method: 'setValueAtTime',
      value: 0.375,
      at: 12,
    });
    expect(firstEnvelope.gain.calls).toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 0,
      at: 17,
    });
    expect(secondEnvelope.gain.calls).toContainEqual({
      method: 'setValueAtTime',
      value: 0.5,
      at: 12,
    });
    expect(secondEnvelope.gain.calls).toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 0,
      at: 17,
    });
    expect(h.gains[4].gain.calls).toContainEqual({
      method: 'linearRampToValueAtTime',
      value: 1,
      at: 15,
    });
    expect(h.sources[0].source.connections.length).toBeGreaterThan(0);
    expect(h.sources[1].source.connections.length).toBeGreaterThan(0);

    h.bgm.dispose();
    expect(h.sources.every(({ source }) => source.connections.length === 0)).toBe(true);
  });
});
