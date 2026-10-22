import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gestureDef } from '@/engine/motion';
import { ReachAnchors } from '@/engine/motion/anchors';
import { CharacterFrame } from '@/engine/motion/frame';
import { DT, type Harness, harness } from './harness';

/**
 * Which way a hand slides to clear the face at the mouth.
 *
 * The measured mouth sits on a lip whose skin leans downward, so sliding along
 * that normal would lower the hand onto the chin. The slide has to follow the
 * face's forward instead, which a rig with flat lips cannot tell apart.
 */

const TILT = 60;
const ALTERNATES = ['cover', 'yawn', 'whisper'] as const;

function required<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`synthetic avatar has no ${what}`);
  return value;
}

/** The face's forward in world space and its up made exactly orthogonal to it. */
function headAxes(h: Harness): { up: THREE.Vector3; forward: THREE.Vector3 } {
  const face = required(h.profile.face, 'face frame');
  const head = required(h.profile.bones.head, 'head');
  head.updateWorldMatrix(true, false);
  const forward = face.forward.clone().transformDirection(head.matrixWorld);
  const up = face.up.clone().transformDirection(head.matrixWorld);
  return { up: up.addScaledVector(forward, -up.dot(forward)).normalize(), forward };
}

interface Slide {
  vector: THREE.Vector3;
  up: THREE.Vector3;
  forward: THREE.Vector3;
}

/** Play `gesture` for 180 frames and collect each `clearFace` slide with the head's axes at that call. */
function slides(h: Harness, gesture: string): Slide[] {
  const out: Slide[] = [];
  const original = (ReachAnchors.prototype as unknown as Record<string, (...a: unknown[]) => void>)
    .clearFace;
  vi.spyOn(
    ReachAnchors.prototype as unknown as Record<string, (...a: unknown[]) => void>,
    'clearFace',
  ).mockImplementation(function (this: unknown, ...args: unknown[]) {
    const target = args[0] as THREE.Vector3;
    const before = target.clone();
    original.apply(this, args);
    out.push({ vector: target.clone().sub(before), ...headAxes(h) });
  });
  const step = () => {
    h.rig.reset();
    h.body.update(DT);
  };
  step();
  const def = required(gestureDef(gesture), gesture);
  h.body.playDef({ ...def, sustain: true }, gesture, 'R');
  for (let i = 0; i < 180; i++) step();
  vi.restoreAllMocks();
  return out;
}

describe('the slide that clears the face at the mouth', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is measured on skin that faces downward', () => {
    const h = harness(0, { random: () => 0.75 }, { lipTilt: TILT });
    const face = required(h.rig.anat.face, 'face skin');
    const anchors = new ReachAnchors(h.profile, h.rig, new CharacterFrame(h.rig, h.profile));
    const mouth = required(anchors.face('mouth', undefined, 'R'), 'mouth').clone();
    face.refresh();
    const normal = new THREE.Vector3();
    expect(face.shortfall(mouth, Number.POSITIVE_INFINITY, normal)).toBeGreaterThan(0);
    expect(normal.dot(headAxes(h).up)).toBeLessThanOrEqual(-0.8);
  });

  it('follows the face forward, not the lip normal', () => {
    let used = 0;
    for (const gesture of ALTERNATES) {
      const h = harness(0, { random: () => 0.75 }, { lipTilt: TILT });
      const found = slides(h, gesture).filter((s) => s.vector.length() > 0);
      for (const { vector, up, forward } of found) {
        expect(Math.abs(vector.dot(up))).toBeLessThanOrEqual(1e-6 * vector.length());
        expect(vector.dot(forward)).toBeGreaterThan(0);
      }
      used += found.length;
      if (found.length) break;
    }
    expect(used).toBeGreaterThan(0);
  });

  it('slides a hand that starts inside the skin rather than leaving it at the ceiling', () => {
    const h = harness(0, { random: () => 0.75 }, { lipTilt: TILT });
    const found = slides(h, 'cover');
    expect(found.some((s) => s.vector.length() > 0)).toBe(true);
  });
});
