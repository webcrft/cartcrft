/**
 * ACP 2026-04 — Agentic checkout sessions service.
 *
 * Endpoints:
 *   POST   /acp/:storeId/checkout_sessions              — create session
 *   GET    /acp/:storeId/checkout_sessions/:id          — get session
 *   POST   /acp/:storeId/checkout_sessions/:id          — update session
 *   POST   /acp/:storeId/checkout_sessions/:id/complete — complete session
 *
 * Wraps core cart/checkout/complete services. The ACP adapter:
 *  - Creates a cart from line_items
 *  - Creates a checkout from the cart
 *  - Maps fulfillment options from shipping_zones/rates
 *  - Maps payment readiness from checkout completeness
 *  - Handles idempotency keys (Idempotency-Key header)
 *  - Maps core errors to ACP error codes
 *
 * Delegate payment (live mode): when payment_data carries a delegated/shared
 * payment token, the token is charged through the store's configured provider
 * (Stripe ACP shared payment method) and a REAL paid order is created — see
 * modules/payments/delegated.ts. Test-mode complete (no token) works via core
 * completeCheckout(). Genuinely-unsupported providers/tokens return machine
 * codes PROVIDER_NO_DELEGATED_PAYMENT / DELEGATED_TOKEN_INVALID.
 */

import { getPool } from "../../../db/pool.js";
import { createCart, addCartLine } from "../../../modules/carts/service.js";
import { createCheckout, updateCheckout, getCheckout } from "../../../modules/checkout/service.js";
import { completeCheckout, CheckoutError } from "../../../modules/checkout/complete.js";
import {
  chargeDelegatedToken,
  DelegatedPaymentError,
} from "../../../modules/payments/delegated.js";
import type {
  AcpCheckoutSession,
  AcpLineItem,
  AcpAddress,
  AcpFulfillmentOption,
  AcpPaymentReadiness,
} from "./types.js";

// ── Idempotency store (in-memory for session creation/completion) ─────────────
// Production-grade: would use the DB idempotency_keys table (T2.3 established this).
// For ACP we use in-memory with TTL since sessions are short-lived agent interactions.

