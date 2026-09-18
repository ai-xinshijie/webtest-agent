import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20000,
    restoreMocks: true,
  },
  coverage: {
    provider: 'v8',
    reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov'],
    reportsDirectory: 'coverage',
    include: ['packages/core/src/**/*.ts', 'packages/cli/src/**/*.ts'],
    exclude: ['**/*.d.ts'],
    thresholds: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
});
