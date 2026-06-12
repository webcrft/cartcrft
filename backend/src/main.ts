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

  // Keep alive.
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log("[worker] shutdown");
      stopEmbedding();
      stopRecovery();
      void closePool().then(resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
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
