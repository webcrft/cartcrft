/**
 * inventory/worker.ts — Background job that detects reorder-point low-stock and
 * emits `inventory.low` notification events.
 *
 * Each tick (default: 10 min):
 *   detectLowStock() scans inventory_levels across all stores for tracked
 *   variants whose quantity_on_hand has dropped to/below reorder_point
 *   (reorder_point > 0). For each NEW transition into low it dispatches an
 *   `inventory.low` event and records per-(variant, warehouse) alert state in
 *   inventory_low_alerts so it doesn't re-alert every tick (idempotent). When
 *   stock recovers above reorder_point the state is updated so a future drop
 *   re-alerts.
 *
 * A distributed worker lock (mirrors recovery/channels/threepl) prevents multiple
 * replicas from double-alerting in the same window. detectLowStock is itself
 * graceful (a bad row never stops the tick — errors are caught at the tick
 * level). Clock-injected for SimClock parity.
 *
 * Usage (main.ts worker mode):
 *   const stopInventoryLow = startInventoryLowStockWorkerJob({});
 */

import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import { acquireLock, releaseLock } from "../../lib/workerlock.js";
import { detectLowStock } from "./service.js";

const INVENTORY_LOW_LOCK_NAME = "inventory-low-worker";
const INVENTORY_LOW_LOCK_TTL_MS = 15 * 60 * 1000; // > default 10-min tick interval

export interface InventoryLowStockWorkerOpts {
  clock?: Clock;
  /** Interval between ticks in ms. Default: 10 minutes. */
  intervalMs?: number;
  /** Initial delay before the first tick in ms. Default: 14s. */
  initialDelayMs?: number;
}

/** Start the inventory low-stock alert worker job. Returns a stop function. */
export function startInventoryLowStockWorkerJob(
  opts: InventoryLowStockWorkerOpts
): () => void {
  const clock: Clock = opts.clock ?? new SystemClock();
  const intervalMs = opts.intervalMs ?? 10 * 60 * 1000;
  const initialDelayMs = opts.initialDelayMs ?? 14_000;

  let stopped = false;

  const tick = async () => {
    if (stopped) return;

    let lockToken: string | null = null;
    try {
      lockToken = await acquireLock(INVENTORY_LOW_LOCK_NAME, INVENTORY_LOW_LOCK_TTL_MS);
    } catch (err) {
      console.warn(
        "[inventory-low-worker] could not acquire lock (skipping tick):",
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
      const fired = await detectLowStock(undefined, { now: () => clock.now() });
      if (fired > 0) {
        console.log(`[inventory-low-worker] fired ${fired} inventory.low event(s)`);
      }
    } catch (err) {
      console.error("[inventory-low-worker] error during tick:", err);
    } finally {
      try {
        await releaseLock(INVENTORY_LOW_LOCK_NAME, lockToken);
      } catch (err) {
        console.warn(
          "[inventory-low-worker] lock release failed:",
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
    console.log("[inventory-low-worker] stopped");
  };
}
