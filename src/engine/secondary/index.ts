/**
 * Secondary motion: the sway solver and the one chain that is driven rather
 * than merely simulated.
 *
 * `Joint`, `Collider` and `SpringGroup` are exported as types only — they are
 * built by `Spring` and named by the layers that read it, never constructed
 * from outside.
 */

export type { Collider, Joint, SpringGroup } from './spring';
export { Spring } from './spring';
export { Tail } from './tail';
