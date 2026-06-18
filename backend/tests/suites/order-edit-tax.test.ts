/**
 * order-edit-tax — Order-edit tax recomputation fidelity (Wave 11.2).
 *
 * repriceOrder() (invoked by editOrderLines) must recompute tax against the new
 * taxable base (subtotal − discount) using the real DB-rate tax engine and the
 * order's stored shipping address, instead of leaving tax at 0.
 *
 * Covers:
 *  1. Order with a taxable shipping address (ZA, 15% exclusive VAT): editing a
 *     line quantity recomputes tax_total = rate × new taxable base and folds it
 *     into total (= subtotal − discount + shipping + tax).
 *  2. Order with NO taxable shipping address: edit still yields tax_total 0.
 *
 * DB setup mirrors fulfillment-edits.test.ts (REST store + SQL variant fixtures)
 * and tax.test.ts (REST-created tax zones/rates).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, mintJwt } from "../shared/helpers.js";
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

async function createStore(auth: { type: "bearer"; token: string }): Promise<string> {
  const res = await post(ctx, "/commerce/stores", { name: "Order Edit Tax Store" }, auth);
  if (res.status !== 201) {
    throw new Error(`createStore: expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.json["id"] as string;
}

/** Insert a tracked product+variant with `onHand` units. Returns the variant id. */
async function insertVariant(storeId: string, price: number, onHand: number): Promise<string> {
  const { rows: prodRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO products (store_id, title, slug)
     VALUES ($1::uuid, 'Tax Product', $2)
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

  return variantId;
}

/** Seed a national tax zone with a single exclusive rate via the REST API. */
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
  if (zRes.status !== 201) {
    throw new Error(`seedTaxRate zone: ${zRes.status}: ${JSON.stringify(zRes.body)}`);
  }
  const zoneId = zRes.json["id"] as string;

  const rRes = await post(
    ctx,
    `/commerce/stores/${storeId}/tax-zones/${zoneId}/rates`,
    { name: `${countryCode} VAT`, rate_pct: ratePct, is_inclusive: false, is_active: true },
    auth
  );
  if (rRes.status !== 201) {
    throw new Error(`seedTaxRate rate: ${rRes.status}: ${JSON.stringify(rRes.body)}`);
  }
}

async function createOrderWithAddress(
  storeId: string,
  auth: { type: "bearer"; token: string },
  variantId: string,
  quantity: number,
  shippingAddress: Record<string, unknown> | undefined
): Promise<string> {
  const body: Record<string, unknown> = {
    currency: "USD",
    lines: [{ variant_id: variantId, quantity }],
  };
  if (shippingAddress) body["shipping_address"] = shippingAddress;
  const res = await post(ctx, `/commerce/stores/${storeId}/orders`, body, auth);
  if (res.status !== 201) {
    throw new Error(`createOrder: expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.json["id"] as string;
}

async function firstLineId(storeId: string, orderId: string, auth: { type: "bearer"; token: string }): Promise<string> {
  const res = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
  return (res.json["lines"] as Array<Record<string, unknown>>)[0]!["id"] as string;
}

describe("Order-edit tax recomputation", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let auth: Awaited<ReturnType<typeof authFor>>;
  let storeId: string;

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
    storeId = await createStore(auth);
    // Single national 15% exclusive rate for ZA used across taxable tests.
    await seedTaxRate(storeId, auth, "ZA", 15.0);
  });

  it("recomputes tax against the new taxable base on a taxable address", async () => {
    const variantId = await insertVariant(storeId, 10, 100);
    const orderId = await createOrderWithAddress(storeId, auth, variantId, 2, {
      country_code: "ZA",
      province_code: "GP",
    });

    const lineId = await firstLineId(storeId, orderId, auth);

    // Edit qty 2 → 5: subtotal 50.00, tax 15% × 50 = 7.50, total 57.50.
    const up = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "update_quantity", order_line_id: lineId, quantity: 5 }] },
      auth
    );
    expect(up.status).toBe(200);
    expect(up.json["subtotal"]).toBe("50.00");
    expect(up.json["tax_total"]).toBe("7.50");
    expect(up.json["total"]).toBe("57.50");

    // Persisted on the order too.
    const after = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    expect(after.json["tax_total"]).toBe("7.50");
    expect(after.json["total"]).toBe("57.50");

    // Edit qty 5 → 1: subtotal 10.00, tax 1.50, total 11.50 — tax tracks the base.
    const down = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "update_quantity", order_line_id: lineId, quantity: 1 }] },
      auth
    );
    expect(down.status).toBe(200);
    expect(down.json["subtotal"]).toBe("10.00");
    expect(down.json["tax_total"]).toBe("1.50");
    expect(down.json["total"]).toBe("11.50");
  });

  it("leaves tax at 0 when the order has no taxable shipping address", async () => {
    const variantId = await insertVariant(storeId, 10, 100);
    // No shipping address → extractAddressCodes yields no country → tax stays 0.
    const orderId = await createOrderWithAddress(storeId, auth, variantId, 2, undefined);

    const lineId = await firstLineId(storeId, orderId, auth);

    const up = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "update_quantity", order_line_id: lineId, quantity: 4 }] },
      auth
    );
    expect(up.status).toBe(200);
    expect(up.json["subtotal"]).toBe("40.00");
    expect(up.json["tax_total"]).toBe("0.00");
    expect(up.json["total"]).toBe("40.00");
  });

  it("leaves tax at 0 for an address in a country with no tax zone", async () => {
    const variantId = await insertVariant(storeId, 10, 100);
    // US has no seeded zone → calcTax finds no rate → tax 0.
    const orderId = await createOrderWithAddress(storeId, auth, variantId, 1, {
      country_code: "US",
      province_code: "CA",
    });

    const lineId = await firstLineId(storeId, orderId, auth);

    const up = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "update_quantity", order_line_id: lineId, quantity: 3 }] },
      auth
    );
    expect(up.status).toBe(200);
    expect(up.json["subtotal"]).toBe("30.00");
    expect(up.json["tax_total"]).toBe("0.00");
    expect(up.json["total"]).toBe("30.00");
  });
});
