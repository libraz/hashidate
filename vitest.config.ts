import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The sweeps: every gesture, every pose pair, played through the whole body at
 * several frame rates. They are a third of the suite's time uninstrumented and
 * five times that under coverage, which measures the engine at block level and
 * slows its hot loops accordingly — and they cover nothing the targeted tests
 * do not, so they run in a project of their own, outside the coverage pass.
 */
const SWEEPS = [
  'tests/engine/director-parity.test.ts',
  'tests/motion/body/arm-budget.test.ts',
  'tests/motion/body/cute.test.ts',
  'tests/motion/body/entrance.test.ts',
  'tests/motion/body/limits.test.ts',
  'tests/motion/body/unowned-arm.test.ts',
];

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    globalSetup: ['tests/setup/rust-core-build.ts'],
    setupFiles: ['tests/setup/core.ts'],
    // Timeouts catch a hang, and are not a budget. Under coverage the engine's
    // longest simulation took 22 s at three workers on an Apple core, and the
    // longest sweep 99 s uninstrumented; a CI runner is slower than both.
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...SWEEPS],
          testTimeout: 120_000,
        },
      },
      {
        resolve: { alias },
        test: { name: 'sweep', include: SWEEPS, testTimeout: 600_000 },
      },
    ],
    coverage: {
      provider: 'v8',
      // `lcov` is what Codecov reads; `html` is what a local run is looked at
      // in. The default set adds clover and json, which nothing here consumes.
      reporter: ['text', 'html', 'lcov'],
      include: [
        'src/engine/**',
        'src/protocol/**',
        'src/server/hub.ts',
        'src/server/event-log.ts',
        'src/server/take.ts',
      ],
    },
  },
});
