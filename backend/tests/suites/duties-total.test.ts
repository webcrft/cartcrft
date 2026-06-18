/**
 * duties-total.test.ts — Import duties folded into the LIVE order total (Wave-24).
 *
 * Wires lib/tax.ts calcDuties into the actual checkout total (checkout/service.ts
 * createCheckout + updateCheckout) and persists it on the order at completion
 * (checkout/complete.ts). Duties are an import / landed-cost charge that engages
 * ONLY when the destination country differs from the store origin AND a duty
 * rate exists — otherwise duties_total = 0 and the total is byte-identical to the
 * pre-change formula (total = subtotal − discount + shipping + tax).
 *
 * Covers:
 *  1. CROSS-BORDER: store origin ZA, duty rate to US → checkout duties_total > 0,
 *     total = subtotal − discount + shipping + tax + duties; complete persists
 *     orders.duties_total and the order total includes it.
 *  2. DOMESTIC (ship to origin) → duties_total = 0, total unchanged.
 *  3. NO DUTY RATES for destination → duties_total = 0, total unchanged.
 *  4. updateCheckout recomputes duties when the shipping address changes.
 *
 * DB setup mirrors duties.test.ts (insert duty_rates via the test pool),
 * order-edit-tax.test.ts (REST tax zones/rates), and checkout/checkout.test.ts
 * (REST cart → checkout → complete).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  put,
  mintJwt,
  insertProduct,
  insertVariant,
} from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

async function authFor(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

/** Create a store via REST (membership/RLS-friendly) and set its origin country. */
async function createStore(
  auth: { type: "bearer"; token: string },
  originCountry: string
): Promise<string> {
  const name = `Duties Total Store ${randomUUID()}`;
  const res = await post(ctx, "/commerce/stores", { name, currency: "USD" }, auth);
  if (res.status !== 201) {
    throw new Error(`createStore: expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  const storeId = res.json["id"] as string;
  await ctx.pool.query(`UPDATE stores SET country_code = $2 WHERE id = $1::uuid`, [
    storeId,
    originCountry,
  ]);
  return storeId;
}

/** Insert a product + variant (no inventory tracking) and return the variant id. */
async function insertSimpleVariant(storeId: string, price: string): Promise<string> {
  const product = await insertProduct(ctx.pool, { storeId, title: "Duty Widget" });
  const variant = await insertVariant(ctx.pool, { productId: product.id, title: "Default", price });
  await ctx.pool.query(`UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`, [
    variant.id,
  ]);
  return variant.id;
}

/** Seed a duty_rates row directly (mirrors duties.test.ts). */
async function insertDuty(
  storeId: string,
  data: { destination_country: string; rate_pct: number; de_minimis_value?: number | null }
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO duty_rates (store_id, destination_country, rate_pct, de_minimis_value, is_active)
     VALUES ($1::uuid, $2, $3, $4, true)`,
    [storeId, data.destination_country, data.rate_pct, data.de_minimis_value ?? null]
  );
}

/** Seed a national exclusive tax rate via REST (mirrors order-edit-tax.test.ts). */
async function seedTaxRate(
  storeId: string,
  auth: { type: "bearer"; token: string },
  countryCode: string,
  ratePct: number
): Promise<void> {
  const zRes = await post(
    ctx,
    `/commerce/stores/${storeId}/tax-zones`,
    { name: `${countryCode} National`, regions: [{ country_code: countryCode }] },
    auth
  );
  if (zRes.status !== 201) throw new Error(`seedTaxRate zone: ${zRes.status}: ${JSON.stringify(zRes.body)}`);
  const zoneId = zRes.json["id"] as string;
  const rRes = await post(
    ctx,
    `/commerce/stores/${storeId}/tax-zones/${zoneId}/rates`,
    { name: `${countryCode} VAT`, rate_pct: ratePct, is_inclusive: false, is_active: true },
    auth
  );
  if (rRes.status !== 201) throw new Error(`seedTaxRate rate: ${rRes.status}: ${JSON.stringify(rRes.body)}`);
}

/** Create a cart with one line (qty) for the given variant. Returns cart id. */
async function createCart(
  storeId: string,
  auth: { type: "bearer"; token: string },
  variantId: string,
  qty: number
): Promise<string> {
  const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, auth);
  if (cartRes.status !== 201) throw new Error(`createCart: ${cartRes.status}: ${JSON.stringify(cartRes.body)}`);
  const cartId = cartRes.json["id"] as string;
  const lineRes = await post(
    ctx,
    `/commerce/stores/${storeId}/carts/${cartId}/lines`,
    { variant_id: variantId, quantity: qty },
    auth
  );
  if (lineRes.status !== 201) throw new Error(`addLine: ${lineRes.status}: ${JSON.stringify(lineRes.body)}`);
  return cartId;
}

