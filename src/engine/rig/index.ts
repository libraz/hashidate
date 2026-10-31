/**
 * Bone layer.
 *
 * `Rig` owns the per-frame pose, run in the core; `reach.ts` holds the two-link
 * geometry it and the motion layer share, and `finger-axes.ts` the hinge axes
 * the rig derived from the rest pose.
 */

export type { FingerAxes } from './finger-axes';
export { solveFingerAxes } from './finger-axes';
export { handFrame, mkFingerSpread } from './hands';
export type { ArmSolution, ReachLinks } from './reach';
export { poleAngle, reachRef, solveReach } from './reach';
export type { OffsetSlot, PointRequest } from './rig';
export { Rig } from './rig';
