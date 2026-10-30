/** Export names common to every build of the core. */
export const BASE_EXPORTS = ['hd_abi_version', 'hd_alloc', 'hd_free', 'memory'] as const;

export interface BaseExports {
  hd_abi_version(): number;
  hd_alloc(len: number): number;
  hd_free(ptr: number, len: number): void;
  memory: WebAssembly.Memory;
}
