import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Load .env from repo root via a setup file
    setupFiles: [path.resolve(__dirname, 'src/test-setup.ts')],
    // Include both src tests (unit) and tests/ directory (lifecycle/integration)
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Generous timeouts for DB integration tests
    hookTimeout: 60_000,
    testTimeout: 30_000,

    // Cap concurrent forks.  Each integration suite creates a per-run schema
    // with the full ~60-table billing/commerce DDL; dropping several at once
    // (DROP SCHEMA CASCADE) under the default max_locks_per_transaction (64)
    // exhausted shared lock memory ("out of shared memory") during teardown.
    // Bounding forks keeps concurrent lock pressure under that ceiling.
    pool: 'forks',
    poolOptions: {
      forks: { maxForks: 4, minForks: 1 },
    },
  },
});
