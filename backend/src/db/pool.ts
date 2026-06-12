/**
 * PostgreSQL pool + transaction helper.
 *
 * Lazily created on first access so the server can boot (and serve /healthz)
 * even when DATABASE_URL is unreachable — the pool itself doesn't connect
 * until the first query.
 */
import pg from "pg";
import { config } from "../config/config.js";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

/** Return the singleton pool, creating it on first call. */
export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: config.DATABASE_URL,
      // Sane defaults — tightened per subsystem in future tasks.
      max: 10,
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
