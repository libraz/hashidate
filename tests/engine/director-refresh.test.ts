import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { buildOutlineChild } from '@/engine/scene/outline';
import { must } from '../helpers/must';
import { addBoneChain, addRigidMesh, buildRig } from '../helpers/scene';

/**
 * The director's frame takes one full pass over the avatar root, the legs' plant, and refreshes
 * the scene for the spring's world reads with the skeleton alone.
 */

const DT = 1 / 60;

function fixture() {
  const rig = buildRig({ legs: true });
  addBoneChain(rig, { parent: 'Head', root: 'Hair', joints: 3 });
  const charm = addRigidMesh(rig, 'Hand_L', 'Charm');
  const descriptor = {
    ...rig.descriptor,
    sway: { groups: [{ id: 'Hair', roots: ['Hair'], stiffness: 1.2, drag: 0.5, gravity: 0.08 }] },
  };
  const director = new Director(buildProfile(rig.root, descriptor));
  director.auto = false;
  director.blinkEnabled = false;
  // Outlines are added once the graph exists, so they stay plain leaves.
  const material = new THREE.MeshBasicMaterial();
  const leaves = [charm, must(rig.meshes.get('Body'), 'Body')].map((mesh) => {
    const leaf = must(buildOutlineChild(mesh, [material]), `${mesh.name} outline`);
    mesh.add(leaf);
    return leaf;
  });
  // The viewer's first full pass places the leaves.
  rig.root.updateMatrixWorld(true);
  return { rig, director, charm, leaves };
}

function bits(values: ArrayLike<number>): string {
  return [...new BigUint64Array(Float64Array.from(values).buffer)]
    .map((b) => b.toString(16))
    .join(',');
}

/** Every node's matrices and needs-update flag, plain leaves and skinned bind inverses included. */
function state(root: THREE.Object3D): string[] {
  const out: string[] = [];
  root.traverse((node) => {
    out.push(
      `${node.name}|${bits(node.matrix.elements)}|${bits(node.matrixWorld.elements)}|${node.matrixWorldNeedsUpdate}`,
    );
    const mesh = node as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) out.push(bits(mesh.bindMatrixInverse.elements));
  });
  return out;
}

describe('Director frame refresh', () => {
  it('runs no full core update of the root in a frame', () => {
    const { rig, director } = fixture();
    director.update(DT);
    const spy = vi.spyOn(rig.root, 'updateMatrixWorld');
    for (let k = 0; k < 3; k++) director.update(DT);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('leaves the scene as a full pass would after the spring pre-pass', () => {
    const { rig, director, charm, leaves } = fixture();
    const refresh = director.refreshScene.bind(director);
    const charmAt: string[] = [];
    let checked = 0;
    const spy = vi.spyOn(director, 'refreshScene').mockImplementation(() => {
      refresh();
      const refreshed = state(rig.root);
      rig.root.updateMatrixWorld(true);
      expect(state(rig.root)).toEqual(refreshed);
      charmAt.push(bits(leaves[0].matrixWorld.elements));
      checked++;
    });
    director.perform('hello', 'L');
    for (let k = 0; k < 30; k++) director.update(DT);
    spy.mockRestore();
    expect(checked).toBe(30);
    // The outline followed its bone rather than standing still.
    expect(new Set(charmAt).size).toBeGreaterThan(1);
    expect(charm.children).toContain(leaves[0]);
  });
});
