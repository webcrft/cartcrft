/**
 * @cartcrft/cloud-billing
 *
 * Cartcrft Cloud billing layer.
 * Consumed by the backend server only when CARTCRFT_CLOUD=1.
 *
 * License: SEE LICENSE IN ../LICENSE
 */

// ── Core simulation helpers ───────────────────────────────────────────────────
export {
  type BillingSimConfig,
  dayDuration,
  cycleDuration,
  dayDurationSeconds,
  isSimEnabled,
} from './billingsim.js';

// ── Clock helpers ─────────────────────────────────────────────────────────────
export {
  type Clock,
  SystemClock,
  ManualClock,
} from './clock.js';

// ── Migration list ────────────────────────────────────────────────────────────
export { billingMigrations } from './migrations.js';

// ── Paystack client ───────────────────────────────────────────────────────────
export {
  PaystackClient,
  extractPaystackAmountCents,
  type PaystackInitRequest,
  type PaystackInitResponse,
  type PaystackChargeRequest,
  type PaystackChargeResult,
  type PaystackVerifyData,
  type PaystackRefundResult,
} from './paystack.js';

// ── FX helpers ────────────────────────────────────────────────────────────────
export {
  getUsdZarRate,
  convertUsdCentsToZar,
  convertUsdToZarCents,
  refreshExchangeRates,
  type FxRate,
} from './fx.js';

// ── Pure math functions ───────────────────────────────────────────────────────
export {
  calcOverageCost,
  shouldAutoTopup,
  walletCoversOverage,
  calcProration,
  nextBillingAnchorAfter,
  previousBillingAnchorBefore,
  clampBillingDay,
  validateTopupAmount,
  formatWalletAmount,
  MIN_TOPUP_CENTS,
  BILLING_TIMEZONE,
  type ProrationResult,
} from './math.js';

// ── Billing engine ────────────────────────────────────────────────────────────
export {
  BillingEngine,
  resolvePreferredBillingDay,
  type BillingEngineConfig,
  type FxSnapshot,
  type SubscribeResult,
  type RenewResult,
  type WalletRow,
} from './engine.js';

// ── Queue worker ──────────────────────────────────────────────────────────────
export {
  BillingWorker,
  createBillingWorker,
  type WorkerConfig,
  type WorkerRunResult,
} from './worker.js';

// ── Host convenience: start billing worker from pool + clock + opts ────────────
export {
  startBillingWorker,
  type StartBillingWorkerOpts,
  type BillingWorkerHandle,
} from './startBillingWorker.js';

// ── Webhook handler + Fastify plugin ─────────────────────────────────────────
export {
  verifyBillingWebhookSignature,
  handleBillingWebhookEvent,
  processBillingWebhook,
  billingWebhookPlugin,
  type WebhookHandlerDeps,
  type BillingWebhookPluginOptions,
} from './webhook.js';
