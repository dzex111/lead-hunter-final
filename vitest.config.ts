import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'var/coverage',
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/types.ts'],
      thresholds: {
        lines: 85,
        functions: 80,
        statements: 85,
        branches: 70,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
});
