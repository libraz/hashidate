import { SHOT_LIMITS } from '@/engine/types';
import type { Shot } from '@/protocol';

/**
 * The pointer over the preview, turned into a shot.
 *
 * The panel owns this rather than the picture, because the picture may be the
 * stage's feed and a video has no camera to drag. The numbers are the ones the
 * embedded viewer's orbit controls used, so a drag swings the shot as far as it
 * always did: a drag the height of the picture turns it `ROTATE_SPEED` of a
 * full circle, and a wheel notch dollies by `0.95 ^ (ZOOM_SPEED * |deltaY| / 100)`.
 */

/** Slower than an orbit default: the operator is nudging a shot, not exploring a model. */
export const ROTATE_SPEED = 0.4;
export const ZOOM_SPEED = 0.5;

/**
 * How often a dragged shot is sent, in milliseconds.
 *
 * Every one is a request out of the panel and a frame down to every renderer,
 * so a drag sent per frame would be sixty round trips a second to move one
 * camera. Ten is enough for the picture on air to look like it is following.
 */
export const SHOT_INTERVAL = 100;

const clamp = (value: number, { min, max }: { min: number; max: number }): number =>
  Math.min(max, Math.max(min, value));

/** Into (-180, 180], where a bearing read back off a camera lands. */
export function wrapYaw(degrees: number): number {
  const wrapped = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

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

/** One wheel event's dolly. Wheel up comes in. */
export function wheelShot(shot: Required<Shot>, deltaY: number): Required<Shot> {
  if (deltaY === 0) return shot;
  const scale = 0.95 ** (ZOOM_SPEED * Math.abs(deltaY * 0.01));
  const zoom = deltaY < 0 ? shot.zoom / scale : shot.zoom * scale;
  return { ...shot, zoom: clamp(zoom, SHOT_LIMITS.zoom) };
}

/**
 * Send at most once per `SHOT_INTERVAL`, always sending the last one.
 *
 * The trailing send is the one that matters: it is the only one that says where
 * the shot ended up.
 */
export function throttleShots(
  send: (shot: Required<Shot>) => void,
  now: () => number = Date.now,
): { push: (shot: Required<Shot>) => void; cancel: () => void } {
  let sentAt = Number.NEGATIVE_INFINITY;
  let pending: Required<Shot> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    if (pending === null) return;
    const shot = pending;
    pending = null;
    sentAt = now();
    send(shot);
  };
  return {
    push(shot) {
      pending = shot;
      const since = now() - sentAt;
      if (since >= SHOT_INTERVAL) {
        if (timer !== null) clearTimeout(timer);
        flush();
        return;
      }
      if (timer === null) timer = setTimeout(flush, SHOT_INTERVAL - since);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
