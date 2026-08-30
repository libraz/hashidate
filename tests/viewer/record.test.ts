import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CANDIDATES,
  compose,
  fitStage,
  pickMime,
  place,
  SlideComposite,
  StageRecorder,
} from '@/viewer/record';
import type { Rect } from '@/viewer/scene/placement';
import type { StageFrame } from '@/viewer/scene/runtime';

/**
 * The second compositor.
 *
 * What is on screen is a DOM canvas behind a WebGL canvas behind CSS, and a
 * recording has to be one picture — so the frame is drawn again. The arithmetic
 * of that redraw is what is pinned here, because it is the part that can be
 * wrong without anybody noticing until a take is watched back.
 *
 * The drawing itself is checked against a recorded call list rather than
 * against pixels: happy-dom has no 2D rasteriser, and what would be tested by
 * one is the browser rather than this.
 */

const OUT = { width: 1920, height: 1080 };

/** A canvas as far as `drawImage` cares: something with a non-zero size. */
const canvas = (width = 800, height = 450): HTMLCanvasElement =>
  ({ width, height }) as HTMLCanvasElement;

function frame(over: Partial<StageFrame> = {}): StageFrame {
  return {
    stage: { width: 1280, height: 720 },
    avatar: { canvas: canvas(), rect: { left: 0, top: 0, width: 1280, height: 720 } },
    slides: null,
    background: 'rgb(15, 17, 21)',
    ...over,
  };
}

