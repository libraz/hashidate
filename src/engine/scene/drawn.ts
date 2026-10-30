import * as THREE from 'three';

/**
 * Which of the avatar's objects count as what the avatar is seen as.
 *
 * Framing and focus measure the avatar, and both have to measure the same
 * thing: the geometry drawn in the worn state. An unworn garment is hidden by
 * the wardrobe and an outline hull is a shell around a mesh already counted, so
 * neither may move a shot or a focus.
 */

const _box = new THREE.Box3();

/** Whether `object` is avatar geometry in its own right, visibility aside. */
export function isAvatarGeometry(object: THREE.Object3D): boolean {
  return (object as THREE.Mesh).geometry !== undefined && object.userData.outline !== true;
}

/** Visit what `root` draws: avatar geometry with visible ancestry. */
export function forEachDrawn(root: THREE.Object3D, visit: (mesh: THREE.Mesh) => void): void {
  root.traverseVisible((object) => {
    if (isAvatarGeometry(object)) visit(object as THREE.Mesh);
  });
}

/**
 * The world-space bounds of what `root` draws (see {@link forEachDrawn}).
 * World matrices must be current. Empty when nothing is drawn.
 */
export function drawnBounds(root: THREE.Object3D, target = new THREE.Box3()): THREE.Box3 {
  target.makeEmpty();
  forEachDrawn(root, (object) => {
    // The object's own bounds only: its children are visited, and judged, in turn.
    const owner = object as THREE.Mesh & { boundingBox?: THREE.Box3 | null };
    if (owner.boundingBox !== undefined) {
      if (owner.boundingBox === null) (owner as THREE.SkinnedMesh).computeBoundingBox();
      _box.copy(owner.boundingBox as THREE.Box3);
    } else {
      if (owner.geometry.boundingBox === null) owner.geometry.computeBoundingBox();
      _box.copy(owner.geometry.boundingBox as THREE.Box3);
    }
    target.union(_box.applyMatrix4(object.matrixWorld));
  });
  return target;
}
