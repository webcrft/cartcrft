/**
 * worker.ts — Billing queue worker
 *
 * Processes billing_queue rows (SELECT … FOR UPDATE SKIP LOCKED), handles
 * idempotency_key dedup, retries with backoff, and moves exhausted tasks to
 * billing_dead_letter.
 *
 * Renewal scheduling is driven by the injected Clock + BillingSimConfig
 * so BILLING_SIM_DAY_SECONDS compresses the entire billing lifecycle.
 *
 * Also runs the exchange-rate refresh job every 2 hours (sim-aware: 2 billing-days).
 *
 * Ported from:
 *   webcrft-mono/backend/internal/handlers/billing.go  CronProcessSubscriptions
 *   webcrft-mono/backend/cmd/server/main.go             worker loop
 */

import type pg from 'pg';
import type { Clock } from './clock.js';
import { BillingEngine, type BillingEngineConfig } from './engine.js';
import { refreshExchangeRates } from './fx.js';
import { dayDuration, type BillingSimConfig } from './billingsim.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkerConfig extends BillingEngineConfig {
  /** Max tasks to process per poll cycle (default: 10) */
  batchSize?: number;
  /** Poll interval in ms (default: uses billingSim dayDuration / 10, min 1s) */
  pollIntervalMs?: number;
  exchangeRateApiKey?: string;
}

export interface WorkerRunResult {
  processed: number;
  renewed: number;
  failed: number;
  cancelled: number;
  dead: number;
}

// ── Worker ────────────────────────────────────────────────────────────────────

export class BillingWorker {
  private readonly pool: pg.Pool;
  private readonly cfg: WorkerConfig;
  private readonly engine: BillingEngine;
  private stopped = false;
  private rateRefreshLastAt: Date | null = null;

  constructor(pool: pg.Pool, cfg: WorkerConfig) {
    this.pool = pool;
    this.cfg = cfg;
    this.engine = new BillingEngine(cfg);
  }

