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
import { round2 } from "../../lib/money.js";
import { config } from "../../config/config.js";
import { encodeSecretValue } from "../../lib/secrets.js";
import { dispatchStoreEvent } from "../notifications/service.js";
import {
  StripeClient,
  type StripePaymentMethodType,
} from "../../providers/payments/stripe.js";
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

// ── Provider refund execution ──────────────────────────────────────────────────

/**
 * Outcome of attempting a refund at the payment provider.
 *
 *  - kind "executed":  the provider was called; `status` is the mapped local
 *                      refund status and `providerRefundId` (if any) is the
 *                      provider's refund reference to persist.
 *  - kind "local":     there is nothing to call at a provider (no provider /
 *                      no provider_reference) — this is a local bookkeeping
 *                      refund and keeps the existing 'pending' status.
 */
type ProviderRefundResult =
  | {
      kind: "executed";
      status: "succeeded" | "processing" | "pending" | "failed";
      providerRefundId: string | null;
      providerError: string | null;
    }
  | { kind: "local" };

/** Map a raw provider refund status to our local refunds.status enum. */
function mapRefundStatus(
  providerType: string,
  raw: string
): "succeeded" | "processing" | "pending" | "failed" {
  const s = raw.toLowerCase();
  switch (providerType) {
    case "stripe":
      // pending | requires_action | succeeded | failed | canceled
      if (s === "succeeded") return "succeeded";
      if (s === "failed" || s === "canceled") return "failed";
      if (s === "pending" || s === "requires_action") return "processing";
      return "processing";
    case "paystack":
      // pending | processing | processed | failed
      if (s === "processed") return "succeeded";
      if (s === "failed") return "failed";
      if (s === "processing") return "processing";
      return "pending";
    case "razorpay":
      // pending | processed | failed
      if (s === "processed") return "succeeded";
      if (s === "failed") return "failed";
      return "processing";
    case "xendit":
      // SUCCEEDED | PENDING | FAILED | CANCELLED
      if (s === "succeeded") return "succeeded";
      if (s === "failed" || s === "cancelled") return "failed";
      return "processing";
    default:
      return "pending";
  }
}

/**
 * Execute the refund against the payment's provider.
 *
 * Resolves the provider type + config for the payment (preferring the
 * payment's provider_id FK, falling back to the store's single active
 * provider of a known type), then calls the provider's refund REST endpoint
 * via the provider client. Amounts in the DB are major units (numeric(15,2));
 * Stripe/Paystack/Razorpay take minor units (×100), Xendit takes major units.
 *
 * `client` is the in-transaction pg client used to read provider config so the
 * read participates in the same transaction/RLS context.
 */
