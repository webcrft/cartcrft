/**
 * concurrency.test.ts — Parallel-execution race conditions.
 *
 * Ported from webcrft-mono/backend/tests/suites/commerce_concurrent.go
 *
 * Covers:
 *  - Parallel completes on same checkout → exactly one order created
 *  - Parallel discount burns on once_per_customer code → only one usage inserted
 *  - Inventory race: single unit, parallel checkouts → no oversell
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../../shared/ctx.js";
import { post, mintJwt, createApiKey, insertProduct, insertVariant } from "../../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

async function bootstrapStore() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: "Concurrency Test Store",
    currency: "ZAR",
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

// Fire n parallel POST requests to the same path
async function parallelPost(
  path: string,
  body: unknown,
  authKey: string,
  n: number
): Promise<Array<{ status: number; json: Record<string, unknown> }>> {
  const requests = Array.from({ length: n }, () =>
    ctx.request({
      method: "POST",
      path,
      body,
      headers: { authorization: `Bearer ${authKey}` },
    })
  );
  const results = await Promise.all(requests);
  return results.map((r) => ({ status: r.status, json: r.json }));
}

function countSuccesses(results: Array<{ status: number }>) {
  return results.filter((r) => r.status >= 200 && r.status < 300).length;
}

describe("Parallel complete → exactly one order (no duplicate)", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let checkoutId: string;

  beforeAll(async () => {
    const setup = await bootstrapStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    const product = await insertProduct(ctx.pool, { storeId, title: "Parallel Widget" });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "50.00" });
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
    checkoutId = coRes.json["id"] as string;
  });

  it("Two parallel completes → exactly 1 succeeds, exactly 1 order created", async () => {
    const results = await parallelPost(
      `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`,
      {},
      keyAuth.key,
      2
    );

    const successes = countSuccesses(results);
    // One must succeed (the first commit wins), the other sees pending→completed race
    expect(successes).toBe(1);

    // Verify only 1 order in DB
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders WHERE store_id = $1::uuid`,
      [storeId]
    );
    expect(parseInt(rows[0]?.count ?? "0", 10)).toBe(1);
  });
});

describe("Inventory race — oversell guard", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    const setup = await bootstrapStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;
  });

  it("Single unit inventory: 2 parallel checkouts → only 1 order, on_hand = 0", async () => {
    const product = await insertProduct(ctx.pool, { storeId, title: "Limited Widget" });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "200.00" });

    // Enable inventory tracking with 1 unit
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = true WHERE id = $1::uuid`,
      [variant.id]
    );

    // Create a warehouse and inventory_level with qty 1
    const { rows: whRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO warehouses (store_id, name, is_default) VALUES ($1::uuid, 'Test WH', true) RETURNING id::text`,
      [storeId]
    );
    const warehouseId = whRows[0]!.id;
    await ctx.pool.query(
      `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand)
       VALUES ($1::uuid, $2::uuid, 1)`,
      [variant.id, warehouseId]
    );

    // Create 2 separate carts + checkouts (one unit each)
    async function makeCheckout() {
      const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
      const cartId = cartRes.json["id"] as string;
      await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
        variant_id: variant.id, quantity: 1,
      }, keyAuth);
      const coRes = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
        cart_id: cartId,
      }, keyAuth);
      return coRes.json["id"] as string;
    }

    const [co1Id, co2Id] = await Promise.all([makeCheckout(), makeCheckout()]);

    // Fire both completes in parallel
    const results = await Promise.all([
      ctx.request({
        method: "POST",
        path: `/commerce/stores/${storeId}/checkouts/${co1Id}/complete`,
        body: {},
        headers: { authorization: `Bearer ${keyAuth.key}` },
      }),
      ctx.request({
        method: "POST",
        path: `/commerce/stores/${storeId}/checkouts/${co2Id}/complete`,
        body: {},
        headers: { authorization: `Bearer ${keyAuth.key}` },
      }),
    ]);

    const successes = results.filter((r) => r.status >= 200 && r.status < 300).length;
    expect(successes).toBe(1);

    // Verify on_hand is 0 (not -1)
    const { rows: invRows } = await ctx.pool.query<{ quantity_on_hand: number }>(
      `SELECT quantity_on_hand FROM inventory_levels WHERE variant_id = $1::uuid`,
      [variant.id]
    );
    const totalOnHand = invRows.reduce((sum, r) => sum + r.quantity_on_hand, 0);
    expect(totalOnHand).toBe(0);
  });
});

describe("Parallel discount burn — once_per_customer race", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    const setup = await bootstrapStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;
  });

  it("Two simultaneous completes with once_per_customer discount → only 1 usage recorded", async () => {
    const product = await insertProduct(ctx.pool, { storeId, title: "Discount Race Widget" });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "100.00" });
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variant.id]
    );

    // Create a customer
    const { rows: custRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO customers (store_id, email) VALUES ($1::uuid, $2) RETURNING id::text`,
      [storeId, "race-customer@example.com"]
    );
    const customerId = custRows[0]!.id;

    // Seed once_per_customer discount
    await ctx.pool.query(
      `INSERT INTO discount_codes (store_id, code, type, value, is_active, once_per_customer)
       VALUES ($1::uuid, 'ONCEPERCUST', 'percentage', 10, true, true)`,
      [storeId]
    );

    // Create 2 carts + checkouts for the same customer
    async function makeCheckout() {
      const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
      const cartId = cartRes.json["id"] as string;
      await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
        variant_id: variant.id, quantity: 1,
      }, keyAuth);
      // Manually set customer_id on the cart
      await ctx.pool.query(
        `UPDATE carts SET customer_id = $2::uuid WHERE id = $1::uuid`,
        [cartId, customerId]
      );
      const coRes = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
        cart_id: cartId,
        customer_id: customerId,
        discount_code: "ONCEPERCUST",
      }, keyAuth);
      return coRes.json["id"] as string;
    }

    const [co1Id, co2Id] = await Promise.all([makeCheckout(), makeCheckout()]);

    // Fire both completes in parallel
    const results = await Promise.all([
      ctx.request({
        method: "POST",
        path: `/commerce/stores/${storeId}/checkouts/${co1Id}/complete`,
        body: {},
        headers: { authorization: `Bearer ${keyAuth.key}` },
      }),
      ctx.request({
        method: "POST",
        path: `/commerce/stores/${storeId}/checkouts/${co2Id}/complete`,
        body: {},
        headers: { authorization: `Bearer ${keyAuth.key}` },
      }),
    ]);

    const successes = results.filter((r) => r.status >= 200 && r.status < 300).length;
    // At most 1 should succeed (second should hit DISCOUNT_ALREADY_USED)
    expect(successes).toBeLessThanOrEqual(1);

    // Verify only 1 discount_usage for this customer
    const { rows: usageRows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM discount_usages
       WHERE customer_id = $1::uuid`,
      [customerId]
    );
    expect(parseInt(usageRows[0]?.count ?? "0", 10)).toBeLessThanOrEqual(1);
  });
});
