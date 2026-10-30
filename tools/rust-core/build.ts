import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BUILT = resolve(ROOT, 'target/wasm32-unknown-unknown/release/hashidate_wasm.wasm');

/** Where the viewer and the tests load the core from. */
export const WASM_PATH = resolve(ROOT, 'src/core/generated/hashidate.wasm');

/** Compile the wasm crate and copy the module to `WASM_PATH`. */
export function buildCore(): void {
  const result = spawnSync(
    'cargo',
    ['build', '-p', 'hashidate-wasm', '--release', '--target', 'wasm32-unknown-unknown'],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    throw new Error(
      'cargo not found: install Rust with rustup (https://rustup.rs); rust-toolchain.toml pins the version',
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo build failed with status ${result.status}`);

  const next = readFileSync(BUILT);
  if (existsSync(WASM_PATH) && readFileSync(WASM_PATH).equals(next)) return;
  mkdirSync(dirname(WASM_PATH), { recursive: true });
  copyFileSync(BUILT, WASM_PATH);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildCore();
