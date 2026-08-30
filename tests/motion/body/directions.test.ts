import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GESTURES } from '@/engine/motion/gestures';
import type { GestureDef, Side } from '@/engine/types';
import {
  canonicalDirection,
  canonicalHandDirection,
  captureOf,
  copyDirection,
  DT,
  handOrientation,
  harness,
  harnessWithoutBodyFrame,
  type PointCapture,
  settleGesture,
  signedRoll,
  twistGesture,
} from './harness';

/**
 * The frame a pose is authored in, and that it survives the trip to the rig.
 */

describe('character-space arm directions', () => {
  it('keeps authored hand twist mirrored by its axial sign on neutral and turned rigs', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const settled = (yaw: number, twist: number, side: Side) => {
        const h = harness(yaw);
        h.rig.limitsEnabled = false;
        h.rig.reset();
        h.body.update(DT);
        h.body.playDef(twistGesture(twist), `twist.${twist}`);
        for (let i = 0; i < 120; i++) {
          h.rig.reset();
          h.body.update(DT);
        }
        return handOrientation(h, side);
      };

      const neutral = {
        L: settled(0, 0, 'L'),
        R: settled(0, 0, 'R'),
      };
      const neutralTwisted = {
        L: settled(0, 0.7, 'L'),
        R: settled(0, 0.7, 'R'),
      };
      const turned = settled(Math.PI / 2, 0.7, 'R');
      const leftRoll = signedRoll(neutral.L.palm, neutralTwisted.L.palm, neutral.L.axis);
      const rightRoll = signedRoll(neutral.R.palm, neutralTwisted.R.palm, neutral.R.axis);
      const turnedRoll = signedRoll(
        settled(Math.PI / 2, 0, 'R').palm,
        turned.palm,
        settled(Math.PI / 2, 0, 'R').axis,
      );

      // The authored hand twist is axial: its sign is opposite the lateral
      // character mirror, preserving the shipped L=+ / R=- roll convention.
      expect(leftRoll).toBeGreaterThan(0.2);
      expect(rightRoll).toBeLessThan(-0.2);
      expect(leftRoll + rightRoll).toBeCloseTo(0, 2);
      expect(turnedRoll).toBeCloseTo(rightRoll, 2);
    } finally {
      random.mockRestore();
    }
  });

  it('mirrors raw reach elbow angles semantically after a root turn', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const anglesAt = (yaw: number): Record<Side, number | undefined> => {
        const h = harness(yaw);
        const angles: Partial<Record<Side, number>> = {};
        const solveReach = vi
          .spyOn(h.rig, 'solveReach')
          .mockImplementation((side, _target, angle) => {
            angles[side] = angle;
            return null;
          });
        const def: GestureDef = {
          label: { en: 'Raw reach', ja: '到達' },
          group: 'pose',
          sustain: true,
          lead: 0.1,
          hold: 1,
          build: () => ({
            reach: {
              L: { at: 'mouth', elbow: 0.6 },
              R: { at: 'mouth', elbow: 0.6 },
            },
          }),
        };
        h.rig.reset();
        h.body.update(DT);
        h.body.playDef(def, `raw-reach.${yaw}`);
        solveReach.mockClear();
        angles.L = undefined;
        angles.R = undefined;
        h.rig.reset();
        h.body.update(DT);
        solveReach.mockRestore();
        return { L: angles.L, R: angles.R };
      };

      const neutral = anglesAt(0);
      const turned = anglesAt(Math.PI / 2);
      expect(neutral.L).toBeCloseTo(0.6, 10);
      expect(neutral.R).toBeCloseTo(-0.6, 10);
      expect(turned.L).toBeCloseTo(neutral.L ?? 0, 10);
      expect(turned.R).toBeCloseTo(neutral.R ?? 0, 10);
    } finally {
      random.mockRestore();
    }
  });

  it('keeps an absolute point direction unmirrored and normalized without a body frame', () => {
    const h = harnessWithoutBodyFrame();
    const seen: Record<Side, PointCapture | null> = {
      L: null,
      R: null,
    };
    const solvePoint = vi.spyOn(h.rig, 'solvePoint').mockImplementation((side, spec) => {
      const point = copyDirection(spec.point);
      const palm = copyDirection(spec.palm);
      if (point && palm) seen[side] = { point, palm };
      return null;
    });
    const value: [number, number, number] = [0.4, 0.2, 0.8];
    const palm: [number, number, number] = [-0.3, 0.6, -0.7];
    const def: GestureDef = {
      label: { en: 'Absolute point', ja: '絶対指示' },
      group: 'explain',
      sustain: true,
      lead: 0.1,
      hold: 1,
      build: () => ({
        point: {
          L: { point: value, palm, mirror: false },
          R: { point: value, palm, mirror: false },
        },
      }),
    };
    h.rig.reset();
    h.body.update(DT);
    h.body.playDef(def, 'absolute-point');
    solvePoint.mockClear();
    seen.L = null;
    seen.R = null;
    h.rig.reset();
    h.body.update(DT);
    solvePoint.mockRestore();

    const left = captureOf(seen, 'L');
    const right = captureOf(seen, 'R');
    if (!(left && right)) throw new Error('absolute point did not reach the solver');
    expect(left.point.distanceTo(right.point)).toBeLessThan(1e-12);
    expect(left.palm.distanceTo(right.palm)).toBeLessThan(1e-12);
    expect(left.point.length()).toBeCloseTo(1, 12);
    expect(left.palm.length()).toBeCloseTo(1, 12);
  });

  it('mirrors explicit point and palm directions for a normal semantic pose', () => {
    const h = harness();
    const seen: Record<Side, PointCapture | null> = {
      L: null,
      R: null,
    };
    const solvePoint = vi.spyOn(h.rig, 'solvePoint').mockImplementation((side, spec) => {
      const point = copyDirection(spec.point);
      const palm = copyDirection(spec.palm);
      if (point && palm) seen[side] = { point, palm };
      return null;
    });
    const point: [number, number, number] = [0.4, 0.2, 0.8];
    const palm: [number, number, number] = [-0.3, 0.6, -0.7];
    const def: GestureDef = {
      label: { en: 'Mirrored point', ja: '左右指示' },
      group: 'explain',
      sustain: true,
      lead: 0.1,
      hold: 1,
      build: () => ({
        point: {
          L: { point, palm },
          R: { point, palm },
        },
      }),
    };
    h.rig.reset();
    h.body.update(DT);
    h.body.playDef(def, 'mirrored-point');
    solvePoint.mockClear();
    seen.L = null;
    seen.R = null;
    h.rig.reset();
    h.body.update(DT);
    solvePoint.mockRestore();

    const left = captureOf(seen, 'L');
    const right = captureOf(seen, 'R');
    if (!(left && right)) throw new Error('mirrored point did not reach the solver');
    h.rig.anat.update();
    for (const key of ['point', 'palm'] as const) {
      expect(left[key].dot(h.rig.anat.right)).toBeCloseTo(-right[key].dot(h.rig.anat.right), 12);
      expect(left[key].dot(h.rig.anat.up)).toBeCloseTo(right[key].dot(h.rig.anat.up), 12);
      expect(left[key].dot(h.rig.anat.fwd)).toBeCloseTo(right[key].dot(h.rig.anat.fwd), 12);
    }
  });

  it('keeps a direct gesture unchanged in the live body frame when the root turns', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const poses = [0, Math.PI / 2, Math.PI].map((yaw) => {
        const h = harness(yaw);
        settleGesture(h, 'present');
        return [
          canonicalDirection(h, 'R', 'upperArm.R', 'lowerArm.R'),
          canonicalDirection(h, 'R', 'lowerArm.R', 'hand.R'),
          canonicalHandDirection(h, 'R'),
        ];
      });

      for (const pose of poses.slice(1)) {
        for (let i = 0; i < pose.length; i++) {
          expect(pose[i].distanceTo(poses[0][i])).toBeLessThan(1e-8);
        }
      }
    } finally {
      random.mockRestore();
    }
  });

  it('mirrors both arms in the canonical outward frame', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const h = harness(Math.PI / 2);
      settleGesture(h, 'present');
      for (const [parent, child] of [
        ['upperArm', 'lowerArm'],
        ['lowerArm', 'hand'],
      ]) {
        const left = canonicalDirection(h, 'L', `${parent}.L`, `${child}.L`);
        const right = canonicalDirection(h, 'R', `${parent}.R`, `${child}.R`);
        expect(left.distanceTo(right)).toBeLessThan(1e-8);
      }
      expect(
        canonicalHandDirection(h, 'L').distanceTo(canonicalHandDirection(h, 'R')),
      ).toBeLessThan(1e-8);
    } finally {
      random.mockRestore();
    }
  });

  it('keeps a direct-to-reach transition on the same canonical path after a root turn', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const transition = (yaw: number): THREE.Vector3[][] => {
        const h = harness(yaw);
        settleGesture(h, 'present');
        h.body.play('catPaw');
        const samples: THREE.Vector3[][] = [];
        for (let i = 0; i < 20; i++) {
          h.rig.reset();
          h.body.update(DT);
          samples.push([
            canonicalDirection(h, 'R', 'upperArm.R', 'lowerArm.R'),
            canonicalDirection(h, 'R', 'lowerArm.R', 'hand.R'),
            canonicalHandDirection(h, 'R'),
          ]);
        }
        return samples;
      };

      const straight = transition(0);
      const turned = transition(Math.PI / 2);
      for (let frame = 0; frame < straight.length; frame++) {
        for (let slot = 0; slot < straight[frame].length; slot++) {
          expect(straight[frame][slot].distanceTo(turned[frame][slot])).toBeLessThan(1e-8);
        }
      }
    } finally {
      random.mockRestore();
    }
  });

  it('does not mutate a shared authored direction while resolving several frames', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const h = harness(Math.PI / 2);
      const shared = new THREE.Vector3(0.42, -0.78, 0.46).normalize();
      const pose = { arms: { L: { upperArm: shared }, R: { upperArm: shared } } };
      const before = shared.clone();
      h.rig.reset();
      h.body.update(DT);
      h.body.playDef(
        {
          label: { en: 'shared', ja: '共有' },
          group: 'pose',
          lead: 0.1,
          hold: 1,
          build: () => pose,
        },
        'shared',
      );
      for (let i = 0; i < 90; i++) {
        h.rig.reset();
        h.body.update(DT);
      }
      expect(shared.distanceTo(before)).toBeLessThan(1e-12);
    } finally {
      random.mockRestore();
    }
  });

  it('turns the promise ulnar edge toward live body forward', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const edgeForward = (yaw: number, side: Side): number => {
        const h = harness(yaw);
        const base = GESTURES.promise;
        const sign = side === 'R' ? 1 : -1;
        const def: GestureDef = {
          ...base,
          build: (t, v) => base.build(t, { ...v, side: sign }),
        };
        h.rig.reset();
        h.body.update(DT);
        h.body.playDef(def, `promise.${side}.${yaw}`);
        for (let i = 0; i < 180; i++) {
          h.rig.reset();
          h.body.update(DT);
        }

        const index = h.profile.fingerBones[`index.${side}`]?.[0];
        const little = h.profile.fingerBones[`little.${side}`]?.[0];
        if (!(index && little)) throw new Error(`synthetic rig has no ${side} promise fingers`);
        h.profile.root.updateMatrixWorld(true);
        const edge = little
          .getWorldPosition(new THREE.Vector3())
          .sub(index.getWorldPosition(new THREE.Vector3()))
          .normalize();
        h.rig.anat.update();
        return edge.dot(h.rig.anat.fwd);
      };

      for (const yaw of [0, 0.6, -0.6]) {
        for (const side of ['L', 'R'] as const) {
          expect(edgeForward(yaw, side), `promise ${side} yaw ${yaw}`).toBeGreaterThan(0.25);
        }
      }
    } finally {
      random.mockRestore();
    }
  });
});