/** A 2D context that records what it was asked to do, in order. */
function recorder() {
  const calls: string[] = [];
  const round = (n: number): number => Math.round(n * 100) / 100;
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    imageSmoothingQuality: 'high',
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push(`fill ${ctx.fillStyle} ${round(x)},${round(y)} ${round(w)}x${round(h)}`);
    },
    clearRect() {
      /* the held composite starts each rebuild from nothing */
    },
    drawImage(_image: unknown, x: number, y: number, w?: number, h?: number) {
      // Three arguments is the flat copy of a held composite; five is a scale.
      if (w === undefined || h === undefined) calls.push(`copy ${round(x)},${round(y)}`);
      else calls.push(`draw @${ctx.globalAlpha} ${round(x)},${round(y)} ${round(w)}x${round(h)}`);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/** A document layer, with the two canvases `SlideStage` keeps and repaints. */
function slides(
  over: Partial<NonNullable<StageFrame['slides']>> = {},
): NonNullable<StageFrame['slides']> {
  return {
    rect: { left: 0, top: 0, width: 1280, height: 720 },
    canvases: [
      { canvas: canvas(), opacity: 1 },
      { canvas: canvas(), opacity: 0 },
    ],
    revision: 1,
    ...over,
  };
}

/** A canvas for `SlideComposite` to hold, recording what is drawn into it. */
function composite() {
  const held = recorder();
  const create = (): HTMLCanvasElement =>
    ({ width: 0, height: 0, getContext: () => held.ctx }) as unknown as HTMLCanvasElement;
  return { held, create };
}

describe('pickMime', () => {
  it('takes MP4 when the browser will encode it', () => {
    expect(pickMime(() => true)).toBe(CANDIDATES[0]);
  });

  it('falls back to WebM rather than writing a container that is a lie', () => {
    expect(pickMime((type) => type.startsWith('video/webm'))).toBe('video/webm;codecs=vp9,opus');
  });

  it('answers null when the browser will encode nothing', () => {
    expect(pickMime(() => false)).toBeNull();
  });
});

describe('fitStage', () => {
  it('scales a stage of the same shape straight onto the frame', () => {
    expect(fitStage({ width: 1280, height: 720 }, OUT)).toEqual({ scale: 1.5, left: 0, top: 0 });
  });

  it('contains rather than covers, so nothing is cropped off an edge', () => {
    // A cropped head is not recoverable and bars are. See `fitStage`.
    const fit = fitStage({ width: 1000, height: 1000 }, OUT);
    expect(fit.scale).toBeCloseTo(1.08);
    expect(fit.left).toBeCloseTo(420);
    expect(fit.top).toBeCloseTo(0);
  });

  it('centres the bars on the axis that has them', () => {
    const fit = fitStage({ width: 1920, height: 500 }, OUT);
    expect(fit.scale).toBe(1);
    expect(fit.left).toBe(0);
    expect(fit.top).toBe(290);
  });

  it('answers a zero scale for a stage that has not been sized yet', () => {
    // The host is measured by a `ResizeObserver`, so the first frames of a page
    // genuinely have no size. Composing against one would divide by zero.
    expect(fitStage({ width: 0, height: 0 }, OUT).scale).toBe(0);
  });
});

describe('place', () => {
  it('moves and scales a stage rectangle into the output frame', () => {
    const rect: Rect = { left: 100, top: 50, width: 400, height: 300 };
    expect(place(rect, { scale: 2, left: 10, top: 20 })).toEqual({
      left: 210,
      top: 120,
      width: 800,
      height: 600,
    });
  });
});

describe('compose', () => {
  it('draws nothing for a stage that has no size', () => {
    const { ctx, calls } = recorder();
    expect(compose(ctx, frame({ stage: { width: 0, height: 0 } }), OUT)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('lays black under everything, then the page colour, then the character', () => {
    const { ctx, calls } = recorder();
    expect(compose(ctx, frame(), OUT)).toBe(true);
    expect(calls).toEqual([
      'fill #000 0,0 1920x1080',
      'fill rgb(15, 17, 21) 0,0 1920x1080',
      'draw @1 0,0 1920x1080',
    ]);
  });

  it('puts the document layer under the character, at its own rectangle', () => {
    const { ctx, calls } = recorder();
    compose(
      ctx,
      frame({
        slides: {
          rect: { left: 0, top: 0, width: 1280, height: 720 },
          canvases: [
            { canvas: canvas(), opacity: 1 },
            { canvas: canvas(), opacity: 0 },
          ],
          revision: 1,
        },
        avatar: { canvas: canvas(), rect: { left: 900, top: 300, width: 340, height: 400 } },
      }),
      OUT,
    );
    expect(calls).toEqual([
      'fill #000 0,0 1920x1080',
      'fill rgb(15, 17, 21) 0,0 1920x1080',
      // The layer letterboxes against black, as its own element does.
      'fill #000 0,0 1920x1080',
      'draw @1 0,0 1920x1080',
      // The character, over the document, at its placement.
      'draw @1 1350,450 510x600',
    ]);
  });

  it('draws a page turn at the opacity it has actually reached', () => {
    // Read off the computed style rather than the inline value, so a crossfade
    // records as a dissolve rather than as a jump. See `SlideStage.layers`.
    const { ctx, calls } = recorder();
    compose(
      ctx,
      frame({
        slides: {
          rect: { left: 0, top: 0, width: 1280, height: 720 },
          canvases: [
            { canvas: canvas(), opacity: 0.4 },
            { canvas: canvas(), opacity: 0.6 },
          ],
          revision: 1,
        },
      }),
      OUT,
    );
    expect(calls.filter((c) => c.startsWith('draw'))).toEqual([
      'draw @0.4 0,0 1920x1080',
      'draw @0.6 0,0 1920x1080',
      'draw @1 0,0 1920x1080',
    ]);
  });

  it('skips a slide canvas that is fully faded or has never been painted', () => {
    const { ctx, calls } = recorder();
    compose(
      ctx,
      frame({
        slides: {
          rect: { left: 0, top: 0, width: 1280, height: 720 },
          canvases: [
            { canvas: canvas(0, 0), opacity: 1 },
            { canvas: canvas(), opacity: 0 },
          ],
          revision: 1,
        },
      }),
      OUT,
    );
    // Only the character.
    expect(calls.filter((c) => c.startsWith('draw'))).toEqual(['draw @1 0,0 1920x1080']);
  });

  it('composites the document layer once and copies it while nothing moves', () => {
    // The page is a still picture for as long as it is up. What it must not cost
    // is a rescale of the largest rectangle in the frame on every one of them.
    const { held, create } = composite();
    const cache = new SlideComposite(create);
    const first = recorder();
    compose(first.ctx, frame({ slides: slides() }), OUT, cache);
    // Scaled into the held canvas, then copied flat into the frame.
    expect(held.calls).toEqual(['fill #000 0,0 1920x1080', 'draw @1 0,0 1920x1080']);
    expect(first.calls.filter((c) => c.startsWith('copy'))).toEqual(['copy 0,0']);

    const second = recorder();
    compose(second.ctx, frame({ slides: slides() }), OUT, cache);
    // Nothing further was drawn into the held canvas; the frame took the copy.
    expect(held.calls).toHaveLength(2);
    expect(second.calls.filter((c) => c.startsWith('copy'))).toEqual(['copy 0,0']);
  });

  it('recomposites when the page changes, which references cannot tell it', () => {
    // `SlideStage` repaints two fixed canvases in place, so identity says
    // nothing about what is on them. `revision` is the only signal there is.
    const { held, create } = composite();
    const cache = new SlideComposite(create);
    compose(recorder().ctx, frame({ slides: slides({ revision: 1 }) }), OUT, cache);
    expect(held.calls).toHaveLength(2);

    compose(recorder().ctx, frame({ slides: slides({ revision: 2 }) }), OUT, cache);
    expect(held.calls).toHaveLength(4);
  });

  it('recomposites through a page turn, and settles once it lands', () => {
    const { held, create } = composite();
    const cache = new SlideComposite(create);
    const turning = (a: number, b: number) =>
      slides({
        canvases: [
          { canvas: canvas(), opacity: a },
          { canvas: canvas(), opacity: b },
        ],
      });

    compose(recorder().ctx, frame({ slides: turning(1, 0) }), OUT, cache);
    const settled = held.calls.length;
    compose(recorder().ctx, frame({ slides: turning(0.6, 0.4) }), OUT, cache);
    expect(held.calls.length).toBeGreaterThan(settled);

    // Landed: the same opacities twice running cost one composite, not two.
    const midturn = held.calls.length;
    compose(recorder().ctx, frame({ slides: turning(0, 1) }), OUT, cache);
    const after = held.calls.length;
    compose(recorder().ctx, frame({ slides: turning(0, 1) }), OUT, cache);
    expect(held.calls.length).toBe(after);
    expect(after).toBeGreaterThan(midturn);
  });

  it('draws the layer directly when no second canvas can be had', () => {
    // A context that will not allocate is a reason to record unaccelerated,
    // never a reason to drop the document out of the frame.
    const cache = new SlideComposite(() => {
      throw new Error('no canvas');
    });
    const { ctx, calls } = recorder();
    compose(ctx, frame({ slides: slides() }), OUT, cache);
    expect(calls).toEqual([
      'fill #000 0,0 1920x1080',
      'fill rgb(15, 17, 21) 0,0 1920x1080',
      'fill #000 0,0 1920x1080',
      'draw @1 0,0 1920x1080',
      'draw @1 0,0 1920x1080',
    ]);
  });

  it('puts the same pixels in the frame whether or not it is holding them', () => {
    const direct = recorder();
    compose(direct.ctx, frame({ slides: slides() }), OUT);

    const { held, create } = composite();
    const cached = recorder();
    compose(cached.ctx, frame({ slides: slides() }), OUT, new SlideComposite(create));

    // The held canvas received exactly the draws the direct frame made for the
    // document layer, and the frame received them as one copy in their place.
    expect(held.calls).toEqual(direct.calls.slice(2, 4));
    expect(cached.calls).toEqual([
      ...direct.calls.slice(0, 2),
      'copy 0,0',
      ...direct.calls.slice(4),
    ]);
  });

  it('leaves the letterbox black on a transparent source, which has no colour', () => {
    // `rgba(0, 0, 0, 0)` is what a transparent stage computes to, and a 2D
    // context correctly draws it as nothing — so what shows through is the black
    // the frame opened with. A recording has no alpha to carry "nothing" in.
    const { ctx, calls } = recorder();
    compose(ctx, frame({ background: 'rgba(0, 0, 0, 0)' }), OUT);
    expect(calls[0]).toBe('fill #000 0,0 1920x1080');
    expect(calls[1]).toBe('fill rgba(0, 0, 0, 0) 0,0 1920x1080');
  });
});

interface FakeMediaRecorderInstance {
  state: RecordingState;
  stopCalls: number;
  emitData(blob: Blob): void;
  emitStop(): void;
  emitError(): void;
}

/** A deterministic encoder: stop changes state, while tests dispatch onstop. */
class FakeMediaRecorder implements FakeMediaRecorderInstance {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = (_mime: string): boolean => true;

  state: RecordingState = 'inactive';
  stopCalls = 0;
  private onData: ((event: BlobEvent) => void) | null = null;
  private onStopped: (() => void) | null = null;
  private onError: ((event: Event) => void) | null = null;

  constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
    FakeMediaRecorder.instances.push(this);
  }

  set ondataavailable(listener: ((event: BlobEvent) => void) | null) {
    this.onData = listener;
  }

  set onstop(listener: (() => void) | null) {
    this.onStopped = listener;
  }

  set onerror(listener: ((event: Event) => void) | null) {
    this.onError = listener;
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.stopCalls++;
    this.state = 'inactive';
  }

  emitData(blob: Blob): void {
    this.onData?.({ data: blob } as BlobEvent);
  }

  emitStop(): void {
    this.onStopped?.();
  }

  emitError(): void {
    this.onError?.(new Event('error'));
  }
}

function recorderEnvironment() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return { ok: true } as Response;
  });
  const context = {
    imageSmoothingQuality: 'low' as ImageSmoothingQuality,
    fillStyle: '',
    globalAlpha: 1,
    fillRect: () => {},
    clearRect: () => {},
    drawImage: () => {},
  } as unknown as CanvasRenderingContext2D;
  const stream = {
    addTrack: vi.fn(),
  } as unknown as MediaStream;
  const recordingCanvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    captureStream: () => stream,
  } as unknown as HTMLCanvasElement;
  const listeners = new Map<string, EventListenerOrEventListenerObject>();
  const removed: string[] = [];

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('document', {
    createElement: () => recordingCanvas,
  });
  vi.stubGlobal(
    'addEventListener',
    (type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.set(type, listener);
    },
  );
  vi.stubGlobal(
    'removeEventListener',
    (type: string, listener: EventListenerOrEventListenerObject) => {
      if (listeners.get(type) === listener) listeners.delete(type);
      removed.push(type);
    },
  );

  const frameListeners = new Set<(frame: StageFrame) => void>();
  const recorder = new StageRecorder({
    base: '/api',
    rendererId: 'renderer-test',
    fetch: send,
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    openAudio: async () => null,
  });
  return { recorder, calls, listeners, removed, frameListeners, send };
}

