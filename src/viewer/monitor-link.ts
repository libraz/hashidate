/**
 * What a viewer and the page that embedded it say to each other directly.
 *
 * Two messages, one each way, and both are about this renderer being a monitor
 * rather than about the performance.
 *
 * **Down: the mute.** The panel shows the character in an iframe, and the
 * operator needs to be able to hear it or not without the picture going away.
 * That cannot be done through the control API: muting is a property of *this
 * renderer*, and a command would silence every viewer including the one going
 * to air.
 *
 * The telemetry readout looks like it belongs here and does not, which is worth
 * saying because it was here once. It is wanted on the viewer going to air more
 * often than on this one, so it is an ordinary `debug` command — and the
 * preview then shows it because the preview is a renderer receiving the same
 * commands, which is the whole idea of the preview.
 *
 * **Up: the shot.** The preview is where the camera is dragged, and what a drag
 * produces has to reach the renderer on air — so it does go through the control
 * API, but it is the *panel* that sends it. The alternative is a renderer that
 * originates commands, and the whole reason the control channel is trustworthy
 * is that it only ever translates them. So the picture tells the panel where the
 * pointer put the camera, and the panel says so in the ordinary way.
 *
 * Both go parent-to-frame or frame-to-parent over `postMessage`.
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
 * ## Why it is only these two
 *
 * Everything else the panel does goes through `/api`, deliberately, so that what
 * the panel can do is exactly what an orchestrator can do. Neither of these
 * takes anything away from that: one is about which speakers a sound comes out
 * of, and the other ends in an ordinary `camera` command that an orchestrator
 * could have sent itself. Nothing here reaches the character.
 */

import type { Shot } from '@/engine/types';

/** What the panel sends. Tagged, because a page receives messages it did not ask for. */
export interface MuteMessage {
  type: 'hashidate.mute';
  muted: boolean;
}

export const MUTE_MESSAGE = 'hashidate.mute';

const isMuteMessage = (data: unknown): data is MuteMessage =>
  typeof data === 'object' &&
  data !== null &&
  (data as MuteMessage).type === MUTE_MESSAGE &&
  typeof (data as MuteMessage).muted === 'boolean';

/**
 * Listen for the embedder's mute. Returns the unsubscribe.
 *
 * A no-op on a page that is not embedded — `window.parent === window` — rather
 * than a listener that can never fire, so the viewer OBS opens carries nothing
 * it does not use.
 */
export function onMonitorMute(apply: (muted: boolean) => void): () => void {
  if (window.parent === window) return () => {};
  const listener = (event: MessageEvent): void => {
    // Same origin or nothing. See the note above on why there is no other one.
    if (event.origin !== location.origin) return;
    if (!isMuteMessage(event.data)) return;
    apply(event.data.muted);
  };
  addEventListener('message', listener);
  return () => removeEventListener('message', listener);
}

/** Send the mute to an embedded viewer. */
export function sendMonitorMute(frame: HTMLIFrameElement | null, muted: boolean): void {
  const message: MuteMessage = { type: MUTE_MESSAGE, muted };
  frame?.contentWindow?.postMessage(message, location.origin);
}

// --- the shot, going the other way ------------------------------------------

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
