/**
 * Live three-shaped views over records the core's rig owns.
 *
 * A view's fields are accessors onto the wasm heap at a fixed f64 index, so the object the facade
 * hands out once keeps reading what the core last wrote, as the TS rig's own vectors and records
 * do. The heap is one module binding, rebuilt whenever an `allocating` call finds the memory grown;
 * no view holds a typed array of its own except `float64View`, whose arrays are rebuilt then too.
 */

import * as THREE from 'three';
import { core, onMemoryGrow } from '../../../core';
import { coreVector3 } from '../../../core/scene';

let heapBuffer: ArrayBufferLike | null = null;
let f64 = new Float64Array(0);

/** Points the module's heap at the current memory; a no-op when it has not grown. */
export function rebindHeap(): void {
  const { buffer } = core().memory;
  if (buffer === heapBuffer) return;
  heapBuffer = buffer;
  f64 = new Float64Array(buffer);
  for (const ref of float64Views) {
    const view = ref.deref();
    if (view) view.rebind();
    else float64Views.delete(ref);
  }
}

/** Throws when the memory grew outside `allocating`, which would leave every view reading zeros. */
export function checkHeap(): void {
  if (heapBuffer !== core().memory.buffer) {
    throw new Error('CoreRig: core memory grew outside allocating(); its views are stale');
  }
}

/** The heap as f64, for copying records in and out around a call. */
export function heap(): Float64Array {
  return f64;
}

onMemoryGrow(rebindHeap);

/** A `Vector3` over the VEC3 at byte address `address`. */
export function vector3View(address: number): THREE.Vector3 {
  return coreVector3(address / 8);
}

/** A real array of `n` numbers whose elements are accessors onto the heap. */
export function arrayView(address: number, n: number): number[] {
  const at = address / 8;
  const out: number[] = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    Object.defineProperty(out, k, {
      enumerable: true,
      get: () => f64[at + k],
      set: (v: number) => {
        f64[at + k] = v;
      },
    });
  }
  return out;
}

/** An object whose `keys` are accessors onto consecutive f64 from `address`, in that order. */
export function recordView<K extends string>(
  address: number,
  keys: readonly K[],
): Record<K, number> {
  const at = address / 8;
  const out = {} as Record<K, number>;
  for (const [k, key] of keys.entries()) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => f64[at + k],
      set: (v: number) => {
        f64[at + k] = v;
      },
    });
  }
  return out;
}

/** A `Matrix3` whose `elements` are the MAT3 at `address`, live. */
export function matrix3View(address: number): THREE.Matrix3 {
  const m = new THREE.Matrix3();
  m.elements = arrayView(address, 9) as THREE.Matrix3Tuple;
  return m;
}

/** A holder of a `Float64Array` over the heap, rebuilt when the memory grows. */
interface Float64View {
  rebind(): void;
}

const float64Views = new Set<WeakRef<Float64View>>();
const owned = new WeakMap<object, Float64View[]>();

/**
 * Defines `key` on `owner` as a `Float64Array` of `n` f64 at `address`, the subarray rebuilt after
 * the memory grows so the property always names the live record.
 */
export function float64View(owner: object, key: string, address: number, n: number): void {
  const at = address / 8;
  const view: Float64View = {
    rebind: () => {
      Object.defineProperty(owner, key, {
        configurable: true,
        enumerable: true,
        value: f64.subarray(at, at + n),
      });
    },
  };
  view.rebind();
  // The owner keeps its rebinders alive; a collected owner drops out of the set.
  const held = owned.get(owner) ?? [];
  held.push(view);
  owned.set(owner, held);
  float64Views.add(new WeakRef(view));
}
