import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SceneGraph } from '@/core/scene';
import { must } from '../helpers/must';
import { buildRig } from '../helpers/scene';

/**
 * `SceneGraph#drawScope`: inside it the root takes one forced update, run by the refresher in
 * place of the core's full pass, and each skeleton one `update`.
 */

const graphs: SceneGraph[] = [];

afterEach(() => {
  for (const graph of graphs.splice(0)) graph.dispose();
});

function mount() {
  const rig = buildRig();
  const scene = new THREE.Scene();
  scene.add(rig.root);
  const graph = SceneGraph.of(rig.root);
  graphs.push(graph);
  rig.root.updateMatrixWorld(true);
  const skeleton = must(rig.meshes.get('Body'), 'Body').skeleton;
  skeleton.computeBoneTexture();
  const head = must(rig.bones.get('Head'), 'Head');
  return { root: rig.root, graph, skeleton, head };
}

const copy = (m: THREE.Matrix4) => Array.from(m.elements);

describe('SceneGraph#drawScope', () => {
  it('runs the refresher for the first forced root update and nothing for later unforced ones', () => {
    const { root, graph } = mount();
    root.position.x += 0.5;
    const stale = copy(root.matrixWorld);
    const refresh = vi.fn();
    expect(graph.drawing).toBe(false);
    graph.drawScope(refresh, () => {
      expect(graph.drawing).toBe(true);
      root.updateMatrixWorld(true);
      root.updateMatrixWorld();
      root.updateMatrixWorld(false);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    // The core's pass did not run: the moved root is still where it was.
    expect(copy(root.matrixWorld)).toEqual(stale);
    expect(graph.drawing).toBe(false);
    root.updateMatrixWorld();
    expect(copy(root.matrixWorld)).not.toEqual(stale);
  });

  it('requires the first root update to be forced', () => {
    const { root, graph } = mount();
    const refresh = vi.fn();
    expect(() => graph.drawScope(refresh, () => root.updateMatrixWorld())).toThrow();
    expect(refresh).not.toHaveBeenCalled();
    expect(graph.drawing).toBe(false);
  });

  it('throws on a second forced root update', () => {
    const { root, graph } = mount();
    const refresh = vi.fn();
    expect(() =>
      graph.drawScope(refresh, () => {
        root.updateMatrixWorld(true);
        root.updateMatrixWorld(true);
      }),
    ).toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('passes the updates of every other node through', () => {
    const { graph, head } = mount();
    graph.drawScope(vi.fn(), () => {
      const before = copy(head.matrixWorld);
      head.position.y += 0.01;
      head.updateMatrixWorld(true);
      const moved = copy(head.matrixWorld);
      expect(moved).not.toEqual(before);
      head.position.y += 0.01;
      head.updateWorldMatrix(false, true);
      expect(copy(head.matrixWorld)).not.toEqual(moved);
    });
  });

  it('updates each skeleton once per scope and flags its bone texture once', () => {
    const { graph, skeleton, head } = mount();
    const texture = must(skeleton.boneTexture, 'bone texture');
    const version = texture.version;
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3);
    let first: number[] = [];
    graph.drawScope(vi.fn(), () => {
      skeleton.update();
      first = Array.from(must(skeleton.boneMatrices, 'bone matrices'));
      head.quaternion.multiply(turn);
      head.updateMatrixWorld(true);
      skeleton.update();
      expect(Array.from(must(skeleton.boneMatrices, 'bone matrices'))).toEqual(first);
    });
    expect(texture.version).toBe(version + 1);
    graph.drawScope(vi.fn(), () => {
      skeleton.update();
      skeleton.update();
    });
    expect(texture.version).toBe(version + 2);
    expect(Array.from(must(skeleton.boneMatrices, 'bone matrices'))).not.toEqual(first);
    skeleton.update();
    skeleton.update();
    expect(texture.version).toBe(version + 4);
  });

  it('closes when the draw throws', () => {
    const { root, graph } = mount();
    expect(() =>
      graph.drawScope(vi.fn(), () => {
        throw new Error('draw failed');
      }),
    ).toThrow('draw failed');
    expect(graph.drawing).toBe(false);
    const refresh = vi.fn();
    graph.drawScope(refresh, () => root.updateMatrixWorld(true));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not nest', () => {
    const { graph } = mount();
    expect(() => graph.drawScope(vi.fn(), () => graph.drawScope(vi.fn(), () => {}))).toThrow();
    expect(graph.drawing).toBe(false);
  });
});
