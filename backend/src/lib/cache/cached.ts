/**
 * lib/cache/cached.ts — TTL-backed loader helper.
 *
 * cached(key, ttlMs, loader) returns a function that:
 *  1. Checks the KV store for a hit.
 *  2. On miss, calls loader(), stores the result as JSON, and returns it.
 *
 * Within the TTL the loader is called at most once — subsequent calls return
 * the cached value.  This is a simple single-flight-ish behaviour: if two
 * concurrent calls both miss the cache before the first loader resolves they
 * will both invoke the loader.  For most cache use-cases (exchange rates,
 * config) the duplicate work is acceptable.
 *
 * Usage:
 *   const getRate = cached('exchange:USD', 6 * 3600_000, () => fetchRate());
 *   const rate = await getRate();
 */

import { buildKv } from "./kv.js";

/**
 * Create a cached loader function bound to `key` with `ttlMs` TTL.
 *
 * @param key    KV key to cache under.
 * @param ttlMs  TTL in milliseconds.
 * @param loader Async function that returns the fresh value on a cache miss.
 */
export function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): () => Promise<T> {
  return async (): Promise<T> => {
    const kv = await buildKv();
    const hit = await kv.get(key);
    if (hit !== undefined) {
      return JSON.parse(hit) as T;
    }
    const value = await loader();
    await kv.set(key, JSON.stringify(value), ttlMs);
    return value;
  };
}

/**
 * Invalidate a cached key immediately.
 * Useful when you know the underlying data has changed (e.g. after a write).
 */
export async function invalidate(key: string): Promise<void> {
  const kv = await buildKv();
  await kv.del(key);
}
