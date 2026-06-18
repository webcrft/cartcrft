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
import { computeDiscounts, type DiscountCartLine } from "../discounts/service.js";
import { getLatestRates, rateFor, convertMoney } from "../../lib/fx-convert.js";

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
  /**
   * Optional DISPLAY-ONLY converted amounts. Present only when the caller asks
   * for ?presentment_currency=XYZ AND a rate is available. NEVER replaces the
   * base-currency amounts above — settlement/charge stays in `currency`.
   */
  presentment?: PresentmentBlock;
}

/**
 * Presentment (display-only) money block.
 *
 * PRESENTMENT ONLY: these are converted *display* values for a storefront to
 * render local prices. The order is still created and charged in the base
 * currency. The base amounts on the parent object are authoritative; this block
 * is purely informational and must never be used for settlement.
 */
export interface PresentmentBlock {
  /** ISO 4217 presentment (display) currency. */
  currency: string;
  /** base→presentment conversion rate used for all amounts below. */
  rate: number;
  subtotal: string;
  shipping_total: string;
  discount_total: string;
  tax_total: string;
  total: string;
}

export interface DiscountLine {
  code: string;
  type: string;
  amount: number;
}

/** The base-currency money fields presentment converts (decimal strings). */
export interface BaseMoney {
  subtotal: string | number;
  shipping_total: string | number;
  discount_total: string | number;
  tax_total: string | number;
  total: string | number;
}

/**
 * Build a DISPLAY-ONLY presentment block converting base-currency money into a
 * target currency, WITHOUT mutating the base amounts.
 *
 * PRESENTMENT ONLY: the returned values are for storefront display. The order is
 * still created and charged in `baseCurrency`. Callers attach this alongside the
 * real amounts and never substitute it for them.
 *
 * Defensive: returns null (caller falls back to base, no conversion) when
 *   - target equals base (nothing to convert), or
 *   - no FX rate is available for base→target.
 *
 * `db` is any `.query()`-capable handle (getReadDb / getPool); the latest USD-
 * base snapshot is read once and the base→target cross-rate derived from it.
 */
