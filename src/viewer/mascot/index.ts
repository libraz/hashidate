import type { ControlClient } from '../control-client';
import type { AvatarRuntime } from '../scene/runtime';
import { mascotBridge } from '../shell-bridge';
import { createHitTest, watchPointer } from './pointer';
import { reportTouches } from './report';

/**
 * Let the character on the desktop be touched and carried about.
 *
 * Does nothing on a page that no mascot window opened: without the bridge
 * there is no window to make solid or to move, so the pointer is left alone.
 *
 * @returns A function that stops listening.
 */
export function mountMascot(
  runtime: AvatarRuntime,
  client: Pick<ControlClient, 'pushEvent'>,
): () => void {
  const bridge = mascotBridge();
  if (!bridge) return () => {};
  return watchPointer({
    target: window,
    bridge,
    hitTest: createHitTest(runtime),
    onTouch: reportTouches(client),
  });
}
