import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { humeralReference, lateralReference } from '@/engine/anatomy/arm-frame';

const EXACT = 1e-9;

const up = new THREE.Vector3(0, 1, 0);
const forward = new THREE.Vector3(0, 0, 1);
const right = new THREE.Vector3(1, 0, 0);

describe('humeral arm frame', () => {
  it('keeps the elbow reference forward on a hanging arm and upright at a forward reach', () => {
    const ref = new THREE.Vector3();
    const hanging = humeralReference(new THREE.Vector3(0, -1, 0), up, forward, ref);
    expect(hanging.distanceTo(forward)).toBeLessThan(EXACT);

    const reaching = humeralReference(forward, up, forward, ref);
    expect(reaching.distanceTo(up)).toBeLessThan(EXACT);
  });

  it('returns an orthonormal bend plane for oblique arm directions', () => {
    const u = new THREE.Vector3(-0.37, 0.42, 0.83).normalize();
    const ref = humeralReference(u, up, forward, new THREE.Vector3());
    const perp = lateralReference(u, ref, up, forward, right.clone().negate(), new THREE.Vector3());

    expect(Math.abs(ref.dot(u))).toBeLessThan(EXACT);
    expect(Math.abs(perp.dot(u))).toBeLessThan(EXACT);
    expect(Math.abs(perp.dot(ref))).toBeLessThan(EXACT);
    expect(Math.abs(ref.length() - 1)).toBeLessThan(EXACT);
    expect(Math.abs(perp.length() - 1)).toBeLessThan(EXACT);
  });

  it('mirrors the perpendicular when the character-facing lateral axis changes sides', () => {
    const u = new THREE.Vector3(0.31, 0.2, 0.93).normalize();
    const ref = humeralReference(u, up, forward, new THREE.Vector3());
    const rightPerp = lateralReference(u, ref, up, forward, right, new THREE.Vector3());
    const leftPerp = lateralReference(
      u,
      ref,
      up,
      forward,
      right.clone().negate(),
      new THREE.Vector3(),
    );

    expect(rightPerp.dot(leftPerp)).toBeCloseTo(-1, 9);
  });
});
