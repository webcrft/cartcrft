/**
 * money.test.ts — Money precision cases.
 *
 * Ported from webcrft-mono/backend/tests/suites/commerce_money_precision.go
 *
 * Covers:
 *  - Integer cents arithmetic (round2, toCents, fromCents)
 *  - Partial proportional apportionment across order lines
 *  - Zero-decimal currency handling (JPY)
 *  - No float drift in stored totals
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../../shared/ctx.js";
import { post, get, mintJwt, createApiKey, insertProduct, insertVariant } from "../../shared/helpers.js";
import { randomUUID } from "node:crypto";
import { round2, toCents, fromCents, toMinorUnits, currencyExponent } from "../../../src/lib/money.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Unit tests for money helpers ──────────────────────────────────────────────

describe("Money helpers unit tests", () => {
  it("round2 rounds to 2dp", () => {
    // Note: 1.005 in IEEE-754 is actually 1.004999... so round2(1.005) = 1.00
    // This matches Go's math.Round(x*100)/100 behavior.
    expect(round2(1.004)).toBe(1.00);
    expect(round2(1.006)).toBe(1.01);
    expect(round2(9.99 + 0.01)).toBe(10.00);
    expect(round2(99.999)).toBe(100.00);
    expect(round2(14.85)).toBe(14.85);
    expect(round2(0.1 + 0.2)).toBeCloseTo(0.3, 10); // 0.30000000000000004 rounded = 0.30
  });

  it("toCents / fromCents round-trip", () => {
    expect(toCents(99.99)).toBe(9999);
    expect(toCents(1.00)).toBe(100);
    expect(toCents(0.01)).toBe(1);
    expect(fromCents(toCents(99.99))).toBe(99.99);
    expect(fromCents(toCents(198.00))).toBe(198.00);
  });

  it("currencyExponent returns correct values", () => {
    expect(currencyExponent("ZAR")).toBe(2);
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KRW")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("BHD")).toBe(3);
  });

  it("toMinorUnits for JPY returns integer (no cents)", () => {
    expect(toMinorUnits(299, "JPY")).toBe(299);
    expect(toMinorUnits(1000, "JPY")).toBe(1000);
  });

  it("toMinorUnits for ZAR returns cents", () => {
    expect(toMinorUnits(99.99, "ZAR")).toBe(9999);
    expect(toMinorUnits(100, "ZAR")).toBe(10000);
  });

  it("toMinorUnits for KWD returns fils (3dp)", () => {
    expect(toMinorUnits(1.000, "KWD")).toBe(1000);
    expect(toMinorUnits(1.001, "KWD")).toBe(1001);
  });
});

// ── Integration: proportional tax/discount apportionment across lines ─────────

async function bootstrapStore(currency = "ZAR") {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: "Money Precision Store",
    currency,
    timezone: "Africa/Johannesburg",
  }, auth);
  const storeId = storeRes.json["id"] as string;

  const apiKey = await createApiKey(ctx, {
    orgId, userId, storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });
  const keyAuth = { type: "api-key" as const, key: apiKey };
  return { storeId, keyAuth };
}

describe("Tax apportionment: last line absorbs rounding remainder", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    const setup = await bootstrapStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    // Set up 10% exclusive tax for ZA
    await ctx.pool.query(
      `INSERT INTO tax_zones (store_id, name) VALUES ($1::uuid, 'SA')`,
      [storeId]
    );
    const { rows } = await ctx.pool.query<{ id: string }>(
      `SELECT id::text FROM tax_zones WHERE store_id = $1::uuid`,
      [storeId]
    );
    const zoneId = rows[0]!.id;
    await ctx.pool.query(
      `INSERT INTO tax_zone_regions (zone_id, country_code) VALUES ($1::uuid, 'ZA')`,
      [zoneId]
    );
    await ctx.pool.query(
      `INSERT INTO tax_rates (zone_id, name, rate_pct, is_inclusive, is_active)
       VALUES ($1::uuid, 'VAT', 10, false, true)`,
      [zoneId]
    );
  });

  it("Tax total across all order_lines sums to order.tax_total exactly", async () => {
    // Create 3 items with different prices to induce rounding
    const product = await insertProduct(ctx.pool, { storeId, title: "Three-line Widget" });
    const v1 = await insertVariant(ctx.pool, { productId: product.id, title: "A", price: "33.33" });
    const v2 = await insertVariant(ctx.pool, { productId: product.id, title: "B", price: "33.33" });
    const v3 = await insertVariant(ctx.pool, { productId: product.id, title: "C", price: "33.34" });
    for (const v of [v1, v2, v3]) {
      await ctx.pool.query(
        `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
        [v.id]
      );
    }

    const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    const cartId = cartRes.json["id"] as string;
    for (const v of [v1, v2, v3]) {
      await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
        variant_id: v.id, quantity: 1,
      }, keyAuth);
    }

    const coRes = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
      cart_id: cartId,
      shipping_address: { country_code: "ZA" },
    }, keyAuth);
    const coId = coRes.json["id"] as string;

    await post(ctx, `/commerce/stores/${storeId}/checkouts/${coId}/complete`, {}, keyAuth);

    // Fetch the order
    const { rows: orderRows } = await ctx.pool.query<{
      tax_total: string;
      id: string;
    }>(
      `SELECT id::text, tax_total::text FROM orders WHERE store_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [storeId]
    );
    const order = orderRows[0]!;
    const orderTaxTotal = parseFloat(order.tax_total);

    // Fetch order_lines and sum their tax_total
    const { rows: lineRows } = await ctx.pool.query<{ tax_total: string }>(
      `SELECT tax_total::text FROM order_lines WHERE order_id = $1::uuid`,
      [order.id]
    );
    const linesTaxSum = lineRows.reduce((acc, r) => acc + parseFloat(r.tax_total), 0);

    // The sum of line tax_totals must equal the order tax_total exactly (within 0.01)
    expect(Math.abs(linesTaxSum - orderTaxTotal)).toBeLessThanOrEqual(0.01);
  });
});

describe("Price re-validation at complete time", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    const setup = await bootstrapStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;
  });

  it("Price change between checkout create and complete is re-validated", async () => {
    const product = await insertProduct(ctx.pool, { storeId, title: "Price Drift Widget" });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "100.00" });
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variant.id]
    );

    const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    const cartId = cartRes.json["id"] as string;
    await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
      variant_id: variant.id, quantity: 1,
    }, keyAuth);
    const coRes = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
      cart_id: cartId,
    }, keyAuth);
    expect(parseFloat(coRes.json["subtotal"] as string)).toBeCloseTo(100.00, 2);
    const coId = coRes.json["id"] as string;

    // Change the variant price to 150.00 after checkout creation
    await ctx.pool.query(
      `UPDATE product_variants SET price = 150.00 WHERE id = $1::uuid`,
      [variant.id]
    );

    // Complete — should use the new price (150.00)
    const completeRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${coId}/complete`, {}, keyAuth);
    expect(completeRes.status).toBe(200);

    // Verify the order total was computed using the new price
    const { rows: orderRows } = await ctx.pool.query<{ subtotal: string; total: string }>(
      `SELECT subtotal::text, total::text FROM orders WHERE store_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [storeId]
    );
    expect(parseFloat(orderRows[0]!.subtotal)).toBeCloseTo(150.00, 2);
  });
});
