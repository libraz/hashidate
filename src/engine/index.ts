/**
 * The avatar runtime.
 *
 * Everything below `Director` is a layer: the profile resolves one avatar's
 * names into canonical slots, the rig owns the pose, the motion and face layers
 * decide what that pose is, and the secondary motion runs last. `Director` is
 * the only object that sees all of them, and `Session` is the turn-shaped API
 * an orchestrator drives it through.
 *
 * Import from here rather than from a file inside: the sub-barrels are the
 * layer boundaries, and this is the whole of what the runtime offers.
 */

export * from './anatomy';
export * from './cues';
export type { DirectorContext } from './director';
export { Director } from './director';
export * from './face';
export * from './motion';
export * from './performance';
export * from './profile';
export * from './rig';
export * from './scene';
export * from './secondary';
export type { PointOptions, SessionListener, SessionOptions, WearRequest } from './session';
export { Session } from './session';
export * from './types';
