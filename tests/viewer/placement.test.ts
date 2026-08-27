import { describe, expect, it } from 'vitest';
import type { Placement } from '@/engine/types';
import {
  FULL_FRAME,
  FULL_SLIDE,
  fitInside,
  hugContent,
  isAnchor,
  rectOf,
  resolvePlacement,
} from '@/viewer/scene/placement';

/**
 * Where each layer of the frame lands.
 *
 * The arithmetic behind a composed picture, and the only part of it that can be
 * checked without rendering the page — which is why as much of the decision as
 * possible was put here rather than in the class that owns the canvas. A layer
 * off the edge of the frame or a margin that eats itself looks, from anywhere
 * downstream, exactly like a renderer that has stopped.
 */

/** Wide and short, so a margin taken off the height is visibly not the width. */
const STAGE = { width: 1000, height: 500 };

const ANCHORS = [
  'center',
  'top-left',
  'top',
  'top-right',
  'left',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const;

/** A fifth of the frame each way: 200 x 100 on the stage above. */
const fifth = (p: Partial<Placement> = {}): Required<Placement> => ({
  ...FULL_FRAME,
  width: 0.2,
  height: 0.2,
  ...p,
});

describe('rectOf', () => {
  it('puts a layer where each of the nine anchors says', () => {
    const at = (anchor: Placement['anchor']) => {
      const { left, top } = rectOf(fifth({ anchor }), STAGE);
      return [left, top];
    };
    expect(at('center')).toEqual([400, 200]);
    expect(at('top-left')).toEqual([0, 0]);
    expect(at('top')).toEqual([400, 0]);
    expect(at('top-right')).toEqual([800, 0]);
    expect(at('left')).toEqual([0, 200]);
    expect(at('right')).toEqual([800, 200]);
    expect(at('bottom-left')).toEqual([0, 400]);
    expect(at('bottom')).toEqual([400, 400]);
    expect(at('bottom-right')).toEqual([800, 400]);
  });

  it('sizes it as two independent fractions of the stage', () => {
    expect(rectOf({ ...FULL_FRAME, width: 0.32, height: 0.6 }, STAGE)).toMatchObject({
      width: 320,
      height: 300,
    });
  });

  it('measures the margin off the height on both axes', () => {
    // Per axis, the same number would open a 100 px gap at the side and a 50 px
    // gap at the bottom of this stage, and be read as one inset by everyone who
    // looked at it.
    const { left, top } = rectOf(fifth({ anchor: 'bottom-right', margin: 0.1 }), STAGE);
    expect([left, top]).toEqual([750, 350]);
  });

  it('spends the margin only on the edges the anchor pulls to', () => {
    // A centred layer touches no edge, so there is nothing for a gap to be a
    // gap from.
    const plain = rectOf(fifth({ anchor: 'center' }), STAGE);
    expect(rectOf(fifth({ anchor: 'center', margin: 0.2 }), STAGE)).toEqual(plain);
    // Pulled to the top, only the top moves.
    expect(rectOf(fifth({ anchor: 'top', margin: 0.1 }), STAGE)).toMatchObject({
      left: 400,
      top: 50,
    });
  });

  it('keeps the layer inside the stage when the margin will not fit', () => {
    // The full frame has no room for a gap. Spent as far as it goes rather than
    // pushed off the edge: from anywhere downstream, a layer that has left the
    // picture looks exactly like a renderer that has died.
    const rect = rectOf({ ...FULL_FRAME, margin: 0.2 }, STAGE);
    expect(rect).toEqual({ left: 0, top: 0, width: 1000, height: 500 });
  });

  it('clamps a fraction the wire would have refused', () => {
    // Below a tenth of the frame the character is a smudge, and a value that
    // large is more likely a typo in a query string than an instruction.
    expect(rectOf({ ...FULL_FRAME, width: 0, height: 0 }, STAGE)).toMatchObject({
      width: 100,
      height: 50,
    });
    expect(rectOf({ ...FULL_FRAME, width: 4, height: 4 }, STAGE)).toMatchObject({
      width: 1000,
      height: 500,
    });
  });

  it('is the whole stage for the full frame, which is what nothing set means', () => {
    expect(rectOf(FULL_FRAME, STAGE)).toEqual({ left: 0, top: 0, width: 1000, height: 500 });
  });
});

describe('resolvePlacement', () => {
  it('leaves a field the patch does not mention alone', () => {
    const base = fifth({ anchor: 'bottom-right', margin: 0.05 });
    expect(resolvePlacement(base, { width: 0.5 })).toEqual({
      anchor: 'bottom-right',
      width: 0.5,
      height: 0.2,
      margin: 0.05,
    });
  });

  it('leaves one that is present and undefined alone as well', () => {
    // Which is the shape an object built from optional wire fields has, and the
    // failure it would otherwise cause is a slider snapping the layer back to
    // the full frame the moment a different one is touched.
    const base = fifth({ anchor: 'top-left' });
    expect(resolvePlacement(base, { anchor: undefined, width: 0.4 })).toMatchObject({
      anchor: 'top-left',
      width: 0.4,
    });
  });

  it('keeps the base it landed on unchanged', () => {
    const base = fifth();
    resolvePlacement(base, { width: 0.9 });
    expect(base.width).toBe(0.2);
  });

  it('carries the fit a document has and a character does not', () => {
    expect(resolvePlacement(FULL_SLIDE, { fit: 'cover' }).fit).toBe('cover');
    expect(resolvePlacement(FULL_SLIDE, { width: 0.5 }).fit).toBe('contain');
  });
});

describe('fitInside', () => {
  /** The stage above is 2:1, so that is the shape a picture of it has. */
  const SHAPE = STAGE.width / STAGE.height;

  it('is the area itself when the area is already the frame’s shape', () => {
    // The whole frame, which is what nothing set means: the canvas is the stage
    // and the output is what it was before any of this existed.
    const area = rectOf(FULL_FRAME, STAGE);
    expect(fitInside(area, SHAPE, 'center')).toEqual(area);
  });

  it('keeps the frame’s shape inside a taller area, rather than filling it', () => {
    // The reason this function exists. Filling the area would keep the
    // framing's vertical and cut the arms off both sides; standing the camera
    // back to fit them would turn an upper-body shot into a full-body one.
    // Neither happens: the picture is the frame's, scaled.
    const area = rectOf({ ...FULL_FRAME, width: 0.4, height: 1 }, STAGE);
    const rect = fitInside(area, SHAPE, 'center');
    expect(rect.width / rect.height).toBeCloseTo(SHAPE, 6);
    expect(rect.width).toBe(area.width);
    expect(rect.height).toBeLessThan(area.height);
  });

  it('keeps it inside a wider area too', () => {
    const area = rectOf({ ...FULL_FRAME, width: 1, height: 0.4 }, STAGE);
    const rect = fitInside(area, SHAPE, 'center');
    expect(rect.height).toBe(area.height);
    expect(rect.width).toBeLessThan(area.width);
  });

  it('pulls the picture to the corner the area was pulled to', () => {
    // 右下 has to mean the bottom right of the frame, not the middle of a box
    // that happens to be over there.
    const area = rectOf({ ...FULL_FRAME, anchor: 'bottom-right', width: 0.4, height: 1 }, STAGE);
    const rect = fitInside(area, SHAPE, 'bottom-right');
    expect(rect.left + rect.width).toBe(area.left + area.width);
    expect(rect.top + rect.height).toBe(area.top + area.height);
  });

  it('centres it on an axis the anchor does not pull', () => {
    const area = rectOf({ ...FULL_FRAME, anchor: 'bottom', width: 0.4, height: 1 }, STAGE);
    const rect = fitInside(area, SHAPE, 'bottom');
    expect(rect.left - area.left).toBe(area.left + area.width - (rect.left + rect.width));
  });

  it('hands back the area for a shape nothing has been laid out at yet', () => {
    // A host with no size answers NaN, and a canvas is better placed wrongly
    // for one frame than not placed at all.
    const area = rectOf(fifth(), STAGE);
    for (const aspect of [Number.NaN, 0, -2]) {
      expect(fitInside(area, aspect, 'center'), String(aspect)).toEqual(area);
    }
  });
});

describe('hugContent', () => {
  /** A picture 400 wide with a figure filling half of it: 100 empty each side. */
  const PICTURE = { left: 600, top: 0, width: 400, height: 200 };

  it('pushes the picture out until the figure is on the edge', () => {
    // The complaint this exists for: pulled right, the character stopped a
    // quarter of a frame short of the edge and stood in front of a large piece
    // of nothing, because it is the picture that was anchored and the figure is
    // in the middle of it.
    expect(hugContent(PICTURE, 'bottom-right', 0.5).left).toBe(700);
    expect(hugContent(PICTURE, 'right', 0.5).left).toBe(700);
  });

  it('pushes the other way for the other side', () => {
    expect(hugContent(PICTURE, 'top-left', 0.5).left).toBe(500);
  });

  it('leaves a centred picture alone, which has no edge to be on', () => {
    for (const anchor of ['center', 'top', 'bottom'] as const) {
      expect(hugContent(PICTURE, anchor, 0.5), anchor).toEqual(PICTURE);
    }
  });

  it('moves nothing vertically, because a framing already fills that axis', () => {
    // A framing is stated as a top and a bottom edge, so there is no gap under
    // the figure to close — and closing one would move the head out of frame.
    expect(hugContent(PICTURE, 'bottom-right', 0.5)).toMatchObject({ top: 0, height: 200 });
  });

  it('leaves it alone when the figure fills the picture or nothing is known', () => {
    // 1 is the answer before an avatar has loaded, and anything outside 0..1 is
    // a measurement that has gone wrong. Neither is a reason to move a canvas.
    for (const content of [1, 0, -1, 4, Number.NaN]) {
      expect(hugContent(PICTURE, 'right', content), String(content)).toEqual(PICTURE);
    }
  });
});

describe('isAnchor', () => {
  it('accepts the nine and nothing else', () => {
    for (const anchor of ANCHORS) expect(isAnchor(anchor), anchor).toBe(true);
    for (const raw of ['', 'centre', 'top-centre', 'TOP', 'bottom-left ']) {
      expect(isAnchor(raw), raw).toBe(false);
    }
  });

  it('does not accept a name every object happens to have', () => {
    // Read from a query string, so `?place=constructor:0.5x0.5` reaches it. A
    // membership test written as a property lookup would say yes.
    for (const raw of ['toString', 'constructor', '__proto__']) {
      expect(isAnchor(raw), raw).toBe(false);
    }
  });
});
