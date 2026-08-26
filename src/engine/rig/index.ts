/**
 * Bone layer.
 *
 * `Rig` owns the per-frame pose; `reach.ts` holds the two-link geometry it and
 * the motion layer share, and `finger-axes.ts` the once-at-load derivation of
 * which way a finger bends.
 */

export type { FingerAxes } from './finger-axes';
export { solveFingerAxes } from './finger-axes';
export type { ArmSolution, ReachLinks } from './reach';
export { poleAngle, reachRef, solveReach } from './reach';
export type { OffsetSlot, PointRequest } from './rig';
export { Rig } from './rig';
