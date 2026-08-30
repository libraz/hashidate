import type { Localized } from '../../../i18n/locale';
import type { GestureDef, GestureGroup } from '../../types';
import { CUTE } from './cute';
import { EMOTE } from './emote';
import { EXPLAIN } from './explain';
import { GREETING } from './greeting';
import { GESTURE_GROUPS } from './groups';
import { POSE } from './pose';
import { REACTION } from './reaction';

/**
 * Gesture table.
 *
 * Poses are authored in "character space" — x outward from the midline, y up,
 * z forward — and mirrored per side at apply time. Written this way a gesture
 * works on either arm and on any rig, because the rig resolves directions
 * rather than local angles.
 *
 * Two rules govern everything here:
 *
 * 1. **Everything fits a bust framing.** That is the shot an AITuber streams.
 *    A gesture that throws an elbow wide or raises a hand overhead puts the
 *    hand outside the frame, and a character gesturing at nothing is worse than
 *    a character standing still.
 *
 * 2. **Oscillations start at zero.** `build(t, v)` is called from t=0, so every
 *    periodic term is written `sin(t * w * v.rate)` and never `sin(t * w + phase)`.
 *    A phase offset means the term is already mid-swing on the first frame and
 *    the limb snaps into the gesture. Variation comes from `v.rate` (frequency)
 *    and `v.scale` (amplitude), neither of which breaks the zero start.
 *
 *    `explain` is the one deliberate exception, and states its own reason where
 *    it breaks the rule. It is exempt because the gesture's entrance eases the
 *    whole pose in over its lead, so the offset arrives scaled to nothing rather
 *    than as a step. Anything added here follows the rule unless it can make the
 *    same argument in the same place.
 *
 * The table is filed by group, one file each, in the order the groups are
 * declared — which is the order the ids come out in and therefore the order a
 * control surface draws them. `base`, `hands` and `builders` hold the parts the
 * six share: the rest pose, the named hand shapes, and the four helpers every
 * `build` returns through.
 */

export { BASE_FINGERS, BASE_PALM, BASE_POSE } from './base';
export { GESTURE_GROUPS } from './groups';
export { POINT_HAND, pointHand } from './hands';

/**
 * Every gesture, in group order.
 *
 * Spread rather than nested so that an id is reachable as `GESTURES.wave` and
 * the table stays one flat namespace — a gesture is named on the wire by its id
 * alone, and a caller has no reason to know which file it lives in.
 */
export const GESTURES = {
  ...REACTION,
  ...GREETING,
  ...EXPLAIN,
  ...EMOTE,
  ...CUTE,
  ...POSE,
} satisfies Record<string, GestureDef>;

export type GestureId = keyof typeof GESTURES;

/** One group, with the ids that belong to it. */
export interface GestureGroupEntry {
  key: GestureGroup;
  label: Localized;
  ids: GestureId[];
}

/** Gesture ids grouped, for the UI and for the auto-gesture pool. */
export const GESTURES_BY_GROUP: GestureGroupEntry[] = (
  Object.entries(GESTURE_GROUPS) as Array<[GestureGroup, Localized]>
).map(([key, label]) => ({
  key,
  label,
  ids: (Object.keys(GESTURES) as GestureId[]).filter((id) => GESTURES[id].group === key),
}));