  /**
   * Start the worker loop (runs until stop() is called).
   * Processes subscription_renewal tasks and triggers rate refreshes.
   */
  async start(): Promise<void> {
    const pollMs = this.cfg.pollIntervalMs ?? this.defaultPollMs();
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err) {
        console.error('[billing-worker] tick error:', err);
      }
      if (!this.stopped) {
        await sleep(pollMs);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Run one poll cycle. Process a batch of ready tasks.
   * Suitable for calling directly in tests without the loop.
   */
  async tick(): Promise<WorkerRunResult> {
    const result = await this.processSubscriptionBatch();
    await this.maybeRefreshExchangeRates();
    return result;
  }

  /**
   * Process up to batchSize pending/failed subscription_renewal tasks.
   * Uses SELECT … FOR UPDATE SKIP LOCKED for safe parallel workers.
   */
  async processSubscriptionBatch(): Promise<WorkerRunResult> {
    const batchSize = this.cfg.batchSize ?? 10;
    const now = this.cfg.clock.now();

    // Claim tasks
    const claimRes = await this.pool.query<{
      id: string;
      organization_id: string;
      subscription_id: string | null;
      attempt_count: number;
      max_attempts: number;
      payload: Record<string, unknown>;
      idempotency_key: string;
    }>(
      `WITH cte AS (
         SELECT id FROM billing_queue
          WHERE status IN ('pending', 'failed')
            AND task_type = 'subscription_renewal'
            AND run_at <= $1
            AND attempt_count < max_attempts
          ORDER BY run_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE billing_queue q
          SET status = 'processing',
              attempt_count = q.attempt_count + 1,
              locked_at = now(),
              locked_by = $3
         FROM cte
        WHERE q.id = cte.id
       RETURNING q.id, q.organization_id, q.subscription_id,
                 q.attempt_count, q.max_attempts, q.payload, q.idempotency_key`,
      [now, batchSize, 'billing-worker'],
    );

    const tasks = claimRes.rows;
    const counters = { processed: 0, renewed: 0, failed: 0, cancelled: 0, dead: 0 };

    for (const task of tasks) {
      counters.processed++;

      if (!task.subscription_id) {
        await this.markTaskDead(task.id, 'no subscription_id');
        counters.dead++;
        continue;
      }

      const result = await this.engine.renew(this.pool, task.subscription_id);

      if (result.ok) {
        await this.pool.query(
          `UPDATE billing_queue SET status = 'completed', processed_at = now(), last_error = NULL WHERE id = $1::uuid`,
          [task.id],
        );
        counters.renewed++;
        continue;
      }

      if (result.cancelled) counters.cancelled++;

      if (task.attempt_count >= task.max_attempts) {
        await this.markTaskDead(task.id, result.message);
        counters.dead++;
      } else {
        // Retry with backoff: attempt 1 → dayDuration/2; attempt 2+ → dayDuration
        const dayMs = dayDuration(this.cfg.billingSimConfig);
        const backoffMs = task.attempt_count === 1 ? dayMs / 2 : dayMs;
        const nextRun = new Date(now.getTime() + backoffMs);
        await this.pool.query(
          `UPDATE billing_queue SET status = 'failed', run_at = $2, last_error = $3 WHERE id = $1::uuid`,
          [task.id, nextRun, result.message],
        );
        counters.failed++;
      }
    }

    return counters;
  }

  /**
   * Enqueue renewal tasks for all subscriptions whose period_end is within
   * one billing day from now. Mirrors CronEnqueueSubscriptions in billing.go.
   */
  async enqueueUpcomingRenewals(): Promise<number> {
    const now = this.cfg.clock.now();
    const lookaheadMs = dayDuration(this.cfg.billingSimConfig);
    const lookaheadUntil = new Date(now.getTime() + lookaheadMs);

    const subRes = await this.pool.query<{
      id: string;
      organization_id: string;
      current_period_end: Date;
    }>(
      `SELECT s.id, s.organization_id, s.current_period_end
         FROM billing_subscriptions s
         JOIN billing_tiers t ON t.id = s.tier_id
        WHERE s.status IN ('active', 'past_due')
          AND t.price_usd_cents > 0
          AND s.current_period_end IS NOT NULL
          AND s.current_period_end <= $1`,
      [lookaheadUntil],
    );

    let enqueued = 0;
    for (const sub of subRes.rows) {
      const periodEnd = new Date(sub.current_period_end);
      const sim = this.cfg.billingSimConfig;
      const cycleKey =
        sim?.billingSimEnabled
          ? periodEnd.toISOString()
          : periodEnd.toISOString().slice(0, 10);

      const runAt = periodEnd < now ? now : periodEnd;

      const res = await this.pool.query(
        `INSERT INTO billing_queue
           (organization_id, task_type, subscription_id, run_at, cycle_key, idempotency_key, status, max_attempts)
         VALUES ($1::uuid, 'subscription_renewal', $2::uuid, $3, $4, $5, 'pending', 3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          sub.organization_id,
          sub.id,
          runAt,
          cycleKey,
          `subscription:${sub.id}:${cycleKey}`,
        ],
      );
      if (res.rowCount && res.rowCount > 0) enqueued++;
    }

    return enqueued;
  }

  // ── Exchange rate refresh ──────────────────────────────────────────────────

  /**
   * Refresh exchange rates if more than 2 billing-days have passed since the
   * last refresh (mirrors Go 2-hour cron cadence, compressed in sim mode).
   */
  async maybeRefreshExchangeRates(): Promise<void> {
    const apiKey = this.cfg.exchangeRateApiKey;
    if (!apiKey) return;

    const now = this.cfg.clock.now();
    const refreshIntervalMs = 2 * dayDuration(this.cfg.billingSimConfig);

    if (
      this.rateRefreshLastAt !== null &&
      now.getTime() - this.rateRefreshLastAt.getTime() < refreshIntervalMs
    ) {
      return;
    }

    try {
      const count = await refreshExchangeRates(this.pool, apiKey);
      this.rateRefreshLastAt = now;
      console.info(`[billing-worker] exchange rates refreshed: ${count} currencies`);
    } catch (err) {
      console.error('[billing-worker] exchange rate refresh failed:', err);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async markTaskDead(taskId: string, lastError: string): Promise<void> {
    // Copy to dead letter then mark dead
    await this.pool.query(
      `INSERT INTO billing_dead_letter
         (queue_id, organization_id, task_type, subscription_id, cycle_key, idempotency_key,
          run_at, attempt_count, last_error, payload)
       SELECT id, organization_id, task_type, subscription_id, cycle_key, idempotency_key,
              run_at, attempt_count, $2, payload
         FROM billing_queue
        WHERE id = $1::uuid
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [taskId, lastError],
    );
    await this.pool.query(
      `UPDATE billing_queue SET status = 'dead', last_error = $2 WHERE id = $1::uuid`,
      [taskId, lastError],
    );
  }

  private defaultPollMs(): number {
    const dayMs = dayDuration(this.cfg.billingSimConfig);
    // Poll at 1/10th of a billing day, min 1s, max 60s.
    return Math.max(1_000, Math.min(60_000, dayMs / 10));
  }
}

// ── Module-level factory ──────────────────────────────────────────────────────

/**
 * Create and return a BillingWorker from config.
 * The caller is responsible for calling worker.start() (or worker.tick() in tests).
 */
export function createBillingWorker(
  pool: pg.Pool,
  cfg: WorkerConfig,
): BillingWorker {
  return new BillingWorker(pool, cfg);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
