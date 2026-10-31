import type * as THREE from 'three';
import { SIDES } from '../../../core/abi/profile';
import {
  LAYOUT_ANAT_AXIS_O,
  LAYOUT_ANAT_FWD,
  LAYOUT_ANAT_RIGHT,
  LAYOUT_ANAT_UP,
  LAYOUT_FACE,
  LAYOUT_RADIAL_SIGN,
} from '../../../core/abi/rig';
import type { FaceSurfaceSample } from '../../anatomy/face';
import type { Side } from '../../types';
import type { RigHandle } from './handle';
import { readVec, writeVec } from './records';
import { recordView, vector3View } from './views';

/** `rig.anat.face`: the face's skin, held by the core. */
export class CoreFaceSurface {
  readonly #rig: RigHandle;

  constructor(rig: RigHandle) {
    this.#rig = rig;
  }

  /** Follow the head to where it is posed now. Call before a run of face queries. */
  refresh(): void {
    this.#rig.run((c, h) => c.hd_rig_face_refresh(h));
  }

  /** How far short of `clear` outside the skin a world point is; see `FaceSurface.shortfall`. */
  shortfall(P: THREE.Vector3, clear: number, outward: THREE.Vector3): number {
    const r = this.#rig;
    const f = r.s();
    writeVec(f, r.scratch, outward);
    const short = r.direct((c, h) => c.hd_rig_face_shortfall(h, P.x, P.y, P.z, clear));
    readVec(f, r.scratch, outward);
    return short;
  }

  /** The signed plane distance and outward normal round `P`; see `FaceSurface.sample`. */
  sample(P: THREE.Vector3, out: FaceSurfaceSample): void {
    const r = this.#rig;
    r.direct((c, h) => c.hd_rig_face_sample(h, P.x, P.y, P.z));
    const f = r.s();
    const s = r.scratch;
    out.distance = f[s];
    out.normal.set(f[s + 1], f[s + 2], f[s + 3]);
    out.valid = f[s + 4] !== 0;
  }
}

/** `rig.anat`: the body frame motion reads live, and the queries it asks of the body. */
export class CoreArmAnatomy {
  readonly #rig: RigHandle;
  /** World-space body frame, refreshed by every call that updates the anatomy. */
  readonly up: THREE.Vector3;
  readonly fwd: THREE.Vector3;
  readonly right: THREE.Vector3;
  readonly #axisO: THREE.Vector3;
  /** Which of ±(palm × forearm) points at the thumb, per side. */
  readonly radialSign: Record<Side, number>;
  readonly #face: CoreFaceSurface | null;

  constructor(rig: RigHandle, layout: Uint32Array) {
    this.#rig = rig;
    this.right = vector3View(layout[LAYOUT_ANAT_RIGHT]);
    this.up = vector3View(layout[LAYOUT_ANAT_UP]);
    this.fwd = vector3View(layout[LAYOUT_ANAT_FWD]);
    this.#axisO = vector3View(layout[LAYOUT_ANAT_AXIS_O]);
    this.radialSign = recordView(layout[LAYOUT_RADIAL_SIGN], SIDES);
    this.#face = layout[LAYOUT_FACE] === 1 ? new CoreFaceSurface(rig) : null;
  }

  /** Trunk axis origin, world, per frame. */
  get axisO(): THREE.Vector3 {
    return this.#axisO;
  }

  /** The face's skin, for the fingers. */
  get face(): CoreFaceSurface | null {
    return this.#face;
  }

  /** Refresh the world-space body frame. Call once per frame, before measuring. */
  update(): boolean {
    return this.#rig.run((c, h) => c.hd_rig_anat_update(h)) === 1;
  }

  /** Move a world point out to the body's surface, in place; see `BodyVolumes.surface`. */
  surface(P: THREE.Vector3): number {
    const r = this.#rig;
    const f = r.s();
    writeVec(f, r.scratch, P);
    const depth = r.direct((c, h) => c.hd_rig_anat_surface(h));
    readVec(f, r.scratch, P);
    return depth;
  }
}
