/**
 * The morph writes of one frame.
 *
 * The face is built up shape by shape — presets, emotions, overlays, the blink
 * — and several of them may name the same shape, so writes are gathered per
 * (mesh, index) first and only copied onto the meshes at the end.
 */

import type * as THREE from 'three';
import type { Profile } from '../types';

export class MorphFrame {
  /** mesh -> Map<index, value> for this frame; inner maps are emptied, not replaced */
  readonly #morphs = new Map<THREE.Mesh, Map<number, number>>();
  /** mesh -> Set<index> written last frame; emptied and refilled each frame */
  readonly #written = new Map<THREE.Mesh, Set<number>>();

  constructor(private readonly p: Pick<Profile, 'morphTargets'>) {}

  /** Start a frame: forget the values gathered for the last one. */
  begin(): void {
    for (const m of this.#morphs.values()) m.clear();
  }

  /**
   * Route a canonical shape name to every (mesh, index) that carries it.
   * A name can live on more than one mesh, so the profile hands back a list.
   */
  set(name: string | null | undefined, v: number): void {
    if (!name) return;
    const targets = this.p.morphTargets.get(name);
    if (!targets) return;
    const val = Math.min(1, v);
    for (const { mesh, index } of targets) {
      let m = this.#morphs.get(mesh);
      if (!m) {
        m = new Map();
        this.#morphs.set(mesh, m);
      }
      m.set(index, Math.max(m.get(index) ?? 0, val));
    }
  }

  /** Copy the gathered values onto the meshes. */
  flush(): void {
    // Clear exactly what was written last frame and nothing else. Wiping a
    // whole influence array would also erase the wardrobe's outfit-hide shapes,
    // which live on the same meshes but are owned by another layer.
    for (const [mesh, indices] of this.#written) {
      const infl = mesh.morphTargetInfluences;
      if (infl) for (const i of indices) infl[i] = 0;
      indices.clear();
    }
    for (const [mesh, values] of this.#morphs) {
      const infl = mesh.morphTargetInfluences;
      if (!infl || values.size === 0) continue;
      let indices = this.#written.get(mesh);
      if (!indices) {
        indices = new Set<number>();
        this.#written.set(mesh, indices);
      }
      for (const [i, v] of values) {
        infl[i] = v;
        indices.add(i);
      }
    }
  }
}
