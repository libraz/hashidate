import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SceneGraph } from '@/core/scene';
import { drawFrame } from '@/viewer/scene/runtime/draw';
import { must } from '../helpers/must';
import { buildRig } from '../helpers/scene';

/**
 * The draw step, without WebGL: the scene does not update itself while drawing, the avatar's root
 * is refreshed once by the refresher and each skeleton updates once however many passes draw it.
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
  return { scene, graph, skeleton, camera: new THREE.PerspectiveCamera() };
}

/** What `renderer.render` does with the scene, as far as matrices and skeletons go. */
const render = (scene: THREE.Scene, skeleton: THREE.Skeleton) => () => {
  if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
  skeleton.update();
  skeleton.update();
};

describe('drawFrame', () => {
  it('refreshes the root once and updates each skeleton once', () => {
    const { scene, graph, skeleton, camera } = mount();
    const texture = must(skeleton.boneTexture, 'bone texture');
    const version = texture.version;
    const calls: string[] = [];
    const refresh = vi.fn(() => calls.push('refresh'));
    const withDraw = vi.fn((_camera: THREE.Camera, draw: () => void) => {
      calls.push('withDraw');
      draw();
    });
    const inner = render(scene, skeleton);
    drawFrame({
      graph,
      refresh,
      scene,
      camera,
      transparentTriangles: { withDraw } as never,
      draw: () => {
        calls.push('draw');
        inner();
      },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(withDraw).toHaveBeenCalledWith(camera, expect.any(Function));
    expect(calls).toEqual(['refresh', 'withDraw', 'draw']);
    expect(texture.version).toBe(version + 1);
    expect(graph.drawing).toBe(false);
  });

  it('closes the scope when the draw throws', () => {
    const { scene, graph, camera } = mount();
    const transparentTriangles = { withDraw: (_c: THREE.Camera, draw: () => void) => draw() };
    expect(() =>
      drawFrame({
        graph,
        refresh: vi.fn(),
        scene,
        camera,
        transparentTriangles: transparentTriangles as never,
        draw: () => {
          throw new Error('draw failed');
        },
      }),
    ).toThrow('draw failed');
    expect(graph.drawing).toBe(false);
    expect(scene.matrixWorldAutoUpdate).toBe(true);
  });

  it("switches the scene's own update off for the draw only", () => {
    const { scene, graph, camera } = mount();
    const transparentTriangles = { withDraw: (_c: THREE.Camera, draw: () => void) => draw() };
    let during: boolean | null = null;
    drawFrame({
      graph,
      refresh: vi.fn(),
      scene,
      camera,
      transparentTriangles: transparentTriangles as never,
      draw: () => {
        during = scene.matrixWorldAutoUpdate;
      },
    });
    expect(during).toBe(false);
    // A skin-point anchor requires the default on every node above its root.
    expect(scene.matrixWorldAutoUpdate).toBe(true);
  });

  it('updates the scene explicitly before drawing when no avatar stands', () => {
    const scene = new THREE.Scene();
    const leaf = new THREE.Object3D();
    leaf.position.set(1, 2, 3);
    scene.add(leaf);
    const refresh = vi.fn();
    let seen: number[] = [];
    drawFrame({
      graph: null,
      refresh,
      scene,
      camera: new THREE.PerspectiveCamera(),
      transparentTriangles: null,
      draw: () => {
        seen = leaf.matrixWorld.elements.slice(12, 15);
      },
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(refresh).not.toHaveBeenCalled();
  });
});
