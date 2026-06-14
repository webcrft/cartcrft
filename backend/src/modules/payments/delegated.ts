/**
 * payments/delegated.ts — Agentic delegated-token charge logic (B6 / H5.1).
 *
 * This module powers the LIVE agentic-checkout payment path used by the ACP
 * ("Agentic Commerce Protocol") and UCP ("Universal Commerce Protocol")
 * adapters.  When an agent (e.g. ChatGPT Instant Checkout) completes a
 * checkout session it hands us a *delegated payment credential* — a single-use
 * shared/delegated payment token that authorises us to charge the buyer's card
 * through the merchant's own payment provider.
 *
 * chargeDelegatedToken():
 *   1. Resolves the merchant's configured provider (payment_providers row).
 *   2. Charges the provider with the agent-supplied delegated token.
 *        - Stripe: create + confirm a PaymentIntent using the shared payment
 *          method (Stripe's real ACP "delegated payments" shape — a
 *          PaymentIntent with `payment_method` = the shared token, `confirm=true`,
 *          `off_session=true`).
 *        - Other providers (paystack/razorpay/xendit): no delegated-payment
 *          primitive exists today → PROVIDER_NO_DELEGATED_PAYMENT.
 *   3. On a successful charge, completes the checkout (core completeCheckout)
 *      to create the order, then records + captures a `live` payment referencing
 *      the provider charge id so the order's financial_status becomes `paid`.
 *
 * Idempotent: keyed off the delegated token's resulting provider charge id via
 * the payments table's (order_id, provider_reference) unique constraint and the
 * checkout's pending-status guard (completeCheckout errors on already-completed).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT IS CREDENTIAL-GATED (exact steps to go truly live):
 *
 * The CODE path implemented here is complete and exercised in tests with the
 * provider HTTP mocked.  To process a REAL agentic card purchase end-to-end you
 * additionally need, OUTSIDE this codebase:
 *
 *  1. Stripe ACP enablement — the merchant's Stripe account must be enabled for
 *     "Agentic Commerce / delegated payments" (shared PaymentMethods).  This is
 *     a Stripe-side allowlist + a live `secret_key` stored in the store's
 *     `payment_providers` row (slug = 'stripe', config.secret_key = sk_live_…).
 *     The shared payment token in the request is minted by the agent platform's
 *     Stripe integration, not by us.
 *
 *  2. OpenAI / ChatGPT Instant Checkout merchant registration — to receive
 *     SharedPaymentTokens from ChatGPT the merchant must be registered in the
 *     OpenAI Commerce merchant program and have published an ACP product feed
 *     (we serve /acp/:storeId/feed).  OpenAI routes the delegated token to our
 *     ACP `complete` endpoint; we forward it to Stripe here.
 *
 * Until both are in place the path returns DELEGATED_TOKEN_INVALID (provider
 * rejects the token) rather than a stub — i.e. it is real, just unauthorised.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { getReadDb } from "../../db/pool.js";
import { completeCheckout, CheckoutError } from "../checkout/complete.js";
import { createPayment, capturePayment } from "./service.js";

const STRIPE_BASE_URL = "https://api.stripe.com/v1";

// Providers with no delegated-payment primitive (no shared/off-session token
// charge that can be confirmed from an agent credential alone).
const NO_DELEGATED_SUPPORT = new Set(["paystack", "razorpay", "xendit", "webhook"]);

/** Stripe PaymentIntent statuses that mean the funds are secured. */
const STRIPE_SUCCESS_STATUSES = new Set(["succeeded", "requires_capture", "processing"]);

export class DelegatedPaymentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number = 422
  ) {
    super(message);
    this.name = "DelegatedPaymentError";
  }
}

export interface ChargeDelegatedTokenInput {
  storeId: string;
  checkoutId: string;
  /** Provider slug override; when omitted the store's first active provider is used. */
  provider?: string | undefined;
  /** The agent-supplied delegated/shared payment credential. */
  delegatedToken: string;
  /** Order total to charge (major units, e.g. 199.00). */
  amount: number;
  /** ISO-4217 currency, e.g. "USD" / "ZAR". */
  currency: string;
  /** Optional receipt email. */
  email?: string | undefined;
}

