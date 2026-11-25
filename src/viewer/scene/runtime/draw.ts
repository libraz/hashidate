import type * as THREE from 'three';
import type { SceneGraph } from '@/core/scene';
import type { TransparentTriangleController } from '@/engine/scene/transparent-triangles';

/** What one frame's draw step needs; `graph` and `transparentTriangles` are null with no avatar standing. */
export interface DrawFrame {
  /** The standing avatar's graph, or null. */
  graph: SceneGraph | null;
  /** Brings the avatar's matrices up to date for the frame; runs in place of the root's full pass. */
  refresh: () => void;
  scene: THREE.Scene;
  camera: THREE.Camera;
  transparentTriangles: Pick<TransparentTriangleController, 'withDraw'> | null;
  draw: () => void;
}

/**
 * Draw one frame with the scene's matrices updated exactly once. The render does not update the
 * scene itself (`matrixWorldAutoUpdate` is off while `draw` runs), so this is the only place a
 * frame's matrices are brought up to date; with an avatar its root and skeletons are refreshed by
 * `refresh`, not by a full pass.
 */
export function drawFrame({
  graph,
  refresh,
  scene,
  camera,
  transparentTriangles,
  draw,
}: DrawFrame): void {
  if (graph && transparentTriangles) {
    graph.drawScope(refresh, () => {
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      transparentTriangles.withDraw(camera, () => drawUpdated(scene, draw));
    });
    return;
  }
  scene.updateMatrixWorld(true);
  drawUpdated(scene, draw);
}

/**
 * Run `draw` with the scene's own update switched off, and only then: outside a draw the flag
 * keeps three's default, which a skin-point anchor requires of every node above its root.
 */
function drawUpdated(scene: THREE.Scene, draw: () => void): void {
  scene.matrixWorldAutoUpdate = false;
  try {
    draw();
  } finally {
    scene.matrixWorldAutoUpdate = true;
  }
}
