/**
 * Motion — the body layer.
 *
 * `gestures.ts` is the table of what the character can do, `body.ts` plays it
 * on top of the idle, and `idle.ts`, `timing.ts`, `follow.ts`, `jump.ts` and
 * `gaze.ts` hold the parts that are answerable on their own: the idle's curves,
 * the time course of a deliberate movement, the filters that chase a target, an
 * arc, and the gaze wander.
 *
 * The one entry point for everything below the director.
 */

export type { ActiveGesture, BodyContext, PointCommand } from './body';
export { Body } from './body';
export { DirFollower, OMEGA_PER_RATE, ScalarFollower } from './follow';
export { Gaze } from './gaze';
export * from './gestures';
export { breathCurve, saturate, settle, smoothstep } from './idle';
export type { HopDef, HopId, HopSpec, JumpArc } from './jump';
export { HOP_IDS, HOPS, planJump, sampleJump } from './jump';
export { FINGER_ONSET, LINK_ONSET, minJerk, onset, reachEnvelope } from './timing';
