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
const _rootQ = new THREE.Quaternion();

/** How much of the target is honoured, and how loud the wander over it is. */
export interface LookSettings {
  /** 0 = straight ahead, 1 = track the target. */
  lookAt: number;
  /** How much of the gaze wander is layered on top. */
  gazeAmount: number;
}

export interface GazeFrame {
  active: boolean;
  gazeHead: THREE.Quaternion;
  eyeYaw: number;
  eyePitch: number;
}

export function makeGazeFrame(): GazeFrame {
  return { active: false, gazeHead: new THREE.Quaternion(), eyeYaw: 0, eyePitch: 0 };
}

const _gazeEuler = new THREE.Euler();
const _gazeQ = new THREE.Quaternion();
const _headOffset = new THREE.Quaternion();

export function prepareGaze(
  rig: Rig,
  p: Profile,
  gaze: Gaze,
  { lookAt, gazeAmount }: LookSettings,
  headWorldTarget: THREE.Vector3 | null,
  frame: GazeFrame,
): void {
  frame.active = false;
  const head = p.bones.head;
  if (headWorldTarget && head) {
    head.updateWorldMatrix(true, false);
    const hp = head.getWorldPosition(_tmp);
    const dir = _dir.copy(headWorldTarget).sub(hp).normalize();
    // Bearing in root space, so tracking follows the avatar's placement, not the room.
    dir.applyQuaternion(p.root.getWorldQuaternion(_rootQ).invert());
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
    frame.gazeHead.identity();
    if (p.bones.neck) {
      frame.gazeHead.setFromEuler(
        _gazeEuler.set(
          C(-bodyPitch * 0.16, -L.neckPitch, L.neckPitch),
          C(bodyYaw * 0.16, -L.neckYaw, L.neckYaw),
          0,
          'XYZ',
        ),
      );
    }
    frame.gazeHead.multiply(
      _gazeQ.setFromEuler(
        _gazeEuler.set(
          C(-bodyPitch * 0.28, -L.headPitch, L.headPitch),
          C(bodyYaw * 0.28, -L.headYaw, L.headYaw),
          0,
          'XYZ',
        ),
      ),
    );
    frame.eyeYaw = eyeYaw;
    frame.eyePitch = eyePitch;
    frame.active = true;
  }
}

function unwrapEyeAngle(angle: number, reference: number): number {
  const turn = 2 * Math.PI;
  return angle + turn * Math.round((reference - angle) / turn);
}

/** Select the equivalent XYZ branch nearest the unsaturated authored eye angles. */
function nearestEyeBranch(angles: THREE.Euler, rawX: number, rawY: number): void {
  const x0 = unwrapEyeAngle(angles.x, rawX);
  const y0 = unwrapEyeAngle(angles.y, rawY);
  const z0 = unwrapEyeAngle(angles.z, 0);
  const x1 = unwrapEyeAngle(angles.x + Math.PI, rawX);
  const y1 = unwrapEyeAngle(Math.PI - angles.y, rawY);
  const z1 = unwrapEyeAngle(angles.z + Math.PI, 0);
  const d0 = (x0 - rawX) ** 2 + (y0 - rawY) ** 2 + z0 ** 2;
  const d1 = (x1 - rawX) ** 2 + (y1 - rawY) ** 2 + z1 ** 2;
  if (d1 < d0) angles.set(x1, y1, z1, 'XYZ');
  else angles.set(x0, y0, z0, 'XYZ');
}

/** Compensate against the head pose actually displayed after body acceptance. */
export function aimEyes(rig: Rig, p: Profile, frame: GazeFrame): void {
  if (!(frame.active && rig.readHeadOffset(_headOffset))) return;
  _gazeQ.setFromEuler(_gazeEuler.set(-frame.eyePitch * 0.5, frame.eyeYaw * 0.5, 0, 'XYZ'));
  _headOffset.invert().multiply(frame.gazeHead).multiply(_gazeQ);
  _gazeEuler.setFromQuaternion(_headOffset, 'XYZ');
  nearestEyeBranch(_gazeEuler, -frame.eyePitch * 0.5, frame.eyeYaw * 0.5);
  // Eyes lead the head, as they do in life, but over a range small enough
  // that turning to look at something is carried almost entirely by the
  // head. Saturated rather than clamped, per `saturate` above.
  const ey = saturate(_gazeEuler.y, p.gaze.eyeYaw);
  const ep = saturate(_gazeEuler.x, p.gaze.eyePitch);
  for (const side of ['L', 'R'] as const) rig.addOffset(`eye.${side}`, ep, ey, 0);
}
