import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Side } from '@/engine/types';
import { DT, type Harness, harness, wristOf } from './harness';

/**
 * The two-handed heart, held and offered.
 *
 * Both hands are a reach with no pole, so nothing but the authored hand and
 * palm decides how the arm is turned. Asked for more wrist than the joint has,
 * the limiter takes the difference out of the shoulder and forearm instead:
 * the elbows swing across the chest, the forearm rolls from one stop to the
 * other, and the release starts with that whole correction coming undone in a
 * frame. Measured here as joints at their stop, the wrist the limiter moved,
 * and the wrist's acceleration from entrance to rest.
 */

const HEARTS = ['heartHands', 'heartOffer'] as const;
const SIDES: Side[] = ['L', 'R'];
/** Nominal variation, so the limited and unlimited runs ask for the same pose. */
const NOMINAL = { random: () => 0.5 };
/** A frame inside the hold of both gestures, the offer included. */
const HOLD = 120;
/** Entrance, hold and release back to rest. */
const FRAMES = 280;
/** Peak wrist acceleration of a clean move, m/s² — the limiter's seams start at 50. */
const SEAM = 40;

interface Run {
  h: Harness;
  /** Both wrists at `HOLD`. */
  held: Record<Side, THREE.Vector3>;
  /** Arm readings at their stop at `HOLD`, per side. */
  stops: string[];
  /** Peak wrist acceleration over either hand and the whole run. */
  acceleration: number;
}

function run(id: string, limits: boolean): Run {
  const h = harness(0, NOMINAL);
  h.rig.limitsEnabled = limits;
  h.rig.reset();
  h.body.update(DT);
  h.body.play(id, 'R');
  const held = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  const stops: string[] = [];
  const prev: Record<Side, { w: THREE.Vector3; v: THREE.Vector3 } | null> = { L: null, R: null };
  let acceleration = 0;
  for (let i = 0; i < FRAMES; i++) {
    h.rig.reset();
    h.body.update(DT);
    for (const side of SIDES) {
      const w = wristOf(h.profile, side);
      const p = prev[side];
      const v = p ? w.clone().sub(p.w).divideScalar(DT) : new THREE.Vector3();
      // The first frames carry the rest pose settling, not the gesture.
      if (p && i > 2) acceleration = Math.max(acceleration, v.distanceTo(p.v) / DT);
      prev[side] = { w, v };
      if (i === HOLD) {
        held[side].copy(w);
        for (const r of h.rig.measure(side) ?? []) {
          if (r.measured && r.zone === 'limit') stops.push(`${side} ${r.id} ${r.deg.toFixed(0)}°`);
        }
      }
    }
  }
  return { h, held, stops, acceleration };
}

describe('the two-handed heart', () => {
  it.each(HEARTS)('%s holds both arms inside their range', (id) => {
    expect(run(id, true).stops).toEqual([]);
  });

  it.each(HEARTS)('%s holds the hands where the unlimited arm puts them', (id) => {
    const limited = run(id, true).held;
    const free = run(id, false).held;
    for (const side of SIDES) {
      expect(limited[side].distanceTo(free[side]), side).toBeLessThan(0.01);
    }
  });

  it.each(HEARTS)('%s enters, holds and releases without a seam', (id) => {
    expect(run(id, true).acceleration).toBeLessThan(SEAM);
  });
});
