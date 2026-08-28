import { describe, expect, it } from 'vitest';
import { CANDIDATES, compose, fitStage, pickMime, place } from '@/viewer/record';
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
    drawImage(_image: unknown, x: number, y: number, w: number, h: number) {
      calls.push(`draw @${ctx.globalAlpha} ${round(x)},${round(y)} ${round(w)}x${round(h)}`);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
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
        },
      }),
      OUT,
    );
    // Only the character.
    expect(calls.filter((c) => c.startsWith('draw'))).toEqual(['draw @1 0,0 1920x1080']);
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
