import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/drivers/postgres.integration.test.ts'],
    globalSetup: './src/test-setup/global-setup-postgres.ts',
    testTimeout: 15000,
    hookTimeout: 15000,
    // vitest 4 removed poolOptions.forks.singleFork; these replace it.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
  },
});
