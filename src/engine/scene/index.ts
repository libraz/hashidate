/**
 * Scene layer: everything that edits the loaded GLB in place.
 *
 * Materials fix what the export lost; the wardrobe decides which of the
 * avatar's meshes are on screen. Neither knows anything about one particular
 * avatar — both read the descriptor.
 */

export type { MaterialSet } from './materials';
export { setupMaterials } from './materials';
export { Wardrobe } from './wardrobe';
