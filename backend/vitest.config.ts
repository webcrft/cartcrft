import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run in Node.js environment (no browser DOM).
    environment: "node",

    // Use forked child processes for true isolation between test files.
    // Vitest 3 uses "forks" as the pool by default; declared explicitly
    // so it is always clear and not accidentally overridden.
    pool: "forks",

    // Cap concurrent forks.  Each fork opens its own pg.Pool against the dev DB
    // and creates a per-run schema; unbounded forks exhausted Postgres
    // connections + advisory locks and leaked schemas (post-unification audit).
    // 4 keeps throughput while staying under the connection ceiling. Override
    // on the CLI with --poolOptions.forks.maxForks=N.
    poolOptions: {
      forks: { maxForks: 4, minForks: 1 },
    },

    // Sweep leaked `test_*` schemas before + after the whole run so a crashed
    // fork can't pollute the dev DB.
    globalSetup: ["./tests/shared/global-teardown.ts"],

    // Each test file gets its own process — no shared module-level state
    // bleeds between suites.
    isolate: true,

    // Generous timeout: ctx.ts boots Fastify + creates a Postgres schema +
    // runs migrations.  Real integration work takes time.
    testTimeout: 60_000,

    // Hook-level timeout (beforeAll / afterAll schema setup + teardown).
    hookTimeout: 60_000,

    // Only look for test files under backend/tests/suites/.
    // Colocated unit tests (*.test.ts next to source) will be added later
    // when Wave 2 service files land.
    include: ["tests/suites/**/*.test.ts"],

    // Silence noisy Fastify/pg logs during test runs unless VITEST_LOG=1.
    silent: process.env["VITEST_LOG"] !== "1",
  },
});
