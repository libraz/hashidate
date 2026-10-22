import * as THREE from 'three';
import type { Rig } from '../rig';
import type { Profile } from '../types';
import { DirFollower, OMEGA_PER_RATE } from './follow';
import { type Gaze, HEAD_OMEGA } from './gaze';
import { saturate } from './idle';
import { minJerk } from './timing';

/**
 * Where the character is looking.
 *
 * Three channels off one target, each with its own share and its own bound:
 * the eyes lead, the head carries most of the turn, and the neck follows. The
 * aim is deliberately partial — a full one would cancel the idle motion the
 * head is already carrying — and every channel is bounded by the profile's own
 * measured limits, because unbounded tracking of an off-axis camera rotates the
 * iris out of the painted sclera and the eyes go blank white.
 *
 * The bearing to the target is followed rather than taken, so a camera that
 * glides is tracked the way a head turns; a cut re-seeds it, because the
 * picture has already jumped and a swing across the cut would be the only
 * thing on screen still travelling.
 */

/**
 * How fast the applied camera-tracking share, and the bearing it is applied
 * to, follow their targets: the head's own settle frequency, so either change
 * moves like a glance.
 */
export const LOOK_FOLLOW = HEAD_OMEGA / OMEGA_PER_RATE;

/**
 * Seconds the head takes to cross the front when the body has turned too far
 * for it to hold the camera, so the flip is a motion rather than a cut.
 */
export const WHIP_T = 0.1;

const wrapToPi = (a: number): number => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

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

/** The eye aim one frame prepares, plus the bearing it carries to the next. */
export interface GazeFrame {
  active: boolean;
  gazeHead: THREE.Quaternion;
  eyeYaw: number;
  eyePitch: number;
  /** The followed root-space bearing to the target; meaningful while `seeded`. */
  bearing: DirFollower;
  /** False until a target is seen, and again after one goes away. */
  seeded: boolean;
  /** The head's bridge across the front while the body is turned away; null when none runs. */
  whip: { from: number; t: number } | null;
  /** Last bearing against the body, as measured and as applied after any whip. */
  rel: number;
  relApplied: number;
}

export function makeGazeFrame(): GazeFrame {
  return {
    active: false,
    gazeHead: new THREE.Quaternion(),
    eyeYaw: 0,
    eyePitch: 0,
    bearing: new DirFollower(new THREE.Vector3(0, 0, 1)),
    seeded: false,
    whip: null,
    rel: 0,
    relApplied: 0,
  };
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
  dt: number,
  cut: boolean,
  bodyYaw = 0,
): void {
  frame.active = false;
  const head = p.bones.head;
  if (!(headWorldTarget && head)) {
    frame.seeded = false;
    frame.whip = null;
  } else {
    const wasSeeded = frame.seeded;
    head.updateWorldMatrix(true, false);
    const hp = head.getWorldPosition(_tmp);
    const dir = _dir.copy(headWorldTarget).sub(hp).normalize();
    // Bearing in root space, so tracking follows the avatar's placement, not the room.
    dir.applyQuaternion(p.root.getWorldQuaternion(_rootQ).invert());
    if (cut || !frame.seeded) frame.bearing.reset(dir);
    else dir.copy(frame.bearing.step(dir, dt, LOOK_FOLLOW));
    frame.seeded = true;
    // Partial aim only: a full aim would cancel the idle motion above.
    const k = lookAt;
    // Against the chest, not the root: the head keeps the camera while the body
    // turns away, up to the limits below.
    const bearing = Math.atan2(dir.x, dir.z);
    const rel = bodyYaw === 0 ? bearing : wrapToPi(bearing - bodyYaw);
    if (cut || !wasSeeded) frame.whip = null;
    // The dancer's whip. The head stays on the camera as long as the neck allows
    // and crosses the front in a few frames when it no longer can; without the
    // bridge the branch flip at directly-behind is a half-turn of the head in one
    // frame.
    else if (bodyYaw !== 0 && !frame.whip && Math.abs(rel - frame.rel) > Math.PI) {
      frame.whip = { from: frame.relApplied, t: 0 };
    }
    let relApplied = rel;
    if (frame.whip) {
      frame.whip.t += dt;
      relApplied = frame.whip.from + (rel - frame.whip.from) * minJerk(frame.whip.t / WHIP_T);
      if (frame.whip.t >= WHIP_T) frame.whip = null;
    }
    frame.rel = rel;
    frame.relApplied = relApplied;
    const camYaw = relApplied * k;
    const camPitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) * k;
    const amt = gazeAmount;

    // Eyes ride the raw saccade plus the microsaccade; head and neck ride the
    // settled copy, which lags and slightly overshoots.
    const eyeYaw = camYaw + (gaze.offset.x + gaze.micro.x) * amt;
    const eyePitch = camPitch + (gaze.offset.y + gaze.micro.y) * amt;
    const aimYaw = camYaw + gaze.settled.x * amt;
    const bodyPitch = camPitch + gaze.settled.y * amt;

    // Every channel is bounded by the profile's limits. Unbounded tracking of
    // an off-axis camera rotates the iris out of the painted sclera and the
    // eyes go blank white; the body just stops following instead.
    const L = p.gaze;
    const C = THREE.MathUtils.clamp;
    rig.addOffset(
      'neck',
      C(-bodyPitch * 0.16, -L.neckPitch, L.neckPitch),
      C(aimYaw * 0.16, -L.neckYaw, L.neckYaw),
      0,
    );
    rig.addOffset(
      'head',
      C(-bodyPitch * 0.28, -L.headPitch, L.headPitch),
      C(aimYaw * 0.28, -L.headYaw, L.headYaw),
      0,
    );
    frame.gazeHead.identity();
    if (p.bones.neck) {
      frame.gazeHead.setFromEuler(
        _gazeEuler.set(
          C(-bodyPitch * 0.16, -L.neckPitch, L.neckPitch),
          C(aimYaw * 0.16, -L.neckYaw, L.neckYaw),
          0,
          'XYZ',
        ),
      );
    }
    frame.gazeHead.multiply(
      _gazeQ.setFromEuler(
        _gazeEuler.set(
          C(-bodyPitch * 0.28, -L.headPitch, L.headPitch),
          C(aimYaw * 0.28, -L.headYaw, L.headYaw),
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
