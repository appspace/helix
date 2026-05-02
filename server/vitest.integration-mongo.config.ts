import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/drivers/mongodb.integration.test.ts'],
    globalSetup: './src/test-setup/global-setup-mongo.ts',
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
