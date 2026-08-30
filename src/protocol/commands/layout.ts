import { z } from 'zod';
import type { Anchor, Placement, SlidePlacement } from '../../engine/types';
import { PLACEMENT_LIMITS } from '../../engine/types';
import type { Assert, Equals, Expect } from './guards';
import { within } from './primitives';

/**
 * Laying out the frame.
 *
 * Its own module rather than living beside `place`, because a layout is stated
 * in two places: as its own command, and on a line under `stage`. One
 * definition, used by both — see `placeCommandSchema` in `staging.ts` for what
 * a placement means and why the two layers travel together.
 */

const anchorSchema = z.enum([
  'center',
  'top-left',
  'top',
  'top-right',
  'left',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
]);
type _AnchorsMatchEngine = Expect<Equals<z.infer<typeof anchorSchema>, Anchor>>;

/**
 * A rectangle of the output frame. See `Placement` in the engine for why it is
 * two fractions rather than a size and an aspect ratio.
 *
 * Every field is optional and an absent one is left alone, so a slider under
 * the pointer sends one number.
 */
export const placementSchema = z.object({
  anchor: anchorSchema.optional(),
  width: within(PLACEMENT_LIMITS.width).optional(),
  height: within(PLACEMENT_LIMITS.height).optional(),
  margin: within(PLACEMENT_LIMITS.margin).optional(),
});

type _PlacementMatchesEngine = Expect<Equals<z.infer<typeof placementSchema>, Placement>>;

export const slidePlacementSchema = placementSchema.extend({
  fit: z.enum(['contain', 'cover']).optional(),
});

type _SlidePlacementMatchesEngine = Assert<z.infer<typeof slidePlacementSchema>, SlidePlacement>;
type _EngineMatchesSlidePlacement = Assert<SlidePlacement, z.infer<typeof slidePlacementSchema>>;

/** Both layers of a layout: the command's payload, and `stage.place`. */
export const placeStageSchema = z.object({
  avatar: placementSchema.optional(),
  slide: slidePlacementSchema.optional(),
});
