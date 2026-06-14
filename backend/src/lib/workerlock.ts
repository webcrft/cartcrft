/**
 * lib/workerlock.ts — distributed worker lock.
 *
 * Prevents background jobs from running concurrently on multiple worker
 * processes (e.g. during rolling deploys or accidental misconfiguration).
 *
 * LOCK STRATEGY — chosen for Neon pooler correctness
 * ────────────────────────────────────────────────────
 * A Neon connection-pooler URL (`*-pooler.neon.tech`) uses TRANSACTION-mode
 * pooling: each statement may execute on a different backend session.
 * SESSION-level pg_try_advisory_lock is meaningless under transaction pooling
 * because the session (and therefore the lock) is released between statements.
 *
 * Solution: Row-claim leader election with heartbeat TTL
 * ──────────────────────────────────────────────────────
 * We maintain a `worker_leader` table (created by migration 0020).  A replica
 * claims leadership by doing an upsert with its own instance_id:
 *
 *   INSERT INTO worker_leader (lock_name, instance_id, expires_at)
 *   VALUES ($name, $id, now() + $ttl)
 *   ON CONFLICT (lock_name) DO UPDATE
 *     SET instance_id = EXCLUDED.instance_id,
 *         expires_at   = EXCLUDED.expires_at
 *   WHERE worker_leader.expires_at < now()   ← only steal if expired
 *   RETURNING instance_id
 *
 * If the returned instance_id matches our own, we hold the lock.  If another
 * unexpired row exists, we get 0 rows back → lock not acquired.
 *
 * Per-tick jobs (subscription-scheduler) should use pg_try_advisory_xact_lock
 * INSIDE their own transaction so the lock scope equals the work.
 *
 * Fallback for per-tick transaction-scoped locking
 * ─────────────────────────────────────────────────
 * acquireXact / releaseXact wrap pg_try_advisory_xact_lock inside a provided
 * client transaction; the lock is released automatically on COMMIT/ROLLBACK.
 * This is safe under any pooler mode.
 *
 * Pooler boot-time WARNING
 * ────────────────────────
 * On startup, if DATABASE_URL contains a Neon pooler hostname AND we fall back
 * to the Postgres backend, we log a WARNING so operators know the lock mode.
 *
 *   RedisWorkerLock (when REDIS_URL is configured)
 *     Uses SET key NX PX <ttlMs> — the token must be presented on release so
 *     only the acquiring instance can release it.
 *
 * Usage:
 *   const lock = buildWorkerLock();
 *   const token = await lock.acquire('billing-enqueuer', 70_000);
 *   if (!token) return; // another instance holds it
 *   try {
 *     await doEnqueueWork();
 *   } finally {
 *     await lock.release('billing-enqueuer', token);
 *   }
 */

import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { getPool } from "../db/pool.js";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface WorkerLock {
  /**
   * Attempt to acquire the named lock.
   *
   * @param name   Logical lock name (e.g. "billing-enqueuer").
   * @param ttlMs  TTL in milliseconds.  For the Postgres row-claim backend this
   *               is the expiry window — if the holder crashes without releasing,
   *               another replica can steal the lock after ttlMs.
   *               For Redis, this is the key TTL.
   * @returns A token string if acquired; `null` if another holder has it.
   */
  acquire(name: string, ttlMs: number): Promise<string | null>;

  /**
   * Release a previously acquired lock.
   *
   * @param name  Logical lock name — must match the acquire call.
   * @param token Token returned by acquire().
   */
  release(name: string, token: string): Promise<void>;
}

// ── Name → int64 hash ─────────────────────────────────────────────────────────

/**
 * Map a lock name to a signed 64-bit integer suitable for pg advisory locks.
 */
function nameToBigInt(name: string): bigint {
  const hash = createHash("sha256").update(name).digest();
  const unsigned = hash.readBigUInt64BE(0);
  const maxSigned = BigInt("9223372036854775808"); // 2^63
  return unsigned >= maxSigned ? unsigned - BigInt("18446744073709551616") : unsigned; // 2^64
}

