import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The mascot window's preload, built on its own.
 *
 * Electron loads a preload inside the renderer, where the TypeScript loader
 * the main process runs under does not reach, and a sandboxed renderer reads
 * CommonJS only. So this one file is compiled to a single `.cjs` with nothing
 * left to import but `electron`, which the sandbox provides.
 *
 * It writes beside the pages rather than over them: `vite build` empties
 * `dist/` and has to run first, which is the order `mascot:build` runs them in.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/mascot',
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./src/mascot/preload.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    rollupOptions: { external: ['electron'] },
  },
});
