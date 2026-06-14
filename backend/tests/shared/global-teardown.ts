/**
 * Vitest globalSetup — sweeps leaked `test_*` schemas before AND after the run.
 *
 * Each suite creates an isolated `test_<runid>` schema and drops it in its own
 * afterAll (ctx.teardown).  But if a suite crashes before teardown — or a fork
 * is killed by the OOM/lock-exhaustion the audit flagged — the schema leaks and
 * pollutes the dev DB, eventually exhausting connections / locks on later runs.
 *
 * The default export runs ONCE before any suite (clean baseline) and the
 * function it returns runs ONCE after the entire run (final sweep across all
 * forks), so the dev DB always returns to a clean state.
 */

import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
dotenvConfig({ path: path.join(repoRoot, ".env"), override: false });

async function dropLeakedTestSchemas(label: string): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) return;

  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const { rows } = await client.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name LIKE 'test\\_%'`
    );
    for (const { schema_name } of rows) {
      // Identifier sourced from pg catalog (LIKE 'test_%'), not user input.
      await client.query(`DROP SCHEMA IF EXISTS "${schema_name}" CASCADE`);
    }
    if (rows.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[global-teardown:${label}] dropped ${rows.length} leaked test_* schema(s)`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[global-teardown:${label}] schema sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  await dropLeakedTestSchemas("pre");
  return async () => {
    await dropLeakedTestSchemas("post");
  };
}
