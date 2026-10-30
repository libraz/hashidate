import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { core, initCore } from '@/core';
import { ABI_EXPORTS } from '@/core/abi';
import { WASM_PATH } from '../../tools/rust-core/build';

describe('core loader', () => {
  it('reports ABI version 1', () => {
    expect(core().hd_abi_version()).toBe(1);
  });

  it('exports exactly the names the ABI lists', async () => {
    const module = new WebAssembly.Module(await readFile(WASM_PATH));
    const names = WebAssembly.Module.exports(module).map((e) => e.name);
    expect([...names].sort()).toEqual([...ABI_EXPORTS].sort());
  });

  it('does not grow memory across no-op calls', () => {
    const before = core().memory.buffer.byteLength;
    for (let i = 0; i < 1000; i++) core().hd_abi_version();
    expect(core().memory.buffer.byteLength).toBe(before);
  });

  it('does not call the loader again once initialised', async () => {
    await initCore(() => {
      throw new Error('loader must not be called');
    });
  });
});
