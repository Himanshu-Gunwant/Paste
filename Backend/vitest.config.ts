import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Integration suites share PostgreSQL/Redis state (rate-limit buckets,
    // IP bans, view counters) — test FILES must not run concurrently.
    fileParallelism: false,
  },
});
