import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ArmAnatomy } from '@/engine/anatomy/arm';
import { surfaceOf } from '@/engine/anatomy/volume';
import type { BodyClearance } from '@/engine/anatomy/volumes';
import { BodyVolumes, makeBodyVolumeFrame } from '@/engine/anatomy/volumes';
import { buildProfile } from '@/engine/profile';
import { buildRig } from '../helpers/scene';

/**
 * The trunk has ends. Measured as a radius per height band, its signed
 * clearance used to stop at the top and bottom: a point well inside the ribs a
 * hair below the shoulders read as deeply buried, and the same point a hair
 * above as absent.
 */

function subject() {
  const built = buildRig();
  const profile = buildProfile(built.root, built.descriptor);
  const anatomy = new ArmAnatomy(profile);
  expect(anatomy.update()).toBe(true);
  const chest = profile.bones.chest ?? profile.bones.spine ?? profile.bones.hips;
  if (!chest) throw new Error('synthetic rig has no chest');
  const volumes = new BodyVolumes(profile, profile.body, anatomy.up, anatomy.right, anatomy.fwd);
  volumes.update(chest);
  const torso = volumes.torso;
  if (!torso) throw new Error('synthetic rig has no torso volume');
  const frame = volumes.captureVolumeFrame(makeBodyVolumeFrame());
  const pose = frame.torso;
  if (!pose) throw new Error('synthetic rig has no torso frame');
  return { volumes, torso, frame, pose };
}

const rows = (): BodyClearance[] =>
  (['torso', 'head'] as const).map((surface) => ({
    surface,
    valid: false,
    distance: Number.POSITIVE_INFINITY,
    normal: new THREE.Vector3(),
  }));

describe.each(['top', 'bottom'] as const)('torso %s cap', (cap) => {
  const sign = cap === 'top' ? 1 : -1;
  /** A point at half the radius in front of the axis, `inset` inside the cap. */
  const at = (s: ReturnType<typeof subject>, inset: number) => {
    const h = s.torso[cap] - sign * inset;
    const R = surfaceOf(s.torso, h, Math.PI / 2);
    return s.pose.O.clone()
      .addScaledVector(s.pose.up, h)
      .addScaledVector(s.pose.fwd, R * 0.5);
  };

  it('closes the signed clearance to contact at the cap, leaving through it', () => {
    const s = subject();
    const span = s.torso.top - s.torso.bottom;
    let previous = Number.NEGATIVE_INFINITY;
    for (const inset of [span * 0.02, span * 0.01, span * 0.001, 0]) {
      const row = s.volumes.sampleVolumeClearances(s.frame, at(s, inset), rows())[0];
      expect(row.valid).toBe(true);
      expect(row.distance).toBeCloseTo(-inset, 12);
      expect(row.normal.dot(s.pose.up)).toBeCloseTo(sign, 12);
      expect(row.distance).toBeGreaterThan(previous);
      previous = row.distance;
    }
  });
});
