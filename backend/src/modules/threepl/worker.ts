/**
 * threepl/worker.ts — Background job that pulls fulfillment status from external
 * 3PLs (ShipBob today) for orders previously submitted via submitOrderToThreePl.
 *
 * Each tick (default: 10 min):
 *   1. listStoresWithOpenThreePlFulfillments() — every store with an active
 *      provider and at least one non-terminal fulfillment.
 *   2. syncThreePlStatuses(storeId) for each — pull status via the registered
 *      connector, update status/tracking/last_synced_at, emit shipment.* events.
 *
 * A distributed worker lock (mirrors recovery/channels) prevents multiple replicas
 * from double-pulling in the same window. syncThreePlStatuses is itself graceful
 * (records last_error instead of throwing), so one bad store/fulfillment never
 * stops the tick. Clock-injected for SimClock parity.
 *
 * Usage (main.ts worker mode):
 *   const stopThreePlSync = startThreePlStatusWorkerJob({});
 */

import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import { acquireLock, releaseLock } from "../../lib/workerlock.js";
import {
  listStoresWithOpenThreePlFulfillments,
  syncThreePlStatuses,
} from "./service.js";

const THREEPL_LOCK_NAME = "threepl-status-worker";
const THREEPL_LOCK_TTL_MS = 15 * 60 * 1000; // > default 10-min tick interval

export interface ThreePlStatusWorkerOpts {
  clock?: Clock;
  /** Interval between ticks in ms. Default: 10 minutes. */
  intervalMs?: number;
  /** Initial delay before the first tick in ms. Default: 12s. */
  initialDelayMs?: number;
}

/** Start the 3PL status-pull worker job. Returns a stop function. */
export function startThreePlStatusWorkerJob(opts: ThreePlStatusWorkerOpts): () => void {
  // Clock reserved for future scheduling (e.g. per-store pull cadence); the
  // distributed lock + DB-driven discovery already make ticks idempotent.
  const _clock: Clock = opts.clock ?? new SystemClock();
  void _clock;
  const intervalMs = opts.intervalMs ?? 10 * 60 * 1000;
  const initialDelayMs = opts.initialDelayMs ?? 12_000;

  let stopped = false;

  const tick = async () => {
    if (stopped) return;

    let lockToken: string | null = null;
    try {
      lockToken = await acquireLock(THREEPL_LOCK_NAME, THREEPL_LOCK_TTL_MS);
    } catch (err) {
      console.warn(
        "[threepl-status-worker] could not acquire lock (skipping tick):",
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
      const stores = await listStoresWithOpenThreePlFulfillments();
      let advanced = 0;
      for (const storeId of stores) {
        if (stopped) break;
        advanced += await syncThreePlStatuses(storeId);
      }
      if (advanced > 0) {
        console.log(
          `[threepl-status-worker] advanced ${advanced} fulfillment(s) across ${stores.length} store(s)`
        );
      }
    } catch (err) {
      console.error("[threepl-status-worker] error during tick:", err);
    } finally {
      try {
        await releaseLock(THREEPL_LOCK_NAME, lockToken);
      } catch (err) {
        console.warn(
          "[threepl-status-worker] lock release failed:",
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
    console.log("[threepl-status-worker] stopped");
  };
}