export interface ChargeDelegatedTokenResult {
  orderId: string;
  orderNumber: string;
  paymentId: string;
  provider: string;
  providerReference: string;
}

interface ResolvedProvider {
  id: string;
  slug: string;
  type: string;
  config: Record<string, unknown>;
}

/**
 * Resolve a store's active payment provider (by slug, or the first active one).
 * Reads payment_providers directly (config is plain jsonb).
 */
async function resolveProvider(
  storeId: string,
  slug?: string
): Promise<ResolvedProvider> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = slug
    ? await pool.query<{ id: string; slug: string | null; type: string; config: unknown }>(
        `SELECT id::text, slug, type, config FROM payment_providers
         WHERE store_id = $1::uuid AND slug = $2 AND is_active = true
         ORDER BY position, created_at LIMIT 1`,
        [storeId, slug]
      )
    : await pool.query<{ id: string; slug: string | null; type: string; config: unknown }>(
        `SELECT id::text, slug, type, config FROM payment_providers
         WHERE store_id = $1::uuid AND is_active = true AND slug IS NOT NULL
         ORDER BY position, created_at LIMIT 1`,
        [storeId]
      );

  const row = rows[0];
  if (!row) {
    throw new DelegatedPaymentError(
      "no active payment provider is configured for this store",
      "PROVIDER_NOT_CONFIGURED",
      409
    );
  }

  const cfg =
    typeof row.config === "object" && row.config !== null
      ? (row.config as Record<string, unknown>)
      : typeof row.config === "string"
        ? (JSON.parse(row.config) as Record<string, unknown>)
        : {};

  return { id: row.id, slug: row.slug ?? row.type, type: row.type, config: cfg };
}

/**
 * Charge a Stripe delegated/shared payment token.
 *
 * Mirrors Stripe's ACP "delegated payments": create a PaymentIntent with the
 * shared payment method attached and confirm it in one off-session call.
 * Returns the PaymentIntent id (used as the payment provider_reference).
 *
 * Uses raw fetch (matching providers/payments/stripe.ts) so tests can stub
 * global fetch with a successful PaymentIntent response.
 */