export async function buildPresentment(
  db: Parameters<typeof getLatestRates>[0],
  baseCurrency: string,
  presentmentCurrency: string,
  base: BaseMoney
): Promise<PresentmentBlock | null> {
  const target = presentmentCurrency.toUpperCase();
  const from = baseCurrency.toUpperCase();
  if (!target || target === from) return null;

  const latest = await getLatestRates(db);
  const rate = rateFor(latest.rates, from, target, latest.base);
  if (rate === null) return null;

  return {
    currency: target,
    rate,
    subtotal: convertMoney(base.subtotal, rate),
    shipping_total: convertMoney(base.shipping_total, rate),
    discount_total: convertMoney(base.discount_total, rate),
    tax_total: convertMoney(base.tax_total, rate),
    total: convertMoney(base.total, rate),
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface CartLine {
  variant_id: string;
  product_id: string;
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
    product_id: string;
    quantity: number;
    price: string;
    title: string;
    sku: string;
    type: string;
  }>(
    `SELECT cl.variant_id::text, pv.product_id::text, cl.quantity, cl.price::text,
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
    product_id: r.product_id,
    qty: r.quantity,
    price: parseFloat(r.price),
    title: r.title,
    sku: r.sku,
    product_type: r.type,
  }));
}

/** Map checkout cart lines to the discount engine's line shape. */
function toDiscountLines(lines: CartLine[]): DiscountCartLine[] {
  return lines.map((l) => ({
    variant_id: l.variant_id,
    product_id: l.product_id,
    qty: l.qty,
    price: l.price,
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
 * Compute discounts for a checkout (read-only preview — no burn).
 *
 * Delegates to the discounts module's execution engine, which evaluates:
 *   - the explicit discount CODE (if any), and
 *   - all eligible AUTOMATIC discounts for the store (codeless),
 * across every discount type (percentage, fixed_amount, free_shipping,
 * bogo, buy_x_get_y) with stacking/priority semantics.
 *
 * Returns the subtotal discount, the post-discount shipping (free_shipping
 * zeroes it), the discount_lines to persist, and an `error` for a bad code.
 * Automatic discounts never error — they simply don't apply when ineligible.
 *
 * NOTE: this is the PREVIEW path. The authoritative recompute + redemption
 * burn happens inside completeCheckout()'s transaction.
 */
export async function applyDiscount(
  pool: ReturnType<typeof getPool>,
  storeId: string,
  lines: DiscountCartLine[],
  subtotal: number,
  baseShipping: number,
  customerId: string | null,
  code: string
): Promise<{
  discountTotal: number;
  shippingTotal: number;
  discountLines: DiscountLine[];
  error: string | null;
}> {
  const result = await computeDiscounts(pool, {
    storeId,
    lines,
    subtotal,
    shippingTotal: baseShipping,
    customerId,
    code: code || null,
  });

  if (result.error) {
    return { discountTotal: 0, shippingTotal: baseShipping, discountLines: [], error: result.error };
  }

  // Persist a compact discount_lines payload (code + type + amount). The
  // free_shipping flag is implied by type; complete-time recompute re-derives
  // it from the rule, so we only need a faithful display/audit record here.
  const discountLines: DiscountLine[] = result.lines.map((l) => ({
    code: l.code,
    type: l.type,
    amount: l.amount,
  }));

  return {
    discountTotal: result.discountTotal,
    shippingTotal: result.shippingTotal,
    discountLines,
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

  // Shipping (H8: server-side price only) — resolved BEFORE discounts so a
  // free_shipping discount can zero it.
  let baseShipping = 0;
  let shippingRateJson: string | null = null;
  if (body.shipping_rate && typeof body.shipping_rate["id"] === "string" && body.shipping_rate["id"]) {
    baseShipping = await lookupShippingRatePrice(pool, storeId, body.shipping_rate["id"] as string);
    shippingRateJson = JSON.stringify(body.shipping_rate);
  }

  // Discount (code + automatic discounts; free_shipping/BOGO supported).
  const discountCode = (body.discount_code ?? "").toUpperCase().trim();
  const hasDomain = cartHasDomainLines(lines);
  if (discountCode && hasDomain) {
    const e = new Error("discount codes cannot be applied to domain products");
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }
  // Domain carts never receive discounts (codeless ones included).
  const discountResult = hasDomain
    ? { discountTotal: 0, shippingTotal: baseShipping, discountLines: [] as DiscountLine[], error: null as string | null }
    : await applyDiscount(pool, storeId, toDiscountLines(lines), subtotal, baseShipping, customerId, discountCode);
  if (discountResult.error) {
    const e = new Error(discountResult.error);
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }

  const shippingTotal = discountResult.shippingTotal;

  // Tax — computed on the discounted subtotal.
  const { countryCode, provinceCode } = extractAddressCodes(body.shipping_address ?? null);
  const taxResult = await calcTax(pool, storeId, subtotal - discountResult.discountTotal, countryCode, provinceCode);

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
 *
 * When `presentmentCurrency` is supplied (storefront ?presentment_currency=XYZ),
 * a DISPLAY-ONLY `presentment` block is attached with the converted amounts. The
 * base-currency amounts (subtotal/total/etc and `currency`) are LEFT UNCHANGED —
 * settlement/charge always happens in the base currency. The presentment block
 * is omitted when no FX rate is available or the target equals the base.
 */
export async function getCheckout(
  storeId: string,
  checkoutId: string,
  presentmentCurrency?: string
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
  const checkout = rows[0];
  if (!checkout) return null;

  if (presentmentCurrency) {
    const presentment = await buildPresentment(
      pool,
      checkout.currency,
      presentmentCurrency,
      checkout
    );
    // Attach DISPLAY-ONLY converted amounts; base amounts stay authoritative.
    if (presentment) checkout.presentment = presentment;
  }

  return checkout;
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

  // Shipping (H8) — resolved BEFORE discounts so free_shipping can zero it.
  let baseShipping = 0;
  let shippingRateJson: string | null = null;
  if (body.shipping_rate && typeof body.shipping_rate["id"] === "string" && body.shipping_rate["id"]) {
    baseShipping = await lookupShippingRatePrice(pool, storeId, body.shipping_rate["id"] as string);
    shippingRateJson = JSON.stringify(body.shipping_rate);
  }

  // Discount (code + automatic discounts).
  const discountCode = (body.discount_code ?? "").toUpperCase().trim();
  const hasDomain = cartHasDomainLines(lines);
  if (discountCode && hasDomain) {
    const e = new Error("discount codes cannot be applied to domain products");
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }
  const discountResult = hasDomain
    ? { discountTotal: 0, shippingTotal: baseShipping, discountLines: [] as DiscountLine[], error: null as string | null }
    : await applyDiscount(pool, storeId, toDiscountLines(lines), subtotal, baseShipping, customerId, discountCode);
  if (discountResult.error) {
    const e = new Error(discountResult.error);
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }

  const shippingTotal = discountResult.shippingTotal;

  // Tax — on the discounted subtotal.
  const { countryCode, provinceCode } = extractAddressCodes(body.shipping_address ?? null);
  const taxResult = await calcTax(pool, storeId, subtotal - discountResult.discountTotal, countryCode, provinceCode);

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
