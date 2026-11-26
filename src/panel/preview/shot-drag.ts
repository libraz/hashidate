import type { Shot } from '@/protocol';

/**
 * The pointer over the preview, turned into a shot.
 *
 * The panel owns this rather than the picture, because the picture may be the
 * stage's feed and a video has no camera to drag. The expressions live in
 * `src/viewer/shot-gesture.ts`.
 */

/**
 * How often a dragged shot is sent, in milliseconds.
 *
 * Every one is a request out of the panel and a frame down to every renderer,
 * so a drag sent per frame would be sixty round trips a second to move one
 * camera. Ten is enough for the picture on air to look like it is following.
 */
export const SHOT_INTERVAL = 100;

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
