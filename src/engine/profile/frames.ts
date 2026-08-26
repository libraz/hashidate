/**
 * Frames and anchors.
 *
 * The head's right/up/forward frame, and the two anchor tables the motion layer
 * reaches for. Both tables are given in units the avatar supplies, so a pose
 * authored on one character lands on another.
 */

import * as THREE from 'three';
import type { FaceFrame, Vec3Tuple } from '../types';
import type { BoneMap } from './bones';

/**
 * Anchor points on the face, for gestures that touch it.
 *
 * Given relative to the midpoint between the eyes, in units of interpupillary
 * distance. IPD is the one facial measurement that scales sensibly across
 * avatars — a stylised head with huge eyes has a proportionally wide IPD, so a
 * mouth "1.25 IPD below the eyes" lands correctly on both a realistic head and
 * a deformed one, where an absolute distance in centimetres would not.
 */
export const FACE_ANCHORS: Record<string, Vec3Tuple> = {
  //         right,   up,  forward
  eyes: [0.0, 0.0, 0.0],
  mouth: [0.0, -1.25, 0.55],
  cheek: [0.8, -0.7, 0.45],
  chin: [0.0, -1.85, 0.35],
  temple: [1.05, -0.05, 0.05],
  ear: [1.25, -0.35, -0.55],
  crown: [0.0, 1.35, -0.2],
};

/**
 * Anchor points on the body, for gestures whose hands meet each other.
 *
 * The counterpart to `FACE_ANCHORS`, and needed for the same reason. A gesture
 * written as directions says which way the limbs point and nothing about where
 * the hands end up, so where they land falls out of the avatar's arm length and
 * shoulder width. That is tolerable for a wave. It is not tolerable for a clap,
 * where the whole gesture is two hands arriving at the same place: authored as
 * directions, the hands missed each other by a visible gap.
 *
 * Given relative to the chest bone, along the body frame from
 * `anatomy/body-frame.ts`, in units of `body.span` — trunk half-width plus arm
 * length, the distance from the midline the hand can actually get to. Every
 * offset here is therefore a fraction of the character's own reach, which is
 * the quantity that ports.
 *
 * `right` is mirrored per side by the caller, exactly as the face anchors are.
 * A positive offset puts the two hands symmetrically either side of the
 * midline, which is what a gap between meeting palms is; a negative one carries
 * a hand across to the opposite side of the body.
 */
export const BODY_ANCHORS: Record<string, Vec3Tuple> = {
  //          right,   up, forward
  chest: [0.0, 0.0, 0.0], // the chest bone itself, on the spine
  sternum: [0.0, 0.06, 0.14], // the front of the ribcage
  navel: [0.0, -0.3, 0.12],
  shoulder: [0.2, 0.28, -0.01], // where the upper arm hangs from
};

/**
 * The torso frame lives in `anatomy/body-frame.ts`, in chest-local space.
 *
 * It was built here, relative to the hips, when its only consumer was the reach
 * solver placing an elbow "in front of the chest". Anatomy needs the same frame
 * for a different job — every joint limit is measured against the torso — and
 * for that one the reference has to be the chest and not the hips: shoulder
 * range is relative to the ribcage, so a character who twists at the waist
 * carries its arm limits round with it. Two frames measured from two different
 * bones would disagree the moment the spine bent, so there is one.
 */

/**
 * A right/up/forward frame for the head, derived from geometry.
 *
 * The head bone's own local axes are arbitrary and differ per rig, so they
 * cannot be used to place anything. The eyes give a lateral axis, the neck
 * gives up, and the cross product gives forward — all three are present on any
 * humanoid, and none of them depend on how the exporter happened to orient the
 * joint. Everything is stored in head-local space so it survives the head
 * moving.
 */
export function buildFaceFrame(root: THREE.Object3D, bones: BoneMap): FaceFrame | null {
  const head = bones.head;
  const eL = bones['eye.L'];
  const eR = bones['eye.R'];
  const neck = bones.neck;
  if (!(head && eL && eR)) return null;
  root.updateMatrixWorld(true);

  const inv = new THREE.Matrix4().copy(head.matrixWorld).invert();
  const pL = eL.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  const pR = eR.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  const ipd = pL.distanceTo(pR);
  if (!(ipd > 1e-6)) return null;

  const origin = pL.clone().add(pR).multiplyScalar(0.5);
  // Positive right is the character's own right, matching how gestures mirror.
  // Left eye to right eye already *is* that direction whichever way the avatar
  // is turned in world space, so nothing about world orientation enters here.
  const right = pR.clone().sub(pL).normalize();

  let up: THREE.Vector3 | null = null;
  if (neck) {
    up = neck.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).negate();
    // Strip any component along `right` so the frame stays orthogonal.
    up.addScaledVector(right, -up.dot(right));
    if (up.lengthSq() < 1e-10) up = null;
    else up.normalize();
  }
  if (!up) up = new THREE.Vector3(0, 1, 0).addScaledVector(right, -right.y).normalize();

  // Forward follows from the other two: in a right-handed space, up cross right
  // is the direction a figure with that right and that up faces. It is fixed by
  // the handedness of the coordinate system, so there is nothing to measure.
  //
  // Do not try to settle it geometrically instead — "the eyes are on the front,
  // so flip if the eye midpoint is behind the head bone" reads plausible and is
  // not: the eye bone sits at the eyeball's centre of rotation, which on this
  // avatar is 0.09 units *behind* the head bone against a 5.16 unit rise. The
  // test decided the sign on a 0.95 degree margin and got it backwards, so
  // every gesture that touched the face reached around the back of the skull.
  const forward = new THREE.Vector3().crossVectors(up, right).normalize();

  return { origin, right, up, forward, ipd };
}
