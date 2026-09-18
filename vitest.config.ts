import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      all: true,
      include: [
        'packages/core/src/**/*.ts',
        'packages/gui/src/**/*.ts',
        'packages/cli/src/**/*.ts',
        'packages/web/src/**/*.{ts,tsx}',
      ],
      exclude: [
        'packages/**/src/**/*.d.ts',
        'packages/**/dist/**',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
