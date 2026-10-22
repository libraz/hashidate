/**
 * Motion — the body layer.
 *
 * `gestures.ts` is the table of what the character can do, `body.ts` plays it
 * on top of the idle, and `idle.ts`, `timing.ts`, `follow.ts`, `jump.ts`,
 * `gaze.ts` and `prosody.ts` hold the parts that are answerable on their own:
 * the idle's curves, the time course of a deliberate movement, the filters that
 * chase a target, an arc, the gaze wander, and the phrase-final nods.
 *
 * The one entry point for everything below the director.
 */

export type { ActiveGesture, BodyContext, HeldAttitude, PointCommand } from './body';
export { Body } from './body';
export type { MotionArm, MotionDef, MotionFrame, MotionLoad, MotionRejection } from './custom';
export {
  clearMotions,
  compileMotion,
  gestureDef,
  gestureEntries,
  loadMotions,
} from './custom';
export { DirFollower, OMEGA_PER_RATE, ScalarFollower } from './follow';
export { Gaze } from './gaze';
export * from './gestures';
export { breathCurve, saturate, settle, smoothstep } from './idle';
export type { HopDef, HopId, HopSpec, JumpArc } from './jump';
export { HOP_IDS, HOPS, planJump, sampleJump } from './jump';
export type { BeatPlanOptions, HeadBeat } from './prosody';
export {
  HeadBeats,
  LATE_START,
  NOD_LEAD,
  NOD_LENGTH,
  NOD_PITCH,
  nodShape,
  planHeadBeats,
} from './prosody';
export { FINGER_ONSET, LINK_ONSET, minJerk, onset, reachEnvelope } from './timing';
