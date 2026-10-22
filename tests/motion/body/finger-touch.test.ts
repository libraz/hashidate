import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FINGER_WIDTH } from '@/engine/anatomy';
import { gestureDef } from '@/engine/motion';
import { FINGER_TIP_EXTENSION } from '@/engine/rig/hand-geometry';
import type { GestureDef, Side } from '@/engine/types';
import { DT, type Harness, harness, wristOf } from './harness';

/**
 * The fingertips-together gesture: the two index tips meet at the midline in
 * front of the chin and tap, parting a little and always returning to contact.
 */

const FRAMES = 360;
/** The frames between the entrance settling and the exit starting. */
const HOLD = { from: 80, to: 180 };
/** The tips may part by no more than this while tapping, metres. */
const MAX_PART = 0.03;
/** A tip within this of the other counts as touching; a gap wider than `PARTED` counts as apart. */
const PARTED = 0.008;

/** The index fingertip as the engine estimates it: the last bone carried on. */
function tipOf(h: Harness, side: Side): THREE.Vector3 {
  const chain = h.profile.fingerBones[`index.${side}`];
  if (!chain || chain.length < 3) throw new Error('synthetic rig has no index chain');
  const at = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3());
  const prev = at(chain[chain.length - 2]);
  const last = at(chain[chain.length - 1]);
  return last.clone().addScaledVector(last.clone().sub(prev), FINGER_TIP_EXTENSION);
}

/** Finger thickness, metres: the knuckle pitch scaled by the engine's finger width. */
function fingerThickness(h: Harness): number {
  const at = (side: Side, f: 'index' | 'middle') =>
    (h.profile.fingerBones[`${f}.${side}`]?.[0] as THREE.Object3D)?.getWorldPosition(
      new THREE.Vector3(),
    );
  return FINGER_WIDTH * at('R', 'index').distanceTo(at('R', 'middle'));
}

interface Frame {
  gap: number;
  /** Midpoint of the tips, in the body frame: right, up, forward, metres from the chest origin. */
  mid: THREE.Vector3;
  /** Each tip's distance from the midline plane, metres. */
  off: number;
  wrists: Record<Side, THREE.Vector3>;
}

function sample(h: Harness): Frame {
  const l = tipOf(h, 'L');
  const r = tipOf(h, 'R');
  const a = h.rig.anat;
  a.update();
  const mid = l.clone().add(r).multiplyScalar(0.5).sub(a.axisO);
  return {
    gap: l.distanceTo(r),
    mid: new THREE.Vector3(mid.dot(a.right), mid.dot(a.up), mid.dot(a.fwd)),
    off: Math.max(
      Math.abs(l.clone().sub(a.axisO).dot(a.right)),
      Math.abs(r.clone().sub(a.axisO).dot(a.right)),
    ),
    wrists: { L: wristOf(h.profile, 'L'), R: wristOf(h.profile, 'R') },
  };
}

function run(h: Harness, def: GestureDef | null = gestureDef('fingerTouch')): Frame[] {
  if (!def) throw new Error('fingerTouch is not in the table');
  h.rig.reset();
  h.body.update(DT);
  h.body.playDef(def, 'fingerTouch', 'R');
  const out: Frame[] = [];
  for (let i = 0; i < FRAMES; i++) {
    h.rig.reset();
    h.body.update(DT);
    out.push(sample(h));
  }
  return out;
}

/** The same gesture with the right hand's lateral offset not mirrored: its sign is wrong. */
function unmirrored(): GestureDef {
  const def = gestureDef('fingerTouch');
  if (!def) throw new Error('fingerTouch is not in the table');
  return {
    ...def,
    build(t, v, phase, out) {
      const pose = def.build(t, v, phase, out);
      const r = pose.reach?.R;
      if (r?.offset) r.offset = [-r.offset[0], r.offset[1], r.offset[2]];
      return pose;
    },
  };
}

/** How many separate times the tips touch after having been apart. */
function contacts(gaps: number[], touching: number): number {
  let n = 0;
  let apart = true;
  for (const g of gaps) {
    if (apart && g <= touching) {
      n++;
      apart = false;
    } else if (g > PARTED) apart = true;
  }
  return n;
}

/** The tap rate scales with the gesture's variation, so the hold is measured at the nominal one. */
const NOMINAL = { random: () => 0.5 };

describe('fingerTouch', () => {
  const h = harness(0, NOMINAL);
  const thickness = fingerThickness(h);
  /** Two fingertips are in contact when their centres are within half a finger's thickness. */
  const touching = thickness / 2;
  const frames = run(h);
  const hold = frames.slice(HOLD.from, HOLD.to);
  const gaps = hold.map((f) => f.gap);

  it('touches at the fingertips and returns to contact on every tap', () => {
    expect(Math.min(...gaps)).toBeLessThanOrEqual(touching);
    expect(contacts(gaps, touching)).toBeGreaterThanOrEqual(2);
  });

  it('parts only a little while tapping', () => {
    expect(Math.max(...gaps)).toBeGreaterThan(PARTED);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(MAX_PART);
  });

  it('keeps the tips on the midline, above the jaw and in front of the face', () => {
    // No ceiling: the synthetic face is compressed to three centimetres from jaw to eyes.
    const head = h.profile.bones.head;
    const eye = h.profile.bones['eye.L'];
    if (!(head && eye)) throw new Error('synthetic rig has no head or eye');
    h.rig.anat.update();
    const local = (b: THREE.Object3D) => {
      const p = b.getWorldPosition(new THREE.Vector3()).sub(h.rig.anat.axisO);
      return new THREE.Vector3(
        p.dot(h.rig.anat.right),
        p.dot(h.rig.anat.up),
        p.dot(h.rig.anat.fwd),
      );
    };
    const jaw = local(head);
    const eyes = local(eye);
    for (const f of hold) {
      expect(f.off).toBeLessThanOrEqual(MAX_PART / 2 + touching);
      expect(f.mid.x).toBeCloseTo(0, 2);
      expect(f.mid.y).toBeGreaterThan(jaw.y);
      expect(f.mid.z).toBeGreaterThan(eyes.z);
    }
  });

  it('moves the wrists without a jump', () => {
    for (const side of ['L', 'R'] as Side[]) {
      let worst = 0;
      for (let i = HOLD.from + 1; i < HOLD.to; i++) {
        worst = Math.max(worst, frames[i].wrists[side].distanceTo(frames[i - 1].wrists[side]) / DT);
      }
      expect(worst).toBeLessThan(0.08);
    }
  });

  it('is not vacuous: an unmirrored offset puts the tips apart', () => {
    const wrong = run(harness(0, NOMINAL), unmirrored()).slice(HOLD.from, HOLD.to);
    const wrongGaps = wrong.map((f) => f.gap);
    expect(Math.min(...wrongGaps)).toBeGreaterThan(touching);
    expect(contacts(wrongGaps, touching)).toBe(0);
  });

  it('is a plain table entry', () => {
    const def = gestureDef('fingerTouch');
    expect(def?.group).toBe('cute');
    expect(def?.sustain).toBeFalsy();
  });
});
