import { core } from './index';

/** `Math.sin` with the core's result, the same on every host. */
export function sin(x: number): number {
  return core().hd_math_sin(x);
}

/** `Math.cos` with the core's result, the same on every host. */
export function cos(x: number): number {
  return core().hd_math_cos(x);
}

/** `Math.acos` with the core's result, the same on every host. */
export function acos(x: number): number {
  return core().hd_math_acos(x);
}

/** `Math.asin` with the core's result, the same on every host. */
export function asin(x: number): number {
  return core().hd_math_asin(x);
}

/** `Math.atan2` with the core's result, the same on every host. */
export function atan2(y: number, x: number): number {
  return core().hd_math_atan2(y, x);
}

/** `Math.hypot(a, b, c)`, computed as V8 does, so it equals the host's on V8. */
export function hypot3(a: number, b: number, c: number): number {
  return core().hd_math_hypot3(a, b, c);
}
