import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINGER_WIDTH } from '@/engine/anatomy';
import { gestureDef } from '@/engine/motion';
import { ReachAnchors } from '@/engine/motion/anchors';
import type { HandContact } from '@/engine/types';
import { DT, fingerDepth, type Harness, harness } from './harness';

/**
 * Where `think` puts its finger: the index fingertip's pad resting on the
 * forehead above the near brow, which is what tells it apart from `chin`.
 *
 * The face anchors are placed in front of a real avatar's eyes, so the
 * synthetic head sets its eyes as far behind the forehead as a validation
 * avatar's are, rather than behind the head bone.
 */
const EYE_DEPTH = 0.85;

function required<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`synthetic avatar has no ${what}`);
  return value;
}

/** The posed contact landmark, from the bones rather than from the contact prediction. */
function contactPoint(h: Harness, contact: HandContact): THREE.Vector3 {
  if (contact.kind !== 'finger') throw new Error('think touches with a finger');
  const at = (bone: THREE.Object3D) => bone.getWorldPosition(new THREE.Vector3());
  const chain = required(h.profile.fingerBones[`${contact.finger}.R`], contact.finger);
  return at(chain[contact.segment]).lerp(at(chain[contact.segment + 1]), contact.fraction);
}

function held(h: Harness) {
  const step = () => {
    h.rig.reset();
    h.body.update(DT);
  };
  step();
  const def = required(gestureDef('think'), 'think');
  h.body.playDef({ ...def, sustain: true }, 'think', 'R');
  for (let i = 0; i < 180; i++) step();
  const g = required(h.body.gesture, 'running gesture');
  const reach = required(def.build(g.time, g.v, g.phase).reach?.R, 'right-hand reach');
  const contact = required(reach.contact, 'contact');
  const face = required(h.profile.face, 'face frame');
  const head = required(h.profile.bones.head, 'head');
  head.updateWorldMatrix(true, false);
  const anchors = new ReachAnchors(h.profile, h.rig, h.rig.characterFrame);
  const anchor = required(anchors.face(reach.at, reach.offset, 'R'), 'anchor').clone();
  const pad = contactPoint(h, contact);
  // The pad in the face frame, in IPD: right, up, forward of the eye midpoint.
  const local = pad.clone().applyMatrix4(head.matrixWorld.clone().invert()).sub(face.origin);
  const skin = required(h.rig.anat.face, 'face skin');
  skin.refresh();
  // The distal phalanx runs on past the pad, and its tip is what meets the skin:
  // carried on from the last joint as the face clearance carries it.
  const chain = required(h.profile.fingerBones['index.R'], 'index');
  const last = chain[chain.length - 1].getWorldPosition(new THREE.Vector3());
  const prev = chain[chain.length - 2].getWorldPosition(new THREE.Vector3());
  const tip = last.clone().addScaledVector(last.clone().sub(prev), 0.75);
  const sample = { distance: 0, normal: new THREE.Vector3(), valid: false };
  skin.sample(tip, sample);
  return {
    reach,
    distance: pad.distanceTo(anchor),
    right: local.dot(face.right) / face.ipd,
    up: local.dot(face.up) / face.ipd,
    skin: sample,
    depth: fingerDepth(h, 'R'),
    thickness: FINGER_WIDTH * (h.profile.limb?.['pitch.R'] ?? 0),
    ipd: face.ipd,
  };
}

describe('think', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reaches for the forehead with the index fingertip pad', () => {
    const def = required(gestureDef('think'), 'think');
    const reach = required(def.build(1, { rate: 1, scale: 1, side: 1 }).reach?.R, 'reach');
    expect(reach.at).toBe('forehead');
    expect(reach.contact).toMatchObject({ kind: 'finger', finger: 'index', surface: 'pad' });
  });

  it('rests the pad on the forehead above the near brow, the fingers out of the skin', () => {
    const m = held(harness(0, {}, { eyeDepth: EYE_DEPTH }));
    expect(m.distance).toBeLessThan(0.4 * m.ipd);
    // Above the eyes and on the gesturing side of the midline, not across it.
    expect(m.up).toBeGreaterThan(0.4);
    expect(m.right).toBeGreaterThan(0);
    // On the skin: the fingertip's centre outside it by no more than a finger's
    // thickness, and nothing of the hand sunk past half of one.
    expect(m.skin.valid).toBe(true);
    expect(m.skin.distance).toBeGreaterThan(0);
    expect(m.skin.distance).toBeLessThan(m.thickness);
    expect(m.thickness).toBeGreaterThan(0);
    expect(m.depth).toBeLessThan(0.5 * m.thickness);
  });
});
