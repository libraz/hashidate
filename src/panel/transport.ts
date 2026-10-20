import type { Snapshot } from '@/protocol';

/**
 * Which transport buttons have something to act on, so that neither can be
 * pressed into a no-op. Stop is for a run in progress: a line on air, or an
 * unheld queue with lines still to go. Drop only ever discards pending lines.
 */
export function transport(snapshot: Snapshot): { stop: boolean; drop: boolean } {
  const onAir =
    (snapshot.airing?.length ?? 0) > 0 ||
    (snapshot.state.turn ?? null) !== null ||
    (snapshot.state.speaking ?? false);
  const pending = snapshot.queue.length > 0;
  return { stop: onAir || (pending && !snapshot.paused), drop: pending };
}

/**
 * Whether the hold can be thrown either way.
 *
 * Holding is always possible. Releasing is not with nothing to release, nor
 * while the voice is loading or down — the server would refuse the play, and a
 * key that did nothing visible would read as a key that is broken.
 */
export function canHold(snapshot: Snapshot): boolean {
  if (!snapshot.paused) return true;
  if (snapshot.queue.length === 0) return false;
  return snapshot.speech !== 'loading' && snapshot.speech !== 'down';
}
