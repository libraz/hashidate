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

/** `Math.tanh` with the core's result, the same on every host. */
export function tanh(x: number): number {
  return core().hd_math_tanh(x);
}

/** `Math.expm1` with the core's result, the same on every host. */
export function expm1(x: number): number {
  return core().hd_math_expm1(x);
}

/** `Math.exp` with the core's result, the same on every host. */
export function exp(x: number): number {
  return core().hd_math_exp(x);
}

/** `Math.log` with the core's result, the same on every host. */
export function log(x: number): number {
  return core().hd_math_log(x);
}

/** `Math.cbrt` with the core's result, the same on every host. */
export function cbrt(x: number): number {
  return core().hd_math_cbrt(x);
}

/** `Math.hypot(a, b)`, computed as V8 does, so it equals the host's on V8. */
export function hypot2(a: number, b: number): number {
  return core().hd_math_hypot2(a, b);
}

/** `Math.hypot(a, b, c)`, computed as V8 does, so it equals the host's on V8. */
export function hypot3(a: number, b: number, c: number): number {
  return core().hd_math_hypot3(a, b, c);
}

/** The double whose IEEE-754 bit pattern is `bits`; for constants that must not depend on the host's `Math`. */
export function float64FromBits(bits: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}
