import type * as THREE from 'three';
import { TRI_FALSE, TRI_TRUE, TRI_UNSET } from '../../core/abi/rig';
import type { RigHandle } from '../rig/handle';
import { readTuple, readVec, sideCode, writeVec } from '../rig/records';
import type { Side, Vec3Tuple } from '../types';

/** `frameReady` as the core takes it; unset, as `??` reads it, defaults as in TS. */
function tri(v: boolean | null | undefined): number {
  if (v === undefined || v === null) return TRI_UNSET;
  return v ? TRI_TRUE : TRI_FALSE;
}

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
 * and the one thing that must not change underneath one. The projection runs in
 * the core, over the rig's anatomy; `rig.characterFrame` is this object.
 */

/** Lateral sign in the semantic character frame, independent of world yaw. */
export const sideMirror = (side: Side): number => (side === 'R' ? 1 : -1);

/** Axial rotation sign; it retains the shipped left/right twist orientation. */
export const rotationMirror = (side: Side): number => -sideMirror(side);

/** `rig.characterFrame`: character space to world and back, over the core's anatomy. */
export class CharacterFrame {
  readonly #rig: RigHandle;

  constructor(rig: RigHandle) {
    this.#rig = rig;
  }

  /** Whether the anatomical frame resolved this frame. */
  ready(): boolean {
    return this.#rig.run((c, h) => c.hd_rig_frame_ready(h)) === 1;
  }

  legacyMirror(side: Side): number {
    const s = sideCode(side);
    return this.#rig.direct((c, h) => c.hd_rig_frame_legacy_mirror(h, s));
  }

  axialMirror(side: Side, frameReady?: boolean): number {
    const s = sideCode(side);
    const ready = tri(frameReady);
    return this.#rig.run((c, h) => c.hd_rig_frame_axial_mirror(h, s, ready));
  }

  toWorld(
    out: THREE.Vector3,
    value: Vec3Tuple | THREE.Vector3,
    side: Side,
    lateral?: number,
    frameReady?: boolean,
  ): THREE.Vector3 {
    const r = this.#rig;
    const s = sideCode(side);
    const ready = tri(frameReady);
    writeVec(r.s(), r.scratch, value);
    r.run((c, h) =>
      c.hd_rig_frame_to_world(h, s, lateral === undefined ? 0 : 1, lateral ?? 0, ready),
    );
    return readVec(r.s(), r.scratch + 3, out);
  }

  tupleToWorld(
    out: Vec3Tuple,
    value: Vec3Tuple | THREE.Vector3,
    side: Side,
    lateral?: number,
    frameReady?: boolean,
  ): Vec3Tuple {
    const r = this.#rig;
    const s = sideCode(side);
    const ready = tri(frameReady);
    writeVec(r.s(), r.scratch, value);
    r.run((c, h) =>
      c.hd_rig_frame_tuple_to_world(h, s, lateral === undefined ? 0 : 1, lateral ?? 0, ready),
    );
    return readTuple(r.s(), r.scratch + 3, out);
  }

  toCharacter(
    out: THREE.Vector3,
    value: THREE.Vector3,
    side: Side,
    frameReady?: boolean,
  ): THREE.Vector3 {
    const r = this.#rig;
    const s = sideCode(side);
    const ready = tri(frameReady);
    writeVec(r.s(), r.scratch, value);
    r.run((c, h) => c.hd_rig_frame_to_character(h, s, ready));
    return readVec(r.s(), r.scratch + 3, out);
  }
}
