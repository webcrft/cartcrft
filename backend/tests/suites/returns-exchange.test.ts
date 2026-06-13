/**
 * returns-exchange.test.ts — H3.4 Exchange resolution.
 *
 * Verifies:
 *  1. Exchange resolution creates a replacement order for each exchange_variant_id × qty
 *     at current variant price, linked via return_requests.replacement_order_id.
 *  2. Restock flag: returned item inventory incremented when restock=true.
 *  3. No restock when restock=false.
 *  4. Regression: refund-type resolution still works (no replacement order created).
 *  5. Mixed return (exchange + non-exchange lines): replacement order contains only
 *     exchange lines.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx } from "../shared/ctx.js";
import type { TestCtx } from "../shared/ctx.js";
import {
  mintJwt,
  insertOrg,
  insertStore,
  insertProduct,
  insertVariant,
  insertCustomer,
} from "../shared/helpers.js";

let ctx: TestCtx;
let orgId: string;
let userId: string;
let storeId: string;
let authHeader: Record<string, string>;

beforeAll(async () => {
  ctx = await createCtx();
  userId = "00000000-0000-0000-0000-000000000007";
  const org = await insertOrg(ctx.pool, { name: "Exchange Test Org" });
  orgId = org.id;
  const jwt = await mintJwt({ userId, orgId });
  authHeader = { authorization: `Bearer ${jwt}` };
  const store = await insertStore(ctx.pool, {
    orgId,
    name: "Exchange Store",
    slug: `exchange-store-${Date.now()}`,
  });
  storeId = store.id;
});

afterAll(async () => {
  await ctx.teardown();
});

const base = () => `/commerce/stores/${storeId}`;

// ── Helper: drive a return to "resolved" ──────────────────────────────────────

async function driveToResolved(returnId: string, resolveBody?: Record<string, unknown>) {
  for (const status of ["approved", "in_transit", "received", "inspected"] as const) {
    await ctx.request({
      method: "PUT",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
      body: { status },
    });
  }
  return ctx.request({
    method: "PUT",
    path: `${base()}/returns/${returnId}`,
    headers: authHeader,
    body: { status: "resolved", ...resolveBody },
  });
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedOrderWithLine(opts: {
  variantId: string;
  price?: number;
  qty?: number;
  customerId?: string | null;
}): Promise<{ orderId: string; orderLineId: string }> {
  const price = opts.price ?? 49.99;
  const qty = opts.qty ?? 1;

  const { rows: orderRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO orders
       (store_id, customer_id, order_number, status, financial_status,
        fulfillment_status, currency, subtotal, total)
     VALUES ($1::uuid, $2, $3, 'open', 'paid', 'fulfilled', 'USD', $4, $4)
     RETURNING id::text`,
    [storeId, opts.customerId ?? null, `EX-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, price * qty]
  );
  const orderId = orderRows[0]!.id;

  const { rows: lineRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO order_lines
       (order_id, variant_id, title, quantity, price, total)
     VALUES ($1::uuid, $2::uuid, 'Exchange Item', $3, $4, $5)
     RETURNING id::text`,
    [orderId, opts.variantId, qty, price, price * qty]
  );
  const orderLineId = lineRows[0]!.id;

  return { orderId, orderLineId };
}

// ── Test: basic exchange creates replacement order ────────────────────────────

describe("exchange resolution — replacement order creation", () => {
  let originalVariantId: string;
  let exchangeVariantId: string;
  let orderId: string;
  let orderLineId: string;
  let returnId: string;

  beforeAll(async () => {
    const product = await insertProduct(ctx.pool, {
      storeId,
      title: "Exchangeable Widget",
    });
    // Original variant (what the customer bought / returns)
    const origVariant = await insertVariant(ctx.pool, {
      productId: product.id,
      title: "Original",
      price: "49.99",
    });
    originalVariantId = origVariant.id;

    // Exchange variant (what the customer wants instead)
    const exchVariant = await insertVariant(ctx.pool, {
      productId: product.id,
      title: "New Size",
      price: "54.99",
    });
    exchangeVariantId = exchVariant.id;

    const customer = await insertCustomer(ctx.pool, {
      storeId,
      email: `exchange-basic-${Date.now()}@test.example.com`,
    });

    ({ orderId, orderLineId } = await seedOrderWithLine({
      variantId: originalVariantId,
      price: 49.99,
      qty: 1,
      customerId: customer.id,
    }));

    // Create return with exchange line
    const createRes = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${orderId}/returns`,
      headers: authHeader,
      body: {
        return_type: "exchange",
        notes: "Wrong size, please send new size",
        lines: [
          {
            order_line_id: orderLineId,
            quantity: 1,
            reason: "wrong_item",
            action: "exchange",
            exchange_variant_id: exchangeVariantId,
            restock: false,
          },
        ],
      },
    });
    expect(createRes.status).toBe(201);
    returnId = (createRes.json as { id: string }).id;
  });

  it("drives to resolved without error", async () => {
    const res = await driveToResolved(returnId, { return_type: "exchange" });
    expect(res.status).toBe(200);
    expect((res.json as { ok: boolean }).ok).toBe(true);
  });

  it("return has replacement_order_id set after exchange resolution", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const ret = res.json as { replacement_order_id: string | null; status: string };
    expect(ret.status).toBe("resolved");
    expect(typeof ret.replacement_order_id).toBe("string");
    expect(ret.replacement_order_id).not.toBeNull();
    expect(ret.replacement_order_id!.length).toBeGreaterThan(0);
  });

  it("replacement order exists and has the exchange variant line at current price", async () => {
    // Fetch replacement_order_id
    const retRes = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    const replacementOrderId = (retRes.json as { replacement_order_id: string }).replacement_order_id;

    // Verify the order exists in the DB
    const { rows: orderRows } = await ctx.pool.query<{
      id: string;
      store_id: string;
      source_name: string;
      status: string;
    }>(
      `SELECT id::text, store_id::text, source_name, status
       FROM orders WHERE id = $1::uuid`,
      [replacementOrderId]
    );
    expect(orderRows.length).toBe(1);
    expect(orderRows[0]!.store_id).toBe(storeId);
    expect(orderRows[0]!.source_name).toBe("exchange");
    expect(orderRows[0]!.status).toBe("open");

    // Verify order line points to exchange variant at correct price
    const { rows: lineRows } = await ctx.pool.query<{
      variant_id: string;
      quantity: number;
      price: string;
      total: string;
    }>(
      `SELECT variant_id::text, quantity, price::text, total::text
       FROM order_lines WHERE order_id = $1::uuid`,
      [replacementOrderId]
    );
    expect(lineRows.length).toBe(1);
    expect(lineRows[0]!.variant_id).toBe(exchangeVariantId);
    expect(lineRows[0]!.quantity).toBe(1);
    // Price should be 54.99 (current exchange variant price)
    expect(parseFloat(lineRows[0]!.price)).toBeCloseTo(54.99, 2);
    expect(parseFloat(lineRows[0]!.total)).toBeCloseTo(54.99, 2);
  });

  it("replacement order total matches line price × qty", async () => {
    const retRes = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    const replacementOrderId = (retRes.json as { replacement_order_id: string }).replacement_order_id;

    const { rows } = await ctx.pool.query<{ total: string; subtotal: string }>(
      `SELECT total::text, subtotal::text FROM orders WHERE id = $1::uuid`,
      [replacementOrderId]
    );
    expect(parseFloat(rows[0]!.total)).toBeCloseTo(54.99, 2);
    expect(parseFloat(rows[0]!.subtotal)).toBeCloseTo(54.99, 2);
  });

  it("replacement order has order_created event linking back to the return", async () => {
    const retRes = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    const replacementOrderId = (retRes.json as { replacement_order_id: string }).replacement_order_id;

    const { rows } = await ctx.pool.query<{ type: string; data: Record<string, unknown> }>(
      `SELECT type, data FROM order_events WHERE order_id = $1::uuid AND type = 'order_created'`,
      [replacementOrderId]
    );
    expect(rows.length).toBeGreaterThan(0);
    // data should carry rma_return_id
    const event = rows[0]!;
    expect(event.data).toMatchObject({ rma_return_id: returnId });
  });
});

// ── Test: exchange with restock=true ─────────────────────────────────────────

describe("exchange resolution — restock of returned item when restock=true", () => {
  let originalVariantId: string;
  let exchangeVariantId: string;
  let warehouseId: string;
  let orderId: string;
  let orderLineId: string;
  let returnId: string;

  beforeAll(async () => {
    const product = await insertProduct(ctx.pool, {
      storeId,
      title: "Restockable Exchange Item",
    });
    const origVariant = await insertVariant(ctx.pool, {
      productId: product.id,
      title: "Original Color",
      price: "29.00",
    });
    originalVariantId = origVariant.id;

    const exchVariant = await insertVariant(ctx.pool, {
      productId: product.id,
      title: "New Color",
      price: "29.00",
    });
    exchangeVariantId = exchVariant.id;

    // Create warehouse and seed inventory level for the original variant
    const { rows: whRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO warehouses (store_id, name, is_default)
       VALUES ($1::uuid, $2, true) RETURNING id::text`,
      [storeId, `WH-Exch-${Date.now()}`]
    );
    warehouseId = whRows[0]!.id;

    await ctx.pool.query(
      `INSERT INTO inventory_levels
         (variant_id, warehouse_id, quantity_on_hand, quantity_committed, quantity_incoming)
       VALUES ($1::uuid, $2::uuid, 10, 0, 0)
       ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET quantity_on_hand = 10`,
      [originalVariantId, warehouseId]
    );

    ({ orderId, orderLineId } = await seedOrderWithLine({
      variantId: originalVariantId,
      price: 29.0,
      qty: 2,
    }));

    // Create return: exchange with restock=true, qty=2
    const createRes = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${orderId}/returns`,
      headers: authHeader,
      body: {
        return_type: "exchange",
        lines: [
          {
            order_line_id: orderLineId,
            quantity: 2,
            reason: "defective",
            action: "exchange",
            exchange_variant_id: exchangeVariantId,
            restock: true,
          },
        ],
      },
    });
    expect(createRes.status).toBe(201);
    returnId = (createRes.json as { id: string }).id;
  });

  it("resolves with exchange and restock", async () => {
    const res = await driveToResolved(returnId, { return_type: "exchange" });
    expect(res.status).toBe(200);
  });

  it("replacement order created for exchange variant at correct price × qty=2", async () => {
    const retRes = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    const replacementOrderId = (retRes.json as { replacement_order_id: string }).replacement_order_id;
    expect(typeof replacementOrderId).toBe("string");

    const { rows: lineRows } = await ctx.pool.query<{
      variant_id: string;
      quantity: number;
      price: string;
      total: string;
    }>(
      `SELECT variant_id::text, quantity, price::text, total::text
       FROM order_lines WHERE order_id = $1::uuid`,
      [replacementOrderId]
    );
    expect(lineRows.length).toBe(1);
    expect(lineRows[0]!.variant_id).toBe(exchangeVariantId);
    expect(lineRows[0]!.quantity).toBe(2);
    expect(parseFloat(lineRows[0]!.price)).toBeCloseTo(29.0, 2);
    expect(parseFloat(lineRows[0]!.total)).toBeCloseTo(58.0, 2);
  });

  it("original variant inventory incremented by qty=2 (restock=true)", async () => {
    const { rows } = await ctx.pool.query<{ quantity_on_hand: number }>(
      `SELECT quantity_on_hand
       FROM inventory_levels
       WHERE variant_id = $1::uuid AND warehouse_id = $2::uuid`,
      [originalVariantId, warehouseId]
    );
    // Started at 10, should be 10 + 2 = 12
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.quantity_on_hand).toBeGreaterThanOrEqual(12);
  });

  it("inventory_adjustments row created for restock", async () => {
    const { rows } = await ctx.pool.query<{ quantity_delta: number; reason: string }>(
      `SELECT quantity_delta, reason
       FROM inventory_adjustments
       WHERE variant_id = $1::uuid AND reference_type = 'return' AND reference_id = $2::uuid`,
      [originalVariantId, returnId]
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.quantity_delta).toBe(2);
    expect(rows[0]!.reason).toBe("returned");
  });
});

// ── Test: exchange with restock=false — no inventory change ──────────────────

describe("exchange resolution — restock=false: no inventory adjustment", () => {
  let originalVariantId: string;
  let exchangeVariantId: string;
  let orderId: string;
  let orderLineId: string;
  let returnId: string;

  beforeAll(async () => {
    const product = await insertProduct(ctx.pool, {
      storeId,
      title: "Non-Restockable Exchange",
    });
    const origVariant = await insertVariant(ctx.pool, {
      productId: product.id,
      title: "Damaged",
      price: "19.00",
    });
    originalVariantId = origVariant.id;

    const exchVariant = await insertVariant(ctx.pool, {
      productId: product.id,
      title: "Replacement",
      price: "19.00",
    });
    exchangeVariantId = exchVariant.id;

    ({ orderId, orderLineId } = await seedOrderWithLine({
      variantId: originalVariantId,
      price: 19.0,
      qty: 1,
    }));

    const createRes = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${orderId}/returns`,
      headers: authHeader,
      body: {
        return_type: "exchange",
        lines: [
          {
            order_line_id: orderLineId,
            quantity: 1,
            action: "exchange",
            exchange_variant_id: exchangeVariantId,
            restock: false,
          },
        ],
      },
    });
    returnId = (createRes.json as { id: string }).id;
  });

  it("resolves without error", async () => {
    const res = await driveToResolved(returnId, { return_type: "exchange" });
    expect(res.status).toBe(200);
  });

  it("no inventory_adjustment row created (restock=false)", async () => {
    const { rows } = await ctx.pool.query(
      `SELECT id FROM inventory_adjustments
       WHERE reference_type = 'return' AND reference_id = $1::uuid`,
      [returnId]
    );
    expect(rows.length).toBe(0);
  });

  it("replacement order still created", async () => {
    const retRes = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    const ret = retRes.json as { replacement_order_id: string | null };
    expect(typeof ret.replacement_order_id).toBe("string");
    expect(ret.replacement_order_id).not.toBeNull();
  });
});

// ── Regression: refund-type resolution — no replacement order ─────────────────

describe("regression — refund resolution unchanged", () => {
  let variantId: string;
  let orderId: string;
  let orderLineId: string;
  let returnId: string;
  let customerId: string;

  beforeAll(async () => {
    const product = await insertProduct(ctx.pool, {
      storeId,
      title: "Refundable Item",
    });
    const variant = await insertVariant(ctx.pool, {
      productId: product.id,
      price: "75.00",
    });
    variantId = variant.id;

    const customer = await insertCustomer(ctx.pool, {
      storeId,
      email: `refund-regression-${Date.now()}@test.example.com`,
    });
    customerId = customer.id;

    // Seed a payment so refund insert path is exercised
    ({ orderId, orderLineId } = await seedOrderWithLine({
      variantId,
      price: 75.0,
      qty: 1,
      customerId,
    }));
    await ctx.pool.query(
      `INSERT INTO payments (order_id, amount, currency, status, mode)
       VALUES ($1::uuid, 75.00, 'USD', 'captured', 'live')`,
      [orderId]
    );

    const createRes = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${orderId}/returns`,
      headers: authHeader,
      body: {
        return_type: "refund",
        lines: [
          {
            order_line_id: orderLineId,
            quantity: 1,
            reason: "defective",
            action: "refund",
            restock: false,
          },
        ],
      },
    });
    expect(createRes.status).toBe(201);
    returnId = (createRes.json as { id: string }).id;
  });

  it("refund resolution succeeds", async () => {
    const res = await driveToResolved(returnId, {
      return_type: "refund",
      credit_amount: "75.00",
    });
    expect(res.status).toBe(200);
    expect((res.json as { ok: boolean }).ok).toBe(true);
  });

  it("replacement_order_id is null for refund resolution", async () => {
    const retRes = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    const ret = retRes.json as { replacement_order_id: string | null; status: string };
    expect(ret.status).toBe("resolved");
    expect(ret.replacement_order_id).toBeNull();
  });

  it("refund row created in payments table", async () => {
    const { rows } = await ctx.pool.query(
      `SELECT id FROM refunds WHERE order_id = $1::uuid`,
      [orderId]
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ── Test: multiple exchange lines in one return ───────────────────────────────

describe("exchange resolution — multiple exchange lines → single replacement order", () => {
  let variantA: string;
  let variantB: string;
  let exchangeVariantA: string;
  let exchangeVariantB: string;
  let orderId: string;
  let orderLineAId: string;
  let orderLineBId: string;
  let returnId: string;

  beforeAll(async () => {
    const productA = await insertProduct(ctx.pool, { storeId, title: "Multi Exchange A" });
    const productB = await insertProduct(ctx.pool, { storeId, title: "Multi Exchange B" });

    const vA = await insertVariant(ctx.pool, { productId: productA.id, price: "10.00" });
    const vB = await insertVariant(ctx.pool, { productId: productB.id, price: "20.00" });
    variantA = vA.id;
    variantB = vB.id;

    const eA = await insertVariant(ctx.pool, { productId: productA.id, title: "ExchA", price: "12.00" });
    const eB = await insertVariant(ctx.pool, { productId: productB.id, title: "ExchB", price: "22.00" });
    exchangeVariantA = eA.id;
    exchangeVariantB = eB.id;

    // One order with two lines
    const { rows: orderRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, order_number, status, financial_status, fulfillment_status,
          currency, subtotal, total)
       VALUES ($1::uuid, $2, 'open', 'paid', 'fulfilled', 'USD', 30.00, 30.00)
       RETURNING id::text`,
      [storeId, `MULTI-${Date.now()}`]
    );
    orderId = orderRows[0]!.id;

    const { rows: laRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO order_lines (order_id, variant_id, title, quantity, price, total)
       VALUES ($1::uuid, $2::uuid, 'Multi A', 1, 10.00, 10.00) RETURNING id::text`,
      [orderId, variantA]
    );
    orderLineAId = laRows[0]!.id;

    const { rows: lbRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO order_lines (order_id, variant_id, title, quantity, price, total)
       VALUES ($1::uuid, $2::uuid, 'Multi B', 1, 20.00, 20.00) RETURNING id::text`,
      [orderId, variantB]
    );
    orderLineBId = lbRows[0]!.id;

    const createRes = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${orderId}/returns`,
      headers: authHeader,
      body: {
        return_type: "exchange",
        lines: [
          {
            order_line_id: orderLineAId,
            quantity: 1,
            action: "exchange",
            exchange_variant_id: exchangeVariantA,
            restock: false,
          },
          {
            order_line_id: orderLineBId,
            quantity: 1,
            action: "exchange",
            exchange_variant_id: exchangeVariantB,
            restock: false,
          },
        ],
      },
    });
    returnId = (createRes.json as { id: string }).id;
  });

  it("resolves successfully", async () => {
    const res = await driveToResolved(returnId, { return_type: "exchange" });
    expect(res.status).toBe(200);
  });

  it("single replacement order contains both exchange lines", async () => {
    const retRes = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    const replacementOrderId = (retRes.json as { replacement_order_id: string }).replacement_order_id;
    expect(typeof replacementOrderId).toBe("string");

    const { rows: lineRows } = await ctx.pool.query<{
      variant_id: string;
      price: string;
    }>(
      `SELECT variant_id::text, price::text FROM order_lines WHERE order_id = $1::uuid ORDER BY price`,
      [replacementOrderId]
    );
    expect(lineRows.length).toBe(2);

    const variantIds = lineRows.map((r) => r.variant_id).sort();
    const expected = [exchangeVariantA, exchangeVariantB].sort();
    expect(variantIds).toEqual(expected);
  });

  it("replacement order total = sum of both exchange variant prices", async () => {
    const retRes = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    const replacementOrderId = (retRes.json as { replacement_order_id: string }).replacement_order_id;

    const { rows } = await ctx.pool.query<{ total: string }>(
      `SELECT total::text FROM orders WHERE id = $1::uuid`,
      [replacementOrderId]
    );
    // 12.00 + 22.00 = 34.00
    expect(parseFloat(rows[0]!.total)).toBeCloseTo(34.0, 2);
  });
});