// ── PostgresWorkerLock — row-claim leader election ────────────────────────────

/**
 * Postgres row-claim implementation.
 *
 * Uses a `worker_leader` table (created in migration 0020) for leader election.
 * Safe under Neon transaction-mode connection pooling because no session state
 * is held — the lock is purely a DB row with a TTL.
 *
 * Acquire: upsert the row with our instance_id; only succeeds if the row is
 * absent or expired.  Returns the instance_id back so we can verify we won.
 *
 * Release: DELETE the row where instance_id matches our token (so we only
 * release our own lock, never another instance's).
 *
 * Heartbeat: callers SHOULD call renew() periodically when holding a long-lived
 * lock.  The subscription scheduler is short-lived enough that TTL (70s) >>
 * tick duration (< 5s), so heartbeating is optional there.
 */
class _PostgresWorkerLock implements WorkerLock {
  async acquire(name: string, ttlMs: number): Promise<string | null> {
    const pool = getPool();
    const instanceId = randomBytes(16).toString("hex");
    const ttlSeconds = Math.ceil(ttlMs / 1000);

    const { rows } = await pool.query<{ instance_id: string }>(
      `INSERT INTO public.worker_leader (lock_name, instance_id, expires_at)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
       ON CONFLICT (lock_name) DO UPDATE
         SET instance_id = EXCLUDED.instance_id,
             expires_at   = EXCLUDED.expires_at
         WHERE worker_leader.expires_at < now()
       RETURNING instance_id`,
      [name, instanceId, String(ttlSeconds)]
    );

    const winner = rows[0]?.instance_id;
    if (winner !== instanceId) {
      // Row was not updated (existing non-expired row) — we did not acquire.
      return null;
    }
    // Token IS the instance_id — used on release to verify ownership.
    return instanceId;
  }

  async release(name: string, token: string): Promise<void> {
    const pool = getPool();
    // Only delete if we still own it (idempotent — safe if already expired/stolen).
    await pool.query(
      `DELETE FROM public.worker_leader
       WHERE lock_name = $1 AND instance_id = $2`,
      [name, token]
    );
  }

  /**
   * Renew the TTL of a held lock.  Call periodically to prevent expiry during
   * long-running work.  No-op if the lock was lost (e.g. due to a crash + steal).
   */
  async renew(name: string, token: string, ttlMs: number): Promise<boolean> {
    const pool = getPool();
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    const { rowCount } = await pool.query(
      `UPDATE public.worker_leader
       SET expires_at = now() + ($3 || ' seconds')::interval
       WHERE lock_name = $1 AND instance_id = $2`,
      [name, token, String(ttlSeconds)]
    );
    return (rowCount ?? 0) > 0;
  }
}

// ── Transaction-scoped advisory lock helpers ──────────────────────────────────

/**
 * Attempt to acquire a TRANSACTION-scoped Postgres advisory lock on the
 * provided client (which must already be inside a BEGIN transaction).
 *
 * pg_try_advisory_xact_lock is safe under any pooler mode because the lock
 * scope is the surrounding transaction, not the session.  The lock is
 * automatically released on COMMIT or ROLLBACK — callers do NOT need to call
 * a corresponding release.
 *
 * Use this for per-tick jobs whose work is naturally transactional.
 *
 * @returns true if acquired, false if another holder has it.
 */
export async function tryAcquireXactLock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg.PoolClient
  client: any,
  name: string
): Promise<boolean> {
  const lockId = nameToBigInt(name);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
  const result = await client.query(
    `SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired`,
    [lockId.toString()]
  );
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return (result.rows[0]?.acquired ?? false) as boolean;
}

// ── RedisWorkerLock ───────────────────────────────────────────────────────────

