import type * as THREE from 'three';
import { SIDES } from '../../core/abi/profile';
import {
  LAYOUT_ANAT_AXIS_O,
  LAYOUT_ANAT_FWD,
  LAYOUT_ANAT_RIGHT,
  LAYOUT_ANAT_UP,
  LAYOUT_FACE,
  LAYOUT_RADIAL_SIGN,
} from '../../core/abi/rig';
import type { RigHandle } from '../rig/handle';
import { readVec, writeVec } from '../rig/records';
import { recordView, vector3View } from '../rig/views';
import type { Side } from '../types';
import { FaceSurface } from './face';

/**
 * `rig.anat`: the body frame motion reads live, and the queries it asks of the body.
 *
 * Measurement and limiting run in the core; this holds the views motion reads and the two
 * queries it makes.
 */
export class ArmAnatomy {
  readonly #rig: RigHandle;
  /** World-space body frame, refreshed by every call that updates the anatomy. */
  readonly up: THREE.Vector3;
  readonly fwd: THREE.Vector3;
  readonly right: THREE.Vector3;
  readonly #axisO: THREE.Vector3;
  /** Which of ±(palm × forearm) points at the thumb, per side. */
  readonly radialSign: Record<Side, number>;
  readonly #face: FaceSurface | null;

  constructor(rig: RigHandle, layout: Uint32Array) {
    this.#rig = rig;
    this.right = vector3View(layout[LAYOUT_ANAT_RIGHT]);
    this.up = vector3View(layout[LAYOUT_ANAT_UP]);
    this.fwd = vector3View(layout[LAYOUT_ANAT_FWD]);
    this.#axisO = vector3View(layout[LAYOUT_ANAT_AXIS_O]);
    this.radialSign = recordView(layout[LAYOUT_RADIAL_SIGN], SIDES);
    this.#face = layout[LAYOUT_FACE] === 1 ? new FaceSurface(rig) : null;
  }

  /** @internal The rig this anatomy is read through, for the standalone reach functions. */
  get handle(): RigHandle {
    return this.#rig;
  }

  /** Trunk axis origin, world, per frame. */
  get axisO(): THREE.Vector3 {
    return this.#axisO;
  }

  /** The face's skin, for the fingers. */
  get face(): FaceSurface | null {
    return this.#face;
  }

  /** Refresh the world-space body frame. Call once per frame, before measuring. */
  update(): boolean {
    return this.#rig.run((c, h) => c.hd_rig_anat_update(h)) === 1;
  }

  /** Move a world point out to the body's surface, in place; returns how deep it was. */
  surface(P: THREE.Vector3): number {
    const r = this.#rig;
    const f = r.s();
    writeVec(f, r.scratch, P);
    const depth = r.direct((c, h) => c.hd_rig_anat_surface(h));
    readVec(f, r.scratch, P);
    return depth;
  }
}
