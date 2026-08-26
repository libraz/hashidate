/**
 * Motion — the body layer.
 *
 * `gestures.ts` is the table of what the character can do, `body.ts` plays it
 * on top of the idle, and `idle.ts`, `jump.ts` and `gaze.ts` hold the parts
 * that are answerable on their own: curves, an arc, and the gaze wander.
 *
 * The one entry point for everything below the director.
 */

export type { ActiveGesture, BodyContext, PointCommand } from './body';
export { Body } from './body';
export { Gaze } from './gaze';
export * from './gestures';
export { breathCurve, saturate, settle, smoothstep } from './idle';
export type { JumpArc } from './jump';
export { planJump, sampleJump } from './jump';
