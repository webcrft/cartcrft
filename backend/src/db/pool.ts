/**
 * PostgreSQL pool + transaction helper.
 *
 * Lazily created on first access so the server can boot (and serve /healthz)
 * even when DATABASE_URL is unreachable — the pool itself doesn't connect
 * until the first query.
 *
 * RLS enforcement (H1.1)
 * ----------------------
 * The application connects as neondb_owner which has rolbypassrls=TRUE,
 * silently skipping all RLS policies. To enforce the policies in 0006_rls.sql
 * and 0007_booking.sql, withTx() now:
 *
 *   1. Calls getRequestCtx() (AsyncLocalStorage) to retrieve the current
 *      authenticated principal (populated by the auth middleware).
 *   2. If a principal is present, executes inside the transaction:
 *        SET LOCAL ROLE cartcrft_app            -- role with NOBYPASSRLS
 *        set_config('app.user_id', userId, true) -- signals authenticated conn
 *        set_config('app.org_id',  orgId,  true) -- org context for future use
 *   3. LOCAL scope ensures the role and GUCs revert at COMMIT/ROLLBACK.
 *
 * Non-request contexts (worker, migration, seed, test fixtures) have no entry
 * in the AsyncLocalStorage store → withTx runs as neondb_owner (BYPASSRLS)
 * → trusted infrastructure code is not blocked by policies.
 */
import pg from "pg";
import { config } from "../config/config.js";
import { getRequestCtx } from "../lib/request-ctx.js";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

/**
 * Maximum pool connections per process.
 *
 * DB_POOL_MAX env override (default: 10).  Important for Neon tiers:
 * (replicas + workers) × DB_POOL_MAX must stay under the project connection
 * ceiling.  Lower this (e.g. DB_POOL_MAX=3) on small/free Neon tiers with
 * multiple worker replicas.
 */
function resolvePoolMax(): number {
  const raw = process.env["DB_POOL_MAX"];
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
    console.warn(`[db/pool] DB_POOL_MAX="${raw}" is not a positive integer — using default 10`);
  }
  return 10;
}

/** Return the singleton pool, creating it on first call. */
export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: config.DATABASE_URL,
      // DB_POOL_MAX env override (default: 10).
      // Tune down on small Neon tiers: (replicas + workers) × DB_POOL_MAX
      // must stay under the project connection ceiling.
      max: resolvePoolMax(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    _pool.on("error", (err) => {
      // Log pool errors without crashing the process.  A pool error usually
      // means the DB went away; queries will fail individually and the caller
      // should handle them.  The pool will reconnect automatically.
      console.error("[db/pool] background client error:", err.message);
    });
  }
  return _pool;
}

/**
 * Override the singleton pool — **test use only**.
 *
 * The test harness (backend/tests/shared/ctx.ts) calls this to inject a
 * search_path-scoped pool before the migration runner and app boot.
 * Never call this in production code.
 */
export function setPoolForTesting(pool: pg.Pool): void {
  _pool = pool;
}

/** Close the pool (call on graceful shutdown). */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Run `fn` inside a single database transaction.
 * Rolls back and rethrows on any error.
 *
 * RLS enforcement: if an authenticated request context exists (set by the auth
 * middleware via runWithRequestCtx), the transaction switches to the
 * cartcrft_app role (NOBYPASSRLS) and sets app.user_id / app.org_id GUCs so
 * that the RLS policies in 0006_rls.sql / 0007_booking.sql evaluate correctly.
 * The SET LOCAL scope ensures the role and GUCs revert at COMMIT/ROLLBACK.
 *
 * Usage:
 *   const result = await withTx(async (client) => {
 *     await client.query('INSERT ...');
 *     return await client.query('SELECT ...');
 *   });
 */
export async function withTx<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── RLS enforcement: switch to restricted role if inside a request ──────
    const reqCtx = getRequestCtx();
    if (reqCtx) {
      // SET LOCAL ROLE restores to the session role (neondb_owner) at
      // COMMIT/ROLLBACK. cartcrft_app has NOBYPASSRLS, so policies evaluate.
      await client.query("SET LOCAL ROLE cartcrft_app");
      // set_config with is_local=true resets at end of transaction.
      await client.query(
        "SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)",
        [reqCtx.userId, reqCtx.orgId]
      );
    }

    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
