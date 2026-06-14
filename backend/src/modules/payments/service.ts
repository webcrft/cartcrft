/**
 * payments/service.ts — SQL-backed payments service.
 *
 * Exports:
 *  - Payment CRUD (createPayment, capturePayment, createRefund, listPayments)
 *  - Payment provider CRUD (listProviders, upsertProvider, deleteProvider)
 *  - Payment gateway CRUD (listGateways, upsertGateway, setGatewayDevCredentials, getGatewayStatus)
 *  - Provider session creators (createStripeSession, createPaystackSession, etc.)
 */

import { getPool, getReadDb, withTx } from "../../db/pool.js";
import { config } from "../../config/config.js";
import { encodeSecretValue } from "../../lib/secrets.js";
import { dispatchStoreEvent } from "../notifications/service.js";
import { StripeClient } from "../../providers/payments/stripe.js";
import { PaystackClient } from "../../providers/payments/paystack.js";
import { RazorpayClient } from "../../providers/payments/razorpay.js";
import { XenditClient } from "../../providers/payments/xendit.js";
import type {
  Payment,
  CreatePaymentInput,
  CreatePaymentResult,
  CreateRefundInput,
  CreateRefundResult,
  PaymentProvider,
  UpsertPaymentProviderInput,
  PaymentGatewayInstance,
  UpsertGatewayInput,
  SetGatewayDevCredentialsInput,
} from "./types.js";

const secretsKey = config.AUTH_SECRETS_KEY ?? "";

// ── Payments CRUD ──────────────────────────────────────────────────────────────

export async function listPayments(
  orderId: string,
  storeId: string
): Promise<Payment[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<Payment>(
    `SELECT p.id::text, p.order_id::text, p.provider_id::text,
            p.amount::text, p.currency, p.status, p.provider_reference,
            p.provider_session_id, p.captured_at, p.is_test, p.mode,
            p.metadata, p.created_at, p.updated_at
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     WHERE p.order_id = $1::uuid AND o.store_id = $2::uuid
     ORDER BY p.created_at`,
    [orderId, storeId]
  );
  return rows;
}

