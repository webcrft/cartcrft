/**
 * Migration runner — mirrors webcrft-mono backend/cmd/migrate/main.go semantics:
 *
 *  1. Ensure schema_migrations(name text PK, applied_at timestamptz) exists.
 *  2. Read backend/migrations/*.sql, sort by filename.
 *  3. For each file not yet in schema_migrations:
 *       BEGIN; <file SQL>; INSERT INTO schema_migrations(name) VALUES ($1); COMMIT;
 *  4. Skip already-applied files (idempotent re-run).
 *  5. When CARTCRFT_CLOUD is set, also apply cloud/billing/migrations/*.sql after
 *     the backend migrations.  Cloud migration names are stored with a "cloud/"
 *     prefix (e.g. "cloud/0001_billing.sql") so they never collide with backend
 *     migration names.  The cloud package is dynamic-imported so the OSS build
 *     works with the cloud package absent.
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
 * Records the tracking name in schema_migrations on success.
 * The trackingName may differ from the filename when the file is from an
 * external package (e.g. "cloud/0001_billing.sql").
 * Throws on error (letting the caller abort).
 */
async function applyFile(
  pool: pg.Pool,
  filePath: string,
  trackingName: string
): Promise<void> {
  const sql = fs.readFileSync(filePath, "utf-8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (name) VALUES ($1)",
      [trackingName]
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
 * Resolve cloud billing migration paths via dynamic import of @cartcrft/cloud-billing.
 * Returns [] when the package is absent (OSS build) or CARTCRFT_CLOUD is unset.
 * Each entry is { filePath, trackingName } where trackingName has the "cloud/" prefix.
 */
async function getCloudMigrationEntries(): Promise<
  { filePath: string; trackingName: string }[]
> {
  if (!process.env["CARTCRFT_CLOUD"]) return [];

  let billingMigrations: () => string[];
  try {
    // Dynamic import keeps the OSS build clean when @cartcrft/cloud-billing is absent.
    const cloudBilling = await import("@cartcrft/cloud-billing" as never) as {
      billingMigrations: () => string[];
    };
    billingMigrations = cloudBilling.billingMigrations;
  } catch (err) {
    console.warn(
      "[migrate] CARTCRFT_CLOUD set but @cartcrft/cloud-billing unavailable:",
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }

  const paths = billingMigrations();
  return paths.map((filePath) => ({
    filePath,
    // e.g. /abs/path/migrations/0001_billing.sql → "cloud/0001_billing.sql"
    trackingName: `cloud/${path.basename(filePath)}`,
  }));
}

/**
 * Run all pending migrations.
 * When CARTCRFT_CLOUD is set, also applies cloud billing migrations after the
 * backend migrations.  Cloud names are stored with a "cloud/" prefix.
 * Returns the total number of migrations applied.
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

  // ── Backend migrations ─────────────────────────────────────────────────────
  const backendFiles = getMigrationFiles();
  const pendingBackend = backendFiles
    .filter((f) => !applied.has(f))
    .map((f) => ({ filePath: path.join(migrationsDir, f), trackingName: f }));

  // ── Cloud billing migrations (CARTCRFT_CLOUD only) ─────────────────────────
  const cloudEntries = await getCloudMigrationEntries();
  const pendingCloud = cloudEntries.filter(
    (e) => !applied.has(e.trackingName)
  );

  const pending = [...pendingBackend, ...pendingCloud];

  if (pending.length === 0) {
    console.log("[migrate] Everything up to date.");
    return 0;
  }

  console.log(`[migrate] ${pending.length} pending migration(s):`);
  for (const { filePath, trackingName } of pending) {
    process.stdout.write(`  → ${trackingName} ... `);
    await applyFile(pool, filePath, trackingName);
    console.log("ok");
  }
  console.log("[migrate] Done!");
  return pending.length;
}