/** Read orders.duties_total + total directly (orders REST view doesn't expose duties_total). */
async function readOrderTotals(orderId: string): Promise<{ duties_total: string; total: string }> {
  const { rows } = await ctx.pool.query<{ duties_total: string; total: string }>(
    `SELECT duties_total::text, total::text FROM orders WHERE id = $1::uuid`,
    [orderId]
  );
  return rows[0]!;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Duties folded into the live order total", () => {
  const orgId = randomUUID();
  const userId = randomUUID();
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
  });

  it("CROSS-BORDER: duties are added to the checkout total and persisted on the order", async () => {
    // Store origin ZA; sells into US with a 10% duty + ZA 15% tax (won't match US).
    const storeId = await createStore(auth, "ZA");
    await insertDuty(storeId, { destination_country: "US", rate_pct: 10 });
    const variantId = await insertSimpleVariant(storeId, "100.00");
    const cartId = await createCart(storeId, auth, variantId, 1);

    // Checkout shipping to US: subtotal 100, no discount, no shipping, no US tax.
    const coRes = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts`,
      { cart_id: cartId, email: "buyer@example.com", shipping_address: { country_code: "US" } },
      auth
    );
    expect(coRes.status).toBe(201);
    const checkoutId = coRes.json["id"] as string;
    expect(parseFloat(coRes.json["subtotal"] as string)).toBeCloseTo(100, 2);
    expect(parseFloat(coRes.json["duties_total"] as string)).toBeCloseTo(10, 2);
    // total = subtotal − discount + shipping + tax + duties = 100 + 10 = 110.
    expect(parseFloat(coRes.json["total"] as string)).toBeCloseTo(110, 2);

    // Complete → order persists duties_total and includes it in total.
    const compRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, auth);
    expect(compRes.status).toBe(200);
    const orderId = compRes.json["order_id"] as string;
    const order = await readOrderTotals(orderId);
    expect(parseFloat(order.duties_total)).toBeCloseTo(10, 2);
    expect(parseFloat(order.total)).toBeCloseTo(110, 2);
  });

  it("CROSS-BORDER with tax: total = subtotal − discount + shipping + tax + duties", async () => {
    // Store origin ZA; ship to US with 10% duty; seed a US tax rate of 5% too.
    const storeId = await createStore(auth, "ZA");
    await insertDuty(storeId, { destination_country: "US", rate_pct: 10 });
    await seedTaxRate(storeId, auth, "US", 5);
    const variantId = await insertSimpleVariant(storeId, "100.00");
    const cartId = await createCart(storeId, auth, variantId, 2); // subtotal 200

    const coRes = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts`,
      { cart_id: cartId, shipping_address: { country_code: "US", province_code: "" } },
      auth
    );
    expect(coRes.status).toBe(201);
    const checkoutId = coRes.json["id"] as string;
    // subtotal 200, tax 5% = 10, duties 10% = 20 → total 230.
    expect(parseFloat(coRes.json["subtotal"] as string)).toBeCloseTo(200, 2);
    expect(parseFloat(coRes.json["tax_total"] as string)).toBeCloseTo(10, 2);
    expect(parseFloat(coRes.json["duties_total"] as string)).toBeCloseTo(20, 2);
    expect(parseFloat(coRes.json["total"] as string)).toBeCloseTo(230, 2);

    const compRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, auth);
    expect(compRes.status).toBe(200);
    const order = await readOrderTotals(compRes.json["order_id"] as string);
    expect(parseFloat(order.duties_total)).toBeCloseTo(20, 2);
    expect(parseFloat(order.total)).toBeCloseTo(230, 2);
  });

  it("DOMESTIC (ship to origin): duties_total = 0 and total is unchanged", async () => {
    // Store origin ZA; even with a US duty rate present, shipping to ZA → no duty.
    const storeId = await createStore(auth, "ZA");
    await insertDuty(storeId, { destination_country: "US", rate_pct: 10 });
    const variantId = await insertSimpleVariant(storeId, "100.00");
    const cartId = await createCart(storeId, auth, variantId, 1);

    const coRes = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts`,
      { cart_id: cartId, shipping_address: { country_code: "ZA" } },
      auth
    );
    expect(coRes.status).toBe(201);
    const checkoutId = coRes.json["id"] as string;
    expect(parseFloat(coRes.json["duties_total"] as string)).toBe(0);
    // total = subtotal (100) − 0 + 0 + 0 + 0 = 100 (pre-change formula).
    expect(parseFloat(coRes.json["total"] as string)).toBeCloseTo(100, 2);

    const compRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, auth);
    expect(compRes.status).toBe(200);
    const order = await readOrderTotals(compRes.json["order_id"] as string);
    expect(parseFloat(order.duties_total)).toBe(0);
    expect(parseFloat(order.total)).toBeCloseTo(100, 2);
  });

  it("NO DUTY RATES for destination: duties_total = 0, total unchanged (regression guard)", async () => {
    // Cross-border (ZA → DE) but no DE duty rate configured → duties stay 0.
    const storeId = await createStore(auth, "ZA");
    await insertDuty(storeId, { destination_country: "US", rate_pct: 10 }); // unrelated dest
    const variantId = await insertSimpleVariant(storeId, "50.00");
    const cartId = await createCart(storeId, auth, variantId, 1);

    const coRes = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts`,
      { cart_id: cartId, shipping_address: { country_code: "DE" } },
      auth
    );
    expect(coRes.status).toBe(201);
    expect(parseFloat(coRes.json["duties_total"] as string)).toBe(0);
    expect(parseFloat(coRes.json["total"] as string)).toBeCloseTo(50, 2);
  });

  it("updateCheckout recomputes duties when the shipping address changes", async () => {
    // Start domestic (ZA) → no duty; update to ship to US → duty engages.
    const storeId = await createStore(auth, "ZA");
    await insertDuty(storeId, { destination_country: "US", rate_pct: 10 });
    const variantId = await insertSimpleVariant(storeId, "100.00");
    const cartId = await createCart(storeId, auth, variantId, 1);

    const coRes = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts`,
      { cart_id: cartId, shipping_address: { country_code: "ZA" } },
      auth
    );
    expect(coRes.status).toBe(201);
    const checkoutId = coRes.json["id"] as string;
    expect(parseFloat(coRes.json["duties_total"] as string)).toBe(0);

    const upRes = await put(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}`,
      { shipping_address: { country_code: "US" } },
      auth
    );
    expect(upRes.status).toBe(200);
    expect(parseFloat(upRes.json["duties_total"] as string)).toBeCloseTo(10, 2);
    expect(parseFloat(upRes.json["total"] as string)).toBeCloseTo(110, 2);
  });
});
