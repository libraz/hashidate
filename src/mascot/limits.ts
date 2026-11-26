import type { ShotAngle } from '../engine/types/staging';

/**
 * What a window may ask of the mascot's size and direction.
 *
 * A leaf with no imports but a type, so the page and the main process can both
 * read it; the main process checks what it is sent against these.
 */

/** The factor one resize request may carry, ends included. */
export const SCALE_BY_LIMITS = { min: 0.5, max: 2 } as const;

/** Whether a request's size factor is a finite number within `SCALE_BY_LIMITS`. */
export function isScaleFactor(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= SCALE_BY_LIMITS.min &&
    value <= SCALE_BY_LIMITS.max
  );
}

/** The angle two numbers make, or null unless both are finite; the `turn` action normalises the range. */
export function angleFrom(yaw: unknown, pitch: unknown): ShotAngle | null {
  if (typeof yaw !== 'number' || typeof pitch !== 'number') return null;
  return Number.isFinite(yaw) && Number.isFinite(pitch) ? { yaw, pitch } : null;
}
