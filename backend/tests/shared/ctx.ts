/**
 * Test context — mirrors the spirit of webcrft-mono/backend/tests/shared/ctx.go.
 *
 * `createCtx()` boots the REAL Fastify app on an ephemeral port against the
 * DATABASE_URL from the repo-root .env, creates a fresh Postgres schema
 * `test_<runid>`, runs migrations into that schema, and returns:
 *
 *   baseUrl   — http://127.0.0.1:<port>
 *   request   — typed HTTP helper
 *   pool      — pg.Pool scoped to the test schema (for fixture inserts)
 *   teardown  — drops the test schema and closes the app + pool
 *
 * Schema isolation mechanism:
 *   1. A unique schema `test_<8-hex-runid>` is created for each test run.
 *   2. The connection string is modified to include `options=-csearch_path=<schema>`
 *      so every connection in the pool automatically uses the test schema for
 *      unqualified table references.
 *   3. Migration SQL is rewritten: `public.table` → `"<schema>".table` so that
 *      explicitly-qualified DDL also lands in the test schema.
 *   4. `teardown` issues `DROP SCHEMA … CASCADE` so the dev DB stays clean.
 *
 * Missing migrations:
 *   If backend/migrations/ is empty the runner is a no-op — the smoke suite
 *   passes before Wave 1 migrations land.
 *
 * Hook into backend/src:
 *   pool.ts exports `setPoolForTesting(pool)` (added by T0.3) so the harness
 *   can inject the search_path-scoped pool without accessing private state.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import pg from "pg";
import type { FastifyInstance } from "fastify";

// ── Load repo-root .env (tests run outside the normal config boot path) ──────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// tests/shared/ → tests/ → backend/ → repo root
const repoRoot = path.resolve(__dirname, "../../..");
const backendRoot = path.resolve(__dirname, "../..");
dotenvConfig({ path: path.join(repoRoot, ".env"), override: false });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RequestResult {
  status: number;
  body: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic response map
  json: Record<string, any>;
}

export interface TestCtx {
  /** Full base URL of the running test server, e.g. http://127.0.0.1:54321 */
  baseUrl: string;

  /**
   * Make an HTTP request to the test server.
   * Content-Type: application/json is set automatically when body is provided.
   */
  request(opts: RequestOptions): Promise<RequestResult>;

  /** pg.Pool connected to the DATABASE_URL with search_path set to the test schema. */
  pool: pg.Pool;

  /** Drop the test schema and shut down the app + pool. Call in afterAll. */
  teardown(): Promise<void>;
}

// ── Connection string helper ──────────────────────────────────────────────────

/**
 * Return a modified connection string that sets `search_path` to the given
 * schema name for every new connection.
 *
 * Approach: append `options=-csearch_path=<schema>` to the URL query string.
 * This is the libpq options parameter — works on Postgres, Neon, Supabase.
 *
 * Example:
 *   input:  postgresql://...?sslmode=require
 *   output: postgresql://...?sslmode=require&options=-csearch_path=test_abc123
 */
function withSearchPath(connectionString: string, schemaName: string): string {
  // Set search_path so that:
  //  1. Unqualified table names land in the test schema (first in path).
  //  2. Extension functions (pgcrypto.gen_random_bytes, etc.) are found via
  //     `public`, where Postgres installs extensions by default.
  // The libpq options format is `-csearch_path=<value>`.
  const searchPath = `${schemaName},public`;
  const optionsValue = encodeURIComponent(`-csearch_path=${searchPath}`);
  const sep = connectionString.includes("?") ? "&" : "?";
  return `${connectionString}${sep}options=${optionsValue}`;
}

// ── Test migration runner ─────────────────────────────────────────────────────

/**
 * A test-local migration runner that:
 *  1. Creates the schema_migrations tracking table in the test schema.
 *  2. Reads .sql files from backend/migrations/ in sorted order.
 *  3. Rewrites `public.` → `"<schemaName>".` in each SQL file so explicitly-
 *     qualified DDL (`public.stores`) lands in the isolated test schema.
 *  4. Skips files already recorded in the test schema's schema_migrations.
 *  5. Returns the count of migrations applied.
 *
 * This is separate from the production migrate.ts runner (which we keep
 * clean).  The production runner is called for the idempotency smoke test.
 */
