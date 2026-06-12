/**
 * UCP 2026-01 — Checkout conformance service.
 *
 * Endpoints (relative, prefix injected by index):
 *   POST  /ucp/:storeId/checkout             — create checkout entity from line_items
 *   PATCH /ucp/:storeId/checkout/:id         — update buyer/address/fulfillment, re-totals
 *   POST  /ucp/:storeId/checkout/:id/submit  — submit: test-mode → real order; live → 501
 *
 * Wraps core cart/checkout/complete services (never edits them).
 * Idempotency-Key header honored on create and submit.
 *
 * Spec version: 2026-01 NRF baseline, provisional.
 * See docs/ucp.md for field mapping and assumptions.
 */

import { getPool } from "../../../db/pool.js";
import { createCart, addCartLine } from "../../../modules/carts/service.js";
import { createCheckout, updateCheckout, getCheckout } from "../../../modules/checkout/service.js";
import { completeCheckout, CheckoutError } from "../../../modules/checkout/complete.js";
import type {
  UcpCheckoutEntity,
  UcpLineItem,
  UcpAddress,
  UcpBuyer,
  UcpFulfillmentOption,
} from "./types.js";

// ── Idempotency store ─────────────────────────────────────────────────────────
// In-memory with TTL — matches ACP pattern. Production systems should use the
// DB idempotency_keys table, but UCP checkouts are short-lived agent interactions.

interface IdempotencyRecord {
  checkoutId: string;
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

function makeIdempotencyKey(storeId: string, key: string): string {
  return `ucp:${storeId}:${key}`;
}

// ── UCP-specific errors ───────────────────────────────────────────────────────

export class UcpError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number = 400,
    public readonly field?: string
  ) {
    super(message);
    this.name = "UcpError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Load active shipping rates for a store, optionally filtered by country.
 */
async function loadFulfillmentOptions(
  storeId: string,
  countryCode?: string
): Promise<UcpFulfillmentOption[]> {
  const pool = getPool();

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
    const opt: UcpFulfillmentOption = {
      id: r.id,
      name: r.name,
      price: { amount: r.price, currency: r.currency },
    };
    if (r.estimated_days_min != null) opt.estimated_days_min = r.estimated_days_min;
    if (r.estimated_days_max != null) opt.estimated_days_max = r.estimated_days_max;
    return opt;
  });
}

/**
 * Assess UCP payment readiness — mirrors ACP pattern but uses UCP field names.
 */
function assessPaymentReadiness(
  checkout: Awaited<ReturnType<typeof getCheckout>>,
  fulfillmentOptions: UcpFulfillmentOption[]
): { ready: boolean; missing: string[] } {
  if (!checkout) return { ready: false, missing: ["checkout"] };

  const missing: string[] = [];
  if (!checkout.email) missing.push("buyer.email");

  const addr = checkout.shipping_address as Record<string, unknown> | null;
  if (!addr || !addr["country_code"]) missing.push("buyer.shipping_address");

  if (fulfillmentOptions.length > 0 && !checkout.shipping_rate) {
    missing.push("selected_fulfillment_id");
  }

  return { ready: missing.length === 0, missing };
}

/**
 * Map core checkout → UcpCheckoutEntity.
 * Also fetches cart lines and fulfillment options.
 */
