import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real MongoDB (see tests/helpers/server.ts),
 * because the behaviour worth testing here IS the database behaviour: the
 * unique partial index that enforces one live session per table, the
 * idempotency index, the atomic counters. A mocked driver would prove nothing.
 *
 * Therefore: one fork, no parallelism — the suites share one database.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // One worker, no file parallelism: the suites share a single database, and
    // the concurrency assertions must be the only concurrency in play.
    maxWorkers: 1,
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
