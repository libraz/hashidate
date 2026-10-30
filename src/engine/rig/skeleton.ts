import * as THREE from 'three';

const BASE_UPDATE_MATRIX_WORLD = THREE.Object3D.prototype.updateMatrixWorld;
const BASE_UPDATE_WORLD_MATRIX = THREE.Object3D.prototype.updateWorldMatrix;

/**
 * `root.updateMatrixWorld(true)` without the subtrees that hold no bone.
 *
 * Every bone, everything parented under one and every ancestor of one up to
 * `root` comes out exactly as the full pass would leave it: ancestors are
 * recomputed node by node top-down, then each topmost bone's subtree in full.
 * The skipped subtrees are, on a heavy avatar, mostly skinned meshes, each of
 * which also inverts a matrix per pass. Skipping them is exact only when nothing
 * has moved since the last full pass but bones, which is the caller's to know.
 *
 * The topology is captured once: nothing adds a bone after the profile is built.
 */
export class SkeletonRefresh {
  private readonly path: THREE.Object3D[] = [];
  private readonly subtrees: THREE.Object3D[] = [];

  constructor(root: THREE.Object3D) {
    this.path.push(root);
    for (const child of root.children) this.collect(child);
  }

  run(): void {
    for (const node of this.path) node.updateWorldMatrix(false, false, true);
    for (const node of this.subtrees) node.updateMatrixWorld(true);
  }

  /** Whether `node` holds a bone; ancestors land in `path` before their descendants. */
  private collect(node: THREE.Object3D): boolean {
    // A node with its own matrix-world step (a skinned mesh, a camera) is taken
    // whole, so its extra state is refreshed exactly as the full pass does it.
    // The class decides, not the instance: a core-backed node replaces both methods.
    const proto = Object.getPrototypeOf(node) as THREE.Object3D;
    if (
      (node as THREE.Bone).isBone ||
      proto.updateMatrixWorld !== BASE_UPDATE_MATRIX_WORLD ||
      proto.updateWorldMatrix !== BASE_UPDATE_WORLD_MATRIX
    ) {
      if (!this.holdsBone(node)) return false;
      this.subtrees.push(node);
      return true;
    }
    const at = this.path.length;
    this.path.push(node);
    let holds = false;
    for (const child of node.children) if (this.collect(child)) holds = true;
    if (!holds) this.path.length = at;
    return holds;
  }

  private holdsBone(node: THREE.Object3D): boolean {
    if ((node as THREE.Bone).isBone) return true;
    return node.children.some((child) => this.holdsBone(child));
  }
}
