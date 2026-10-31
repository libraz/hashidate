/**
 * Anatomy — what a joint can do, and what the body it hangs on is in the way of.
 *
 * `joints.ts` is the table itself and the labels a reading is shown with. The
 * measurement and limiting run in the core; `arm.ts` and `face.ts` are the
 * views of it motion reads through `rig.anat`. What is read off the mesh at
 * load stays here: `volume.ts` measures a body part's surface, `face.ts` the
 * face's skin, and `body-frame.ts` the chest's frame. See `joints.ts` for why
 * every degree of freedom carries two bands rather than one bound.
 */

export { ArmAnatomy } from './arm';
export { buildBodyFrame } from './body-frame';
export {
  FINGER_WIDTH,
  HAND_CONTACT,
  INTERLACE_GAP,
  JOINTS,
  SPLAY_CAP,
  ZONES,
} from './joints';
export type { MeasuredVolume, VolumeExtent } from './volume';
export { measureVolume } from './volume';
