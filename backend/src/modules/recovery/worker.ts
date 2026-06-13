/**
 * recovery/worker.ts — Background job for abandoned-cart recovery emails.
 *
 * Polls every `intervalMs` (default: 5 minutes). Clock-injected for SimClock
 * compatibility in tests.
 *
 * Usage (in main.ts worker mode):
 *   const stopRecovery = startRecoveryWorkerJob({ mailer, clock });
 */

import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import { acquireLock, releaseLock } from "../../lib/workerlock.js";
import type { Mailer } from "../../lib/mailer/index.js";
import { processAbandonedCarts } from "./service.js";

const RECOVERY_LOCK_NAME = "recovery-worker";
const RECOVERY_LOCK_TTL_MS = 6 * 60 * 1000; // slightly longer than the default 5-min poll interval

export interface RecoveryWorkerOpts {
  mailer: Mailer;
  clock?: Clock;
  /** Interval between scans in ms. Default: 5 minutes. */
  intervalMs?: number;
  /** Abandoned threshold in ms. Default: 1 hour. */
  thresholdMs?: number;
}

/**
 * Start the recovery worker job.
 * Returns a stop function.
 */
export function startRecoveryWorkerJob(opts: RecoveryWorkerOpts): () => void {
  const clock = opts.clock ?? new SystemClock();
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000; // 5 minutes
  const thresholdMs = opts.thresholdMs;

  let stopped = false;

  const tick = async () => {
    if (stopped) return;

    // Acquire a distributed advisory lock so multi-replica deploys don't
    // send duplicate recovery emails in the same tick window.
    // The per-cart last_notified_at guard is the correctness safety net;
    // the lock is an efficiency guard that prevents redundant work.
    let lockToken: string | null = null;
    try {
      lockToken = await acquireLock(RECOVERY_LOCK_NAME, RECOVERY_LOCK_TTL_MS);
    } catch (err) {
      console.warn("[recovery-worker] could not acquire lock (skipping tick):", err instanceof Error ? err.message : String(err));
      if (!stopped) setTimeout(() => void tick(), intervalMs);
      return;
    }
    if (!lockToken) {
      // Another replica holds the lock — skip this tick cleanly.
      if (!stopped) setTimeout(() => void tick(), intervalMs);
      return;
    }

    try {
      const count = await processAbandonedCarts({
        clock,
        mailer: opts.mailer,
        ...(thresholdMs !== undefined ? { thresholdMs } : {}),
      });
      if (count > 0) {
        console.log(`[recovery-worker] sent ${count} recovery email(s)`);
      }
    } catch (err) {
      console.error("[recovery-worker] error during tick:", err);
    } finally {
      try {
        await releaseLock(RECOVERY_LOCK_NAME, lockToken);
      } catch (err) {
        console.warn("[recovery-worker] lock release failed:", err instanceof Error ? err.message : String(err));
      }
    }

    if (!stopped) {
      setTimeout(() => void tick(), intervalMs);
    }
  };

  // Run first tick after a short delay (let DB settle at startup)
  const initial = setTimeout(() => void tick(), 5000);

  return () => {
    stopped = true;
    clearTimeout(initial);
    console.log("[recovery-worker] stopped");
  };
}