export async function createPayment(
  orderId: string,
  storeId: string,
  input: CreatePaymentInput
): Promise<CreatePaymentResult> {
  const amount = parseFloat(input.amount);
  if (isNaN(amount) || amount <= 0) {
    const e = new Error("amount is required and must be > 0");
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }

  return withTx(async (client) => {
    // Resolve currency from order if not provided
    let currency = input.currency?.trim() ?? "";
    if (!currency) {
      const { rows } = await client.query<{ currency: string }>(
        `SELECT currency FROM orders WHERE id = $1::uuid`,
        [orderId]
      );
      currency = rows[0]?.currency ?? "USD";
    }

    const mode = input.mode === "dev" ? "dev" : "live";
    const isTest = mode === "dev";

    // Lock order row FOR UPDATE — check balance
    const { rows: orderRows } = await client.query<{
      total: string;
      total_refunded: string;
    }>(
      `SELECT total::text, total_refunded::text
       FROM orders
       WHERE id = $1::uuid AND store_id = $2::uuid
       FOR UPDATE`,
      [orderId, storeId]
    );

    if (!orderRows[0]) {
      const e = new Error("order not found");
      (e as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw e;
    }

    const orderTotal = parseFloat(orderRows[0].total);
    const totalRefunded = parseFloat(orderRows[0].total_refunded);

    const { rows: capturedRows } = await client.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS sum
       FROM payments
       WHERE order_id = $1::uuid AND status = 'captured'`,
      [orderId]
    );
    const sumCaptured = parseFloat(capturedRows[0]?.sum ?? "0");

    const remaining = orderTotal - sumCaptured - totalRefunded;
    if (amount > remaining + 0.01) {
      const e = new Error("payment amount exceeds remaining order balance");
      (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
      throw e;
    }

    // Idempotency: use INSERT ... ON CONFLICT DO NOTHING + follow-up SELECT
    // to avoid a transaction-aborted state on duplicate provider_reference.
    if (input.provider_reference) {
      const { rows: insertRows } = await client.query<{ id: string }>(
        `INSERT INTO payments
           (order_id, provider_id, amount, currency, status, provider_reference, is_test, mode)
         VALUES ($1::uuid, $2, $3, $4, 'pending', $5, $6, $7)
         ON CONFLICT (order_id, provider_reference) WHERE provider_reference IS NOT NULL
         DO NOTHING
         RETURNING id::text`,
        [
          orderId,
          input.provider_id ?? null,
          amount,
          currency,
          input.provider_reference,
          isTest,
          mode,
        ]
      );

      if (insertRows[0]) {
        return { id: insertRows[0].id, mode, is_test: isTest };
      }

      // ON CONFLICT hit — return existing row
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id::text FROM payments
         WHERE order_id = $1::uuid AND provider_reference = $2`,
        [orderId, input.provider_reference]
      );
      const existingId = existing[0]?.id;
      if (existingId) return { id: existingId, mode, is_test: isTest };
      throw new Error("createPayment: could not find or insert payment");
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO payments
         (order_id, provider_id, amount, currency, status, provider_reference, is_test, mode)
       VALUES ($1::uuid, $2, $3, $4, 'pending', $5, $6, $7)
       RETURNING id::text`,
      [
        orderId,
        input.provider_id ?? null,
        amount,
        currency,
        null,
        isTest,
        mode,
      ]
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("createPayment: no id returned");
    return { id, mode, is_test: isTest };
  });
}

export async function capturePayment(
  paymentId: string,
  orderId: string,
  storeId: string,
  userId?: string | undefined
): Promise<void> {
  await withTx(async (client) => {
    // Lock order row
    const { rows: orderRows } = await client.query<{
      total: string;
      total_refunded: string;
    }>(
      `SELECT total::text, total_refunded::text
       FROM orders
       WHERE id = $1::uuid AND store_id = $2::uuid
       FOR UPDATE`,
      [orderId, storeId]
    );

    if (!orderRows[0]) {
      const e = new Error("order not found");
      (e as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw e;
    }

    const orderTotal = parseFloat(orderRows[0].total);
    const totalRefunded = parseFloat(orderRows[0].total_refunded);

    // Get payment
    const { rows: paymentRows } = await client.query<{
      amount: string;
      status: string;
    }>(
      `SELECT amount::text, status
       FROM payments
       WHERE id = $1::uuid AND order_id = $2::uuid`,
      [paymentId, orderId]
    );

    if (!paymentRows[0]) {
      const e = new Error("payment not found");
      (e as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw e;
    }

    const { amount: amountStr, status } = paymentRows[0];
    if (status !== "pending") {
      const e = new Error("payment is not in 'pending' status");
      (e as NodeJS.ErrnoException).code = "CONFLICT";
      throw e;
    }

    const paymentAmount = parseFloat(amountStr);

    const { rows: capturedRows } = await client.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS sum
       FROM payments
       WHERE order_id = $1::uuid AND status = 'captured'`,
      [orderId]
    );
    const sumCaptured = parseFloat(capturedRows[0]?.sum ?? "0");

    const remaining = orderTotal - sumCaptured - totalRefunded;
    if (paymentAmount > remaining + 0.01) {
      const e = new Error("capturing this payment would exceed the remaining order balance");
      (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
      throw e;
    }

    // Capture the payment
    const { rowCount } = await client.query(
      `UPDATE payments
       SET status = 'captured', captured_at = now(), updated_at = now()
       WHERE id = $1::uuid AND order_id = $2::uuid AND status = 'pending'`,
      [paymentId, orderId]
    );

    if ((rowCount ?? 0) === 0) {
      const e = new Error("payment not found");
      (e as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw e;
    }

    // Update order financial_status
    const newCaptured = sumCaptured + paymentAmount;
    if (newCaptured + 0.01 >= orderTotal) {
      await client.query(
        `UPDATE orders SET financial_status = 'paid', updated_at = now()
         WHERE id = $1::uuid AND store_id = $2::uuid`,
        [orderId, storeId]
      );
    } else {
      await client.query(
        `UPDATE orders SET financial_status = 'partially_paid', updated_at = now()
         WHERE id = $1::uuid AND store_id = $2::uuid AND financial_status = 'pending'`,
        [orderId, storeId]
      );
    }

    // Insert event
    await client
      .query(
        `INSERT INTO order_events (order_id, type, data, created_by)
         VALUES ($1::uuid, 'payment_captured',
                 jsonb_build_object('payment_id', $2::text),
                 $3)`,
        [orderId, paymentId, userId ?? null]
      )
      .catch(() => undefined);

    // Fire-and-forget outbound notification (H2.1)
    dispatchStoreEvent(storeId, "payment.captured", {
      order_id: orderId,
      payment_id: paymentId,
      amount: String(paymentAmount),
    });
  });
}

export async function createRefund(
  paymentId: string,
  orderId: string,
  storeId: string,
  input: CreateRefundInput,
  userId?: string | undefined
): Promise<CreateRefundResult> {
  const amount = parseFloat(input.amount);
  if (isNaN(amount) || amount <= 0) {
    const e = new Error("amount is required and must be > 0");
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }

  const validReasons = new Set([
    "customer_request",
    "defective",
    "not_received",
    "other",
  ]);
  const reason =
    input.reason && validReasons.has(input.reason) ? input.reason : null;

  const idempotencyKey = input.idempotency_key?.trim() || null;

  return withTx(async (client) => {
    // ── Idempotency-Key fast-path ─────────────────────────────────────────
    // If the caller supplied a key, try to look up an existing refund first.
    // We do this BEFORE locking the order row so that concurrent duplicates
    // resolve to the same row without re-running the balance check.
    if (idempotencyKey) {
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id::text FROM refunds
         WHERE payment_id = $1::uuid AND idempotency_key = $2`,
        [paymentId, idempotencyKey]
      );
      if (existing[0]) return { id: existing[0].id };
    }

    // Lock order row
    const { rows: lockRows } = await client.query<{ id: string }>(
      `SELECT id::text FROM orders
       WHERE id = $1::uuid AND store_id = $2::uuid
       FOR UPDATE`,
      [orderId, storeId]
    );
    if (!lockRows[0]) {
      const e = new Error("order not found");
      (e as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw e;
    }

    // Check refundable balance
    const { rows: capturedRows } = await client.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS sum
       FROM payments
       WHERE order_id = $1::uuid AND status = 'captured'`,
      [orderId]
    );
    const { rows: refundedRows } = await client.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS sum
       FROM refunds
       WHERE order_id = $1::uuid AND status IN ('pending','processing','succeeded')`,
      [orderId]
    );

    const sumCaptured = parseFloat(capturedRows[0]?.sum ?? "0");
    const sumRefunded = parseFloat(refundedRows[0]?.sum ?? "0");
    const refundable = sumCaptured - sumRefunded;

    if (amount > refundable + 0.01) {
      const e = new Error(
        "refund amount exceeds captured-and-not-yet-refunded balance"
      );
      (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
      throw e;
    }

    try {
      // Insert with ON CONFLICT on idempotency_key — concurrent duplicate
      // POSTs with the same key both race to insert; exactly one wins and the
      // other gets DO NOTHING, then falls through to the SELECT below.
      const { rows } = idempotencyKey
        ? await client.query<{ id: string }>(
            `INSERT INTO refunds
               (payment_id, order_id, amount, reason, notes, status,
                restock_inventory, provider_reference, idempotency_key, created_by)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'pending', $6, $7, $8, $9)
             ON CONFLICT (payment_id, idempotency_key)
               WHERE idempotency_key IS NOT NULL
             DO NOTHING
             RETURNING id::text`,
            [
              paymentId,
              orderId,
              amount,
              reason,
              input.notes ?? null,
              input.restock ?? true,
              input.provider_reference ?? null,
              idempotencyKey,
              userId ?? null,
            ]
          )
        : await client.query<{ id: string }>(
            `INSERT INTO refunds
               (payment_id, order_id, amount, reason, notes, status,
                restock_inventory, provider_reference, created_by)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'pending', $6, $7, $8)
             RETURNING id::text`,
            [
              paymentId,
              orderId,
              amount,
              reason,
              input.notes ?? null,
              input.restock ?? true,
              input.provider_reference ?? null,
              userId ?? null,
            ]
          );

      if (rows[0]) {
        const refundId = rows[0].id;

        // Update total_refunded on order
        const { rowCount: updateRowCount } = await client.query(
          `UPDATE orders SET total_refunded = total_refunded + $2::numeric, updated_at = now()
           WHERE id = $1::uuid`,
          [orderId, amount]
        );
        if ((updateRowCount ?? 0) === 0) {
          const e = new Error("createRefund: order not found when updating total_refunded");
          (e as NodeJS.ErrnoException).code = "NOT_FOUND";
          throw e;
        }

        // Insert event (best-effort, use savepoint to avoid aborting the transaction)
        try {
          await client.query("SAVEPOINT refund_event");
          await client.query(
            `INSERT INTO order_events (order_id, type, data, created_by)
             VALUES ($1::uuid, 'refund_created',
                     jsonb_build_object('refund_id', $2::text, 'amount', $3::numeric),
                     $4)`,
            [orderId, refundId, amount, userId ?? null]
          );
          await client.query("RELEASE SAVEPOINT refund_event");
        } catch {
          await client.query("ROLLBACK TO SAVEPOINT refund_event");
        }

        // Fire-and-forget outbound notification (H2.1) — dispatched outside tx
        dispatchStoreEvent(storeId, "payment.refunded", {
          order_id: orderId,
          payment_id: paymentId,
          refund_id: refundId,
          refund_amount: String(amount),
        });

        // H2.5: Release B2B credit on refund.
        // A refund on a net-terms order returns credit capacity to the company.
        // Join to companies to get payment_terms_days (the orders row may not
        // carry it if the order came from checkout/complete).
        // Best-effort: credit release failure must never break the refund.
        try {
          const { rows: ordRows } = await client.query<{
            company_id: string | null;
            company_payment_terms_days: number | null;
          }>(
            `SELECT o.company_id::text,
                    c.payment_terms_days AS company_payment_terms_days
             FROM orders o
             LEFT JOIN companies c ON c.id = o.company_id
             WHERE o.id = $1::uuid`,
            [orderId]
          );
          const ord = ordRows[0];
          if (ord?.company_id && (ord.company_payment_terms_days ?? 0) > 0) {
            const { releaseCredit } = await import("../b2b/service.js");
            // Release only the refunded amount, not the full order total
            await releaseCredit(ord.company_id, amount);
          }
        } catch (creditErr) {
          console.warn("[createRefund] credit release failed (non-fatal):", creditErr);
        }

        return { id: refundId };
      }

      // ON CONFLICT fired (concurrent duplicate with same idempotency_key) —
      // the row was already inserted; return it.
      if (idempotencyKey) {
        const { rows: deduped } = await client.query<{ id: string }>(
          `SELECT id::text FROM refunds
           WHERE payment_id = $1::uuid AND idempotency_key = $2`,
          [paymentId, idempotencyKey]
        );
        const existingId = deduped[0]?.id;
        if (existingId) return { id: existingId };
      }

      throw new Error("createRefund: no id returned");
    } catch (err: unknown) {
      // Idempotency: duplicate (payment_id, provider_reference) from webhook path
      if (
        err instanceof Error &&
        err.message.includes("uq_refunds_payment_provider_reference")
      ) {
        const { rows: existing } = await client.query<{ id: string }>(
          `SELECT id::text FROM refunds
           WHERE payment_id = $1::uuid AND provider_reference = $2`,
          [paymentId, input.provider_reference]
        );
        const existingId = existing[0]?.id;
        if (existingId) return { id: existingId };
      }
      throw err;
    }
  });
}

// ── Payment providers (store-level) ───────────────────────────────────────────

export async function listProviders(
  storeId: string
): Promise<PaymentProvider[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<
    PaymentProvider & { config: string | Record<string, unknown> }
  >(
    `SELECT id::text, store_id::text, name, type, slug,
            webhook_url, webhook_secret, config, is_active, position,
            created_at, updated_at
     FROM payment_providers
     WHERE store_id = $1::uuid
     ORDER BY position, created_at`,
    [storeId]
  );

  // Config is stored as plain JSON in the jsonb column — redact secret fields
  return rows.map((row) => {
    const cfg = (typeof row.config === "object" && row.config !== null)
      ? (row.config as Record<string, unknown>)
      : {};
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (/secret|key|token|password/i.test(k)) {
        redacted[k] = typeof v === "string" && v.length > 0 ? "[redacted]" : v;
      } else {
        redacted[k] = v;
      }
    }
    return { ...row, config: redacted };
  });
}

export async function upsertProvider(
  storeId: string,
  input: UpsertPaymentProviderInput
): Promise<string> {
  const pool = getPool();

  // Config is stored as plain JSON in the jsonb column.
  // Only webhook_secret (text column) is encrypted.
  const configJson = JSON.stringify(input.config ?? {});
  const webhookSecretEnc = input.webhook_secret
    ? (encodeSecretValue(input.webhook_secret, secretsKey) ?? null)
    : null;

  const providerType = input.type ?? input.slug;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO payment_providers
       (store_id, slug, name, type, config, is_active, webhook_secret)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (store_id, slug) WHERE slug IS NOT NULL
     DO UPDATE SET
       name           = EXCLUDED.name,
       type           = EXCLUDED.type,
       config         = EXCLUDED.config,
       is_active      = EXCLUDED.is_active,
       webhook_secret = EXCLUDED.webhook_secret,
       updated_at     = now()
     RETURNING id::text`,
    [
      storeId,
      input.slug,
      input.name ?? input.slug,
      providerType,
      configJson,
      input.is_active ?? true,
      webhookSecretEnc,
    ]
  );

  const id = rows[0]?.id;
  if (!id) throw new Error("upsertProvider: no id returned");
  return id;
}

