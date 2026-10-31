import { BASE_EXPORTS, type BaseExports } from './base';
import { MATH_EXPORTS, type MathExports } from './math';
import { PROFILE_EXPORTS, type ProfileExports } from './profile';
import { RIG_EXPORTS, type RigExports } from './rig';
import { SCENE_EXPORTS, type SceneExports } from './scene';
import { SPRING_EXPORTS, type SpringExports } from './spring';
import { TRIANGLES_EXPORTS, type TrianglesExports } from './triangles';

/** Every name the wasm module must export, and no others. */
export const ABI_EXPORTS = [
  ...BASE_EXPORTS,
  ...MATH_EXPORTS,
  ...SCENE_EXPORTS,
  ...SPRING_EXPORTS,
  ...TRIANGLES_EXPORTS,
  ...PROFILE_EXPORTS,
  ...RIG_EXPORTS,
] as const;

export type CoreExports = BaseExports &
  MathExports &
  SceneExports &
  SpringExports &
  TrianglesExports &
  ProfileExports &
  RigExports;
export type Core = CoreExports;
