import type { Anchor, Placement, SlidePlacement } from '@/engine/types';
import { PLACEMENT_LIMITS } from '@/engine/types';

/**
 * Where each layer of the output frame lands, in pixels.
 *
 * The arithmetic half of the composition, and it is a module of its own for
 * that reason: everything that consumes it owns a WebGL context or a canvas
 * element, and a decision made in there can only be checked by rendering the
 * page and looking at it. Here it can be checked by reading a number.
 *
 * Nothing in this file touches the DOM. See `SlideStage` and `AvatarRuntime`
 * for what is done with the rectangles it produces.
 */

/** A layer's place on the stage, in CSS pixels from the stage's top-left. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The stage a layer is placed on, in CSS pixels. */
export interface StageSize {
  width: number;
  height: number;
}

/** Which edge of the stage an axis is pulled to. */
type Align = 'start' | 'mid' | 'end';

/**
 * The nine anchors, resolved to an alignment per axis.
 *
 * A table rather than string tests, because the compiler checks a
 * `Record<Anchor, …>` covers every anchor and cannot check that
 * `anchor.includes('left')` does. It is also the list of anchors that exist —
 * `isAnchor` reads it — so a tenth would arrive here and nowhere else.
 */
const ALIGN: Record<Anchor, { x: Align; y: Align }> = {
  center: { x: 'mid', y: 'mid' },
  'top-left': { x: 'start', y: 'start' },
  top: { x: 'mid', y: 'start' },
  'top-right': { x: 'end', y: 'start' },
  left: { x: 'start', y: 'mid' },
  right: { x: 'end', y: 'mid' },
  'bottom-left': { x: 'start', y: 'end' },
  bottom: { x: 'mid', y: 'end' },
  'bottom-right': { x: 'end', y: 'end' },
};

/** Whether a string names one of the nine. For reading a query string. */
export const isAnchor = (raw: string): raw is Anchor => Object.hasOwn(ALIGN, raw);

/**
 * The whole frame: what a layer occupies until something says otherwise.
 *
 * Stated as a `Required` placement rather than as the partial the wire carries,
 * because this is the thing a patch lands *on*. A resolved placement always has
 * all four fields, so nothing downstream has to decide what an absent one meant.
 */
export const FULL_FRAME: Required<Placement> = {
  anchor: 'center',
  width: 1,
  height: 1,
  margin: 0,
};

/** The same, plus the one extra question a picture asks. See `SlidePlacement`. */
export const FULL_SLIDE: Required<SlidePlacement> = { ...FULL_FRAME, fit: 'contain' };

/**
 * Land a patch on a resolved placement.
 *
 * An absent field is left alone rather than reset, which is the rule the whole
 * command set follows: a surface with one slider under the pointer sends one
 * number. Written as a loop instead of a spread because a spread copies an
 * explicit `undefined` over a value that was set — a shape a zod object with
 * optional fields produces the moment the key is present at all — and the
 * failure that causes is a slider snapping a layer back to full frame.
 */
