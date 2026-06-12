import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run in Node.js environment (no browser DOM).
    environment: "node",

    // Use forked child processes for true isolation between test files.
    // Vitest 3 uses "forks" as the pool by default; declared explicitly
    // so it is always clear and not accidentally overridden.
    pool: "forks",

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
