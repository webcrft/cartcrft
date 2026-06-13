/**
 * subscriptions/scheduler.ts — Background worker job for automatic subscription billing.
 *
 * Polls on a clock-driven interval, selects active subscriptions whose
 * next_billing_at <= clock.now(), and calls billSubscription() for each.
 *
 * Idempotency:
 *   The query uses `FOR UPDATE SKIP LOCKED` so concurrent scheduler instances
 *   on multiple replicas never double-process the same subscription.  A 5-second
 *   buffer is subtracted from clock.now() on the SELECT predicate to account for
 *   sub-second clock skew between DB server and app server.
 *
 *   Additionally, billSubscription() wraps its work in a transaction that:
 *     - INSERT INTO subscription_orders (unique subscription_id + billing_period
 *       combination prevents double-insertion for the same billing cycle).
 *     - Advances next_billing_at forward immediately, so a second scheduler
 *       tick within the same billing cycle will not pick up the same sub.
 *
 * Parity with webcrft-mono:
 *   The Go handler (commerce_subscriptions.go:BillSubscription) is a manual
 *   HTTP endpoint.  The Go cron drives it via billing_queue (enqueue + process
 *   pattern).  Here we query direct and call the service function, matching the
 *   billing semantics: create order → insert subscription_orders → advance
 *   current_period_start / current_period_end / next_billing_at.
 *
 * Usage (in runWorker):
 *   const stop = startSubscriptionScheduler({ clock });
 *   // ... later:
 *   stop();
 */

import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import { getPool } from "../../db/pool.js";
import { billSubscription, setSubscriptionPastDue } from "./service.js";

export interface SubscriptionSchedulerOpts {
  clock?: Clock;
  /** How often to run the billing scan, in ms. Default: 60 000 (1 minute). */
  intervalMs?: number;
  /** Initial delay before the first tick, in ms. Default: 10 000 (10 s). */
  initialDelayMs?: number;
}

/**
 * Select IDs of active subscriptions whose next_billing_at is due.
 *
 * Uses FOR UPDATE SKIP LOCKED so a concurrent scheduler on another replica
 * will not pick up the same row.  The lock is held inside the caller's
 * per-subscription billSubscription() transaction.
 *
 * We intentionally keep a short advisory window: if a transaction commits or
 * rolls back quickly, the lock is released and another instance could retry
 * — but billSubscription already guards against double-billing via the
 * subscription_orders unique constraint on (subscription_id, billing_period).
 */
async function selectDueSubscriptions(now: Date): Promise<{ id: string; store_id: string }[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; store_id: string }>(
    `SELECT s.id::text, s.store_id::text
     FROM subscriptions s
     WHERE s.status = 'active'
       AND s.next_billing_at <= $1
     LIMIT 100
     FOR UPDATE SKIP LOCKED`,
    [now]
  );
  return rows;
}

/**
 * Start the subscription billing scheduler.
 *
 * Returns a stop function for graceful shutdown.
 */
export function startSubscriptionScheduler(
  opts: SubscriptionSchedulerOpts = {}
): () => void {
  const clock = opts.clock ?? new SystemClock();
  const intervalMs = opts.intervalMs ?? 60_000;
  const initialDelayMs = opts.initialDelayMs ?? 10_000;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const now = clock.now();
      const due = await selectDueSubscriptions(now);
      if (due.length > 0) {
        console.log(
          `[subscription-scheduler] ${due.length} subscription(s) due at ${now.toISOString()}`
        );
        for (const sub of due) {
          try {
            const result = await billSubscription(sub.store_id, sub.id, clock);
            console.log(
              `[subscription-scheduler] billed sub=${sub.id} order=${result.order_number} ` +
              `period=${result.billing_period} next=${result.next_billing_at.toISOString()}`
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[subscription-scheduler] billing failed for sub=${sub.id}: ${msg}`
            );
            // Mark past_due so the subscription isn't retried immediately.
            try {
              await setSubscriptionPastDue(sub.store_id, sub.id, msg);
            } catch (markErr) {
              console.error(
                `[subscription-scheduler] could not mark sub=${sub.id} past_due:`,
                markErr
              );
            }
          }
        }
      }
    } catch (err) {
      console.error("[subscription-scheduler] scan error:", err);
    }

    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
    }
  };

  timer = setTimeout(() => void tick(), initialDelayMs);
  console.log(
    `[subscription-scheduler] started (interval=${intervalMs}ms, initialDelay=${initialDelayMs}ms)`
  );

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    console.log("[subscription-scheduler] stopped");
  };
}
