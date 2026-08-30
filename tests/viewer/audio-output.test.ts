import { describe, expect, it } from 'vitest';
import { BrowserAudioOutput } from '@/viewer/audio-output';

interface FakeNode {
  kind: string;
  gain?: { value: number };
  connections: unknown[];
  connect(destination: unknown): unknown;
  disconnect(): void;
}

function node(kind: string): FakeNode {
  const value: FakeNode = {
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
  return value;
}

function context() {
  const destination = node('destination');
  const created: FakeNode[] = [];
  const stream = { id: 'post-master' } as unknown as MediaStream;
  const ctx = {
    state: 'running' as AudioContextState,
    sampleRate: 48_000,
    destination,
    createGain: () => {
      const item = node('gain');
      created.push(item);
      return item;
    },
    createMediaStreamDestination: () => {
      const item = node('capture') as FakeNode & { stream: MediaStream };
      item.stream = stream;
      created.push(item);
      return item;
    },
    resume: async () => {},
    close: async () => {},
  };
  return { ctx: ctx as unknown as AudioContext, destination, created, stream };
}

describe('BrowserAudioOutput', () => {
  it('uses one master for speaker and post-master capture, including mute', async () => {
    const fake = context();
    const output = new BrowserAudioOutput({ context: fake.ctx, muted: true });

    expect(output.context).toBe(fake.ctx);
    expect(output.isMuted).toBe(true);
    expect(output.master.gain.value).toBe(0);
    expect((output.voiceBus as unknown as FakeNode).connections).toContain(output.master);
    expect((output.bgmBus as unknown as FakeNode).connections).toContain(output.master);
    expect((output.master as unknown as FakeNode).connections).toContain(fake.destination);
    expect((output.master as unknown as FakeNode).connections).toContain(output.captureDestination);
    expect(await output.captureStream()).toBe(fake.stream);

    output.dispose();
  });

  it('keeps voice and BGM on separate buses while sharing the context', () => {
    const fake = context();
    const output = new BrowserAudioOutput({ context: fake.ctx, muted: false });

    expect(output.voiceBus).not.toBe(output.bgmBus);
    output.dispose();
  });
});
