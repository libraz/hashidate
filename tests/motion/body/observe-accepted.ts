import { vi } from 'vitest';
import type { FingerName, Side } from '@/engine/types';
import type { Harness } from './harness';

export interface AcceptedHandFrame {
  curls: Record<FingerName, number>;
  spread: Record<FingerName, number>;
}

export type AcceptedHandsFrame = Record<Side, AcceptedHandFrame>;

/** Observe the shapes Body actually accepted after each completed frame. */
export function observeAcceptedHands(
  h: Harness,
  onFrame: (frame: AcceptedHandsFrame) => void,
): void {
  const update = h.body.update.bind(h.body);
  vi.spyOn(h.body, 'update').mockImplementation((dt, ctx) => {
    const result = update(dt, ctx);
    const side = (which: Side): AcceptedHandFrame => {
      const accepted = h.rig.acceptedArmState(which);
      return { curls: { ...accepted.curls }, spread: { ...accepted.spread } };
    };
    onFrame({ L: side('L'), R: side('R') });
    return result;
  });
}
