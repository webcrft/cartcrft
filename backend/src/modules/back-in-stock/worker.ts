/**
 * back-in-stock/worker.ts — Background job that notifies subscribers when an
 * out-of-stock variant is restocked.
 *
 * Each tick (default: 5 min): processRestocks() scans active subscriptions
 * across all stores, finds variants whose total on-hand transitioned from <=0
 * to >0, emails each subscriber once and marks the subscription notified.
 *
 * A distributed worker lock (mirrors recovery/marketing/inventory) prevents
 * multiple replicas from double-notifying in the same window. The per-row
 * notify-once status guard inside processRestocks is the correctness safety net;
 * the lock is an efficiency guard. processRestocks is graceful (a bad send never
 * stops the tick). Clock-injected for SimClock parity.
 *
 * Usage (main.ts worker mode):
 *   const stopBackInStock = startBackInStockWorkerJob({ mailer });
 */

import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import { acquireLock, releaseLock } from "../../lib/workerlock.js";
import type { Mailer } from "../../lib/mailer/index.js";
import { processRestocks, setBackInStockMailer } from "./service.js";

const BACK_IN_STOCK_LOCK_NAME = "back-in-stock-worker";
const BACK_IN_STOCK_LOCK_TTL_MS = 6 * 60 * 1000; // > default 5-min tick interval

export interface BackInStockWorkerOpts {
  mailer: Mailer;
  clock?: Clock;
  /** Interval between ticks in ms. Default: 5 minutes. */
  intervalMs?: number;
  /** Initial delay before the first tick in ms. Default: 12s. */
  initialDelayMs?: number;
}

/** Start the back-in-stock notification worker job. Returns a stop function. */
export function startBackInStockWorkerJob(opts: BackInStockWorkerOpts): () => void {
  const clock: Clock = opts.clock ?? new SystemClock();
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  const initialDelayMs = opts.initialDelayMs ?? 12_000;

  // Register the mailer so processRestocks can default to it when called without
  // an injected mailer (e.g. from another scheduler).
  setBackInStockMailer(opts.mailer);

  let stopped = false;

  const tick = async () => {
    if (stopped) return;

    let lockToken: string | null = null;
    try {
      lockToken = await acquireLock(BACK_IN_STOCK_LOCK_NAME, BACK_IN_STOCK_LOCK_TTL_MS);
    } catch (err) {
      console.warn(
        "[back-in-stock-worker] could not acquire lock (skipping tick):",
        err instanceof Error ? err.message : String(err)
      );
      if (!stopped) setTimeout(() => void tick(), intervalMs);
      return;
    }
    if (!lockToken) {
      // Another replica holds the lock — skip this tick cleanly.
      if (!stopped) setTimeout(() => void tick(), intervalMs);
      return;
    }

    try {
      const sent = await processRestocks(undefined, { mailer: opts.mailer, clock });
      if (sent > 0) {
        console.log(`[back-in-stock-worker] sent ${sent} restock notification(s)`);
      }
    } catch (err) {
      console.error("[back-in-stock-worker] error during tick:", err);
    } finally {
      try {
        await releaseLock(BACK_IN_STOCK_LOCK_NAME, lockToken);
      } catch (err) {
        console.warn(
          "[back-in-stock-worker] lock release failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    if (!stopped) {
      setTimeout(() => void tick(), intervalMs);
    }
  };

  const initial = setTimeout(() => void tick(), initialDelayMs);

  return () => {
    stopped = true;
    clearTimeout(initial);
    console.log("[back-in-stock-worker] stopped");
  };
}
