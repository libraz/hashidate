import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMotions, loadMotions, type MotionDef } from '@/engine/motion';
import type { GestureDef } from '@/engine/types';
import { DT, type Harness, harness } from './harness';

/**
 * A loaded motion may state `lead: 0`, and a spine-only one has no arm travel
 * to stretch it. Spine offsets have no follower, so whatever the envelope does
 * is what the torso does: a zero lead is a one-frame snap in and out.
 */

const spineOnly = (chest: [number, number, number]): MotionDef => ({
  id: 'spineOnly',
  label: { en: 'Spine only', ja: '背骨だけ' },
  group: 'pose',
  lead: 0,
  hold: 0.3,
  frames: [{ at: 0, spine: { chest } }],
});

const lead = (h: Harness): number => h.body.gesture?.lead ?? Number.NaN;

function chestAngle(h: Harness): number {
  const chest = h.profile.bones.chest;
  if (!chest) throw new Error('synthetic rig has no chest');
  return chest.quaternion.angleTo(h.rig.rest.get(chest) ?? new THREE.Quaternion());
}

afterEach(() => {
  clearMotions();
});

describe('entrance floor', () => {
  it('never plays a zero-length entrance or exit', () => {
    const h = harness();
    loadMotions([spineOnly([0.25, 0, 0])]);
    h.rig.reset();
    h.body.update(DT);
    h.body.play('spineOnly');
    expect(lead(h)).toBeGreaterThan(0);

    const angles: number[] = [];
    for (let i = 0; i < 90; i++) {
      h.rig.reset();
      h.body.update(DT);
      angles.push(chestAngle(h));
    }
    const peak = Math.max(...angles);
    expect(peak).toBeGreaterThan(0.2);
    const steps = angles.map((a, i) => Math.abs(a - (i === 0 ? 0 : angles[i - 1])));
    // In and out alike: no single frame carries a third of the pose.
    expect(Math.max(...steps)).toBeLessThan(peak / 3);
  });

  it('stretches the entrance for a long spine travel, as it does for an arm', () => {
    const small = harness();
    const large = harness();
    loadMotions([spineOnly([0.05, 0, 0])]);
    small.rig.reset();
    small.body.update(DT);
    small.body.play('spineOnly');
    loadMotions([spineOnly([0, 1.2, 0])]);
    large.rig.reset();
    large.body.update(DT);
    large.body.play('spineOnly');
    expect(lead(large)).toBeGreaterThan(lead(small));
  });
});

describe('spine travel from the displayed handoff', () => {
  it('sizes a nested entrance from the weighted outgoing pose rather than rest or either endpoint', () => {
    const h = harness();
    h.rig.limitsEnabled = false;
    h.body.lookAt = 0;
    const pose = (pitch: number, authoredLead: number): GestureDef => ({
      label: { en: 'Head pose', ja: '頭のポーズ' },
      group: 'pose',
      lead: authoredLead,
      hold: 2,
      sustain: true,
      build: () => ({ spine: { head: [pitch, 0, 0] } }),
    });
    const advance = (frames: number) => {
      for (let frame = 0; frame < frames; frame++) {
        h.rig.reset();
        h.body.update(DT);
      }
    };
    const head = h.profile.bones.head;
    if (!head) throw new Error('missing head');
    h.body.playDef(pose(0.8, 0.4), 'first');
    advance(60);
    h.body.playDef(pose(-0.4, 0.4), 'second');
    advance(12); // Halfway through the authored 0.4 s complementary fade.
    const rest = h.rig.rest.get(head);
    if (!rest) throw new Error('missing head rest');
    const offset = head.quaternion.clone().multiply(rest.clone().invert());
    const displayedPitch = new THREE.Euler().setFromQuaternion(offset, 'XYZ').x;
    expect(displayedPitch).toBeCloseTo(0.2, 10);
    h.body.playDef(pose(0.9, 0), 'third');
    expect(lead(h)).toBeCloseTo(Math.abs(0.9 - displayedPitch) * 0.32, 10);
    expect(lead(h)).toBeGreaterThan(0.12);
  });
});
