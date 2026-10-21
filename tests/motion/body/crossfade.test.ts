import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { FIST, OPEN_HAND } from '@/engine/motion/gestures/hands';
import type { FingerSpec, GestureDef } from '@/engine/types';
import { canonicalDirection, DT, type Harness, harness } from './harness';
import { observeAcceptedHands } from './observe-accepted';

/**
 * How the arms and hands cross from one held pose to the next.
 *
 * The outgoing pose's share has to complement the incoming one's entrance, as
 * the spine's does: a switch between two raised arms that lets the outgoing
 * weight run out on its own clock shows the hanging arm through the gap.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

/** A held pose that raises the right upper arm along `dir` and states nothing else. */
const raised = (dir: THREE.Vector3, lead = 0.4): GestureDef => ({
  label: { en: 'Raised', ja: '挙上' },
  group: 'pose',
  lead,
  hold: 2,
  sustain: true,
  build: () => ({ arms: { R: { upperArm: dir.clone() } } }),
});

const step = (h: Harness) => {
  h.rig.reset();
  h.body.update(DT);
};

const upperArm = (h: Harness) => canonicalDirection(h, 'R', 'upperArm.R', 'lowerArm.R');

/** Test-only view of the outgoing slots, which the layer keeps private. */
const fading = (h: Harness): unknown[] => (h.body as unknown as { _fading: unknown[] })._fading;

describe('arm crossfade', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    h.body.lookAt = 0;
  });

  it('keeps the arm away from rest while one raised pose hands over to another', () => {
    step(h);
    const rest = upperArm(h);
    const forward = V(0.15, 0.25, 0.95);
    const side = V(0.95, 0.25, 0.15);

    h.body.playDef(raised(forward), 'forward');
    for (let i = 0; i < 120; i++) step(h);
    const fromAngle = upperArm(h).angleTo(rest);
    // The pose really is raised, or this pins nothing.
    expect(fromAngle).toBeGreaterThan(1.3);

    h.body.playDef(raised(side), 'side');
    const seen: number[] = [];
    for (let i = 0; i < 120; i++) {
      step(h);
      seen.push(upperArm(h).angleTo(rest));
    }
    const toAngle = seen.at(-1) ?? 0;
    expect(toAngle).toBeGreaterThan(1.3);
    // Both poses sit at the same height and the arc between them only rises,
    // so nothing short of a dip toward rest can take the arm below both.
    expect(Math.min(...seen)).toBeGreaterThan(Math.min(fromAngle, toAngle) - 0.02);
  });

  it('caps the outgoing slots under rapid firing and keeps the arm continuous', () => {
    const dirs = [V(0.15, 0.25, 0.95), V(0.95, 0.25, 0.15), V(0.6, 0.6, 0.5)];
    h.body.playDef(raised(dirs[0]), 'first');
    for (let i = 0; i < 60; i++) step(h);
    let previous = upperArm(h);
    let worst = 0;
    let most = 0;
    for (let i = 0; i < 90; i++) {
      h.body.playDef(raised(dirs[i % dirs.length]), `rapid.${i}`);
      step(h);
      most = Math.max(most, fading(h).length);
      const now = upperArm(h);
      worst = Math.max(worst, now.angleTo(previous));
      previous = now;
    }
    expect(most).toBeLessThanOrEqual(4);
    // Bounded by the arm follower: nothing dropped from the blend snaps the arm.
    expect(worst).toBeLessThan(0.05);
  });
});

describe('finger handover', () => {
  it('does not raise an older pose’s curls when the incoming pose states only a spread', () => {
    const h = harness();
    h.body.lookAt = 0;
    const curls: number[] = [];
    observeAcceptedHands(h, (frame) => {
      curls.push(frame.R.curls.index);
    });
    const shaped = (fingers: typeof FIST, lead: number): GestureDef => ({
      label: { en: 'Shape', ja: '形' },
      group: 'pose',
      lead,
      hold: 2,
      sustain: true,
      build: () => ({ fingers: { R: fingers } }),
    });
    const spread: FingerSpec = { index: 0.2, middle: -0.1 };
    const spreadOnly: GestureDef = {
      label: { en: 'Spread', ja: '開き' },
      group: 'pose',
      lead: 2,
      hold: 2,
      sustain: true,
      build: () => ({ fingerSpread: { R: spread } }),
    };

    h.body.playDef(shaped(FIST, 0.3), 'fist');
    for (let i = 0; i < 90; i++) step(h);
    // A brief open hand: handed over almost at once, at a small weight.
    h.body.playDef(shaped(OPEN_HAND, 0.5), 'open');
    for (let i = 0; i < 8; i++) step(h);
    h.body.playDef(spreadOnly, 'spread');
    const from = curls.length;
    for (let i = 0; i < 90; i++) step(h);

    const after = curls.slice(from);
    let low = after[0];
    let rise = 0;
    for (const c of after) {
      low = Math.min(low, c);
      rise = Math.max(rise, c - low);
    }
    expect(rise).toBeLessThan(0.02);
  });
});