class _RedisWorkerLock implements WorkerLock {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional dep
  constructor(private readonly client: any) {}

  async acquire(name: string, ttlMs: number): Promise<string | null> {
    const key = `workerlock:${name}`;
    const token = randomBytes(16).toString("hex");
    // SET key token NX PX ttlMs — atomic, only succeeds if key absent.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const result: string | null = await this.client.set(key, token, "NX", "PX", ttlMs);
    return result === "OK" ? token : null;
  }

  async release(name: string, token: string): Promise<void> {
    const key = `workerlock:${name}`;
    // Lua script: only delete if the token matches — prevents releasing another
    // instance's lock.
    const lua = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      else
        return 0
      end
    `;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await this.client.eval(lua, 1, key, token);
  }
}

// ── Pooler boot-time warning ──────────────────────────────────────────────────

/**
 * Emit a one-time warning if DATABASE_URL looks like a Neon transaction-pooler
 * URL and we are using the Postgres backend (not Redis).
 *
 * Transaction-pooled connections do not preserve sessions, so any attempt to
 * use session-level advisory locks (pg_try_advisory_lock) would silently break.
 * Our row-claim implementation is safe under transaction pooling, but this
 * warning helps operators who might have stale workerlock code elsewhere.
 */
function warnIfPoolerUrl(): void {
  const url = process.env["DATABASE_URL"] ?? "";
  // Neon pooler URLs contain "-pooler." in the hostname.
  if (url.includes("-pooler.")) {
    console.warn(
      "[workerlock] WARNING: DATABASE_URL looks like a Neon transaction-pooler endpoint " +
        "(*-pooler.neon.tech). Worker locks use row-claim leader election (safe under " +
        "transaction pooling). Do NOT use session-level pg_try_advisory_lock on this " +
        "connection — use tryAcquireXactLock() for transaction-scoped locking instead."
    );
  }
}

// ── Singleton factory ─────────────────────────────────────────────────────────

let _lock: WorkerLock | null = null;

/**
 * Return the process-singleton WorkerLock.
 *
 * Uses RedisWorkerLock when REDIS_URL is set, row-claim PostgresWorkerLock otherwise.
 * Lazy-initialised on first call.
 */
export async function buildWorkerLock(): Promise<WorkerLock> {
  if (_lock) return _lock;

  const redisUrl = process.env["REDIS_URL"];
  if (redisUrl) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional dep
      const { default: Redis } = await import("ioredis") as { default: any };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const client = new Redis(redisUrl, {
        lazyConnect: false,
        enableReadyCheck: true,
        maxRetriesPerRequest: 3,
      });
      _lock = new _RedisWorkerLock(client);
      console.log("[workerlock] Redis backend initialised");
    } catch (err) {
      console.warn(
        "[workerlock] REDIS_URL set but ioredis unavailable — falling back to Postgres row-claim locks:",
        err instanceof Error ? err.message : String(err)
      );
      warnIfPoolerUrl();
      _lock = new _PostgresWorkerLock();
    }
  } else {
    warnIfPoolerUrl();
    _lock = new _PostgresWorkerLock();
  }

  return _lock;
}

/**
 * Override singleton — test use only.
 */
export function setWorkerLockForTesting(lock: WorkerLock): void {
  _lock = lock;
}

// ── Convenience re-export ─────────────────────────────────────────────────────

/** Acquire a named lock.  Convenience wrapper around buildWorkerLock(). */
export async function acquireLock(
  name: string,
  ttlMs: number
): Promise<string | null> {
  const lock = await buildWorkerLock();
  return lock.acquire(name, ttlMs);
}

/** Release a named lock. Convenience wrapper around buildWorkerLock(). */
export async function releaseLock(name: string, token: string): Promise<void> {
  const lock = await buildWorkerLock();
  return lock.release(name, token);
}

// Re-export the concrete Postgres lock class for test use.
export { _PostgresWorkerLock as PostgresWorkerLockImpl };
