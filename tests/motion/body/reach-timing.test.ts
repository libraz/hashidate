import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReachAnchors } from '@/engine/motion/anchors';
import type { ArmDirections, ArmSlot, GestureDef, ReachSpec, Side } from '@/engine/types';
import { DT, harness, wristOf } from './harness';

type Envelope = { entrance: number; exit: number };
type SideArmEnv = Record<Side, Record<ArmSlot, Envelope>>;
type SideWeights = Record<Side, Record<ArmSlot, number>>;

interface OutgoingView {
  armW: SideWeights;
  armStart: SideWeights;
  wristW: number;
  wristStart: number;
}

interface Observation {
  _reachEntrance: number;
  _armEnv: SideArmEnv;
  _wristEnv: Envelope;
  _handCarried: Record<Side, boolean>;
  _handHandoff: Record<Side, boolean | null>;
  _fading: OutgoingView[];
  _spineFading: unknown[];
  _spare: unknown[];
  _arm: { travelling(side: Side): boolean };
}

const step = (h: ReturnType<typeof harness>): void => {
  h.rig.reset();
  h.body.update(DT);
};

const observe = (h: ReturnType<typeof harness>): Observation => h.body as unknown as Observation;

function directedGesture(sides: readonly Side[], lead = 1): GestureDef {
  return {
    label: { en: 'Directed hand pose', ja: '手の向き' },
    group: 'pose',
    lead,
    hold: 1,
    sustain: true,
    build: () => {
      const arms: Partial<Record<Side, ArmDirections>> = {};
      for (const side of sides) {
        const mirror = side === 'R' ? -1 : 1;
        arms[side] = {
          upperArm: new THREE.Vector3(0.55, mirror * 0.7, 0.4).normalize(),
          lowerArm: new THREE.Vector3(0.25, mirror * 0.2, 0.95).normalize(),
          hand: new THREE.Vector3(0.1, mirror * 0.1, 0.98).normalize(),
          palm: new THREE.Vector3(0, 1, 0),
          twist: 0.3,
        };
      }
      return { arms };
    },
  };
}

function reachGesture(side: Side): GestureDef {
  const reach: ReachSpec = {
    at: 'cheek',
    space: 'face',
    offset: [0.4, -0.45, 0.8],
    hand: [-0.4, 0.8, -0.45],
    palm: [-0.69, 0.41, -0.73],
    pole: [0.26, -0.92, 0.3],
  };
  return {
    label: { en: 'Carried reach', ja: '運ぶリーチ' },
    group: 'pose',
    lead: 0.6,
    hold: 1,
    sustain: true,
    build: () => ({ reach: { [side]: reach } }),
  };
}

/** Observe the target interpolation itself, before the constrained arm solve. */
function observeTravel(h: ReturnType<typeof harness>, frames: number): number[] {
  const travel = vi.spyOn(ReachAnchors.prototype, 'travel');
  travel.mockClear();
  for (let i = 0; i < frames; i++) step(h);
  return travel.mock.calls.map((call) => call[3]);
}

afterEach(() => vi.restoreAllMocks());

