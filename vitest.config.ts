import { defineConfig } from 'vitest/config'

import inventory from './scripts/real-test-inventory.json' with { type: 'json' }

const allTests = ['packages/*/tests/**/*.test.ts', 'packages/*/src/**/*.test.ts']
const realTests = inventory.map((row) => row.path)

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    passWithNoTests: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: allTests,
          exclude: [...realTests, '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'real-electron',
          include: realTests,
          fileParallelism: false,
          env: { STAGEWRIGHT_E2E: '1' },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/tests/**',
        // Executable doc/site generators (run as scripts, not exercised by the unit suite).
        'packages/core/src/manifest/gen-tool-reference.ts',
        'packages/core/src/snapshot/renderer-entry.ts',
        // Executable benchmark report drivers are validated through their commands and real
        // Electron runs; their process-level entrypoints are not unit-test targets.
        'packages/bench/src/run-manifest.ts',
        'packages/bench/src/run-profile-bench.ts',
      ],
      // Global floors, set a couple of points under the current numbers (stmts 87 / branch 80 /
      // funcs 87 / lines 89 as of this change) so an honest addition does not trip them but a real
      // regression does. Enforced by the `pnpm test:coverage` CI cell.
      thresholds: {
        statements: 85,
        branches: 77,
        functions: 84,
        lines: 87,
      },
    },
  },
})
