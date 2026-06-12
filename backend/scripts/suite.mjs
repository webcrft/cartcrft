/**
 * suite.mjs — run a single named test suite via vitest.
 *
 * Usage (from repo root):   pnpm suite <name>
 * Usage (from backend/):    node scripts/suite.mjs <name>
 *
 * Maps <name> → backend/tests/suites/<name>.test.ts and forwards to vitest.
 * Extra vitest flags (e.g. --reporter verbose) can be appended after the name.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ → backend/
const backendRoot = resolve(__dirname, "..");

// argv: [node, scripts/suite.mjs, [--,] <name>, ...rest]
// pnpm may inject a `--` separator before the user's args; strip it.
const rawArgs = process.argv.slice(2).filter((a) => a !== "--");
const [name, ...rest] = rawArgs;

if (!name) {
  console.error("Usage: pnpm suite <name>");
  console.error("Example: pnpm suite smoke");
  process.exit(1);
}

const testFile = resolve(backendRoot, "tests", "suites", `${name}.test.ts`);

if (!existsSync(testFile)) {
  console.error(`Suite file not found: ${testFile}`);
  console.error(`Available suites are .ts files in backend/tests/suites/`);
  process.exit(1);
}

const vitestBin = resolve(backendRoot, "node_modules", ".bin", "vitest");
const configFile = resolve(backendRoot, "vitest.config.ts");

const result = spawnSync(
  vitestBin,
  ["run", testFile, "--config", configFile, ...rest],
  {
    stdio: "inherit",
    cwd: backendRoot,
  }
);

process.exit(result.status ?? 1);
