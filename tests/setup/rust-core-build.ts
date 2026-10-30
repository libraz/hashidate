import { buildCore } from '../../tools/rust-core/build';

/** Build the wasm core once before any test file runs. */
export default function setup(): void {
  buildCore();
}
