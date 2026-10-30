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
