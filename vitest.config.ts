import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // `lcov` is what Codecov reads; `html` is what a local run is looked at
      // in. The default set adds clover and json, which nothing here consumes.
      reporter: ['text', 'html', 'lcov'],
      include: ['src/engine/**', 'src/protocol/**', 'src/server/hub.ts'],
    },
  },
});
