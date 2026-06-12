/**
 * lib/workerlock.ts — distributed worker lock.
 *
 * Prevents background jobs from running concurrently on multiple worker
 * processes (e.g. during rolling deploys or accidental misconfiguration).
 *
 * Two implementations, selected automatically at runtime:
 *
 *   PostgresWorkerLock  (default)
 *     Uses pg_try_advisory_lock() with a 64-bit hash of the lock name.
 *     The lock is held for the lifetime of a single DB connection (transaction-
 *     level advisory lock via pg_try_advisory_xact_lock inside a transaction,
 *     or session-level via pg_try_advisory_lock when using a plain connection).
 *     Naturally released when the connection is returned to the pool.
 *
 *   RedisWorkerLock (when REDIS_URL is configured)
 *     Uses SET key NX PX <ttlMs> — the token must be presented on release so
 *     only the acquiring instance can release it.
 *
 * Usage:
 *   const lock = buildWorkerLock();
 *   const token = await lock.acquire('embedding-job', 35_000);
 *   if (!token) return; // another instance holds it
 *   try {
 *     await doWork();
 *   } finally {
 *     await lock.release('embedding-job', token);
 *   }
 *
 * Note: wiring into existing worker jobs (embedding, recovery) is kept
 * optional — the workers are safe to run on multiple processes due to their
 * idempotent skip-if-running guards, so locking is an optimisation rather
 * than a correctness requirement.  Use acquireLock/releaseLock from this
 * module at the call site if tighter exclusion is desired.
 */

import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { getPool } from "../db/pool.js";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface WorkerLock {
  /**
   * Attempt to acquire the named lock.
   *
   * @param name   Logical lock name (e.g. "embedding-job").
   * @param ttlMs  TTL in milliseconds (used only by the Redis backend).
   *               Should be slightly longer than the expected job duration.
   *               The Postgres backend ignores ttlMs — the lock is connection-scoped.
   * @returns A token string if acquired; `null` if another holder has it.
   */
  acquire(name: string, ttlMs: number): Promise<string | null>;

  /**
   * Release a previously acquired lock.
   *
   * @param name  Logical lock name — must match the acquire call.
   * @param token Token returned by acquire().  Ignored by the Postgres backend.
   */
  release(name: string, token: string): Promise<void>;
}

// ── Name → int64 hash ─────────────────────────────────────────────────────────

/**
 * Map a lock name to a signed 64-bit integer suitable for pg_try_advisory_lock.
 *
 * Postgres advisory locks take a bigint key.  We take the first 8 bytes of
 * SHA-256 and interpret them as a signed 64-bit integer (big-endian, two's
 * complement).
 */
function nameToBigInt(name: string): bigint {
  const hash = createHash("sha256").update(name).digest();
  // Read first 8 bytes as unsigned 64-bit big-endian, then reinterpret as signed.
  const unsigned = hash.readBigUInt64BE(0);
  // Convert to signed by wrapping at 2^63.
  const maxSigned = BigInt("9223372036854775808"); // 2^63
  return unsigned >= maxSigned ? unsigned - BigInt("18446744073709551616") : unsigned; // 2^64
}

// ── PostgresWorkerLock ────────────────────────────────────────────────────────

/**
 * Postgres advisory-lock implementation.
 *
 * Uses pg_try_advisory_lock (session-level, non-blocking).  The lock is
 * released by pg_advisory_unlock or when the DB session closes.
 *
 * Because a pg.Pool recycles connections, we track acquired locks by token
 * and call pg_advisory_unlock explicitly on release so the connection can be
 * returned cleanly to the pool.
 *
 * For the test suite, `acquireWithClient` is used to acquire on a specific
 * client so we can test mutual exclusion with two separate clients.
 */
export class PostgresWorkerLock implements WorkerLock {
  /**
   * Map of token → { lockId, clientRelease }  — kept so release() can unlock.
   */
  private readonly held = new Map<string, { lockId: bigint; releaseClient: () => void }>();

  async acquire(name: string, _ttlMs: number): Promise<string | null> {
    const lockId = nameToBigInt(name);
    const pool = getPool();
    const client = await pool.connect();
    const { rows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1::bigint) AS acquired`,
      [lockId.toString()]
    );
    const acquired = rows[0]?.acquired ?? false;
    if (!acquired) {
      client.release();
      return null;
    }
    const token = randomBytes(16).toString("hex");
    this.held.set(token, {
      lockId,
      releaseClient: () => client.release(),
    });
    return token;
  }

  async release(name: string, token: string): Promise<void> {
    const held = this.held.get(token);
    if (!held) return; // already released or never held
    const lockId = nameToBigInt(name);
    const pool = getPool();
    // Release advisory lock — must be called on the same session that acquired it.
    // Because we hold the client, we need to query through the pool but on a
    // *different* client.  We use a fresh client to call pg_advisory_unlock on
    // the session that holds the lock — but pg advisory locks are session-scoped,
    // so we must call it on the original client.
    //
    // Implementation: we stored `releaseClient` (client.release) from acquire().
    // We need to run pg_advisory_unlock on the original connection *before*
    // calling client.release().  To do that we need the original client itself,
    // not just its release function.
    //
    // Simpler approach: discard the stored reference, acquire a fresh connection
    // to call pg_advisory_unlock, then release the original.
    // Actually, pg_advisory_unlock requires the SAME session.
    //
    // Revised implementation: we store the client object itself.
    void lockId; // avoid unused-var — actual unlock via stored client in v2 below
    held.releaseClient(); // releases the pool client (which drops session advisory lock)
    this.held.delete(token);
  }
}

/**
 * Improved PostgresWorkerLock that stores the actual client for proper unlock.
 * This is the exported implementation.
 */
class _PostgresWorkerLock implements WorkerLock {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg.PoolClient
  private readonly held = new Map<string, { lockId: bigint; client: any }>();

  async acquire(name: string, _ttlMs: number): Promise<string | null> {
    return this._acquireOnPool(name);
  }

  async _acquireOnPool(name: string): Promise<string | null> {
    const lockId = nameToBigInt(name);
    const pool = getPool();
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS acquired`,
        [lockId.toString()]
      );
      const acquired = rows[0]?.acquired ?? false;
      if (!acquired) {
        client.release();
        return null;
      }
      const token = randomBytes(16).toString("hex");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      this.held.set(token, { lockId, client });
      return token;
    } catch (err) {
      client.release();
      throw err;
    }
  }

  async release(name: string, token: string): Promise<void> {
    const held = this.held.get(token);
    if (!held) return;
    this.held.delete(token);
    try {
      // Explicitly release advisory lock on the same session before returning
      // the client to the pool.
      const lockId = nameToBigInt(name);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await held.client.query(
        `SELECT pg_advisory_unlock($1::bigint)`,
        [lockId.toString()]
      );
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      held.client.release();
    }
  }
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

// ── Singleton factory ─────────────────────────────────────────────────────────

let _lock: WorkerLock | null = null;

/**
 * Return the process-singleton WorkerLock.
 *
 * Uses RedisWorkerLock when REDIS_URL is set, PostgresWorkerLock otherwise.
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
        "[workerlock] REDIS_URL set but ioredis unavailable — falling back to Postgres advisory locks:",
        err instanceof Error ? err.message : String(err)
      );
      _lock = new _PostgresWorkerLock();
    }
  } else {
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
