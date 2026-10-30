import type { Core, CoreExports } from './abi';

/** Typed-array windows onto the wasm linear memory. */
export interface CoreViews {
  f64: Float64Array;
  u32: Uint32Array;
  u8: Uint8Array;
}

let instance: Core | null = null;
let started: Promise<void> | null = null;
let cached: { buffer: ArrayBufferLike; views: CoreViews } | null = null;
let seen: ArrayBufferLike | null = null;
const growListeners = new Set<() => void>();

/**
 * Load and instantiate the wasm core. Later calls return the first call's promise
 * without invoking `load`.
 */
export function initCore(load: () => Promise<BufferSource> | BufferSource): Promise<void> {
  started ??= (async () => {
    const bytes = await load();
    const { instance: wasm } = await WebAssembly.instantiate(bytes, {});
    instance = wasm.exports as unknown as CoreExports;
  })();
  return started;
}

/** The instantiated core. Throws before `initCore` has resolved. */
export function core(): Core {
  if (!instance) throw new Error('core() called before initCore() resolved');
  return instance;
}

/** Views over the current linear memory, rebuilt whenever the memory has grown. */
export function views(): CoreViews {
  const { buffer } = core().memory;
  if (cached?.buffer !== buffer) {
    cached = {
      buffer,
      views: {
        f64: new Float64Array(buffer),
        u32: new Uint32Array(buffer),
        u8: new Uint8Array(buffer),
      },
    };
  }
  return cached.views;
}

/**
 * Registers `cb` to run after an `allocating` call finds that the memory has grown. Returns the
 * function that unregisters it.
 */
export function onMemoryGrow(cb: () => void): () => void {
  growListeners.add(cb);
  return () => growListeners.delete(cb);
}

/**
 * Runs an export that may allocate, then rebuilds the views and notifies `onMemoryGrow` listeners
 * if `memory.buffer` is no longer the one last seen. Every export that can grow the memory goes
 * through this, as `allocating(() => c.hd_x(...))`.
 */
export function allocating<T>(fn: () => T): T {
  const result = fn();
  const { buffer } = core().memory;
  if (buffer !== seen) {
    seen = buffer;
    views();
    for (const cb of growListeners) cb();
  }
  return result;
}

/**
 * Frees a core handle when its owner is collected without having been disposed. `free` runs from
 * the collector, in no fixed order relative to the other handles, so it must tolerate a handle
 * whose scene graph is already gone.
 */
export function handleFinalizer(free: (c: Core, handle: number) => void) {
  const registry = new FinalizationRegistry<number>((h) => allocating(() => free(core(), h)));
  return {
    /** Frees `handle` once `target` is collected, unless `unregister(token)` ran first. */
    register(target: object, handle: number, token: object = target): void {
      registry.register(target, handle, token);
    },
    unregister(token: object): void {
      registry.unregister(token);
    },
  };
}
