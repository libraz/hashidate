import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { HOPS, LEAD_MAX, planJump, sampleJump } from '@/engine/motion/jump';
import type { BoneSlot } from '@/engine/types';
import { DT, type Harness, harness } from './harness';

const UP = new THREE.Vector3(0, 1, 0);
const SIDES = ['L', 'R'] as const;

function bone(h: Harness, slot: BoneSlot): THREE.Bone {
  const b = h.profile.bones[slot];
  if (!b) throw new Error(`synthetic rig has no ${slot}`);
  return b;
}

function world(h: Harness, slot: BoneSlot): THREE.Vector3 {
  h.profile.root.updateMatrixWorld(true);
  return bone(h, slot).getWorldPosition(new THREE.Vector3());
}

function worldQ(h: Harness, slot: BoneSlot): THREE.Quaternion {
  h.profile.root.updateMatrixWorld(true);
  return bone(h, slot).getWorldQuaternion(new THREE.Quaternion());
}

/** The hips' yaw about world up relative to `rest`, radians in (-pi, pi]. */
function yawOf(q: THREE.Quaternion, rest: THREE.Quaternion): number {
  const d = q.clone().multiply(rest.clone().invert());
  return 2 * Math.atan2(d.y, d.w);
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function step(h: Harness): void {
  h.rig.reset();
  h.body.update(DT);
}

function legged(): Harness {
  const h = harness(0, {}, { legs: true });
  step(h);
  step(h);
  return h;
}

/** Flat snapshot of every bone's local pose, for frame-by-frame comparison. */
function snapshot(h: Harness): number[] {
  const out: number[] = [];
  for (const b of Object.values(h.profile.bones)) {
    if (b) out.push(...b.position.toArray(), ...b.quaternion.toArray());
  }
  return out;
}

describe('a spinning hop on a standing rig', () => {
  const spin = HOPS.spin;
  const arc = planJump(spin.height, 9.81, spin.count, spin.turn);

  it('keeps the feet on their marks while planted, rotated about the stance centre', () => {
    const h = legged();
    const rest = SIDES.map((s) => world(h, `foot.${s}`));
    const pivot = rest[0].clone().add(rest[1]).multiplyScalar(0.5);
    pivot.y = 0;
    h.body.hop(spin);
    let checked = 0;
    let worst = 0;
    for (let i = 1; i < 300; i++) {
      step(h);
      if (!h.body.jumping) break;
      const t = i * DT;
      const s = sampleJump(arc, t);
      if (s.done || s.rise > 1e-6 || t < 0.05) continue;
      const k = Math.round(s.yaw / arc.turn);
      if (Math.abs(s.yaw - k * arc.turn) > 1e-9) continue;
      SIDES.forEach((side, j) => {
        const expected = rest[j]
          .clone()
          .sub(pivot)
          .applyAxisAngle(UP, k * arc.turn)
          .add(pivot);
        expected.y = rest[j].y;
        const got = world(h, `foot.${side}`);
        got.y = rest[j].y;
        worst = Math.max(worst, got.distanceTo(expected));
      });
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
    expect(worst).toBeLessThan(1e-3);
  });

  it('ends facing front with the hips back at rest', () => {
    const h = legged();
    const restQ = worldQ(h, 'hips');
    const restP = world(h, 'hips');
    h.body.hop(spin);
    for (let i = 0; i < 400; i++) step(h);
    expect(h.body.jumping).toBe(false);
    expect(worldQ(h, 'hips').angleTo(restQ)).toBeLessThan(1e-6);
    expect(world(h, 'hips').distanceTo(restP)).toBeLessThan(1e-6);
    for (const side of SIDES) {
      const rest = world(legged(), `foot.${side}`);
      expect(world(h, `foot.${side}`).distanceTo(rest)).toBeLessThan(1e-6);
    }
  });

  it('turns the hips through a full revolution without a step or a reversal', () => {
    const h = legged();
    const restQ = worldQ(h, 'hips');
    h.body.hop(spin);
    let prev = 0;
    let total = 0;
    let maxStep = 0;
    for (let i = 0; i < 300; i++) {
      step(h);
      const yaw = yawOf(worldQ(h, 'hips'), restQ);
      const d = wrap(yaw - prev);
      prev = yaw;
      total += d;
      maxStep = Math.max(maxStep, Math.abs(d));
      expect(d).toBeGreaterThan(-1e-9);
    }
    expect(total).toBeCloseTo(2 * Math.PI, 6);
    // The step the arc was sized for: under 11 degrees at 60 Hz.
    expect(maxStep).toBeLessThan((11 * Math.PI) / 180);
  });

  it('leads with the trunk, off the hips, and lands aligned', () => {
    const h = legged();
    const restHips = worldQ(h, 'hips');
    const restChest = worldQ(h, 'chest');
    h.body.hop(spin);
    let peak = 0;
    let worstHips = 0;
    let worstLanding = 0;
    for (let i = 1; i < 200; i++) {
      step(h);
      const t = i * DT;
      const s = sampleJump(arc, t);
      if (s.done) break;
      const hipsYaw = yawOf(worldQ(h, 'hips'), restHips);
      // The hips carry the rigid track alone: the lead never reaches them.
      worstHips = Math.max(worstHips, Math.abs(wrap(hipsYaw - s.yaw)));
      const lead = wrap(yawOf(worldQ(h, 'chest'), restChest) - hipsYaw);
      peak = Math.max(peak, lead);
      if (s.lead === 0) worstLanding = Math.max(worstLanding, Math.abs(lead));
    }
    expect(worstHips).toBeLessThan(1e-6);
    expect(peak).toBeGreaterThan(0.9 * LEAD_MAX);
    expect(peak).toBeLessThan(1.1 * LEAD_MAX);
    expect(worstLanding).toBeLessThan(0.02);
  });

  it('still closes when finished early', () => {
    const h = legged();
    const restQ = worldQ(h, 'hips');
    h.body.hop(spin);
    for (let i = 0; i < 20; i++) step(h);
    h.body.finishHop();
    let prev = 0;
    let total = 0;
    for (let i = 0; i < 400; i++) {
      step(h);
      const yaw = yawOf(worldQ(h, 'hips'), restQ);
      total += wrap(yaw - prev);
      prev = yaw;
    }
    expect(h.body.jumping).toBe(false);
    expect(total).toBeCloseTo(2 * Math.PI, 6);
    expect(worldQ(h, 'hips').angleTo(restQ)).toBeLessThan(1e-6);
  });
});

describe('a plain hop on a standing rig', () => {
  it.each(['hop', 'bounce', 'leap'] as const)('%s never yaws the skeleton or the trunk', (id) => {
    const h = legged();
    const restQ = worldQ(h, 'hips');
    const plant = vi.spyOn(h.rig, 'plantLegs');
    h.body.hop(HOPS[id]);
    for (let i = 0; i < 200; i++) {
      step(h);
      expect(yawOf(worldQ(h, 'hips'), restQ)).toBeLessThan(1e-9);
    }
    expect(plant).toHaveBeenCalled();
    for (const call of plant.mock.calls) expect(call[1] ?? 0).toBe(0);
  });

  it.each(['hop', 'bounce', 'leap'] as const)(
    '%s runs the same with an explicit zero turn',
    (id) => {
      const a = legged();
      const b = legged();
      a.body.hop(HOPS[id]);
      b.body.hop({ ...HOPS[id], turn: 0 });
      for (let i = 0; i < 200; i++) {
        step(a);
        step(b);
        expect(snapshot(b)).toEqual(snapshot(a));
      }
    },
  );
});
