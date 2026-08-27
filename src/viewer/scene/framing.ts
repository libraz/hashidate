import * as THREE from 'three';
import type { CameraFrame, Profile } from '@/engine/types';
import type { Localized } from '@/i18n/locale';

/**
 * Camera framings.
 *
 * A framing is given as the world-space top and bottom edge that must be
 * visible, and the distance is derived from those. Stating it that way keeps
 * the shot stable no matter how tall the avatar is or where its bones sit —
 * which is the whole point, since the two validation avatars differ in height
 * and in where their heads sit relative to the armature.
 */

export interface Framing {
  target: THREE.Vector3;
  position: THREE.Vector3;
  /** World height the framing shows: the distance between its two edges. */
  height: number;
  /**
   * Half the character's own width, in the same world units.
   *
   * Not part of the shot — the framings say nothing about width, by design.
   * It is here because a *placement* needs it: pulling the picture to the right
   * of the frame has to pull the character there, and the character is a narrow
   * thing in the middle of a wide picture. Without this the corner gets the
   * picture's edge and the character stays a quarter of a frame short of it.
   *
   * The resting silhouette, measured from the elbows — see where it is built,
   * where the two measurements that looked more obvious are written down along
   * with what each of them broke. An arm thrown out sideways goes past it and
   * is clipped by the edge of the frame, which is what an overlay looks like
   * anyway; sizing this to the full reach instead would make the box as wide as
   * the picture and hug nothing.
   */
  halfWidth: number;
}

export type Framings = Record<CameraFrame, Framing>;

export const CAMERA_FRAMES: readonly CameraFrame[] = ['face', 'bust', 'upper', 'full'];

export const CAMERA_LABELS: Record<CameraFrame, Localized> = {
  face: { en: 'Face', ja: '顔' },
  bust: { en: 'Bust', ja: 'バスト' },
  upper: { en: 'Upper body', ja: '上半身' },
  full: { en: 'Full body', ja: '全身' },
};

export function buildFramings(
  root: THREE.Object3D,
  profile: Profile,
  fovDegrees: number,
): Framings {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const worldOf = (b: THREE.Bone | undefined) => b?.getWorldPosition(new THREE.Vector3()) ?? null;
  const head = worldOf(profile.bones.head) ?? new THREE.Vector3(0, box.max.y - size.y * 0.09, 0);
  const chest = worldOf(profile.bones.chest) ?? new THREE.Vector3(0, head.y - size.y * 0.18, 0);
  const hips = worldOf(profile.bones.hips) ?? new THREE.Vector3(0, center.y, 0);
  const tan = Math.tan((fovDegrees * Math.PI) / 360);

  /**
   * Half the silhouette the character actually presents, standing.
   *
   * **Not the bounds of the file**, and not the shoulders either. Both were
   * tried on the two validation avatars and both are wrong by a lot:
   *
   * - The bounds are the bind pose, which is a T or an A and is never what is
   *   on screen: 1.11 across against 1.31 tall. Wider than the shot itself, so
   *   nothing was ever pulled anywhere.
   * - The shoulder joints sit close in on a stylised rig — 0.15 apart on both
   *   avatars — while what is actually widest in a bust shot is the *hair*, at
   *   0.49 on one and 0.70 on the other. Reading the shoulders under-measured
   *   by more than half and pushed the character clean off the frame.
   *
   * The elbows are the joint that lands near the edge of the silhouette, and
   * they agree to within a millimetre across both avatars (0.254 either side of
   * the midline). A quarter again covers the hair, which is what the number
   * below is: the one eye-judged figure in this file. **It errs wide on
   * purpose.** Too wide leaves the character a little short of the edge; too
   * narrow puts their hair off it, and one of those is a mistake anybody can
   * see.
   */
  const elbowL = worldOf(profile.bones['lowerArm.L']);
  const elbowR = worldOf(profile.bones['lowerArm.R']);
  const elbows = elbowL && elbowR ? Math.abs(elbowL.x - elbowR.x) / 2 : size.y * 0.19;
  const halfWidth = elbows * 1.4;

  const frame = (top: number, bottom: number, z = 0): Framing => {
    const centerY = (top + bottom) / 2;
    const dist = (top - bottom) / 2 / tan;
    return {
      target: new THREE.Vector3(center.x, centerY, z),
      position: new THREE.Vector3(center.x, centerY, z + dist),
      height: top - bottom,
      // The whole body's, at every framing including the ones no arm is in.
      // Erring wide only costs a little of the hug; erring narrow would pull a
      // shoulder off the edge of the frame, which is a visible mistake rather
      // than an approximate one.
      halfWidth,
    };
  };

  const crown = box.max.y; // includes hair and ears
  const headroom = size.y * 0.03;

  return {
    face: frame(crown + headroom * 0.5, head.y - size.y * 0.1, head.z),
    // Crown with headroom down past the chest. Wide enough that a raised hand
    // stays in shot, which is what the gestures are authored against.
    bust: frame(crown + headroom, chest.y - size.y * 0.17, head.z * 0.5),
    upper: frame(crown + headroom, hips.y - size.y * 0.05, 0),
    full: frame(crown + headroom, box.min.y - headroom, 0),
  };
}
