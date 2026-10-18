// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_RESUME_WAIT_MS, BrowserAudioOutput, startContext } from '@/viewer/audio-output';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface FakeNode {
  gain?: { value: number };
  connect(destination: unknown): unknown;
  disconnect(): void;
}

function node(withGain = false): FakeNode {
  const value: FakeNode = {
    connect: (destination) => destination,
    disconnect: () => {},
  };
  if (withGain) value.gain = { value: 0 };
  return value;
}

function fakeAudioContext(state: AudioContextState = 'suspended') {
  const resume = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve());
  const stream = { id: 'capture' } as unknown as MediaStream;
  const raw = {
    state,
    sampleRate: 48_000,
    destination: node(),
    resume,
    close,
    createGain: () => node(true),
    createMediaStreamDestination: () => ({ ...node(), stream }),
  };
  return { context: raw as unknown as AudioContext, raw, resume, close, stream };
}

const outputs: BrowserAudioOutput[] = [];

afterEach(() => {
  for (const output of outputs.splice(0)) output.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function outputFor(
  context: ReturnType<typeof fakeAudioContext>,
  resumeWaitMs = 40,
): BrowserAudioOutput {
  const output = new BrowserAudioOutput({
    context: context.context,
    muted: false,
    resumeWaitMs,
  });
  outputs.push(output);
  return output;
}

describe('startContext timer lifecycle', () => {
  it('clears its timeout when resume succeeds first', async () => {
    vi.useFakeTimers();
    const fake = fakeAudioContext();
    const resumed = deferred<void>();
    fake.resume.mockReturnValueOnce(resumed.promise);

    const attempt = startContext(fake.context, 80);
    expect(vi.getTimerCount()).toBe(1);
    fake.raw.state = 'running';
    resumed.resolve(undefined);

    await expect(attempt).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timeout when resume rejects first', async () => {
    vi.useFakeTimers();
    const fake = fakeAudioContext();
    fake.resume.mockRejectedValueOnce(new Error('refused'));

    await expect(startContext(fake.context, 80)).resolves.toBe(false);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps waiting until the configured timeout when resume stays pending', async () => {
    vi.useFakeTimers();
    const fake = fakeAudioContext();
    fake.resume.mockReturnValueOnce(new Promise<void>(() => {}));
    let settled = false;
    const attempt = startContext(fake.context).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(AUDIO_RESUME_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(attempt).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resume or schedule timeouts for running and closed contexts', async () => {
    vi.useFakeTimers();
    const running = fakeAudioContext('running');
    const closed = fakeAudioContext('closed');

    await expect(startContext(running.context)).resolves.toBe(true);
    await expect(startContext(closed.context)).resolves.toBe(false);

    expect(running.resume).not.toHaveBeenCalled();
    expect(closed.resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('BrowserAudioOutput teardown during resume', () => {
  it('returns null and remains blocked when a deferred start succeeds after disposal', async () => {
    vi.useFakeTimers();
    const fake = fakeAudioContext();
    const secondResume = deferred<void>();
    fake.resume
      .mockReturnValueOnce(new Promise<void>(() => {}))
      .mockReturnValueOnce(secondResume.promise);
    const output = outputFor(fake);
    const unlocked = vi.fn();
    output.onUnlock(unlocked);

    const refused = output.ensureRunning();
    await vi.advanceTimersByTimeAsync(40);
    await expect(refused).resolves.toBeNull();
    expect(output.isBlocked).toBe(true);

    const late = output.ensureRunning();
    output.dispose();
    fake.raw.state = 'running';
    secondResume.resolve(undefined);

    await expect(late).resolves.toBeNull();
    expect(output.isBlocked).toBe(true);
    expect(unlocked).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['rejection', 'timeout'] as const)(
    'does not mark an output blocked when a late %s follows disposal',
    async (outcome) => {
      vi.useFakeTimers();
      const fake = fakeAudioContext();
      const lateResume = deferred<void>();
      fake.resume.mockReturnValueOnce(lateResume.promise);
      const output = outputFor(fake);

      const pending = output.ensureRunning();
      output.dispose();
      if (outcome === 'rejection') {
        lateResume.reject(new Error('refused'));
      } else {
        await vi.advanceTimersByTimeAsync(40);
      }

      await expect(pending).resolves.toBeNull();
      expect(output.isBlocked).toBe(false);
      expect(fake.close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not notify or unlock after a pending gesture resume finishes on disposal', async () => {
    vi.useFakeTimers();
    const fake = fakeAudioContext();
    const gestureResume = deferred<void>();
    fake.resume
      .mockReturnValueOnce(new Promise<void>(() => {}))
      .mockReturnValueOnce(gestureResume.promise);
    const output = outputFor(fake);
    const unlocked = vi.fn();
    output.onUnlock(unlocked);

    const refused = output.ensureRunning();
    await vi.advanceTimersByTimeAsync(40);
    await expect(refused).resolves.toBeNull();
    expect(output.isBlocked).toBe(true);

    window.dispatchEvent(new Event('pointerdown'));
    expect(fake.resume).toHaveBeenCalledTimes(2);
    output.dispose();
    fake.raw.state = 'running';
    gestureResume.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(output.isBlocked).toBe(true);
    expect(unlocked).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
  });

  it('still notifies a live blocked output when its context recovers', async () => {
    vi.useFakeTimers();
    const fake = fakeAudioContext();
    fake.resume.mockReturnValueOnce(new Promise<void>(() => {}));
    const output = outputFor(fake);
    const unlocked = vi.fn();
    output.onUnlock(unlocked);

    const refused = output.ensureRunning();
    await vi.advanceTimersByTimeAsync(40);
    await expect(refused).resolves.toBeNull();
    expect(output.isBlocked).toBe(true);

    fake.resume.mockImplementationOnce(() => {
      fake.raw.state = 'running';
      return Promise.resolve();
    });
    await expect(output.ensureRunning()).resolves.toBe(fake.context);

    expect(output.isBlocked).toBe(false);
    expect(unlocked).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes its owned context exactly once', () => {
    const fake = fakeAudioContext('running');
    const output = new BrowserAudioOutput({
      contextFactory: () => fake.context,
      muted: false,
    });
    outputs.push(output);

    output.dispose();
    output.dispose();

    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
