import type * as THREE from 'three';
import type { Rig } from '../rig';
import type { Profile, Side, Vec3Tuple } from '../types';

/**
 * The one boundary between the frame gestures are authored in and the frame the
 * rig is spoken to in.
 *
 * Everything above this is *character space* — x outward from the midline, y
 * up, z forward — which is what lets one authored gesture serve both arms on
 * any rig. Everything the rig is handed is world space. The conversion happens
 * here and nowhere else, and it goes both ways: a solver answers in world
 * directions and those have to come back before they are allowed to become
 * follower state, or a root turn would masquerade as a gesture change.
 *
 * The fallback path matters as much as the main one. A rig whose body frame the
 * profile could not resolve has no anatomical axes to project through, and then
 * these keep exactly the pre-frame world-X behaviour the profile's `sideSign`
 * describes — which is the behaviour every avatar had before there was a frame,
 * and the one thing that must not change underneath one.
 */

/** Lateral sign in the semantic character frame, independent of world yaw. */
export const sideMirror = (side: Side): number => (side === 'R' ? 1 : -1);

/** Axial rotation sign; it retains the shipped left/right twist orientation. */
export const rotationMirror = (side: Side): number => -sideMirror(side);

export class CharacterFrame {
  constructor(
    private readonly rig: Rig,
    private readonly p: Profile,
  ) {}

  /** Whether the anatomical frame resolved this frame. */
  ready(): boolean {
    return this.rig.anat.update();
  }

  /**
   * The profile's `sideSign` is only a fallback for a rig with no body frame.
   * Once anatomy has resolved, the lateral axis comes from the live chest and
   * therefore follows root yaw and every committed spine offset.
   */
  legacyMirror(side: Side): number {
    return side === 'L' ? this.p.sideSign : -this.p.sideSign;
  }

  /**
   * Sign for rotations about an arm axis. With a resolved body frame the
   * lateral semantic sign and the axial sign differ; without one, preserve the
   * profile's pre-frame convention exactly.
   */
  axialMirror(side: Side, frameReady?: boolean): number {
    const ready = frameReady ?? this.ready();
    return ready ? rotationMirror(side) : this.legacyMirror(side);
  }

  /**
   * Project a character-space direction into world space without touching the
   * authored tuple. `lateral` is normally the semantic side sign; a value of
   * one is used for an absolute point bearing. The fallback deliberately keeps
   * the old world-X behaviour when no anatomical frame can be resolved.
   */
  toWorld(
    out: THREE.Vector3,
    value: Vec3Tuple | THREE.Vector3,
    side: Side,
    lateral = sideMirror(side),
    frameReady?: boolean,
  ): THREE.Vector3 {
    const x = (Array.isArray(value) ? (value[0] ?? 0) : value.x) * lateral;
    const y = Array.isArray(value) ? (value[1] ?? 0) : value.y;
    const z = Array.isArray(value) ? (value[2] ?? 0) : value.z;
    const ready = frameReady ?? this.ready();
    if (ready) {
      const { anat } = this.rig;
      return out
        .copy(anat.right)
        .multiplyScalar(x)
        .addScaledVector(anat.up, y)
        .addScaledVector(anat.fwd, z)
        .normalize();
    }
    return out
      .set((Array.isArray(value) ? (value[0] ?? 0) : value.x) * -this.p.sideSign * lateral, y, z)
      .normalize();
  }

  /**
   * The tuple form of `toWorld`, for the world-space contract at the Rig
   * boundary. A separate buffer keeps `_armDirs` and `_palmOut` canonical.
   */
  tupleToWorld(
    out: Vec3Tuple,
    value: Vec3Tuple | THREE.Vector3,
    side: Side,
    lateral = sideMirror(side),
    frameReady?: boolean,
  ): Vec3Tuple {
    const x = (Array.isArray(value) ? (value[0] ?? 0) : value.x) * lateral;
    const y = Array.isArray(value) ? (value[1] ?? 0) : value.y;
    const z = Array.isArray(value) ? (value[2] ?? 0) : value.z;
    const ready = frameReady ?? this.ready();
    if (ready) {
      const { anat } = this.rig;
      out[0] = anat.right.x * x + anat.up.x * y + anat.fwd.x * z;
      out[1] = anat.right.y * x + anat.up.y * y + anat.fwd.y * z;
      out[2] = anat.right.z * x + anat.up.z * y + anat.fwd.z * z;
      return out;
    }
    out[0] = (Array.isArray(value) ? (value[0] ?? 0) : value.x) * -this.p.sideSign * lateral;
    out[1] = y;
    out[2] = z;
    return out;
  }

  /**
   * Bring a world-space solver result back into the canonical blend frame.
   * Solvers never write into the follower state directly: this inverse is the
   * one boundary where a world result becomes a character-space direction.
   */
  toCharacter(
    out: THREE.Vector3,
    value: THREE.Vector3,
    side: Side,
    frameReady?: boolean,
  ): THREE.Vector3 {
    const ready = frameReady ?? this.ready();
    if (ready) {
      const { anat } = this.rig;
      const x = value.dot(anat.right) * sideMirror(side);
      const y = value.dot(anat.up);
      const z = value.dot(anat.fwd);
      return out.set(x, y, z).normalize();
    }
    return out.set(value.x * this.legacyMirror(side), value.y, value.z).normalize();
  }
}
