import type * as THREE from 'three';
import { TRI_FALSE, TRI_TRUE, TRI_UNSET } from '../../core/abi/rig';
import type { ArmAnatomy } from '../anatomy';
import type { JointTable, Profile, Side } from '../types';
import { readVec, sideCode, writeVec } from './records';

/**
 * Two-link reach geometry, run in the core over the rig `anat` belongs to.
 *
 * Functions rather than methods: none of this needs the rig's per-frame state,
 * only the profile's bones and lengths and the anatomy layer's world frame.
 * The profile and joint table they read are that rig's own, so `p` and
 * `joints` must be the ones the rig was built with.
 */

/**
 * The two links a plain reach determines. The elbow search scores candidates
 * that carry nothing else, so this is what `solveReach` is allowed to want.
 */
export interface ReachLinks {
  upperArm: THREE.Vector3;
  lowerArm: THREE.Vector3;
}

/**
 * A solved arm, as the motion layer holds it.
 *
 * Allocated by the caller and filled in place — one set per gesture slot, so an
 * outgoing reach and an incoming one can both be live during a crossfade.
 */
export interface ArmSolution extends ReachLinks {
  hand: THREE.Vector3;
  palm: THREE.Vector3;
  /** Where the fingertip actually ended up, for a caller checking it arrived. */
  tip: THREE.Vector3;
  twist: number;
  /** Anatomical strain of the solved pose, from a fingertip solve. */
  strain?: number;
  /**
   * Where the elbow search left this slot's elbow: the direction it stands off
   * the reach line, in the body frame (right, up, forward). Zero until the
   * slot's first solve.
   *
   * A direction rather than the swivel angle. The angle is measured from
   * `reachRef`, which changes its reference as the reach nears forward, and an
   * angle remembered across that change names a different elbow in the next
   * frame — the arm then swung a quarter turn to reach it.
   */
  swivelDir: THREE.Vector3;
  /** Set when the follower hand of a clasp was solved here rather than a plain reach. */
  clasp?: boolean;
}

/** `framed` as the core takes it: unset refreshes the frame, as an omitted argument does. */
function tri(framed: boolean | undefined): number {
  if (framed === undefined) return TRI_UNSET;
  return framed ? TRI_TRUE : TRI_FALSE;
}

/**
 * The zero-angle elbow reference for a reach along `n`, written into `perp`.
 *
 * Shared with `poleAngle` so that converting a pole point to an angle and
 * solving with it agree on where zero is. `framed` is the result of an
 * `anat.update()` the caller already made this frame; omitted, the frame is
 * refreshed here.
 */
export function reachRef(
  anat: ArmAnatomy,
  n: THREE.Vector3,
  perp: THREE.Vector3,
  framed?: boolean,
): THREE.Vector3 {
  const r = anat.handle;
  writeVec(r.s(), r.scratch, n);
  const t = tri(framed);
  r.run((c, h) => c.hd_rig_reach_ref(h, t));
  return readVec(r.s(), r.scratch + 3, perp);
}

/**
 * Solve a two-link reach so the wrist lands on `targetWorld`.
 *
 * Returns world-space directions for the arm chain rather than posing the
 * bones, so the result flows through exactly the same blending path as an
 * authored gesture. `elbowAngle` says where on the circle round the
 * shoulder-to-wrist line the elbow sits: zero puts it straight in front of the
 * chest; positive swings it outward and up. `framed` is as for `reachRef`.
 */
export function solveReach(
  _p: Profile,
  _joints: JointTable,
  anat: ArmAnatomy,
  side: Side,
  targetWorld: THREE.Vector3,
  elbowAngle: number,
  out: ReachLinks,
  framed?: boolean,
): ReachLinks | null {
  const r = anat.handle;
  const s = sideCode(side);
  const f = r.s();
  writeVec(f, r.scratch, targetWorld);
  writeVec(f, r.scratch + 3, out.upperArm);
  writeVec(f, r.scratch + 6, out.lowerArm);
  const t = tri(framed);
  const ok = r.run((c, h) => c.hd_rig_solve_reach(h, s, elbowAngle, t));
  readVec(r.s(), r.scratch + 3, out.upperArm);
  readVec(r.s(), r.scratch + 6, out.lowerArm);
  return ok === 1 ? out : null;
}

/**
 * The elbow angle that puts the elbow nearest a world-space pole point, in
 * `reachRef`'s reference. Null when the pole sits on the reach line, where it
 * says nothing, or the side has no upper arm.
 */
export function poleAngle(
  _p: Profile,
  anat: ArmAnatomy,
  side: Side,
  targetWorld: THREE.Vector3,
  poleWorld: THREE.Vector3,
): number | null {
  const r = anat.handle;
  const s = sideCode(side);
  const f = r.s();
  writeVec(f, r.scratch, targetWorld);
  writeVec(f, r.scratch + 3, poleWorld);
  const ok = r.run((c, h) => c.hd_rig_pole_angle(h, s));
  return ok === 1 ? r.s()[r.scratch + 6] : null;
}
