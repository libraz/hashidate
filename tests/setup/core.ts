import { readFile } from 'node:fs/promises';
import { initCore } from '@/core';
import { WASM_PATH } from '../../tools/rust-core/build';

await initCore(() => readFile(WASM_PATH));
