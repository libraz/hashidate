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

  // Lowering a wave by swinging the wrist out past the side put the elbow
  // behind the body with the folded forearm pointing outward.
  it.each<Side>(['L', 'R'])(
    'keeps the upper arm in front of the trunk on the way down (%s)',
    (side) => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const h = harness();
      frame(h);
      const rest = links(h, side).upper;

      h.body.playDef(GESTURES.wave, 'wave', side);
      for (let i = 0; i < 60; i++) frame(h);
      const held = links(h, side).upper;
      const floor = Math.min(held.z, rest.z) - 0.05;

      let lowest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 60 * 5; i++) {
        frame(h);
        lowest = Math.min(lowest, links(h, side).upper.z);
      }
      expect(links(h, side).upper.angleTo(rest)).toBeLessThan(0.05);
      expect(lowest).toBeGreaterThanOrEqual(floor);
    },
  );

  // Carrying the folded forearm toward the resting bend, which leans in toward
  // the thigh, swept the waving hand across the belly on its way down.
  it.each<Side>(['L', 'R'])('brings a waving hand down in front, not across (%s)', (side) => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = harness();
    const reach = () => canonicalDirection(h, side, `upperArm.${side}`, `hand.${side}`);
    frame(h);
    const rest = reach().x;

    h.body.playDef(GESTURES.wave, 'wave', side);
    for (let i = 0; i < 60; i++) frame(h);
    h.body.stopGesture();
    let inmost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 60 * 3; i++) {
      frame(h);
      inmost = Math.min(inmost, reach().x);
    }
    expect(inmost).toBeGreaterThanOrEqual(rest * 0.5);
  });
});