export async function deleteProvider(
  providerId: string,
  storeId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM payment_providers WHERE id = $1::uuid AND store_id = $2::uuid`,
    [providerId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Payment gateways (platform-level) ─────────────────────────────────────────

export async function listGateways(): Promise<PaymentGatewayInstance[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<{
    id: string;
    name: string;
    type: "paystack" | "stripe" | "razorpay" | "xendit" | "flutterwave";
    is_active: boolean;
    has_dev_credentials: boolean;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id::text, name, type, is_active,
            (dev_secret_key_enc IS NOT NULL AND dev_secret_key_enc <> '') AS has_dev_credentials,
            created_at, updated_at
     FROM payment_gateway_instances
     ORDER BY name`
  );
  return rows;
}

export async function upsertGateway(input: UpsertGatewayInput): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO payment_gateway_instances
       (name, type, secret_key_enc, public_key_enc, webhook_secret_enc,
        webhook_secret_secondary_enc, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (name) DO UPDATE SET
       type                         = EXCLUDED.type,
       secret_key_enc               = EXCLUDED.secret_key_enc,
       public_key_enc               = EXCLUDED.public_key_enc,
       webhook_secret_enc           = EXCLUDED.webhook_secret_enc,
       webhook_secret_secondary_enc = EXCLUDED.webhook_secret_secondary_enc,
       is_active                    = EXCLUDED.is_active,
       updated_at                   = now()
     RETURNING id::text`,
    [
      input.name,
      input.type,
      input.secret_key_enc,
      input.public_key_enc ?? "",
      input.webhook_secret_enc ?? null,
      input.webhook_secret_secondary_enc ?? null,
      input.is_active ?? true,
    ]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("upsertGateway: no id returned");
  return id;
}

export async function setGatewayDevCredentials(
  gatewayId: string,
  input: SetGatewayDevCredentialsInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE payment_gateway_instances
     SET dev_secret_key_enc = $2,
         dev_public_key_enc = $3,
         updated_at         = now()
     WHERE id = $1::uuid`,
    [
      gatewayId,
      input.dev_secret_key_enc,
      input.dev_public_key_enc ?? null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function getGatewayStatus(): Promise<
  Record<string, { has_live: boolean; has_dev: boolean }>
> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<{
    type: string;
    has_live: boolean;
    has_dev: boolean;
  }>(
    `SELECT type,
            (secret_key_enc IS NOT NULL AND secret_key_enc <> '') AS has_live,
            (dev_secret_key_enc IS NOT NULL AND dev_secret_key_enc <> '') AS has_dev
     FROM payment_gateway_instances
     WHERE is_active = true`
  );

  const result: Record<string, { has_live: boolean; has_dev: boolean }> = {};
  for (const row of rows) {
    result[row.type] = { has_live: row.has_live, has_dev: row.has_dev };
  }
  return result;
}

// ── Provider session creators (used by checkout module) ───────────────────────

/** Get the payment_providers row config (decrypted) for a store+slug. */
async function getProviderConfig(
  storeId: string,
  slug: string
): Promise<Record<string, unknown>> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<{
    config: string | Record<string, unknown>;
  }>(
    `SELECT config FROM payment_providers
     WHERE store_id = $1::uuid AND slug = $2 AND is_active = true
     LIMIT 1`,
    [storeId, slug]
  );

  if (!rows[0]) {
    const e = new Error(
      `No active ${slug} payment provider configured for this store`
    );
    (e as NodeJS.ErrnoException).code = "PROVIDER_NOT_CONFIGURED";
    throw e;
  }

  // Config is stored as plain JSON in the jsonb column (pg driver parses jsonb to JS objects)
  const cfg = rows[0].config;
  if (typeof cfg === "object" && cfg !== null) {
    return cfg as Record<string, unknown>;
  }
  if (typeof cfg === "string") {
    return JSON.parse(cfg) as Record<string, unknown>;
  }
  return {};
}

