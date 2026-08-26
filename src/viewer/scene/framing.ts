import * as THREE from 'three';
import type { CameraFrame, Profile } from '@/engine/types';

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
}

export type Framings = Record<CameraFrame, Framing>;

export const CAMERA_FRAMES: readonly CameraFrame[] = ['face', 'bust', 'upper', 'full'];

export const CAMERA_LABELS: Record<CameraFrame, string> = {
  face: '顔',
  bust: 'バスト',
  upper: '上半身',
  full: '全身',
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

  const frame = (top: number, bottom: number, z = 0): Framing => {
    const centerY = (top + bottom) / 2;
    const dist = (top - bottom) / 2 / tan;
    return {
      target: new THREE.Vector3(center.x, centerY, z),
      position: new THREE.Vector3(center.x, centerY, z + dist),
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
