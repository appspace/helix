import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    globalSetup: './src/test-setup/global-setup.ts',
    testTimeout: 15000,
    hookTimeout: 15000,
    // Run all tests in one process to share module-level state (app, raw conn)
    // and prevent concurrent writes from racing between tests.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
