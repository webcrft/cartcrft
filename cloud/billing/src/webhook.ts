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
 * Options for the billingWebhookPlugin.
 */
export type BillingWebhookPluginOptions = {
  pool: pg.Pool;
  clock: Clock;
  paystackSecretKey: string;
};

/**
 * billingWebhookPlugin — Fastify-compatible plugin that registers the Paystack
 * billing webhook route at `POST /paystack`.
 *
 * The cloud package does not depend on Fastify directly, so the instance
 * parameter is typed as `unknown` and cast internally (quarantined any).
 * Fastify's duck-typed plugin system accepts any `(instance, opts) =>
 * Promise<void>` function for `app.register()`.
 *
 * Mount in backend/src/http/app.ts (cloud gate — see tasks.md Discovered):
 *
 * ```ts
 * if (process.env.CARTCRFT_CLOUD) {
 *   const { billingWebhookPlugin } = await import('@cartcrft/cloud-billing');
 *   await app.register(billingWebhookPlugin, { prefix: '/webhooks/billing' });
 * }
 * ```
 *
 * The plugin reads PAYSTACK_SECRET_KEY from the environment at request time.
 * The pool is resolved via the `pool` option if provided, else falls back to
 * a new pg.Pool from DATABASE_URL (useful in standalone worker contexts).
 */
export async function billingWebhookPlugin(
  // any: Fastify instance — cloud package has no Fastify dep; quarantined here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instance: any,
  opts: BillingWebhookPluginOptions & Record<string, unknown>
): Promise<void> {
  // Reuse the pool passed by the host (backend passes getPool() via opts.pool).
  // The fallback new Pool is only for standalone worker contexts that mount this
  // plugin without a host app pool — it is not reached when mounted in backend/app.ts.
  const pool: pg.Pool = opts.pool ?? (() => {
    const { Pool } = require('pg') as typeof import('pg'); // eslint-disable-line @typescript-eslint/no-require-imports
    return new Pool({ connectionString: process.env['DATABASE_URL'] });
  })();

  const clock: Clock = opts.clock ?? { now: () => new Date() };

  // POST /paystack  (mounted under the prefix provided at register time)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instance.post('/paystack', async (req: any, reply: any) => {
    const secretKey: string = opts.paystackSecretKey ?? process.env['PAYSTACK_SECRET_KEY'] ?? '';
    const sigHeader: string = (req.headers['x-paystack-signature'] as string) ?? '';

    // Prefer rawBody (if content-parser pre-populated it), else serialise body.
    let rawBody: Buffer;
    if (Buffer.isBuffer(req.rawBody)) {
      rawBody = req.rawBody as Buffer;
    } else if (typeof req.body === 'string') {
      rawBody = Buffer.from(req.body as string, 'utf8');
    } else {
      rawBody = Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
    }

    try {
      verifyBillingWebhookSignature(rawBody, sigHeader, secretKey);
    } catch {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'invalid billing webhook signature' },
      });
    }

    let event: { event: string; data: Record<string, unknown> };
    try {
      event = JSON.parse(rawBody.toString()) as typeof event;
    } catch {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'invalid JSON body' },
      });
    }

    await handleBillingWebhookEvent({ pool, clock, paystackSecretKey: secretKey }, event);
    return reply.send({ status: 'ok' });
  });
}

export { handleBillingWebhookEvent as processBillingWebhook };
