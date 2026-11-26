import type { ControlClient } from '../control-client';
import type { AvatarRuntime } from '../scene/runtime';
import { mascotBridge } from '../shell-bridge';
import { createHitTest, watchPointer } from './pointer';
import { reportTouches } from './report';

/**
 * Let the character on the desktop be touched, carried about, turned and resized,
 * and shown from the angle its window keeps.
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
  const unlisten = bridge.onShot((angle) => runtime.setShot(angle));
  const stop = watchPointer({
    target: window,
    bridge,
    hitTest: createHitTest(runtime),
    onTouch: reportTouches(client),
    shot: { get: () => runtime.shot, set: (shot) => runtime.setShot(shot) },
    height: () => window.innerHeight,
    origin: () => ({ x: window.screenX, y: window.screenY }),
    cursor: (kind) => {
      document.documentElement.style.cursor = kind ?? '';
    },
  });
  return () => {
    unlisten();
    stop();
  };
}
