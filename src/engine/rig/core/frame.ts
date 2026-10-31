import type * as THREE from 'three';
import { TRI_FALSE, TRI_TRUE, TRI_UNSET } from '../../../core/abi/rig';
import type { Side, Vec3Tuple } from '../../types';
import type { RigHandle } from './handle';
import { readTuple, readVec, sideCode, writeVec } from './records';

/** `frameReady` as the core takes it; unset, as `??` reads it, defaults as in TS. */
function tri(v: boolean | null | undefined): number {
  if (v === undefined || v === null) return TRI_UNSET;
  return v ? TRI_TRUE : TRI_FALSE;
}

/** `rig.characterFrame`: character space to world and back, over the core's anatomy. */
export class CoreCharacterFrame {
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