async function executeProviderRefund(
  client: import("pg").PoolClient,
  storeId: string,
  payment: {
    provider_id: string | null;
    provider_reference: string | null;
    currency: string;
  },
  amount: number
): Promise<ProviderRefundResult> {
  const providerReference = payment.provider_reference?.trim() || null;

  // Resolve the provider row (type + config) for this payment.
  let providerType: string | null = null;
  let providerConfig: Record<string, unknown> = {};

  if (payment.provider_id) {
    const { rows } = await client.query<{
      type: string;
      config: string | Record<string, unknown>;
    }>(
      `SELECT type, config FROM payment_providers
       WHERE id = $1::uuid AND store_id = $2::uuid AND is_active = true
       LIMIT 1`,
      [payment.provider_id, storeId]
    );
    if (rows[0]) {
      providerType = rows[0].type;
      providerConfig = parseProviderConfig(rows[0].config);
    }
  }

  // No provider on the payment (or it was deactivated) and no provider
  // reference to refund against → local bookkeeping refund.
  if (!providerType && !providerReference) {
    return { kind: "local" };
  }

  // We have something to refund at a provider but couldn't resolve a provider
  // row — fall back to the store's single active provider of a known type.
  if (!providerType) {
    const { rows } = await client.query<{
      type: string;
      config: string | Record<string, unknown>;
    }>(
      `SELECT type, config FROM payment_providers
       WHERE store_id = $1::uuid AND is_active = true
         AND type IN ('stripe','paystack','razorpay','xendit')
       ORDER BY position, created_at
       LIMIT 1`,
      [storeId]
    );
    if (rows[0]) {
      providerType = rows[0].type;
      providerConfig = parseProviderConfig(rows[0].config);
    }
  }

  // Providers that genuinely cannot refund programmatically (the generic
  // "webhook" provider type, or an unresolvable provider) must fail loudly
  // rather than silently succeeding.
  const REFUNDABLE = new Set(["stripe", "paystack", "razorpay", "xendit"]);
  if (!providerType || !REFUNDABLE.has(providerType)) {
    const e = new Error(
      `refunds are not supported for provider type '${providerType ?? "unknown"}'`
    );
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }

  if (!providerReference) {
    const e = new Error(
      `cannot refund ${providerType} payment: missing provider_reference`
    );
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }

  // Call the provider. On a provider-side failure we capture the error and
  // map to 'failed' rather than throwing, so the refund row is preserved.
  try {
    const minorUnits = Math.round(amount * 100);
    if (providerType === "stripe") {
      const secretKey = providerConfig["secret_key"];
      if (typeof secretKey !== "string" || !secretKey) {
        throw new Error("stripe provider config missing secret_key");
      }
      const res = await new StripeClient(secretKey).createRefund({
        providerReference,
        amountCents: minorUnits,
      });
      return {
        kind: "executed",
        status: mapRefundStatus("stripe", res.status),
        providerRefundId: res.id || null,
        providerError: null,
      };
    }
    if (providerType === "paystack") {
      const secretKey = providerConfig["secret_key"];
      if (typeof secretKey !== "string" || !secretKey) {
        throw new Error("paystack provider config missing secret_key");
      }
      const res = await new PaystackClient(secretKey).createRefund({
        transaction: providerReference,
        amountKobo: minorUnits,
        currency: payment.currency,
      });
      return {
        kind: "executed",
        status: mapRefundStatus("paystack", res.status),
        providerRefundId: res.id || null,
        providerError: null,
      };
    }
    if (providerType === "razorpay") {
      const keyId = providerConfig["key_id"];
      const keySecret = providerConfig["key_secret"];
      if (
        typeof keyId !== "string" ||
        !keyId ||
        typeof keySecret !== "string" ||
        !keySecret
      ) {
        throw new Error("razorpay provider config missing key_id or key_secret");
      }
      const res = await new RazorpayClient(keyId, keySecret).createRefund({
        paymentId: providerReference,
        amountSmallest: minorUnits,
      });
      return {
        kind: "executed",
        status: mapRefundStatus("razorpay", res.status),
        providerRefundId: res.id || null,
        providerError: null,
      };
    }
    // xendit — amounts are in full currency units (NOT cents)
    const apiKey = providerConfig["api_key"];
    if (typeof apiKey !== "string" || !apiKey) {
      throw new Error("xendit provider config missing api_key");
    }
    const res = await new XenditClient(apiKey).createRefund({
      invoiceId: providerReference,
      amount,
      currency: payment.currency,
    });
    return {
      kind: "executed",
      status: mapRefundStatus("xendit", res.status),
      providerRefundId: res.id || null,
      providerError: null,
    };
  } catch (err) {
    return {
      kind: "executed",
      status: "failed",
      providerRefundId: null,
      providerError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Coerce a payment_providers.config column (jsonb or text) to an object. */
function parseProviderConfig(
  cfg: string | Record<string, unknown>
): Record<string, unknown> {
  if (typeof cfg === "object" && cfg !== null) {
    return cfg as Record<string, unknown>;
  }
  if (typeof cfg === "string") {
    try {
      return JSON.parse(cfg) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

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

    // Load the payment so we can call its provider's refund API. Scoped to the
    // order to prevent cross-order refunds.
    const { rows: payRows } = await client.query<{
      provider_id: string | null;
      provider_reference: string | null;
      currency: string;
    }>(
      `SELECT provider_id::text, provider_reference, currency
       FROM payments
       WHERE id = $1::uuid AND order_id = $2::uuid`,
      [paymentId, orderId]
    );
    if (!payRows[0]) {
      const e = new Error("payment not found");
      (e as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw e;
    }
    const payment = payRows[0];

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

        // ── Execute the refund at the payment provider ────────────────────────
        // Admin-initiated refunds (no input.provider_reference) call the
        // provider's refund API for real. Webhook reconciliation inserts supply
        // input.provider_reference (the provider's own refund id) and must NOT
        // re-call the provider — that would double-refund.
        let providerResult: ProviderRefundResult = { kind: "local" };
        if (!input.provider_reference) {
          providerResult = await executeProviderRefund(
            client,
            storeId,
            payment,
            amount
          );
        }

        // On a provider-side failure, persist the refund row as 'failed' with
        // the provider error in metadata and STOP: do not touch total_refunded,
        // do not dispatch the refund notification, do not release B2B credit.
        if (
          providerResult.kind === "executed" &&
          providerResult.status === "failed"
        ) {
          await client.query(
            `UPDATE refunds
             SET status = 'failed',
                 metadata = metadata || jsonb_build_object(
                   'provider_error', $2::text),
                 updated_at = now()
             WHERE id = $1::uuid`,
            [refundId, providerResult.providerError ?? "provider refund failed"]
          );

          // Best-effort event log so the failure is auditable.
          try {
            await client.query("SAVEPOINT refund_event");
            await client.query(
              `INSERT INTO order_events (order_id, type, data, created_by)
               VALUES ($1::uuid, 'refund_failed',
                       jsonb_build_object('refund_id', $2::text, 'amount', $3::numeric,
                                          'error', $4::text),
                       $5)`,
              [orderId, refundId, amount, providerResult.providerError ?? null, userId ?? null]
            );
            await client.query("RELEASE SAVEPOINT refund_event");
          } catch {
            await client.query("ROLLBACK TO SAVEPOINT refund_event");
          }

          // Return the persisted failed row (do NOT throw — that would roll
          // back the record). The route surfaces this as a non-success status.
          return {
            id: refundId,
            status: "failed",
            provider_error:
              providerResult.providerError ?? "provider refund failed",
          };
        }

        // Provider call succeeded (or is in flight, or this is a local refund).
        // Persist the mapped status and the provider's refund id.
        if (providerResult.kind === "executed") {
          await client.query(
            `UPDATE refunds
             SET status = $2,
                 provider_reference = COALESCE($3, provider_reference),
                 updated_at = now()
             WHERE id = $1::uuid`,
            [refundId, providerResult.status, providerResult.providerRefundId]
          );
        }

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

        return {
          id: refundId,
          status:
            providerResult.kind === "executed"
              ? providerResult.status
              : "pending",
        };
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

// ── Post-edit payment reconciliation ────────────────────────────────────────────
//
// When an order's total changes (e.g. orders.editOrderLines re-prices the order
// after a line edit) the amount already captured no longer matches the new
// total. This reconciles that delta CONSERVATIVELY:
//
//   NEW total < captured  (customer overpaid)  → AUTO-issue a refund for the
//       difference. Refunds are customer-favourable and low-risk, so this is
//       safe to do automatically. Idempotent: keyed off (order, expected
//       refunded amount) so a retried edit landing on the same total does not
//       double-refund.
//
//   NEW total > captured  (customer owes more) → DO NOT auto-charge. Record the
//       outstanding balance (financial_status → 'partially_paid' + a metadata
//       marker + an order_event) and wait for an explicit collect-balance call.
//
// All work is best-effort relative to the (already committed) edit: callers run
// this AFTER the edit transaction so a reconciliation failure never rolls the
// edit back. Errors are returned in the result and recorded as order_events.

export type ReconcileOutcome =
  | { kind: "none"; captured: string; total: string }
  | {
      kind: "refunded";
      refund_id: string;
      amount: string;
      status: string;
      captured: string;
      total: string;
    }
  | {
      kind: "refund_skipped";
      reason: string;
      amount: string;
      captured: string;
      total: string;
    }
  | {
      kind: "balance_outstanding";
      amount: string;
      captured: string;
      total: string;
    }
  | { kind: "error"; error: string };

/**
 * Build the deterministic idempotency marker for an auto-refund. Keyed off the
 * order id and the amount that SHOULD have been refunded by the time the order
 * total settled at `total` against `captured`. A retried edit that lands on the
 * same (captured, total) pair therefore reuses the same key and the refund is
 * deduped at the refunds(payment_id, idempotency_key) unique index.
 */
function editRefundIdempotencyKey(orderId: string, refundAmount: number): string {
  return `edit-reconcile:${orderId}:refund:${refundAmount.toFixed(2)}`;
}

/**
 * Reconcile captured payments against the order's CURRENT total after an edit.
 *
 * Runs in its own transaction (locks the order row FOR UPDATE) so it is safe to
 * call concurrently / on retry. Never throws on a money-movement failure — the
 * failure is captured, recorded as an order_event, and returned as
 * `{ kind: "error" }` so the caller can surface it without rolling back the
 * already-committed edit.
 */
export async function reconcilePaymentDelta(
  orderId: string,
  storeId: string,
  userId?: string | undefined
): Promise<ReconcileOutcome> {
  // Read order + captured/refunded snapshot under a row lock.
  let total: number;
  let captured: number;
  let alreadyRefunded: number;
  let financialStatus: string;
  let refundTargetPaymentId: string | null = null;

  try {
    const snapshot = await withTx(async (client) => {
      const { rows: ordRows } = await client.query<{
        total: string;
        financial_status: string;
      }>(
        `SELECT total::text, financial_status
         FROM orders WHERE id = $1::uuid AND store_id = $2::uuid
         FOR UPDATE`,
        [orderId, storeId]
      );
      const ord = ordRows[0];
      if (!ord) {
        const e = new Error("order not found");
        (e as NodeJS.ErrnoException).code = "NOT_FOUND";
        throw e;
      }

      const { rows: capRows } = await client.query<{ sum: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS sum
         FROM payments WHERE order_id = $1::uuid AND status = 'captured'`,
        [orderId]
      );
      const { rows: refRows } = await client.query<{ sum: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS sum
         FROM refunds
         WHERE order_id = $1::uuid AND status IN ('pending','processing','succeeded')`,
        [orderId]
      );

      // Most-recent captured payment is the target for an auto-refund.
      const { rows: payRows } = await client.query<{ id: string }>(
        `SELECT id::text FROM payments
         WHERE order_id = $1::uuid AND status = 'captured'
         ORDER BY captured_at DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [orderId]
      );

      return {
        total: parseFloat(ord.total) || 0,
        financial_status: ord.financial_status,
        captured: parseFloat(capRows[0]?.sum ?? "0") || 0,
        refunded: parseFloat(refRows[0]?.sum ?? "0") || 0,
        targetPaymentId: payRows[0]?.id ?? null,
      };
    });

    total = snapshot.total;
    captured = snapshot.captured;
    alreadyRefunded = snapshot.refunded;
    financialStatus = snapshot.financial_status;
    refundTargetPaymentId = snapshot.targetPaymentId;
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }

  // Net amount the customer has actually paid (captured minus refunds).
  const netPaid = round2(captured - alreadyRefunded);
  const delta = round2(total - netPaid);

  const totalStr = total.toFixed(2);
  const capturedStr = netPaid.toFixed(2);

  // No captured money at all → nothing to refund and no balance to "leave
  // outstanding" against a payment (the order was never paid). Leave the
  // financial_status as-is (still 'pending').
  if (captured <= 0) {
    return { kind: "none", captured: capturedStr, total: totalStr };
  }

  // Within a cent → no action.
  if (Math.abs(delta) <= 0.005) {
    return { kind: "none", captured: capturedStr, total: totalStr };
  }

  if (delta < 0) {
    // ── Overpaid → AUTO-refund the difference. ────────────────────────────────
    const refundAmount = round2(-delta);
    if (!refundTargetPaymentId) {
      // Shouldn't happen (captured > 0 implies a captured payment) but guard.
      return {
        kind: "refund_skipped",
        reason: "no captured payment to refund against",
        amount: refundAmount.toFixed(2),
        captured: capturedStr,
        total: totalStr,
      };
    }

    try {
      const result = await createRefund(
        refundTargetPaymentId,
        orderId,
        storeId,
        {
          amount: refundAmount.toFixed(2),
          reason: "other",
          notes: "auto-refund: order total reduced by edit",
          idempotency_key: editRefundIdempotencyKey(orderId, refundAmount),
        },
        userId
      );
      return {
        kind: "refunded",
        refund_id: result.id,
        amount: refundAmount.toFixed(2),
        status: result.status ?? "pending",
        captured: capturedStr,
        total: totalStr,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await recordReconcileEvent(orderId, "edit_refund_failed", {
        amount: refundAmount.toFixed(2),
        error: msg,
      });
      return { kind: "error", error: msg };
    }
  }

  // ── Owed → DO NOT auto-charge. Record outstanding balance. ──────────────────
  const owed = round2(delta);
  try {
    await withTx(async (client) => {
      // Re-lock to write atomically. Only downgrade 'paid' → 'partially_paid';
      // never override 'refunded'/'voided' states.
      await client.query(
        `UPDATE orders
         SET financial_status = 'partially_paid',
             metadata = metadata || jsonb_build_object(
               'outstanding_balance', $2::text,
               'outstanding_reason', 'order total increased by edit'
             ),
             updated_at = now()
         WHERE id = $1::uuid AND store_id = $3::uuid
           AND financial_status IN ('pending','authorized','partially_paid','paid')`,
        [orderId, owed.toFixed(2), storeId]
      );

      await client
        .query(
          `INSERT INTO order_events (order_id, type, data, created_by)
           VALUES ($1::uuid, 'balance_outstanding',
                   jsonb_build_object('amount', $2::text, 'captured', $3::text, 'total', $4::text),
                   $5)`,
          [orderId, owed.toFixed(2), capturedStr, totalStr, userId ?? null]
        )
        .catch(() => undefined);
    });
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }

  // Suppress unused-var lint for financialStatus (kept for clarity/debugging).
  void financialStatus;

  return {
    kind: "balance_outstanding",
    amount: owed.toFixed(2),
    captured: capturedStr,
    total: totalStr,
  };
}

/** Best-effort order_event writer for reconciliation diagnostics. */
async function recordReconcileEvent(
  orderId: string,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO order_events (order_id, type, data, created_by)
       VALUES ($1::uuid, $2, $3::jsonb, NULL)`,
      [orderId, type, JSON.stringify(data)]
    );
  } catch {
    // best-effort only
  }
}

/**
 * Explicitly collect the outstanding balance on an order via the saved payment
 * method. ONLY invoked when a merchant/customer deliberately calls the
 * collect-balance endpoint — we never auto-charge from reconciliation.
 *
 * Captures the difference between the order total and net captured money by
 * creating a 'pending' payment for the delta against the same provider as the
 * order's last captured payment, then capturing it (which emits
 * payment.captured and rolls financial_status forward to paid/partially_paid).
 *
 * Idempotent at the balance level: if there is no outstanding balance (already
 * collected) it returns { collected: false }.
 */
export interface CollectBalanceResult {
  collected: boolean;
  amount: string;
  payment_id?: string | undefined;
}

export async function collectOutstandingBalance(
  orderId: string,
  storeId: string,
  userId?: string | undefined
): Promise<CollectBalanceResult> {
  // Compute the outstanding delta and create the pending payment atomically so
  // two concurrent collect calls can't each create a full-delta payment.
  const prepared = await withTx(async (client) => {
    const { rows: ordRows } = await client.query<{
      total: string;
      currency: string;
    }>(
      `SELECT total::text, currency
       FROM orders WHERE id = $1::uuid AND store_id = $2::uuid
       FOR UPDATE`,
      [orderId, storeId]
    );
    const ord = ordRows[0];
    if (!ord) {
      const e = new Error("order not found");
      (e as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw e;
    }

    const { rows: capRows } = await client.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS sum
       FROM payments WHERE order_id = $1::uuid AND status = 'captured'`,
      [orderId]
    );
    const { rows: pendRows } = await client.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS sum
       FROM payments WHERE order_id = $1::uuid AND status = 'pending'`,
      [orderId]
    );
    const { rows: refRows } = await client.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS sum
       FROM refunds
       WHERE order_id = $1::uuid AND status IN ('pending','processing','succeeded')`,
      [orderId]
    );

    const total = parseFloat(ord.total) || 0;
    const captured = parseFloat(capRows[0]?.sum ?? "0") || 0;
    const pending = parseFloat(pendRows[0]?.sum ?? "0") || 0;
    const refunded = parseFloat(refRows[0]?.sum ?? "0") || 0;

    // Outstanding = order total − net captured − already-pending captures.
    const netPaid = round2(captured - refunded);
    const outstanding = round2(total - netPaid - pending);
    if (outstanding <= 0.005) {
      return { outstanding: 0, paymentId: null as string | null, currency: ord.currency };
    }

    // Mirror the provider/mode of the order's last captured payment so the
    // capture lands against the saved payment method.
    const { rows: srcRows } = await client.query<{
      provider_id: string | null;
      mode: string;
      is_test: boolean;
    }>(
      `SELECT provider_id::text, mode, is_test FROM payments
       WHERE order_id = $1::uuid AND status = 'captured'
       ORDER BY captured_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [orderId]
    );
    const src = srcRows[0];

    const { rows: insRows } = await client.query<{ id: string }>(
      `INSERT INTO payments
         (order_id, provider_id, amount, currency, status, is_test, mode)
       VALUES ($1::uuid, $2, $3::numeric, $4, 'pending', $5, $6)
       RETURNING id::text`,
      [
        orderId,
        src?.provider_id ?? null,
        outstanding,
        ord.currency,
        src?.is_test ?? false,
        src?.mode ?? "live",
      ]
    );
    const paymentId = insRows[0]?.id ?? null;
    return { outstanding, paymentId, currency: ord.currency };
  });

  if (prepared.outstanding <= 0 || !prepared.paymentId) {
    return { collected: false, amount: "0.00" };
  }

  // Capture the pending balance payment (separate tx — emits payment.captured
  // and advances financial_status). Capture itself is the explicit charge.
  await capturePayment(prepared.paymentId, orderId, storeId, userId);

  // Clear the outstanding-balance marker now that it's been collected.
  try {
    const pool = getPool();
    await pool.query(
      `UPDATE orders
       SET metadata = (metadata - 'outstanding_balance' - 'outstanding_reason'),
           updated_at = now()
       WHERE id = $1::uuid AND store_id = $2::uuid`,
      [orderId, storeId]
    );
  } catch {
    // best-effort marker cleanup
  }

  return {
    collected: true,
    amount: prepared.outstanding.toFixed(2),
    payment_id: prepared.paymentId,
  };
}

// ── Payment providers (store-level) ───────────────────────────────────────────

export async function listProviders(
  storeId: string
): Promise<PaymentProvider[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  // SEC: never return webhook_secret to clients. Mirror the gateway path
  // (getGatewayStatus / listGateways), which exposes only has_* booleans —
  // surface has_webhook_secret instead of the secret itself.
  const { rows } = await pool.query<
    Omit<PaymentProvider, "config"> & {
      config: string | Record<string, unknown>;
    }
  >(
    `SELECT id::text, store_id::text, name, type, slug,
            webhook_url,
            (webhook_secret IS NOT NULL AND webhook_secret <> '') AS has_webhook_secret,
            config, is_active, position,
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

/** BNPL methods we support gating on for Stripe, in display order. */
const STRIPE_BNPL_METHODS: StripePaymentMethodType[] = [
  "klarna",
  "afterpay_clearpay",
  "affirm",
];

const STRIPE_ALL_METHODS: readonly StripePaymentMethodType[] = [
  "card",
  ...STRIPE_BNPL_METHODS,
];

/**
 * Resolve the explicit Stripe `payment_method_types[]` to request from a store's
 * stripe provider config. Returns `undefined` to mean "use Stripe automatic
 * payment methods" (the default — card + wallets like Apple/Google Pay shown
 * automatically). Returns a non-empty array to pin an explicit method set.
 *
 * Config (all optional, defaults preserve existing card+wallets behaviour):
 *  - `payment_methods`: string[] — explicit allowlist, e.g.
 *      ["card","klarna","afterpay_clearpay","affirm"]. Unknown entries are
 *      ignored. If it contains any BNPL method, `card` is always included so
 *      the card/wallet flow is never lost.
 *  - `enable_bnpl`: boolean — shorthand to add klarna + afterpay_clearpay +
 *      affirm on top of card. Ignored if `payment_methods` is set.
 *  - `enable_wallets`: boolean (default true) — wallets (Apple/Google Pay) ride
 *      on `card` and are surfaced automatically; setting this false has no
 *      effect on its own but is read so a future explicit-method config can
 *      reason about it. It never disables card.
 *
 * Backward-compatible default: with none of these set we return `undefined`,
 * so the PaymentIntent keeps using `automatic_payment_methods[enabled]=true`.
 */
export function resolveStripePaymentMethodTypes(
  cfg: Record<string, unknown>
): StripePaymentMethodType[] | undefined {
  const known = new Set<string>(STRIPE_ALL_METHODS);

  // 1. Explicit allowlist wins.
  const raw = cfg["payment_methods"];
  if (Array.isArray(raw)) {
    const picked = raw
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => known.has(v)) as StripePaymentMethodType[];
    if (picked.length === 0) {
      // Configured but nothing valid → fall back to automatic methods.
      return undefined;
    }
    const set = new Set<StripePaymentMethodType>(picked);
    // Never drop card (wallets depend on it) when BNPL is requested.
    if (picked.some((m) => STRIPE_BNPL_METHODS.includes(m))) {
      set.add("card");
    }
    // Preserve canonical order (card first, then BNPL).
    return STRIPE_ALL_METHODS.filter((m) => set.has(m));
  }

  // 2. enable_bnpl shorthand → card + all BNPL methods.
  if (cfg["enable_bnpl"] === true) {
    return [...STRIPE_ALL_METHODS];
  }

  // 3. Default: automatic payment methods (card + wallets surfaced by Stripe).
  return undefined;
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

  const paymentMethodTypes = resolveStripePaymentMethodTypes(cfg);

  const client = new StripeClient(secretKey);
  const result = await client.createPaymentIntent({
    amountCents,
    currency,
    checkoutId,
    email,
    ...(paymentMethodTypes ? { paymentMethodTypes } : {}),
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
