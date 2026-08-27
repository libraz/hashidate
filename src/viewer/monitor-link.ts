/**
 * The one thing a staged viewer accepts from the page that embedded it.
 *
 * The broadcast panel shows the character in an iframe, and the operator needs
 * to be able to hear it or not without the picture going away. That cannot be
 * done through the control API: muting is a property of *this renderer* rather
 * than of the performance, and a command would silence every viewer including
 * the one going to air.
 *
 * So it goes directly, parent to frame, over `postMessage`.
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
 * ## Why it is only this
 *
 * Everything else the panel does goes through `/api`, deliberately, so that what
 * the panel can do is exactly what an orchestrator can do. This is the single
 * exception and it stays single: it is about which speakers a sound comes out
 * of, which is not something an orchestrator has an opinion about.
 */

/** What the panel sends. Tagged, because a page receives messages it did not ask for. */
export interface MuteMessage {
  type: 'aituber.mute';
  muted: boolean;
}

export const MUTE_MESSAGE = 'aituber.mute';

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
