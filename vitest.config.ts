import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    passWithNoTests: true,
    include: ['packages/*/tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
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
