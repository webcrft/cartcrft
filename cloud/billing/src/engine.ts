/**
 * engine.ts — Billing engine
 *
 * Implements the core billing lifecycle:
 *   subscribe()    — create/update subscription, initiate Paystack checkout or charge saved card
 *   renew()        — renew a subscription (called by worker queue)
 *   changeBillingDay() — billing-day anchor change with proration
 *   autoDowngrade()    — downgrade to free tier after grace period
 *   applyVoucher()     — apply a voucher code to an invoice
 *   recordRefund()     — store a refund record
 *   getOrCreateWallet() / creditWallet() / debitWallet() — wallet operations
 *
 * USD price book:
 *   - Tiers store price_usd_cents (USD cents).
 *   - At charge time, exchange_rates is read and the USD amount is converted
 *     to ZAR cents. The fx snapshot {usd_amount, fx_rate, zar_amount, fx_fetched_at}
 *     is stored immutably on every invoice/transaction/attempt row.
 *
 * Ported from:
 *   webcrft-mono/backend/internal/handlers/billing.go
 *   webcrft-mono/backend/internal/handlers/billing_wallet.go
 */

import type pg from 'pg';
import type { Clock } from './clock.js';
import { PaystackClient, type PaystackChargeResult } from './paystack.js';
import { getUsdZarRate, convertUsdCentsToZar } from './fx.js';
import {
  calcProration,
  nextBillingAnchorAfter,
  shouldAutoTopup,
  MIN_TOPUP_CENTS,
} from './math.js';
import { cycleDuration, type BillingSimConfig } from './billingsim.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const BILLING_TIMEZONE = 'Africa/Johannesburg';
const GRACE_PERIOD_DAYS_DEFAULT = 7;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BillingEngineConfig {
  paystackSecretKey: string;
  exchangeRateApiKey?: string;
  /** For billing sim support */
  billingSimConfig?: BillingSimConfig;
  clock: Clock;
}

export interface FxSnapshot {
  usdAmount: number;     // USD as decimal (e.g. 29.00)
  fxRate: number;        // zarPerUsd
  zarAmount: number;     // ZAR as decimal (e.g. 537.08)
  fxFetchedAt: Date | null;
}

export interface SubscribeResult {
  /** 'checkout' = redirect user to authorizationUrl; 'charged' = saved card charged */
  mode: 'checkout' | 'charged';
  authorizationUrl?: string | undefined;
  reference?: string | undefined;
  transactionId?: string | undefined;
  subscriptionId: string;
}

export interface RenewResult {
  ok: boolean;
  message: string;
  cancelled: boolean;
  transactionId?: string | undefined;
}

export interface WalletRow {
  id: string;
  balanceCents: number;
  autoTopupEnabled: boolean;
  autoTopupAmountCents: number;
  autoTopupThresholdCents: number;
}

// ── BillingEngine ─────────────────────────────────────────────────────────────

export class BillingEngine {
  private readonly paystack: PaystackClient;
  private readonly cfg: BillingEngineConfig;

  constructor(cfg: BillingEngineConfig) {
    this.cfg = cfg;
    this.paystack = new PaystackClient(cfg.paystackSecretKey);
  }

  // ── FX helper ──────────────────────────────────────────────────────────────

  /**
   * Load current USD→ZAR rate and compute ZAR cents for a USD-cent price.
   * Returns null for fxSnapshot if rate is unavailable (use as abort signal).
   */
  async computeFxSnapshot(
    pool: pg.Pool,
    usdCents: number,
  ): Promise<{ zarCents: number; snapshot: FxSnapshot } | null> {
    const rate = await getUsdZarRate(pool, this.cfg.clock);
    if (!rate) return null;

    const zarCents = convertUsdCentsToZar(usdCents, rate.zarPerUsd);
    const snapshot: FxSnapshot = {
      usdAmount: usdCents / 100,
      fxRate: rate.zarPerUsd,
      zarAmount: zarCents / 100,
      fxFetchedAt: rate.fetchedAt,
    };
    return { zarCents, snapshot };
  }

  // ── Invoice helpers ────────────────────────────────────────────────────────

  private nextInvoiceNumber(pool: pg.Pool): Promise<string> {
    return pool
      .query<{ count: number }>('SELECT COUNT(*) AS count FROM billing_invoices')
      .then((r) => {
        const n = (Number(r.rows[0]?.count ?? 0) + 1).toString().padStart(6, '0');
        return `INV-${n}`;
      });
  }