export async function createStripeSession(
  storeId: string,
  checkoutId: string,
  amountCents: number,
  currency: string,
  email?: string | undefined
): Promise<{ provider: "stripe"; clientSecret: string; paymentIntentId: string }> {
  const cfg = await getProviderConfig(storeId, "stripe");
  const secretKey = cfg["secret_key"];
  if (typeof secretKey !== "string" || !secretKey) {
    const e = new Error("stripe provider config missing secret_key");
    (e as NodeJS.ErrnoException).code = "PROVIDER_NOT_CONFIGURED";
    throw e;
  }

  const client = new StripeClient(secretKey);
  const result = await client.createPaymentIntent({
    amountCents,
    currency,
    checkoutId,
    email,
  });

  return {
    provider: "stripe",
    clientSecret: result.clientSecret,
    paymentIntentId: result.id,
  };
}

export async function createPaystackSession(
  storeId: string,
  checkoutId: string,
  amountKobo: number,
  currency: string,
  email: string
): Promise<{ provider: "paystack"; authorizationUrl: string; reference: string }> {
  const cfg = await getProviderConfig(storeId, "paystack");
  const secretKey = cfg["secret_key"];
  if (typeof secretKey !== "string" || !secretKey) {
    const e = new Error("paystack provider config missing secret_key");
    (e as NodeJS.ErrnoException).code = "PROVIDER_NOT_CONFIGURED";
    throw e;
  }

  const client = new PaystackClient(secretKey);
  const result = await client.initializeTransaction({
    email,
    amountKobo,
    reference: checkoutId,
    currency,
  });

  return {
    provider: "paystack",
    authorizationUrl: result.authorizationUrl,
    reference: result.reference,
  };
}

