import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'apps/mobile/**'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
