import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { IdlePosture, type PostureInput } from '@/engine/motion/posture';
import type { Rig } from '@/engine/rig';
import type { Profile } from '@/engine/types';

type Sum = [number, number, number];

/** A rig that only sums what each slot is offset by. */
function recordingRig() {
  const sums = new Map<string, Sum>();
  const rig = {
    addOffset(slot: string, x: number, y: number, z: number) {
      const s = sums.get(slot) ?? [0, 0, 0];
      sums.set(slot, [s[0] + x, s[1] + y, s[2] + z]);
    },
  } as unknown as Rig;
  return { rig, sum: (slot: string): Sum => sums.get(slot) ?? [0, 0, 0] };
}

const profile = { bones: {} } as unknown as Profile;

function headAndChest(t: number, talk: number): { head: Sum; chest: Sum } {
  const { rig, sum } = recordingRig();
  const input: PostureInput = {
    t,
    speaking: talk > 0,
    speechEnergy: talk,
    nod: 0,
    breathPeriod: 4.2,
    breathDepth: 0,
    weightShift: 0,
    idleAmount: 0,
    hipsRest: new THREE.Vector3(),
    hipsRight: new THREE.Vector3(1, 0, 0),
    hipsUp: new THREE.Vector3(0, 1, 0),
    jumpHeight: 0.08,
    rise: 0,
    load: 0,
  };
  new IdlePosture(() => 0.5).apply(rig, profile, 1 / 60, input);
  return { head: sum('head'), chest: sum('chest') };
}

describe('IdlePosture speech head motion', () => {
  it.each([0.7, 3.1, 11.9, 42.3])('carries the slower second term on every axis at t=%s', (t) => {
    const { head, chest } = headAndChest(t, 1);
    expect(head[0]).toBeCloseTo(
      -0.024 * Math.sin(t * 2.31 + 0.5) - 0.007 * Math.sin(t * 0.97 + 2.6),
      12,
    );
    expect(head[1]).toBeCloseTo(0.016 * Math.sin(t * 1.73) + 0.005 * Math.sin(t * 0.83 + 1.1), 12);
    expect(head[2]).toBeCloseTo(
      0.011 * Math.sin(t * 1.29 + 2.0) + 0.003 * Math.sin(t * 0.53 + 0.3),
      12,
    );
    // Breath depth is zero, so the chest's pitch is speech alone.
    expect(chest[0]).toBeCloseTo(
      -0.008 * Math.sin(t * 2.31 + 0.5) - 0.0023 * Math.sin(t * 0.97 + 2.6),
      12,
    );
  });

  it('adds nothing to the head while there is no speech', () => {
    for (const t of [0.7, 3.1, 11.9, 42.3]) {
      const { head } = headAndChest(t, 0);
      for (const axis of head) expect(Math.abs(axis)).toBe(0);
    }
  });
});
