/**
 * Anatomy — what a joint can do, and what the body it hangs on is in the way of.
 *
 * `joints.ts` is the table itself, `strain.ts` scores a value against it,
 * `volume.ts` measures a body part's surface off the mesh, and `volumes.ts`
 * assembles the trunk and the head from those measurements. `arm.ts` puts them
 * together for one arm: `measurement.ts` is the shape of what it reads off a
 * pose, and `cost.ts` turns that into strain, a search cost and a readout. See
 * `joints.ts` for why every degree of freedom carries two bands rather than one
 * bound.
 */

export { ArmAnatomy } from './arm';
export { buildBodyFrame } from './body-frame';
export { HAND_CONTACT, JOINTS, ZONES } from './joints';
export type { ArmMeasurement, ArmStrain } from './measurement';
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
export type { VolumeFrame } from './volumes';
