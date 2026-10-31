import { defineConfig } from 'vitest/config';

// Pure engine unit tests only: no database, no network.
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.js'], passWithNoTests: true },
});
