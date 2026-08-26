/**
 * Anatomy — what a joint can do, and what the body it hangs on is in the way of.
 *
 * `joints.ts` is the table itself, `strain.ts` scores a value against it,
 * `volume.ts` measures a body part's surface off the mesh, and `arm.ts` puts
 * the three together for one arm. See `joints.ts` for why every degree of
 * freedom carries two bands rather than one bound.
 */

export type { ArmMeasurement, ArmStrain, VolumeFrame } from './arm';
export { ArmAnatomy } from './arm';
export { buildBodyFrame } from './body-frame';
export { HAND_CONTACT, JOINTS, ZONES } from './joints';
export type { ElevationCeiling } from './strain';
export {
  clampDof,
  elevationCeiling,
  elevationStrain,
  excessOf,
  fingerCurl,
  rollRoom,
  strainOf,
  zoneOf,
} from './strain';
export type { MeasuredVolume, VolumeExtent } from './volume';
export { measureVolume, surfaceOf } from './volume';
