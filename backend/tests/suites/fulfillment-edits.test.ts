/**
 * fulfillment-edits — Order fulfillment + safe line-edit suite (Wave 4.1).
 *
 * Covers:
 *  1. Partial then full line fulfillment + order fulfillment_status transitions
 *     (unfulfilled → partial → fulfilled).
 *  2. Over-fulfillment rejected (409 CONFLICT).
 *  3. Edit line quantity → re-prices the order + adjusts held inventory.
 *  4. Add line + remove line (re-prices, adjusts inventory).
 *  5. Edit refused after a line is fulfilled (409).
 *  6. Edit refused after the order is cancelled (409).
 *
 * DB setup follows orders.test.ts conventions: REST-created store, SQL-inserted
 * product/variant/inventory fixtures via ctx.pool.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, mintJwt, errorCode } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

async function authFor(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

async function createStore(
  orgId: string,
  auth: { type: "bearer"; token: string }
): Promise<string> {
  const res = await post(ctx, "/commerce/stores", { name: "Fulfillment Test Store" }, auth);
  if (res.status !== 201) {
    throw new Error(`createStore: expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.json["id"] as string;
}

/**
 * Insert a product+variant (price 10.00) with track_inventory and a warehouse +
 * inventory_levels row holding `onHand` units. Returns { variantId, warehouseId }.
 */
async function insertTrackedVariant(
  storeId: string,
  price: number,
  onHand: number
): Promise<{ variantId: string; warehouseId: string }> {
  const { rows: prodRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO products (store_id, title, slug)
     VALUES ($1::uuid, 'Tracked Product', $2)
     RETURNING id::text`,
    [storeId, `prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`]
  );
  const productId = prodRows[0]!.id;

  const { rows: varRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO product_variants (product_id, title, price, track_inventory)
     VALUES ($1::uuid, 'Default', $2, true)
     RETURNING id::text`,
    [productId, price]
  );
  const variantId = varRows[0]!.id;

  const { rows: whRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO warehouses (store_id, name, is_default)
     VALUES ($1::uuid, 'Main', true)
     RETURNING id::text`,
    [storeId]
  );
  const warehouseId = whRows[0]!.id;

  await ctx.pool.query(
    `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand)
     VALUES ($1::uuid, $2::uuid, $3)`,
    [variantId, warehouseId, onHand]
  );

  return { variantId, warehouseId };
}

async function createOrder(
  storeId: string,
  auth: { type: "bearer"; token: string },
  lines: Array<{ variant_id: string; quantity: number }>
): Promise<string> {
  const res = await post(
    ctx,
    `/commerce/stores/${storeId}/orders`,
    { currency: "USD", lines },
    auth
  );
  if (res.status !== 201) {
    throw new Error(`createOrder: expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.json["id"] as string;
}

async function onHandFor(variantId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ q: string }>(
    `SELECT COALESCE(SUM(quantity_on_hand),0)::text AS q
     FROM inventory_levels WHERE variant_id = $1::uuid`,
    [variantId]
  );
  return parseInt(rows[0]!.q, 10);
}

