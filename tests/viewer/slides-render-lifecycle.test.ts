// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlideStage } from '@/viewer/scene/slides';
import type { DeckSource } from '@/viewer/scene/slides/deck';

interface TrackedBitmap {
  image: ImageBitmap;
  close: ReturnType<typeof vi.fn>;
}

interface RenderRequest {
  page: number;
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: unknown) => void;
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
    render(page) {
      // Return this promise directly so tests can place its reactions precisely.
      return new Promise<ImageBitmap>((resolve, reject) => {
        requests.push({ page, resolve, reject });
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

/** Let the open, rasterise and settle promise continuations drain. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const stages: Array<{ stage: SlideStage; host: HTMLDivElement }> = [];
let drawImage: ReturnType<typeof vi.fn>;
let contextSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('requestIdleCallback', undefined);
  vi.stubGlobal('cancelIdleCallback', undefined);
  drawImage = vi.fn();
  const context = {
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage,
  } as unknown as CanvasRenderingContext2D;
  contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
});

afterEach(() => {
  for (const { stage, host } of stages.splice(0)) {
    stage.dispose();
    host.remove();
  }
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

async function showFirstPage(stage: SlideStage, deck: ReturnType<typeof controlledDeck>) {
  stage.setDeck('deck');
  await flushMicrotasks();
  const first = trackedBitmap();
  requestFor(deck, 1).resolve(first.image);
  await flushMicrotasks();
  expect(stage.report()).toMatchObject({ page: 1, pages: deck.source.pages, ready: true });
  return first;
}

describe('slide render lifecycle', () => {
  it('clears a current page error only after a successful retry paints', async () => {
    const deck = controlledDeck(6);
    const stage = build(deck.source);
    await showFirstPage(stage, deck);

    stage.setSlide(2);
    requestFor(deck, 2).reject(new Error('first attempt failed'));
    await flushMicrotasks();
    const firstError = stage.report().error;
    expect(firstError).toContain('2');
    expect(stage.report()).toMatchObject({ page: 1, ready: false });

    stage.setSlide(2);
    const recovered = trackedBitmap();
    requestFor(deck, 2, 1).resolve(recovered.image);
    await flushMicrotasks();

    expect(stage.report()).toMatchObject({ page: 2, ready: true, error: null });
  });

  it('does not report an obsolete page rejection after a newer page is shown', async () => {
    const deck = controlledDeck(6);
    const stage = build(deck.source);
    await showFirstPage(stage, deck);

    stage.setSlide(2);
    const obsolete = requestFor(deck, 2);
    stage.setSlide(3);
    const current = trackedBitmap();
    requestFor(deck, 3).resolve(current.image);
    await flushMicrotasks();
    expect(stage.report()).toMatchObject({ page: 3, ready: true, error: null });

    obsolete.reject(new Error('obsolete page failed'));
    await flushMicrotasks();

    expect(stage.report()).toMatchObject({ page: 3, ready: true, error: null });
  });

  it('clears a current page error when returning to the cached shown page', async () => {
    const deck = controlledDeck(6);
    const stage = build(deck.source);
    const first = await showFirstPage(stage, deck);

    stage.setSlide(2);
    requestFor(deck, 2).reject(new Error('page 2 failed'));
    await flushMicrotasks();
    expect(stage.report().error).toContain('2');

    stage.setSlide(1);
    await flushMicrotasks();

    expect(stage.report()).toMatchObject({ page: 1, ready: true, error: null });
    expect(deck.requests.filter((request) => request.page === 1)).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();
  });

  it('does not report a failed prefetch for the healthy shown page', async () => {
    vi.useFakeTimers();
    const deck = controlledDeck(6);
    const stage = build(deck.source);
    await showFirstPage(stage, deck);

    await vi.advanceTimersByTimeAsync(300);
    requestFor(deck, 2).reject(new Error('prefetch failed'));
    await flushMicrotasks();

    expect(stage.report()).toMatchObject({ page: 1, ready: true, error: null });
  });

  it.each(['success', 'failure'] as const)(
    'keeps the foreground error when an obsolete background render ends in %s',
    async (outcome) => {
      const deck = controlledDeck(6);
      const stage = build(deck.source);
      await showFirstPage(stage, deck);

      stage.setSlide(3);
      const background = requestFor(deck, 3);
      stage.setSlide(2);
      requestFor(deck, 2).reject(new Error('foreground page 2 failed'));
      await flushMicrotasks();
      const foregroundError = stage.report().error;
      expect(foregroundError).toContain('2');

      if (outcome === 'success') {
        background.resolve(trackedBitmap().image);
      } else {
        background.reject(new Error('background page 3 failed'));
      }
      await flushMicrotasks();

      expect(stage.report().error).toBe(foregroundError);
      expect(stage.report()).toMatchObject({ page: 1, ready: false });
    },
  );

  it('closes a late far-page bitmap without repainting the current page', async () => {
    const deck = controlledDeck(8);
    const stage = build(deck.source);
    await showFirstPage(stage, deck);

    stage.setSlide(4);
    const far = requestFor(deck, 4);
    stage.setSlide(2);
    requestFor(deck, 2).resolve(trackedBitmap().image);
    await flushMicrotasks();
    const revision = stage.layers()?.revision;

    const late = trackedBitmap();
    far.resolve(late.image);
    await flushMicrotasks();

    expect(late.close).toHaveBeenCalledTimes(1);
    expect(stage.layers()?.revision).toBe(revision);
    expect(stage.report()).toMatchObject({ page: 2, ready: true });
    expect(drawImage.mock.calls.some(([image]) => image === late.image)).toBe(false);
  });

  it('reuses a rendered neighbor when the operator turns to it', async () => {
    vi.useFakeTimers();
    const deck = controlledDeck(6);
    const stage = build(deck.source);
    await showFirstPage(stage, deck);

    await vi.advanceTimersByTimeAsync(300);
    const neighbor = trackedBitmap();
    requestFor(deck, 2).resolve(neighbor.image);
    await flushMicrotasks();

    stage.setSlide(2);
    await flushMicrotasks();

    expect(deck.requests.map((request) => request.page)).toEqual([1, 2]);
    expect(stage.report()).toMatchObject({ page: 2, ready: true });
    expect(neighbor.close).not.toHaveBeenCalled();
  });

  it('keeps the wanted far page through the trim before its first paint', async () => {
    const deck = controlledDeck(8);
    const stage = build(deck.source);
    await showFirstPage(stage, deck);

    stage.setSlide(4);
    const far = trackedBitmap();
    requestFor(deck, 4).resolve(far.image);
    await flushMicrotasks();

    expect(stage.report()).toMatchObject({ page: 4, ready: true });
    expect(far.close).not.toHaveBeenCalled();
    expect(drawImage.mock.calls.some(([image]) => image === far.image)).toBe(true);
  });

  it('does not paint a closed bitmap when the same wanted page is requested again', async () => {
    const deck = controlledDeck(8);
    const stage = build(deck.source);
    await showFirstPage(stage, deck);
    const initialRevision = stage.layers()?.revision;

    stage.setSlide(4);
    stage.setSlide(7);
    stage.setSlide(4);
    const firstFour = trackedBitmap();
    const seven = trackedBitmap();
    requestFor(deck, 4).resolve(firstFour.image);
    queueMicrotask(() => stage.setSlide(7));
    requestFor(deck, 7).resolve(seven.image);
    queueMicrotask(() => stage.setSlide(4));
    await flushMicrotasks();

    expect(firstFour.close).toHaveBeenCalledTimes(1);
    expect(deck.requests.filter((request) => request.page === 4)).toHaveLength(2);
    expect(stage.report()).toMatchObject({ page: 1, ready: false });
    expect(stage.layers()?.revision).toBe(initialRevision);
    expect(drawImage.mock.calls.some(([image]) => image === firstFour.image)).toBe(false);

    const secondFour = trackedBitmap();
    requestFor(deck, 4, 1).resolve(secondFour.image);
    await flushMicrotasks();

    expect(stage.report()).toMatchObject({ page: 4, ready: true });
    expect(drawImage.mock.calls.some(([image]) => image === firstFour.image)).toBe(false);
    expect(drawImage.mock.calls.some(([image]) => image === secondFour.image)).toBe(true);
  });
});
