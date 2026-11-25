import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DT, type Harness, harness } from './harness';

/**
 * The lid follows the eye down, as it does in life: a downward glance against
 * the head asks for some droop, a level or upward one asks for none.
 */

/** A target in front of the head, `drop` metres below it. */
function target(h: Harness, drop: number): THREE.Vector3 {
  const head = h.profile.bones.head;
  if (!head) throw new Error('synthetic rig has no head');
  head.updateWorldMatrix(true, false);
  return head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, -drop, 1.5));
}

function lidAfter(h: Harness, headWorldTarget: THREE.Vector3 | null, frames = 60): number {
  for (let i = 0; i < frames; i++) {
    h.rig.reset();
    h.body.update(DT, { headWorldTarget });
  }
  return h.body.gazeLid;
}

describe('gaze lid', () => {
  it('droops the lids while the eyes look down', () => {
    const h = harness(0, { random: () => 0.5 });
    const lid = lidAfter(h, target(h, 0.9));
    expect(lid).toBeGreaterThan(0.01);
    expect(lid).toBeLessThanOrEqual(0.2);
  });

  it('leaves the lids alone looking level or up', () => {
    const level = harness(0, { random: () => 0.5 });
    expect(lidAfter(level, target(level, 0))).toBeLessThan(1e-6);
    const up = harness(0, { random: () => 0.5 });
    expect(lidAfter(up, target(up, -0.9))).toBe(0);
  });

  it.each([0, -0.1])('asks for nothing when the eye pitch limit is %s', (limit) => {
    const h = harness(0, { random: () => 0.5 });
    h.profile.gaze.eyePitch = limit;
    expect(lidAfter(h, target(h, 0.9))).toBe(0);
  });

  it('asks for nothing on a frame with no eye aim', () => {
    const h = harness(0, { random: () => 0.5 });
    expect(lidAfter(h, target(h, 0.9))).toBeGreaterThan(0.01);
    expect(lidAfter(h, null, 1)).toBe(0);
  });
});
