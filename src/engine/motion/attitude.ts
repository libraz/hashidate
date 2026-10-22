import { DROOP_RATE } from '../face/blink';
import type { Rig } from '../rig';
import type { SpineOffsets } from '../types';
import { SPINE_SLOTS } from './custom';
import { ScalarFollower } from './follow';

/**
 * A mood's body: spine offsets held while the mood is up.
 *
 * Static and armless, so it is one more additive source under breath, drift and
 * whatever gesture is playing, never ducked by one. It follows at the pace of
 * the face (`DROOP_RATE`), so a change of attitude, or none, is a new target for
 * the same follower rather than a handoff.
 */

/** How fast the held offsets arrive, in the followers' first-order terms. */
export const ATTITUDE_FOLLOW = DROOP_RATE;

const AXES = 3;
/** Below this a settled slot adds nothing. */
const SETTLED = 1e-6;

export class Attitude {
  private readonly _value = SPINE_SLOTS.flatMap(() => [0, 1, 2].map(() => new ScalarFollower(0)));
  private readonly _goal = new Float64Array(SPINE_SLOTS.length * AXES);
  private _target: SpineOffsets | null = null;

  /** The offsets being held, as authored (not mirrored), or null. */
  get target(): SpineOffsets | null {
    return this._target;
  }

  /** `mirror` flips yaw and roll, as a gesture's `v.side` does; pitch is unchanged. */
  set(offsets: SpineOffsets | null, mirror: 1 | -1): void {
    this._target = offsets;
    for (let i = 0; i < SPINE_SLOTS.length; i++) {
      const o = offsets?.[SPINE_SLOTS[i]];
      this._goal[i * AXES] = o ? o[0] : 0;
      this._goal[i * AXES + 1] = o ? o[1] * mirror : 0;
      this._goal[i * AXES + 2] = o ? o[2] * mirror : 0;
    }
  }

  apply(rig: Pick<Rig, 'addOffset'>, dt: number): void {
    for (let i = 0; i < SPINE_SLOTS.length; i++) {
      const k = i * AXES;
      const x = this._value[k].step(this._goal[k], dt, ATTITUDE_FOLLOW);
      const y = this._value[k + 1].step(this._goal[k + 1], dt, ATTITUDE_FOLLOW);
      const z = this._value[k + 2].step(this._goal[k + 2], dt, ATTITUDE_FOLLOW);
      const live =
        Math.abs(x) > SETTLED ||
        Math.abs(y) > SETTLED ||
        Math.abs(z) > SETTLED ||
        this._goal[k] !== 0 ||
        this._goal[k + 1] !== 0 ||
        this._goal[k + 2] !== 0;
      if (live) rig.addOffset(SPINE_SLOTS[i], x, y, z);
    }
  }
}
