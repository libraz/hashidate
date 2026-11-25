import type { SessionEvent } from '@/protocol';
import type { ControlClient } from '../control-client';
import type { MascotTouch } from './pointer';

/**
 * Turn the pointer's touches into reports.
 *
 * A touch is reported and nothing more: what the character does about it is
 * the caller's to decide from `/api/events`.
 */
export function reportTouches(
  client: Pick<ControlClient, 'pushEvent'>,
): (touch: MascotTouch) => void {
  return ({ kind, part, side, count }) => {
    const event: SessionEvent = { type: kind === 'tap' ? 'touch.tap' : 'touch.hold', count };
    if (part !== undefined) event.part = part;
    if (side !== undefined) event.side = side;
    client.pushEvent(event);
  };
}