describe("Order fulfillment + line edits", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let auth: Awaited<ReturnType<typeof authFor>>;
  let storeId: string;

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
    storeId = await createStore(orgId, auth);
  });

  it("1. partial then full line fulfillment transitions order status", async () => {
    const { variantId } = await insertTrackedVariant(storeId, 10, 100);
    const orderId = await createOrder(storeId, auth, [{ variant_id: variantId, quantity: 4 }]);

    // Resolve the single line id.
    const getRes = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    expect(getRes.json["fulfillment_status"]).toBe("unfulfilled");
    const lineId = (getRes.json["lines"] as Array<Record<string, unknown>>)[0]!["id"] as string;

    // Fulfill 1 of 4 → partial
    const f1 = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/fulfillments`,
      { lines: [{ order_line_id: lineId, quantity: 1 }] },
      auth
    );
    expect(f1.status).toBe(201);
    expect(f1.json["fulfillment_status"]).toBe("partial");

    const afterPartial = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    expect(afterPartial.json["fulfillment_status"]).toBe("partial");
    const partialLine = (afterPartial.json["lines"] as Array<Record<string, unknown>>)[0]!;
    expect(Number(partialLine["quantity_fulfilled"])).toBe(1);
    expect(partialLine["fulfillment_status"]).toBe("partial");

    // Fulfill remaining 3 → fulfilled
    const f2 = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/fulfillments`,
      { lines: [{ order_line_id: lineId, quantity: 3 }] },
      auth
    );
    expect(f2.status).toBe(201);
    expect(f2.json["fulfillment_status"]).toBe("fulfilled");

    const afterFull = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    expect(afterFull.json["fulfillment_status"]).toBe("fulfilled");
    const fullLine = (afterFull.json["lines"] as Array<Record<string, unknown>>)[0]!;
    expect(Number(fullLine["quantity_fulfilled"])).toBe(4);
    expect(fullLine["fulfillment_status"]).toBe("fulfilled");

    // fulfillment_created events recorded.
    const events = (afterFull.json["events"] as Array<Record<string, unknown>>).map((e) => e["type"]);
    expect(events).toContain("fulfillment_created");
  });

  it("2. over-fulfillment is rejected", async () => {
    const { variantId } = await insertTrackedVariant(storeId, 10, 100);
    const orderId = await createOrder(storeId, auth, [{ variant_id: variantId, quantity: 2 }]);
    const getRes = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    const lineId = (getRes.json["lines"] as Array<Record<string, unknown>>)[0]!["id"] as string;

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/fulfillments`,
      { lines: [{ order_line_id: lineId, quantity: 3 }] },
      auth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");

    // Order remains unfulfilled (transaction rolled back).
    const after = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    expect(after.json["fulfillment_status"]).toBe("unfulfilled");
  });

  it("3. edit line quantity re-prices order + adjusts inventory", async () => {
    const { variantId } = await insertTrackedVariant(storeId, 10, 100);
    // Order created → checkout-style hold already decremented on-hand at create?
    // createOrder() (manual path) does NOT decrement inventory, so on-hand stays 100.
    const orderId = await createOrder(storeId, auth, [{ variant_id: variantId, quantity: 2 }]);
    expect(await onHandFor(variantId)).toBe(100);

    const getRes = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    expect(getRes.json["total"]).toBe("20.00");
    const lineId = (getRes.json["lines"] as Array<Record<string, unknown>>)[0]!["id"] as string;

    // Increase qty 2 → 5: reserves 3 more units (on-hand 100 → 97), total 50.00
    const up = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "update_quantity", order_line_id: lineId, quantity: 5 }] },
      auth
    );
    expect(up.status).toBe(200);
    expect(up.json["total"]).toBe("50.00");
    expect(up.json["subtotal"]).toBe("50.00");
    expect(await onHandFor(variantId)).toBe(97);

    // Decrease qty 5 → 1: releases 4 units (on-hand 97 → 101), total 10.00
    const down = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "update_quantity", order_line_id: lineId, quantity: 1 }] },
      auth
    );
    expect(down.status).toBe(200);
    expect(down.json["total"]).toBe("10.00");
    expect(await onHandFor(variantId)).toBe(101);

    // order_lines_edited event recorded.
    const after = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    const events = (after.json["events"] as Array<Record<string, unknown>>).map((e) => e["type"]);
    expect(events).toContain("order_lines_edited");
  });

  it("4. add and remove lines re-price + adjust inventory", async () => {
    const a = await insertTrackedVariant(storeId, 10, 50);
    const b = await insertTrackedVariant(storeId, 25, 30);
    const orderId = await createOrder(storeId, auth, [{ variant_id: a.variantId, quantity: 1 }]);

    let getRes = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    expect(getRes.json["total"]).toBe("10.00");

    // Add variant b x2 → reserves 2 of b (30 → 28), total 10 + 50 = 60.00
    const add = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "add", variant_id: b.variantId, quantity: 2 }] },
      auth
    );
    expect(add.status).toBe(200);
    expect(add.json["total"]).toBe("60.00");
    expect(await onHandFor(b.variantId)).toBe(28);

    // Remove the original variant-a line → releases 1 of a (50 → 51), total 50.00
    getRes = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    const aLine = (getRes.json["lines"] as Array<Record<string, unknown>>).find(
      (l) => l["variant_id"] === a.variantId
    )!;
    const remove = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "remove", order_line_id: aLine["id"] as string }] },
      auth
    );
    expect(remove.status).toBe(200);
    expect(remove.json["total"]).toBe("50.00");
    expect(await onHandFor(a.variantId)).toBe(51);
  });

  it("5. edit refused after a line is fulfilled", async () => {
    const { variantId } = await insertTrackedVariant(storeId, 10, 100);
    const orderId = await createOrder(storeId, auth, [{ variant_id: variantId, quantity: 3 }]);
    const getRes = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    const lineId = (getRes.json["lines"] as Array<Record<string, unknown>>)[0]!["id"] as string;

    // Partially fulfill.
    await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/fulfillments`,
      { lines: [{ order_line_id: lineId, quantity: 1 }] },
      auth
    );

    const edit = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "update_quantity", order_line_id: lineId, quantity: 5 }] },
      auth
    );
    expect(edit.status).toBe(409);
    expect(errorCode(edit)).toBe("CONFLICT");
  });

  it("6. edit + fulfill refused after cancellation", async () => {
    const { variantId } = await insertTrackedVariant(storeId, 10, 100);
    const orderId = await createOrder(storeId, auth, [{ variant_id: variantId, quantity: 1 }]);
    const getRes = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    const lineId = (getRes.json["lines"] as Array<Record<string, unknown>>)[0]!["id"] as string;

    const cancel = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/cancel`,
      { reason: "test" },
      auth
    );
    expect(cancel.status).toBe(200);

    const edit = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "add", variant_id: variantId, quantity: 1 }] },
      auth
    );
    expect(edit.status).toBe(409);
    expect(errorCode(edit)).toBe("CONFLICT");

    const fulfill = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/fulfillments`,
      { lines: [{ order_line_id: lineId, quantity: 1 }] },
      auth
    );
    expect(fulfill.status).toBe(409);
    expect(errorCode(fulfill)).toBe("CONFLICT");
  });
});
