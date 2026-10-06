import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DT, type Harness, harness } from './harness';

/**
 * The camera-tracking share is a target. A performance that drops it, or a
 * caller that changes it, turns the head the way a glance does rather than in
 * one frame.
 */

function headAngle(h: Harness): number {
  const head = h.profile.bones.head;
  if (!head) throw new Error('synthetic rig has no head');
  return head.quaternion.angleTo(h.rig.rest.get(head) ?? new THREE.Quaternion());
}

describe('look-at share', () => {
  it('turns the head toward and away from the camera without a step', () => {
    const h = harness();
    // Off to one side and up, so tracking has something to turn toward.
    const camera = new THREE.Vector3(1.2, 1.9, 2);
    const frame = () => {
      h.rig.reset();
      h.body.update(DT, { headWorldTarget: camera });
      return headAngle(h);
    };
    const seen: number[] = [];
    for (let i = 0; i < 120; i++) seen.push(frame());
    const tracking = seen.at(-1) ?? 0;
    expect(tracking).toBeGreaterThan(0.05);
    h.body.lookAt = 0;
    for (let i = 0; i < 120; i++) seen.push(frame());
    expect(seen.at(-1)).toBeLessThan(tracking * 0.05);
    h.body.lookAt = 1;
    for (let i = 0; i < 120; i++) seen.push(frame());
    const steps = seen.slice(121).map((x, i) => Math.abs(x - seen[120 + i]));
    // A one-frame switch would move the whole tracked angle at once.
    expect(Math.max(...steps)).toBeLessThan(tracking * 0.1);
  });
});
