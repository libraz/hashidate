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
  it('tracks the same relative bearing when the avatar turns in the room', () => {
    const deltas = [0, Math.PI / 2, Math.PI].map((yaw) => {
      const h = harness(yaw);
      const head = h.profile.bones.head;
      if (!head) throw new Error('synthetic rig has no head');
      h.profile.root.position.set(0.4, 0.2, -0.3);
      h.profile.root.updateMatrixWorld(true);
      const camera = new THREE.Vector3(1.2, 0.35, 2)
        .applyQuaternion(h.profile.root.getWorldQuaternion(new THREE.Quaternion()))
        .add(head.getWorldPosition(new THREE.Vector3()));
      h.rig.reset();
      h.body.update(DT, { headWorldTarget: camera });
      expect(headAngle(h)).toBeGreaterThan(0.05);
      return (['head', 'neck', 'eye.L', 'eye.R'] as const).map((slot) => {
        const bone = h.profile.bones[slot];
        if (!bone) throw new Error(`synthetic rig has no ${slot}`);
        const rest = h.rig.rest.get(bone);
        if (!rest) throw new Error(`synthetic rig has no rest for ${slot}`);
        const delta = rest.clone().invert().multiply(bone.quaternion);
        expect(delta.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.02);
        return delta;
      });
    });
    for (const turned of deltas.slice(1)) {
      for (const [i, q] of turned.entries()) {
        expect(q.angleTo(deltas[0][i])).toBeLessThan(1e-7);
      }
    }
  });

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

/**
 * The bearing to the camera is followed, and a cut re-seeds it. Every
 * placement of the camera is a cut — the picture has already jumped — while
 * the pointer and its damping move it over frames, and only that is followed.
 */
describe('camera cut', () => {
  const A = new THREE.Vector3(-1.2, 1.5, 2);
  const B = new THREE.Vector3(1.4, 1.9, 1.6);

  /** Wander off, so the head shows the bearing and nothing drawn at random. */
  function still(): Harness {
    const h = harness(0, { random: () => 0.5 });
    h.body.gazeAmount = 0;
    return h;
  }

  function step(h: Harness, camera: THREE.Vector3, cameraCut = false): THREE.Quaternion {
    h.rig.reset();
    h.body.update(DT, { headWorldTarget: camera, cameraCut });
    const head = h.profile.bones.head;
    if (!head) throw new Error('synthetic rig has no head');
    return head.quaternion.clone();
  }

  it('lands on the new bearing in the frame of the cut, with no swing after it', () => {
    const cut = still();
    const there = still();
    for (let i = 0; i < 120; i++) {
      step(cut, A);
      step(there, B);
    }
    const before = step(cut, A).angleTo(step(there, B));
    // The two bearings are far enough apart for a swing to show.
    expect(before).toBeGreaterThan(0.05);
    expect(step(cut, B, true).angleTo(step(there, B))).toBeLessThan(1e-6);
    for (let i = 0; i < 60; i++) {
      expect(step(cut, B).angleTo(step(there, B))).toBeLessThan(1e-6);
    }
  });

  it('follows a camera that moves over frames without a step', () => {
    const h = still();
    const settled = still();
    for (let i = 0; i < 120; i++) {
      step(h, A);
      step(settled, B);
    }
    const start = step(h, A);
    step(settled, B);
    const total = start.angleTo(step(settled, B));
    // An orbit from A to B over half a second, then held.
    const camera = new THREE.Vector3();
    let last = start;
    let largest = 0;
    for (let i = 1; i <= 150; i++) {
      camera.lerpVectors(A, B, Math.min(1, i / 30));
      const now = step(h, camera);
      largest = Math.max(largest, now.angleTo(last));
      last = now;
      step(settled, B);
    }
    expect(largest).toBeLessThan(total * 0.1);
    expect(last.angleTo(step(settled, B))).toBeLessThan(total * 0.05);
  });

  it('spreads a jump that did not arrive as a cut over frames', () => {
    const h = still();
    const there = still();
    for (let i = 0; i < 120; i++) {
      step(h, A);
      step(there, B);
    }
    const start = step(h, A);
    const total = start.angleTo(step(there, B));
    const first = step(h, B);
    step(there, B);
    expect(first.angleTo(start)).toBeLessThan(total * 0.1);
  });
});