afterEach(() => {
  FakeMediaRecorder.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('StageRecorder lifecycle', () => {
  it('waits for onstop, then posts a renderer-bound final marker after data', async () => {
    const env = recorderEnvironment();
    await env.recorder.start({ session: 'take-1', width: 1280, height: 720, fps: 30 });
    const media = FakeMediaRecorder.instances[0];
    media.emitData(new Blob(['part']));

    let finished = false;
    const stopping = env.recorder.stop().then(() => {
      finished = true;
    });
    expect(media.stopCalls).toBe(1);
    await Promise.resolve();
    expect(finished).toBe(false);

    media.emitStop();
    await stopping;
    expect(finished).toBe(true);
    expect(env.calls).toHaveLength(2);
    expect(env.calls[0].url).toContain('session=take-1');
    expect(env.calls[0].url).toContain('renderer=renderer-test');
    expect(env.calls[0].url).not.toContain('final=1');
    expect(env.calls[1].url).toContain('renderer=renderer-test');
    expect(env.calls[1].url).toContain('final=1');
    expect(env.calls[1].init?.keepalive).toBe(true);
  });

  it('flushes the previous session before replacing an active recording', async () => {
    const env = recorderEnvironment();
    await env.recorder.start({ session: 'take-first', width: 640, height: 360, fps: 24 });
    const first = FakeMediaRecorder.instances[0];
    first.emitData(new Blob(['first']));

    const replacing = env.recorder.start({
      session: 'take-second',
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(first.stopCalls).toBe(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    first.emitStop();
    await replacing;
    expect(FakeMediaRecorder.instances).toHaveLength(2);

    const second = FakeMediaRecorder.instances[1];
    second.emitData(new Blob(['second']));
    const stopping = env.recorder.stop();
    second.emitStop();
    await stopping;

    expect(env.calls.map(({ url }) => url)).toEqual([
      expect.stringContaining('session=take-first'),
      expect.stringContaining('session=take-first'),
      expect.stringContaining('session=take-second'),
      expect.stringContaining('session=take-second'),
    ]);
    expect(env.calls[1].url).toContain('final=1');
    expect(env.calls[3].url).toContain('final=1');
  });

  it('closes a take on encoder error and still sends the final marker', async () => {
    const env = recorderEnvironment();
    await env.recorder.start({ session: 'take-error', width: 640, height: 360, fps: 24 });
    const media = FakeMediaRecorder.instances[0];
    media.emitError();
    await env.recorder.stop();

    expect(env.recorder.error).toBe('the encoder stopped');
    expect(media.stopCalls).toBe(1);
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0].url).toContain('session=take-error');
    expect(env.calls[0].url).toContain('final=1');
    expect(env.calls[0].init?.keepalive).toBe(true);
  });

  it('uses pagehide once and removes the listener when disposed', async () => {
    const env = recorderEnvironment();
    await env.recorder.start({ session: 'take-pagehide', width: 640, height: 360, fps: 24 });
    const media = FakeMediaRecorder.instances[0];
    const pagehide = env.listeners.get('pagehide');
    expect(pagehide).toBeDefined();

    (pagehide as () => void)();
    expect(media.stopCalls).toBe(1);
    expect(env.removed).toEqual(['pagehide']);
    expect(env.listeners.has('pagehide')).toBe(false);
    media.emitStop();
    await env.recorder.stop();

    expect(env.calls).toHaveLength(1);
    expect(env.calls[0].url).toContain('final=1');
    expect(env.calls[0].init?.keepalive).toBe(true);
  });
});
