/**
 * startBillingWorker.ts — Convenience factory for the host process.
 *
 * The backend server (backend/src/main.ts) calls this via dynamic import when
 * CARTCRFT_CLOUD is set.  It wires together:
 *   1. BillingWorker (queue drain + FX refresh)
 *   2. A renewal enqueuer interval (enqueueUpcomingRenewals every pollMs)
 *
 * Returns a BillingWorkerHandle with a stop() method for graceful shutdown.
 *
 * This module is additive — it does not change any existing exports.
 */

import type pg from 'pg';
import type { Clock } from './clock.js';
import { createBillingWorker, type WorkerConfig } from './worker.js';
import { dayDuration } from './billingsim.js';

export interface StartBillingWorkerOpts {
  /** Milliseconds between renewal-enqueuer runs (default: derived from sim config). */
  pollIntervalMs?: number;
}

export interface BillingWorkerHandle {
  /** Stop the queue drain loop and the enqueuer interval. */
  stop(): void;
}

/**
 * Start the billing worker loop and renewal enqueuer.
 *
 * The queue drain loop (worker.start()) runs until handle.stop() is called.
 * The renewal enqueuer fires every pollIntervalMs to insert upcoming renewal
 * tasks into billing_queue for the drain loop to process.
 *
 * @param pool    pg.Pool connected to the billing schema
 * @param clock   Clock instance (SystemClock or SimClock)
 * @param cfg     WorkerConfig (paystackSecretKey, billingSimConfig, etc.)
 * @param opts    Additional options (pollIntervalMs override)
 */
export function startBillingWorker(
  pool: pg.Pool,
  clock: Clock,
  cfg: Omit<WorkerConfig, 'clock'>,
  opts: StartBillingWorkerOpts = {},
): BillingWorkerHandle {
  const fullCfg: WorkerConfig = { ...cfg, clock };
  const worker = createBillingWorker(pool, fullCfg);

  // Determine enqueuer poll interval.
  const dayMs = dayDuration(cfg.billingSimConfig);
  const pollMs = opts.pollIntervalMs ?? Math.max(1_000, Math.min(60_000, dayMs / 10));

  // Start the main drain loop (runs until worker.stop()).
  void worker.start().catch((err: unknown) => {
    console.error('[billing-worker] worker loop exited with error:', err);
  });

  // Kick off the renewal enqueuer on an interval.
  const enqueueTimer = setInterval(() => {
    void worker.enqueueUpcomingRenewals().then((n: number) => {
      if (n > 0) console.log(`[billing-worker] enqueued ${n} upcoming renewal(s)`);
    }).catch((err: unknown) => {
      console.error('[billing-worker] enqueueUpcomingRenewals error:', err);
    });
  }, pollMs);

  return {
    stop(): void {
      worker.stop();
      clearInterval(enqueueTimer);
    },
  };
}