async function buildCheckoutEntity(
  storeId: string,
  checkoutId: string
): Promise<UcpCheckoutEntity | null> {
  const pool = getPool();

  const checkout = await getCheckout(storeId, checkoutId);
  if (!checkout) return null;

  // Cart lines
  const { rows: lineRows } = await pool.query<{
    variant_id: string;
    quantity: number;
    price: string;
  }>(
    `SELECT cl.variant_id::text, cl.quantity, cl.price::text
     FROM cart_lines cl
     WHERE cl.cart_id = $1::uuid`,
    [checkout.cart_id]
  );

  const lineItems: UcpLineItem[] = lineRows.map((r) => ({
    variant_id: r.variant_id,
    quantity: r.quantity,
    unit_price: r.price,
  }));

  // Fulfillment options
  const addr = checkout.shipping_address as Record<string, unknown> | null;
  const countryCode = typeof addr?.["country_code"] === "string" ? addr["country_code"] : undefined;
  const fulfillmentOptions = await loadFulfillmentOptions(storeId, countryCode);

  const paymentReadiness = assessPaymentReadiness(checkout, fulfillmentOptions);

  // Build buyer
  const buyer: UcpBuyer = {};
  if (checkout.email) buyer.email = checkout.email;
  if (checkout.shipping_address) {
    // Remap core address fields to UCP names
    const src = checkout.shipping_address as Record<string, unknown>;
    const ucpAddr: UcpAddress = {};
    if (src["name"]) ucpAddr.name = String(src["name"]);
    if (src["phone"]) ucpAddr.phone = String(src["phone"]);
    if (src["email"]) ucpAddr.email = String(src["email"]);
    if (src["address1"]) ucpAddr.address1 = String(src["address1"]);
    if (src["address2"]) ucpAddr.address2 = String(src["address2"]);
    if (src["city"]) ucpAddr.city = String(src["city"]);
    // UCP uses state_or_province; core uses province_code
    if (src["province_code"]) ucpAddr.state_or_province = String(src["province_code"]);
    // UCP uses postal_code; core uses zip
    if (src["zip"]) ucpAddr.postal_code = String(src["zip"]);
    if (src["country_code"]) ucpAddr.country_code = String(src["country_code"]);
    buyer.shipping_address = ucpAddr;
  }
  if (checkout.billing_address) {
    const src = checkout.billing_address as Record<string, unknown>;
    const ucpAddr: UcpAddress = {};
    if (src["name"]) ucpAddr.name = String(src["name"]);
    if (src["phone"]) ucpAddr.phone = String(src["phone"]);
    if (src["email"]) ucpAddr.email = String(src["email"]);
    if (src["address1"]) ucpAddr.address1 = String(src["address1"]);
    if (src["address2"]) ucpAddr.address2 = String(src["address2"]);
    if (src["city"]) ucpAddr.city = String(src["city"]);
    if (src["province_code"]) ucpAddr.state_or_province = String(src["province_code"]);
    if (src["zip"]) ucpAddr.postal_code = String(src["zip"]);
    if (src["country_code"]) ucpAddr.country_code = String(src["country_code"]);
    buyer.billing_address = ucpAddr;
  }

  // Map status: core "pending" → UCP "OPEN"; "completed" → "COMPLETED"; "expired" → "EXPIRED"
  let status: UcpCheckoutEntity["status"] = "OPEN";
  if (checkout.status === "completed") status = "COMPLETED";
  else if (checkout.status === "expired") status = "EXPIRED";

  // selected_fulfillment_id from shipping_rate.id
  const shippingRate = checkout.shipping_rate as Record<string, unknown> | null;
  const selectedFulfillmentId =
    typeof shippingRate?.["id"] === "string" ? shippingRate["id"] : undefined;

  const entity: UcpCheckoutEntity = {
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

  if (selectedFulfillmentId) entity.selected_fulfillment_id = selectedFulfillmentId;

  return entity;
}

// ── Public service inputs ─────────────────────────────────────────────────────

export interface CreateCheckoutInput {
  line_items: UcpLineItem[];
  buyer?: UcpBuyer | undefined;
  selected_fulfillment_id?: string | undefined;
}

export interface UpdateCheckoutInput {
  buyer?: UcpBuyer | undefined;
  selected_fulfillment_id?: string | undefined;
}

export interface SubmitCheckoutInput {
  payment_token?: string | undefined;
  /** "test" (default) → core complete; "live" → 501 */
  mode?: "test" | "live" | undefined;
}

// ── Mapper: UcpAddress → core address shape ───────────────────────────────────

function ucpAddressToCoreAddress(addr: UcpAddress): Record<string, unknown> {
  const core: Record<string, unknown> = {};
  if (addr.name) core["name"] = addr.name;
  if (addr.phone) core["phone"] = addr.phone;
  if (addr.email) core["email"] = addr.email;
  if (addr.address1) core["address1"] = addr.address1;
  if (addr.address2) core["address2"] = addr.address2;
  if (addr.city) core["city"] = addr.city;
  // UCP state_or_province → core province_code
  if (addr.state_or_province) core["province_code"] = addr.state_or_province;
  // UCP postal_code → core zip
  if (addr.postal_code) core["zip"] = addr.postal_code;
  if (addr.country_code) core["country_code"] = addr.country_code;
  return core;
}

// ── Public service functions ──────────────────────────────────────────────────

/**
 * Create a UCP checkout from line_items.
 * Idempotency: Idempotency-Key header causes duplicate calls to return same checkout.
 */
export async function createUcpCheckout(
  storeId: string,
  input: CreateCheckoutInput,
  idempotencyKeyValue?: string
): Promise<UcpCheckoutEntity> {
  // Check idempotency cache
  if (idempotencyKeyValue) {
    const iKey = makeIdempotencyKey(storeId, idempotencyKeyValue);
    const cached = idempotencyStore.get(iKey);
    if (cached) {
      const entity = await buildCheckoutEntity(storeId, cached.checkoutId);
      if (entity) return entity;
    }
  }

  if (!input.line_items || input.line_items.length === 0) {
    throw new UcpError("line_items must not be empty", "INVALID_REQUEST", 400, "line_items");
  }

  // Create cart
  const cartId = await createCart(storeId);

  // Add line items
  for (const li of input.line_items) {
    if (!li.variant_id) {
      throw new UcpError("each line_item must have a variant_id", "INVALID_REQUEST", 400, "line_items.variant_id");
    }
    if (!li.quantity || li.quantity < 1) {
      throw new UcpError("each line_item must have quantity >= 1", "INVALID_REQUEST", 400, "line_items.quantity");
    }
    try {
      await addCartLine(storeId, cartId, li.variant_id, li.quantity);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "NOT_FOUND") {
        throw new UcpError(
          `variant ${li.variant_id} not found in store`,
          "INVALID_REQUEST",
          400,
          "line_items.variant_id"
        );
      }
      throw err;
    }
  }

  // Build core checkout body from UCP buyer
  const checkoutBody: Parameters<typeof createCheckout>[1] = { cart_id: cartId };
  if (input.buyer?.email) checkoutBody.email = input.buyer.email;
  if (input.buyer?.shipping_address) {
    checkoutBody.shipping_address = ucpAddressToCoreAddress(input.buyer.shipping_address);
  }
  if (input.buyer?.billing_address) {
    checkoutBody.billing_address = ucpAddressToCoreAddress(input.buyer.billing_address);
  }
  if (input.selected_fulfillment_id) {
    checkoutBody.shipping_rate = { id: input.selected_fulfillment_id };
  }

  const { id: checkoutId } = await createCheckout(storeId, checkoutBody);

  // Cache idempotency
  if (idempotencyKeyValue) {
    const iKey = makeIdempotencyKey(storeId, idempotencyKeyValue);
    idempotencyStore.set(iKey, { checkoutId, result: null, createdAt: Date.now() });
  }

  const entity = await buildCheckoutEntity(storeId, checkoutId);
  if (!entity) {
    throw new UcpError("checkout creation failed", "INTERNAL_ERROR", 500);
  }
  return entity;
}