describe('reach travel timing', () => {
  it('carries a single wrist target monotonically through the full entrance', () => {
    const h = harness();
    h.body.idleAmount = 0;
    step(h); // The resolver marks the actual wrist as the departure point.
    h.body.play('chin', 'R');
    const lead = h.body.gesture?.lead;
    if (lead === undefined) throw new Error('chin did not start');

    const progress = observeTravel(h, Math.ceil(lead / DT));
    expect(progress.length).toBeGreaterThan(Math.floor((lead * 0.8) / DT));
    expect(progress.at(-1)).toBeGreaterThan(0.999);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
      expect(progress[i]).toBeLessThanOrEqual(1);
    }

    const increments = progress.slice(1).map((value, i) => value - progress[i]);
    const peak = Math.max(...increments);
    expect(increments.at(-1)).toBeLessThan(peak * 0.1);
  });

  it('keeps the actual wrist moving through the late part of its reach', () => {
    const h = harness();
    h.body.idleAmount = 0;
    step(h);
    h.body.play('chin', 'R');
    const lead = h.body.gesture?.lead;
    if (lead === undefined) throw new Error('chin did not start');

    const start = wristOf(h.profile, 'R');
    const wrists: THREE.Vector3[] = [];
    for (let frame = 0; frame < Math.ceil(lead / DT); frame++) {
      step(h);
      wrists.push(wristOf(h.profile, 'R'));
    }

    const atEighty = wrists[Math.floor((lead * 0.8) / DT) - 1];
    const last = wrists.at(-1);
    if (!(atEighty && last)) throw new Error('chin travel produced too few wrist samples');
    const total = start.distanceTo(last);
    expect(total).toBeGreaterThan(0.03);
    expect(atEighty.distanceTo(last)).toBeGreaterThan(total * 0.03);
    expect(wrists.at(-1)?.distanceTo(wrists.at(-2) ?? last)).toBeLessThan(0.01);
  });

  it('uses the same monotone travel clock for both clasped wrists', () => {
    const h = harness();
    h.body.idleAmount = 0;
    step(h);
    h.body.play('handsClasp', 'R');
    const lead = h.body.gesture?.lead;
    if (lead === undefined) throw new Error('handsClasp did not start');

    const progress = observeTravel(h, Math.ceil(lead / DT));
    expect(progress.length).toBeGreaterThan(Math.floor((lead * 0.8) / DT));
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
      expect(progress[i]).toBeLessThanOrEqual(1);
    }
  });

  it('freezes reach travel at the entrance reached when stopped', () => {
    const h = harness();
    h.body.idleAmount = 0;
    step(h);
    h.body.play('chin', 'R');
    for (let i = 0; i < 12; i++) step(h);

    const travel = vi.spyOn(ReachAnchors.prototype, 'travel');
    step(h);
    const frozen = travel.mock.calls.at(-1)?.[3];
    if (frozen === undefined) throw new Error('chin had no in-progress wrist travel');

    h.body.stopGesture();
    const afterStop = observeTravel(h, 12);
    expect(afterStop.length).toBeGreaterThan(0);
    for (const progress of afterStop) expect(progress).toBeCloseTo(frozen, 12);
  });

  it('pairs a carried hand with its outgoing share per side, keeping authored direction timing', () => {
    const h = harness();
    h.body.idleAmount = 0;
    step(h);
    const source: GestureDef = {
      label: { en: 'Source', ja: '出発姿勢' },
      group: 'pose',
      lead: 0.2,
      hold: 1,
      sustain: true,
      build: () => ({
        arms: {
          L: {
            upperArm: new THREE.Vector3(0.55, -0.7, 0.4).normalize(),
            lowerArm: new THREE.Vector3(0.25, -0.2, 0.95).normalize(),
            hand: new THREE.Vector3(0.1, 0.1, 0.98).normalize(),
            palm: new THREE.Vector3(0, 1, 0),
          },
          R: {
            upperArm: new THREE.Vector3(0.55, -0.7, 0.4).normalize(),
            lowerArm: new THREE.Vector3(0.25, -0.2, 0.95).normalize(),
            hand: new THREE.Vector3(0.1, 0.1, 0.98).normalize(),
            palm: new THREE.Vector3(0, 1, 0),
          },
        },
      }),
    };
    h.body.playDef(source, 'source');
    for (let i = 0; i < 60; i++) step(h);

    const mixed: GestureDef = {
      label: { en: 'Mixed reach and direction', ja: '左右別の動き' },
      group: 'pose',
      lead: 0.6,
      hold: 1,
      sustain: true,
      build: () => ({
        reach: {
          R: {
            at: 'cheek',
            space: 'face',
            offset: [0.4, -0.45, 0.8],
            hand: [-0.4, 0.8, -0.45],
            palm: [-0.69, 0.41, -0.73],
            pole: [0.26, -0.92, 0.3],
          },
        },
        arms: {
          L: {
            upperArm: new THREE.Vector3(0.5, 0.6, 0.6).normalize(),
            lowerArm: new THREE.Vector3(0.2, 0.5, 0.8).normalize(),
            hand: new THREE.Vector3(-0.2, 0.5, 0.8).normalize(),
            palm: new THREE.Vector3(0, 1, 0),
            twist: 0.3,
          },
        },
      }),
    };
    h.body.playDef(mixed, 'mixed');
    const seen = observe(h);
    const lead = h.body.gesture?.lead;
    if (lead === undefined) throw new Error('mixed reach did not start');
    let leftOvershoot = false;
    for (let i = 0; i < Math.ceil(lead / DT); i++) {
      step(h);
      expect(seen._handCarried.R).toBe(true);
      expect(seen._handCarried.L).toBe(false);
      const rightCurrent = seen._armEnv.R.hand.entrance * seen._armEnv.R.hand.exit;
      const rightOutgoing = seen._fading.reduce((sum, f) => sum + f.armW.R.hand, 0);
      expect(rightCurrent + rightOutgoing).toBeCloseTo(1, 12);
      const leftCurrent = seen._armEnv.L.hand.entrance * seen._armEnv.L.hand.exit;
      const leftOutgoing = seen._fading.reduce((sum, f) => sum + f.armW.L.hand, 0);
      if (leftCurrent > 1.001) {
        leftOvershoot = true;
        expect(leftCurrent + leftOutgoing).toBeGreaterThan(1.001);
      }
      if (i === Math.floor((lead * 0.84) / DT)) {
        const rightSnapshot = Math.min(1, rightCurrent);
        const leftSnapshot = Math.min(1, leftCurrent);
        const wristSnapshot = Math.min(1, seen._wristEnv.entrance * seen._wristEnv.exit);
        expect(Math.abs(rightSnapshot - leftSnapshot)).toBeGreaterThan(0.01);
        expect(Math.abs(rightSnapshot - wristSnapshot)).toBeGreaterThan(0.01);
        h.body.playDef(source, 'interrupt-mixed-reach');
        const snapshot = seen._fading.at(-1);
        if (!snapshot) throw new Error('mixed reach was not handed off');
        expect(snapshot.armStart.R.hand).toBeCloseTo(rightSnapshot, 12);
        expect(snapshot.armStart.L.hand).toBeCloseTo(leftSnapshot, 12);
        expect(snapshot.wristStart).toBeCloseTo(wristSnapshot, 12);
        break;
      }
    }
    expect(leftOvershoot).toBe(true);
  });

  it('enables hand timing for a tiny positive same-side orientation handoff', () => {
    const h = harness();
    h.body.idleAmount = 0;
    step(h);
    const seen = observe(h);
    h.body.playDef(directedGesture(['R']), 'partial-source');
    for (let i = 0; i < 13; i++) step(h);
    const partial = seen._armEnv.R.hand.entrance * seen._armEnv.R.hand.exit;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(0.01);

    h.body.playDef(reachGesture('R'), 'partial-reach');
    expect(seen._fading.at(-1)?.armStart.R.hand).toBeCloseTo(partial, 12);
    expect(seen._fading.at(-1)?.wristStart).toBeCloseTo(partial, 12);
    step(h);
    expect(seen._handHandoff.R).toBe(true);
    expect(seen._handCarried.R).toBe(true);
    for (let i = 0; i < 12; i++) step(h);
    expect(seen._armEnv.R.hand.entrance).toBeCloseTo(seen._reachEntrance, 12);
    expect(seen._wristEnv.entrance).not.toBeCloseTo(seen._reachEntrance, 5);
  });

  it('does not enable same-side hand timing from a head-only or opposite-side handoff', () => {
    const head = harness();
    head.body.idleAmount = 0;
    step(head);
    const headSeen = observe(head);
    const headOnly: GestureDef = {
      label: { en: 'Head only', ja: '頭のみ' },
      group: 'pose',
      lead: 1,
      hold: 1,
      sustain: true,
      build: () => ({ spine: { head: [0.02, 0, 0] } }),
    };
    head.body.playDef(headOnly, 'head-only');
    for (let i = 0; i < 20; i++) step(head);
    expect(headSeen._armEnv.R.hand.entrance).toBeGreaterThan(0);
    head.body.playDef(reachGesture('R'), 'head-to-reach');
    step(head);
    expect(headSeen._handHandoff.R).toBe(false);
    expect(headSeen._handCarried.R).toBe(false);
    for (let i = 0; i < 12; i++) step(head);
    expect(headSeen._armEnv.R.hand.entrance).not.toBeCloseTo(headSeen._reachEntrance, 5);

    const opposite = harness();
    opposite.body.idleAmount = 0;
    step(opposite);
    const oppositeSeen = observe(opposite);
    opposite.body.playDef(directedGesture(['L']), 'left-only');
    for (let i = 0; i < 30; i++) step(opposite);
    opposite.body.playDef(reachGesture('R'), 'right-reach');
    step(opposite);
    expect(oppositeSeen._handHandoff.R).toBe(false);
    expect(oppositeSeen._handCarried.R).toBe(false);
    expect(oppositeSeen._handHandoff.L).toBe(true);
    for (let i = 0; i < 12; i++) step(opposite);
    expect(oppositeSeen._armEnv.R.hand.entrance).not.toBeCloseTo(oppositeSeen._reachEntrance, 5);
  });

  it('freezes a clasp follower hand phase on release while its resolver freezes', () => {
    const h = harness();
    h.body.idleAmount = 0;
    step(h);
    h.body.playDef(directedGesture(['L', 'R']), 'bilateral-source');
    for (let i = 0; i < 90; i++) step(h);
    h.body.play('handsClasp', 'R');
    for (let i = 0; i < 12; i++) step(h);
    const seen = observe(h);
    expect(seen._handHandoff.L).toBe(true);
    expect(seen._handHandoff.R).toBe(true);
    expect(seen._handCarried.L).toBe(true);
    const traveling = seen._reachEntrance;
    const outgoingBefore = seen._fading.reduce((sum, f) => sum + f.armW.R.hand, 0);
    const wristPhase = seen._wristEnv.entrance;
    const outgoingWristBefore = seen._fading.reduce((sum, f) => sum + f.wristW, 0);

    h.body.stopGesture();
    step(h);
    expect(seen._arm.travelling('L')).toBe(false);
    expect(seen._handCarried.L).toBe(true);
    expect(seen._reachEntrance).toBeCloseTo(traveling, 12);
    expect(seen._armEnv.L.hand.entrance).toBeCloseTo(traveling, 12);
    expect(seen._wristEnv.entrance).toBeCloseTo(wristPhase, 12);
    const outgoingAfter = seen._fading.reduce((sum, f) => sum + f.armW.R.hand, 0);
    expect(outgoingAfter).toBeLessThan(outgoingBefore);
    const outgoingWristAfter = seen._fading.reduce((sum, f) => sum + f.wristW, 0);
    expect(outgoingWristAfter).toBeLessThan(outgoingWristBefore);
    for (let i = 0; i < 180; i++) step(h);
    expect(seen._fading).toHaveLength(0);
  });

  it('preserves both side shares through repeated interruption and retires capped slots', () => {
    const h = harness();
    h.body.idleAmount = 0;
    step(h);
    const pose: GestureDef = {
      label: { en: 'Two arm pose', ja: '両腕の姿勢' },
      group: 'pose',
      lead: 0.35,
      hold: 1,
      sustain: true,
      build: () => ({
        arms: {
          L: {
            upperArm: new THREE.Vector3(0.5, 0.6, 0.6).normalize(),
            lowerArm: new THREE.Vector3(0.2, 0.5, 0.8).normalize(),
            hand: new THREE.Vector3(-0.2, 0.5, 0.8).normalize(),
            palm: new THREE.Vector3(0, 1, 0),
          },
          R: {
            upperArm: new THREE.Vector3(0.5, -0.6, 0.6).normalize(),
            lowerArm: new THREE.Vector3(0.2, -0.5, 0.8).normalize(),
            hand: new THREE.Vector3(-0.2, -0.5, 0.8).normalize(),
            palm: new THREE.Vector3(0, 1, 0),
          },
        },
      }),
    };
    const seen = observe(h);
    h.body.playDef(pose, 'pose.0');
    for (let i = 0; i < 60; i++) step(h);

    let folded = 0;
    for (let i = 1; i <= 7; i++) {
      const previousCount = seen._fading.length;
      const beforeWristPool =
        seen._fading.reduce((sum, f) => sum + f.wristW, 0) +
        seen._wristEnv.entrance * seen._wristEnv.exit;
      const willFold = previousCount >= 4 && h.body.blend > 0;
      h.body.playDef(pose, `pose.${i}`);
      if (willFold) {
        folded++;
        const wristPool = seen._fading.reduce((sum, f) => sum + f.wristStart, 0);
        expect(wristPool).toBeCloseTo(beforeWristPool, 8);
      }
      step(h);
      if (i === 1) {
        h.body.playDef(pose, 'pose.repeated');
        step(h);
      }
      for (let frame = 0; frame < 5; frame++) step(h);
      expect(seen._fading.length).toBeLessThanOrEqual(4);
      expect(new Set(seen._fading).size).toBe(seen._fading.length);
      for (const f of seen._fading) {
        for (const side of ['L', 'R'] as const) {
          expect(f.armW[side].hand).toBeGreaterThanOrEqual(0);
          expect(f.armW[side].hand).toBeLessThanOrEqual(1);
          expect(f.armStart[side].hand).toBeGreaterThanOrEqual(0);
          expect(f.armStart[side].hand).toBeLessThanOrEqual(1);
        }
        expect(f.wristW).toBeGreaterThanOrEqual(0);
        expect(f.wristW).toBeLessThanOrEqual(1);
        expect(f.wristStart).toBeGreaterThanOrEqual(0);
        expect(f.wristStart).toBeLessThanOrEqual(1);
      }
    }
    expect(folded).toBeGreaterThan(0);

    h.body.playDef({ ...pose, build: () => ({}) }, 'rest');
    for (let i = 0; i < 240; i++) step(h);
    expect(seen._fading).toHaveLength(0);
    expect(seen._spineFading).toHaveLength(0);
    expect(new Set(seen._spare).size).toBe(seen._spare.length);
  });
});