export async function createRazorpaySession(
  storeId: string,
  checkoutId: string,
  amountSmallest: number,
  currency: string
): Promise<{
  provider: "razorpay";
  razorpayOrderId: string;
  amount: number;
  currency: string;
}> {
  const cfg = await getProviderConfig(storeId, "razorpay");
  const keyId = cfg["key_id"];
  const keySecret = cfg["key_secret"];
  if (
    typeof keyId !== "string" ||
    !keyId ||
    typeof keySecret !== "string" ||
    !keySecret
  ) {
    const e = new Error("razorpay provider config missing key_id or key_secret");
    (e as NodeJS.ErrnoException).code = "PROVIDER_NOT_CONFIGURED";
    throw e;
  }

  const client = new RazorpayClient(keyId, keySecret);
  const result = await client.createOrder({ amountSmallest, currency, checkoutId });

  return {
    provider: "razorpay",
    razorpayOrderId: result.id,
    amount: result.amount,
    currency: result.currency,
  };
}

export async function createXenditSession(
  storeId: string,
  checkoutId: string,
  amount: number,
  currency: string,
  email?: string | undefined,
  description?: string | undefined
): Promise<{ provider: "xendit"; invoiceUrl: string; invoiceId: string }> {
  const cfg = await getProviderConfig(storeId, "xendit");
  const apiKey = cfg["api_key"];
  if (typeof apiKey !== "string" || !apiKey) {
    const e = new Error("xendit provider config missing api_key");
    (e as NodeJS.ErrnoException).code = "PROVIDER_NOT_CONFIGURED";
    throw e;
  }

  const client = new XenditClient(apiKey);
  const result = await client.createInvoice({
    externalId: checkoutId,
    amount,
    currency,
    payerEmail: email,
    description,
  });

  return {
    provider: "xendit",
    invoiceUrl: result.invoiceUrl,
    invoiceId: result.id,
  };
}
