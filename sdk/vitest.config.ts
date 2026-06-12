import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 200_000,
    include: ["tests/**/*.test.ts"],
    // Import TypeScript source directly — no need to build first
    typecheck: {
      enabled: false,
    },
  },
});
