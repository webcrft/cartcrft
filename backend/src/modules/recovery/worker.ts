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
import type { Mailer } from "../../lib/mailer/index.js";
import { processAbandonedCarts } from "./service.js";

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
