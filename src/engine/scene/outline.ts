import * as THREE from 'three';

/**
 * The inverted-hull outline, as a child mesh of the mesh it outlines.
 *
 * The child shares the parent's geometry, skeleton and morph arrays by
 * reference, so it deforms with the body without a second copy of anything and
 * inherits the wardrobe's visibility through the scene graph. It is a child
 * rather than an extra geometry group because the material toggle swaps a
 * mesh's whole material array, and a group the imported set has no slot for
 * would leave that array a slot short.
 */

/** Fills a group that has no outline; never drawn, shared by every avatar, never disposed. */
export const OUTLINE_HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

/**
 * Build the outline child for `mesh`, one material per material slot.
 *
 * `outlineMaterials` is indexed like the mesh's material array (or holds one
 * entry for a single-material mesh); `null` marks a slot with no outline.
 * Returns null when no slot has one. The caller adds the child.
 */
export function buildOutlineChild(
  mesh: THREE.Mesh,
  outlineMaterials: (THREE.Material | null)[],
): THREE.Mesh | null {
  if (outlineMaterials.every((m) => m === null)) return null;
  const filled = outlineMaterials.map((m) => m ?? OUTLINE_HIDDEN);
  const material = Array.isArray(mesh.material) ? filled : filled[0];

  let child: THREE.Mesh;
  if (mesh instanceof THREE.SkinnedMesh) {
    const skinned = new THREE.SkinnedMesh(mesh.geometry, material);
    // Same bind as the parent; at an identity local transform the attached
    // mode's per-frame inverse then matches the parent's too.
    skinned.bindMode = mesh.bindMode;
    skinned.bind(mesh.skeleton, mesh.bindMatrix);
    child = skinned;
  } else {
    child = new THREE.Mesh(mesh.geometry, material);
  }
  // The same arrays, so a weight written to the body moves the hull with it.
  child.morphTargetInfluences = mesh.morphTargetInfluences;
  child.morphTargetDictionary = mesh.morphTargetDictionary;
  child.castShadow = false;
  child.receiveShadow = false;
  child.frustumCulled = false;
  child.name = `${mesh.name}#outline`;
  child.userData.outline = true;
  return child;
}
