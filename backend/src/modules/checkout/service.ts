/**
 * checkout/service.ts — Checkout session business logic.
 *
 * Ported from:
 *   webcrft-mono/backend/internal/handlers/commerce_checkout.go
 *
 * Key invariants:
 *  H8: Shipping rate price is NEVER trusted from the client body.
 *      We look up by server-side rate id from shipping_rates table.
 *  H9: customer_id in body is verified against store before attaching.
 *  discount validation is read-only here; the atomic burn happens at complete time.
 */

import { getPool, getReadDb } from "../../db/pool.js";
import { calcTax, extractAddressCodes, type TaxLine } from "../../lib/tax.js";
import { round2 } from "../../lib/money.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CheckoutPublic {
  id: string;
  cart_id: string;
  store_id: string;
  customer_id: string | null;
  company_id: string | null;
  email: string | null;
  shipping_address: Record<string, unknown> | null;
  billing_address: Record<string, unknown> | null;
  collection_point_id: string | null;
  shipping_rate: Record<string, unknown> | null;
  tax_lines: TaxLine[];
  discount_lines: Array<Record<string, unknown>>;
  subtotal: string;
  shipping_total: string;
  tax_total: string;
  discount_total: string;
  total: string;
  currency: string;
  payment_session: Record<string, unknown> | null;
  status: string;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DiscountLine {
  code: string;
  type: string;
  amount: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface CartLine {
  variant_id: string;
  qty: number;
  price: number;
  title: string;
  sku: string;
  product_type: string;
}

async function loadCartLines(
  pool: ReturnType<typeof getPool>,
  cartId: string
): Promise<CartLine[]> {
  const { rows } = await pool.query<{
    variant_id: string;
    quantity: number;
    price: string;
    title: string;
    sku: string;
    type: string;
  }>(
    `SELECT cl.variant_id::text, cl.quantity, cl.price::text,
            COALESCE(pv.title, p.title, 'Item') AS title,
            COALESCE(pv.sku, '') AS sku,
            p.type
     FROM cart_lines cl
     JOIN product_variants pv ON pv.id = cl.variant_id
     JOIN products p ON p.id = pv.product_id
     WHERE cl.cart_id = $1::uuid`,
    [cartId]
  );
  return rows.map((r) => ({
    variant_id: r.variant_id,
    qty: r.quantity,
    price: parseFloat(r.price),
    title: r.title,
    sku: r.sku,
    product_type: r.type,
  }));
}

function cartSubtotal(lines: CartLine[]): number {
  return lines.reduce((acc, l) => acc + l.price * l.qty, 0);
}

function cartHasDomainLines(lines: CartLine[]): boolean {
  return lines.some((l) => l.product_type === "domain");
}

/**
 * Lookup shipping rate price from the DB by rate id.
 * H8: Never trust client-supplied price.
 * Returns 0 if not found.
 */
async function lookupShippingRatePrice(
  pool: ReturnType<typeof getPool>,
  storeId: string,
  rateId: string
): Promise<number> {
  const { rows } = await pool.query<{ price: string }>(
    `SELECT sr.price::text FROM shipping_rates sr
     JOIN shipping_zones sz ON sz.id = sr.zone_id
     WHERE sr.id = $1::uuid AND sz.store_id = $2::uuid AND sr.is_active = true`,
    [rateId, storeId]
  );
  return rows[0] ? parseFloat(rows[0].price) : 0;
}

/**
 * Apply a discount code read-only (validation only; no burn).
 * Mirrors Go checkoutApplyDiscount().
 * Returns { discountTotal, discountLines, error }.
 */
export async function applyDiscount(
  storeId: string,
  code: string,
  subtotal: number,
  customerId: string | null
): Promise<{
  discountTotal: number;
  discountLines: DiscountLine[];
  error: string | null;
}> {
  if (!code) return { discountTotal: 0, discountLines: [], error: null };

  const pool = getReadDb();
  const { rows } = await pool.query<{
    id: string;
    type: string;
    value: string | null;
    min_order_total: string | null;
    max_discount: string | null;
    max_uses: number | null;
    uses_count: number;
    once_per_customer: boolean;
  }>(
    `SELECT id::text, type, value::text, min_order_total::text, max_discount::text,
            max_uses, uses_count, once_per_customer
     FROM discount_codes
     WHERE store_id = $1::uuid AND code = $2
       AND is_active = true
       AND (starts_at IS NULL OR starts_at <= now())
       AND (ends_at IS NULL OR ends_at >= now())`,
    [storeId, code.toUpperCase()]
  );

  if (rows.length === 0) {
    return { discountTotal: 0, discountLines: [], error: "invalid or expired discount code" };
  }

  const dc = rows[0]!;

  // Min subtotal check
  if (dc.min_order_total !== null) {
    const minTotal = parseFloat(dc.min_order_total);
    if (subtotal < minTotal) {
      return { discountTotal: 0, discountLines: [], error: "invalid or expired discount code" };
    }
  }

  // Pre-flight cap check (non-authoritative — authoritative burn at complete time)
  if (dc.max_uses !== null && dc.uses_count >= dc.max_uses) {
    return { discountTotal: 0, discountLines: [], error: "invalid or expired discount code" };
  }

  // once_per_customer pre-flight (also re-checked atomically at completion)
  if (dc.once_per_customer) {
    if (!customerId) {
      return { discountTotal: 0, discountLines: [], error: "invalid or expired discount code" };
    }
    const { rows: usageRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM discount_usages
       WHERE discount_id = $1::uuid AND customer_id = $2::uuid`,
      [dc.id, customerId]
    );
    if (parseInt(usageRows[0]?.count ?? "0", 10) > 0) {
      return { discountTotal: 0, discountLines: [], error: "invalid or expired discount code" };
    }
  }

  let amount = 0;
  switch (dc.type) {
    case "percentage": {
      if (dc.value !== null) {
        amount = subtotal * parseFloat(dc.value) / 100;
        if (dc.max_discount !== null) {
          amount = Math.min(amount, parseFloat(dc.max_discount));
        }
      }
      break;
    }
    case "fixed_amount": {
      if (dc.value !== null) {
        amount = Math.min(parseFloat(dc.value), subtotal);
      }
      break;
    }
    // free_shipping, bogo, buy_x_get_y handled at complete time (T2.7)
    default:
      amount = 0;
  }
  amount = round2(amount);

  return {
    discountTotal: amount,
    discountLines: [{ code, type: dc.type, amount }],
    error: null,
  };
}

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * Create a checkout from a cart.
 * H9: Validates customer_id belongs to store.
 * H8: Shipping rate price fetched from DB.
 */
export async function createCheckout(
  storeId: string,
  body: {
    cart_id: string;
    customer_id?: string;
    company_id?: string;
    email?: string;
    shipping_address?: Record<string, unknown>;
    billing_address?: Record<string, unknown>;
    shipping_rate?: Record<string, unknown>;
    discount_code?: string;
  }
): Promise<{
  id: string;
  subtotal: number;
  shipping_total: number;
  tax_total: number;
  discount_total: number;
  total: number;
  currency: string;
  tax_lines: TaxLine[];
  discount_lines: DiscountLine[];
}> {
  const pool = getPool();
  const cartId = body.cart_id;

  // H9: Validate customer if provided
  if (body.customer_id) {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1::uuid AND store_id = $2::uuid) AS exists`,
      [body.customer_id, storeId]
    );
    if (!rows[0]?.exists) {
      const e = new Error("customer not found in store");
      (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
      throw e;
    }
  }

  // Load cart — must be active
  const { rows: cartRows } = await pool.query<{
    currency: string;
    customer_id: string | null;
  }>(
    `SELECT currency, customer_id::text FROM carts
     WHERE id = $1::uuid AND store_id = $2::uuid AND status = 'active'`,
    [cartId, storeId]
  );
  if (cartRows.length === 0) {
    const e = new Error("cart not found or not active");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }

  const currency = cartRows[0]!.currency;
  let customerId: string | null = cartRows[0]!.customer_id ?? null;
  if (!customerId && body.customer_id) {
    customerId = body.customer_id;
  }

  const lines = await loadCartLines(pool, cartId);
  if (lines.length === 0) {
    const e = new Error("cart has no lines");
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }

  const subtotal = round2(cartSubtotal(lines));

  // Discount
  const discountCode = (body.discount_code ?? "").toUpperCase().trim();
  if (discountCode && cartHasDomainLines(lines)) {
    const e = new Error("discount codes cannot be applied to domain products");
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }
  const discountResult = await applyDiscount(storeId, discountCode, subtotal, customerId);
  if (discountResult.error) {
    const e = new Error(discountResult.error);
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }

  // Tax
  const { countryCode, provinceCode } = extractAddressCodes(body.shipping_address ?? null);
  const taxResult = await calcTax(pool, storeId, subtotal - discountResult.discountTotal, countryCode, provinceCode);

  // Shipping (H8: server-side price only)
  let shippingTotal = 0;
  let shippingRateJson: string | null = null;
  if (body.shipping_rate && typeof body.shipping_rate["id"] === "string" && body.shipping_rate["id"]) {
    shippingTotal = await lookupShippingRatePrice(pool, storeId, body.shipping_rate["id"] as string);
    shippingRateJson = JSON.stringify(body.shipping_rate);
  }

  const total = round2(subtotal - discountResult.discountTotal + taxResult.taxTotal + shippingTotal);

  const { rows: insertRows } = await pool.query<{ id: string }>(
    `INSERT INTO checkouts
       (cart_id, store_id, customer_id, company_id, email,
        shipping_address, billing_address,
        shipping_rate, tax_lines, discount_lines,
        subtotal, shipping_total, tax_total, discount_total, total, currency)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5,
             $6, $7, $8, $9::jsonb, $10::jsonb,
             $11, $12, $13, $14, $15, $16)
     RETURNING id::text`,
    [
      cartId,
      storeId,
      customerId,
      body.company_id ?? null,
      body.email ?? null,
      body.shipping_address ? JSON.stringify(body.shipping_address) : null,
      body.billing_address ? JSON.stringify(body.billing_address) : null,
      shippingRateJson,
      JSON.stringify(taxResult.taxLines),
      JSON.stringify(discountResult.discountLines),
      subtotal,
      shippingTotal,
      taxResult.taxTotal,
      discountResult.discountTotal,
      total,
      currency,
    ]
  );

  return {
    id: insertRows[0]!.id,
    subtotal,
    shipping_total: shippingTotal,
    tax_total: taxResult.taxTotal,
    discount_total: discountResult.discountTotal,
    total,
    currency,
    tax_lines: taxResult.taxLines,
    discount_lines: discountResult.discountLines,
  };
}

/**
 * Get a checkout by id. IDOR-safe: always filters by store_id.
 */
export async function getCheckout(
  storeId: string,
  checkoutId: string
): Promise<CheckoutPublic | null> {
  const pool = getReadDb();
  const { rows } = await pool.query<CheckoutPublic>(
    `SELECT id::text, cart_id::text, store_id::text, customer_id::text, company_id::text,
            email,
            shipping_address, billing_address, collection_point_id::text,
            shipping_rate, tax_lines, discount_lines,
            subtotal::text, shipping_total::text, tax_total::text,
            discount_total::text, total::text,
            currency, payment_session, status, completed_at, created_at, updated_at
     FROM checkouts
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [checkoutId, storeId]
  );
  return rows[0] ?? null;
}

/**
 * Update a checkout (email, addresses, shipping rate, discount code).
 * H8: Shipping price fetched server-side.
 * Recalculates all totals.
 */
export async function updateCheckout(
  storeId: string,
  checkoutId: string,
  body: {
    email?: string;
    shipping_address?: Record<string, unknown>;
    billing_address?: Record<string, unknown>;
    shipping_rate?: Record<string, unknown>;
    discount_code?: string;
  }
): Promise<{
  subtotal: number;
  shipping_total: number;
  tax_total: number;
  discount_total: number;
  total: number;
  currency: string;
  tax_lines: TaxLine[];
  discount_lines: DiscountLine[];
}> {
  const pool = getPool();

  // Load existing checkout (must be pending)
  const { rows: chRows } = await pool.query<{
    cart_id: string;
    currency: string;
    customer_id: string | null;
  }>(
    `SELECT cart_id::text, currency, customer_id::text
     FROM checkouts
     WHERE id = $1::uuid AND store_id = $2::uuid AND status = 'pending'`,
    [checkoutId, storeId]
  );
  if (chRows.length === 0) {
    const e = new Error("checkout not found or already completed");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }

  const cartId = chRows[0]!.cart_id;
  const currency = chRows[0]!.currency;
  const customerId = chRows[0]!.customer_id;

  const lines = await loadCartLines(pool, cartId);
  const subtotal = round2(cartSubtotal(lines));

  // Discount
  const discountCode = (body.discount_code ?? "").toUpperCase().trim();
  if (discountCode && cartHasDomainLines(lines)) {
    const e = new Error("discount codes cannot be applied to domain products");
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }
  const discountResult = await applyDiscount(storeId, discountCode, subtotal, customerId);
  if (discountResult.error) {
    const e = new Error(discountResult.error);
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }

  // Tax
  const { countryCode, provinceCode } = extractAddressCodes(body.shipping_address ?? null);
  const taxResult = await calcTax(pool, storeId, subtotal - discountResult.discountTotal, countryCode, provinceCode);

  // Shipping (H8)
  let shippingTotal = 0;
  let shippingRateJson: string | null = null;
  if (body.shipping_rate && typeof body.shipping_rate["id"] === "string" && body.shipping_rate["id"]) {
    shippingTotal = await lookupShippingRatePrice(pool, storeId, body.shipping_rate["id"] as string);
    shippingRateJson = JSON.stringify(body.shipping_rate);
  }

  const total = round2(subtotal - discountResult.discountTotal + taxResult.taxTotal + shippingTotal);

  await pool.query(
    `UPDATE checkouts SET
       email            = COALESCE($3, email),
       shipping_address = COALESCE($4, shipping_address),
       billing_address  = COALESCE($5, billing_address),
       shipping_rate    = COALESCE($6, shipping_rate),
       tax_lines        = $7::jsonb,
       discount_lines   = $8::jsonb,
       subtotal         = $9,
       shipping_total   = $10,
       tax_total        = $11,
       discount_total   = $12,
       total            = $13,
       updated_at       = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [
      checkoutId,
      storeId,
      body.email ?? null,
      body.shipping_address ? JSON.stringify(body.shipping_address) : null,
      body.billing_address ? JSON.stringify(body.billing_address) : null,
      shippingRateJson,
      JSON.stringify(taxResult.taxLines),
      JSON.stringify(discountResult.discountLines),
      subtotal,
      shippingTotal,
      taxResult.taxTotal,
      discountResult.discountTotal,
      total,
    ]
  );

  return {
    subtotal,
    shipping_total: shippingTotal,
    tax_total: taxResult.taxTotal,
    discount_total: discountResult.discountTotal,
    total,
    currency,
    tax_lines: taxResult.taxLines,
    discount_lines: discountResult.discountLines,
  };
}