interface IdempotencyRecord {
  sessionId: string;
  result: unknown;
  createdAt: number;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const idempotencyStore = new Map<string, IdempotencyRecord>();

// Prune stale entries every hour
setInterval(
  () => {
    const now = Date.now();
    for (const [key, rec] of idempotencyStore) {
      if (now - rec.createdAt > IDEMPOTENCY_TTL_MS) {
        idempotencyStore.delete(key);
      }
    }
  },
  60 * 60_000
).unref();

function idempotencyKey(storeId: string, key: string): string {
  return `${storeId}:${key}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load fulfillment options (shipping rates) for a store,
 * optionally filtered by shipping address country_code.
 */
async function loadFulfillmentOptions(
  storeId: string,
  countryCode?: string
): Promise<AcpFulfillmentOption[]> {
  const pool = getPool();

  // Build country filter: if we have a country_code, filter zones by region match
  let query: string;
  let params: unknown[];

  if (countryCode) {
    query = `
      SELECT sr.id::text, sr.name, sr.price::text, s.currency,
             sr.estimated_days_min, sr.estimated_days_max
      FROM shipping_rates sr
      JOIN shipping_zones sz ON sz.id = sr.zone_id
      LEFT JOIN shipping_zone_regions sre ON sre.zone_id = sz.id
      JOIN stores s ON s.id = sz.store_id
      WHERE sz.store_id = $1::uuid
        AND sr.is_active = true
        AND (sre.country_code = $2 OR sre.id IS NULL)
      ORDER BY sr.price ASC
      LIMIT 20`;
    params = [storeId, countryCode.toUpperCase()];
  } else {
    query = `
      SELECT sr.id::text, sr.name, sr.price::text, s.currency,
             sr.estimated_days_min, sr.estimated_days_max
      FROM shipping_rates sr
      JOIN shipping_zones sz ON sz.id = sr.zone_id
      JOIN stores s ON s.id = sz.store_id
      WHERE sz.store_id = $1::uuid
        AND sr.is_active = true
      ORDER BY sr.price ASC
      LIMIT 20`;
    params = [storeId];
  }

  const { rows } = await pool.query<{
    id: string;
    name: string;
    price: string;
    currency: string;
    estimated_days_min: number | null;
    estimated_days_max: number | null;
  }>(query, params);

  return rows.map((r) => {
    const opt: AcpFulfillmentOption = {
      id: r.id,
      name: r.name,
      price: { amount: r.price, currency: r.currency },
    };
    if (r.estimated_days_max != null) {
      opt.estimated_days = r.estimated_days_max;
    } else if (r.estimated_days_min != null) {
      opt.estimated_days = r.estimated_days_min;
    }
    return opt;
  });
}

/**
 * Assess payment readiness based on checkout completeness.
 */
function assessPaymentReadiness(
  checkout: Awaited<ReturnType<typeof getCheckout>>,
  fulfillmentOptions: AcpFulfillmentOption[]
): AcpPaymentReadiness {
  if (!checkout) {
    return { ready: false, missing: ["session"] };
  }

  const missing: string[] = [];

  if (!checkout.email) missing.push("email");

  const addr = checkout.shipping_address as Record<string, unknown> | null;
  if (!addr || !addr["country_code"]) missing.push("shipping_address");

  // Shipping rate only required if fulfillment options exist
  if (fulfillmentOptions.length > 0 && !checkout.shipping_rate) {
    missing.push("shipping_rate");
  }

  return {
    ready: missing.length === 0,
    missing,
  };
}

/**
 * Build an AcpCheckoutSession from a core checkout row.
 * Loads the cart lines for the line_items field.
 */
async function buildSession(
  storeId: string,
  checkoutId: string
): Promise<AcpCheckoutSession | null> {
  const pool = getPool();

  const checkout = await getCheckout(storeId, checkoutId);
  if (!checkout) return null;

  // Fetch cart lines for line_items
  const { rows: lineRows } = await pool.query<{
    variant_id: string;
    quantity: number;
  }>(
    `SELECT cl.variant_id::text, cl.quantity
     FROM cart_lines cl
     WHERE cl.cart_id = $1::uuid`,
    [checkout.cart_id]
  );

  const lineItems: AcpLineItem[] = lineRows.map((r) => ({
    variant_id: r.variant_id,
    quantity: r.quantity,
  }));

  // Get fulfillment options
  const addr = checkout.shipping_address as Record<string, unknown> | null;
  const countryCode = typeof addr?.["country_code"] === "string" ? addr["country_code"] : undefined;
  const fulfillmentOptions = await loadFulfillmentOptions(storeId, countryCode);

  const paymentReadiness = assessPaymentReadiness(checkout, fulfillmentOptions);

  // Build buyer from checkout fields
  const buyer: AcpCheckoutSession["buyer"] = {};
  if (checkout.email) buyer.email = checkout.email;
  if (checkout.shipping_address) buyer.shipping_address = checkout.shipping_address as AcpAddress;
  if (checkout.billing_address) buyer.billing_address = checkout.billing_address as AcpAddress;

  // Map status
  let status: AcpCheckoutSession["status"] = "open";
  if (checkout.status === "completed") status = "completed";
  else if (checkout.status === "expired") status = "expired";

  // selected_fulfillment_id from shipping_rate
  const shippingRate = checkout.shipping_rate as Record<string, unknown> | null;
  const selectedFulfillmentId =
    typeof shippingRate?.["id"] === "string" ? shippingRate["id"] : undefined;

  const sessionObj: AcpCheckoutSession = {
    id: checkout.id,
    store_id: checkout.store_id,
    status,
    line_items: lineItems,
    buyer,
    fulfillment_options: fulfillmentOptions,
    totals: {
      subtotal: checkout.subtotal,
      shipping: checkout.shipping_total,
      tax: checkout.tax_total,
      discount: checkout.discount_total,
      total: checkout.total,
      currency: checkout.currency,
    },
    payment_readiness: paymentReadiness,
    created_at: (checkout.created_at as Date).toISOString(),
    updated_at: (checkout.updated_at as Date).toISOString(),
  };

  if (selectedFulfillmentId) {
    sessionObj.selected_fulfillment_id = selectedFulfillmentId;
  }

  return sessionObj;
}

// ── Public service functions ──────────────────────────────────────────────────

export interface CreateSessionInput {
  line_items: AcpLineItem[];
  buyer?: {
    email?: string | undefined;
    shipping_address?: AcpAddress | undefined;
    billing_address?: AcpAddress | undefined;
  } | undefined;
  selected_fulfillment_id?: string | undefined;
}

export interface UpdateSessionInput {
  buyer?: {
    email?: string | undefined;
    shipping_address?: AcpAddress | undefined;
    billing_address?: AcpAddress | undefined;
  } | undefined;
  selected_fulfillment_id?: string | undefined;
}

export interface CompleteSessionInput {
  payment_data?: {
    token?: string | undefined;
    mode?: "test" | "live" | undefined;
  } | undefined;
}

export class AcpError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number = 400
  ) {
    super(message);
    this.name = "AcpError";
  }
}

/**
 * Create an ACP checkout session from line_items.
 * Idempotency: if idempotencyKey is provided and a previous call used it,
 * the same session is returned.
 */
export async function createSession(
  storeId: string,
  input: CreateSessionInput,
  idempotencyKeyValue?: string
): Promise<AcpCheckoutSession> {
  // Check idempotency cache
  if (idempotencyKeyValue) {
    const iKey = idempotencyKey(storeId, idempotencyKeyValue);
    const cached = idempotencyStore.get(iKey);
    if (cached) {
      const session = await buildSession(storeId, cached.sessionId);
      if (session) return session;
    }
  }

  if (!input.line_items || input.line_items.length === 0) {
    throw new AcpError("line_items must not be empty", "invalid_request", 400);
  }

  // Create cart (currency defaults to store's currency via createCart)
  const cartId = await createCart(storeId);

  // Add each line item to the cart
  for (const li of input.line_items) {
    if (!li.variant_id) {
      throw new AcpError("each line_item must have a variant_id", "invalid_request", 400);
    }
    if (!li.quantity || li.quantity < 1) {
      throw new AcpError("each line_item must have quantity >= 1", "invalid_request", 400);
    }
    try {
      await addCartLine(storeId, cartId, li.variant_id, li.quantity);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "NOT_FOUND") {
        throw new AcpError(
          `variant ${li.variant_id} not found in store`,
          "invalid_request",
          400
        );
      }
      throw err;
    }
  }

  // Build checkout body from buyer info
  const checkoutBody: Parameters<typeof createCheckout>[1] = {
    cart_id: cartId,
  };
  if (input.buyer?.email) checkoutBody.email = input.buyer.email;
  if (input.buyer?.shipping_address) {
    checkoutBody.shipping_address = input.buyer.shipping_address as Record<string, unknown>;
  }
  if (input.buyer?.billing_address) {
    checkoutBody.billing_address = input.buyer.billing_address as Record<string, unknown>;
  }
  if (input.selected_fulfillment_id) {
    checkoutBody.shipping_rate = { id: input.selected_fulfillment_id };
  }

  // Create checkout
  const { id: checkoutId } = await createCheckout(storeId, checkoutBody);

  // Cache idempotency
  if (idempotencyKeyValue) {
    const iKey = idempotencyKey(storeId, idempotencyKeyValue);
    idempotencyStore.set(iKey, {
      sessionId: checkoutId,
      result: null,
      createdAt: Date.now(),
    });
  }

  const session = await buildSession(storeId, checkoutId);
  if (!session) {
    throw new AcpError("session creation failed", "internal_error", 500);
  }
  return session;
}

/**
 * Get an ACP checkout session by id.
 */
export async function getSession(
  storeId: string,
  sessionId: string
): Promise<AcpCheckoutSession> {
  const session = await buildSession(storeId, sessionId);
  if (!session) {
    throw new AcpError("session not found", "session_not_found", 404);
  }
  return session;
}

/**
 * Update an ACP checkout session (buyer info / fulfillment selection).
 * Re-totals the checkout.
 */
export async function updateSession(
  storeId: string,
  sessionId: string,
  input: UpdateSessionInput
): Promise<AcpCheckoutSession> {
  const existing = await getCheckout(storeId, sessionId);
  if (!existing) {
    throw new AcpError("session not found", "session_not_found", 404);
  }
  if (existing.status !== "pending") {
    throw new AcpError("session is not open", "session_not_open", 409);
  }

  const updateBody: Parameters<typeof updateCheckout>[2] = {};
  if (input.buyer?.email) updateBody.email = input.buyer.email;
  if (input.buyer?.shipping_address) {
    updateBody.shipping_address = input.buyer.shipping_address as Record<string, unknown>;
  }
  if (input.buyer?.billing_address) {
    updateBody.billing_address = input.buyer.billing_address as Record<string, unknown>;
  }
  if (input.selected_fulfillment_id) {
    updateBody.shipping_rate = { id: input.selected_fulfillment_id };
  }

  await updateCheckout(storeId, sessionId, updateBody);

  const session = await buildSession(storeId, sessionId);
  if (!session) {
    throw new AcpError("session not found after update", "session_not_found", 404);
  }
  return session;
}

/** Map a CheckoutError (from core complete) to an AcpError. */
function mapCheckoutError(err: CheckoutError): AcpError {
  const codeMap: Record<string, string> = {
    NOT_FOUND: "session_not_found",
    DISCOUNT_EXHAUSTED: "discount_exhausted",
    DISCOUNT_ALREADY_USED: "discount_already_used",
    INSUFFICIENT_INVENTORY: "insufficient_inventory",
    MANDATE_SPEND_LIMIT_EXCEEDED: "mandate_spend_limit_exceeded",
    MANDATE_REQUIRED: "mandate_required",
    CREDIT_LIMIT_EXCEEDED: "credit_limit_exceeded",
  };
  return new AcpError(
    err.message,
    codeMap[err.code] ?? "checkout_error",
    err.code === "NOT_FOUND" ? 404 : 422
  );
}

/**
 * Complete an ACP checkout session.
 *
 * Live mode — a delegated payment token is present (payment_data.token, or
 *   payment_data.mode === "live"):
 *     The shared/delegated token is charged through the store's configured
 *     provider (Stripe ACP shared payment method). On a successful charge a
 *     REAL paid order is created (financial_status = 'paid'). Unsupported
 *     providers/tokens surface machine codes PROVIDER_NO_DELEGATED_PAYMENT /
 *     DELEGATED_TOKEN_INVALID.
 *
 * Test mode (no token, mode absent or "test"):
 *     Calls completeCheckout() directly — creates a real (unpaid/test) order.
 *
 * Idempotency: if idempotencyKey is provided, the same response is returned
 * for duplicate calls.
 */
export async function completeSession(
  storeId: string,
  sessionId: string,
  input: CompleteSessionInput,
  idempotencyKeyValue?: string
): Promise<{ session: AcpCheckoutSession; orderId: string; orderNumber: string }> {
  // Check idempotency (applies to both test and live paths)
  if (idempotencyKeyValue) {
    const iKey = idempotencyKey(storeId, `complete:${idempotencyKeyValue}`);
    const cached = idempotencyStore.get(iKey);
    if (cached) {
      const session = await buildSession(storeId, sessionId);
      if (session) {
        const cachedResult = cached.result as { orderId: string; orderNumber: string } | null;
        if (cachedResult) {
          return {
            session,
            orderId: cachedResult.orderId,
            orderNumber: cachedResult.orderNumber,
          };
        }
      }
    }
  }

  const delegatedToken = input.payment_data?.token;
  const isLive = input.payment_data?.mode === "live" || Boolean(delegatedToken);

  let completeResult: { orderId: string; orderNumber: string };

  if (isLive) {
    // ── Live delegated-payment path ──────────────────────────────────────────
    if (!delegatedToken) {
      throw new AcpError(
        "live-mode completion requires payment_data.token (a delegated/shared payment credential)",
        "DELEGATED_TOKEN_INVALID",
        400
      );
    }

    // Load the checkout so we know the amount/currency/email to charge.
    const checkout = await getCheckout(storeId, sessionId);
    if (!checkout) {
      throw new AcpError("session not found", "session_not_found", 404);
    }

    try {
      const charged = await chargeDelegatedToken({
        storeId,
        checkoutId: sessionId,
        delegatedToken,
        amount: parseFloat(checkout.total),
        currency: checkout.currency,
        ...(checkout.email ? { email: checkout.email } : {}),
      });
      completeResult = { orderId: charged.orderId, orderNumber: charged.orderNumber };
    } catch (err) {
      if (err instanceof CheckoutError) throw mapCheckoutError(err);
      if (err instanceof DelegatedPaymentError) {
        throw new AcpError(err.message, err.code, err.httpStatus);
      }
      throw err;
    }
  } else {
    // ── Test-mode path: create a real order without charging ─────────────────
    try {
      completeResult = await completeCheckout(storeId, sessionId);
    } catch (err) {
      if (err instanceof CheckoutError) throw mapCheckoutError(err);
      throw err;
    }
  }

  // Cache idempotency result
  if (idempotencyKeyValue) {
    const iKey = idempotencyKey(storeId, `complete:${idempotencyKeyValue}`);
    idempotencyStore.set(iKey, {
      sessionId,
      result: { orderId: completeResult.orderId, orderNumber: completeResult.orderNumber },
      createdAt: Date.now(),
    });
  }

  const session = await buildSession(storeId, sessionId);
  if (!session) {
    throw new AcpError("session not found after completion", "internal_error", 500);
  }

  return {
    session,
    orderId: completeResult.orderId,
    orderNumber: completeResult.orderNumber,
  };
}
