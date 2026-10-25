import * as THREE from 'three';
import { expect, it } from 'vitest';
import { SkeletonRefresh } from '@/engine/rig/skeleton';

/** A tree with every kind of node the refresh treats differently. */
function scene() {
  const outer = new THREE.Group();
  outer.position.set(0.4, -0.2, 0.1);
  const root = new THREE.Group();
  root.rotation.set(0.1, 0.5, -0.2);
  root.scale.setScalar(0.01);
  outer.add(root);
  const armature = new THREE.Object3D();
  armature.position.set(3, 1, -2);
  root.add(armature);
  const hips = new THREE.Bone();
  hips.position.set(0, 90, 0);
  armature.add(hips);
  const spine = new THREE.Bone();
  spine.position.set(0, 12, 1);
  hips.add(spine);
  // Parented under a bone, so it moves with the skeleton and has to be refreshed.
  const accessory = new THREE.Group();
  accessory.position.set(2, 3, 4);
  spine.add(accessory);
  const bones = [hips, spine];
  const skeleton = new THREE.Skeleton(bones);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
  // Beside the skeleton: never read by the rig, skipped.
  const beside = new THREE.SkinnedMesh(geometry);
  beside.position.set(-1, 0, 2);
  armature.add(beside);
  const layer = new THREE.Mesh(geometry);
  beside.add(layer);
  // A skinned mesh carrying a bone: refreshed whole, its bind inverse included.
  const carrier = new THREE.SkinnedMesh(geometry);
  carrier.position.set(0.5, 0.5, 0);
  root.add(carrier);
  const carried = new THREE.Bone();
  carried.position.set(1, 1, 1);
  carrier.add(carried);
  for (const mesh of [beside, carrier]) mesh.bind(skeleton);
  outer.updateMatrixWorld(true);
  return { root, armature, hips, spine, accessory, beside, layer, carrier, carried };
}

function state(objects: THREE.Object3D[]) {
  return objects.map((object) => [
    object.matrix.elements.slice(),
    object.matrixWorld.elements.slice(),
    object instanceof THREE.SkinnedMesh ? object.bindMatrixInverse.elements.slice() : [],
  ]);
}

function move(s: ReturnType<typeof scene>) {
  s.root.rotation.y += 0.3;
  s.armature.position.x -= 0.5;
  s.hips.quaternion.setFromEuler(new THREE.Euler(0.2, -0.1, 0.3));
  s.spine.position.z += 2;
  s.carrier.rotation.x += 0.4;
  s.carried.rotation.z -= 0.2;
}

it('leaves bones, their descendants and their ancestors exactly as a full root pass does', () => {
  const actual = scene();
  const reference = scene();
  const refresh = new SkeletonRefresh(actual.root);
  const fresh = (s: ReturnType<typeof scene>) => [
    s.root,
    s.armature,
    s.hips,
    s.spine,
    s.accessory,
    s.carrier,
    s.carried,
  ];
  const beside = (s: ReturnType<typeof scene>) => [s.beside, s.layer];
  for (let step = 0; step < 3; step++) {
    move(actual);
    move(reference);
    const stale = state(beside(actual));
    refresh.run();
    reference.root.updateMatrixWorld(true);
    expect(state(fresh(actual))).toEqual(state(fresh(reference)));
    // Holds no bone: left for the next full pass.
    expect(state(beside(actual))).toEqual(stale);
    actual.root.updateMatrixWorld(true);
    expect(state([...fresh(actual), ...beside(actual)])).toEqual(
      state([...fresh(reference), ...beside(reference)]),
    );
  }
});
