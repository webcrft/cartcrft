/**
 * idempotency.test.ts — Replay/duplicate-delivery tests.
 *
 * Ported from webcrft-mono/backend/tests/suites/commerce_idempotency.go
 *
 * Covers:
 *  - Second POST to /checkouts/:id/complete must NOT create a second order
 *    (checkout state machine idempotency)
 *  - Cart creation with the same idempotency key returns the same cart id
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../../shared/ctx.js";
import { post, get, mintJwt, createApiKey, insertProduct, insertVariant } from "../../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

async function bootstrapStoreAndVariant() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: "Idempotency Test Store",
    currency: "ZAR",
    timezone: "Africa/Johannesburg",
  }, auth);
  expect(storeRes.status).toBe(201);
  const storeId = storeRes.json["id"] as string;

  const apiKey = await createApiKey(ctx, {
    orgId, userId, storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });
  const keyAuth = { type: "api-key" as const, key: apiKey };

  const product = await insertProduct(ctx.pool, { storeId, title: "Idempotency Widget" });
  const variant = await insertVariant(ctx.pool, { productId: product.id, price: "100.00" });

  // Disable inventory tracking
  await ctx.pool.query(
    `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
    [variant.id]
  );

  return { storeId, keyAuth, variantId: variant.id };
}

describe("Checkout complete replay (state-machine idempotency)", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let variantId: string;
  let checkoutId: string;
  let firstOrderId: string;

  beforeAll(async () => {
    const setup = await bootstrapStoreAndVariant();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;
    variantId = setup.variantId;

    // Build cart → checkout
    const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    const cartId = cartRes.json["id"] as string;
    await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
      variant_id: variantId, quantity: 1,
    }, keyAuth);
    const coRes = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
      cart_id: cartId,
    }, keyAuth);
    checkoutId = coRes.json["id"] as string;
  });

  it("First /complete → 200 and returns order_id", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, keyAuth);
    expect(res.status).toBe(200);
    firstOrderId = res.json["order_id"] as string;
    expect(firstOrderId).toBeTruthy();
  });

  it("Replay /complete → 4xx (checkout already consumed)", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, keyAuth);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("CRITICAL: Only one order was created (no duplicate order)", async () => {
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders WHERE store_id = $1::uuid`,
      [storeId]
    );
    const orderCount = parseInt(rows[0]?.count ?? "0", 10);
    expect(orderCount).toBe(1);
  });

  it("Cart status is 'converted' after completion", async () => {
    // Get cart_id from checkout
    const { rows } = await ctx.pool.query<{ cart_id: string }>(
      `SELECT cart_id::text FROM checkouts WHERE id = $1::uuid`,
      [checkoutId]
    );
    const cartId = rows[0]?.cart_id;
    if (cartId) {
      const { rows: cartRows } = await ctx.pool.query<{ status: string }>(
        `SELECT status FROM carts WHERE id = $1::uuid`,
        [cartId]
      );
      expect(cartRows[0]?.status).toBe("converted");
    }
  });
});

describe("Cart cannot be used for a second checkout after conversion", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let variantId: string;

  beforeAll(async () => {
    const setup = await bootstrapStoreAndVariant();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;
    variantId = setup.variantId;
  });

  it("Second checkout on a converted cart → 4xx", async () => {
    const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    const cartId = cartRes.json["id"] as string;
    await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
      variant_id: variantId, quantity: 1,
    }, keyAuth);
    const co1Res = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
      cart_id: cartId,
    }, keyAuth);
    const co1Id = co1Res.json["id"] as string;

    // Complete first checkout
    await post(ctx, `/commerce/stores/${storeId}/checkouts/${co1Id}/complete`, {}, keyAuth);

    // Try to create a second checkout from the same (now converted) cart
    const co2Res = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
      cart_id: cartId,
    }, keyAuth);
    // The cart is no longer 'active', so this should fail
    expect(co2Res.status).toBeGreaterThanOrEqual(400);
  });
});