  /**
   * Create an invoice and a linked invoice item for a transaction.
   * Stores the FX snapshot immutably.
   */
  async createInvoice(
    pool: pg.Pool,
    orgId: string,
    subscriptionId: string | null,
    transactionId: string | null,
    zarCents: number,
    description: string,
    snapshot: FxSnapshot,
  ): Promise<string> {
    const invoiceNumber = await this.nextInvoiceNumber(pool);
    const now = this.cfg.clock.now();

    const alreadyPaid = transactionId !== null;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_invoices
         (organization_id, subscription_id, invoice_number, status,
          subtotal_cents, tax_cents, total_cents,
          usd_amount, fx_rate, zar_amount, fx_fetched_at,
          due_at, paid_at, recipient_email)
       VALUES
         ($1::uuid, $2::uuid, $3, (CASE WHEN $10 THEN 'paid' ELSE 'issued' END)::invoice_status,
          $4, 0, $4,
          $5, $6, $7, $8,
          $9::timestamptz, CASE WHEN $10 THEN $9::timestamptz ELSE NULL END, NULL)
       RETURNING id`,
      [
        orgId,
        subscriptionId || null,
        invoiceNumber,
        zarCents,
        snapshot.usdAmount,
        snapshot.fxRate,
        snapshot.zarAmount,
        snapshot.fxFetchedAt,
        now,
        alreadyPaid, // $10: already paid (boolean)
      ],
    );

    const invoiceId = rows[0]!.id;

    // Link the transaction to this invoice
    if (transactionId) {
      await pool.query(
        `UPDATE billing_transactions SET invoice_id = $1::uuid WHERE id = $2::uuid`,
        [invoiceId, transactionId],
      );
    }

    // Insert invoice line item
    await pool.query(
      `INSERT INTO billing_invoice_items
         (invoice_id, description, quantity, unit_amount_cents, line_total_cents,
          usd_amount, fx_rate, zar_amount, fx_fetched_at)
       VALUES ($1::uuid, $2, 1, $3, $3, $4, $5, $6, $7)`,
      [
        invoiceId,
        description,
        zarCents,
        snapshot.usdAmount,
        snapshot.fxRate,
        snapshot.zarAmount,
        snapshot.fxFetchedAt,
      ],
    );

    return invoiceId;
  }

  // ── Subscribe ──────────────────────────────────────────────────────────────

  /**
   * Create or change a subscription.
   *
   * Happy path (saved card exists):
   *   1. Load tier (price_usd_cents) and current FX rate.
   *   2. Convert USD→ZAR, charge saved card.
   *   3. Create/update billing_subscription + billing_invoice.
   *
   * No saved card:
   *   1. Initialize Paystack checkout.
   *   2. Return authorizationUrl for redirect.
   *
   * Mirrors BillingHandler.Subscribe in billing.go.
   */
  async subscribe(
    pool: pg.Pool,
    orgId: string,
    tierSlug: string,
    email: string,
    callbackUrl?: string,
  ): Promise<SubscribeResult> {
    const now = this.cfg.clock.now();

    // Load tier
    const tierRes = await pool.query<{
      id: string;
      slug: string;
      name: string;
      price_usd_cents: number;
    }>(
      `SELECT id, slug, name, price_usd_cents FROM billing_tiers WHERE slug = $1 AND is_active = true`,
      [tierSlug],
    );
    if (tierRes.rows.length === 0) throw new Error('Tier not found');
    const tier = tierRes.rows[0]!;

    // Load the most recent subscription (any tier/status) for billing-day anchor
    const curSubRes = await pool.query<{
      id: string;
      current_period_end: Date | null;
      metadata: Record<string, unknown> | null;
      tier_slug: string;
      authorization_id: string | null;
      paystack_subscription_code: string | null;
      status: string;
    }>(
      `SELECT s.id, s.current_period_end, s.metadata, t.slug AS tier_slug,
              s.authorization_id, s.paystack_subscription_code, s.status
         FROM billing_subscriptions s
         JOIN billing_tiers t ON t.id = s.tier_id
        WHERE s.organization_id = $1::uuid
        ORDER BY s.created_at DESC LIMIT 1`,
      [orgId],
    );
    const currentSub = curSubRes.rows[0] ?? null;

    // Guard: reject if already on this plan with an active paid subscription.
    // A subscription created without a card (e.g. free tier or test fixture) has no
    // authorization_id and no paystack_subscription_code — those can be re-subscribed.
    if (
      currentSub?.tier_slug === tierSlug &&
      currentSub.status === 'active' &&
      (currentSub.authorization_id !== null || currentSub.paystack_subscription_code !== null)
    ) {
      throw new Error('Already on this plan');
    }

    const preferredDay = resolvePreferredBillingDay(currentSub, now);
    const periodEnd = this.nextPeriodEnd(now, preferredDay);
    const subId = currentSub?.id ?? null;

    // Test/seed auth codes bypass Paystack
    if (tier.price_usd_cents > 0) {
      // Try to charge saved card first
      const authRes = await pool.query<{ id: string; paystack_authorization_code: string; email: string }>(
        `SELECT id, paystack_authorization_code, email
           FROM billing_authorizations
          WHERE organization_id = $1::uuid
            AND is_default = true AND is_active = true AND deleted_at IS NULL
         LIMIT 1`,
        [orgId],
      );
      const auth = authRes.rows[0];

      if (auth) {
        const fxResult = await this.computeFxSnapshot(pool, tier.price_usd_cents);
        if (!fxResult) throw new Error('Exchange rate unavailable — cannot proceed with charge');

        const result = await this.chargeAndRecord(
          pool, orgId, auth, fxResult.zarCents, tier.price_usd_cents,
          fxResult.snapshot, 'subscription', subId, null,
          { tier_slug: tierSlug, action: 'plan_change' },
        );

        if (!result.ok) {
          // Fall through to checkout
        } else {
          const newSubId = await this.upsertSubscription(
            pool, orgId, tier.id, subId, now, periodEnd, preferredDay,
          );
          await this.createInvoice(
            pool, orgId, newSubId, result.transactionId!, fxResult.zarCents,
            `Plan: ${tier.name}`, fxResult.snapshot,
          );
          return { mode: 'charged', transactionId: result.transactionId, subscriptionId: newSubId };
        }
      }

      // No saved card (or charge failed) → initialize checkout
      const cb = callbackUrl ?? '/billing';
      const metadata = {
        organization_id: orgId,
        intent: 'upgrade',
        tier_id: tier.id,
        tier_slug: tier.slug,
        ...(subId ? { subscription_id: subId } : {}),
      };
      const ref = `upgrade-${randomStr(20)}`;

      // For free tiers (price=0) skip Paystack
      const initResp = await this.paystack.initializeTransaction({
        email,
        amount: await (async () => {
          const fxResult = await this.computeFxSnapshot(pool, tier.price_usd_cents);
          return fxResult ? fxResult.zarCents : tier.price_usd_cents;
        })(),
        currency: 'ZAR',
        reference: ref,
        callbackUrl: cb,
        metadata,
      });

      return {
        mode: 'checkout',
        authorizationUrl: initResp.authorizationUrl,
        reference: initResp.reference,
        subscriptionId: subId ?? '',
      };
    }

    // Free tier — no charge needed
    const newSubId = await this.upsertSubscription(
      pool, orgId, tier.id, subId, now, periodEnd, preferredDay,
    );
    return { mode: 'charged', subscriptionId: newSubId };
  }

  // ── Renew (called by queue worker) ─────────────────────────────────────────

  /**
   * Process one subscription renewal task.
   *
   * Mirrors processSubscriptionTask in billing.go.
   * Returns { ok, message, cancelled }.
   */
  async renew(
    pool: pg.Pool,
    subscriptionId: string,
  ): Promise<RenewResult> {
    const now = this.cfg.clock.now();

    const subRes = await pool.query<{
      id: string;
      organization_id: string;
      tier_id: string;
      failed_payment_count: number;
      last_payment_failed_at: Date | null;
      metadata: Record<string, unknown> | null;
      current_period_end: Date | null;
      cancel_at_period_end: boolean;
      price_usd_cents: number;
      tier_slug: string;
      grace_period_days: number;
    }>(
      `SELECT s.id, s.organization_id, s.tier_id, s.failed_payment_count, s.last_payment_failed_at,
              s.metadata, s.current_period_end, s.cancel_at_period_end,
              s.grace_period_days,
              t.price_usd_cents, t.slug AS tier_slug
         FROM billing_subscriptions s
         JOIN billing_tiers t ON t.id = s.tier_id
        WHERE s.id = $1::uuid AND s.status IN ('active', 'past_due') AND t.price_usd_cents > 0`,
      [subscriptionId],
    );
    if (subRes.rows.length === 0) {
      return { ok: false, message: 'subscription not found', cancelled: false };
    }
    const sub = subRes.rows[0]!;
    const orgId = sub.organization_id;
    const usdCents = sub.price_usd_cents;

    // Scheduled cancellation
    if (sub.cancel_at_period_end) {
      await this.autoDowngrade(pool, subscriptionId, orgId, 'user_cancelled_at_period_end');
      return { ok: false, message: 'cancelled at period end', cancelled: true };
    }

    // Load saved card
    const authRes = await pool.query<{
      id: string;
      paystack_authorization_code: string;
      email: string;
    }>(
      `SELECT id, paystack_authorization_code, email
         FROM billing_authorizations
        WHERE organization_id = $1::uuid AND is_default = true AND is_active = true AND deleted_at IS NULL
       LIMIT 1`,
      [orgId],
    );
    const auth = authRes.rows[0] ?? null;

    if (!auth) {
      const newCount = sub.failed_payment_count + 1;
      await pool.query(
        `UPDATE billing_subscriptions
            SET failed_payment_count = $1,
                last_payment_failed_at = COALESCE(last_payment_failed_at, $2),
                status = 'past_due', outstanding_amount_cents = GREATEST(outstanding_amount_cents, $3),
                updated_at = now()
          WHERE id = $4::uuid`,
        [newCount, now, usdCents, subscriptionId],
      );
      await this.recordPaymentAttempt(pool, {
        organizationId: orgId,
        subscriptionId,
        source: 'recurring_queue',
        providerRef: `no-card-${randomStr(16)}`,
        status: 'failed',
        chargeType: 'subscription',
        amountCents: usdCents,
        currency: 'ZAR',
        failureReason: 'No payment method on file',
      });
      if (this.shouldDowngrade(sub, now)) {
        await this.autoDowngrade(pool, subscriptionId, orgId, 'past_due_no_card');
        return { ok: false, message: 'no payment method', cancelled: true };
      }
      return { ok: false, message: 'no payment method', cancelled: false };
    }

    // Compute FX and attempt charge
    const fxResult = await this.computeFxSnapshot(pool, usdCents);
    if (!fxResult) {
      return { ok: false, message: 'Exchange rate unavailable', cancelled: false };
    }

    const chargeResult = await this.chargeAndRecord(
      pool, orgId, auth, fxResult.zarCents, usdCents,
      fxResult.snapshot, 'subscription', subscriptionId, null,
      { tier_slug: sub.tier_slug, action: 'recurring' },
    );

    if (chargeResult.ok) {
      const preferredDay = resolvePreferredBillingDay(sub, now);
      const newEnd = this.nextPeriodEnd(now, preferredDay);

      await pool.query(
        `UPDATE billing_subscriptions
            SET status = 'active', failed_payment_count = 0, outstanding_amount_cents = 0,
                last_payment_failed_at = NULL,
                current_period_start = $1, current_period_end = $2,
                metadata = coalesce(metadata, '{}'::jsonb) ||
                           jsonb_build_object('billing_day_of_month', $4::int, 'billing_timezone', $5::text),
                updated_at = now()
          WHERE id = $3::uuid`,
        [now, newEnd, subscriptionId, preferredDay, BILLING_TIMEZONE],
      );

      await this.createInvoice(
        pool, orgId, subscriptionId, chargeResult.transactionId!,
        fxResult.zarCents, 'Subscription renewal', fxResult.snapshot,
      );

      // Schedule next renewal task
      await this.enqueueRenewal(pool, orgId, subscriptionId, newEnd);

      return { ok: true, message: 'renewed', cancelled: false, transactionId: chargeResult.transactionId };
    }

    // Charge failed
    const newCount = sub.failed_payment_count + 1;
    await pool.query(
      `UPDATE billing_subscriptions
          SET failed_payment_count = $1,
              last_payment_failed_at = COALESCE(last_payment_failed_at, $2),
              status = 'past_due',
              outstanding_amount_cents = GREATEST(outstanding_amount_cents, $3),
              updated_at = now()
        WHERE id = $4::uuid`,
      [newCount, now, usdCents, subscriptionId],
    );

    const updatedSub = { ...sub, failed_payment_count: newCount };
    if (this.shouldDowngrade(updatedSub, now)) {
      await this.autoDowngrade(pool, subscriptionId, orgId, 'past_due_14_days');
      return { ok: false, message: chargeResult.message ?? 'charge failed', cancelled: true };
    }

    return { ok: false, message: chargeResult.message ?? 'charge failed', cancelled: false };
  }

  // ── Billing day change with proration ──────────────────────────────────────

  async changeBillingDay(
    pool: pg.Pool,
    orgId: string,
    newDay: number,
  ): Promise<{ newDue: Date; prorationCents: number; zarCents: number }> {
    if (newDay < 1 || newDay > 31) throw new Error('day_of_month must be between 1 and 31');

    const now = this.cfg.clock.now();

    const subRes = await pool.query<{
      id: string;
      current_period_end: Date | null;
      metadata: Record<string, unknown> | null;
      price_usd_cents: number;
    }>(
      `SELECT s.id, s.current_period_end, s.metadata, t.price_usd_cents
         FROM billing_subscriptions s
         JOIN billing_tiers t ON t.id = s.tier_id
        WHERE s.organization_id = $1::uuid
        ORDER BY s.created_at DESC LIMIT 1`,
      [orgId],
    );
    if (subRes.rows.length === 0) throw new Error('No subscription found');
    const sub = subRes.rows[0]!;
    const subId = sub.id;

    const oldDay = resolvePreferredBillingDay(sub, now);
    if (newDay === oldDay) throw new Error('Already set to this billing day');

    const oldDue = sub.current_period_end ? new Date(sub.current_period_end) : now;
    const { newDue, prorationCents: prorationUsdCents } = calcProration(
      now, oldDue, newDay, sub.price_usd_cents,
    );

    let zarCents = 0;
    if (prorationUsdCents > 0) {
      // Charge proration via saved card
      const authRes = await pool.query<{ id: string; paystack_authorization_code: string; email: string }>(
        `SELECT id, paystack_authorization_code, email
           FROM billing_authorizations
          WHERE organization_id = $1::uuid AND is_default = true AND is_active = true AND deleted_at IS NULL
         LIMIT 1`,
        [orgId],
      );
      const auth = authRes.rows[0];
      if (!auth) throw new Error('No valid payment method on file');

      const fxResult = await this.computeFxSnapshot(pool, prorationUsdCents);
      if (!fxResult) throw new Error('Exchange rate unavailable');

      zarCents = fxResult.zarCents;

      const chargeResult = await this.chargeAndRecord(
        pool, orgId, auth, zarCents, prorationUsdCents, fxResult.snapshot,
        'subscription', subId, null,
        { action: 'billing_day_change_proration', old_day: oldDue.getDate(), new_day: newDay },
      );

      if (!chargeResult.ok) throw new Error(`Proration payment failed: ${chargeResult.message}`);

      await this.createInvoice(
        pool, orgId, subId, chargeResult.transactionId!, zarCents,
        'Billing date change proration', fxResult.snapshot,
      );
    }

    // Update subscription schedule
    await pool.query(
      `UPDATE billing_subscriptions
          SET current_period_end = $1,
              metadata = coalesce(metadata, '{}'::jsonb) ||
                         jsonb_build_object('billing_day_of_month', $2::int, 'billing_timezone', $3::text),
              updated_at = now()
        WHERE id = $4::uuid`,
      [newDue, newDay, BILLING_TIMEZONE, subId],
    );

    return { newDue, prorationCents: prorationUsdCents, zarCents };
  }

  // ── Voucher apply ──────────────────────────────────────────────────────────

  /**
   * Validate and apply a voucher code to an upcoming invoice.
   * Returns the discount in USD cents.
   */
  async applyVoucher(
    pool: pg.Pool,
    orgId: string,
    voucherCode: string,
    invoiceUsdCents: number,
  ): Promise<{ discountUsdCents: number; freeMonths: number }> {
    const vRes = await pool.query<{
      id: string;
      discount_type: string;
      discount_value: number;
      max_redemptions: number | null;
      redemption_count: number;
      valid_from: Date | null;
      valid_until: Date | null;
      tier_restriction: string | null;
    }>(
      `SELECT id, discount_type, discount_value, max_redemptions, redemption_count,
              valid_from, valid_until, tier_restriction
         FROM billing_vouchers
        WHERE code = $1 AND is_active = true`,
      [voucherCode],
    );
    if (vRes.rows.length === 0) throw new Error('Voucher not found or inactive');
    const v = vRes.rows[0]!;

    const now = this.cfg.clock.now();
    if (v.valid_from && now < new Date(v.valid_from)) throw new Error('Voucher not yet valid');
    if (v.valid_until && now > new Date(v.valid_until)) throw new Error('Voucher has expired');
    if (v.max_redemptions !== null && v.redemption_count >= v.max_redemptions) {
      throw new Error('Voucher redemption limit reached');
    }

    // Check if org already redeemed this voucher
    const redeemedRes = await pool.query(
      `SELECT 1 FROM billing_voucher_redemptions WHERE voucher_id = $1::uuid AND organization_id = $2::uuid`,
      [v.id, orgId],
    );
    if (redeemedRes.rows.length > 0) throw new Error('Voucher already redeemed');

    let discountUsdCents = 0;
    let freeMonths = 0;

    if (v.discount_type === 'percent') {
      discountUsdCents = Math.floor(invoiceUsdCents * (Number(v.discount_value) / 100));
    } else if (v.discount_type === 'fixed_usd') {
      discountUsdCents = Math.min(Math.round(Number(v.discount_value) * 100), invoiceUsdCents);
    } else if (v.discount_type === 'free_months') {
      freeMonths = Math.floor(Number(v.discount_value));
      discountUsdCents = invoiceUsdCents * freeMonths;
    }

    // Atomically increment redemption count and insert redemption record
    await pool.query(
      `UPDATE billing_vouchers SET redemption_count = redemption_count + 1 WHERE id = $1::uuid`,
      [v.id],
    );
    await pool.query(
      `INSERT INTO billing_voucher_redemptions
         (voucher_id, organization_id, discount_applied_usd)
       VALUES ($1::uuid, $2::uuid, $3)`,
      [v.id, orgId, discountUsdCents / 100],
    );

    return { discountUsdCents, freeMonths };
  }

  // ── Refund record ──────────────────────────────────────────────────────────

  async recordRefund(
    pool: pg.Pool,
    orgId: string,
    transactionId: string,
    amountZarCents: number,
    reason?: string,
  ): Promise<string> {
    // Copy FX snapshot from original transaction (immutable per spec)
    const txnRes = await pool.query<{
      usd_amount: number;
      fx_rate: number;
      zar_amount: number;
      fx_fetched_at: Date | null;
      invoice_id: string | null;
    }>(
      `SELECT usd_amount, fx_rate, zar_amount, fx_fetched_at, invoice_id
         FROM billing_transactions
        WHERE id = $1::uuid AND organization_id = $2::uuid`,
      [transactionId, orgId],
    );
    if (txnRes.rows.length === 0) throw new Error('Transaction not found');
    const txn = txnRes.rows[0]!;

    const refRes = await pool.query<{ id: string }>(
      `INSERT INTO billing_refunds
         (organization_id, transaction_id, invoice_id, amount_cents, reason, status,
          usd_amount, fx_rate, zar_amount, fx_fetched_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'pending', $6, $7, $8, $9)
       RETURNING id`,
      [
        orgId, transactionId, txn.invoice_id || null,
        amountZarCents, reason || null,
        txn.usd_amount, txn.fx_rate, txn.zar_amount, txn.fx_fetched_at,
      ],
    );
    return refRes.rows[0]!.id;
  }

  // ── Wallet operations ──────────────────────────────────────────────────────

  async getOrCreateWallet(pool: pg.Pool, orgId: string): Promise<WalletRow> {
    await pool.query(
      `INSERT INTO billing_wallets (organization_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`,
      [orgId],
    );
    const res = await pool.query<WalletRow>(
      `SELECT id, balance_cents AS "balanceCents",
              auto_topup_enabled AS "autoTopupEnabled",
              auto_topup_amount_cents AS "autoTopupAmountCents",
              auto_topup_threshold_cents AS "autoTopupThresholdCents"
         FROM billing_wallets
        WHERE organization_id = $1::uuid`,
      [orgId],
    );
    return res.rows[0]!;
  }

  async creditWallet(
    pool: pg.Pool,
    orgId: string,
    amountCents: number,
    description: string,
    transactionId?: string,
  ): Promise<number> {
    await pool.query(
      `INSERT INTO billing_wallets (organization_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`,
      [orgId],
    );
    const res = await pool.query<{ balance_cents: number }>(
      `UPDATE billing_wallets SET balance_cents = balance_cents + $2, updated_at = now()
        WHERE organization_id = $1::uuid RETURNING balance_cents`,
      [orgId, amountCents],
    );
    const newBalance = res.rows[0]!.balance_cents;

    await pool.query(
      `INSERT INTO billing_wallet_ledger
         (organization_id, wallet_id, entry_type, amount_cents, balance_after_cents, description, transaction_id)
       VALUES ($1::uuid, (SELECT id FROM billing_wallets WHERE organization_id = $1::uuid), 'credit', $2, $3, $4, $5::uuid)`,
      [orgId, amountCents, newBalance, description, transactionId || null],
    );

    // Check auto-topup trigger (for crediting on topup)
    const wallet = await this.getOrCreateWallet(pool, orgId);
    if (wallet.autoTopupEnabled && wallet.autoTopupAmountCents >= MIN_TOPUP_CENTS) {
      // Already crediting — no need to re-trigger here; worker handles periodic checks
    }

    return newBalance;
  }

  async debitWallet(
    pool: pg.Pool,
    orgId: string,
    amountCents: number,
    description: string,
  ): Promise<{ newBalance: number; ok: boolean }> {
    const res = await pool.query<{ balance_cents: number }>(
      `UPDATE billing_wallets
          SET balance_cents = balance_cents - $2, updated_at = now()
        WHERE organization_id = $1::uuid AND balance_cents >= $2
       RETURNING balance_cents`,
      [orgId, amountCents],
    );
    if (res.rows.length === 0) return { newBalance: 0, ok: false };
    const newBalance = res.rows[0]!.balance_cents;

    await pool.query(
      `INSERT INTO billing_wallet_ledger
         (organization_id, wallet_id, entry_type, amount_cents, balance_after_cents, description)
       VALUES ($1::uuid, (SELECT id FROM billing_wallets WHERE organization_id = $1::uuid), 'debit', $2, $3, $4)`,
      [orgId, amountCents, newBalance, description],
    );

    return { newBalance, ok: true };
  }

  // ── Auto-downgrade ─────────────────────────────────────────────────────────

  async autoDowngrade(
    pool: pg.Pool,
    subscriptionId: string,
    orgId: string,
    reason: string,
  ): Promise<void> {
    const tierRes = await pool.query<{ id: string }>(
      `SELECT id FROM billing_tiers WHERE slug = 'free'`,
    );
    const freeTierId = tierRes.rows[0]?.id;
    if (!freeTierId) return;

    const now = this.cfg.clock.now();
    await pool.query(
      `UPDATE billing_subscriptions
          SET tier_id = $1::uuid, status = 'active', failed_payment_count = 0,
              last_payment_failed_at = NULL,
              cancelled_at = $2, downgraded_at = $2, downgrade_reason = $3,
              current_period_start = $2, current_period_end = NULL, updated_at = now()
        WHERE id = $4::uuid`,
      [freeTierId, now, reason, subscriptionId],
    );
  }

  // ── Queue scheduling ───────────────────────────────────────────────────────

  async enqueueRenewal(
    pool: pg.Pool,
    orgId: string,
    subscriptionId: string,
    periodEnd: Date,
  ): Promise<void> {
    const sim = this.cfg.billingSimConfig;
    const cycleKey =
      sim?.billingSimEnabled
        ? periodEnd.toISOString()
        : periodEnd.toISOString().slice(0, 10);

    await pool.query(
      `INSERT INTO billing_queue
         (organization_id, task_type, subscription_id, run_at, cycle_key, idempotency_key, status, max_attempts)
       VALUES ($1::uuid, 'subscription_renewal', $2::uuid, $3, $4, $5, 'pending', 3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        orgId,
        subscriptionId,
        periodEnd,
        cycleKey,
        `subscription:${subscriptionId}:${cycleKey}`,
      ],
    );
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Charge via Paystack + record billing_transaction + billing_payment_attempt.
   * Returns { ok, transactionId, message }.
   */
  private async chargeAndRecord(
    pool: pg.Pool,
    orgId: string,
    auth: { id: string; paystack_authorization_code: string; email: string },
    zarCents: number,
    usdCents: number,
    snapshot: FxSnapshot,
    chargeType: string,
    subscriptionId: string | null,
    invoiceId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<{ ok: boolean; transactionId?: string | undefined; message?: string | undefined }> {
    // Test/seed bypass: AUTH_seed_* and AUTH_test_* codes bypass real Paystack
    if (
      auth.paystack_authorization_code.startsWith('AUTH_seed_') ||
      auth.paystack_authorization_code.startsWith('AUTH_test_')
    ) {
      const psRef = `test-bypass-${randomStr(16)}`;
      const txnId = await this.insertTransaction(
        pool, orgId, subscriptionId, invoiceId, auth.id, psRef,
        zarCents, usdCents, snapshot, chargeType, 'success', 'test bypass',
      );
      await this.recordPaymentAttempt(pool, {
        organizationId: orgId,
        subscriptionId: subscriptionId ?? undefined,
        invoiceId: invoiceId ?? undefined,
        transactionId: txnId,
        authorizationId: auth.id,
        source: 'saved_card',
        providerRef: psRef,
        status: 'success',
        chargeType,
        amountCents: zarCents,
        currency: 'ZAR',
        usdAmount: snapshot.usdAmount,
        fxRate: snapshot.fxRate,
        zarAmount: snapshot.zarAmount,
        fxFetchedAt: snapshot.fxFetchedAt,
        metadata,
      });
      return { ok: true, transactionId: txnId };
    }

    const chargeReq = {
      authorizationCode: auth.paystack_authorization_code,
      email: auth.email,
      amount: zarCents,
      currency: 'ZAR',
      metadata: { organization_id: orgId, charge_type: chargeType, ...metadata },
    };

    let psResult: PaystackChargeResult;
    try {
      psResult = await this.paystack.chargeAuthorization(chargeReq);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Paystack request failed';
      await this.recordPaymentAttempt(pool, {
        organizationId: orgId,
        subscriptionId: subscriptionId ?? undefined,
        authorizationId: auth.id,
        source: 'saved_card',
        providerRef: `request-${randomStr(16)}`,
        status: 'failed',
        chargeType,
        amountCents: zarCents,
        currency: 'ZAR',
        usdAmount: snapshot.usdAmount,
        fxRate: snapshot.fxRate,
        zarAmount: snapshot.zarAmount,
        fxFetchedAt: snapshot.fxFetchedAt,
        failureReason: `Paystack request failed: ${msg}`,
        metadata,
      });
      return { ok: false, message: 'Payment failed. Please try again or update your card.' };
    }

    const txnStatus = psResult.status === 'success' ? 'success' : 'failed';
    const txnId = await this.insertTransaction(
      pool, orgId, subscriptionId, invoiceId, auth.id, psResult.reference,
      zarCents, usdCents, snapshot, chargeType, txnStatus, psResult.gatewayResponse,
    );

    await this.recordPaymentAttempt(pool, {
      organizationId: orgId,
      subscriptionId: subscriptionId ?? undefined,
      invoiceId: invoiceId ?? undefined,
      transactionId: txnId,
      authorizationId: auth.id,
      source: 'saved_card',
      providerRef: psResult.reference,
      status: txnStatus,
      chargeType,
      amountCents: zarCents,
      currency: 'ZAR',
      usdAmount: snapshot.usdAmount,
      fxRate: snapshot.fxRate,
      zarAmount: snapshot.zarAmount,
      fxFetchedAt: snapshot.fxFetchedAt,
      failureReason: txnStatus === 'failed' ? psResult.gatewayResponse : undefined,
      metadata,
    });

    if (txnStatus !== 'success') {
      return { ok: false, transactionId: txnId, message: 'Payment failed. Please try again or update your card.' };
    }

    return { ok: true, transactionId: txnId };
  }

  private async insertTransaction(
    pool: pg.Pool,
    orgId: string,
    subscriptionId: string | null,
    invoiceId: string | null,
    authId: string,
    psRef: string,
    zarCents: number,
    usdCents: number,
    snapshot: FxSnapshot,
    chargeType: string,
    status: 'success' | 'failed' | 'pending',
    gatewayResponse: string,
  ): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO billing_transactions
         (organization_id, subscription_id, invoice_id, authorization_id,
          paystack_reference, amount_cents, currency, status, charge_type, gateway_response, paid_at,
          usd_amount, fx_rate, zar_amount, fx_fetched_at)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
          $5, $6, 'ZAR', $7::transaction_status, $8, $9,
          CASE WHEN $7::transaction_status = 'success' THEN now() ELSE NULL END,
          $10, $11, $12, $13)
       ON CONFLICT (paystack_reference)
       DO UPDATE SET status = excluded.status, gateway_response = excluded.gateway_response, updated_at = now()
       RETURNING id`,
      [
        orgId,
        subscriptionId || null,
        invoiceId || null,
        authId || null,
        psRef,
        zarCents,
        status,
        chargeType,
        gatewayResponse,
        snapshot.usdAmount,
        snapshot.fxRate,
        snapshot.zarAmount,
        snapshot.fxFetchedAt,
      ],
    );
    return res.rows[0]!.id;
  }

  private async recordPaymentAttempt(
    pool: pg.Pool,
    a: {
      organizationId: string;
      subscriptionId?: string | undefined;
      invoiceId?: string | undefined;
      transactionId?: string | undefined;
      authorizationId?: string | undefined;
      source: string;
      providerRef: string;
      status: 'success' | 'failed' | 'pending';
      chargeType: string;
      amountCents: number;
      currency: string;
      usdAmount?: number | undefined;
      fxRate?: number | undefined;
      zarAmount?: number | undefined;
      fxFetchedAt?: Date | null | undefined;
      failureReason?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
    },
  ): Promise<void> {
    await pool
      .query(
        `INSERT INTO billing_payment_attempts
           (organization_id, subscription_id, invoice_id, transaction_id, authorization_id,
            source, provider, provider_reference, status, charge_type, amount_cents, currency,
            usd_amount, fx_rate, zar_amount, fx_fetched_at,
            failure_reason, metadata)
         VALUES
           ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
            $6, 'paystack', $7, $8::transaction_status, $9, $10, $11,
            $12, $13, $14, $15,
            $16, $17::jsonb)
         ON CONFLICT (provider, source, provider_reference, status) DO NOTHING`,
        [
          a.organizationId,
          a.subscriptionId || null,
          a.invoiceId || null,
          a.transactionId || null,
          a.authorizationId || null,
          a.source,
          a.providerRef,
          a.status,
          a.chargeType,
          a.amountCents,
          a.currency,
          a.usdAmount ?? 0,
          a.fxRate ?? 1,
          a.zarAmount ?? 0,
          a.fxFetchedAt ?? null,
          a.failureReason || null,
          JSON.stringify(a.metadata ?? {}),
        ],
      )
      .catch(() => {/* best-effort */});
  }

  private shouldDowngrade(
    sub: { failed_payment_count: number; last_payment_failed_at: Date | null; grace_period_days: number },
    now: Date,
  ): boolean {
    const graceDays = sub.grace_period_days ?? GRACE_PERIOD_DAYS_DEFAULT;
    if (!sub.last_payment_failed_at) return false;

    const sim = this.cfg.billingSimConfig;
    const gracePeriodMs = sim?.billingSimEnabled && sim.billingSimDaySeconds > 0
      ? graceDays * sim.billingSimDaySeconds * 1_000
      : graceDays * 24 * 60 * 60 * 1_000;

    const failedAt = new Date(sub.last_payment_failed_at);
    return now.getTime() - failedAt.getTime() > gracePeriodMs;
  }

  private nextPeriodEnd(now: Date, preferredDay: number): Date {
    const sim = this.cfg.billingSimConfig;
    if (sim?.billingSimEnabled && sim.billingSimDaySeconds > 0) {
      return new Date(now.getTime() + cycleDuration(sim));
    }
    return nextBillingAnchorAfter(now, preferredDay);
  }

  private async upsertSubscription(
    pool: pg.Pool,
    orgId: string,
    tierId: string,
    existingSubId: string | null,
    now: Date,
    periodEnd: Date,
    preferredDay: number,
  ): Promise<string> {
    if (existingSubId) {
      await pool.query(
        `UPDATE billing_subscriptions
            SET tier_id = $1::uuid, status = 'active', failed_payment_count = 0,
                last_payment_failed_at = NULL, outstanding_amount_cents = 0,
                current_period_start = $2, current_period_end = $3,
                metadata = coalesce(metadata, '{}'::jsonb) ||
                           jsonb_build_object('billing_day_of_month', $5::int, 'billing_timezone', $6::text),
                cancelled_at = NULL, cancel_at_period_end = false,
                downgraded_at = NULL, downgrade_reason = NULL,
                updated_at = now()
          WHERE id = $4::uuid`,
        [tierId, now, periodEnd, existingSubId, preferredDay, BILLING_TIMEZONE],
      );
      return existingSubId;
    }

    const res = await pool.query<{ id: string }>(
      `INSERT INTO billing_subscriptions
         (organization_id, tier_id, status, current_period_start, current_period_end, metadata)
       VALUES ($1::uuid, $2::uuid, 'active', $3, $4,
               jsonb_build_object('billing_day_of_month', $5::int, 'billing_timezone', $6::text))
       RETURNING id`,
      [orgId, tierId, now, periodEnd, preferredDay, BILLING_TIMEZONE],
    );
    return res.rows[0]!.id;
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * Resolve the preferred billing day from a subscription row's metadata.
 * Falls back to the period_end day, then current day.
 */
export function resolvePreferredBillingDay(
  sub: { metadata: Record<string, unknown> | null; current_period_end?: Date | null } | null,
  now: Date,
): number {
  if (sub?.metadata?.['billing_day_of_month']) {
    const d = Number(sub.metadata['billing_day_of_month']);
    if (d >= 1 && d <= 31) return d;
  }
  if (sub?.current_period_end) {
    const pe = new Date(sub.current_period_end);
    // Get SAST day
    const fmt = new Intl.DateTimeFormat('en-ZA', {
      timeZone: BILLING_TIMEZONE,
      day: 'numeric',
    });
    return parseInt(fmt.format(pe), 10);
  }
  const fmt = new Intl.DateTimeFormat('en-ZA', {
    timeZone: BILLING_TIMEZONE,
    day: 'numeric',
  });
  return parseInt(fmt.format(now), 10);
}

function randomStr(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}
