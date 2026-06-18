/**
 * discount-execution.test.ts — Wave 3.1 discount EXECUTION at checkout.
 *
 * Exercises the discount engine wired into checkout create + complete:
 *   - automatic percentage discount applied with NO code entered
 *   - automatic free_shipping zeroing the shipping amount
 *   - buy_x_get_y / bogo reducing the correct (cheapest-unit) amount
 *   - stacking on/off behaviour for automatic discounts
 *   - redemption caps + once-per-customer burn still hold at completion
 *
 * Conventions mirror tests/suites/checkout/checkout.test.ts:
 *   - store via REST, API key for commerce scopes
 *   - product/variant via SQL fixtures
 *   - automatic_discounts / discount_codes seeded via direct SQL
 *   - inventory tracking disabled so completion never blocks on stock
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  createApiKey,
  insertProduct,
  insertVariant,
  mintJwt,
} from "../shared/helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Shared setup ────────────────────────────────────────────────────────────────

interface StoreCtx {
  storeId: string;
  keyAuth: { type: "api-key"; key: string };
  orgId: string;
  userId: string;
}

async function setupStore(): Promise<StoreCtx> {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(
    ctx,
    "/commerce/stores",
    { name: "Discount Exec Store", currency: "ZAR", timezone: "Africa/Johannesburg" },
    auth
  );
  expect(storeRes.status).toBe(201);
  const storeId = (storeRes.json as Record<string, unknown>)["id"] as string;

  const apiKey = await createApiKey(ctx, {
    orgId,
    userId,
    storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });
  return { storeId, keyAuth: { type: "api-key", key: apiKey }, orgId, userId };
}

/** Insert a product + variant at the given price, with inventory tracking off. */
async function makeVariant(storeId: string, price: string, title = "Widget"): Promise<string> {
  const product = await insertProduct(ctx.pool, { storeId, title });
  const variant = await insertVariant(ctx.pool, { productId: product.id, title: "Default", price });
  await ctx.pool.query(
    `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
    [variant.id]
  );
  return variant.id;
}

/** Create a cart with a single line. Returns cartId. */
async function cartWith(storeId: string, keyAuth: StoreCtx["keyAuth"], variantId: string, qty: number): Promise<string> {
  const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
  const cartId = cartRes.json["id"] as string;
  const lineRes = await post(
    ctx,
    `/commerce/stores/${storeId}/carts/${cartId}/lines`,
    { variant_id: variantId, quantity: qty },
    keyAuth
  );
  expect(lineRes.status).toBe(201);
  return cartId;
}

// ── Automatic percentage discount (no code) ─────────────────────────────────────

describe("Automatic percentage discount (no code)", () => {
  let s: StoreCtx;
  let variantId: string;

  beforeAll(async () => {
    s = await setupStore();
    variantId = await makeVariant(s.storeId, "100.00");
    // 10% off everything, no minimum, no code.
    await ctx.pool.query(
      `INSERT INTO automatic_discounts (store_id, title, type, value, is_active, priority)
       VALUES ($1::uuid, 'Auto 10%', 'percentage', 10, true, 10)`,
      [s.storeId]
    );
  });

  it("applies 10% automatically at checkout create with no discount_code", async () => {
    const cartId = await cartWith(s.storeId, s.keyAuth, variantId, 2); // subtotal 200
    const res = await post(ctx, `/commerce/stores/${s.storeId}/checkouts`, { cart_id: cartId }, s.keyAuth);
    expect(res.status).toBe(201);
    expect(parseFloat(res.json["subtotal"] as string)).toBeCloseTo(200, 2);
    expect(parseFloat(res.json["discount_total"] as string)).toBeCloseTo(20, 2);
    expect(parseFloat(res.json["total"] as string)).toBeCloseTo(180, 2);
    const lines = res.json["discount_lines"] as Array<Record<string, unknown>>;
    expect(lines.length).toBe(1);
    expect(lines[0]?.["code"]).toBe(""); // automatic → no code
    expect(lines[0]?.["type"]).toBe("percentage");
  });

  it("persists the automatic discount onto the completed order", async () => {
    const cartId = await cartWith(s.storeId, s.keyAuth, variantId, 1); // subtotal 100
    const coRes = await post(ctx, `/commerce/stores/${s.storeId}/checkouts`, { cart_id: cartId }, s.keyAuth);
    const coId = coRes.json["id"] as string;
    const completeRes = await post(ctx, `/commerce/stores/${s.storeId}/checkouts/${coId}/complete`, {}, s.keyAuth);
    expect(completeRes.status).toBe(200);
    const orderId = completeRes.json["order_id"] as string;

    const { rows } = await ctx.pool.query<{ discount_total: string; total: string }>(
      `SELECT discount_total::text, total::text FROM orders WHERE id = $1::uuid`,
      [orderId]
    );
    expect(parseFloat(rows[0]!.discount_total)).toBeCloseTo(10, 2);
    expect(parseFloat(rows[0]!.total)).toBeCloseTo(90, 2);
  });
});

// ── free_shipping ───────────────────────────────────────────────────────────────

describe("free_shipping discount zeroes shipping", () => {
  let s: StoreCtx;
  let variantId: string;
  let rateId: string;

  beforeAll(async () => {
    s = await setupStore();
    variantId = await makeVariant(s.storeId, "100.00");

    // Shipping zone + active rate priced at 50.
    const { rows: zoneRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO shipping_zones (store_id, name) VALUES ($1::uuid, 'ZA') RETURNING id::text`,
      [s.storeId]
    );
    const zoneId = zoneRows[0]!.id;
    const { rows: rateRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO shipping_rates (zone_id, name, price, is_active)
       VALUES ($1::uuid, 'Standard', 50, true) RETURNING id::text`,
      [zoneId]
    );
    rateId = rateRows[0]!.id;

    await ctx.pool.query(
      `INSERT INTO automatic_discounts (store_id, title, type, is_active, priority)
       VALUES ($1::uuid, 'Free Ship', 'free_shipping', true, 5)`,
      [s.storeId]
    );
  });

  it("zeroes shipping_total when a free_shipping discount applies", async () => {
    const cartId = await cartWith(s.storeId, s.keyAuth, variantId, 1); // subtotal 100
    const res = await post(
      ctx,
      `/commerce/stores/${s.storeId}/checkouts`,
      { cart_id: cartId, shipping_rate: { id: rateId, name: "Standard" } },
      s.keyAuth
    );
    expect(res.status).toBe(201);
    expect(parseFloat(res.json["subtotal"] as string)).toBeCloseTo(100, 2);
    // free_shipping → shipping_total forced to 0, total = subtotal only.
    expect(parseFloat(res.json["shipping_total"] as string)).toBeCloseTo(0, 2);
    expect(parseFloat(res.json["total"] as string)).toBeCloseTo(100, 2);
  });

  it("completing carries the zeroed shipping onto the order", async () => {
    const cartId = await cartWith(s.storeId, s.keyAuth, variantId, 1);
    const coRes = await post(
      ctx,
      `/commerce/stores/${s.storeId}/checkouts`,
      { cart_id: cartId, shipping_rate: { id: rateId, name: "Standard" } },
      s.keyAuth
    );
    const coId = coRes.json["id"] as string;
    const done = await post(ctx, `/commerce/stores/${s.storeId}/checkouts/${coId}/complete`, {}, s.keyAuth);
    expect(done.status).toBe(200);
    const { rows } = await ctx.pool.query<{ shipping_total: string; total: string }>(
      `SELECT shipping_total::text, total::text FROM orders WHERE id = $1::uuid`,
      [done.json["order_id"] as string]
    );
    expect(parseFloat(rows[0]!.shipping_total)).toBeCloseTo(0, 2);
    expect(parseFloat(rows[0]!.total)).toBeCloseTo(100, 2);
  });
});

// ── buy_x_get_y / BOGO ──────────────────────────────────────────────────────────

describe("buy_x_get_y / bogo line-level discount", () => {
  let s: StoreCtx;

  beforeAll(async () => {
    s = await setupStore();
  });

  it("bogo: buy 1 get 1 free discounts the cheapest unit per pair", async () => {
    // Two units at 100 each → 1 pair → cheapest unit (100) is free.
    const variantId = await makeVariant(s.storeId, "100.00", "BOGO Widget");
    await ctx.pool.query(
      `INSERT INTO automatic_discounts (store_id, title, type, is_active, priority)
       VALUES ($1::uuid, 'BOGO', 'bogo', true, 10)`,
      [s.storeId]
    );
    const cartId = await cartWith(s.storeId, s.keyAuth, variantId, 2); // subtotal 200
    const res = await post(ctx, `/commerce/stores/${s.storeId}/checkouts`, { cart_id: cartId }, s.keyAuth);
    expect(res.status).toBe(201);
    expect(parseFloat(res.json["subtotal"] as string)).toBeCloseTo(200, 2);
    expect(parseFloat(res.json["discount_total"] as string)).toBeCloseTo(100, 2);
    expect(parseFloat(res.json["total"] as string)).toBeCloseTo(100, 2);
  });

  it("bogo: 3 units → only 1 complete pair → 1 free unit (not 1.5)", async () => {
    const s2 = await setupStore();
    const variantId = await makeVariant(s2.storeId, "30.00", "BOGO3");
    await ctx.pool.query(
      `INSERT INTO automatic_discounts (store_id, title, type, is_active, priority)
       VALUES ($1::uuid, 'BOGO', 'bogo', true, 10)`,
      [s2.storeId]
    );
    const cartId = await cartWith(s2.storeId, s2.keyAuth, variantId, 3); // subtotal 90
    const res = await post(ctx, `/commerce/stores/${s2.storeId}/checkouts`, { cart_id: cartId }, s2.keyAuth);
    expect(res.status).toBe(201);
    // groupSize = buy(1)+get(1) = 2, units=3 → 1 group → 1 unit free = 30.
    expect(parseFloat(res.json["discount_total"] as string)).toBeCloseTo(30, 2);
    expect(parseFloat(res.json["total"] as string)).toBeCloseTo(60, 2);
  });

  it("buy_x_get_y: buy 2 get 1 @ 50% off cheapest, via metadata", async () => {
    const s3 = await setupStore();
    const variantId = await makeVariant(s3.storeId, "20.00", "BXGY");
    await ctx.pool.query(
      `INSERT INTO automatic_discounts (store_id, title, type, is_active, priority, metadata)
       VALUES ($1::uuid, 'B2G1', 'buy_x_get_y', true, 10,
               '{"buy_quantity":2,"get_quantity":1,"get_discount_pct":50}'::jsonb)`,
      [s3.storeId]
    );
    // 3 units @ 20 → groupSize 3 → 1 group → 1 cheapest unit at 50% off = 10.
    const cartId = await cartWith(s3.storeId, s3.keyAuth, variantId, 3); // subtotal 60
    const res = await post(ctx, `/commerce/stores/${s3.storeId}/checkouts`, { cart_id: cartId }, s3.keyAuth);
    expect(res.status).toBe(201);
    expect(parseFloat(res.json["discount_total"] as string)).toBeCloseTo(10, 2);
    expect(parseFloat(res.json["total"] as string)).toBeCloseTo(50, 2);
  });
});

// ── Stacking on / off ───────────────────────────────────────────────────────────

describe("automatic discount stacking behaviour", () => {
  it("stacking OFF (default): only the single best discount applies", async () => {
    const s = await setupStore();
    const variantId = await makeVariant(s.storeId, "100.00");
    // Two automatic discounts, neither stackable. Higher priority is 10%, but
    // 25% is the larger amount → best-by-value should win.
    await ctx.pool.query(
      `INSERT INTO automatic_discounts (store_id, title, type, value, is_active, priority, allow_stacking)
       VALUES
         ($1::uuid, 'Ten', 'percentage', 10, true, 20, false),
         ($1::uuid, 'TwentyFive', 'percentage', 25, true, 10, false)`,
      [s.storeId]
    );
    const cartId = await cartWith(s.storeId, s.keyAuth, variantId, 1); // subtotal 100
    const res = await post(ctx, `/commerce/stores/${s.storeId}/checkouts`, { cart_id: cartId }, s.keyAuth);
    expect(res.status).toBe(201);
    // Best single discount = 25.
    expect(parseFloat(res.json["discount_total"] as string)).toBeCloseTo(25, 2);
    const lines = res.json["discount_lines"] as Array<Record<string, unknown>>;
    expect(lines.length).toBe(1);
  });

  it("stacking ON: stackable discounts combine in priority order", async () => {
    const s = await setupStore();
    const variantId = await makeVariant(s.storeId, "100.00");
    await ctx.pool.query(
      `INSERT INTO automatic_discounts (store_id, title, type, value, is_active, priority, allow_stacking)
       VALUES
         ($1::uuid, 'Ten', 'percentage', 10, true, 20, true),
         ($1::uuid, 'Five', 'percentage', 5, true, 10, true)`,
      [s.storeId]
    );
    const cartId = await cartWith(s.storeId, s.keyAuth, variantId, 1); // subtotal 100
    const res = await post(ctx, `/commerce/stores/${s.storeId}/checkouts`, { cart_id: cartId }, s.keyAuth);
    expect(res.status).toBe(201);
    // 10 + 5 = 15 (both computed against the same subtotal).
    expect(parseFloat(res.json["discount_total"] as string)).toBeCloseTo(15, 2);
    const lines = res.json["discount_lines"] as Array<Record<string, unknown>>;
    expect(lines.length).toBe(2);
  });
});

// ── Caps + once-per-customer still hold ─────────────────────────────────────────

describe("redemption caps + once-per-customer burn still hold", () => {
  it("explicit code burns uses_count and rejects when exhausted at completion", async () => {
    const s = await setupStore();
    const variantId = await makeVariant(s.storeId, "100.00");
    // max_uses = 1 code.
    await ctx.pool.query(
      `INSERT INTO discount_codes (store_id, code, type, value, is_active, max_uses)
       VALUES ($1::uuid, 'CAP1', 'percentage', 10, true, 1)`,
      [s.storeId]
    );

    // First completion succeeds and burns the single use.
    const cart1 = await cartWith(s.storeId, s.keyAuth, variantId, 1);
    const co1 = await post(
      ctx,
      `/commerce/stores/${s.storeId}/checkouts`,
      { cart_id: cart1, discount_code: "CAP1" },
      s.keyAuth
    );
    expect(co1.status).toBe(201);
    const done1 = await post(ctx, `/commerce/stores/${s.storeId}/checkouts/${co1.json["id"]}/complete`, {}, s.keyAuth);
    expect(done1.status).toBe(200);

    const { rows: after } = await ctx.pool.query<{ uses_count: number }>(
      `SELECT uses_count FROM discount_codes WHERE store_id = $1::uuid AND code = 'CAP1'`,
      [s.storeId]
    );
    expect(after[0]!.uses_count).toBe(1);

    // Second checkout: code now exhausted → checkout create should 422.
    const cart2 = await cartWith(s.storeId, s.keyAuth, variantId, 1);
    const co2 = await post(
      ctx,
      `/commerce/stores/${s.storeId}/checkouts`,
      { cart_id: cart2, discount_code: "CAP1" },
      s.keyAuth
    );
    expect(co2.status).toBe(422);
  });

  it("code exhausted BETWEEN checkout and completion → completion rejects, no order", async () => {
    const s = await setupStore();
    const variantId = await makeVariant(s.storeId, "100.00");
    const { rows: dcRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO discount_codes (store_id, code, type, value, is_active, max_uses)
       VALUES ($1::uuid, 'RACE1', 'percentage', 10, true, 1)
       RETURNING id::text`,
      [s.storeId]
    );

    const cartId = await cartWith(s.storeId, s.keyAuth, variantId, 1);
    const co = await post(
      ctx,
      `/commerce/stores/${s.storeId}/checkouts`,
      { cart_id: cartId, discount_code: "RACE1" },
      s.keyAuth
    );
    expect(co.status).toBe(201);

    // Simulate another order burning the only use before completion.
    await ctx.pool.query(
      `UPDATE discount_codes SET uses_count = 1 WHERE id = $1::uuid`,
      [dcRows[0]!.id]
    );

    const done = await post(ctx, `/commerce/stores/${s.storeId}/checkouts/${co.json["id"]}/complete`, {}, s.keyAuth);
    expect(done.status).toBeGreaterThanOrEqual(400);

    // No order row should have been created for this checkout.
    const { rows: orderRows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders WHERE checkout_id = $1::uuid`,
      [co.json["id"] as string]
    );
    expect(parseInt(orderRows[0]!.count, 10)).toBe(0);
  });

  it("automatic discount with max_uses burns its counter at completion", async () => {
    const s = await setupStore();
    const variantId = await makeVariant(s.storeId, "100.00");
    const { rows: adRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO automatic_discounts (store_id, title, type, value, is_active, priority, max_uses)
       VALUES ($1::uuid, 'AutoCap', 'percentage', 10, true, 10, 5)
       RETURNING id::text`,
      [s.storeId]
    );

    const cartId = await cartWith(s.storeId, s.keyAuth, variantId, 1);
    const co = await post(ctx, `/commerce/stores/${s.storeId}/checkouts`, { cart_id: cartId }, s.keyAuth);
    expect(co.status).toBe(201);
    const done = await post(ctx, `/commerce/stores/${s.storeId}/checkouts/${co.json["id"]}/complete`, {}, s.keyAuth);
    expect(done.status).toBe(200);

    const { rows } = await ctx.pool.query<{ uses_count: number }>(
      `SELECT uses_count FROM automatic_discounts WHERE id = $1::uuid`,
      [adRows[0]!.id]
    );
    expect(rows[0]!.uses_count).toBe(1);
  });
});
