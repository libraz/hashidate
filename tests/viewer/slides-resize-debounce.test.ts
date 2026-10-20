// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlideStage } from '@/viewer/scene/slides';
import type { DeckSource } from '@/viewer/scene/slides/deck';

interface RenderRequest {
  page: number;
  pixelWidth: number;
  resolve: (bitmap: ImageBitmap) => void;
}

interface TrackedBitmap {
  image: ImageBitmap;
  close: ReturnType<typeof vi.fn>;
}

function trackedBitmap(): TrackedBitmap {
  const close = vi.fn();
  return {
    image: { width: 1600, height: 900, close } as unknown as ImageBitmap,
    close,
  };
}

function controlledDeck(pages: number) {
  const requests: RenderRequest[] = [];
  const source: DeckSource = {
    pages,
    render(page, pixelWidth) {
      return new Promise<ImageBitmap>((resolve) => {
        requests.push({ page, pixelWidth, resolve });
      });
    },
    dispose: vi.fn(),
  };
  return { source, requests };
}

function requestFor(
  deck: ReturnType<typeof controlledDeck>,
  page: number,
  occurrence = 0,
): RenderRequest {
  const requests = deck.requests.filter((request) => request.page === page);
  const request = requests[occurrence];
  if (!request) throw new Error(`No render request ${occurrence} for page ${page}`);
  return request;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const stages: Array<{ stage: SlideStage; host: HTMLDivElement }> = [];
let contextSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestIdleCallback', undefined);
  vi.stubGlobal('cancelIdleCallback', undefined);
  const context = {
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
});

afterEach(() => {
  for (const { stage, host } of stages.splice(0)) {
    stage.dispose();
    host.remove();
  }
  vi.clearAllTimers();
  contextSpy.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function build(source: DeckSource): SlideStage {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const stage = new SlideStage(host, { open: () => Promise.resolve(source) });
  stage.resize({ width: 1920, height: 1080 });
  stages.push({ stage, host });
  return stage;
}

async function showFirstPage(
  stage: SlideStage,
  deck: ReturnType<typeof controlledDeck>,
): Promise<TrackedBitmap> {
  stage.setDeck('deck');
  await flushMicrotasks();
  const first = trackedBitmap();
  requestFor(deck, 1).resolve(first.image);
  await flushMicrotasks();
  expect(stage.report()).toMatchObject({ page: 1, ready: true });
  return first;
}

describe('slide resize debounce', () => {
  it('cancels a pending resize when the dimensions return to the drawn size', async () => {
    const deck = controlledDeck(1);
    const stage = build(deck.source);
    const first = await showFirstPage(stage, deck);
    const revision = stage.layers()?.revision;

    stage.resize({ width: 1280, height: 720 });
    stage.resize({ width: 1920, height: 1080 });
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();

    expect(deck.requests).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();
    expect(stage.layers()?.revision).toBe(revision);
  });

  it('keeps resize invalidation after a page turn during the debounce', async () => {
    const deck = controlledDeck(2);
    const stage = build(deck.source);
    const first = await showFirstPage(stage, deck);

    stage.resize({ width: 1280, height: 720 });
    stage.setSlide(2);
    const second = trackedBitmap();
    requestFor(deck, 2).resolve(second.image);
    await flushMicrotasks();
    const revision = stage.layers()?.revision;
    stage.resize({ width: 1280, height: 720 });
    stage.resize({ width: 1024, height: 576 });
    stage.resize({ width: 1280, height: 720 });

    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();

    expect(deck.requests.map(({ page }) => page)).toEqual([1, 2, 2]);
    expect(requestFor(deck, 2, 0).pixelWidth).toBe(1280);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(stage.layers()?.revision).toBe(revision);
    expect(stage.report()).toMatchObject({ page: 2, ready: true });

    const resized = trackedBitmap();
    requestFor(deck, 2, 1).resolve(resized.image);
    await flushMicrotasks();

    expect(second.close).toHaveBeenCalledTimes(1);
    expect(stage.layers()?.revision).toBe((revision ?? 0) + 1);
    expect(stage.report()).toMatchObject({ page: 2, ready: true });
  });

  it.each(['settled', 'pending'] as const)(
    'keeps resize invalidation when a %s prefetch starts during the debounce',
    async (prefetchState) => {
      const deck = controlledDeck(2);
      const stage = build(deck.source);
      const first = await showFirstPage(stage, deck);
      const revision = stage.layers()?.revision;

      await vi.advanceTimersByTimeAsync(200);
      stage.resize({ width: 1280, height: 720 });
      await vi.advanceTimersByTimeAsync(100);
      const prefetch = requestFor(deck, 2);
      const prefetched = trackedBitmap();
      if (prefetchState === 'settled') {
        prefetch.resolve(prefetched.image);
        await flushMicrotasks();
      }
      await vi.advanceTimersByTimeAsync(20);
      expect(stage.layers()?.revision).toBe(revision);

      stage.resize({ width: 1920, height: 1080 });
      await vi.advanceTimersByTimeAsync(130);
      await flushMicrotasks();

      expect(deck.requests.map(({ page }) => page)).toEqual([1, 2, 1]);
      expect(requestFor(deck, 1, 1).pixelWidth).toBe(1920);
      expect(first.close).toHaveBeenCalledTimes(1);
      if (prefetchState === 'settled') {
        expect(prefetched.close).toHaveBeenCalledTimes(1);
      } else {
        expect(prefetched.close).not.toHaveBeenCalled();
        prefetch.resolve(prefetched.image);
        await flushMicrotasks();
        expect(prefetched.close).toHaveBeenCalledTimes(1);
      }

      const resized = trackedBitmap();
      requestFor(deck, 1, 1).resolve(resized.image);
      await flushMicrotasks();

      expect(stage.layers()?.revision).toBe((revision ?? 0) + 1);
      expect(stage.report()).toMatchObject({ page: 1, ready: true });
    },
  );

  it('rerenders after the debounce when the dimensions remain changed', async () => {
    const deck = controlledDeck(1);
    const stage = build(deck.source);
    const first = await showFirstPage(stage, deck);
    const revision = stage.layers()?.revision;

    stage.resize({ width: 1280, height: 720 });
    await vi.advanceTimersByTimeAsync(249);
    await flushMicrotasks();
    expect(deck.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(deck.requests).toHaveLength(2);
    expect(requestFor(deck, 1, 1).pixelWidth).toBe(1280);
    expect(first.close).toHaveBeenCalledTimes(1);

    const resized = trackedBitmap();
    requestFor(deck, 1, 1).resolve(resized.image);
    await flushMicrotasks();

    expect(stage.layers()?.revision).toBe((revision ?? 0) + 1);
    expect(stage.report()).toMatchObject({ page: 1, ready: true });
  });
});
