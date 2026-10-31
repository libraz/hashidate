import { allocating, core } from '../../core';
import type { Core } from '../../core/abi';
import type { SceneGraph } from '../../core/scene';
import { checkHeap, heap } from './views';

/**
 * One `hd_rig_new` handle and the scene graph it was made on, shared by the rig's facades.
 *
 * `run` is for every export that may read or move a node: it goes through the graph's ancestor
 * mirror, as the scene graph's own updates do, and through `allocating`. `direct` is for the ones
 * that touch only the rig's own state.
 */
export class RigHandle {
  #h: number;
  readonly graph: SceneGraph;
  /** f64 index of the rig's scratch. */
  readonly scratch: number;

  constructor(h: number, graph: SceneGraph, scratch: number) {
    this.#h = h;
    this.graph = graph;
    this.scratch = scratch;
  }

  /** The live handle; throws once the rig is freed. */
  get h(): number {
    if (this.#h === 0) throw new Error('Rig: used after dispose()');
    return this.#h;
  }

  /** Marks the handle freed. */
  release(): void {
    this.#h = 0;
  }

  get freed(): boolean {
    return this.#h === 0;
  }

  run<T>(fn: (c: Core, h: number) => T): T {
    const h = this.h;
    checkHeap();
    // The arm step solver lays out its rows on a side's first constrained call; see `abi/rig.ts`.
    return this.graph.run(() => allocating(() => fn(core(), h)));
  }

  direct<T>(fn: (c: Core, h: number) => T): T {
    const h = this.h;
    checkHeap();
    return fn(core(), h);
  }

  /** The heap, positioned for scratch writes: `s()[scratch + k]`. */
  s(): Float64Array {
    return heap();
  }
}
