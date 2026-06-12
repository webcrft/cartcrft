/**
 * cache.test.ts — suite for T6.7 pluggable KV, rate-limit backend, worker locks.
 *
 * Covers:
 *  1. MemoryKv — get/set/del, TTL expiry, incrWithWindow window semantics.
 *  2. Rate limiter — 429 after limit breach (config-override trick from apikeys.test.ts).
 *  3. Postgres advisory lock — mutual exclusion across two pool clients.
 *  4. cached() helper — loader called once within TTL, again after TTL.
 *  5. RedisKv — skip unless REDIS_URL env var is set (describe.skipIf).
 *
 * A single createCtx() is used for all integration tests so there is only one
 * Fastify app instance in the process (no duplicate-route registration error).
 * The Postgres advisory lock tests use the same ctx.pool from the test schema.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get } from "../shared/helpers.js";
import { MemoryKv, RedisKv, setKvForTesting } from "../../src/lib/cache/kv.js";
import { cached, invalidate } from "../../src/lib/cache/cached.js";
import { PostgresWorkerLockImpl } from "../../src/lib/workerlock.js";
import { setPoolForTesting } from "../../src/db/pool.js";
import pg from "pg";

// ── Single shared context for all integration tests ───────────────────────────

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── 1. MemoryKv unit tests (no DB needed) ─────────────────────────────────────

describe("MemoryKv", () => {
  it("get returns undefined for missing key", async () => {
    const kv = new MemoryKv();
    const v = await kv.get("nonexistent");
    expect(v).toBeUndefined();
  });

  it("set + get round-trips value", async () => {
    const kv = new MemoryKv();
    await kv.set("hello", "world");
    expect(await kv.get("hello")).toBe("world");
  });

  it("del removes key", async () => {
    const kv = new MemoryKv();
    await kv.set("k", "v");
    await kv.del("k");
    expect(await kv.get("k")).toBeUndefined();
  });

  it("del on absent key is a no-op", async () => {
    const kv = new MemoryKv();
    await expect(kv.del("absent")).resolves.toBeUndefined();
  });

  it("set with ttlMs — key expires after ttl", async () => {
    const kv = new MemoryKv();
    await kv.set("expiring", "yes", 1); // 1ms TTL

    // Wait a few ms to let it expire naturally.
    await new Promise((r) => setTimeout(r, 20));
    expect(await kv.get("expiring")).toBeUndefined();
  });

  it("set without ttlMs — key does not expire", async () => {
    const kv = new MemoryKv();
    await kv.set("permanent", "yes");
    await new Promise((r) => setTimeout(r, 50));
    // Key should still exist.
    expect(await kv.get("permanent")).toBe("yes");
  });

  it("incrWithWindow — increments within window", async () => {
    const kv = new MemoryKv();
    const k = "test:incr:basic";
    expect(await kv.incrWithWindow(k, 60_000)).toBe(1);
    expect(await kv.incrWithWindow(k, 60_000)).toBe(2);
    expect(await kv.incrWithWindow(k, 60_000)).toBe(3);
  });

  it("incrWithWindow — resets after window expires", async () => {
    const kv = new MemoryKv();
    const k = "test:incr:reset";
    // Use a 20ms window.
    expect(await kv.incrWithWindow(k, 20)).toBe(1);
    expect(await kv.incrWithWindow(k, 20)).toBe(2);

    // Wait for window to expire.
    await new Promise((r) => setTimeout(r, 50));

    // Should reset.
    const afterReset = await kv.incrWithWindow(k, 20);
    expect(afterReset).toBe(1);
  });

  it("incrWithWindow — distinct keys are independent", async () => {
    const kv = new MemoryKv();
    await kv.incrWithWindow("k1", 60_000);
    await kv.incrWithWindow("k1", 60_000);
    await kv.incrWithWindow("k2", 60_000);
    expect(await kv.incrWithWindow("k1", 60_000)).toBe(3);
    expect(await kv.incrWithWindow("k2", 60_000)).toBe(2);
  });
});

// ── 2. Rate-limiter via KV (HTTP integration) ─────────────────────────────────

describe("Rate-limit via KV (HTTP integration)", () => {
  it("Exceeding IP_RATE_LIMIT_PER_MINUTE returns 429 (same behaviour as before refactor)", async () => {
    // Inject a fresh MemoryKv so this test's window is isolated from others.
    const isolatedKv = new MemoryKv();
    setKvForTesting(isolatedKv);

    // Use the config-override trick from apikeys.test.ts.
    const { config } = await import("../../src/config/config.js");
    const original = config.IP_RATE_LIMIT_PER_MINUTE;
    (config as { IP_RATE_LIMIT_PER_MINUTE: number }).IP_RATE_LIMIT_PER_MINUTE = 5;

    try {
      let saw429 = false;
      for (let i = 0; i <= 10; i++) {
        const res = await get(ctx, "/healthz");
        if (res.status === 429) {
          saw429 = true;
          const err = (res.json["error"] as Record<string, unknown>);
          expect(err["code"]).toBe("RATE_LIMIT_EXCEEDED");
          break;
        }
      }
      expect(saw429).toBe(true);
    } finally {
      (config as { IP_RATE_LIMIT_PER_MINUTE: number }).IP_RATE_LIMIT_PER_MINUTE = original;
      // Restore a fresh KV so subsequent tests in this process aren't rate-limited.
      setKvForTesting(new MemoryKv());
    }
  });
});

// ── 3. Postgres advisory lock — mutual exclusion ──────────────────────────────
//
// These tests wire PostgresWorkerLockImpl to the test-schema pool via
// setPoolForTesting — so advisory locks run on the same connection as
// migrations.  Advisory locks are session-scoped so they don't interact
// with schema objects.

describe("PostgresWorkerLock — mutual exclusion", () => {
  it("acquires lock when free", async () => {
    // Re-inject the test pool so getPool() in workerlock.ts returns it.
    setPoolForTesting(ctx.pool);
    const lock = new PostgresWorkerLockImpl();
    const token = await lock.acquire("test-lock-free", 10_000);
    expect(token).toBeTruthy();
    await lock.release("test-lock-free", token!);
  });

  it("second acquire on same name returns null while first holds it", async () => {
    setPoolForTesting(ctx.pool);
    const lockA = new PostgresWorkerLockImpl();
    const lockB = new PostgresWorkerLockImpl();

    const tokenA = await lockA.acquire("test-lock-exclusive", 10_000);
    expect(tokenA).toBeTruthy();

    // B should fail since A holds it on the same session.
    // Note: pg_try_advisory_lock is session-level, not transaction-level.
    // A different pool.connect() call gets a different session, but if the
    // pool has only 1 connection it will block.  Use a small pool so this
    // test doesn't deadlock.
    //
    // Actually: our test pool has max: 5.  LockA holds a session.
    // LockB connects on a different session → different advisory lock slot.
    // pg_try_advisory_lock is process-global per lock ID, not per session.
    // Two different sessions cannot both hold the same lock ID.
    const tokenB = await lockB.acquire("test-lock-exclusive", 10_000);
    expect(tokenB).toBeNull();

    // Release A.
    await lockA.release("test-lock-exclusive", tokenA!);

    // Now B should succeed.
    const tokenB2 = await lockB.acquire("test-lock-exclusive", 10_000);
    expect(tokenB2).toBeTruthy();
    await lockB.release("test-lock-exclusive", tokenB2!);
  });

  it("distinct lock names do not conflict", async () => {
    setPoolForTesting(ctx.pool);
    const lockA = new PostgresWorkerLockImpl();
    const lockB = new PostgresWorkerLockImpl();

    const tokenA = await lockA.acquire("test-lock-nameA", 10_000);
    const tokenB = await lockB.acquire("test-lock-nameB", 10_000);

    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();

    await lockA.release("test-lock-nameA", tokenA!);
    await lockB.release("test-lock-nameB", tokenB!);
  });
});

// ── 4. cached() helper ────────────────────────────────────────────────────────

describe("cached() — single-flight-ish loader", () => {
  it("calls loader on first access", async () => {
    const testKv = new MemoryKv();
    setKvForTesting(testKv);

    let calls = 0;
    const loader = async () => {
      calls++;
      return { value: 42 };
    };

    const load = cached("test:cached:basic", 60_000, loader);
    const result = await load();
    expect(result).toEqual({ value: 42 });
    expect(calls).toBe(1);
  });

  it("does not call loader again within TTL", async () => {
    const testKv = new MemoryKv();
    setKvForTesting(testKv);

    let calls = 0;
    const loader = async () => {
      calls++;
      return { value: calls };
    };

    const load = cached("test:cached:dedup", 60_000, loader);
    const r1 = await load();
    const r2 = await load();
    const r3 = await load();

    // Loader should only have been called once.
    expect(calls).toBe(1);
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });

  it("calls loader again after TTL expires", async () => {
    const testKv = new MemoryKv();
    setKvForTesting(testKv);

    let calls = 0;
    const loader = async () => {
      calls++;
      return calls;
    };

    const load = cached("test:cached:ttl", 30, loader); // 30ms TTL

    const r1 = await load();
    expect(r1).toBe(1);
    expect(calls).toBe(1);

    // Wait for TTL to expire.
    await new Promise((r) => setTimeout(r, 80));

    const r2 = await load();
    expect(r2).toBe(2);
    expect(calls).toBe(2);
  });

  it("invalidate() clears the cache entry", async () => {
    const testKv = new MemoryKv();
    setKvForTesting(testKv);

    let calls = 0;
    const loader = async () => {
      calls++;
      return calls;
    };

    const load = cached("test:cached:invalidate", 60_000, loader);

    const r1 = await load();
    expect(r1).toBe(1);

    await invalidate("test:cached:invalidate");

    const r2 = await load();
    expect(r2).toBe(2);
    expect(calls).toBe(2);
  });
});

// ── 5. RedisKv (skip unless REDIS_URL is set) ─────────────────────────────────

const hasRedis = !!process.env["REDIS_URL"];

describe.skipIf(!hasRedis)("RedisKv (requires REDIS_URL)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional dep
  let client: any;
  let redisKv: RedisKv;

  beforeAll(async () => {
    // Dynamic import so ioredis is only loaded when REDIS_URL is available.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional dep
    const { default: Redis } = await import("ioredis") as { default: any };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    client = new Redis(process.env["REDIS_URL"]!);
    redisKv = new RedisKv(client);
  }, 15_000);

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await client.quit();
  }, 10_000);

  it("set + get round-trips value", async () => {
    const key = `test:redis:rtt:${Date.now()}`;
    await redisKv.set(key, "hello");
    expect(await redisKv.get(key)).toBe("hello");
    await redisKv.del(key);
  });

  it("set with TTL — key expires", async () => {
    const key = `test:redis:ttl:${Date.now()}`;
    // Use a generous TTL (500ms) to avoid race with Redis round-trips.
    await redisKv.set(key, "bye", 500);
    // Should be present right after setting.
    expect(await redisKv.get(key)).toBe("bye");
    // Wait well past the TTL.
    await new Promise((r) => setTimeout(r, 700));
    expect(await redisKv.get(key)).toBeUndefined();
  });

  it("del removes key", async () => {
    const key = `test:redis:del:${Date.now()}`;
    await redisKv.set(key, "v");
    await redisKv.del(key);
    expect(await redisKv.get(key)).toBeUndefined();
  });

  it("incrWithWindow increments within window", async () => {
    const key = `test:redis:incr:${Date.now()}`;
    expect(await redisKv.incrWithWindow(key, 60_000)).toBe(1);
    expect(await redisKv.incrWithWindow(key, 60_000)).toBe(2);
    expect(await redisKv.incrWithWindow(key, 60_000)).toBe(3);
    await redisKv.del(key);
  });

  it("incrWithWindow resets after window", async () => {
    const key = `test:redis:incr:reset:${Date.now()}`;
    // Short window (200ms) so the test doesn't take long.
    expect(await redisKv.incrWithWindow(key, 200)).toBe(1);
    await new Promise((r) => setTimeout(r, 400));
    // After TTL the key was deleted by Redis; new incr starts at 1.
    const after = await redisKv.incrWithWindow(key, 200);
    expect(after).toBe(1);
    await redisKv.del(key);
  });
});
