import { SHOT_LIMITS, wrapYaw } from '@/engine/types';
import type { Shot } from '@/protocol';

/**
 * The pointer turned into a shot, shared by every surface that drags a camera.
 *
 * The numbers are the ones the embedded viewer's orbit controls used, so a drag
 * swings the shot as far as it always did: a drag the height of the picture
 * turns it `ROTATE_SPEED` of a full circle, and a wheel notch dollies by
 * `0.95 ^ (ZOOM_SPEED * |deltaY| / 100)`.
 */

/** Slower than an orbit default: the operator is nudging a shot, not exploring a model. */
export const ROTATE_SPEED = 0.4;
export const ZOOM_SPEED = 0.5;

const clamp = (value: number, { min, max }: { min: number; max: number }): number =>
  Math.min(max, Math.max(min, value));

/**
 * Where a drag of `dx`, `dy` CSS pixels over a picture `height` tall puts the
 * camera, from the shot it started at. Right swings round to the left of the
 * character, down lifts the camera to look down; pitch stops where the wire does.
 */
export function dragShot(
  start: Required<Shot>,
  dx: number,
  dy: number,
  height: number,
): Required<Shot> {
  if (height <= 0) return start;
  const turn = (360 * ROTATE_SPEED) / height;
  return {
    ...start,
    yaw: wrapYaw(start.yaw - dx * turn),
    pitch: clamp(start.pitch + dy * turn, SHOT_LIMITS.pitch),
  };
}

/** The magnitude of one wheel event's dolly, as a factor below 1. */
export function wheelScale(deltaY: number): number {
  return 0.95 ** (ZOOM_SPEED * Math.abs(deltaY * 0.01));
}

/** The factor one wheel event multiplies the zoom by, 1 when it carries no delta. Wheel up comes in. */
export function wheelFactor(deltaY: number): number {
  if (deltaY === 0) return 1;
  const scale = wheelScale(deltaY);
  return deltaY < 0 ? 1 / scale : scale;
}

/** One wheel event's dolly. Wheel up comes in. */
export function wheelShot(shot: Required<Shot>, deltaY: number): Required<Shot> {
  if (deltaY === 0) return shot;
  const scale = wheelScale(deltaY);
  const zoom = deltaY < 0 ? shot.zoom / scale : shot.zoom * scale;
  return { ...shot, zoom: clamp(zoom, SHOT_LIMITS.zoom) };
}
