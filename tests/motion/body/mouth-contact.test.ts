import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINGER_WIDTH } from '@/engine/anatomy';
import { gestureDef } from '@/engine/motion';
import { ReachAnchors } from '@/engine/motion/anchors';
import { CharacterFrame } from '@/engine/motion/frame';
import { performanceDef } from '@/engine/performance';
import type { HandContact } from '@/engine/types';
import { DT, fingerDepth, type Harness, harness } from './harness';

/**
 * Where a hand held to the mouth makes contact.
 *
 * These reaches name the part of the hand that touches — a finger's pad or
 * the palm — and the wrist is placed from it. The mouth anchor is measured on
 * the skin from the lip-sync shapes, so the touching part is measured against
 * the reach's anchor itself.
 */

const MOUTH = [
  { gesture: 'cover', performance: 'giggle' },
  { gesture: 'whisper', performance: 'secret' },
  { gesture: 'yawn', performance: 'sleepy' },
  { gesture: 'blowKiss', performance: 'blowKiss' },
] as const;

/** Held gestures are measured settled; a kiss at its beat, before the hand leaves. */
const SETTLED = ['cover', 'whisper', 'yawn'] as const;

function required<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`synthetic avatar has no ${what}`);
  return value;
}

/** The posed contact landmark, from the bones rather than from the contact prediction. */
function contactPoint(h: Harness, contact: HandContact): THREE.Vector3 {
  const at = (bone: THREE.Object3D) => bone.getWorldPosition(new THREE.Vector3());
  if (contact.kind === 'finger') {
    const chain = required(h.profile.fingerBones[`${contact.finger}.R`], contact.finger);
    return at(chain[contact.segment]).lerp(at(chain[contact.segment + 1]), contact.fraction);
  }
  const wrist = at(required(h.profile.bones['hand.R'], 'hand'));
  const knuckles = new THREE.Vector3();
  for (const f of ['index', 'middle', 'ring', 'little'] as const) {
    knuckles.add(at(required(h.profile.fingerBones[`${f}.R`], f)[0]));
  }
  // Halfway from the wrist to the four knuckles, as the palm contact is defined.
  return wrist.lerp(knuckles.multiplyScalar(0.25), 0.5);
}

/** The reach's contact landmark against its anchor, and the deepest finger. */
function measure(h: Harness, gesture: string, t: number) {
  const def = required(gestureDef(gesture), gesture);
  const g = required(h.body.gesture, 'running gesture');
  const reach = required(def.build(t, g.v, g.phase).reach?.R, 'right-hand reach');
  const contact = required(reach.contact, 'contact');
  const anchors = new ReachAnchors(h.profile, h.rig, new CharacterFrame(h.rig, h.profile));
  const anchor = required(anchors.face(reach.at, reach.offset, 'R'), 'face frame').clone();
  return {
    distance: contactPoint(h, contact).distanceTo(anchor),
    depth: fingerDepth(h, 'R'),
    half: 0.5 * FINGER_WIDTH * (h.profile.limb?.['pitch.R'] ?? 0),
    ipd: required(h.profile.face, 'face frame').ipd,
  };
}

describe('a hand held to the mouth', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(MOUTH)('$performance plays $gesture', ({ gesture, performance }) => {
    expect(performanceDef(performance)?.gesture).toBe(gesture);
  });

  it.each(SETTLED)('%s lands its contact on the lips, fingers out of the skin', (gesture) => {
    const h = harness();
    const step = () => {
      h.rig.reset();
      h.body.update(DT);
    };
    step();
    const def = required(gestureDef(gesture), gesture);
    h.body.playDef({ ...def, sustain: true }, gesture, 'R');
    for (let i = 0; i < 180; i++) step();
    const m = measure(h, gesture, required(h.body.gesture, 'running gesture').time);
    // Half an IPD is about the mouth's own half-width: inside it, the hand is on
    // the mouth rather than beside or in front of it.
    expect(m.distance).toBeLessThan(0.5 * m.ipd);
    expect(m.half).toBeGreaterThan(0);
    expect(m.depth).toBeLessThan(m.half);
  });

  it('blowKiss holds the index fingertip pad on the lips at the kiss', () => {
    const h = harness();
    const step = () => {
      h.rig.reset();
      h.body.update(DT);
    };
    step();
    h.body.playDef(required(gestureDef('blowKiss'), 'blowKiss'), 'blowKiss', 'R');
    // The kiss is the first fifth of a second held, before the hand departs.
    for (let i = 0; i < 600 && (h.body.gesture?.phase.held ?? 0) < 0.15; i++) step();
    const g = required(h.body.gesture, 'running gesture');
    expect(g.phase.held).toBeGreaterThanOrEqual(0.15);
    expect(g.phase.held).toBeLessThan(0.2);
    const m = measure(h, 'blowKiss', g.time);
    expect(m.distance).toBeLessThan(0.5 * m.ipd);
    expect(m.depth).toBeLessThan(m.half);
  });
});