/**
 * Get a UCP checkout entity by id.
 */
export async function getUcpCheckout(
  storeId: string,
  checkoutId: string
): Promise<UcpCheckoutEntity> {
  const entity = await buildCheckoutEntity(storeId, checkoutId);
  if (!entity) {
    throw new UcpError("checkout not found", "ENTITY_NOT_FOUND", 404);
  }
  return entity;
}

/**
 * Update a UCP checkout (buyer/address/fulfillment), re-totals.
 */
export async function updateUcpCheckout(
  storeId: string,
  checkoutId: string,
  input: UpdateCheckoutInput
): Promise<UcpCheckoutEntity> {
  const existing = await getCheckout(storeId, checkoutId);
  if (!existing) {
    throw new UcpError("checkout not found", "ENTITY_NOT_FOUND", 404);
  }
  if (existing.status !== "pending") {
    throw new UcpError("checkout is not open", "CHECKOUT_NOT_OPEN", 409);
  }

  const updateBody: Parameters<typeof updateCheckout>[2] = {};
  if (input.buyer?.email) updateBody.email = input.buyer.email;
  if (input.buyer?.shipping_address) {
    updateBody.shipping_address = ucpAddressToCoreAddress(input.buyer.shipping_address);
  }
  if (input.buyer?.billing_address) {
    updateBody.billing_address = ucpAddressToCoreAddress(input.buyer.billing_address);
  }
  if (input.selected_fulfillment_id) {
    updateBody.shipping_rate = { id: input.selected_fulfillment_id };
  }

  await updateCheckout(storeId, checkoutId, updateBody);

  const entity = await buildCheckoutEntity(storeId, checkoutId);
  if (!entity) {
    throw new UcpError("checkout not found after update", "ENTITY_NOT_FOUND", 404);
  }
  return entity;
}

