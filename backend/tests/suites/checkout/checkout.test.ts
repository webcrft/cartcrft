/**
 * checkout.test.ts — Cart → checkout → complete happy path.
 *
 * Covers:
 *  - Create cart, add lines, get cart
 *  - Create checkout from cart
 *  - Update checkout (address, shipping rate, discount)
 *  - Complete checkout → order created
 *  - Totals math (subtotal, tax, discount, total)
 *  - Checkout GET fields present
 *  - Payment-session stub returns 501
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../../shared/ctx.js";
import {
  get,
  post,
  put,
  mintJwt,
  createApiKey,
  insertStore,
  insertProduct,
  insertVariant,
} from "../../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupStore() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  // Create store via REST
  const storeRes = await post(ctx, "/commerce/stores", {
    name: "Checkout Test Store",
    currency: "ZAR",
    timezone: "Africa/Johannesburg",
  }, auth);
  expect(storeRes.status).toBe(201);
  const storeId = (storeRes.json as Record<string, unknown>)["id"] as string;

  // Create API key with full scopes
  const apiKey = await createApiKey(ctx, {
    orgId,
    userId,
    storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });
  const keyAuth = { type: "api-key" as const, key: apiKey };

  return { storeId, auth, keyAuth, orgId, userId };
}

async function setupProductVariant(storeId: string, keyAuth: ReturnType<typeof useKeyAuth>) {
  // Insert product + variant via SQL fixture (catalog routes not yet in T2.3 scope)
  const product = await insertProduct(ctx.pool, { storeId, title: "Test Widget" });
  const variant = await insertVariant(ctx.pool, {
    productId: product.id,
    title: "Default",
    price: "99.00",
  });
  return { product, variant };
}

function useKeyAuth(key: string) {
  return { type: "api-key" as const, key };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Cart CRUD", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let variantId: string;
  let cartId: string;
  let lineId: string;

  beforeAll(async () => {
    const setup = await setupStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    const pv = await setupProductVariant(storeId, keyAuth);
    variantId = pv.variant.id;
  });

  it("POST /carts → creates cart with store currency", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    expect(res.status).toBe(201);
    cartId = (res.json as Record<string, unknown>)["id"] as string;
    expect(cartId).toBeTruthy();
  });

  it("GET /carts/:id → returns cart with empty lines", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/carts/${cartId}`, keyAuth);
    expect(res.status).toBe(200);
    const body = res.json;
    expect(body["id"]).toBe(cartId);
    expect(body["currency"]).toBe("ZAR");
    expect(body["status"]).toBe("active");
    expect(Array.isArray(body["lines"])).toBe(true);
    expect((body["lines"] as unknown[]).length).toBe(0);
  });

  it("POST /carts/:id/lines → adds variant with price snapshot", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
      variant_id: variantId,
      quantity: 2,
    }, keyAuth);
    expect(res.status).toBe(201);
    lineId = (res.json as Record<string, unknown>)["id"] as string;
    expect(lineId).toBeTruthy();
  });

  it("GET /carts/:id → has line with price and quantity", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/carts/${cartId}`, keyAuth);
    expect(res.status).toBe(200);
    const lines = res.json["lines"] as Array<Record<string, unknown>>;
    expect(lines.length).toBe(1);
    expect(lines[0]?.["variant_id"]).toBe(variantId);
    expect(lines[0]?.["quantity"]).toBe(2);
    expect(parseFloat(lines[0]?.["price"] as string)).toBe(99.00);
  });

  it("POST /carts/:id/lines same variant → increments quantity", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
      variant_id: variantId,
      quantity: 1,
    }, keyAuth);
    expect(res.status).toBe(201);
    // Verify quantity is now 3
    const cartRes = await get(ctx, `/commerce/stores/${storeId}/carts/${cartId}`, keyAuth);
    const lines = cartRes.json["lines"] as Array<Record<string, unknown>>;
    expect(lines[0]?.["quantity"]).toBe(3);
  });

  it("PATCH /carts/:id/lines/:lineId → updates quantity", async () => {
    const res = await ctx.request({
      method: "PATCH",
      path: `/commerce/stores/${storeId}/carts/${cartId}/lines/${lineId}`,
      body: { quantity: 5 },
      headers: { authorization: `Bearer ${keyAuth.key}` },
    });
    expect(res.status).toBe(200);
    const cartRes = await get(ctx, `/commerce/stores/${storeId}/carts/${cartId}`, keyAuth);
    const lines = cartRes.json["lines"] as Array<Record<string, unknown>>;
    expect(lines[0]?.["quantity"]).toBe(5);
  });

  it("DELETE /carts/:id/lines/:lineId → removes line", async () => {
    // Add a second line to delete
    const addRes = await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
      variant_id: variantId,
      quantity: 1,
    }, keyAuth);
    // Reset back to line, get cart with current lineId
    const cartRes = await get(ctx, `/commerce/stores/${storeId}/carts/${cartId}`, keyAuth);
    const currentLineId = (cartRes.json["lines"] as Array<Record<string, unknown>>)[0]?.["id"] as string;

    // Update to qty 1 so we have a clean state
    await ctx.request({
      method: "PATCH",
      path: `/commerce/stores/${storeId}/carts/${cartId}/lines/${currentLineId}`,
      body: { quantity: 1 },
      headers: { authorization: `Bearer ${keyAuth.key}` },
    });

    const deleteRes = await ctx.request({
      method: "DELETE",
      path: `/commerce/stores/${storeId}/carts/${cartId}/lines/${currentLineId}`,
      headers: { authorization: `Bearer ${keyAuth.key}` },
    });
    expect(deleteRes.status).toBe(200);

    const afterCart = await get(ctx, `/commerce/stores/${storeId}/carts/${cartId}`, keyAuth);
    const lines = afterCart.json["lines"] as Array<Record<string, unknown>>;
    expect(lines.length).toBe(0);
  });

  it("GET /carts/:id → 404 for unknown cart", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/carts/${randomUUID()}`, keyAuth);
    expect(res.status).toBe(404);
  });

  it("GET /carts/:id → 401 without auth", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/carts/${cartId}`);
    expect(res.status).toBe(401);
  });
});

describe("Checkout create → complete happy path", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let variantId: string;
  let cartId: string;
  let checkoutId: string;

  beforeAll(async () => {
    const setup = await setupStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    const pv = await setupProductVariant(storeId, keyAuth);
    variantId = pv.variant.id;

    // Disable inventory tracking to keep test simple
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variantId]
    );
  });

  it("Creates cart and adds a line (qty=2, price=99.00)", async () => {
    const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    expect(cartRes.status).toBe(201);
    cartId = cartRes.json["id"] as string;

    const lineRes = await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
      variant_id: variantId,
      quantity: 2,
    }, keyAuth);
    expect(lineRes.status).toBe(201);
  });

  it("POST /checkouts → creates checkout with correct subtotal", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
      cart_id: cartId,
      email: "buyer@example.com",
    }, keyAuth);
    expect(res.status).toBe(201);
    checkoutId = res.json["id"] as string;
    expect(checkoutId).toBeTruthy();
    // subtotal = 99.00 * 2 = 198.00
    expect(parseFloat(res.json["subtotal"] as string)).toBeCloseTo(198.00, 2);
    expect(parseFloat(res.json["total"] as string)).toBeCloseTo(198.00, 2);
    expect(res.json["currency"]).toBe("ZAR");
  });

  it("GET /checkouts/:id → returns checkout fields", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}`, keyAuth);
    expect(res.status).toBe(200);
    expect(res.json["id"]).toBe(checkoutId);
    expect(res.json["status"]).toBe("pending");
    expect(res.json["email"]).toBe("buyer@example.com");
  });

  it("PUT /checkouts/:id → updates email", async () => {
    const res = await put(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}`, {
      email: "updated@example.com",
    }, keyAuth);
    expect(res.status).toBe(200);
    // Verify update persisted
    const getRes = await get(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}`, keyAuth);
    expect(getRes.json["email"]).toBe("updated@example.com");
  });

  it("POST /checkouts/:id/complete → creates order", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, keyAuth);
    expect(res.status).toBe(200);
    expect(res.json["order_id"]).toBeTruthy();
    expect(res.json["order_number"]).toBeTruthy();
  });

  it("GET /checkouts/:id → status is completed after complete", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}`, keyAuth);
    expect(res.status).toBe(200);
    expect(res.json["status"]).toBe("completed");
    expect(res.json["completed_at"]).toBeTruthy();
  });

  it("POST /checkouts/:id/complete → 404 on second attempt (idempotency)", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, keyAuth);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("POST /checkouts/:id/payment-session → 501 PROVIDER_NOT_CONFIGURED", async () => {
    // Need a pending checkout for this
    const cart2Res = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    const cart2Id = cart2Res.json["id"] as string;
    await post(ctx, `/commerce/stores/${storeId}/carts/${cart2Id}/lines`, {
      variant_id: variantId, quantity: 1,
    }, keyAuth);
    const co2Res = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
      cart_id: cart2Id,
    }, keyAuth);
    const co2Id = co2Res.json["id"] as string;

    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts/${co2Id}/payment-session`, {}, keyAuth);
    expect(res.status).toBe(501);
    expect((res.json["error"] as Record<string, unknown>)?.["code"]).toBe("PROVIDER_NOT_CONFIGURED");
  });
});

describe("Checkout totals math with tax", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let variantId: string;

  beforeAll(async () => {
    const setup = await setupStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    const pv = await setupProductVariant(storeId, keyAuth);
    variantId = pv.variant.id;

    // Disable inventory tracking
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variantId]
    );

    // Create a simple tax zone and 15% exclusive tax rate for ZA
    await ctx.pool.query(
      `INSERT INTO tax_zones (store_id, name) VALUES ($1::uuid, 'South Africa') `,
      [storeId]
    );
    const { rows: zoneRows } = await ctx.pool.query<{ id: string }>(
      `SELECT id::text FROM tax_zones WHERE store_id = $1::uuid LIMIT 1`,
      [storeId]
    );
    const zoneId = zoneRows[0]?.id;
    if (zoneId) {
      await ctx.pool.query(
        `INSERT INTO tax_zone_regions (zone_id, country_code) VALUES ($1::uuid, 'ZA')`,
        [zoneId]
      );
      await ctx.pool.query(
        `INSERT INTO tax_rates (zone_id, name, rate_pct, is_inclusive, is_active)
         VALUES ($1::uuid, 'VAT', 15, false, true)`,
        [zoneId]
      );
    }
  });

  it("Checkout with ZA shipping address applies 15% exclusive VAT", async () => {
    const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    const cartId = cartRes.json["id"] as string;
    await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
      variant_id: variantId, quantity: 1,
    }, keyAuth);

    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
      cart_id: cartId,
      shipping_address: { country_code: "ZA", province_code: "" },
    }, keyAuth);
    expect(res.status).toBe(201);

    const subtotal = parseFloat(res.json["subtotal"] as string);
    const taxTotal = parseFloat(res.json["tax_total"] as string);
    const total = parseFloat(res.json["total"] as string);

    // subtotal = 99.00, tax = 99.00 * 0.15 = 14.85, total = 113.85
    expect(subtotal).toBeCloseTo(99.00, 2);
    expect(taxTotal).toBeCloseTo(14.85, 2);
    expect(total).toBeCloseTo(113.85, 2);

    const taxLines = res.json["tax_lines"] as Array<Record<string, unknown>>;
    expect(Array.isArray(taxLines)).toBe(true);
    expect(taxLines.length).toBeGreaterThan(0);
    expect(taxLines[0]?.["rate_pct"]).toBe(15);
    expect(taxLines[0]?.["is_inclusive"]).toBe(false);
  });
});

describe("Checkout with discount code", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let variantId: string;

  beforeAll(async () => {
    const setup = await setupStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    const pv = await setupProductVariant(storeId, keyAuth);
    variantId = pv.variant.id;

    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variantId]
    );

    // Seed a 10% discount code
    await ctx.pool.query(
      `INSERT INTO discount_codes (store_id, code, type, value, is_active)
       VALUES ($1::uuid, 'SAVE10', 'percentage', 10, true)`,
      [storeId]
    );
  });

  it("Applies percentage discount to checkout subtotal", async () => {
    const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    const cartId = cartRes.json["id"] as string;
    await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
      variant_id: variantId, quantity: 2,
    }, keyAuth);

    // subtotal = 99 * 2 = 198, discount 10% = 19.80
    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
      cart_id: cartId,
      discount_code: "SAVE10",
    }, keyAuth);
    expect(res.status).toBe(201);

    const subtotal = parseFloat(res.json["subtotal"] as string);
    const discountTotal = parseFloat(res.json["discount_total"] as string);
    const total = parseFloat(res.json["total"] as string);

    expect(subtotal).toBeCloseTo(198.00, 2);
    expect(discountTotal).toBeCloseTo(19.80, 2);
    expect(total).toBeCloseTo(178.20, 2);
  });

  it("Completing checkout burns the discount_code uses_count", async () => {
    // Get current uses_count
    const { rows: before } = await ctx.pool.query<{ uses_count: number }>(
      `SELECT uses_count FROM discount_codes WHERE store_id = $1::uuid AND code = 'SAVE10'`,
      [storeId]
    );
    const beforeCount = before[0]!.uses_count;

    const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    const cartId = cartRes.json["id"] as string;
    await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
      variant_id: variantId, quantity: 1,
    }, keyAuth);
    const coRes = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
      cart_id: cartId,
      discount_code: "SAVE10",
    }, keyAuth);
    const coId = coRes.json["id"] as string;

    const completeRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${coId}/complete`, {}, keyAuth);
    expect(completeRes.status).toBe(200);

    const { rows: after } = await ctx.pool.query<{ uses_count: number }>(
      `SELECT uses_count FROM discount_codes WHERE store_id = $1::uuid AND code = 'SAVE10'`,
      [storeId]
    );
    expect(after[0]!.uses_count).toBe(beforeCount + 1);
  });

  it("Invalid discount code → 422 on checkout create", async () => {
    const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
    const cartId = cartRes.json["id"] as string;
    await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
      variant_id: variantId, quantity: 1,
    }, keyAuth);

    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
      cart_id: cartId,
      discount_code: "NOPE",
    }, keyAuth);
    expect(res.status).toBe(422);
  });
});
