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
 * Run `fn` inside a read-only, role-switched transaction so that RLS policies
 * are enforced on READ paths (P4 / audit item 2).
 *
 * Why this exists
 * ---------------
 * withTx() already role-switches to cartcrft_app (NOBYPASSRLS) so writes are
 * RLS-enforced. But the bulk of tenant-data READS in the request-scoped service
 * paths run as `getPool().query()` — i.e. as the owner role (BYPASSRLS) — and
 * rely SOLELY on hand-written `store_id` predicates. A single missing predicate
 * = a cross-tenant read with no DB backstop. withRlsRead() routes those reads
 * through the same role-switched path so the policies in 0006_rls.sql /
 * 0019_rls_tenant_isolation.sql double-check every read.
 *
 * Behaviour
 * ---------
 *   - In a request context (getRequestCtx() returns a principal): opens a
 *     READ ONLY transaction, SET LOCAL ROLE cartcrft_app, sets the
 *     app.user_id / app.org_id GUCs, runs fn(client), then COMMITs (read-only
 *     so there is nothing to roll back; COMMIT releases cleanly).
 *   - Outside a request context (workers, migrations, pre-auth, seeds): runs
 *     fn() against a plain pooled connection as the owner role (BYPASSRLS), so
 *     trusted infrastructure code is never blocked by policies. This is the
 *     graceful no-op the audit requires.
 *
 * Read-only enforcement (BEGIN ... READ ONLY) is a belt-and-braces guard: it
 * makes accidental writes on this path fail loudly rather than silently slip
 * past the write-oriented RLS WITH CHECK story. Use withTx() for writes.
 */
export async function withRlsRead<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const reqCtx = getRequestCtx();

  // No request context → trusted infra path: run as owner, no transaction
  // overhead, no role switch. Keeps workers / migrations / pre-auth working.
  if (!reqCtx) {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  // Request context → enforce RLS in a read-only, role-switched transaction.
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL ROLE cartcrft_app");
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)",
      [reqCtx.userId, reqCtx.orgId]
    );
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

/**
 * A `.query()`-compatible façade that routes each query through the
 * RLS-enforced read path (withRlsRead) when a request context is present, and
 * straight to the pool (owner role) otherwise.
 *
 * Migration ergonomics
 * --------------------
 * Most service read functions do `const pool = getPool();` then one or more
 * `pool.query(...)` calls (often via Promise.all). Swapping `getPool()` →
 * `getReadDb()` converts every read at that site to RLS-enforced with a
 * one-line change, no restructuring, and Promise.all keeps working (each query
 * gets its own short-lived role-switched connection).
 *
 * IMPORTANT: only use this for READS. Each call is an independent transaction,
 * so it gives NO write atomicity. For writes (and multi-statement read+write
 * units that must be atomic) use withTx().
 *
 * Documented owner-role exception list (P4 / item-2)
 * --------------------------------------------------
 * The following READ sites INTENTIONALLY stay on owner-role getPool() — they
 * either have no request context or legitimately need cross-tenant access, so
 * routing them through getReadDb() would (correctly) deny them. Keep them as
 * getPool() ON PURPOSE:
 *   - Auth middleware API-key / JWT lookups — pre-auth, the org context that RLS
 *     needs does not exist yet.
 *   - The superadmin module — intentional cross-tenant browse (sets no
 *     request-ctx; reads as owner/BYPASSRLS by design).
 *   - Workers / cron / schedulers (subscriptions/scheduler, recovery, billing
 *     worker) — run outside any HTTP request, no request-ctx.
 *   - MCP / pre-auth store resolution and the migration runner — no org ctx.
 *   - All write paths (INSERT/UPDATE/DELETE) — RLS-enforced via withTx(), not
 *     this read helper.
 * withRlsRead/getReadDb already no-op to owner role when getRequestCtx() is
 * undefined, so the no-context cases above keep working even if accidentally
 * routed here; the list documents which sites are owner-role BY DESIGN.
 */
export interface ReadDb {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<pg.QueryResult<R>>;
}

export function getReadDb(): ReadDb {
  return {
    query<R extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      params?: unknown[]
    ): Promise<pg.QueryResult<R>> {
      return withRlsRead((client) => client.query<R>(text, params));
    },
  };
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
