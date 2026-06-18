/**
 * abandoned-checkout/worker.ts — Background job for abandoned-CHECKOUT recovery.
 *
 * Polls every `intervalMs` (default: 5 minutes). Each tick acquires a
 * distributed worker lock (`abandoned-checkout-worker`, mirrors
 * recovery/back-in-stock/marketing) so multi-replica deploys don't double-send
 * in the same window; the per-row recovery_notified_at guard inside
 * processAbandonedCheckouts is the correctness safety net. Clock-injected for
 * SimClock parity in tests.
 *
 * Usage (main.ts worker mode):
 *   const stopAbandonedCheckout = startAbandonedCheckoutWorkerJob({ mailer });
 */

import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import { acquireLock, releaseLock } from "../../lib/workerlock.js";
import type { Mailer } from "../../lib/mailer/index.js";
import {
  processAbandonedCheckouts,
  setAbandonedCheckoutMailer,
} from "./service.js";

const LOCK_NAME = "abandoned-checkout-worker";
const LOCK_TTL_MS = 6 * 60 * 1000; // > default 5-min tick interval

export interface AbandonedCheckoutWorkerOpts {
  mailer: Mailer;
  clock?: Clock;
  /** Interval between ticks in ms. Default: 5 minutes. */
  intervalMs?: number;
  /** Idle threshold before a pending checkout is eligible. Default: 1 hour. */
  thresholdMs?: number;
  /** Initial delay before the first tick in ms. Default: 13s. */
  initialDelayMs?: number;
}

/** Start the abandoned-checkout recovery worker. Returns a stop function. */
export function startAbandonedCheckoutWorkerJob(
  opts: AbandonedCheckoutWorkerOpts
): () => void {
  const clock: Clock = opts.clock ?? new SystemClock();
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  const initialDelayMs = opts.initialDelayMs ?? 13_000;
  const thresholdMs = opts.thresholdMs;

  // Register the mailer so processAbandonedCheckouts can default to it.
  setAbandonedCheckoutMailer(opts.mailer);

  let stopped = false;

  const tick = async () => {
    if (stopped) return;

    let lockToken: string | null = null;
    try {
      lockToken = await acquireLock(LOCK_NAME, LOCK_TTL_MS);
    } catch (err) {
      console.warn(
        "[abandoned-checkout-worker] could not acquire lock (skipping tick):",
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
      const sent = await processAbandonedCheckouts(clock.now(), {
        mailer: opts.mailer,
        clock,
        ...(thresholdMs !== undefined ? { thresholdMs } : {}),
      });
      if (sent > 0) {
        console.log(
          `[abandoned-checkout-worker] sent ${sent} recovery email(s)`
        );
      }
    } catch (err) {
      console.error("[abandoned-checkout-worker] error during tick:", err);
    } finally {
      try {
        await releaseLock(LOCK_NAME, lockToken);
      } catch (err) {
        console.warn(
          "[abandoned-checkout-worker] lock release failed:",
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
    console.log("[abandoned-checkout-worker] stopped");
  };
}
