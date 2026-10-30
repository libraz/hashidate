import { readFile } from 'node:fs/promises';
import { initCore } from '../../src/core';
import { buildCore, WASM_PATH } from './build';

export { WASM_PATH };

/** Build the core and initialise it, for scripts that run outside vitest and the viewer. */
export async function loadCoreForNode(): Promise<void> {
  buildCore();
  await initCore(() => readFile(WASM_PATH));
}
