/**
 * marketing/worker.ts — Background job for event-triggered marketing flows.
 *
 * Each tick (default: 60s):
 *   1. Trigger discovery — scan for newly-eligible orders / customers /
 *      abandoned carts and enroll them into matching active flows
 *      (idempotent via unique(flow_id, trigger_ref)).
 *   2. processDueRuns — send the due step for every active run and advance.
 *
 * A distributed worker lock (mirrors recovery/worker.ts) prevents multiple
 * replicas from double-sending in the same tick window. The FOR UPDATE SKIP
 * LOCKED claim inside processDueRuns is the per-run correctness safety net;
 * the lock is an efficiency guard.
 *
 * Clock-injected so SimClock works in dev/test.
 *
 * Usage (in main.ts worker mode):
 *   const stopMarketing = startMarketingWorkerJob({ mailer, sms });
 */

import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import { acquireLock, releaseLock } from "../../lib/workerlock.js";
import type { Mailer } from "../../lib/mailer/index.js";
import { discoverAndEnroll, processDueRuns, type SmsSender } from "./service.js";

const MARKETING_LOCK_NAME = "marketing-worker";
const MARKETING_LOCK_TTL_MS = 90 * 1000; // > default 60s tick interval

export interface MarketingWorkerOpts {
  mailer: Mailer;
  /** Optional; email-only flows work without it. SMS steps fail without it. */
  sms?: SmsSender | null;
  clock?: Clock;
  /** Interval between ticks in ms. Default: 60s. */
  intervalMs?: number;
  /** Initial delay before the first tick in ms. Default: 5s. */
  initialDelayMs?: number;
}

/**
 * Start the marketing flows worker job. Returns a stop function.
 */
export function startMarketingWorkerJob(opts: MarketingWorkerOpts): () => void {
  const clock = opts.clock ?? new SystemClock();
  const intervalMs = opts.intervalMs ?? 60 * 1000;
  const initialDelayMs = opts.initialDelayMs ?? 5000;

  let stopped = false;

  const tick = async () => {
    if (stopped) return;

    let lockToken: string | null = null;
    try {
      lockToken = await acquireLock(MARKETING_LOCK_NAME, MARKETING_LOCK_TTL_MS);
    } catch (err) {
      console.warn(
        "[marketing-worker] could not acquire lock (skipping tick):",
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
      const enrolled = await discoverAndEnroll(null, { clock });
      const sent = await processDueRuns(null, {
        mailer: opts.mailer,
        sms: opts.sms ?? null,
        clock,
      });
      if (enrolled > 0 || sent > 0) {
        console.log(`[marketing-worker] enrolled ${enrolled}, sent ${sent} message(s)`);
      }
    } catch (err) {
      console.error("[marketing-worker] error during tick:", err);
    } finally {
      try {
        await releaseLock(MARKETING_LOCK_NAME, lockToken);
      } catch (err) {
        console.warn(
          "[marketing-worker] lock release failed:",
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
    console.log("[marketing-worker] stopped");
  };
}
