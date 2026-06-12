/**
 * lib/cache/kv.ts — pluggable KV interface for rate-limiting and cache.
 *
 * Two implementations:
 *   MemoryKv  — default, in-process map (zero new infra for OSS installs).
 *   RedisKv   — optional Redis backend; created only when REDIS_URL is set
 *               via a dynamic import of `ioredis` so OSS installs that have
 *               no Redis and no ioredis installed still boot cleanly.
 *
 * The KV interface is intentionally minimal — only the operations needed
 * by rate limiting and simple TTL caching.
 */

// ── Interface ─────────────────────────────────────────────────────────────────

export interface KV {
  /** Get a value by key. Returns undefined if missing or expired. */
  get(key: string): Promise<string | undefined>;

  /** Set key = value. `ttlMs` is optional TTL in milliseconds. */
  set(key: string, value: string, ttlMs?: number): Promise<void>;

  /** Delete a key. No-op if absent. */
  del(key: string): Promise<void>;

  /**
   * Atomically increment a counter within a sliding fixed window.
   *
   * The counter resets when `windowMs` has elapsed since the window opened.
   * Returns the new count after the increment.
   *
   * Used by rateLimitHook:
   *   const count = await kv.incrWithWindow('rl:' + ip, 60_000);
   *   if (count > limit) { send 429 }
   */
  incrWithWindow(key: string, windowMs: number): Promise<number>;
}

// ── MemoryKv ──────────────────────────────────────────────────────────────────

interface MemEntry {
  value: string;
  expiresAt: number | null; // null = no expiry
}

interface WindowEntry {
  count: number;
  windowStart: number; // Date.now() ms
}

/**
 * In-process KV store.  Zero dependencies.  Default when REDIS_URL is not set.
 *
 * incrWithWindow uses a fixed-window bucket — identical semantics to the
 * original ipBuckets Map in lib/auth/middleware.ts, so existing
 * apikeys.test.ts behaviour is preserved exactly.
 */
export class MemoryKv implements KV {
  private readonly entries = new Map<string, MemEntry>();
  private readonly windows = new Map<string, WindowEntry>();

  // Prune expired entries every 5 minutes — same cadence as the original.
  private readonly pruneHandle: ReturnType<typeof setInterval>;

  constructor() {
    this.pruneHandle = setInterval(
      () => this._prune(),
      5 * 60_000
    ).unref();
  }

  async get(key: string): Promise<string | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : null,
    });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
    this.windows.delete(key);
  }

  async incrWithWindow(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    let win = this.windows.get(key);
    if (!win || now - win.windowStart > windowMs) {
      win = { count: 0, windowStart: now };
      this.windows.set(key, win);
    }
    win.count++;
    return win.count;
  }

  /** Stop the prune interval (useful in tests). */
  destroy(): void {
    clearInterval(this.pruneHandle);
  }

  private _prune(): void {
    const now = Date.now();
    for (const [k, e] of this.entries) {
      if (e.expiresAt !== null && now > e.expiresAt) {
        this.entries.delete(k);
      }
    }
    for (const [k, w] of this.windows) {
      // Remove buckets that haven't been touched in 2× the longest plausible window.
      // Without knowing the window at prune time we use a conservative 10-minute ceiling.
      if (now - w.windowStart > 10 * 60_000) {
        this.windows.delete(k);
      }
    }
  }
}

// ── RedisKv ───────────────────────────────────────────────────────────────────

/**
 * Redis-backed KV using ioredis.
 *
 * `ioredis` is declared as an optional dependency in package.json.
 * This class is only instantiated when REDIS_URL is configured — the dynamic
 * import is performed once in `buildKv()` so that OSS installs without ioredis
 * still compile and run without errors.
 *
 * incrWithWindow uses INCR + PEXPIRE for fixed-window semantics compatible
 * with the MemoryKv implementation (bucket resets on first request in a new
 * window, not on a strict rolling basis — good enough for rate limiting).
 */
export class RedisKv implements KV {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional dep boundary
  constructor(private readonly client: any) {}

  async get(key: string): Promise<string | undefined> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const val: string | null = await this.client.get(key);
    return val ?? undefined;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await this.client.set(key, value, "PX", ttlMs);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await this.client.del(key);
  }

  async incrWithWindow(key: string, windowMs: number): Promise<number> {
    // Lua script: atomically increment and set expiry only on first increment.
    // If the key already exists the PEXPIRE is not re-applied — the window
    // stays anchored to the first request (fixed-window semantics).
    const luaScript = `
      local v = redis.call('INCR', KEYS[1])
      if v == 1 then
        redis.call('PEXPIRE', KEYS[1], ARGV[1])
      end
      return v
    `;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const result: number = await this.client.eval(luaScript, 1, key, String(windowMs));
    return result;
  }
}

// ── Singleton factory ─────────────────────────────────────────────────────────

let _kv: KV | null = null;

/**
 * Return the process-singleton KV instance.
 *
 * On first call:
 *  - If REDIS_URL is set, dynamically imports ioredis and returns a RedisKv.
 *  - Otherwise returns a MemoryKv.
 *
 * Subsequent calls return the cached instance.
 */
export async function buildKv(): Promise<KV> {
  if (_kv) return _kv;

  const redisUrl = process.env["REDIS_URL"];
  if (redisUrl) {
    try {
      // Dynamic import — ioredis is optional; only required when REDIS_URL set.
      // Pattern mirrors the CARTCRFT_CLOUD dynamic-import in app.ts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional dep
      const { default: Redis } = await import("ioredis") as { default: any };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const client = new Redis(redisUrl, {
        lazyConnect: false,
        enableReadyCheck: true,
        maxRetriesPerRequest: 3,
      });
      _kv = new RedisKv(client);
      console.log("[kv] Redis KV backend initialised");
    } catch (err) {
      console.warn(
        "[kv] REDIS_URL is set but ioredis failed to load — falling back to MemoryKv:",
        err instanceof Error ? err.message : String(err)
      );
      _kv = new MemoryKv();
    }
  } else {
    _kv = new MemoryKv();
  }

  return _kv;
}

/**
 * Override the KV singleton — test use only.
 * The cache test suite calls this to inject a fresh MemoryKv per test.
 */
export function setKvForTesting(kv: KV): void {
  _kv = kv;
}

/**
 * Return the current singleton without initialising (may be null before first call).
 * Used by rateLimitHook to fall back synchronously before the first async init.
 */
export function getKvSync(): KV | null {
  return _kv;
}
