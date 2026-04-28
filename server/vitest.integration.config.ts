import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    globalSetup: './src/test-setup/global-setup.ts',
    testTimeout: 15000,
    hookTimeout: 15000,
    // Run integration tests sequentially — each test shares the same DB connection
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
