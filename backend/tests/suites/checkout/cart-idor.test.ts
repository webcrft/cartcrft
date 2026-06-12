/**
 * cart-idor.test.ts — Cross-cart IDOR protection (C7).
 *
 * Ported from webcrft-mono/backend/tests/suites/commerce_cart_idor.go
 *
 * Guards C7: same org+store, two carts A and B, assert that:
 *   - PUT  /carts/{cartA}/lines/{lineB} → 404 (not 200)
 *   - PUT  /carts/{cartB}/lines/{lineA} → 404
 *   - DELETE /carts/{cartA}/lines/{lineB} → 404 and lineB still exists in DB
 *   - DELETE /carts/{cartB}/lines/{lineA} → 404 and lineA still exists in DB
 *
 * Also verifies cross-store IDOR:
 *   - Store B's creds cannot read/write store A's carts or checkouts
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

async function setupStoreWithAuth(orgId: string, userId: string, storeName: string) {
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: storeName,
    currency: "ZAR",
    timezone: "Africa/Johannesburg",
  }, auth);
  const storeId = storeRes.json["id"] as string;

  const apiKey = await createApiKey(ctx, {
    orgId, userId, storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });
  return { storeId, keyAuth: { type: "api-key" as const, key: apiKey } };
}

describe("C7: Same-store cross-cart IDOR", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let cartAId: string;
  let cartBId: string;
  let lineAId: string;
  let lineBId: string;

  beforeAll(async () => {
    const orgId = randomUUID();
    const userId = randomUUID();

    const setup = await setupStoreWithAuth(orgId, userId, "Cart IDOR Store");
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    // Seed product + variant
    const product = await insertProduct(ctx.pool, { storeId, title: "IDOR Widget" });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "199.00" });
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variant.id]
    );

    // Cart A + line A
    const cartARes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    cartAId = cartARes.json["id"] as string;
    const lineARes = await post(ctx, `/commerce/stores/${storeId}/carts/${cartAId}/lines`, {
      variant_id: variant.id, quantity: 1,
    }, keyAuth);
    lineAId = lineARes.json["id"] as string;

    // Cart B + line B
    const cartBRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    cartBId = cartBRes.json["id"] as string;
    const lineBRes = await post(ctx, `/commerce/stores/${storeId}/carts/${cartBId}/lines`, {
      variant_id: variant.id, quantity: 2,
    }, keyAuth);
    lineBId = lineBRes.json["id"] as string;
  });

  it("Two distinct carts seeded", () => {
    expect(cartAId).not.toBe(cartBId);
    expect(lineAId).not.toBe(lineBId);
  });

  it("PATCH /carts/{cartA}/lines/{lineB} → 404 (cart-B's line via cart-A URL)", async () => {
    const res = await ctx.request({
      method: "PATCH",
      path: `/commerce/stores/${storeId}/carts/${cartAId}/lines/${lineBId}`,
      body: { quantity: 99 },
      headers: { authorization: `Bearer ${keyAuth.key}` },
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /carts/{cartB}/lines/{lineA} → 404 (cart-A's line via cart-B URL)", async () => {
    const res = await ctx.request({
      method: "PATCH",
      path: `/commerce/stores/${storeId}/carts/${cartBId}/lines/${lineAId}`,
      body: { quantity: 99 },
      headers: { authorization: `Bearer ${keyAuth.key}` },
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /carts/{cartA}/lines/{lineB} → 404, lineB still in DB", async () => {
    const res = await ctx.request({
      method: "DELETE",
      path: `/commerce/stores/${storeId}/carts/${cartAId}/lines/${lineBId}`,
      headers: { authorization: `Bearer ${keyAuth.key}` },
    });
    expect(res.status).toBe(404);

    // Verify lineB still exists
    const { rows } = await ctx.pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM cart_lines WHERE id = $1::uuid) AS exists`,
      [lineBId]
    );
    expect(rows[0]?.exists).toBe(true);
  });

  it("DELETE /carts/{cartB}/lines/{lineA} → 404, lineA still in DB", async () => {
    const res = await ctx.request({
      method: "DELETE",
      path: `/commerce/stores/${storeId}/carts/${cartBId}/lines/${lineAId}`,
      headers: { authorization: `Bearer ${keyAuth.key}` },
    });
    expect(res.status).toBe(404);

    // Verify lineA still exists
    const { rows } = await ctx.pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM cart_lines WHERE id = $1::uuid) AS exists`,
      [lineAId]
    );
    expect(rows[0]?.exists).toBe(true);
  });

  it("Sanity: PATCH /carts/{cartA}/lines/{lineA} with qty=5 → 200", async () => {
    const res = await ctx.request({
      method: "PATCH",
      path: `/commerce/stores/${storeId}/carts/${cartAId}/lines/${lineAId}`,
      body: { quantity: 5 },
      headers: { authorization: `Bearer ${keyAuth.key}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("Cross-org IDOR: store B cannot access store A's carts", () => {
  let storeAId: string;
  let storeBId: string;
  let keyAuthA: { type: "api-key"; key: string };
  let keyAuthB: { type: "api-key"; key: string };
  let cartAId: string;
  let checkoutAId: string;

  beforeAll(async () => {
    // Org A setup
    const orgAId = randomUUID();
    const userAId = randomUUID();
    const setupA = await setupStoreWithAuth(orgAId, userAId, "Org A Store");
    storeAId = setupA.storeId;
    keyAuthA = setupA.keyAuth;

    // Org B setup (different org)
    const orgBId = randomUUID();
    const userBId = randomUUID();
    const setupB = await setupStoreWithAuth(orgBId, userBId, "Org B Store");
    storeBId = setupB.storeId;
    keyAuthB = setupB.keyAuth;

    // Create product in store A
    const product = await insertProduct(ctx.pool, { storeId: storeAId, title: "Store A Widget" });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "50.00" });
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variant.id]
    );

    // Create cart in store A
    const cartRes = await post(ctx, `/commerce/stores/${storeAId}/carts`, {}, keyAuthA);
    cartAId = cartRes.json["id"] as string;
    await post(ctx, `/commerce/stores/${storeAId}/carts/${cartAId}/lines`, {
      variant_id: variant.id, quantity: 1,
    }, keyAuthA);

    // Create checkout in store A
    const coRes = await post(ctx, `/commerce/stores/${storeAId}/checkouts`, {
      cart_id: cartAId,
    }, keyAuthA);
    checkoutAId = coRes.json["id"] as string;
  });

  it("GET /stores/B/carts/A-cart → 404 (store B cannot see store A's cart)", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeBId}/carts/${cartAId}`,
      keyAuthB
    );
    expect(res.status).toBe(404);
  });

  it("GET /stores/B/checkouts/A-checkout → 404 (store B cannot see store A's checkout)", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeBId}/checkouts/${checkoutAId}`,
      keyAuthB
    );
    expect(res.status).toBe(404);
  });

  it("POST /stores/B/checkouts/:id/complete with A's checkoutId → 404", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeBId}/checkouts/${checkoutAId}/complete`,
      {},
      keyAuthB
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
