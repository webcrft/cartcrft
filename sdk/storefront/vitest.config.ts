import { defineConfig } from "vitest/config";

/**
 * Storefront SDK test config. Tests live alongside source in src/ (the IIFE is
 * not built before testing — TS source is imported directly). A local config is
 * required so this package doesn't inherit the parent sdk/ config whose include
 * is scoped to tests/**.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    typecheck: { enabled: false },
  },
});
