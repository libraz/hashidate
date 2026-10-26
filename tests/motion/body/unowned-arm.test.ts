import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { sideMirror } from '@/engine/motion/frame';
import { GESTURES } from '@/engine/motion/gestures';
import type { GestureDef, Side } from '@/engine/types';
import { canonicalDirection, canonicalHandDirection, DT, type Harness, harness } from './harness';

/**
 * An arm the gesture does not pose is not the gesture's to move.
 *
 * A nod is head, neck and chest; the arms hanging beside it have no part in it
 * and should not hear it start, hold or end. Measured as each link's angular
 * speed in the body's own frame, so a trunk that bends or turns under the arm
 * does not count as the arm moving.
 */

/** rad/s. The twitch this guards against peaked near 6.7; a resting arm reads ~0. */
const STILL = 0.3;
const SIDES: readonly Side[] = ['L', 'R'];

function frame(h: Harness): void {
  h.rig.reset();
  h.body.update(DT);
}

/** The sides a gesture never poses, sampled over its whole playback with `side` pinned. */
function unowned(def: GestureDef, side: Side): Side[] {
  const v = { rate: 1, scale: 1, side: sideMirror(side) };
  const owned = new Set<Side>();
  const end = (def.lead ?? 0) + def.hold + 1;
  for (let t = 0; t <= end; t += 0.05) {
    const pose = def.build(t, v);
    if (pose.clasp) return [];
    for (const s of SIDES) if (pose.arms?.[s] || pose.reach?.[s] || pose.point?.[s]) owned.add(s);
  }
  return SIDES.filter((s) => !owned.has(s));
}

function links(h: Harness, side: Side): THREE.Vector3[] {
  return [
    canonicalDirection(h, side, `upperArm.${side}`, `lowerArm.${side}`),
    canonicalDirection(h, side, `lowerArm.${side}`, `hand.${side}`),
    canonicalHandDirection(h, side),
  ];
}

const CASES = Object.entries(GESTURES as Record<string, GestureDef>).flatMap(([id, def]) =>
  unowned(def, 'R').map((free) => ({ id, free })),
);

describe('an arm the gesture does not own', () => {
  it('is found for the head-only reactions', () => {
    const ids = CASES.map((c) => c.id);
    expect(ids).toContain('nod');
    expect(ids).toContain('tilt');
  });

  it.each(CASES)('stays still through $id ($free)', ({ id, free }) => {
    const h = harness(0, { random: () => 0.5 });
    for (let i = 0; i < 120; i++) frame(h);
    let prev = links(h, free);

    const def = (GESTURES as Record<string, GestureDef>)[id];
    h.body.play(id, 'R');
    const holdFrames = Math.ceil(((def.lead ?? 0) + def.hold) / DT);
    let worst = 0;
    let at = 0;
    for (let i = 0; i < holdFrames + 150; i++) {
      if (def.sustain && i === holdFrames) h.body.stopGesture();
      frame(h);
      const now = links(h, free);
      for (let k = 0; k < now.length; k++) {
        const w = prev[k].angleTo(now[k]) / DT;
        if (w > worst) {
          worst = w;
          at = i * DT;
        }
      }
      prev = now;
    }
    expect(worst, `peak at ${at.toFixed(3)} s`).toBeLessThan(STILL);
  });
});
