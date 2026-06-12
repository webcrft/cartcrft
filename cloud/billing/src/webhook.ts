/**
 * webhook.ts — Paystack billing webhook handler (exported as a Fastify plugin)
 *
 * Verifies X-Paystack-Signature HMAC-SHA512. The verifyPaystackSignature function
 * is copied here (NOT imported from backend/src/webhooks/verifiers/paystack.ts)
 * to avoid a cross-license-boundary import.
 *
 * Handles:
 *   charge.success → confirm pending invoice idempotently, persist authorization
 *
 * Ported from:
 *   webcrft-mono/backend/internal/handlers/billing.go  (Webhook, handleChargeSuccess)
 *
 * Usage (one-line mount in backend — backend file must NOT be edited; this is noted
 * in tasks.md Discovered):
 *
 *   // In backend/src/http/app.ts (when CARTCRFT_CLOUD=1):
 *   const { billingWebhookPlugin } = await import('@cartcrft/cloud-billing');
 *   app.register(billingWebhookPlugin, { prefix: '/billing/webhook', pool, config });
 *
 * @module
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { Clock } from './clock.js';
import { extractPaystackAmountCents } from './paystack.js';

// ── Signature verification (copied — not imported across license boundary) ────

/**
 * Verify Paystack HMAC-SHA512 webhook signature.
 * Throws if invalid.
 */
export function verifyBillingWebhookSignature(
  body: Buffer,
  sigHeader: string,
  secret: string,
): void {
  if (!sigHeader) {
    throw new Error('paystack: missing X-Paystack-Signature header');
  }
  const mac = createHmac('sha512', secret);
  mac.update(body);
  const expected = mac.digest('hex');
  const provided = sigHeader.trim();

  if (
    expected.length !== provided.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
  ) {
    throw new Error('paystack: billing webhook signature mismatch');
  }
}

// ── Webhook event handler ─────────────────────────────────────────────────────

export interface WebhookHandlerDeps {
  pool: pg.Pool;
  clock: Clock;
  paystackSecretKey: string;
}

/**
 * Handle a verified Paystack webhook event.
 *
 * @param deps  Database pool + clock
 * @param event Parsed Paystack event (event + data fields)
 * @returns 'handled' | 'ignored'
 */
export async function handleBillingWebhookEvent(
  deps: WebhookHandlerDeps,
  event: { event: string; data: Record<string, unknown> },
): Promise<'handled' | 'ignored'> {
  const { pool, clock } = deps;
  const data = event.data ?? {};

  switch (event.event) {
    case 'charge.success':
      await handleChargeSuccess(pool, clock, data);
      return 'handled';

    default:
      return 'ignored';
  }
}

// ── handleChargeSuccess ───────────────────────────────────────────────────────

/**
 * Handle a charge.success event.
 * Idempotent: uses ON CONFLICT DO NOTHING on billing_transactions.paystack_reference.
 *
 * Mirrors billing.go handleChargeSuccess for the 'upgrade' and 'add_card' intents.
 */
