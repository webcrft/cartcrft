/**
 * Cartcrft backend — single entrypoint.
 *
 * Subcommands:
 *   serve   (default) — start the HTTP server
 *   worker             — background job runner (stub; expand in Wave 2+)
 *   migrate            — run pending SQL migrations
 *
 * Mirrors the shape of webcrft-mono/backend/cmd/server/main.go:
 *   graceful shutdown on SIGINT/SIGTERM, root context cancellation, clear
 *   startup logs that never print secret values.
 */
import { config, mask } from "./config/config.js";
import { closePool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { buildApp } from "./http/app.js";
import { startEmbeddingWorkerJob } from "./agent/search/indexer.js";
import { startRecoveryWorkerJob } from "./modules/recovery/worker.js";
import { startMarketingWorkerJob } from "./modules/marketing/worker.js";
import { buildSmsSenderFromConfig } from "./modules/marketing/service.js";
import { startSubscriptionScheduler } from "./modules/subscriptions/scheduler.js";
import { startIcalPullWorkerJob } from "./modules/bookings/ical-pull.js";
import { startFxRefreshJob } from "./modules/exchange-rates/fx-refresh.js";
import { startChannelSyncWorkerJob } from "./modules/channels/worker.js";
import { startThreePlStatusWorkerJob } from "./modules/threepl/worker.js";
import { startInventoryLowStockWorkerJob } from "./modules/inventory/worker.js";
import { startBackInStockWorkerJob } from "./modules/back-in-stock/worker.js";
import { startAbandonedCheckoutWorkerJob } from "./modules/abandoned-checkout/worker.js";
import { ConsoleMailer } from "./lib/mailer/console.js";
import { SesMailer } from "./lib/mailer/ses.js";

// ── Subcommand dispatch ───────────────────────────────────────────────────
const subcommand = process.argv[2] ?? "serve";

switch (subcommand) {
  case "serve":
    await runServe();
    break;
  case "worker":
    await runWorker();
    break;
  case "migrate":
    await runMigrate();
    break;
  default:
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error("Usage: main.ts [serve|worker|migrate]");
    process.exit(1);
}

// ── serve ─────────────────────────────────────────────────────────────────
async function runServe(): Promise<void> {
  printBanner();

  // Graceful shutdown context (mirrors Go's signal.NotifyContext pattern).
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[main] ${signal} received — graceful shutdown…`);
    try {
      await app.close();
      await closePool();
      console.log("[main] shutdown complete");
    } catch (err) {
      console.error("[main] error during shutdown:", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const app = await buildApp();

  try {
    const address = await app.listen({
      port: config.PORT,
      host: "0.0.0.0",
    });
    console.log(`[main] server listening on ${address}`);
  } catch (err) {
    console.error("[main] failed to start server:", err);
    await closePool();
    process.exit(1);
  }
}

// ── worker ────────────────────────────────────────────────────────────────
async function runWorker(): Promise<void> {
  console.log("[worker] starting background job runner…");
  // T3.2 — semantic catalog embedding worker job.
  const stopEmbedding = startEmbeddingWorkerJob();
  console.log("[worker] embedding job registered (30s poll interval)");

  // T6.5 — abandoned-cart recovery email worker job.
  const mailer =
    config.AWS_SES_REGION &&
    config.AWS_SES_ACCESS_KEY_ID &&
    config.AWS_SES_SECRET_ACCESS_KEY &&
    config.EMAIL_FROM
      ? new SesMailer({
          region: config.AWS_SES_REGION,
          accessKeyId: config.AWS_SES_ACCESS_KEY_ID,
          secretAccessKey: config.AWS_SES_SECRET_ACCESS_KEY,
          fromAddress: config.EMAIL_FROM,
        })
      : new ConsoleMailer();
  const stopRecovery = startRecoveryWorkerJob({ mailer });
  console.log("[worker] recovery job registered (5-min poll interval)");

  // Wave 8 — Marketing flows / automation (event-triggered drip sequences).
  // Reuses the recovery mailer; SMS sender is env-resolved from Twilio config
  // (null when unconfigured — email-only flows still work). Distributed-locked
  // inside the worker so multiple replicas don't double-send.
  const marketingSms = buildSmsSenderFromConfig();
  const stopMarketing = startMarketingWorkerJob({ mailer, sms: marketingSms });
  console.log("[worker] marketing flows job registered (60s poll interval)");

  // H0.2 — Cloud billing worker (CARTCRFT_CLOUD only).
  // Dynamic import keeps the OSS build working with @cartcrft/cloud-billing absent.
  let stopBillingWorker: (() => void) | null = null;
  if (process.env["CARTCRFT_CLOUD"]) {
    stopBillingWorker = await startCloudBillingWorker();
  }

  // H2.3 — Subscription billing scheduler.
  // Selects active subscriptions with next_billing_at <= clock.now() and calls
  // billSubscription() for each. Clock-driven (SimClock when BILLING_SIM_ENABLED).
  let clock: { now(): Date };
  if (config.BILLING_SIM_ENABLED && config.BILLING_SIM_DAY_SECONDS > 0) {
    const { SimClock } = await import("./clock.js");
    clock = new SimClock(new Date(), config.BILLING_SIM_DAY_SECONDS);
  } else {
    const { SystemClock } = await import("./clock.js");
    clock = new SystemClock();
  }

  // Acquire a worker lock for the subscription scheduler to prevent
  // double-billing under multi-replica deploys.
  const { acquireLock, releaseLock } = await import("./lib/workerlock.js");
  const SUB_LOCK_NAME = "subscription-scheduler";
  const SUB_LOCK_TTL_MS = 70_000; // slightly longer than the poll interval

  let subLockToken: string | null = null;
  let stopSubscriptionScheduler: () => void = () => { /* no-op */ };

  try {
    subLockToken = await acquireLock(SUB_LOCK_NAME, SUB_LOCK_TTL_MS);
    if (!subLockToken) {
      console.log(
        "[worker] subscription scheduler lock held by another process — this replica will skip"
      );
    } else {
      console.log("[worker] subscription scheduler lock acquired");
      // Poll interval: compress with sim clock if configured; default 60s.
      const subIntervalMs =
        config.BILLING_SIM_ENABLED && config.BILLING_SIM_DAY_SECONDS > 0
          ? Math.max(1_000, Math.min(30_000, config.BILLING_SIM_DAY_SECONDS * 100))
          : 60_000;
      stopSubscriptionScheduler = startSubscriptionScheduler({
        clock,
        intervalMs: subIntervalMs,
        initialDelayMs: 5_000,
      });
      console.log(
        `[worker] subscription scheduler registered (${subIntervalMs}ms poll interval)`
      );
    }
  } catch (err) {
    console.warn(
      "[worker] could not acquire subscription scheduler lock (proceeding without):",
      err instanceof Error ? err.message : String(err)
    );
    stopSubscriptionScheduler = startSubscriptionScheduler({
      clock,
      intervalMs: 60_000,
      initialDelayMs: 5_000,
    });
    console.log("[worker] subscription scheduler registered (no lock — fallback mode)");
  }

  // H5.2 — Scheduled iCal pull worker.
  // Periodically fetches remote iCal URLs for active import feeds and applies
  // them via importICalFeed(). acquireLock guards against multi-replica double-pull.
  const stopIcalPull = startIcalPullWorkerJob({});
  console.log("[worker] ical pull job registered");

  // H2.3 — Exchange-rate refresh job.
  // Fetches USD-base rates from ExchangeRate-API and upserts into exchange_rates.
  // Graceful no-op when EXCHANGE_RATE_API_KEY is absent.
  const stopFxRefresh = startFxRefreshJob({
    apiKey: config.EXCHANGE_RATE_API_KEY,
    // Compress interval in sim mode so rates are refreshed more often in tests.
    intervalMs:
      config.BILLING_SIM_ENABLED && config.BILLING_SIM_DAY_SECONDS > 0
        ? Math.max(5_000, Math.min(120_000, config.BILLING_SIM_DAY_SECONDS * 1000))
        : 2 * 60 * 60 * 1000,
    initialDelayMs: 15_000,
  });

  // Wave 9 — Outbound channel sync (push products/inventory to external sales
  // channels via API, e.g. Google Shopping). Distributed-locked inside the
  // worker so multiple replicas don't double-push; runChannelSync is graceful.
  const stopChannelSync = startChannelSyncWorkerJob({
    intervalMs:
      config.BILLING_SIM_ENABLED && config.BILLING_SIM_DAY_SECONDS > 0
        ? Math.max(5_000, Math.min(120_000, config.BILLING_SIM_DAY_SECONDS * 1000))
        : 10 * 60 * 1000,
  });
  console.log("[worker] channel-sync job registered (10-min poll interval)");

  // Wave 10 — 3PL / fulfillment-network status pull. Pulls fulfillment status
  // from external 3PLs (ShipBob) for previously-submitted orders and advances
  // threepl_fulfillments. Distributed-locked inside the worker so multiple
  // replicas don't double-pull; syncThreePlStatuses is graceful.
  const stopThreePlSync = startThreePlStatusWorkerJob({
    intervalMs:
      config.BILLING_SIM_ENABLED && config.BILLING_SIM_DAY_SECONDS > 0
        ? Math.max(5_000, Math.min(120_000, config.BILLING_SIM_DAY_SECONDS * 1000))
        : 10 * 60 * 1000,
  });
  console.log("[worker] 3PL status-pull job registered (10-min poll interval)");

  // Wave 12 — Inventory reorder-point low-stock alerts. Scans inventory_levels
  // for tracked variants at/below reorder_point and emits inventory.low events on
  // new transitions into low. Distributed-locked inside the worker so multiple
  // replicas don't double-alert; detectLowStock is graceful + idempotent.
  const stopInventoryLow = startInventoryLowStockWorkerJob({
    intervalMs:
      config.BILLING_SIM_ENABLED && config.BILLING_SIM_DAY_SECONDS > 0
        ? Math.max(5_000, Math.min(120_000, config.BILLING_SIM_DAY_SECONDS * 1000))
        : 10 * 60 * 1000,
  });
  console.log("[worker] inventory low-stock alert job registered (10-min poll interval)");

  // Wave 18.2 — Back-in-stock notifications. Polls active subscriptions and
  // emails subscribers when an out-of-stock variant's total on-hand transitions
  // from <=0 to >0. Reuses the recovery mailer. Distributed-locked inside the
  // worker so multiple replicas don't double-notify; processRestocks is
  // graceful + notify-once idempotent.
  const stopBackInStock = startBackInStockWorkerJob({
    mailer,
    intervalMs:
      config.BILLING_SIM_ENABLED && config.BILLING_SIM_DAY_SECONDS > 0
        ? Math.max(5_000, Math.min(120_000, config.BILLING_SIM_DAY_SECONDS * 1000))
        : 5 * 60 * 1000,
  });
  console.log("[worker] back-in-stock notification job registered (5-min poll interval)");

  // Wave 22 — Abandoned-CHECKOUT recovery. Distinct from abandoned-cart
  // recovery: scans pending checkouts (started but not completed) that have
  // been idle past a threshold and have a contact email, and sends one recovery
  // email each linking back to resume checkout. Reuses the recovery mailer.
  // Distributed-locked inside the worker so multiple replicas don't double-send;
  // the per-row recovery_notified_at guard makes it send-once idempotent.
  const stopAbandonedCheckout = startAbandonedCheckoutWorkerJob({
    mailer,
    intervalMs:
      config.BILLING_SIM_ENABLED && config.BILLING_SIM_DAY_SECONDS > 0
        ? Math.max(5_000, Math.min(120_000, config.BILLING_SIM_DAY_SECONDS * 1000))
        : 5 * 60 * 1000,
  });
  console.log("[worker] abandoned-checkout recovery job registered (5-min poll interval)");

  // Keep alive.
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log("[worker] shutdown");
      stopEmbedding();
      stopRecovery();
      stopMarketing();
      stopSubscriptionScheduler();
      stopIcalPull();
      stopFxRefresh();
      stopChannelSync();
      stopThreePlSync();
      stopInventoryLow();
      stopBackInStock();
      stopAbandonedCheckout();
      if (subLockToken) {
        void releaseLock(SUB_LOCK_NAME, subLockToken).catch(() => { /* best-effort */ });
      }
      if (stopBillingWorker) stopBillingWorker();
      void closePool().then(resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

/**
 * Start the cloud billing worker loop (subscription renewals + FX refresh).
 * Uses SimClock when BILLING_SIM_DAY_SECONDS is set, SystemClock otherwise.
 * Worker locks (workerlock.ts / H2.4) are used to prevent double-processing in
 * multi-replica deploys.
 *
 * Returns a stop function for graceful shutdown.
 */
async function startCloudBillingWorker(): Promise<() => void> {
  let cloudBilling: {
    createBillingWorker: (pool: import("pg").Pool, cfg: unknown) => {
      start(): Promise<void>;
      stop(): void;
      enqueueUpcomingRenewals(): Promise<number>;
    };
  };

  try {
    cloudBilling = await import("@cartcrft/cloud-billing" as never) as typeof cloudBilling;
  } catch (err) {
    console.warn(
      "[worker] CARTCRFT_CLOUD set but @cartcrft/cloud-billing unavailable — billing worker not started:",
      err instanceof Error ? err.message : String(err)
    );
    return () => { /* no-op */ };
  }

  const { getPool: getMainPool } = await import("./db/pool.js");
  const pool = getMainPool();

  // Build the clock — SimClock when BILLING_SIM_DAY_SECONDS is in sim mode.
  let clock: { now(): Date };
  const simConfig = {
    billingSimEnabled: config.BILLING_SIM_ENABLED,
    billingSimDaySeconds: config.BILLING_SIM_DAY_SECONDS,
  };

  if (config.BILLING_SIM_ENABLED && config.BILLING_SIM_DAY_SECONDS > 0) {
    const { SimClock } = await import("./clock.js");
    clock = new SimClock(new Date(), config.BILLING_SIM_DAY_SECONDS);
    console.log(
      `[worker] billing clock: SimClock (1 day = ${config.BILLING_SIM_DAY_SECONDS}s)`
    );
  } else {
    const { SystemClock } = await import("./clock.js");
    clock = new SystemClock();
    console.log("[worker] billing clock: SystemClock");
  }

  const paystackSecretKey = config.PAYSTACK_SECRET_KEY ?? "";

  const worker = cloudBilling.createBillingWorker(pool, {
    clock,
    paystackSecretKey,
    billingSimConfig: simConfig,
    exchangeRateApiKey: config.EXCHANGE_RATE_API_KEY,
  });

  // ── Billing queue architecture ──────────────────────────────────────────────
  //
  // The billing_queue uses FOR UPDATE SKIP LOCKED, which already makes the
  // DRAIN safe on all replicas in parallel — SKIP LOCKED ensures each row is
  // processed by exactly one worker.  There is no need to lock the drain.
  //
  // The ENQUEUER (enqueueUpcomingRenewals) must run on exactly ONE replica to
  // avoid duplicate queue entries for the same billing period.  We acquire a
  // leader lock only around the enqueuer.  If this replica loses the lock,
  // another replica holds the enqueuer role; the drain still runs here.
  //
  // Fix (audit scale cliff): previously the entire billing worker (drain + enqueuer)
  // was pinned behind ONE advisory lock, preventing queue sharding across replicas.

  const { acquireLock, releaseLock } = await import("./lib/workerlock.js");
  const ENQUEUE_LOCK_NAME = "billing-enqueuer";
  const ENQUEUE_LOCK_TTL_MS = 120_000; // 2× poll interval

  const pollMs = config.BILLING_SIM_ENABLED && config.BILLING_SIM_DAY_SECONDS > 0
    ? Math.max(1_000, Math.min(60_000, config.BILLING_SIM_DAY_SECONDS * 100))
    : 60_000;

  // Try to become the enqueuer leader.  Loss is not fatal — another replica enqueues.
  let enqueueLockToken: string | null = null;
  let enqueueTimer: ReturnType<typeof setInterval> | null = null;

  try {
    enqueueLockToken = await acquireLock(ENQUEUE_LOCK_NAME, ENQUEUE_LOCK_TTL_MS);
    if (enqueueLockToken) {
      console.log("[worker] billing enqueuer lock acquired — this replica is the enqueuer leader");
      // Run an initial enqueue immediately, then on cadence.
      const runEnqueue = () => {
        void worker.enqueueUpcomingRenewals().then((n) => {
          if (n > 0) console.log(`[billing-worker] enqueued ${n} upcoming renewal(s)`);
          // Renew the leader lock so we keep the enqueuer role across ticks.
          if (enqueueLockToken) {
            // Best-effort renew (the lock row expiry will cover short gaps).
            void acquireLock(ENQUEUE_LOCK_NAME, ENQUEUE_LOCK_TTL_MS).catch(() => { /* ignore */ });
          }
        }).catch((err) => {
          console.error("[billing-worker] enqueueUpcomingRenewals error:", err);
        });
      };
      runEnqueue();
      enqueueTimer = setInterval(runEnqueue, pollMs);
    } else {
      console.log(
        "[worker] billing enqueuer lock held by another replica — this replica will only drain the queue"
      );
    }
  } catch (err) {
    console.warn(
      "[worker] could not acquire billing enqueuer lock (proceeding as drain-only):",
      err instanceof Error ? err.message : String(err)
    );
  }

  // Start the queue drain loop on ALL replicas (SKIP LOCKED makes it safe).
  void worker.start().catch((err) => {
    console.error("[billing-worker] worker loop exited with error:", err);
  });

  console.log("[worker] cloud billing worker started (drain on all replicas; enqueue on leader only)");

  return () => {
    worker.stop();
    if (enqueueTimer) clearInterval(enqueueTimer);
    if (enqueueLockToken) {
      void releaseLock(ENQUEUE_LOCK_NAME, enqueueLockToken).catch(() => { /* best-effort */ });
    }
    console.log("[worker] cloud billing worker stopped");
  };
}

// ── migrate ───────────────────────────────────────────────────────────────
async function runMigrate(): Promise<void> {
  console.log("[migrate] running migrations…");
  try {
    await runMigrations();
  } catch (err) {
    console.error("[migrate] FAILED:", err);
    await closePool();
    process.exit(1);
  }
  await closePool();
  process.exit(0);
}

// ── Banner ─────────────────────────────────────────────────────────────────
function printBanner(): void {
  console.log("┌─── cartcrft ──────────────────────────");
  console.log(`│ APP_ENV     = ${config.APP_ENV}`);
  console.log(`│ PORT        = ${config.PORT}`);
  console.log(`│ DATABASE_URL= ${mask(config.DATABASE_URL)}`);
  console.log(`│ JWT_SECRET  = ${mask(config.JWT_SECRET)}`);
  console.log(
    `│ AUTH_SECRETS_KEY = ${config.AUTH_SECRETS_KEY ? "configured" : "(not set — provider secrets will not be encrypted)"}`
  );
  console.log(
    `│ PAYSTACK    = ${config.PAYSTACK_SECRET_KEY ? "configured" : "(not set)"}`
  );
  console.log(
    `│ AWS SES     = ${config.AWS_SES_REGION ? "configured" : "(not set)"}`
  );
  console.log(
    `│ BILLING_SIM = ${config.BILLING_SIM_ENABLED ? `enabled (day=${config.BILLING_SIM_DAY_SECONDS}s)` : "disabled"}`
  );
  console.log("└───────────────────────────────────────");
}