/**
 * Submit (complete) a UCP checkout.
 *
 * Test mode (default): calls core completeCheckout() → real order.
 * Live mode (mode="live" or payment_token provided without mode): 501
 *   PAYMENT_TOKEN_UNSUPPORTED — live payment token passthrough not yet supported.
 */
export async function submitUcpCheckout(
  storeId: string,
  checkoutId: string,
  input: SubmitCheckoutInput,
  idempotencyKeyValue?: string
): Promise<{ checkout: UcpCheckoutEntity; orderId: string; orderNumber: string }> {
  // Live mode: not supported
  if (input.mode === "live" || (input.payment_token && input.mode !== "test")) {
    throw new UcpError(
      "Live-mode payment token passthrough is not yet supported. " +
        "Use mode='test' for test-mode checkout completion. " +
        "Live-mode card token support is on the roadmap.",
      "PAYMENT_TOKEN_UNSUPPORTED",
      501
    );
  }

  // Check idempotency
  if (idempotencyKeyValue) {
    const iKey = makeIdempotencyKey(storeId, `submit:${idempotencyKeyValue}`);
    const cached = idempotencyStore.get(iKey);
    if (cached) {
      const entity = await buildCheckoutEntity(storeId, checkoutId);
      if (entity) {
        const cachedResult = cached.result as { orderId: string; orderNumber: string } | null;
        if (cachedResult) {
          return { checkout: entity, orderId: cachedResult.orderId, orderNumber: cachedResult.orderNumber };
        }
      }
    }
  }

  // Complete checkout via core service
  let completeResult: Awaited<ReturnType<typeof completeCheckout>>;
  try {
    completeResult = await completeCheckout(storeId, checkoutId);
  } catch (err) {
    if (err instanceof CheckoutError) {
      // Map core error codes to UCP codes
      const codeMap: Record<string, string> = {
        NOT_FOUND: "ENTITY_NOT_FOUND",
        DISCOUNT_EXHAUSTED: "PROMOTION_EXHAUSTED",
        DISCOUNT_ALREADY_USED: "PROMOTION_ALREADY_REDEEMED",
        INSUFFICIENT_INVENTORY: "INVENTORY_UNAVAILABLE",
        MANDATE_SPEND_LIMIT_EXCEEDED: "MANDATE_SPEND_LIMIT_EXCEEDED",
        MANDATE_REQUIRED: "MANDATE_REQUIRED",
      };
      throw new UcpError(
        err.message,
        codeMap[err.code] ?? "CHECKOUT_ERROR",
        err.code === "NOT_FOUND" ? 404 : 422
      );
    }
    throw err;
  }

  // Cache idempotency result
  if (idempotencyKeyValue) {
    const iKey = makeIdempotencyKey(storeId, `submit:${idempotencyKeyValue}`);
    idempotencyStore.set(iKey, {
      checkoutId,
      result: { orderId: completeResult.orderId, orderNumber: completeResult.orderNumber },
      createdAt: Date.now(),
    });
  }

  const entity = await buildCheckoutEntity(storeId, checkoutId);
  if (!entity) {
    throw new UcpError("checkout not found after submission", "INTERNAL_ERROR", 500);
  }

  return {
    checkout: entity,
    orderId: completeResult.orderId,
    orderNumber: completeResult.orderNumber,
  };
}
