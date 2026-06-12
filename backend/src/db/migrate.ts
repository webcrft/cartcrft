/**
 * Migration runner — mirrors webcrft-mono backend/cmd/migrate/main.go semantics:
 *
 *  1. Ensure schema_migrations(name text PK, applied_at timestamptz) exists.
 *  2. Read backend/migrations/*.sql, sort by filename.
 *  3. For each file not yet in schema_migrations:
 *       BEGIN; <file SQL>; INSERT INTO schema_migrations(name) VALUES ($1); COMMIT;
 *  4. Skip already-applied files (idempotent re-run).
 *
 * Works whether or not any .sql files exist yet — a fresh run with an empty
 * migrations dir is a valid no-op.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getPool } from "./pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// src/db/ → src/ → backend/
const backendRoot = path.resolve(__dirname, "../..");
const migrationsDir = path.join(backendRoot, "migrations");

const TRACKING_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

/** Ensure the tracking table exists. */
async function ensureTrackingTable(client: pg.PoolClient): Promise<void> {
  await client.query(TRACKING_TABLE_DDL);
}

/** Return the set of already-applied migration names. */
async function getApplied(client: pg.PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ name: string }>(
    "SELECT name FROM schema_migrations"
  );
  return new Set(rows.map((r) => r.name));
}

/**
 * Return sorted list of .sql filenames from the migrations directory.
 * Returns [] if the directory doesn't exist or is empty.
 */
function getMigrationFiles(): string[] {
  if (!fs.existsSync(migrationsDir)) return [];
  const entries = fs.readdirSync(migrationsDir);
  return entries
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Apply a single migration file inside its own transaction.
 * Records the filename in schema_migrations on success.
 * Throws on error (letting the caller abort).
 */
async function applyFile(
  pool: pg.Pool,
  filename: string
): Promise<void> {
  const filePath = path.join(migrationsDir, filename);
  const sql = fs.readFileSync(filePath, "utf-8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (name) VALUES ($1)",
      [filename]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run all pending migrations.
 * Returns the number of migrations applied.
 */
export async function runMigrations(): Promise<number> {
  const pool = getPool();

  // Use a dedicated client for the tracking table setup + status check.
  const client = await pool.connect();
  let applied: Set<string>;
  try {
    await ensureTrackingTable(client);
    applied = await getApplied(client);
  } finally {
    client.release();
  }

  const files = getMigrationFiles();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log("[migrate] Everything up to date.");
    return 0;
  }

  console.log(`[migrate] ${pending.length} pending migration(s):`);
  for (const filename of pending) {
    process.stdout.write(`  → ${filename} ... `);
    await applyFile(pool, filename);
    console.log("ok");
  }
  console.log("[migrate] Done!");
  return pending.length;
}