async function chargeStripeDelegated(
  secretKey: string,
  input: ChargeDelegatedTokenInput
): Promise<{ providerReference: string; status: string }> {
  // Stripe wants the smallest currency unit (cents). Zero-decimal currencies
  // are rare for card commerce; we follow the existing StripeClient (× 100).
  const amountCents = Math.round(input.amount * 100);

  const params = new URLSearchParams();
  params.set("amount", String(amountCents));
  params.set("currency", input.currency.toLowerCase());
  params.set("payment_method", input.delegatedToken);
  params.set("confirm", "true");
  params.set("off_session", "true");
  // Do not let Stripe redirect — agentic flows are server-to-server.
  params.set("automatic_payment_methods[enabled]", "true");
  params.set("automatic_payment_methods[allow_redirects]", "never");
  params.set("metadata[checkout_id]", input.checkoutId);
  params.set("metadata[source]", "agentic_delegated");
  if (input.email) params.set("receipt_email", input.email);

  let res: Response;
  try {
    res = await fetch(`${STRIPE_BASE_URL}/payment_intents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        // Idempotency at the provider level — duplicate confirms for the same
        // checkout+token collapse to one charge.
        "Idempotency-Key": `acp-delegated:${input.checkoutId}`,
      },
      body: params.toString(),
    });
  } catch (err) {
    throw new DelegatedPaymentError(
      `payment provider request failed: ${(err as Error).message}`,
      "PROVIDER_UNAVAILABLE",
      502
    );
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    const errObj = data["error"] as Record<string, unknown> | undefined;
    const message = String(errObj?.["message"] ?? `stripe: status ${res.status}`);
    const declineCode = errObj?.["code"] ?? errObj?.["decline_code"];
    // A 4xx from Stripe on a confirm call almost always means the delegated
    // token was invalid / declined / already used.
    throw new DelegatedPaymentError(
      declineCode ? `${message} (${String(declineCode)})` : message,
      "DELEGATED_TOKEN_INVALID",
      402
    );
  }

  const status = String(data["status"] ?? "");
  const id = String(data["id"] ?? "");
  if (!id || !STRIPE_SUCCESS_STATUSES.has(status)) {
    throw new DelegatedPaymentError(
      `delegated payment was not completed (status: ${status || "unknown"})`,
      "DELEGATED_TOKEN_INVALID",
      402
    );
  }

  return { providerReference: id, status };
}

/**
 * Charge an agent-supplied delegated payment token through the store's
 * configured provider, then complete the checkout into a paid order.
 *
 * On success the checkout is completed, a `live` payment is recorded and
 * captured, and the order's financial_status is `paid`.
 *
 * Throws DelegatedPaymentError with a machine code:
 *   PROVIDER_NOT_CONFIGURED        — no active provider for the store
 *   PROVIDER_NO_DELEGATED_PAYMENT  — provider has no delegated-payment primitive
 *   DELEGATED_TOKEN_INVALID        — provider declined / token invalid
 *   PROVIDER_UNAVAILABLE           — provider HTTP failure
 * Re-throws CheckoutError from completeCheckout() unchanged so the adapter can
 * map domain errors (inventory, discount, mandate, …) to its own error codes.
 */
export async function chargeDelegatedToken(
  input: ChargeDelegatedTokenInput
): Promise<ChargeDelegatedTokenResult> {
  if (!input.delegatedToken || input.delegatedToken.trim() === "") {
    throw new DelegatedPaymentError(
      "a delegated payment token is required for live-mode completion",
      "DELEGATED_TOKEN_INVALID",
      400
    );
  }

  const provider = await resolveProvider(input.storeId, input.provider);

  if (NO_DELEGATED_SUPPORT.has(provider.slug)) {
    throw new DelegatedPaymentError(
      `the configured payment provider '${provider.slug}' does not support ` +
        "delegated/agentic token payments; only Stripe ACP shared payment " +
        "methods are supported for live agentic checkout",
      "PROVIDER_NO_DELEGATED_PAYMENT",
      422
    );
  }

  // ── Step 1: charge the provider with the delegated token ──────────────────
  let charge: { providerReference: string; status: string };
  if (provider.slug === "stripe") {
    const secretKey = provider.config["secret_key"];
    if (typeof secretKey !== "string" || !secretKey) {
      throw new DelegatedPaymentError(
        "stripe provider config is missing secret_key",
        "PROVIDER_NOT_CONFIGURED",
        409
      );
    }
    charge = await chargeStripeDelegated(secretKey, input);
  } else {
    throw new DelegatedPaymentError(
      `the configured payment provider '${provider.slug}' does not support ` +
        "delegated/agentic token payments",
      "PROVIDER_NO_DELEGATED_PAYMENT",
      422
    );
  }

  // ── Step 2: complete the checkout → real order ────────────────────────────
  // The provider has already secured the funds, so completing now means the
  // order exists to attach the payment to.  CheckoutError (inventory/discount/
  // mandate) propagates unchanged for the adapter to map.
  const completed = await completeCheckout(input.storeId, input.checkoutId);

  // ── Step 3: record + capture the live payment ─────────────────────────────
  // Reuses the core payments service (createPayment + capturePayment), which
  // marks the order financial_status = 'paid' when fully captured. The
  // (order_id, provider_reference) unique constraint makes this idempotent.
  const created = await createPayment(completed.orderId, input.storeId, {
    amount: String(completed.total),
    currency: completed.currency,
    provider_id: provider.id,
    provider_reference: charge.providerReference,
    mode: "live",
  });

  await capturePayment(created.id, completed.orderId, input.storeId);

  return {
    orderId: completed.orderId,
    orderNumber: completed.orderNumber,
    paymentId: created.id,
    provider: provider.slug,
    providerReference: charge.providerReference,
  };
}

// Re-export for adapters that need to distinguish checkout-domain errors.
export { CheckoutError };
