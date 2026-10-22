import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Gaze } from '@/engine/motion/gaze';
import { makeGazeFrame, prepareGaze, WHIP_T } from '@/engine/motion/look';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { buildRig } from '../helpers/scene';

const DT = 1 / 60;

function fixture() {
  const built = buildRig({ eyes: true });
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const head = profile.bones.head;
  if (!head) throw new Error('synthetic rig has no head');
  const headAt = head.getWorldPosition(new THREE.Vector3());
  const gaze = new Gaze({ random: () => 0.5 });
  const frame = makeGazeFrame();
  const target = (bearing: number) =>
    headAt.clone().add(new THREE.Vector3(Math.sin(bearing), 0, Math.cos(bearing)));
  /** One frame; returns the head yaw offset and the eye yaw the frame asked for. */
  const step = (bearing: number, bodyYaw?: number, cut = false) => {
    rig.reset();
    const args: unknown[] = [
      rig,
      profile,
      gaze,
      { lookAt: 1, gazeAmount: 0 },
      target(bearing),
      frame,
      DT,
      cut,
    ];
    if (bodyYaw !== undefined) args.push(bodyYaw);
    Reflect.apply(prepareGaze, undefined, args);
    const euler = new THREE.Euler().setFromQuaternion(frame.gazeHead, 'XYZ');
    return { head: euler.y, eye: frame.eyeYaw };
  };
  return { profile, frame, step };
}

describe('bodyYaw of zero', () => {
  it('leaves every camera bearing exactly as it was', () => {
    const plain = fixture();
    const zero = fixture();
    for (let i = 0; i <= 240; i++) {
      const bearing = -Math.PI + (2 * Math.PI * i) / 240;
      expect(zero.step(bearing, 0)).toEqual(plain.step(bearing));
    }
    expect(zero.frame.whip).toBeNull();
  });
});

describe('a body turning one revolution under a camera in front', () => {
  const sweep = () => {
    const h = fixture();
    const limit = h.profile.gaze;
    const rows: Array<{ yaw: number; head: number; eye: number; whipping: boolean }> = [];
    let whips = 0;
    let wasWhipping = false;
    h.step(0, 0);
    for (let i = 1; i <= 120; i++) {
      const yaw = (2 * Math.PI * i) / 120;
      const out = h.step(0, yaw === 2 * Math.PI ? 0 : yaw);
      const whipping = h.frame.whip !== null;
      if (whipping && !wasWhipping) whips += 1;
      wasWhipping = whipping;
      rows.push({ yaw, ...out, whipping });
    }
    return { rows, whips, limit };
  };

  it('whips exactly once', () => {
    expect(sweep().whips).toBe(1);
  });

  it('spreads the head crossing over the whip instead of one frame', () => {
    const { rows, limit } = sweep();
    const swing = 2 * (limit.headYaw + limit.neckYaw);
    // Unclamped, the bridge sweeps the bearing 2*pi at a minimum-jerk peak of 1.875 times its
    // mean, and head plus neck follow it at their 0.28 + 0.16 shares.
    const bound = ((1.875 * 2 * Math.PI) / (WHIP_T / DT)) * (0.28 + 0.16) + 1e-9;
    let previous = 0;
    let peak = 0;
    for (const r of rows) {
      peak = Math.max(peak, Math.abs(r.head - previous));
      previous = r.head;
    }
    expect(peak).toBeLessThanOrEqual(bound);
    expect(peak).toBeLessThan(swing / 2);
  });

  it('pins the head and eyes at their limits from 135 degrees until the whip', () => {
    const { rows, limit } = sweep();
    const start = rows.findIndex((r) => r.yaw >= (3 * Math.PI) / 4);
    const whip = rows.findIndex((r) => r.whipping);
    expect(whip).toBeGreaterThan(start);
    for (const r of rows.slice(start, whip)) {
      expect(r.head).toBeCloseTo(-(limit.headYaw + limit.neckYaw), 6);
      expect(Math.abs(r.eye)).toBeGreaterThanOrEqual(limit.eyeYaw);
    }
  });

  it('is back on the camera when the revolution closes', () => {
    const { rows } = sweep();
    expect(rows.at(-1)?.head).toBeCloseTo(0, 6);
  });
});

describe('a cut', () => {
  it('ends a whip in progress', () => {
    const h = fixture();
    h.step(0, 0);
    let yaw = 0;
    while (h.frame.whip === null && yaw < 2 * Math.PI) {
      yaw += 0.15;
      h.step(0, yaw);
    }
    expect(h.frame.whip).not.toBeNull();
    h.step(0, yaw, true);
    expect(h.frame.whip).toBeNull();
  });
});
