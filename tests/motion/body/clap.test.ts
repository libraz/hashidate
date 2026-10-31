import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FINGER_WIDTH } from '@/engine/anatomy';
import { gestureDef } from '@/engine/motion';
import type { FingerName, GestureDef, Side } from '@/engine/types';
import { DT, type Harness, harness, wristOf } from './harness';

/**
 * The clap: the two palms meet flat at the midline on every beat, each hand's
 * fingers staying on its own side of it rather than interleaving with the
 * other's.
 */

/** How far a fingertip runs past its last joint, as a share of that bone (`rig/hand_geometry.rs`). */
const FINGER_TIP_EXTENSION = 0.75;
const FRAMES = 240;
/** The frames between the entrance settling and the exit starting. */
const HOLD = { from: 45, to: 175 };
/** Degrees the two palms may turn off facing each other at a meeting before the fingers fan into the other hand. */
const MAX_PALM_ANGLE = 5;

const FINGERS: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];

/** Every finger joint of one hand and its tip as the engine estimates it, world space. */
function fingerPoints(h: Harness, side: Side): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const f of FINGERS) {
    const pts = (h.profile.fingerBones[`${f}.${side}`] ?? []).map((b) =>
      b.getWorldPosition(new THREE.Vector3()),
    );
    const k = pts.length;
    if (k < 2) throw new Error(`synthetic rig has no ${f} chain`);
    pts.push(
      pts[k - 1].clone().addScaledVector(pts[k - 1].clone().sub(pts[k - 2]), FINGER_TIP_EXTENSION),
    );
    out.push(...pts);
  }
  return out;
}

/** Finger thickness, metres: the knuckle pitch scaled by the engine's finger width. */
function fingerThickness(h: Harness): number {
  const at = (f: FingerName) => {
    const bone = h.profile.fingerBones[`${f}.R`]?.[0];
    if (!bone) throw new Error(`synthetic rig has no ${f} chain`);
    return bone.getWorldPosition(new THREE.Vector3());
  };
  return FINGER_WIDTH * at('index').distanceTo(at('middle'));
}

interface Frame {
  /** Wrist-to-wrist distance across the midline, metres. */
  sep: number;
  /** How far the deepest finger point of either hand is past the midline, metres. */
  cross: number;
  /** Degrees between one palm normal and the reverse of the other. */
  palmAngle: number;
}

function sample(h: Harness): Frame {
  const a = h.rig.anat;
  a.update();
  const lateral = (p: THREE.Vector3) => p.clone().sub(a.axisO).dot(a.right);
  const own = (side: Side) => (side === 'R' ? 1 : -1);
  let cross = Number.NEGATIVE_INFINITY;
  for (const side of ['L', 'R'] as Side[]) {
    for (const p of fingerPoints(h, side)) cross = Math.max(cross, -own(side) * lateral(p));
  }
  const normal = (side: Side) => {
    const local = h.rig.palmLocal[side];
    const hand = h.profile.bones[`hand.${side}`];
    if (!(local && hand)) throw new Error('synthetic rig has no palm');
    return local.clone().applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()));
  };
  const cos = THREE.MathUtils.clamp(-normal('L').dot(normal('R')), -1, 1);
  return {
    sep: lateral(wristOf(h.profile, 'R')) - lateral(wristOf(h.profile, 'L')),
    cross,
    palmAngle: THREE.MathUtils.radToDeg(Math.acos(cos)),
  };
}

function run(h: Harness, def: GestureDef | null = gestureDef('clap')): Frame[] {
  if (!def) throw new Error('clap is not in the table');
  h.rig.reset();
  h.body.update(DT);
  h.body.playDef(def, 'clap', 'R');
  const out: Frame[] = [];
  for (let i = 0; i < FRAMES; i++) {
    h.rig.reset();
    h.body.update(DT);
    out.push(sample(h));
  }
  return out;
}

/**
 * Frames, entrance included, whose wrists are nearer than halfway between the
 * held beat's closest and widest: a meeting while the arm is still arriving counts.
 */
function together(frames: Frame[]): Frame[] {
  const seps = frames.slice(HOLD.from, HOLD.to).map((f) => f.sep);
  const near = (Math.min(...seps) + Math.max(...seps)) / 2;
  return frames.slice(0, HOLD.to).filter((f) => f.sep < near);
}

/** The frames where the hands meet: each local minimum of the wrists' separation while together. */
function contacts(frames: Frame[]): Frame[] {
  const close = new Set(together(frames));
  return frames.filter(
    (f, i) =>
      i > 0 && close.has(f) && f.sep <= frames[i - 1].sep && f.sep < (frames[i + 1]?.sep ?? 0),
  );
}

/** The clap with its fingers angled in along the converging forearm. */
function angledIn(): GestureDef {
  const def = gestureDef('clap');
  if (!def) throw new Error('clap is not in the table');
  return {
    ...def,
    build(t, v, phase, out) {
      const pose = def.build(t, v, phase, out);
      for (const side of ['L', 'R'] as Side[]) {
        const r = pose.reach?.[side];
        if (r?.hand) r.hand = [-0.2, r.hand[1], r.hand[2]];
      }
      return pose;
    },
  };
}

/** The beat rate scales with the gesture's variation, so the beats are measured at the nominal one. */
const NOMINAL = { random: () => 0.5 };

describe('clap', () => {
  const h = harness(0, NOMINAL);
  const half = fingerThickness(h) / 2;
  const frames = run(h);
  const met = contacts(frames);

  it('meets more than once, the fingers reaching the midline', () => {
    expect(met.length).toBeGreaterThanOrEqual(2);
    for (const f of met) expect(f.cross).toBeGreaterThan(-4 * half);
  });

  it('brings the palms together facing each other on every beat', () => {
    for (const f of met) expect(f.palmAngle).toBeLessThanOrEqual(MAX_PALM_ANGLE);
  });

  it("keeps each hand's fingers on its own side of the midline while the hands are together", () => {
    for (const f of together(frames)) expect(f.cross).toBeLessThanOrEqual(-half);
  });

  it('is not vacuous: fingers angled in along the forearm cross the midline', () => {
    const wrong = together(run(harness(0, NOMINAL), angledIn()));
    expect(Math.max(...wrong.map((f) => f.cross))).toBeGreaterThan(-half);
  });
});
