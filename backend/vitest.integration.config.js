import { defineConfig } from 'vitest/config';

// DB-backed tests. They skip themselves when DATABASE_URL_TEST is not set.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.js'],
    passWithNoTests: true,
    fileParallelism: false,
    testTimeout: 30000,
  },
});
