import type * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GESTURES } from '@/engine/motion/gestures';
import type { Side } from '@/engine/types';
import { canonicalDirection, DT, type Harness, harness } from './harness';

/**
 * How an arm comes down off a raised pose.
 *
 * A person lowering a raised hand keeps the elbow bent while the upper arm
 * comes down and straightens it late. Blending each link back on its own
 * unfolds the forearm first, and the straightened arm then swings in from the
 * side — measured here as the elbow's fold at the moment the upper arm is half
 * way home.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function links(h: Harness, side: Side): { upper: THREE.Vector3; lower: THREE.Vector3 } {
  return {
    upper: canonicalDirection(h, side, `upperArm.${side}`, `lowerArm.${side}`),
    lower: canonicalDirection(h, side, `lowerArm.${side}`, `hand.${side}`),
  };
}

function frame(h: Harness): void {
  h.rig.reset();
  h.body.update(DT);
}

describe('gesture exit', () => {
  it.each<Side>(['L', 'R'])(
    'keeps the elbow folded while the upper arm comes down (%s)',
    (side) => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const h = harness();
      frame(h);
      const rest = links(h, side).upper;

      h.body.playDef({ ...GESTURES.pointUp, sustain: true }, 'pointUp', side);
      for (let i = 0; i < 120; i++) frame(h);
      const held = links(h, side);
      const heldFold = held.upper.angleTo(held.lower);
      const travel = held.upper.angleTo(rest);
      expect(heldFold).toBeGreaterThan(1.5);

      h.body.stopGesture();
      let fold: number | null = null;
      for (let i = 0; i < 180 && fold === null; i++) {
        frame(h);
        const now = links(h, side);
        if (now.upper.angleTo(held.upper) >= travel * 0.5) fold = now.upper.angleTo(now.lower);
      }
      expect(fold).not.toBeNull();
      expect(fold ?? 0).toBeGreaterThanOrEqual(heldFold * 0.75);
    },
  );
});