async function runMigrationsForTest(
  pool: pg.Pool,
  schemaName: string
): Promise<number> {
  const migrationsDir = path.join(backendRoot, "migrations");

  // Ensure the tracking table exists in the test schema.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations"
  );
  const applied = new Set(rows.map((r) => r.name));

  // Enumerate pending .sql files.
  if (!fs.existsSync(migrationsDir)) return 0;
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) return 0;

  for (const filename of pending) {
    const raw = fs.readFileSync(path.join(migrationsDir, filename), "utf-8");

    // ── SQL transformations for test-schema isolation ────────────────────

    // 1. Rewrite `public.identifier` → `"<schemaName>".identifier` so that
    //    explicitly-qualified DDL lands in the test schema.
    //    Covers `public.foo`, `public."foo"`, `public.set_updated_at()` etc.
    let sql = raw.replace(/\bpublic\./gi, `"${schemaName}".`);

    // 2. Ensure extensions are created in public schema, not in the test
    //    schema.  `CREATE EXTENSION IF NOT EXISTS <name>` without a SCHEMA
    //    clause installs into search_path's first schema (our test schema),
    //    which causes the extension to be dropped at teardown, breaking
    //    subsequent test runs.  We add `SCHEMA public` to pin them.
    //
    //    Pattern: CREATE EXTENSION IF NOT EXISTS name (no SCHEMA clause)
    //    We match inside DO-blocks too (case-insensitive, single-line).
    sql = sql.replace(
      /\bcreate\s+extension\s+if\s+not\s+exists\s+(\w+)(?!\s+SCHEMA)/gi,
      "CREATE EXTENSION IF NOT EXISTS $1 SCHEMA public"
    );

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
      throw new Error(
        `[test-migrate] ${filename} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      client.release();
    }
  }

  return pending.length;
}

// ── Public factory ─────────────────────────────────────────────────────────────

/**
 * Create a fully isolated test context.
 *
 * Call once per suite in `beforeAll` and call `ctx.teardown()` in `afterAll`.
 *
 * @example
 * ```ts
 * import { createCtx } from '../shared/ctx.js';
 * import type { TestCtx } from '../shared/ctx.js';
 *
 * let ctx: TestCtx;
 * beforeAll(async () => { ctx = await createCtx(); });
 * afterAll(async () => { await ctx.teardown(); });
 * ```
 */
export async function createCtx(): Promise<TestCtx> {
  const maybeDatabaseUrl = process.env["DATABASE_URL"];
  if (!maybeDatabaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Is the repo-root .env file present?"
    );
  }
  // Narrowed to string; captured by closures below.
  const databaseUrl: string = maybeDatabaseUrl;

  // ── 1. Generate a unique schema name ─────────────────────────────────────
  const runId = randomBytes(4).toString("hex"); // e.g. "a3f7c2d1"
  const schemaName = `test_${runId}`;

  // ── 2. Create the schema via a direct client ─────────────────────────────
  const adminClient = new pg.Client({ connectionString: databaseUrl });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  } finally {
    await adminClient.end();
  }

  // ── 3. Build the test pool with search_path baked into the connection URL ──
  //
  // Using `options=-csearch_path=<schema>` in the connection string is the
  // most reliable approach — it applies at the protocol level and works for
  // all query paths (pool.query, pool.connect, client.query).
  const testConnStr = withSearchPath(databaseUrl, schemaName);
  const testPool = new pg.Pool({
    connectionString: testConnStr,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

  // ── 4. Inject the test pool into the app's pool singleton ─────────────────
  //
  // pool.ts exports `setPoolForTesting` for exactly this purpose (T0.3 hook).
  // Must happen BEFORE buildApp() so all app code uses the test-scoped pool.
  const { setPoolForTesting, closePool } = await import(
    "../../src/db/pool.js"
  );
  setPoolForTesting(testPool);

  // ── 5. Run migrations into the test schema ────────────────────────────────
  //
  // Uses the test-local runner which rewrites `public.` qualifiers and
  // populates the test schema's schema_migrations table.
  // No-op if backend/migrations/ is empty (Wave 0).
  try {
    await runMigrationsForTest(testPool, schemaName);
  } catch (err) {
    await _dropSchema(databaseUrl, schemaName);
    await testPool.end();
    throw err;
  }

  // ── 6. Boot the Fastify app on an ephemeral port ─────────────────────────
  process.env["APP_ENV"] = "test";

  let app: FastifyInstance;
  let baseUrl: string;
  try {
    const { buildApp } = await import("../../src/http/app.js");
    app = await buildApp();
    // port 0 → OS picks an ephemeral port; returns "http://127.0.0.1:<port>"
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  } catch (err) {
    await _dropSchema(databaseUrl, schemaName);
    await testPool.end();
    throw err;
  }

  // ── 7. Request helper ─────────────────────────────────────────────────────
  async function request(opts: RequestOptions): Promise<RequestResult> {
    const url = `${baseUrl}${opts.path}`;
    const method = (opts.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };

    let bodyStr: string | undefined;
    if (opts.body !== undefined) {
      // If the caller already provided a content-type AND the body is a raw
      // string (e.g. text/csv, text/plain), send it as-is without JSON-encoding.
      const callerContentType = opts.headers?.["content-type"] ?? opts.headers?.["Content-Type"] ?? "";
      if (typeof opts.body === "string" && callerContentType && !callerContentType.includes("application/json")) {
        bodyStr = opts.body;
        // content-type already in headers — don't override it
      } else {
        bodyStr = JSON.stringify(opts.body);
        headers["content-type"] = "application/json";
      }
    }

    const res = await fetch(url, {
      method,
      headers,
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    let body: unknown = text;
    try {
      body = JSON.parse(text);
      json = body as Record<string, unknown>;
    } catch {
      // Not JSON — leave json = {}
    }
    return { status: res.status, body, json };
  }

  // ── 8. Teardown ────────────────────────────────────────────────────────────
  async function teardown(): Promise<void> {
    // Gracefully close Fastify.
    try {
      await app.close();
    } catch {
      // Ignore.
    }

    // Drop the test schema.
    await _dropSchema(databaseUrl, schemaName);

    // Close the pool and reset the singleton.
    try {
      await closePool();
    } catch {
      // Ignore.
    }
  }

  return { baseUrl, request, pool: testPool, teardown };
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Drop a Postgres schema using a fresh direct client (not the pool). */
async function _dropSchema(
  connectionString: string,
  schemaName: string
): Promise<void> {
  try {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await client.end();
    }
  } catch {
    // Best-effort — schema can be cleaned up manually if this fails.
  }
}
