import * as THREE from 'three';
import type { Rig } from '../rig';
import type { Profile } from '../types';
import type { Gaze } from './gaze';
import { saturate } from './idle';

/**
 * Where the character is looking.
 *
 * Three channels off one target, each with its own share and its own bound:
 * the eyes lead, the head carries most of the turn, and the neck follows. The
 * aim is deliberately partial — a full one would cancel the idle motion the
 * head is already carrying — and every channel is bounded by the profile's own
 * measured limits, because unbounded tracking of an off-axis camera rotates the
 * iris out of the painted sclera and the eyes go blank white.
 */

const _tmp = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** How much of the target is honoured, and how loud the wander over it is. */
export interface LookSettings {
  /** 0 = straight ahead, 1 = track the target. */
  lookAt: number;
  /** How much of the gaze wander is layered on top. */
  gazeAmount: number;
}

export function aimGaze(
  rig: Rig,
  p: Profile,
  gaze: Gaze,
  { lookAt, gazeAmount }: LookSettings,
  headWorldTarget: THREE.Vector3 | null,
): void {
  const head = p.bones.head;
  if (headWorldTarget && head) {
    head.updateWorldMatrix(true, false);
    const hp = head.getWorldPosition(_tmp);
    const dir = _dir.copy(headWorldTarget).sub(hp).normalize();
    // Partial aim only: a full aim would cancel the idle motion above.
    const k = lookAt;
    const camYaw = Math.atan2(dir.x, dir.z) * k;
    const camPitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) * k;
    const amt = gazeAmount;

    // Eyes ride the raw saccade plus the microsaccade; head and neck ride the
    // settled copy, which lags and slightly overshoots.
    const eyeYaw = camYaw + (gaze.offset.x + gaze.micro.x) * amt;
    const eyePitch = camPitch + (gaze.offset.y + gaze.micro.y) * amt;
    const bodyYaw = camYaw + gaze.settled.x * amt;
    const bodyPitch = camPitch + gaze.settled.y * amt;

    // Every channel is bounded by the profile's limits. Unbounded tracking of
    // an off-axis camera rotates the iris out of the painted sclera and the
    // eyes go blank white; the body just stops following instead.
    const L = p.gaze;
    const C = THREE.MathUtils.clamp;
    rig.addOffset(
      'neck',
      C(-bodyPitch * 0.16, -L.neckPitch, L.neckPitch),
      C(bodyYaw * 0.16, -L.neckYaw, L.neckYaw),
      0,
    );
    rig.addOffset(
      'head',
      C(-bodyPitch * 0.28, -L.headPitch, L.headPitch),
      C(bodyYaw * 0.28, -L.headYaw, L.headYaw),
      0,
    );
    // Eyes lead the head, as they do in life, but over a range small enough
    // that turning to look at something is carried almost entirely by the
    // head. Saturated rather than clamped, per `saturate` above.
    const ey = saturate(eyeYaw * 0.5, L.eyeYaw);
    const ep = saturate(-eyePitch * 0.5, L.eyePitch);
    for (const side of ['L', 'R'] as const) rig.addOffset(`eye.${side}`, ep, ey, 0);
  }
}
