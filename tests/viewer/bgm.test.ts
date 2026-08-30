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

function audio(): FakeAudio {
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

function harness({ worklet = true }: { worklet?: boolean } = {}) {
  const bgmBus = node() as FakeNode & { gain: { value: number } };
  bgmBus.gain = { value: 0 };
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
  let now = 100;
  const bgm = new BrowserBgm({
    output: output as never,
    audioFactory: () => {
      const element = audio();
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

  it('routes media through the BGM bus and destroys the old DSP on a track switch', async () => {
    const h = harness();
    h.bgm.apply({ cmd: 'bgm', id: 'a', revision: 1, track: 'one.mp3', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = h.nodes[0];
    expect(h.sources[0].source.connections).toContain(first);
    expect(first.connections).toContain(h.bgmBus);

    h.bgm.apply({ cmd: 'bgm', id: 'b', revision: 2, track: 'two.flac', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.messages).toContainEqual({ type: 'destroy' });
    expect(h.sources[1].source.connections).toContain(h.nodes[1]);
    expect(h.nodes[1].connections).toContain(h.bgmBus);
    h.bgm.dispose();
  });

  it('keeps playback alive with a dry fallback when worklet setup fails', async () => {
    const h = harness({ worklet: false });
    h.bgm.apply({ cmd: 'bgm', id: 'a', revision: 1, track: 'one.mp3', action: 'play' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.bgm.isDspDegraded).toBe(true);
    expect(h.bgm.report().error).toBeNull();
    expect(h.audios[0].paused).toBe(false);
    expect(h.sources[0].source.connections).toContain(h.bgmBus);
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
});
