import { BASE_EXPORTS, type BaseExports } from './base';
import { MATH_EXPORTS, type MathExports } from './math';
import { SPRING_EXPORTS, type SpringExports } from './spring';
import { TRIANGLES_EXPORTS, type TrianglesExports } from './triangles';

/** Every name the wasm module must export, and no others. */
export const ABI_EXPORTS = [
  ...BASE_EXPORTS,
  ...MATH_EXPORTS,
  ...SPRING_EXPORTS,
  ...TRIANGLES_EXPORTS,
] as const;

export type CoreExports = BaseExports & MathExports & SpringExports & TrianglesExports;
export type Core = CoreExports;