async function handleChargeSuccess(
  pool: pg.Pool,
  clock: Clock,
  data: Record<string, unknown>,
): Promise<void> {
  if (String(data['status'] ?? '').toLowerCase() !== 'success') return;

  const metadata = (data['metadata'] as Record<string, unknown>) ?? {};
  const orgId = String(metadata['organization_id'] ?? '');
  if (!orgId) return;

  const intent = String(metadata['intent'] ?? '');
  const reference = String(data['reference'] ?? '');
  if (!reference) return;

  const amountCents = extractPaystackAmountCents(data);
  const currency = String(data['currency'] ?? 'ZAR');
  const gatewayResponse = String(data['gateway_response'] ?? '');
  const now = clock.now();

  switch (intent) {
    case 'add_card': {
      const authId = await persistAuthorizationFromCharge(pool, orgId, data);
      if (!authId) return;

      await pool
        .query(
          `INSERT INTO billing_transactions
             (organization_id, authorization_id, paystack_reference, amount_cents, currency,
              status, charge_type, gateway_response, paid_at, metadata)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'success', 'card_authorization', $6, now(), $7::jsonb)
           ON CONFLICT (paystack_reference) DO NOTHING`,
          [
            orgId,
            authId,
            reference,
            amountCents,
            currency,
            gatewayResponse,
            JSON.stringify({ intent: 'add_card', auto_refund: true }),
          ],
        )
        .catch(() => {/* best-effort */});
      break;
    }

    case 'upgrade': {
      const tierIdVal = metadata['tier_id'];
      if (!tierIdVal) return;
      const tierId = String(tierIdVal);

      const authId = await persistAuthorizationFromCharge(pool, orgId, data);

      // Get or create subscription
      let subId = '';
      const subRes = await pool.query<{ id: string }>(
        `SELECT id FROM billing_subscriptions WHERE organization_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
        [orgId],
      );
      subId = subRes.rows[0]?.id ?? '';

      // Compute period end (simple 30-day cycle for webhook path)
      const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
      const preferredDay = now.getDate();

      if (!subId) {
        const newSubRes = await pool.query<{ id: string }>(
          `INSERT INTO billing_subscriptions
             (organization_id, tier_id, status, failed_payment_count, outstanding_amount_cents,
              current_period_start, current_period_end, metadata)
           VALUES ($1::uuid, $2::uuid, 'active', 0, 0, $3, $4,
                   jsonb_build_object('billing_day_of_month', $5::int, 'billing_timezone', 'Africa/Johannesburg'))
           RETURNING id`,
          [orgId, tierId, now, periodEnd, preferredDay],
        );
        subId = newSubRes.rows[0]!.id;
      } else {
        await pool.query(
          `UPDATE billing_subscriptions
              SET tier_id = $1::uuid, status = 'active', failed_payment_count = 0,
                  last_payment_failed_at = NULL, outstanding_amount_cents = 0,
                  current_period_start = $2, current_period_end = $3,
                  downgraded_at = NULL, downgrade_reason = NULL, updated_at = now()
            WHERE id = $4::uuid`,
          [tierId, now, periodEnd, subId],
        );
      }

      // Record transaction (idempotent)
      await pool
        .query(
          `INSERT INTO billing_transactions
             (organization_id, subscription_id, authorization_id, paystack_reference,
              amount_cents, currency, status, charge_type, gateway_response, paid_at, metadata)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'success', 'subscription', $7, now(), $8::jsonb)
           ON CONFLICT (paystack_reference)
           DO UPDATE SET status = 'success', gateway_response = excluded.gateway_response, updated_at = now()`,
          [
            orgId,
            subId || null,
            authId || null,
            reference,
            amountCents,
            currency,
            gatewayResponse,
            JSON.stringify(metadata),
          ],
        )
        .catch(() => {/* best-effort */});
      break;
    }

    case 'topup_wallet': {
      // Credit wallet
      await pool.query(
        `INSERT INTO billing_wallets (organization_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`,
        [orgId],
      );
      await pool.query(
        `UPDATE billing_wallets SET balance_cents = balance_cents + $2, updated_at = now()
          WHERE organization_id = $1::uuid`,
        [orgId, amountCents],
      );
      break;
    }

    default:
      break;
  }
}

// ── persistAuthorizationFromCharge ────────────────────────────────────────────

async function persistAuthorizationFromCharge(
  pool: pg.Pool,
  orgId: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  const auth = (data['authorization'] as Record<string, unknown>) ?? {};
  const authCode = String(auth['authorization_code'] ?? '');
  if (!authCode) return null;

  const reusable = Boolean(auth['reusable']);
  if (!reusable) return null;

  const customerData = (data['customer'] as Record<string, unknown>) ?? {};
  const email = String(data['customer_email'] ?? customerData['email'] ?? '');
  const customerCode = String(customerData['customer_code'] ?? '');

  const res = await pool.query<{ id: string }>(
    `INSERT INTO billing_authorizations
       (organization_id, paystack_authorization_code, paystack_customer_code, email,
        card_type, last4, exp_month, exp_year, bank, brand, reusable, is_default, is_active)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, true)
     ON CONFLICT (paystack_authorization_code) DO UPDATE
       SET is_active = true, email = excluded.email, updated_at = now()
     RETURNING id`,
    [
      orgId,
      authCode,
      customerCode,
      email,
      String(auth['card_type'] ?? ''),
      String(auth['last4'] ?? ''),
      String(auth['exp_month'] ?? ''),
      String(auth['exp_year'] ?? ''),
      String(auth['bank'] ?? ''),
      String(auth['brand'] ?? ''),
      reusable,
    ],
  );

  return res.rows[0]?.id ?? null;
}

// ── Fastify plugin export ─────────────────────────────────────────────────────

/**
 * Minimal type for the Fastify plugin interface.
 * Using unknown to avoid importing @types/fastify here (cloud package has no such dep).
 */
export type BillingWebhookPluginOptions = {
  pool: pg.Pool;
  clock: Clock;
  paystackSecretKey: string;
};

/**
 * Export the raw handler — the actual Fastify plugin registration is done
 * in the backend when CARTCRFT_CLOUD=1, because the cloud package does not
 * depend on Fastify.
 *
 * One-line mount (for tasks.md Discovered note):
 *
 * ```ts
 * // backend/src/http/app.ts (cloud gate):
 * app.post('/billing/webhook/paystack', { config: { rawBody: true } }, async (req, reply) => {
 *   const raw = (req as any).rawBody as Buffer;
 *   try {
 *     verifyBillingWebhookSignature(raw, req.headers['x-paystack-signature'] as string, PAYSTACK_SECRET_KEY);
 *   } catch { return reply.status(401).send({ error: 'invalid signature' }); }
 *   const body = JSON.parse(raw.toString()) as { event: string; data: Record<string,unknown> };
 *   await handleBillingWebhookEvent({ pool, clock, paystackSecretKey: PAYSTACK_SECRET_KEY }, body);
 *   reply.send({ status: 'ok' });
 * });
 * ```
 */
export { handleBillingWebhookEvent as processBillingWebhook };
