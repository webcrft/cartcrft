/**
 * multi-warehouse-allocation.test.ts — Wave-23: split inventory decrement at
 * checkout completion across multiple warehouses.
 *
 * Guarantees under test:
 *  1. SINGLE-warehouse variant — completes and decrements the single
 *     inventory_levels row by the full quantity, and order_lines.warehouse_id
 *     stays NULL (byte-identical regression guard for the common path).
 *  2. TWO-warehouse variant where NEITHER alone covers the qty but the SUM does —
 *     completes, splits the decrement (default warehouse drawn first), no row
 *     goes negative, and the routing hint (order_lines.warehouse_id) is set to
 *     the primary (largest-share) warehouse.
 *  3. SUM across warehouses < needed — INSUFFICIENT_INVENTORY, no order created,
 *     no decrements.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  post,
  mintJwt,
  createApiKey,
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

async function bootstrapStore() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: "Multi-WH Test Store",
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

async function makeWarehouse(storeId: string, name: string, isDefault: boolean): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO warehouses (store_id, name, is_default) VALUES ($1::uuid, $2, $3) RETURNING id::text`,
    [storeId, name, isDefault]
  );
  return rows[0]!.id;
}

async function seedLevel(variantId: string, warehouseId: string, qty: number): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand)
     VALUES ($1::uuid, $2::uuid, $3)`,
    [variantId, warehouseId, qty]
  );
}

async function makeTrackedVariant(storeId: string, title: string): Promise<string> {
  const product = await insertProduct(ctx.pool, { storeId, title });
  const variant = await insertVariant(ctx.pool, { productId: product.id, price: "50.00" });
  await ctx.pool.query(
    `UPDATE product_variants SET track_inventory = true WHERE id = $1::uuid`,
    [variant.id]
  );
  return variant.id;
}

async function makeCheckout(storeId: string, keyAuth: { key: string }, variantId: string, qty: number): Promise<string> {
  const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, { type: "api-key", key: keyAuth.key });
  const cartId = cartRes.json["id"] as string;
  await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
    variant_id: variantId, quantity: qty,
  }, { type: "api-key", key: keyAuth.key });
  const coRes = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
    cart_id: cartId,
  }, { type: "api-key", key: keyAuth.key });
  return coRes.json["id"] as string;
}

async function onHand(variantId: string): Promise<Map<string, number>> {
  const { rows } = await ctx.pool.query<{ warehouse_id: string; quantity_on_hand: number }>(
    `SELECT warehouse_id::text, quantity_on_hand FROM inventory_levels WHERE variant_id = $1::uuid`,
    [variantId]
  );
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.warehouse_id, r.quantity_on_hand);
  return m;
}

describe("Multi-warehouse allocation at checkout completion", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    const s = await bootstrapStore();
    storeId = s.storeId;
    keyAuth = s.keyAuth;
  });

  it("single-warehouse variant: decrements the one row by full qty, no warehouse hint (byte-identical path)", async () => {
    const wh = await makeWarehouse(storeId, "Solo WH", true);
    const variantId = await makeTrackedVariant(storeId, "Single-WH Widget");
    await seedLevel(variantId, wh, 10);

    const coId = await makeCheckout(storeId, keyAuth, variantId, 4);
    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts/${coId}/complete`, {}, keyAuth);
    expect(res.status).toBe(200);
    const orderId = res.json["order_id"] as string;

    // Single row decremented by full quantity → 10 - 4 = 6.
    const levels = await onHand(variantId);
    expect(levels.get(wh)).toBe(6);

    // Byte-identical guard: single-warehouse lines never set warehouse_id.
    const { rows: lineRows } = await ctx.pool.query<{ warehouse_id: string | null }>(
      `SELECT warehouse_id::text FROM order_lines WHERE order_id = $1::uuid AND variant_id = $2::uuid`,
      [orderId, variantId]
    );
    expect(lineRows.length).toBe(1);
    expect(lineRows[0]!.warehouse_id).toBeNull();
  });

  it("two warehouses, neither covers qty alone but SUM does: splits decrement (default first), no negative, sets routing hint", async () => {
    // Default WH has 3, secondary WH has 4. Need 5 → default drawn first (3),
    // then secondary (2). Default is larger draw → primary routing hint.
    const whDefault = await makeWarehouse(storeId, "Default WH", true);
    const whOther = await makeWarehouse(storeId, "Secondary WH", false);
    const variantId = await makeTrackedVariant(storeId, "Split Widget");
    await seedLevel(variantId, whDefault, 3);
    await seedLevel(variantId, whOther, 4);

    const coId = await makeCheckout(storeId, keyAuth, variantId, 5);
    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts/${coId}/complete`, {}, keyAuth);
    expect(res.status).toBe(200);
    const orderId = res.json["order_id"] as string;

    const levels = await onHand(variantId);
    // Default drawn fully first (3 → 0), remainder 2 from secondary (4 → 2).
    expect(levels.get(whDefault)).toBe(0);
    expect(levels.get(whOther)).toBe(2);
    // No row negative.
    for (const v of levels.values()) expect(v).toBeGreaterThanOrEqual(0);
    // Total drawn equals the line quantity.
    const totalRemaining = [...levels.values()].reduce((a, b) => a + b, 0);
    expect(totalRemaining).toBe(7 - 5);

    // Routing hint: line genuinely split → warehouse_id set to primary (default,
    // which contributed the larger share of 3 vs 2).
    const { rows: lineRows } = await ctx.pool.query<{ warehouse_id: string | null }>(
      `SELECT warehouse_id::text FROM order_lines WHERE order_id = $1::uuid AND variant_id = $2::uuid`,
      [orderId, variantId]
    );
    expect(lineRows[0]!.warehouse_id).toBe(whDefault);
  });

  it("SUM across warehouses < needed → INSUFFICIENT_INVENTORY, no order, no decrement", async () => {
    const whA = await makeWarehouse(storeId, "Short WH A", true);
    const whB = await makeWarehouse(storeId, "Short WH B", false);
    const variantId = await makeTrackedVariant(storeId, "Insufficient Widget");
    await seedLevel(variantId, whA, 2);
    await seedLevel(variantId, whB, 2); // total 4

    const { rows: ordersBefore } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders WHERE store_id = $1::uuid`,
      [storeId]
    );
    const beforeCount = parseInt(ordersBefore[0]!.count, 10);

    const coId = await makeCheckout(storeId, keyAuth, variantId, 5); // need 5 > 4
    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts/${coId}/complete`, {}, keyAuth);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // No decrements — both rows untouched.
    const levels = await onHand(variantId);
    expect(levels.get(whA)).toBe(2);
    expect(levels.get(whB)).toBe(2);

    // No order created (transaction rolled back).
    const { rows: ordersAfter } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders WHERE store_id = $1::uuid`,
      [storeId]
    );
    expect(parseInt(ordersAfter[0]!.count, 10)).toBe(beforeCount);
  });
});