export function resolvePlacement<T extends object>(base: T, patch: Partial<T>): T {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * The largest rectangle of a given shape that fits in an area, pulled to the
 * same corner the area was.
 *
 * ## What this is for, which took two wrong answers to find
 *
 * The character's picture is drawn into a rectangle of the frame, and the
 * rectangle an operator asks for is very often not the shape of the frame — a
 * tall box in a corner, beside a document. A camera framing is stated as a
 * world-space top and bottom edge, so pointing it at a rectangle of some other
 * shape has to give something up, and both of the obvious answers are wrong in
 * a way that is only obvious afterwards:
 *
 * - Fill the rectangle. The framing's vertical is kept and the width falls out
 *   of the aspect, so a tall box keeps the head and cuts the arms off both
 *   sides — which is where a raised hand and most of the hair are.
 * - Stand the camera back until the width fits. Nothing is cropped, and the
 *   vertical grows by the same factor, so an upper-body shot quietly becomes a
 *   full-body one. The framing stops meaning what it says.
 *
 * So the rectangle does not decide the shot at all. It is an *area*, and the
 * picture put in it is the frame's own shape scaled down — the same picture the
 * whole frame would have shown, smaller and in a corner. Nothing is cropped,
 * nothing is reframed, and every framing goes on meaning exactly what it did.
 *
 * The area around it is left transparent rather than filled, so what shows
 * through is the document behind the character. There is nothing to letterbox.
 */
export function fitInside(area: Rect, aspect: number, anchor: Anchor): Rect {
  if (!Number.isFinite(aspect) || aspect <= 0) return area;
  const width = Math.min(area.width, Math.round(area.height * aspect));
  const height = Math.min(area.height, Math.round(width / aspect));
  const align = ALIGN[anchor] ?? ALIGN.center;
  return {
    left: area.left + offset(align.x, 0, width, area.width),
    top: area.top + offset(align.y, 0, height, area.height),
    width,
    height,
  };
}

/**
 * Slide a picture so that the thing *in* it lands on the edge the anchor names.
 *
 * `fitInside` puts the picture's edge against the area's edge, which is right
 * for a document and wrong for a character: a framing is a wide picture with a
 * narrow figure in the middle of it, so anchoring the picture to the right of
 * the frame leaves the character a quarter of a frame short of it, standing in
 * front of a large piece of nothing. That is the whole of what an operator
 * means by "pull it to the right", and it is not what they get.
 *
 * `content` is how much of the picture's width the figure actually occupies,
 * 0 to 1. The empty half of the difference is spent by pushing the picture
 * *past* the edge it was pulled to — the frame clips it there, which is exactly
 * what an overlay hanging off the side of a shot looks like, and much better
 * than the alternative of cropping the picture to the figure, which would take
 * an arm off the moment one was raised.
 *
 * Only the horizontal is moved. A framing is stated as a top and a bottom edge,
 * so the figure already fills the picture vertically and there is no gap under
 * it to close.
 */
export function hugContent(picture: Rect, anchor: Anchor, content: number): Rect {
  const align = ALIGN[anchor] ?? ALIGN.center;
  if (align.x === 'mid') return picture;
  if (!Number.isFinite(content) || content <= 0 || content >= 1) return picture;
  const pad = Math.round((picture.width * (1 - content)) / 2);
  return { ...picture, left: picture.left + (align.x === 'end' ? pad : -pad) };
}

/**
 * Where a placement puts a layer on a stage of a given size.
 *
 * `margin` is a fraction of the stage **height** on both axes and is spent only
 * on the edges the anchor pulls the layer to — a centred layer touches none of
 * them and is unaffected, which is why it is not an inset. See `Placement`.
 *
 * The result is clamped inside the stage. A margin that will not fit is spent
 * as far as it goes rather than pushing the layer off the frame: the numbers
 * come off a query string and out of a drag, and a layer that has left the
 * picture is indistinguishable from a renderer that has died.
 */
export function rectOf(p: Required<Placement>, stage: StageSize): Rect {
  const width = Math.min(
    Math.round(
      stage.width * clamp(p.width, PLACEMENT_LIMITS.width.min, PLACEMENT_LIMITS.width.max),
    ),
    stage.width,
  );
  const height = Math.min(
    Math.round(
      stage.height * clamp(p.height, PLACEMENT_LIMITS.height.min, PLACEMENT_LIMITS.height.max),
    ),
    stage.height,
  );
  // Both axes off the height, so one number reads as one gap. Measured per axis
  // it opens a wider hole at the side than at the bottom on a 16:9 frame.
  const margin = Math.round(
    stage.height * clamp(p.margin, PLACEMENT_LIMITS.margin.min, PLACEMENT_LIMITS.margin.max),
  );
  const align = ALIGN[p.anchor] ?? ALIGN.center;
  return {
    left: offset(align.x, margin, width, stage.width),
    top: offset(align.y, margin, height, stage.height),
    width,
    height,
  };
}

function offset(align: Align, margin: number, size: number, extent: number): number {
  const raw =
    align === 'start' ? margin : align === 'end' ? extent - size - margin : (extent - size) / 2;
  return Math.round(clamp(raw, 0, Math.max(extent - size, 0)));
}
