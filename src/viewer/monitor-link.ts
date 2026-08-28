/**
 * What a viewer and the page that embedded it say to each other directly.
 *
 * One message, going up, and it is about this renderer being a monitor rather
 * than about the performance.
 *
 * **The shot.** The preview is where the camera is dragged, and what a drag
 * produces has to reach the renderer on air — so it does go through the control
 * API, but it is the *panel* that sends it. The alternative is a renderer that
 * originates commands, and the whole reason the control channel is trustworthy
 * is that it only ever translates them. So the picture tells the panel where the
 * pointer put the camera, and the panel says so in the ordinary way.
 *
 * It goes frame-to-parent over `postMessage`.
 *
 * ## What used to be here, going the other way
 *
 * A mute, sent down to an embedded viewer so that the panel's preview could be
 * listened to without the picture reloading. It is gone, and the reason is
 * worth keeping: whether a renderer makes a sound is now decided by the URL it
 * was opened on, which is the same `?mute=1` every browser source has always
 * understood. The panel's preview is opened muted and stays that way, and the
 * one window in the native shell that speaks is opened muted or not from a
 * menu that reloads it. That costs a reload where a message cost nothing —
 * affordable because it is a decision about the desk, made once while it is
 * being set up, and not something reached for mid-broadcast.
 *
 * Which leaves one fewer thing that can silence a renderer without the URL
 * saying so, and that is the part worth having: a page that is quiet is quiet
 * for a reason its address states.
 *
 * The telemetry readout looks like it belongs here and does not, which is worth
 * saying because it was here once. It is wanted on the viewer going to air more
 * often than on the preview, so it is an ordinary `debug` command — and the
 * preview then shows it because the preview is a renderer receiving the same
 * commands, which is the whole idea of the preview.
 *
 * ## Why it is safe to have at all
 *
 * The origin is checked against this page's own, and both ends of this are
 * served by the same loopback server — the viewer, the panel and the control API
 * are one origin by licence condition, not by convenience. A message from
 * anywhere else is dropped, and there is nowhere else it could come from: the
 * server binds `127.0.0.1` and sends no CORS header, so no other origin can host
 * a page that frames this one and gets a reply.
 *
 * ## Why it is only this one
 *
 * Everything else the panel does goes through `/api`, deliberately, so that what
 * the panel can do is exactly what an orchestrator can do. This takes nothing
 * away from that: it ends in an ordinary `camera` command that an orchestrator
 * could have sent itself. Nothing here reaches the character.
 */

import type { Shot } from '@/engine/types';

export const SHOT_MESSAGE = 'hashidate.shot';

/** Where the pointer put the camera, as the embedded viewer read it back. */
export interface ShotMessage {
  type: 'hashidate.shot';
  shot: Required<Shot>;
}

const isShotMessage = (data: unknown): data is ShotMessage => {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as ShotMessage;
  if (message.type !== SHOT_MESSAGE) return false;
  const shot = message.shot as Partial<Shot> | undefined;
  return (
    typeof shot === 'object' &&
    shot !== null &&
    typeof shot.frame === 'string' &&
    typeof shot.yaw === 'number' &&
    typeof shot.pitch === 'number' &&
    typeof shot.zoom === 'number'
  );
};

/**
 * Tell the embedder where the camera ended up.
 *
 * A no-op on a page nobody framed, which is the one OBS opens: the shot there
 * is set by the panel and never read back, because the pointer cannot move it.
 */
export function sendMonitorShot(shot: Required<Shot>): void {
  if (window.parent === window) return;
  const message: ShotMessage = { type: SHOT_MESSAGE, shot };
  window.parent.postMessage(message, location.origin);
}

/** Listen for the shot an embedded viewer reports. Returns the unsubscribe. */
export function onMonitorShot(apply: (shot: Required<Shot>) => void): () => void {
  const listener = (event: MessageEvent): void => {
    if (event.origin !== location.origin) return;
    if (!isShotMessage(event.data)) return;
    apply(event.data.shot);
  };
  addEventListener('message', listener);
  return () => removeEventListener('message', listener);
}
